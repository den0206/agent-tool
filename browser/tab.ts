import { AgentId } from "../core/agent.js";
import { Collected } from "../core/collection.js";
import { skillIndex, ToolLead, verifiedPage } from "../core/detect.js";
import { GitHubSource, needsPage, SUPPORTED_SITES } from "../core/github.js";
import { PAGE_LIMIT } from "../core/limits.js";
import {
  CONFIG_DIRS, placement, Placement, rootOf, RootState, splitRoot, targets,
} from "../core/placement.js";
import {
  clearRoot, configHandle, exists, PickerError, pickerHint, pickerUnavailable, placeHandle,
} from "./fs.js";
import { fetchJson } from "./fetch.js";
import {
  filesFor, install, InstallError, isExtractable, remove, willOverwrite,
} from "./install.js";
import { listSkills, SkillEntry } from "../core/tree.js";
import {
  autoOpenEnabled, forgetAll, loadCollection, setAutoOpenEnabled, setTheme, Theme, theme,
} from "./store.js";
import {
  animateDetection, applyI18n, applyTheme, byId, clearStatus, setBusy, showStatus,
} from "./popupUi.js";
import { rootStates, targetSet, TargetOption } from "./targets.js";

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
let chosen: AgentId | null = null;

// --- 導入先の選択 -------------------------------------------------------

/** 導入先の候補。選ばれているものを `chosen` に持つ。 */
let options: TargetOption[] = [];

const stateLabel = (state: RootState): string =>
  state.kind === "ok" ? ""
    : state.kind === "unset" ? `（${t("tabNeedsPermission")}）`
    : `（${t("rootMismatchShort", state.chosen)}）`;

/** 選択に合わせて、入る場所と足りない設定を出し分ける。 */
function showTarget(): void {
  const picked = options.find(option => option.agent === chosen);
  const path = byId("target-path");
  const hint = byId("picker-hint");
  const permission = byId("permission-note");
  path.textContent = picked === undefined ? "" : `~/${rootOf(picked.where)}`;
  path.className = "repo";
  hint.className = "hint";
  hint.textContent = "";
  permission.textContent = picked === undefined ? "" : t(
    "tabPermissionNote", `~/${picked.where.configDir}`, `~/${rootOf(picked.where)}`,
  );
  if (picked === undefined || picked.state.kind === "ok") return;

  if (picked.state.kind === "unset") {
    hint.textContent = pickerHint(`~/${picked.where.configDir}`);
    return;
  }
  // 別のフォルダが設定されている。入る先が違うので、赤字で示して導入も止める。
  path.className = "repo error";
  path.textContent = `~/${picked.where.configDir} → ${picked.state.chosen}`;
  hint.className = "hint error";
  hint.textContent = t("rootMismatch", `~/${picked.where.configDir}`, picked.state.chosen);
}

async function renderTargets(found: ToolLead): Promise<void> {
  const select = byId<HTMLSelectElement>("target");
  select.replaceChildren();
  ({ options } = await targetSet(found.kind, found.name));

  for (const picked of options) {
    const option = document.createElement("option");
    option.value = picked.agent;
    option.textContent = `${agentLabel(picked.where.configDir)}${stateLabel(picked.state)}`;
    select.append(option);
  }
  // 正しく設定されているものがあればそれを初期値にする。無ければ先頭。
  chosen = (options.find(option => option.state.kind === "ok") ?? options[0])?.agent ?? null;
  if (chosen !== null) select.value = chosen;
  showTarget();
}

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
  if (Number(response.headers.get("content-length") ?? 0) > PAGE_LIMIT) return null;
  return verifiedPage(raw, (await response.text()).slice(0, PAGE_LIMIT), check);
}

function setMode(detected: boolean): void {
  document.body.classList.toggle("detected", detected);
  byId("found").hidden = !detected;
  if (detected && !byId("found").hidden) animateDetection(byId("found"));
}

async function showLead(raw: string, vetted = false): Promise<void> {
  // Skill が並ぶディレクトリなら一覧を出す。列挙は GitHub API を 1 回だけ使う。
  const at = skillIndex(raw);
  if (at !== null) {
    const entries = await listSkills(at.source, at.subdir, fetchJson);
    if (entries.length > 0) {
      byId("url-error").hidden = true;
      await showIndex({ ...at, entries });
      return;
    }
  }
  const found = await resolve(raw, vetted);
  current = found;
  // 対応外の URL でこそ出す。検知できたときは `#url-section` ごと隠れる。
  byId("url-error").hidden = found !== null || raw === "";
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
}

/** 検知の表示をやめて通常の画面に戻す。導入後とタブを移ったときに呼ぶ。 */
function backToNormal(): void {
  current = null;
  chosen = null;
  index = null;
  byId("destination").hidden = true;
  byId("index").hidden = true;
  setMode(false);
  byId<HTMLInputElement>("url").value = "";
  byId("url-error").hidden = true;
}

byId<HTMLInputElement>("url").addEventListener("change", event => {
  const value = (event.target as HTMLInputElement).value.trim();
  if (value === "") { backToNormal(); return; }
  void showLead(value);
});

byId<HTMLSelectElement>("target").addEventListener("change", event => {
  chosen = (event.target as HTMLSelectElement).value as AgentId;
  showTarget();
});

byId<HTMLButtonElement>("dismiss").addEventListener("click", () => {
  void send({ type: "dismiss" });
  backToNormal();
});

// --- 導入 ---------------------------------------------------------------

byId<HTMLButtonElement>("install").addEventListener("click", async () => {
  const found = current;
  const status = byId("status");
  if (found === null) return;

  // 検知の時点では種類と名前だけを出している。どこへ入れるかはここで見せる。
  if (byId("destination").hidden) {
    byId("destination").hidden = false;
    await renderTargets(found);
    return;
  }

  const picked = options.find(option => option.agent === chosen);
  if (picked === undefined) {
    showStatus(status, t("tabPickTarget"), true);
    return;
  }
  const { agent, where } = picked;
  // 別のフォルダが設定されたままなら入れない。意図しない場所へ書かない。
  if (picked.state.kind === "mismatch") {
    showStatus(status, t("rootMismatch", `~/${where.configDir}`, picked.state.chosen), true);
    return;
  }

  const button = byId<HTMLButtonElement>("install");
  const card = byId("found-card");
  setBusy(card, button, true);
  showStatus(status, picked.state.kind === "unset" ? t("tabRequestingPermission") : t("tabInstalling"));
  try {
    const root = await placeHandle(where, true, { create: true });
    if (root === null) { showStatus(status, t("permissionLost")); return; }
    showStatus(status, t("tabInstalling"));

    const request = { lead: found, agent, placement: where, root };
    if (await willOverwrite(request) && !confirm(t("overwriteConfirm", found.name))) {
      clearStatus(status);
      return;
    }
    await install({ ...request, overwrite: true });
    await send({ type: "dismiss" });               // バッジを下ろす。導入済みは収集一覧が持つ
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
let indexOptions: TargetOption[] = [];
let indexAgent: AgentId | null = null;
/** 共有ストアが許可済みか。行ごとに置き場を組み直すのに要る。 */
let indexShared = false;

function showIndexTarget(): void {
  const picked = indexOptions.find(option => option.agent === indexAgent);
  const path = byId("index-path");
  const hint = byId("index-hint");
  path.className = "repo";
  hint.className = "hint";
  hint.textContent = "";
  path.textContent = picked === undefined ? "" : `~/${rootOf(picked.where)}`;
  if (picked === undefined || picked.state.kind === "ok") return;
  if (picked.state.kind === "unset") {
    hint.textContent = pickerHint(`~/${picked.where.configDir}`);
    return;
  }
  path.className = "repo error";
  path.textContent = `~/${picked.where.configDir} → ${picked.state.chosen}`;
  hint.className = "hint error";
  hint.textContent = t("rootMismatch", `~/${picked.where.configDir}`, picked.state.chosen);
}

async function renderIndexTargets(sample: string): Promise<void> {
  const select = byId<HTMLSelectElement>("index-target");
  select.replaceChildren();
  const resolved = await targetSet("skill", sample);
  indexOptions = resolved.options;
  indexShared = resolved.shared;

  for (const picked of indexOptions) {
    const option = document.createElement("option");
    option.value = picked.agent;
    option.textContent = `${agentLabel(picked.where.configDir)}${stateLabel(picked.state)}`;
    select.append(option);
  }
  indexAgent = (indexOptions.find(option => option.state.kind === "ok") ?? indexOptions[0])?.agent ?? null;
  if (indexAgent !== null) select.value = indexAgent;
  showIndexTarget();
}

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
  await renderIndexTargets(at.entries[0].name);

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
  const picked = indexOptions.find(option => option.agent === indexAgent);
  const row = button.parentElement ?? byId("index");
  clearStatus(status);
  if (index === null || picked === undefined) {
    showStatus(status, t("tabPickTarget"), true);
    return;
  }
  // 別のフォルダが設定されたままなら入れない。意図しない場所へ書かない。
  if (picked.state.kind === "mismatch") {
    showStatus(status, t("rootMismatch", `~/${picked.where.configDir}`, picked.state.chosen), true);
    return;
  }
  const where = placement(picked.agent, "skill", entry.name, indexShared);
  if (where === null) return;

  const label = button.textContent ?? "";
  setBusy(row, button, true);
  showStatus(status, picked.state.kind === "unset" ? t("tabRequestingPermission") : t("tabInstalling"));
  let installed = false;
  try {
    const root = await placeHandle(where, true, { create: true });
    if (root === null) { showStatus(status, t("permissionLost")); return; }

    showStatus(status, t("tabInstalling"));
    const lead: ToolLead = {
      url: index.url, source: index.source, kind: "skill", name: entry.name, proofs: [],
    };
    const request = {
      lead, agent: picked.agent, placement: where, root,
      // アーカイブではなくファイル単位で取る。大きいリポジトリでも 1 件ぶんで済む。
      fetchFiles: filesFor(index.source, index.subdir, entry),
    };
    if (await willOverwrite(request) && !confirm(t("overwriteConfirm", entry.name))) {
      clearStatus(status);
      return;
    }
    await install({ ...request, overwrite: true });
    installed = true;
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

byId<HTMLSelectElement>("index-target").addEventListener("change", event => {
  indexAgent = (event.target as HTMLSelectElement).value as AgentId;
  showIndexTarget();
});

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

// --- 設定。別タブへ飛ばさず popup の中で切り替える ----------------------

function setSettings(open: boolean): void {
  document.body.classList.toggle("settings", open);
  byId("settings-view").hidden = !open;
  if (open) { void renderRoots(); refreshCollection(); }
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

void (async () => {
  autoOpen.checked = await autoOpenEnabled();
  // 検知の候補は「今見ているタブのもの」だけを受け取る（別のタブのものを出さない）。
  const candidate = await send({ type: "candidate" }) as
    { url?: string; index?: SkillIndex | null } | undefined;
  // 列挙済みの一覧があればそれを使う。popup から API をもう一度叩かない。
  if (candidate?.index != null && candidate.index.entries.length > 0) {
    await showIndex(candidate.index);
    return;
  }
  if (typeof candidate?.url === "string" && candidate.url !== "") {
    byId<HTMLInputElement>("url").value = candidate.url;
    await showLead(candidate.url, true);
  }
})();
