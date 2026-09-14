import { AgentId, AGENT_IDS, BUNDLED_SKILL_ROOTS, KindId, ruleRoots, ScopeId, skillRoots, subagentRoots } from "../core/agent";
import { sourceKey } from "../core/github";
import { agentStore, disabledAgentStore, disabledStore, Env, Run, skillStore } from "./env";
import * as mcp from "./mcpScanner";
import { floatingPackage, MCPScope, MCPServer, summary as mcpSummary } from "./mcpServer";
import * as plugins from "./pluginScanner";
import { projectRuleRoots, projectSkillRoots, projectSubagentRoot } from "./projectScan";
import { Entry, load, Registry, update } from "./registry";
import { absorb as absorbLedgers, key as ledgerKey, prune, scan as scanLedgers } from "./ledger";
import {
  isLoadable, scanRuleRoot, scanRules, scanSkillRoot, scanSkills, scanSubagentRoot,
  scanSubagents, Skill, unreadableRoots,
} from "./skillScanner";

export type InventoryItem = {
  readonly name: string;
  readonly kind: KindId;
  readonly scope: ScopeId;
  /** 複数エージェントで共有する場合がある。 */
  readonly agents: AgentId[];
  readonly enabled: boolean;
  readonly origin: "managed" | "user" | "bundled";
  readonly sourcePath?: string;
  readonly repoUrl?: string;
  readonly hasUpdate: boolean;
  /** 更新を追わないと利用者が決めたもの。 */
  readonly pinned: boolean;
  /** frontmatter の先頭 4 KB から取得。本文は詳細表示のときだけ読む。 */
  readonly summary?: string;
  /** MCP の登録先。削除コマンドの `-s` になるので `scope` に潰さず持つ。 */
  readonly mcpScope?: MCPScope;
  /**
   * `@latest` 指定のパッケージ名。起動のたびに最新を取るので、こちらが更新を
   * 管理する余地が無く黙って壊れうる。ピン留めを促すために一覧へ出す。
   */
  readonly floating?: string;
  /** Plugin の登録先。Claude の削除コマンドの `-s` になる。 */
  readonly pluginScope?: "user" | "project" | "local";
};

/** 無効化して退避したものの擬似ルート。どのエージェントからも見えない。 */
export const PARKED = "(disabled)";

/**
 * `@latest` 指定を一覧へ載せる。判定は `mcpServer.floatingPackage` が持っていて、
 * ここで拾わないと「黙って壊れうる」と分かっているものを利用者に見せられない。
 */
const floatingOf = (server: MCPServer): { floating?: string } => {
  const found = floatingPackage(server);
  return found === null ? {} : { floating: found };
};

const byName = (a: InventoryItem, b: InventoryItem): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** 更新の有無は registry.json だけで決まる。固定中は数えない。 */
export function hasUpdate(entry: Entry | undefined, registry: Registry): boolean {
  if (!entry || entry.pinned || !entry.repo) return false;
  const latest = registry.repos[sourceKey({ repo: entry.repo, branch: entry.branch })]?.latestSha;
  return latest !== undefined && latest !== entry.sha;
}

/**
 * スキルの出どころ。エージェント同梱ルートにしか無いものだけを bundled にする —
 * ユーザーが同名のものを自分の置き場にも持っていれば、それは自分のもの。
 */
function origin(name: string, kind: KindId, roots: string[], registry: Registry,
                project?: string): InventoryItem["origin"] {
  const visible = roots.filter(root => root !== PARKED);
  if (visible.length > 0 && visible.every(root => BUNDLED_SKILL_ROOTS.has(root))) return "bundled";
  return entryOf(registry, name, kind, project) !== undefined ? "managed" : "user";
}

/**
 * 同じ名前・種別が user と project の両方にありうる。`project` まで見ないと、
 * プロジェクトのものに user の取得元や更新バッジを出してしまう。
 */
const entryOf = (registry: Registry, name: string, kind: KindId, project?: string):
  Entry | undefined => registry.resources.find(e =>
    e.name === name && e.kind === kind && e.project === project);

function group(found: Skill[], kind: KindId, scope: ScopeId, registry: Registry,
               rootsFor: (agent: AgentId) => string[], project?: string): InventoryItem[] {
  const groups = new Map<string, Skill[]>();
  for (const item of found) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);

  return [...groups].map(([name, items]) => {
    // リンク切れ・SKILL.md 欠落は「有効」にしない。退避中はどこからも見えない。
    const visible = new Set(items.filter(item => isLoadable(item.status) && item.root !== PARKED)
      .map(item => item.root));
    const entry = entryOf(registry, name, kind, project);
    return {
      name, kind, scope,
      agents: AGENT_IDS.filter(agent => rootsFor(agent).some(root => visible.has(root))),
      enabled: !items.some(item => item.root === PARKED),
      origin: origin(name, kind, items.map(item => item.root), registry, project),
      sourcePath: items[0].path,
      repoUrl: entry?.repo,
      hasUpdate: hasUpdate(entry, registry),
      pinned: entry?.pinned === true,
      summary: items.find(item => item.description !== undefined)?.description,
    };
  }).sort(byName);
}

function userSkills(env: Env, registry: Registry): InventoryItem[] {
  // 無効化したスキルは走査ルートから消えるので、退避先も併せて読む。
  // これが無いと再有効化する手段がなくなる。
  const found = [...scanSkills(env), ...scanSkillRoot(disabledStore(env), PARKED)];
  return group(found, "skill", "user", registry, skillRoots);
}

function userSubagents(env: Env, registry: Registry): InventoryItem[] {
  const found = [...scanSubagents(env), ...scanSubagentRoot(disabledAgentStore(env), PARKED)];
  return group(found, "subagent", "user", registry, subagentRoots);
}

function userRules(env: Env, registry: Registry): InventoryItem[] {
  // Rule には toggle が無い（registry に載らないため）ので、退避先は走査しない。
  const found = scanRules(env);
  return group(found, "rule", "user", registry, ruleRoots);
}

/** プロジェクトのスキルとサブエージェント。ユーザー資産なので origin は user のまま。 */
function projectItems(project: string, registry: Registry): InventoryItem[] {
  // ルート名はユーザー側と同じ `.claude/skills` にする。どのエージェントが読むかは
  // `skillRoots` の宣言だけで決まり、サブディレクトリの位置では変わらない。
  const skills = projectSkillRoots(project).flatMap(({ prefix, path }) =>
    // サブディレクトリのスキルは `apps/web:deploy` として区別する。
    // 名前で畳むので、修飾しないと別物が 1 行に潰れる。
    scanSkillRoot(path, ".claude/skills")
      .map(skill => prefix === "" ? skill : { ...skill, name: `${prefix}:${skill.name}` }));
  const subagents = scanSubagentRoot(projectSubagentRoot(project), ".claude/agents");
  const rules = projectRuleRoots(project).flatMap(({ path, label }) => scanRuleRoot(path, label));
  return [
    ...group(skills, "skill", "project", registry, skillRoots, project),
    ...group(subagents, "subagent", "project", registry, subagentRoots, project),
    ...group(rules, "rule", "project", registry, ruleRoots, project),
  ];
}

export async function inventory(params: {
  env: Env; projectPath: string | null; run?: Run; user?: boolean;
  /** 未信頼ワークスペースと Remote では false。台帳の取り込みと entry の除去を行わない。 */
  writable?: boolean;
}): Promise<{ items: InventoryItem[]; issues: string[] }> {
  const { env, projectPath, run } = params;
  const includeUser = params.user !== false;
  const writable = params.writable === true;
  // 取り込みは registry を書くので、先に済ませてから一覧を組む
  // （この走査の結果に managed として反映される）。
  if (writable) await absorb(env);
  const registry = load(env);
  const issues: string[] = [];

  let mcpItems: InventoryItem[] = [];
  if (includeUser) {
    const servers = await mcp.scan(env, run);
    issues.push(...servers.issues);
    mcpItems = AGENT_IDS.flatMap(agent =>
      (servers.servers[agent] ?? []).map(server => ({
        name: server.name, kind: "mcp" as const, scope: "user" as const, agents: [agent],
        enabled: server.enabled,
        origin: server.isProtected ? "bundled" as const : "user" as const,
        hasUpdate: false, pinned: false, summary: mcpSummary(server), mcpScope: "user" as const,
        ...floatingOf(server),
      }))).sort(byName);
  }

  const installed = await plugins.scan(env, run);
  issues.push(...installed.issues);
  // CLI は全プロジェクトの Plugin を返す。今見ている projectPath 以外は載せない。
  const pluginItems: InventoryItem[] = installed.plugins
    .filter(plugin => plugin.projectPath === projectPath
      || (includeUser && plugin.projectPath === undefined))
    .map((plugin): InventoryItem => ({
      name: plugin.id, kind: "plugin", scope: plugin.projectPath ? "project" : "user",
      agents: [plugin.agent], enabled: plugin.enabled,
      origin: plugin.isBundled ? "bundled" : "user",
      sourcePath: plugin.projectPath, hasUpdate: false, pinned: false,
      pluginScope: plugin.scope,
      summary: plugin.version === undefined ? undefined : `v${plugin.version}`,
    })).sort(byName);

  const projectItemList = projectPath === null ? [] : projectItems(projectPath, registry);
  const projectMcp: InventoryItem[] = projectPath === null ? []
    : [...mcp.readProject(projectPath, env)].map(([name, { server, scope }]): InventoryItem => ({
      name, kind: "mcp", scope: "project", agents: ["claude" as AgentId],
      enabled: server.enabled, origin: server.isProtected ? "bundled" : "user",
      hasUpdate: false, pinned: false, summary: `${scope} · ${mcpSummary(server)}`, mcpScope: scope,
      ...floatingOf(server),
    }));

  const items = [
    ...(includeUser
      ? [...userSkills(env, registry), ...userSubagents(env, registry),
         ...userRules(env, registry), ...mcpItems]
      : []),
    ...pluginItems, ...projectItemList, ...projectMcp,
  ];

  // 実体を失った entry を落とす。走査できたルートの分だけを対象にする。
  // 読めなかったルートが 1 つでもあれば行わない — 読めないだけのものを「消えた」と
  // 扱うと、実体が残っているのに pinned / disabled / 取得元が永久に失われる。
  const blocked = writable ? unreadableRoots(env, [
    disabledStore(env), disabledAgentStore(env),
    ...(projectPath === null ? []
      : [...projectSkillRoots(projectPath).map(root => root.path),
         projectSubagentRoot(projectPath),
         ...projectRuleRoots(projectPath).map(root => root.path)]),
  ]) : [];
  // 失敗を握り潰さない。読めなかったから消さなかった、と利用者に見せる。
  for (const root of blocked) issues.push(`${root}: not readable, its entries were kept`);
  if (writable && blocked.length === 0) {
    const seen = new Set(items
      .filter(item => item.kind === "skill" || item.kind === "subagent" || item.kind === "rule")
      .map(item => ledgerKey(item.name, item.kind,
        item.scope === "project" && projectPath !== null ? projectPath : undefined)));
    await update(env, registry => {
      prune(registry, { seen, scannedUser: includeUser, scannedProject: projectPath });
    });
  }

  return { items, issues };
}

/** 台帳を取り込む。1 件も無ければ registry を開かない。 */
async function absorb(env: Env): Promise<void> {
  const found = scanLedgers(env);
  if (found.length === 0) return;
  await update(env, registry => { absorbLedgers(env, registry, found); });
}
