import { AgentId } from "../core/agent.js";
import { Collected } from "../core/collection.js";
import { DetectKind, skillIndex, ToolLead, verifiedPage } from "../core/detect.js";
import { GitHubSource, needsPage, parseUrl, SUPPORTED_SITES } from "../core/github.js";
import { PAGE_LIMIT } from "../core/limits.js";
import {
  CONFIG_DIRS, placement, Placement, rootOf, RootState, splitRoot,
} from "../core/placement.js";
import {
  clearRoot, configHandle, exists, PickerError, pickerHint, pickerUnavailable, placeHandle,
} from "./fs.js";
import { rateLimitWatch, readText } from "./fetch.js";
import {
  filesFor, install, InstallError, InstallRequest, isExtractable, remove, willOverwrite,
} from "./install.js";
import { listSkills, SkillEntry } from "../core/tree.js";
import {
  autoOpenEnabled, forgetAll, loadCollection, setAutoOpenEnabled, setTheme, Theme, theme,
} from "./store.js";
import {
  animateDetection, applyI18n, applyLang, applyTheme, byId, clearStatus, setBusy, showStatus,
} from "./popupUi.js";
import { rootStates, targetSet, TargetOption } from "./targets.js";
import { detectWithJev, evidenceFromActiveTab } from "./aiDetect.js";
import { PageEvidence } from "./pageEvidence.js";
import {
  jevApiKey, jevEnabled, protectAiStorage, setJevApiKey, setJevEnabled,
} from "./aiSettings.js";
import { decideWithJev, JevDecision, JevError } from "./jev.js";
import { grantedSites, originPattern, patternHost } from "./sitePermissions.js";

const t = (key: string, ...args: string[]): string => chrome.i18n.getMessage(key, args);
/** `.claude` → `agentClaude`。設定画面と同じ言葉を使う。 */
const agentLabel = (configDir: string): string =>
  t(`agent${configDir.slice(1, 2).toUpperCase()}${configDir.slice(2)}`);
const send = (message: Record<string, unknown>): Promise<unknown> =>
  chrome.runtime.sendMessage(message).catch(() => undefined);

/*
 * 配色。持っている値は `color-scheme` にそのまま入るので、当てるのは 1 行で済む
 * （明暗の色は `tab.css` の `light-dark()` が選ぶ）。
 *
 * 他の何よりも先に読む。読み終わるまではシステムの配色で出るが、既定がそれなので
 * 変えていない利用者には何も起きない。
 */
const themePick = byId<HTMLFieldSetElement>("theme");

themePick.addEventListener("change", event => {
  const { value } = event.target as HTMLInputElement;
  applyTheme(value);
  void setTheme(value as Theme);
});

void theme().then(value => {
  applyTheme(value);
  for (const input of themePick.querySelectorAll("input")) input.checked = input.value === value;
});

applyLang(chrome.i18n.getUILanguage());
applyI18n(t);
byId<HTMLInputElement>("url").placeholder = t("tabUrlPlaceholder");

const sitesDialog = byId<HTMLDialogElement>("supported-sites");
const sitesList = byId<HTMLUListElement>("sites-list");
for (const site of SUPPORTED_SITES) {
  const row = document.createElement("li");
  const link = document.createElement("a");
  link.href = site.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = site.label;
  row.append(link);
  sitesList.append(row);
}

/**
 * popup の高さは中身で決まり、modal はその viewport に収まるよう潰される。通常画面は
 * 低いので、そのまま開くと一覧が下で切れる。開いている間だけ土台を伸ばして高さを作る。
 */
function showSites(open: boolean): void {
  document.body.classList.toggle("dialog", open);
  if (open) sitesDialog.showModal();
  else sitesDialog.close();
}

byId<HTMLButtonElement>("close-sites").addEventListener("click", () => showSites(false));
sitesDialog.addEventListener("close", () => document.body.classList.remove("dialog"));

/**
 * 「対応サイトのリンクを貼る」の「対応サイト」だけをリンクにする。
 * 語順は言語で変わるので、差し込み位置 `{}` は文言側に持たせて割る。
 *
 * `getMessage` の置換は使わない。制御文字を印にすると落とされて割れず、リンクが
 * 末尾に付く。文言にそのまま `{}` を書いておけば、置換を通らないので確実である。
 */
{
  const SLOT = "{}";
  const lead = byId("url-label");
  const parts = t("tabUrlLabel").split(SLOT);
  if (parts.length !== 2) console.error("Agent Tool: tabUrlLabel に", SLOT, "がありません");
  const link = document.createElement("button");
  link.type = "button";
  link.className = "link";
  link.textContent = t("tabSupportedSitesLink");   // 見出しとは別。文中なので英語は小文字
  link.addEventListener("click", () => showSites(true));
  lead.replaceChildren(parts[0] ?? "", link, parts[1] ?? "");
  // 案内文はボタンを含むので入力欄の名前に使えない。同じ文を読み上げ用に渡す。
  byId("url").setAttribute("aria-label", parts.join(link.textContent ?? ""));
}

let current: ToolLead | null = null;

// --- 導入先の選択 -------------------------------------------------------

const stateLabel = (state: RootState): string =>
  state.kind === "ok" ? ""
    : state.kind === "unset" ? `（${t("tabNeedsPermission")}）`
    : `（${t("rootMismatchShort", state.chosen)}）`;

/**
 * 導入先の選択。カード（1 件）と一覧（複数）で同じ選び方・同じ出し分けをするので、
 * 触る要素の id だけを変えて 2 つ作る。`permission` を持たない面もある。
 */
function targetPicker(ids: {
  select: string; path: string; hint: string; permission?: string;
}) {
  let options: TargetOption[] = [];
  let chosen: AgentId | null = null;
  let shared = false;
  const picked = (): TargetOption | undefined => options.find(option => option.agent === chosen);

  /** 選択に合わせて、入る場所と足りない設定を出し分ける。 */
  const show = (): void => {
    const option = picked();
    const path = byId(ids.path);
    const hint = byId(ids.hint);
    path.textContent = option === undefined ? "" : `~/${rootOf(option.where)}`;
    path.className = "repo";
    hint.className = "hint";
    hint.textContent = "";
    // 既に許可があるフォルダに「選んでください」と言わない。書き込み先だけを示す。
    if (ids.permission !== undefined) {
      byId(ids.permission).textContent =
        option === undefined ? ""
        : option.state.kind === "ok" ? t("tabPermissionNoteReady", `~/${rootOf(option.where)}`)
        : t("tabPermissionNote", `~/${option.where.configDir}`, `~/${rootOf(option.where)}`);
    }
    if (option === undefined || option.state.kind === "ok") return;

    if (option.state.kind === "unset") {
      hint.textContent = pickerHint(`~/${option.where.configDir}`);
      return;
    }
    // 別のフォルダが設定されている。入る先が違うので、赤字で示して導入も止める。
    path.className = "repo error";
    path.textContent = `~/${option.where.configDir} → ${option.state.chosen}`;
    hint.className = "hint error";
    hint.textContent = t("rootMismatch", `~/${option.where.configDir}`, option.state.chosen);
  };

  byId<HTMLSelectElement>(ids.select).addEventListener("change", event => {
    chosen = (event.target as HTMLSelectElement).value as AgentId;
    show();
  });

  return {
    picked,
    shared: () => shared,
    reset: () => { chosen = null; },
    render: async (kind: DetectKind, name: string): Promise<void> => {
      const select = byId<HTMLSelectElement>(ids.select);
      select.replaceChildren();
      ({ options, shared } = await targetSet(kind, name));

      for (const option of options) {
        const node = document.createElement("option");
        node.value = option.agent;
        node.textContent = `${agentLabel(option.where.configDir)}${stateLabel(option.state)}`;
        select.append(node);
      }
      // 正しく設定されているものがあればそれを初期値にする。無ければ先頭。
      chosen = (options.find(option => option.state.kind === "ok") ?? options[0])?.agent ?? null;
      if (chosen !== null) select.value = chosen;
      show();
    },
  };
}

const cardTarget = targetPicker({
  select: "target", path: "target-path", hint: "picker-hint", permission: "permission-note",
});
const indexTarget = targetPicker({
  select: "index-target", path: "index-path", hint: "index-hint",
});

/**
 * URL だけで取得元が決まらないカタログは、ページを 1 回読んで JSON-LD から採る。
 *
 * `vetted` は service worker が既に展開確認を済ませた候補。もう一度確かめると
 * アーカイブを 1 本（実測で数 MB）落とし直すことになるので、そこは飛ばす。
 */
async function resolve(raw: string, vetted: boolean): Promise<ToolLead | null> {
  const check = vetted
    ? async (): Promise<boolean> => true
    : async (found: ToolLead): Promise<boolean> => await isExtractable(found) === true;
  const direct = await verifiedPage(raw, "", check);
  if (direct !== null) return direct;
  const page = needsPage(raw);
  if (page === null) return null;
  const response = await fetch(page, { cache: "no-store" }).catch(() => null);
  if (response === null || !response.ok) return null;
  const html = await readText(response, PAGE_LIMIT);
  return html === null ? null : verifiedPage(raw, html, check);
}

function setMode(detected: boolean): void {
  document.body.classList.toggle("detected", detected);
  byId("found").hidden = !detected;
}

/**
 * 直前の一覧が GitHub の枠切れで読めなかったか。`listSkills` は理由を問わず空配列を
 * 返すので、「無い」と「読めなかった」を呼び出し側で分けるために覚える。
 */
let listRateLimited = false;

async function showLead(raw: string, vetted = false, alreadyIn = false): Promise<void> {
  // Skill が並ぶディレクトリなら一覧を出す。列挙は GitHub API を 1 回だけ使う。
  const at = skillIndex(raw);
  listRateLimited = false;
  if (at !== null) {
    const watch = rateLimitWatch();
    const entries = await listSkills(at.source, at.subdir, watch.get);
    listRateLimited = entries.length === 0 && watch.hit();
    if (entries.length > 0) {
      byId("url-error").hidden = true;
      await showIndex({ ...at, entries });
      return;
    }
  }
  const found = await resolve(raw, vetted);
  current = found;
  // 対応外の URL でこそ出す。検知できたときは `#url-section` ごと隠れる。
  // 枠切れで一覧が読めなかっただけのものを「指していません」と言わない。
  const error = byId("url-error");
  error.hidden = found !== null || raw === "";
  error.textContent = t(listRateLimited ? "badgeRateLimited" : "tabUrlUnsupported");
  clearStatus(byId("status"));
  byId("picker-hint").textContent = "";
  index = null;
  byId("index").hidden = true;
  byId("found").hidden = found === null;
  setMode(found !== null);
  if (found === null) return;

  byId("found-kind").textContent = t(found.kind === "skill" ? "kindSkill" : "kindSubagent");
  byId("found-name").textContent = found.name;
  byId("found-repo").textContent = found.source.repo;
  byId("security-source").textContent = t("tabSecuritySource", found.source.repo);
  byId("destination").hidden = true;             // 導入を押してから出す

  // 導入済みでも、別の Agent を選んで同じ取得元を追加できる。
  const tag = byId<HTMLSpanElement>("found-installed");
  const installBtn = byId<HTMLButtonElement>("install");
  tag.hidden = !alreadyIn;
  installBtn.hidden = false;
  animateDetection(byId("found"));
}

/** 検知の表示をやめて通常の画面に戻す。導入後とタブを移ったときに呼ぶ。 */
function backToNormal(): void {
  current = null;
  cardTarget.reset();
  index = null;
  byId("destination").hidden = true;
  byId("index").hidden = true;
  // 導入済みの印を次回に持ち越さない。導入ボタンも既定の表示に戻す。
  byId("found-installed").hidden = true;
  byId<HTMLButtonElement>("install").hidden = false;
  setMode(false);
  byId<HTMLInputElement>("url").value = "";
  byId("url-error").hidden = true;
}

byId<HTMLInputElement>("url").addEventListener("change", event => {
  const value = (event.target as HTMLInputElement).value.trim();
  if (value === "") { backToNormal(); return; }
  void showLead(value);
});

byId<HTMLButtonElement>("dismiss").addEventListener("click", () => {
  void send({ type: "dismiss" });
  backToNormal();
});

// --- 導入 ---------------------------------------------------------------

/** 選ばれた導入先が使えるか。使えなければ理由を出して null を返す。 */
function usableTarget(picked: TargetOption | undefined, status: HTMLElement): TargetOption | null {
  if (picked === undefined) {
    showStatus(status, t("tabPickTarget"), true);
    return null;
  }
  // 別のフォルダが設定されたままなら入れない。意図しない場所へ書かない。
  if (picked.state.kind === "mismatch") {
    showStatus(status, t("rootMismatch", `~/${picked.where.configDir}`, picked.state.chosen), true);
    return null;
  }
  return picked;
}

/**
 * 許可 → 上書き確認 → 書き込み。後始末はカードと行で違うので、書けたかだけを返す。
 * 取得の仕方（アーカイブかファイル単位か）は `build` が決める。
 */
async function writeTool(
  picked: TargetOption, where: Placement, name: string, status: HTMLElement,
  build: (root: FileSystemDirectoryHandle) => Omit<InstallRequest, "overwrite">,
): Promise<boolean> {
  showStatus(status, picked.state.kind === "unset" ? t("tabRequestingPermission") : t("tabInstalling"));
  const root = await placeHandle(where, true, { create: true });
  if (root === null) { showStatus(status, t("permissionLost")); return false; }
  showStatus(status, t("tabInstalling"));

  const request = build(root);
  if (await willOverwrite(request) && !confirm(t("overwriteConfirm", name))) {
    clearStatus(status);
    return false;
  }
  await install({ ...request, overwrite: true });
  return true;
}

byId<HTMLButtonElement>("install").addEventListener("click", async () => {
  const found = current;
  const status = byId("status");
  if (found === null) return;

  // 検知の時点では種類と名前だけを出している。どこへ入れるかはここで見せる。
  if (byId("destination").hidden) {
    byId("destination").hidden = false;
    await cardTarget.render(found.kind, found.name);
    return;
  }

  const picked = usableTarget(cardTarget.picked(), status);
  if (picked === null) return;
  const { agent, where } = picked;

  const button = byId<HTMLButtonElement>("install");
  const card = byId("found-card");
  setBusy(card, button, true);
  try {
    const written = await writeTool(picked, where, found.name, status,
      root => ({ lead: found, agent, placement: where, root }));
    if (!written) return;
    await send({ type: "dismiss" });               // バッジを下ろす。導入済みは収集一覧が持つ
    // 現在のタブへ「もう一度検知して」と伝える。content script が visited を送り直し、
    // SW の visit() が走り直し、次に popup を開いたとき「導入済み」が返る。
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined) {
        void chrome.tabs.sendMessage(tab.id, { type: "rescan" }).catch(() => { /* content script 不在 */ });
      }
    }).catch(() => { /* tabs へアクセスできない */ });
    backToNormal();
    // 読み上げのために先に出す。`hidden` の間は live region が木に載らない。
    const done = byId("done");
    done.hidden = false;
    byId("done-text").textContent = t("tabInstalled", found.name, `~/${rootOf(where)}`);
    // 中の「一覧を見る」に指がかかったまま消さない。フォーカスが body へ落ちる。
    setTimeout(() => {
      if (!done.contains(document.activeElement)) done.hidden = true;
    }, 6000);
  } catch (error) {
    showStatus(status, message(error, where), true);
  } finally {
    setBusy(card, button, false);
  }
});

const message = (error: unknown, where: Placement): string => {
  if (error instanceof PickerError) {
    if (error.kind === "cancelled") return "";
    if (error.kind === "unavailable") return pickerUnavailable();
    return t("pickerWrongFolder", error.chosen ?? "", `~/${where.configDir}`);
  }
  if (error instanceof InstallError) {
    if (error.kind === "tooLarge") return t("errorTooLarge");
    if (error.kind === "rollbackTooLarge") {
      return t("errorRollbackTooLarge", `~/${rootOf(where)}/${where.entry}`);
    }
    if (error.kind === "notFound") return t("errorNotFound");
    if (error.kind === "blocked") return t("errorBlocked", `~/${rootOf(where)}/${where.entry}`);
    if (error.kind === "unusableName") return t("errorUnusableName", error.message);
    return t("errorFetchFailed");
  }
  // 想定していない失敗を「接続を確かめて」で塗りつぶさない。理由をそのまま見せる。
  console.error("Agent Tool:", error);
  return error instanceof Error ? error.message : String(error);
};

// --- Skill が並ぶディレクトリ -------------------------------------------

/**
 * 1 件ではなく一覧を出す。**まとめては入れない** — 行ごとに利用者が決める。
 *
 * 実体はアーカイブではなくファイル単位で取るので、取得上限を超える大きいリポジトリ
 * （実測 116 MB）からも入れられる。列挙は service worker が済ませていればそれを使う。
 */
type SkillIndex = {
  readonly url: string; readonly source: GitHubSource;
  readonly subdir: string; readonly entries: SkillEntry[];
};
let index: SkillIndex | null = null;

async function showIndex(at: SkillIndex): Promise<void> {
  index = at;
  current = null;
  setMode(true);
  byId("found").hidden = true;
  byId("index").hidden = false;
  animateDetection(byId("index"));
  byId("index-title").textContent = t("tabIndexTitle", String(at.entries.length));
  byId("index-repo").textContent = `${at.source.repo}/${at.subdir}`;
  byId("index-security-source").textContent = t("tabSecuritySource", at.source.repo);
  byId("index-status").textContent = "";
  byId("index-status").className = "status";
  await indexTarget.render("skill", at.entries[0].name);

  const box = byId("index-list");
  box.replaceChildren();
  for (const entry of at.entries) {
    const row = document.createElement("li");
    const text = document.createElement("div");
    text.className = "name";
    text.textContent = entry.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = t("tabIndexFiles", String(entry.files.length));
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t("tabInstall");
    button.addEventListener("click", () => void installOne(entry, button));
    row.append(text, count, button);
    box.append(row);
  }
}

/** 一覧の 1 件を入れる。押した行だけを触り、他の行は残す。 */
async function installOne(entry: SkillEntry, button: HTMLButtonElement): Promise<void> {
  const status = byId("index-status");
  const row = button.parentElement ?? byId("index");
  clearStatus(status);
  const at = index;
  const picked = usableTarget(indexTarget.picked(), status);
  if (at === null || picked === null) return;
  const where = placement(picked.agent, "skill", entry.name, indexTarget.shared());
  if (where === null) return;

  const label = button.textContent ?? "";
  setBusy(row, button, true);
  let installed = false;
  try {
    const lead: ToolLead = {
      url: at.url, source: at.source, kind: "skill", name: entry.name, proofs: [],
    };
    installed = await writeTool(picked, where, entry.name, status, root => ({
      lead, agent: picked.agent, placement: where, root,
      // アーカイブではなくファイル単位で取る。大きいリポジトリでも 1 件ぶんで済む。
      fetchFiles: filesFor(at.source, at.subdir, entry),
    }));
    if (!installed) return;
    showStatus(status, t("tabInstalled", entry.name, `~/${rootOf(where)}`));
    button.textContent = t("tabInstalledShort");   // 入ったものは押せないままにする
  } catch (error) {
    showStatus(status, message(error, where), true);
  } finally {
    // **入ったときだけ**押せないままにする。許可が取れなかった・上書きをやめた・
    // 取得に失敗した行は必ず戻す。押せない行を残さない。
    setBusy(row, null, false);
    if (!installed) { button.textContent = label; button.disabled = false; }
  }
}

byId<HTMLButtonElement>("index-dismiss").addEventListener("click", () => {
  void send({ type: "dismiss" });
  backToNormal();
});

// --- 収集一覧 -----------------------------------------------------------

/** 許可が無いルートは実態を見られない。消えたのか残っているのか決めつけない。 */
type Row = { readonly item: Collected; readonly verified: boolean };

/**
 * 実態と突き合わせる。**許可を訊く**ので、クリックから始まる経路でだけ呼ぶ。
 *
 * 許可が無いと `exists` を呼べず、IDE 拡張や手で消されたものを落とせない。
 * popup を開いた直後の許可はまず `prompt` なので（`readRoots` の注記）、
 * 訊かずに済ませると一覧が実態と永久にずれる。一覧を開くのは利用者の明示操作なので、
 * ここで 1 回訊く。
 *
 * ルートが複数あるときは最初の 1 つしか訊けない（許可ダイアログは transient user
 * activation を消費する）。残りは `verified: false` のままにして、もう一度押せば次へ進む。
 */
async function reconcile(list: readonly Collected[]): Promise<Row[]> {
  // 同じルートを何度も開かない。`loadHandle` は呼ぶたびに IndexedDB を開け閉てするので、
  // 件数ではなくルートの数（高々 4 つ）に比例させる。
  const opened = new Map<string, FileSystemDirectoryHandle | null>();
  const handleFor = async (root: string): Promise<FileSystemDirectoryHandle | null> => {
    if (!opened.has(root)) {
      opened.set(root, await placeHandle(splitRoot(root), true).catch(() => null));
    }
    return opened.get(root) ?? null;
  };

  const rows: Row[] = [];
  const gone: Collected[] = [];
  for (const item of list) {
    const root = await handleFor(item.root);
    if (root === null) { rows.push({ item, verified: false }); continue; }
    const entry = item.kind === "skill" ? item.name : `${item.name}.md`;
    // IDE 側や手で消されていれば、ここで収集一覧から落とす。
    if (await exists(root, entry)) rows.push({ item, verified: true });
    else gone.push(item);
  }
  await forgetAll(gone);                          // 消えていた分を 1 回でまとめて落とす
  return rows;
}

const collectionBox = byId<HTMLDetailsElement>("collection-section");

/**
 * 描画のきっかけは「畳みを開く」「設定を開く」「削除した」「許可し直した」の 4 つある。
 * 同じ描画を重ねて走らせない。畳んでいる間は組まない — 見えないもののために
 * IndexedDB とハンドルの許可を見に行かない。
 */
let drawing: Promise<void> | null = null;
function refreshCollection(): void {
  if (!collectionBox.open || drawing !== null) return;
  drawing = renderCollection().finally(() => { drawing = null; });
}

collectionBox.addEventListener("toggle", refreshCollection);

async function renderCollection(): Promise<void> {
  const rows = await reconcile(await loadCollection());
  const box = byId("collection");
  box.replaceChildren();
  byId("collection-empty").hidden = rows.length > 0;
  byId("verify").hidden = rows.every(row => row.verified);
  // 件数バッジ。0 のときは空文字にして CSS で消す (見出しの右が空になる)。
  byId("collection-count").textContent = rows.length > 0 ? String(rows.length) : "";

  for (const { item, verified } of rows) {
    const row = document.createElement("li");
    if (!verified) row.className = "unverified";

    const text = document.createElement("div");
    text.className = "name";
    const name = document.createElement("div");
    name.textContent = item.name;
    const where = document.createElement("code");
    where.translate = false;                      // パスを自動翻訳に壊させない
    where.textContent = `~/${item.root}`;
    text.append(name, where);
    // 灰色にするだけでは「まだ入っている」と読まれる。確かめられていないと書く。
    if (!verified) {
      const why = document.createElement("div");
      why.className = "why";
      why.textContent = t("tabUnverified");
      text.append(why);
    }

    const button = document.createElement("button");
    button.textContent = t("tabRemove");
    button.addEventListener("click", () => void removeItem(item));

    row.append(text, button);
    box.append(row);
  }
}

/** 確かめ直す。許可を訊くのは `reconcile` の仕事なので、組み直すだけでよい。 */
byId<HTMLButtonElement>("verify").addEventListener("click", () => { void renderCollection(); });

async function removeItem(item: Collected): Promise<void> {
  if (!confirm(t("tabRemoveConfirm", item.name))) return;
  const status = byId("status");
  status.className = "status";
  const root = await placeHandle(splitRoot(item.root), true).catch(() => null);
  if (root === null) { status.textContent = t("permissionLost"); return; }

  const result = await remove(item, root, item.kind === "skill");
  if (result === "changed") {
    status.className = "status error";
    status.textContent = t("tabRemoveChanged", item.name);
  }
  await renderCollection();
}

// --- 未対応サイトの AI-assisted detection -------------------------------

async function showAiScanIfAvailable(): Promise<void> {
  const section = byId("ai-scan");
  section.hidden = true;
  if (!await jevEnabled().catch(() => false)) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  if (!/^https?:\/\//.test(url)) return;
  // 既知サイトは deterministic path が正本。AI の fallback にしない。
  if (parseUrl(url) !== null || needsPage(url) !== null) return;
  section.hidden = false;
}

byId<HTMLButtonElement>("ai-scan-button").addEventListener("click", async () => {
  const status = byId("ai-scan-status");
  const button = byId<HTMLButtonElement>("ai-scan-button");
  clearStatus(status);
  const key = await jevApiKey();
  if (key === "") {
    showStatus(status, t("aiKeyRequired"), true);
    return;
  }

  setBusy(byId("ai-scan"), button, true);
  showStatus(status, t("aiScanning"));
  try {
    const evidence = await evidenceFromActiveTab();
    // 読めなかった（権限・内部ページ）と、読めたが手がかりが無いを分ける。
    if (evidence === null) {
      showStatus(status, t("aiPageUnreadable"), true);
      return;
    }
    if (evidence.candidates.length === 0) {
      showStatus(status, t("aiNoCandidates"), true);
      return;
    }
    // 落ちたときに「何を渡して何と答えられたか」が残らないと、利用者の報告から段を
    // 特定できない（Beta の間は特に）。保持はせず、開いている devtools にだけ出す。
    let decision: JevDecision | undefined;
    let sent: PageEvidence | undefined;
    const result = await detectWithJev(evidence, key, async (...args) => {
      [sent] = args;                               // 絞り込み後。実際に送ったもの
      decision = await decideWithJev(...args);
      return decision;
    });
    if (result.kind === "unsupported-kind") {
      showStatus(status, t("aiUnsupportedKind", result.resource.toUpperCase()), true);
      return;
    }
    // 実在を確かめられなかった（通信不能）。「無い」と言うと直しようのない案内になる。
    if (result.kind === "unverified") {
      showStatus(status, t("aiSourceUnreadable", result.source.repo), true);
      return;
    }
    if (result.kind === "none") {
      // `debug` は devtools の既定（Verbose 非表示）で見えず、`warn` / `error` は
      // `chrome://extensions` のエラー一覧に拾われて**不具合が起きているように見える**。
      // 見つからなかったのは正常な結果なので、既定で出て拾われない `info` にする。
      console.info("Agent Tool: Jev", {
        候補: sent?.candidates.map(item => `${item.kind}: ${item.value}`),
        ページが名乗る名前: sent?.page.url,
        isToolPage: decision?.isToolPage,
        kind: decision && `${decision.kind.choice} p=${decision.kind.probabilities[decision.kind.choice]}`,
      });
      showStatus(status, t("aiNothingFound"), true);
      return;
    }

    // ページが複数の Tool を載せている。1 つに決めず、個別ページを開いてもらう。
    // ここで当てにいくと、まとめページで無関係な 1 件を出すことになる。
    if (result.kind === "many") {
      showStatus(status, t("aiManyTools", String(result.leads.length)), true);
      return;
    }

    // 決まった取得元を、既存の解決経路へそのまま渡す。リポジトリ直下は
    // skills.sh の形の URL を内部のアダプタとして使う（記録・取得は解決後の
    // `GitHubSource` で、skills.sh には触れない）。
    // `detectWithJev` が同じ lead で実在確認を済ませているので `vetted` を渡す。
    const show = async (url: string): Promise<boolean> => {
      byId<HTMLInputElement>("url").value = url;
      await showLead(url, true);
      return index !== null || current !== null;
    };
    const shown = result.kind === "found"
      ? await show(result.lead.url)
      : await show(`https://skills.sh/${result.source.repo}`);
    if (!shown) {
      // 取得元までは決まっている。ここで「見つかりません」と言うと、利用者は
      // 直しようのない案内を受け取る。読めなかった理由と repo をそのまま出す。
      const source = result.kind === "found" ? result.lead.source : result.source;
      showStatus(status, t(listRateLimited ? "aiSourceRateLimited" : "aiSourceUnreadable",
                           source.repo), true);
      return;
    }
    byId("ai-scan").hidden = true;
    // Tool を確かめられたので、ここで初めて「次からは自動で」を提案できる。
    await offerAutomation();
  } catch (error) {
    if (error instanceof JevError) {
      const key = error.kind === "auth" ? "aiAuthError"
        : error.kind === "rateLimit" ? "aiRateLimit"
        : "aiRequestFailed";
      showStatus(status, t(key), true);
    } else {
      console.error("Agent Tool: AI detection", error);
      showStatus(status, t("aiRequestFailed"), true);
    }
  } finally {
    setBusy(byId("ai-scan"), button, false);
  }
});

// --- 許可済みサイトの自動検知 -------------------------------------------

/** 今開いているタブの URL。`chrome.tabs` を何度も叩かないよう 1 箇所にまとめる。 */
const activeUrl = async (): Promise<string> =>
  (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url ?? "";

/**
 * Tool を確認できたサイトにだけ「今後は自動で」を出す。
 *
 * **見つかっただけでは permission を求めない。** 出すのは CTA までで、
 * `chrome.permissions.request()` は利用者がボタンを押したときにしか呼ばない
 * （押さずに呼ぶと Chrome 側が例外にする）。
 */
async function offerAutomation(): Promise<void> {
  const card = byId("auto-site");
  card.hidden = true;
  const pattern = originPattern(await activeUrl());
  if (pattern === null) return;
  // 既に許可済みなら勧めない。外すのは設定画面でできる。
  if (await chrome.permissions.contains({ origins: [pattern] })) return;
  byId("auto-site-origin").textContent = patternHost(pattern) ?? pattern;
  clearStatus(byId("auto-site-status"));
  card.hidden = false;
}

byId("auto-site-dismiss").addEventListener("click", () => { byId("auto-site").hidden = true; });

byId("auto-site-allow").addEventListener("click", async () => {
  const status = byId("auto-site-status");
  const pattern = originPattern(await activeUrl());
  if (pattern === null) return;
  try {
    // Chrome の permission dialog は popup を閉じることがある。**戻り値で UI を組み立てない** —
    // 許可は成立するので、開き直したときに `contains` から出し直す（`offerAutomation`）。
    if (!await chrome.permissions.request({ origins: [pattern] })) {
      showStatus(status, t("autoSiteDenied"), true);
      return;
    }
  } catch {
    showStatus(status, t("autoSiteFailed"), true);
    return;
  }
  byId("auto-site").hidden = true;
  // 許可は grant 後のページにしか効かない。開いたままのタブは、ここで一度走らせないと
  // 次に遷移するまで何も起きない。
  await send({ type: "rescanActive" });
});

/**
 * 許可したサイトの一覧。正本は `chrome.permissions` なので、開くたびにそこから作る
 * （独自の保存を持つと、Chrome 側で外されたときに二重正本になる）。
 */
async function renderAutoSites(): Promise<void> {
  const box = byId("auto-sites");
  box.replaceChildren();
  const { origins = [] } = await chrome.permissions.getAll();
  const sites = grantedSites(origins);
  if (sites.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = t("autoSitesEmpty");
    box.append(empty);
    return;
  }
  for (const pattern of sites) {
    const row = document.createElement("div");
    row.className = "root";
    const name = patternHost(pattern) ?? pattern;
    const host = document.createElement("code");
    host.translate = false;
    const link = document.createElement("a");
    link.href = `https://${name}/`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = name;
    host.append(link);
    const drop = document.createElement("button");
    drop.className = "clear";
    drop.type = "button";
    drop.title = t("autoSitesRemove");
    drop.setAttribute("aria-label", t("autoSitesRemove"));
    drop.textContent = "×";
    drop.addEventListener("click", async () => {
      await chrome.permissions.remove({ origins: [pattern] });
      await renderAutoSites();
    });
    row.append(host, drop);
    box.append(row);
  }
}

// --- 設定。別タブへ飛ばさず popup の中で切り替える ----------------------

function setSettings(open: boolean): void {
  document.body.classList.toggle("settings", open);
  byId("settings-view").hidden = !open;
  if (open) { void renderRoots(); void renderAutoSites(); refreshCollection(); }
  else void showAiScanIfAvailable();
}

async function renderRoots(): Promise<void> {
  const roots = await rootStates();
  const box = byId("roots");
  box.replaceChildren();

  for (const configDir of CONFIG_DIRS) {
    const state = roots.get(configDir) ?? { kind: "unset" as const };
    const row = document.createElement("div");
    row.className = state.kind === "mismatch" ? "root bad" : "root";

    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "root-name";
    name.textContent = agentLabel(configDir);
    const path = document.createElement("code");
    path.translate = false;                       // 同上
    text.append(name, path);

    if (state.kind === "mismatch") {
      // 設定されているフォルダを赤字で見せる。何が入っているのか分からないまま
      // 「選び直す」とだけ言われても直しようがない。
      path.className = "error";
      path.textContent = `~/${configDir} → ${state.chosen}`;
      const why = document.createElement("div");
      why.className = "error";
      why.textContent = t("rootMismatch", `~/${configDir}`, state.chosen);
      text.append(why);
    } else {
      path.textContent = `~/${configDir}`;
    }

    const actions = document.createElement("div");
    actions.className = "root-actions";

    const button = document.createElement("button");
    button.textContent = state.kind === "ok" ? t("settingsGranted") : t("settingsChoose");
    if (state.kind !== "ok") button.className = "primary";
    button.addEventListener("click", () => void grant(configDir, state.kind !== "unset"));
    actions.append(button);

    // 設定してあるときだけ取り消せる。間違ったフォルダを入れたまま直せないと困る。
    if (state.kind !== "unset") {
      const clear = document.createElement("button");
      clear.className = "clear";
      clear.type = "button";
      clear.title = t("settingsClear");
      clear.setAttribute("aria-label", t("settingsClear"));
      clear.textContent = "×";
      clear.addEventListener("click", async () => {
        await clearRoot(configDir);
        byId("settings-status").textContent = "";
        await renderRoots();
      });
      actions.append(clear);
    }

    row.append(text, actions);
    box.append(row);
  }
}

/** `again` が真なら、覚えているフォルダを使わず必ずピッカーを開く。 */
async function grant(configDir: string, again: boolean): Promise<void> {
  const status = byId("settings-status");
  status.className = "status";
  status.textContent = "";
  try {
    const handle = await configHandle(configDir, true, again);
    if (handle !== null) status.textContent = t("settingsSaved", `~/${configDir}`);
    await renderRoots();
  } catch (error) {
    if (error instanceof PickerError && error.kind !== "cancelled") {
      status.className = "status error";
      status.textContent = error.kind === "unavailable"
        ? pickerUnavailable()
        : t("pickerWrongFolder", error.chosen ?? "", `~/${configDir}`);
    }
    // 失敗しても状態は変わっている。いま何が設定されているかを出し直す。
    await renderRoots();
  }
}

/** 導入直後の案内から、入れたものの一覧へ。設定を開いて畳みも開く。 */
byId<HTMLButtonElement>("done-open").addEventListener("click", () => {
  collectionBox.open = true;                     // 畳んでいれば toggle が描画を起こす
  setSettings(true);
});

byId("hint").textContent = pickerHint("~/.claude");
byId<HTMLButtonElement>("open-settings").addEventListener("click", () => setSettings(true));
byId<HTMLButtonElement>("close-settings").addEventListener("click", () => setSettings(false));

// --- 起動 ---------------------------------------------------------------

const autoOpen = byId<HTMLInputElement>("auto-open");
autoOpen.addEventListener("change", () => void setAutoOpenEnabled(autoOpen.checked));

const jevToggle = byId<HTMLInputElement>("jev-enabled");

/**
 * 鍵の有無で入力欄と「保存済み」を入れ替える。保存した値は読み戻さない（消す導線だけ）。
 * 鍵が無いときは有効にできない — 押しても毎回「鍵を登録してください」になるだけなので、
 * 入口で止める。
 */
async function renderJevKey(): Promise<void> {
  const stored = (await jevApiKey()) !== "";
  byId("jev-key-entry").hidden = stored;
  byId("jev-key-saved").hidden = !stored;
  jevToggle.disabled = !stored;
  if (!stored && jevToggle.checked) {
    jevToggle.checked = false;
    await setJevEnabled(false);
  }
}

jevToggle.addEventListener("change", async () => {
  await setJevEnabled(jevToggle.checked);
  void showAiScanIfAvailable();
});

byId<HTMLButtonElement>("jev-save").addEventListener("click", async () => {
  const input = byId<HTMLInputElement>("jev-api-key");
  if (input.value.trim() === "") return;         // 削除は専用ボタン。空保存では消さない
  await setJevApiKey(input.value);
  input.value = "";
  // 鍵を入れたのは使うためなので、ここで有効にする。トグルの押し忘れで
  // 「鍵は入れたのに何も出ない」を作らない。解析は毎回ボタンを押すまで走らない。
  await setJevEnabled(true);
  jevToggle.checked = true;
  await renderJevKey();
  showStatus(byId("jev-status"), t("aiKeySaved"));
});

byId<HTMLButtonElement>("jev-delete").addEventListener("click", async () => {
  await setJevApiKey("");
  await setJevEnabled(false);                    // 鍵の無い「有効」を残さない
  await renderJevKey();
  showStatus(byId("jev-status"), t("aiKeyRemoved"));
});

void (async () => {
  // Beta の初期化で既存の検知・導入を止めない。`setAccessLevel` が使えない環境では
  // 鍵を預からず、トグルを disabled のままにして popup は通常どおり開く。
  try {
    await protectAiStorage();
    jevToggle.checked = await jevEnabled();
    await renderJevKey();
  } catch (error) {
    console.info("Agent Tool: AI-assisted detection unavailable", error);
  }
  autoOpen.checked = await autoOpenEnabled();

  // 検知の候補は「今見ているタブのもの」だけを受け取る（別のタブのものを出さない）。
  const candidate = await send({ type: "candidate" }) as
    { url?: string; index?: SkillIndex | null; installed?: string } | undefined;
  // 列挙済みの一覧があればそれを使う。popup から API をもう一度叩かない。
  if (candidate?.index != null && candidate.index.entries.length > 0) {
    await showIndex(candidate.index);
    return;
  }
  if (typeof candidate?.url === "string" && candidate.url !== "") {
    byId<HTMLInputElement>("url").value = candidate.url;
    await showLead(candidate.url, true);
    return;
  }
  // 既に入っているものは popup を開いたときにだけ「導入済み」で見せる。バッジは
  // 出していないので、開いた本人にしか見えない — 毎回勧める形にはしない。
  // 実体の確認は service worker が済ませている（`installedFromSameSource`）。
  if (candidate?.installed) {
    byId<HTMLInputElement>("url").value = candidate.installed;
    await showLead(candidate.installed, true, true);
    return;
  }
  // バッジはタブに残るが、候補は service worker のメモリにしかない（MV3 は数十秒で
  // 停止する）。押しても何も出ないバッジを残さないよう、ここで下ろす。
  await send({ type: "dismiss" });
  await showAiScanIfAvailable();
})();
