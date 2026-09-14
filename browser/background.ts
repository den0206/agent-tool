import { detectPage, proofUrls, skillIndex, ToolLead } from "../core/detect.js";
import { GitHubSource } from "../core/github.js";
import { listSkills, SkillEntry } from "../core/tree.js";
import { rootStateOf, splitRoot } from "../core/placement.js";
import { MAX_BROWSER_COLLECTION_ENTRIES } from "../core/collection.js";
import { autoOpenEnabled, knownRoots, loadCollection, loadHandle } from "./store.js";
import { isExtractable } from "./install.js";
import { fetchJson } from "./fetch.js";

/**
 * 検知の判定はここで行う。content script は URL を送るだけにする
 * （content script は ES モジュールを読み込めない）。
 *
 * 見た URL は保存しない。持つのは**タブごと**の候補だけで、タブを移ったり別のページへ
 * 行けば消える — 前のページの検知結果を出し続けない。
 *
 * 「今はしない」も覚えない。断るのは**その表示**に対してであって、そのページに対して
 * ではない。覚えると、いつ解除されるのか利用者から見て決まらない状態ができる
 * （service worker が停止するまで、という拡張の都合でしかない基準になる）。
 * 同じページをもう一度開けば、もう一度出る。
 */
const candidates = new Map<number, string>();

/**
 * カタログは実体パスを約束しないので、展開して中身を確かめるしかない。
 * アーカイブを 1 本落とすので **1 URL につき 1 回だけ**にし、結果はこの起動中の
 * メモリにだけ置く。覚えるのは**答えが出たときだけ**で、取得に失敗しただけのものは
 * 覚えない — 通信が戻れば出るはずのものを、出ないまま固定してしまう。
 */
const extracted = new Map<string, boolean>();

async function extractable(found: ToolLead): Promise<boolean> {
  if (found.proofs.length > 0) return true;             // 実在確認で足りる
  const cached = extracted.get(found.url);
  if (cached !== undefined) return cached;
  const ok = await isExtractable(found);
  if (ok !== null) {
    const oldest = extracted.keys().next().value;
    if (extracted.size >= MAX_BROWSER_COLLECTION_ENTRIES && oldest !== undefined) extracted.delete(oldest);
    extracted.set(found.url, ok);
  }
  return ok === true;
}

/** そのタブで出している一覧。popup が開いたときにそのまま渡す。 */
type Index = { source: GitHubSource; subdir: string; entries: SkillEntry[] };
const shown = new Map<number, Index>();

/**
 * 列挙は GitHub API を 1 回使う（未認証は 60 req/時）。同じ置き場を見るたびに叩かない
 * よう、この起動中のメモリにだけ覚える。件数上限は収集一覧と同じにする。
 */
const listed = new Map<string, SkillEntry[]>();

async function enumerate(at: { source: GitHubSource; subdir: string }): Promise<SkillEntry[]> {
  const key = `${at.source.repo}\n${at.source.branch ?? ""}\n${at.subdir}`;
  const cached = listed.get(key);
  if (cached !== undefined) return cached;
  const entries = await listSkills(at.source, at.subdir, fetchJson);
  if (entries.length === 0) return entries;    // 取れなかっただけのものを固定しない
  const oldest = listed.keys().next().value;
  if (listed.size >= MAX_BROWSER_COLLECTION_ENTRIES && oldest !== undefined) listed.delete(oldest);
  listed.set(key, entries);
  return entries;
}

/** 実在確認。**どれか 1 つでも 200 なら本物**。404 と通信失敗は黙る。 */
async function exists(found: ToolLead): Promise<boolean> {
  if (found.proofs.length === 0) return true;
  for (const url of proofUrls(found)) {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" }).catch(() => null);
    if (response?.status === 200) return true;
  }
  return false;
}

/**
 * 既に入っているものを毎回勧めない。許可済みのルートは実態を見る。
 *
 * 名前が一覧に出れば入っているとみなす。IDE 拡張が張った symlink は
 * `getDirectoryHandle` では見つからないので、それだけだと毎回勧めてしまう。
 */
async function alreadyInstalled(found: ToolLead): Promise<boolean> {
  const entry = found.kind === "skill" ? found.name : `${found.name}.md`;
  for (const root of await knownRoots()) {
    const config = await loadHandle(root);
    if (config === undefined) continue;
    // 別のフォルダが設定されている記録は見ない。中身を見て「導入済み」と誤判定する。
    if (rootStateOf(splitRoot(root).configDir, config.name).kind !== "ok") continue;
    if (await config.queryPermission({ mode: "read" }) !== "granted") continue;
    // 保存しているのが設定ディレクトリか置き場そのものかで、見る階層が変わる。
    const dirs = splitRoot(root).sub === ""
      ? await Promise.all(["skills", "agents"].map(sub =>
          config.getDirectoryHandle(sub).catch(() => null)))
      : [config];
    for (const dir of dirs) {
      if (dir === null) continue;
      try {
        for await (const [name] of dir.entries()) if (name === entry) return true;
      } catch { /* 読めないルートは判断しない */ }
    }
  }
  return (await loadCollection()).some(item =>
    item.name === found.name && item.kind === found.kind);
}

const clear = async (tabId: number): Promise<void> => {
  const had = candidates.delete(tabId);
  if (!shown.delete(tabId) && !had) return;
  await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { /* タブが閉じた */ });
};

/** バッジを出し、設定されているときだけ popup を開く。 */
async function announce(tabId: number, text: string, open: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text, tabId }).catch(() => { /* タブが閉じた */ });
  // popup の `--accent` と同じ紫。バッジはアイコンの上に出るので、そこで色がずれない。
  await chrome.action.setBadgeBackgroundColor({ color: "#5b4bd6", tabId }).catch(() => { /* 同上 */ });
  // `openPopup` は Chrome 127 以降で、それ未満と
  // 操作の文脈によっては開けない。そのときはバッジだけにする（manifest の
  // `minimum_chrome_version` は `light-dark()` が要る 123 に置く。これは必須ではない）。
  // **別ウィンドウは作らない** — 見ていたページが隠れる。
  if (open) await chrome.action.openPopup().catch(() => { /* バッジで足りる */ });
}

async function visit(url: string, tabId: number | undefined, jsonLd?: string): Promise<void> {
  if (tabId === undefined) return;
  // 遷移したら前のページの検知は無かったことにする。
  if (candidates.get(tabId) !== url) await clear(tabId);
  const autoOpen = await autoOpenEnabled();

  // 展開確認はアーカイブを 1 本丸ごと落とす（実測で数 MB）。ネットワークに触れない
  // 判定を全部先に通し、**出すと決まったものだけ**確かめる。導入済みのものを
  // 見るたびに落とし直さない。
  // Skill が並ぶディレクトリなら、1 件ではなく一覧を出す。アーカイブは落とさない。
  const at = skillIndex(url);
  if (at !== null) {
    const entries = await enumerate(at);
    if (entries.length === 0) return;
    shown.set(tabId, { ...at, entries });
    await announce(tabId, String(entries.length), autoOpen);
    return;
  }

  const found = detectPage(url, jsonLd ?? "");
  if (found === null) return;
  if (!await exists(found) || await alreadyInstalled(found)) return;
  if (!await extractable(found)) return;

  candidates.set(tabId, found.url);
  await announce(tabId, "1", autoOpen);
}

/**
 * 今見ているタブの候補。popup が開いたときに訊く。
 * 一覧は列挙済みのものをそのまま渡す — popup がもう一度 API を叩かないため。
 */
async function activeCandidate(): Promise<{ url: string; index: Index | null }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { url: "", index: null };
  return { url: candidates.get(tab.id) ?? "", index: shown.get(tab.id) ?? null };
}

/** 今の表示をやめる。「今はしない」と導入後の両方が呼ぶ。次に開けばまた出る。 */
async function clearActive(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await clear(tab.id);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const payload = message as { type?: string; url?: string; jsonLd?: string };

  if (payload.type === "visited" && payload.url !== undefined) {
    void visit(payload.url, sender.tab?.id, payload.jsonLd);
    return false;
  }
  // 導入後も「今はしない」と同じ。導入済みかどうかは収集一覧が持っているので
  // （`alreadyInstalled`）、service worker が別に覚える必要が無い。
  if (payload.type === "dismiss") { void clearActive(); return false; }
  if (payload.type === "candidate") {
    void activeCandidate().then(respond);
    return true;                                 // 非同期に返す
  }
  return false;
});

// SPA の遷移。カタログは JSON-LD をページから読む必要があるので、
// URL だけで判定せず content script に送り直してもらう。
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  void clear(details.tabId);
  void chrome.tabs.sendMessage(details.tabId, { type: "rescan" })
    .catch(() => { /* content script が入っていないページ */ });
});

chrome.tabs.onRemoved.addListener(tabId => {
  candidates.delete(tabId);
  shown.delete(tabId);
});
