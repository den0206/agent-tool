import { detectPage, proofUrls, skillIndex, ToolLead } from "../core/detect.js";
import { GitHubSource } from "../core/github.js";
import { listSkills, SkillEntry } from "../core/tree.js";
import { Collected, MAX_BROWSER_COLLECTION_ENTRIES } from "../core/collection.js";
import { rootStateOf, splitRoot } from "../core/placement.js";
import { autoOpenEnabled, forget, loadCollection, loadHandle } from "./store.js";
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
 * 既に入っているものは**バッジを出さず**、popup を開いたときにだけ「導入済み」として
 * 見せる。毎回勧めないという方針は変えないが、利用者が自分から popup を開いたときは
 * 「このページのものは入っている」と分かるようにする。
 *
 * 覚えているのは URL だけ — 種類・名前は popup 側が `resolve` でもう一度出す
 * （直リンクなら追加の取得は無く、カタログでも 1 回で済む）。
 */
const installed = new Map<number, string>();

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
 * rate limit を告げているバッジが乗っているタブ。`clear` はここも見て掃除する。
 * 「取れなかった一覧」を覚えたいわけではないので候補・一覧の map には入れない。
 */
const rateLimited = new Set<number>();

/**
 * 列挙は GitHub API を 1 回使う（未認証は 60 req/時）。同じ置き場を見るたびに叩かない
 * よう、この起動中のメモリにだけ覚える。件数上限は収集一覧と同じにする。
 */
const listed = new Map<string, SkillEntry[]>();

/**
 * 「読めなかった」と「並んでいない」を混ぜないため、fetch を包んで rate limit を
 * 見張る（403/429 + `x-ratelimit-remaining: 0`）。0 件返りの理由が枠切れなら
 * 呼び出し側へ `rateLimited` を返し、バッジで告げる（`core/tree.ts` の `listFiles`
 * が `fetchFailed` を throw するのと同じ姿勢を、一覧側にも通す）。
 */
type EnumerationResult =
  | { readonly kind: "entries"; readonly entries: SkillEntry[] }
  | { readonly kind: "rateLimited" };

async function enumerate(
  at: { source: GitHubSource; subdir: string },
): Promise<EnumerationResult> {
  const key = `${at.source.repo}\n${at.source.branch ?? ""}\n${at.subdir}`;
  const cached = listed.get(key);
  if (cached !== undefined) return { kind: "entries", entries: cached };

  let rateLimitHit = false;
  const observant: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if ((response.status === 403 || response.status === 429)
        && response.headers.get("x-ratelimit-remaining") === "0") {
      rateLimitHit = true;
    }
    return response;
  };

  const entries = await listSkills(at.source, at.subdir, url => fetchJson(url, observant));
  if (entries.length === 0) {
    // 枠切れ = 読めなかったことを利用者に伝える。「並んでいない」と誤解させない。
    return rateLimitHit ? { kind: "rateLimited" } : { kind: "entries", entries: [] };
  }
  const oldest = listed.keys().next().value;
  if (listed.size >= MAX_BROWSER_COLLECTION_ENTRIES && oldest !== undefined) listed.delete(oldest);
  listed.set(key, entries);
  return { kind: "entries", entries };
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
 * 「これは今見ているページの取得元から入っている」と赤字で断言できる強い一致。
 *
 * 収集一覧に記録があるだけでは足りない — ブラウザ拡張の外で消されたとき、記録は
 * 残り続けるからである（`remove` を経由しない削除は `forget` を呼ばない）。
 * FSA で実体があると確かめられたときにだけ真にする。
 *
 * 許可が取れず確かめようがないときは false を返す。収集一覧を信じてしまうと、
 * サービスワーカーが冷える度に「導入済み」の誤表示が復活する（`queryPermission` は
 * 冷えた文脈で `prompt` を返し、削除の反映を見逃す）。false のときは通常の導入
 * ダイアログが出るが、同名の上書きは導入時の確認ダイアログが止める。
 *
 * 実体が確かに無いと分かった場合は、その場で収集一覧から落として二度と誤表示させない。
 */
async function installedFromSameSource(found: ToolLead): Promise<boolean> {
  const match = (await loadCollection()).find(item =>
    item.name === found.name && item.kind === found.kind
    && item.repo === found.source.repo);
  if (match === undefined) return false;
  const verdict = await stillOnDisk(match);
  if (verdict === "missing") await forget(match);
  return verdict === "present";
}

/**
 * 収集一覧の 1 件が実体としてまだ置き場に残っているか。
 * 許可が要る API を呼ぶが、`granted` のときだけ叩いてダイアログは出さない。
 *
 * `Collected.root` は `.claude/skills` の形（`rootOf(placement)`）で入っており、
 * IndexedDB のハンドルは設定ディレクトリ（`.claude`）だけを鍵に持つので、
 * 分けて突き合わせる。
 */
async function stillOnDisk(item: Collected): Promise<"present" | "missing" | "unknown"> {
  const { configDir, sub } = splitRoot(item.root);
  const config = await loadHandle(configDir);
  if (config === undefined) return "unknown";
  if (rootStateOf(configDir, config.name).kind !== "ok") return "unknown";
  if (await config.queryPermission({ mode: "read" }) !== "granted") return "unknown";
  // 置き場（`skills` / `agents`）ごと消えていれば実体も無い。
  const dir = sub === "" ? config : await config.getDirectoryHandle(sub).catch(() => null);
  if (dir === null) return "missing";
  const entry = item.kind === "skill" ? item.name : `${item.name}.md`;
  try {
    for await (const [name] of dir.entries()) if (name === entry) return "present";
  } catch { return "unknown"; }               // 読めなければ黙って許すのは呼び出し側
  return "missing";
}

const clear = async (tabId: number): Promise<void> => {
  const had = candidates.delete(tabId);
  const hadIndex = shown.delete(tabId);
  const hadLimit = rateLimited.delete(tabId);
  const hadInstalled = installed.delete(tabId);
  if (!had && !hadIndex && !hadLimit && !hadInstalled) return;
  // 導入済み表示はバッジを持たないので、それだけの場合は setBadgeText を呼ばない。
  if (had || hadIndex || hadLimit) {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { /* タブが閉じた */ });
  }
  // rate limit の告知だけがタイトルを差し替える。ここでも必ず元へ戻す。
  if (hadLimit) await chrome.action.setTitle({ tabId, title: "" }).catch(() => { /* 同上 */ });
};

/** バッジを出し、設定されているときだけ popup を開く。 */
async function announce(tabId: number, text: string, open: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text, tabId }).catch(() => { /* タブが閉じた */ });
  // popup の `--accent` と同じ紫。バッジはアイコンの上に出るので、そこで色がずれない。
  await chrome.action.setBadgeBackgroundColor({ color: "#5b4bd6", tabId }).catch(() => { /* 同上 */ });
  // 文字色を明示。既定は Chrome が地の色から自動で決めるため、機種や配色設定で
  // グレー寄りに落ちて数字が中心からずれて見えることがある。白で固定する。
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff", tabId }).catch(() => { /* Chrome 110 未満 */ });
  // `openPopup` は Chrome 127 以降で、それ未満と
  // 操作の文脈によっては開けない。そのときはバッジだけにする（manifest の
  // `minimum_chrome_version` は `light-dark()` が要る 123 に置く。これは必須ではない）。
  // **別ウィンドウは作らない** — 見ていたページが隠れる。
  if (open) await chrome.action.openPopup().catch(() => { /* バッジで足りる */ });
}

/**
 * 枠切れの告知。**popup は開かない** — 利用者ができるのは待つことだけで、
 * 開いても入れられるものは無い。紫（候補あり）と混ぜないよう別の色を当てる。
 * 理由はホバーで見えるようタイトルへ入れる。
 */
async function announceRateLimited(tabId: number): Promise<void> {
  rateLimited.add(tabId);
  await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => { /* タブが閉じた */ });
  await chrome.action.setBadgeBackgroundColor({ color: "#c9411c", tabId }).catch(() => { /* 同上 */ });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff", tabId }).catch(() => { /* Chrome 110 未満 */ });
  await chrome.action.setTitle({ tabId, title: chrome.i18n.getMessage("badgeRateLimited") })
    .catch(() => { /* 同上 */ });
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
    const result = await enumerate(at);
    if (result.kind === "rateLimited") {
      // popup は開かない（autoOpen 設定に関わらず）。バッジと tooltip だけで告げる。
      await announceRateLimited(tabId);
      return;
    }
    if (result.entries.length === 0) return;
    shown.set(tabId, { ...at, entries: result.entries });
    await announce(tabId, String(result.entries.length), autoOpen);
    return;
  }

  const found = detectPage(url, jsonLd ?? "");
  if (found === null) return;
  if (!await exists(found)) return;
  // 取得元まで一致するものだけを「導入済み」として popup で見せる。
  // バッジは出さない — 毎回勧めないという方針は保つ。
  if (await installedFromSameSource(found)) {
    installed.set(tabId, found.url);
    return;
  }
  // 別リポジトリの同名 Skill を持っているだけで検知が消える誤判定を避けるため、
  // 名前だけの一致は「導入済み」とは扱わない。ただし黙って引くのはやめて、
  // 導入ボタン付きで見せる（同名上書きは導入時の確認ダイアログが止める）。
  if (!await extractable(found)) return;

  candidates.set(tabId, found.url);
  await announce(tabId, "1", autoOpen);
}

/**
 * 今見ているタブの候補。popup が開いたときに訊く。
 * 一覧は列挙済みのものをそのまま渡す — popup がもう一度 API を叩かないため。
 */
async function activeCandidate(): Promise<{
  url: string; index: Index | null; installed: string;
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { url: "", index: null, installed: "" };
  return {
    url: candidates.get(tab.id) ?? "",
    index: shown.get(tab.id) ?? null,
    installed: installed.get(tab.id) ?? "",
  };
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
  rateLimited.delete(tabId);
});
