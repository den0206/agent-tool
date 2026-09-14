import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AgentId, KindId, ScopeId } from "../core/agent";
import { AgentInfo, scanPath as detectAgents } from "./detector";
import { Env, Run } from "./env";
import { AgentToolError } from "../core/errors";
import { run as runCommand } from "./exec";
import { Candidate, discard, fetchPage, stage } from "./fetcher";
import { fromJsonLd, GitHubSource, narrowToSkill, needsPage, parseUrl, skillHint, sourceKey } from "../core/github";
import { install } from "./installer";
import { inventory as buildInventory, InventoryItem } from "./inventory";
import * as mcp from "./mcpScanner";
import { MCPScope, MCPServer } from "./mcpServer";
import { mcpStatus as pollMcpStatus } from "./processScanner";
import { knownProjects } from "./projectScan";
import { cliOverrides, entry, load, read, Registry, save, update, upsert } from "./registry";
import { disable, enable, Place, remove as removeManaged, removeUnmanaged, USER } from "./skillManager";
import { SOURCES, sourcePath } from "./source";
import { updateApply as applyUpdate, Http, updatePreview as previewUpdate, resolveSha, UpdateDiff } from "./updater";

export { AgentToolError } from "../core/errors";
export type { ErrorCode } from "../core/errors";
export type { AgentInfo } from "./detector";
export type { InventoryItem } from "./inventory";
export type { UpdateDiff } from "./updater";
export type { MCPScope, MCPServer } from "./mcpServer";

export type Selector = {
  name: string;
  kind: KindId;
  scope: ScopeId;
  agent: AgentId;
  sourcePath?: string;
  /** project スコープのときのワークスペース。実体の置き場がここで決まる。 */
  projectPath?: string;
};

export type PreviewCandidate = {
  kind: KindId;
  name: string;
  installSelector?: string;
  description?: string;
};

/** `storagePath` は `context.globalStorageUri.fsPath`。OS 別パスは VS Code が解決する。 */
const envOf = (storagePath: string): Env => ({ home: homedir(), appSupport: storagePath });

/** 走査と操作で同じ実行系を使う。手動指定した CLI パスは registry が持つ。 */
const runnerFor = (env: Env): Run => {
  const overrides = cliOverrides(load(env));
  return command => {
    const [head, ...rest] = command;
    // `basename` で比べる。`endsWith("/" + head)` は Windows の `\` に当たらず、
    // 手動指定した CLI パスが黙って無視される。
    const manual = (Object.entries(overrides).find(([, path]) =>
      path !== undefined && head !== undefined && basename(path) === head) ?? [])[1];
    return runCommand(manual === undefined ? command : [manual, ...rest]);
  };
};

/** 壊れた registry の上で書き込みを始めない。read-modify-write はロックの中で行う。 */
async function mutate(storagePath: string,
                      change: (registry: Registry, env: Env) => void | Promise<void>): Promise<void> {
  const env = envOf(storagePath);
  read(env);                                     // 壊れていればここで落ちる
  await update(env, async registry => { await change(registry, env); });
}

export async function inventory(params: {
  storagePath: string; projectPath: string | null; user?: boolean;
  /** 未信頼ワークスペースと Remote では渡さない。台帳の取り込みと entry の除去を止める。 */
  writable?: boolean;
}): Promise<{ items: InventoryItem[]; issues: string[] }> {
  const env = envOf(params.storagePath);
  return buildInventory({
    env, projectPath: params.projectPath, run: runnerFor(env), user: params.user,
    writable: params.writable,
  });
}

/** 他プロジェクトの一覧を出すための候補。`~/.claude.json` の既知パスだけを返す。 */
export function projects(params: { storagePath: string }): string[] {
  return knownProjects(envOf(params.storagePath));
}

/**
 * 管理下の取得元の最新 SHA を引き、`registry.repos` に記録する。
 * ここが走らないと `hasUpdate` は永久に false のままで、更新の導線が出ない。
 * GitHub の API を叩くので、明示的な操作のときだけ走らせる（定期ポーリングは持たない）。
 */
export async function checkUpdates(params: { storagePath: string; http?: Http }):
  Promise<{ checked: number; issues: string[] }> {
  const env = envOf(params.storagePath);
  const sources = new Map<string, GitHubSource>();
  for (const item of read(env).resources) {
    // 固定中は更新しないと決めたもの。レート制限を使ってまで確認しない。
    if (item.repo === undefined || item.pinned) continue;
    sources.set(sourceKey({ repo: item.repo, branch: item.branch }),
      { repo: item.repo, branch: item.branch });
  }

  const found = new Map<string, string>();
  const issues: string[] = [];
  for (const [key, source] of sources) {
    try {
      found.set(key, await resolveSha(source, params.http));
    } catch (error) {
      issues.push(`${key}: ${error instanceof AgentToolError || error instanceof Error
        ? error.message : String(error)}`);
    }
  }
  if (found.size > 0) {
    const checkedAt = new Date().toISOString();
    await mutate(params.storagePath, registry => {
      for (const [key, latestSha] of found) {
        registry.repos[key] = { ...registry.repos[key], latestSha, checkedAt };
      }
    });
  }
  return { checked: found.size, issues };
}

/**
 * View 表示中に監視するパス。走査ホワイトリスト（`source.ts`）から導くので、
 * 対象が増えても監視の側で二重に宣言しない。ホームやワークスペース全体は含めない。
 */
export function watchPaths(params: { storagePath: string; projectPath: string | null }): string[] {
  const env = envOf(params.storagePath);
  const paths = SOURCES.flatMap(source => {
    const path = sourcePath(source, env);
    return path === null ? [] : [path];
  });
  if (params.projectPath !== null) {
    paths.push(join(params.projectPath, ".claude", "skills"),
      join(params.projectPath, ".claude", "agents"),
      join(params.projectPath, ".mcp.json"));
  }
  return [...new Set(paths)].sort();
}

export function scanPath(params: { storagePath: string }): Promise<AgentInfo[]> {
  const env = envOf(params.storagePath);
  return detectAgents(env, runnerFor(env), cliOverrides(load(env)));
}

/**
 * URL だけで取得元が決まらないカタログは、ページを 1 回だけ読んで取得元の URL に置き換える。
 * 本文は JSON-LD の抽出に使うだけで、読み終えたら捨てる。
 */
async function resolveUrl(url: string): Promise<string> {
  const page = needsPage(url);
  if (page === null) return url;
  const target = fromJsonLd(await fetchPage(page));
  if (target === null) {
    throw new AgentToolError("NOT_FOUND", "that page does not name a public GitHub repository");
  }
  return target;
}

/**
 * 取得元を組み立てる。カタログ URL は subdir を持たないので、規約どおりの置き場に
 * あるかだけ HEAD 1 回で確かめる。当たれば zipball から要る分だけを取り出せる。
 */
async function sourceFor(url: string): Promise<GitHubSource> {
  const source = parseUrl(url);
  if (source === null) {
    throw new AgentToolError("NOT_FOUND", "that URL is not a public GitHub repository");
  }
  return narrowToSkill(source, skillHint(url));
}

/** この URL を解析できるか。クリップボードの中身を提案してよいかの判定に使う。 */
export const isSupportedUrl = (url: string): boolean =>
  parseUrl(url) !== null || needsPage(url) !== null;

/**
 * 取得した候補を返すだけ。入れるかどうかは確認画面で決める。
 * 解決後の URL も返す。導入のときに同じページをもう一度読まないため。
 */
export async function preview(params: { url: string }):
  Promise<{ url: string; candidates: PreviewCandidate[] }> {
  const url = await resolveUrl(params.url);
  const staging = await stage(await sourceFor(url));
  try {
    const hint = skillHint(url);
    const found = hint === undefined ? staging.candidates
      : staging.candidates.filter(item => item.name === hint);
    return { url, candidates: (found.length > 0 ? found : staging.candidates).map(toPreview) };
  } finally {
    discard(staging);
  }
}

const toPreview = (candidate: Candidate): PreviewCandidate => ({
  kind: candidate.kind,
  name: candidate.name,
  installSelector: candidate.installSelector,
  description: candidate.description,
});

export async function add(params: {
  storagePath: string;
  url: string;
  kind: "skill" | "subagent" | "plugin";
  scope: ScopeId;
  /** project スコープで必須。無いまま project を指定したら user へは落とさず失敗させる。 */
  projectPath?: string;
  name?: string;
}): Promise<void> {
  const place = placeFor(params.scope, params.projectPath);
  const url = await resolveUrl(params.url);
  const staging = await stage(await sourceFor(url));
  try {
    const wanted = params.name ?? skillHint(url);
    const candidate = staging.candidates.find(item =>
      item.kind === params.kind && (wanted === undefined || item.name === wanted))
      ?? staging.candidates.find(item => item.kind === params.kind);
    if (candidate === undefined) {
      throw new AgentToolError("NOT_FOUND", `no ${params.kind} was found at that URL`);
    }
    await mutate(params.storagePath, (registry, env) =>
      install(candidate, staging, env, registry, place));
  } finally {
    discard(staging);
  }
}

/** 追加先の置き場。project を頼まれてワークスペースが無いときは、黙って user に落とさない。 */
function placeFor(scope: ScopeId, projectPath?: string): Place {
  if (scope !== "project") return USER;
  if (projectPath === undefined) {
    throw new AgentToolError("OPERATION_FAILED", "no workspace folder is open to install into");
  }
  return { scope: "project", path: projectPath };
}

/** 実体の置き場。project はワークスペースが分からなければ組めない。 */
const placeOf = (selector: Selector): Place =>
  selector.scope === "project" && selector.projectPath !== undefined
    ? { scope: "project", path: selector.projectPath }
    : USER;

/**
 * 実体を触ってよい対象か。MCP と Plugin はこちらの管理ストアに実体を持たず、
 * `layout` に渡すと**同名の Skill の置き場**を指してしまう。
 * D-5 によりゴミ箱を経由しないため、取り違えは復旧できない。ここで先に落とす。
 *
 * project スコープはワークスペースが分かるときだけ。`apps/web:deploy` のような
 * 修飾名はサブディレクトリのもので、`.claude/skills` 直下ではないので扱わない。
 */
export const isManageable = (selector: Selector): boolean =>
  (selector.kind === "skill" || selector.kind === "subagent" || selector.kind === "rule")
  && !selector.name.includes(":")
  && (selector.scope === "user" || selector.projectPath !== undefined);

/** registry に載せる `project`。user スコープでは必ず undefined にする。 */
const projectOf = (selector: Selector): string | undefined => {
  const place = placeOf(selector);
  return place.scope === "project" ? place.path : undefined;
};

/**
 * 有効化・無効化は退避先がある user だけ。プロジェクト内に隠し退避先を作らない。
 * Rule は URL からの導入経路を持たず registry に載らないため、`assertMutable` が
 * 通らずに toggle が失敗する。表示・削除だけを提供して toggle は出さない（D-20）。
 */
export const isTogglable = (selector: Selector): boolean =>
  isManageable(selector) && selector.scope === "user" && selector.kind !== "rule";

function assertManageable(selector: Selector): void {
  if (isManageable(selector)) return;
  throw new AgentToolError("OPERATION_FAILED", selector.scope === "project"
    ? `${selector.name} belongs to this project; change it in the project files`
    : `${selector.kind} cannot be changed here`);
}

export async function remove(params: { storagePath: string; selector: Selector }): Promise<void> {
  assertManageable(params.selector);
  const { name, kind } = params.selector;
  const place = placeOf(params.selector);
  const project = place.scope === "project" ? place.path : undefined;
  return mutate(params.storagePath, (registry, env) => {
    // registry に載っていれば管理下の実体。載っていないものは他のツールが入れた資産で、
    // 既知ルート直下にあるものだけを削除する。
    const managed = registry.resources.some(item =>
      item.name === name && item.kind === kind && item.project === project);
    if (managed) removeManaged(name, kind, env, registry, place);
    // Rule は同名でもエージェントごとに別ファイル。選ばれた行の agent だけを消す（D-20）。
    else removeUnmanaged(name, kind, env, place, params.selector.agent);
  });
}

export async function toggle(params: { storagePath: string; selector: Selector }):
  Promise<{ enabled: boolean }> {
  assertManageable(params.selector);
  if (!isTogglable(params.selector)) {
    throw new AgentToolError("OPERATION_FAILED",
      `${params.selector.name} belongs to the project; enable and disable are not available there`);
  }
  const { name, kind } = params.selector;
  const env = envOf(params.storagePath);
  const wasEnabled = entry(read(env), name, kind)?.disabled !== true;
  await mutate(params.storagePath, (registry, scoped) =>
    wasEnabled ? disable(name, kind, scoped, registry) : enable(name, kind, scoped, registry));
  return { enabled: !wasEnabled };
}

/**
 * 更新の固定を切り替える。固定中は `hasUpdate` にも更新確認にも載せない —
 * 上流が方針転換したときに、こちらの都合で追随を止められるようにする。
 */
export async function togglePin(params: { storagePath: string; selector: Selector }):
  Promise<{ pinned: boolean }> {
  assertManageable(params.selector);
  const { name, kind } = params.selector;
  const project = projectOf(params.selector);
  let pinned = false;
  await mutate(params.storagePath, registry => {
    const current = entry(registry, name, kind, project);
    if (current === undefined) {
      throw new AgentToolError("NOT_IN_REGISTRY", `${name} has no known source, so it cannot be pinned`);
    }
    pinned = !current.pinned;
    upsert(registry, { ...current, pinned });
  });
  return { pinned };
}

export function updatePreview(params: { storagePath: string; selector: Selector }): Promise<UpdateDiff> {
  const env = envOf(params.storagePath);
  return previewUpdate({ env, registry: read(env), name: params.selector.name,
    kind: params.selector.kind, project: projectOf(params.selector) });
}

export async function updateApply(params: { storagePath: string; selector: Selector }):
  Promise<{ appliedSha: string }> {
  const env = envOf(params.storagePath);
  const registry = read(env);
  const result = await applyUpdate({ env, registry, name: params.selector.name,
    kind: params.selector.kind, project: projectOf(params.selector) });
  return result;
}

/** 追加は user スコープだけ（`addCommand` が `-s user` を載せる）。 */
export function mcpAdd(params: {
  storagePath: string; agent: AgentId; server: MCPServer;
}): Promise<void> {
  const env = envOf(params.storagePath);
  return mcp.add(params.server, params.agent, env, runnerFor(env));
}

/** `scope` は CLI の `-s` にそのまま載る。取り違えると同名の user サーバーを消す。 */
export function mcpRemove(params: {
  storagePath: string; agent: AgentId; name: string; scope: MCPScope;
}): Promise<void> {
  const env = envOf(params.storagePath);
  return mcp.remove(params.name, params.agent, env, runnerFor(env), params.scope);
}

/** View 表示中に 3 秒ポーリングで呼ぶ。key は "agent:serverName"。 */
export async function mcpStatus(params: { storagePath: string }): Promise<Record<string, boolean>> {
  const env = envOf(params.storagePath);
  const runner = runnerFor(env);
  const { servers } = await mcp.scan(env, runner);
  return pollMcpStatus(servers, runner);
}

/**
 * Plugin の削除は各エージェントの CLI に委譲する。実体の置き場も削除方法も
 * エージェント側が持っていて、こちらの管理ストアには何も無い。
 * 同梱プラグインは消してもエージェントの更新で戻るので受け付けない。
 */
export async function pluginRemove(params: {
  storagePath: string; agent: AgentId; name: string; scope?: "user" | "project" | "local"; bundled?: boolean;
}): Promise<void> {
  if (params.agent !== "claude" && params.agent !== "codex") {
    throw new AgentToolError("OPERATION_FAILED", `${params.agent} does not support plugins`);
  }
  if (params.bundled === true) {
    throw new AgentToolError("WRITE_GUARD_DENIED",
      `${params.name} ships with ${params.agent} and would come back on the next update`);
  }
  const env = envOf(params.storagePath);
  await runnerFor(env)(pluginRemoveCommand(params.agent, params.name, params.scope ?? "user"));
}

/** Claude は Marketplace を先に登録する。Codex も同じ二段階だが `add` を使う。 */
export function pluginAddCommands(agent: "claude" | "codex", name: string, url?: string): string[][] {
  const source = url === undefined ? undefined : parseUrl(url);
  const marketplaceUrl = source?.subdir === undefined ? url
    : `https://github.com/${source.repo}`;
  const selector = source?.subdir === undefined || name.includes("@") ? name
    : `${name}@${basename(source.repo)}`;
  const install = agent === "claude"
    ? ["claude", "plugin", "install", selector, "-s", "user"]
    : ["codex", "plugin", "add", selector];
  return marketplaceUrl === undefined
    ? [install] : [[agent, "plugin", "marketplace", "add", marketplaceUrl], install];
}

/** Codex は scope を受けない。Claude は一覧が返した scope をそのまま使う。 */
export function pluginRemoveCommand(agent: "claude" | "codex", name: string,
                                    scope: "user" | "project" | "local"): string[] {
  return agent === "claude"
    ? ["claude", "plugin", "remove", name, "-s", scope]
    : ["codex", "plugin", "remove", name];
}

/** Plugin の追加は各エージェントの CLI に委譲する。 */
export async function pluginAdd(params: {
  storagePath: string; agent: AgentId; name: string; url?: string;
}): Promise<void> {
  if (params.agent !== "claude" && params.agent !== "codex") {
    throw new AgentToolError("OPERATION_FAILED", `${params.agent} does not support plugins`);
  }
  const env = envOf(params.storagePath);
  for (const argv of pluginAddCommands(params.agent, params.name, params.url)) await runnerFor(env)(argv);
}

export { save, load };
