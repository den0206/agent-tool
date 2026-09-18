import { realpathSync } from "node:fs";
import { AgentId, AGENT_IDS, BUNDLED_SKILL_ROOTS, KindId, ruleRoots, ScopeId, skillRoots, subagentRoots } from "../core/agent";
import { sourceKey, sourcePageUrl } from "../core/github";
import { agentStore, Env, Run, skillStore } from "./env";
import * as mcp from "./mcpScanner";
import { floatingPackage, MCPScope, MCPServer, summary as mcpSummary } from "./mcpServer";
import * as plugins from "./pluginScanner";
import { resolvePath, which } from "./detector";
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
  /** ブラウザ拡張へ渡す、取得元を特定できる URL。 */
  readonly sourceUrl?: string;
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

export type DiagnosticTarget = {
  readonly name: string;
  readonly kind: KindId;
  readonly scope: ScopeId;
  readonly sourcePath?: string;
  readonly projectPath?: string;
};

export type Diagnostic = {
  readonly code: "DUPLICATE_IDENTITY" | "DUPLICATE_MCP_NAME" | "BROKEN_LINK" | "MISSING_SKILL_FILE" | "MISSING_EXECUTABLE";
  readonly severity: "warning" | "broken";
  readonly targets: DiagnosticTarget[];
  readonly message: string;
};

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

const targetOf = (item: Skill, kind: KindId, scope: ScopeId, projectPath?: string): DiagnosticTarget => ({
  name: item.name, kind, scope, sourcePath: item.path, projectPath,
});

/** 同じ実体へ張った symlink は 1 件。別の実体だけを競合として出す。 */
function skillDiagnostics(found: Skill[], kind: "skill" | "subagent", scope: ScopeId,
                          projectPath?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const bodies = new Map<string, Map<string, Skill>>();
  for (const item of found) {
    if (item.status === "brokenLink") {
      diagnostics.push({ code: "BROKEN_LINK", severity: "broken", targets: [targetOf(item, kind, scope, projectPath)],
        message: `${item.name} has a broken link` });
      continue;
    }
    if (item.status === "noSkillFile") {
      diagnostics.push({ code: "MISSING_SKILL_FILE", severity: "broken", targets: [targetOf(item, kind, scope, projectPath)],
        message: `${item.name} has no SKILL.md` });
      continue;
    }
    if (!isLoadable(item.status)) continue;
    try {
      const paths = bodies.get(item.name) ?? new Map<string, Skill>();
      paths.set(realpathSync(item.path), item);
      bodies.set(item.name, paths);
    } catch { /* 消えた実体は次回の prune に任せる */ }
  }
  for (const [name, paths] of bodies) {
    if (paths.size < 2) continue;
    diagnostics.push({ code: "DUPLICATE_IDENTITY", severity: "warning",
      targets: [...paths.values()].map(item => targetOf(item, kind, scope, projectPath)),
      message: `${name} has ${paths.size} independent bodies` });
  }
  return diagnostics;
}

/** PATH で解決可否を調べる対象。絶対・相対パス直指定は「PATH で引かない」ので対象外。 */
const needsPathLookup = (server: MCPServer): boolean =>
  server.transport.type === "stdio" && !/[\\/]/.test(server.transport.command);

function executableDiagnostics(servers: Iterable<MCPServer>, path: string,
                               scope: ScopeId, projectPath?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const server of servers) {
    if (server.transport.type !== "stdio") continue;
    const command = server.transport.command;
    if (/[\\/]/.test(command)) continue;
    if (which(command, path) !== null) continue;
    diagnostics.push({ code: "MISSING_EXECUTABLE", severity: "warning", targets: [{
      name: server.name, kind: "mcp", scope, projectPath,
    }], message: `${server.name} cannot resolve ${command} on PATH` });
  }
  return diagnostics;
}

/** Claude の user / project 登録は別設定なので、同名でもどちらが優先されるかを推測しない。 */
function mcpScopeDiagnostics(user: Iterable<MCPServer>, project: Iterable<MCPServer>,
                             projectPath: string): Diagnostic[] {
  const names = new Set([...user].map(server => server.name));
  return [...project].flatMap(server => !names.has(server.name) ? [] : [{
    code: "DUPLICATE_MCP_NAME" as const, severity: "warning" as const,
    targets: [
      { name: server.name, kind: "mcp" as const, scope: "user" as const },
      { name: server.name, kind: "mcp" as const, scope: "project" as const, projectPath },
    ], message: `${server.name} is registered in both user and project MCP scopes`,
  }]);
}

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
  if (roots.length > 0 && roots.every(root => BUNDLED_SKILL_ROOTS.has(root))) return "bundled";
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
  for (const item of found) {
    // Rule は共有ストアもリンクも無く、同名でもエージェントごとに無関係な別ファイル。
    // 1 行にまとめると、消す前の確認に出せるパスが片方だけになる（D-20）。
    const key = kind === "rule" ? `${item.root}\u0000${item.name}` : item.name;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups].map(([, items]) => {
    const name = items[0].name;
    // リンク切れ・SKILL.md 欠落は「有効」にしない。
    const visible = new Set(items.filter(item => isLoadable(item.status))
      .map(item => item.root));
    const entry = entryOf(registry, name, kind, project);
    return {
      name, kind, scope,
      agents: AGENT_IDS.filter(agent => rootsFor(agent).some(root => visible.has(root))),
      enabled: true,
      origin: origin(name, kind, items.map(item => item.root), registry, project),
      sourcePath: items[0].path,
      repoUrl: entry?.repo,
      // リポジトリ直下の Skill はブラウザ拡張が名前を特定できないので導線を出さない。
      sourceUrl: entry?.repo === undefined || entry.subdir === undefined ? undefined
        : sourcePageUrl({ repo: entry.repo, branch: entry.branch, subdir: entry.subdir }),
      hasUpdate: hasUpdate(entry, registry),
      pinned: entry?.pinned === true,
      summary: items.find(item => item.description !== undefined)?.description,
    };
  }).sort(byName);
}

function userSkills(found: Skill[], registry: Registry): InventoryItem[] {
  return group(found, "skill", "user", registry, skillRoots);
}

function userSubagents(found: Skill[], registry: Registry): InventoryItem[] {
  return group(found, "subagent", "user", registry, subagentRoots);
}

function userRules(env: Env, registry: Registry): InventoryItem[] {
  const found = scanRules(env);
  return group(found, "rule", "user", registry, ruleRoots);
}

/** プロジェクトのスキルとサブエージェント。ユーザー資産なので origin は user のまま。 */
function projectItems(project: string, registry: Registry, skills: Skill[], subagents: Skill[]): InventoryItem[] {
  // ルート名はユーザー側と同じ `.claude/skills` にする。どのエージェントが読むかは
  // `skillRoots` の宣言だけで決まり、サブディレクトリの位置では変わらない。
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
}): Promise<{ items: InventoryItem[]; issues: string[]; diagnostics: Diagnostic[] }> {
  const { env, projectPath, run } = params;
  const includeUser = params.user !== false;
  const writable = params.writable === true;
  // 取り込みは registry を書くので、先に済ませてから一覧を組む
  // （この走査の結果に managed として反映される）。
  if (writable) await absorb(env);
  const registry = load(env);
  const issues: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const userSkillFound = includeUser ? scanSkills(env) : [];
  const userSubagentFound = includeUser ? scanSubagents(env) : [];
  const projectSkills = projectPath === null ? [] : projectSkillRoots(projectPath).flatMap(({ prefix, path }) =>
    scanSkillRoot(path, ".claude/skills").map(skill => prefix === "" ? skill : { ...skill, name: `${prefix}:${skill.name}` }));
  const projectSubagents = projectPath === null ? []
    : scanSubagentRoot(projectSubagentRoot(projectPath), ".claude/agents");

  let mcpItems: InventoryItem[] = [];
  let userMcpServers: MCPServer[] = [];
  let claudeMcpServers: MCPServer[] = [];
  if (includeUser) {
    const servers = await mcp.scan(env, run);
    issues.push(...servers.issues);
    userMcpServers = AGENT_IDS.flatMap(agent => servers.servers[agent] ?? []);
    claudeMcpServers = servers.servers.claude ?? [];
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

  const projectItemList = projectPath === null ? [] : projectItems(projectPath, registry, projectSkills, projectSubagents);
  const projectMcpEntries = projectPath === null ? [] : [...mcp.readProject(projectPath, env)];
  const projectServers = projectMcpEntries.map(([, { server }]) => server);
  const projectMcp: InventoryItem[] = projectPath === null ? []
    : projectMcpEntries.map(([name, { server, scope }]): InventoryItem => ({
      name, kind: "mcp", scope: "project", agents: ["claude" as AgentId],
      enabled: server.enabled, origin: server.isProtected ? "bundled" : "user",
      hasUpdate: false, pinned: false, summary: `${scope} · ${mcpSummary(server)}`, mcpScope: scope,
      ...floatingOf(server),
    }));

  const items = [
    ...(includeUser
      ? [...userSkills(userSkillFound, registry), ...userSubagents(userSubagentFound, registry),
         ...userRules(env, registry), ...mcpItems]
      : []),
    ...pluginItems, ...projectItemList, ...projectMcp,
  ];
  if (includeUser) {
    diagnostics.push(
      ...skillDiagnostics(userSkillFound, "skill", "user"),
      ...skillDiagnostics(userSubagentFound, "subagent", "user"),
    );
  }
  if (projectPath !== null) {
    diagnostics.push(
      ...skillDiagnostics(projectSkills, "skill", "project", projectPath),
      ...skillDiagnostics(projectSubagents, "subagent", "project", projectPath),
      ...(includeUser ? mcpScopeDiagnostics(claudeMcpServers, projectServers, projectPath) : []),
    );
  }
  // PATH 解決はログインシェルを起こすので、走査対象が 1 件も無ければ引かない。
  // user / project を跨いで 1 回だけ引いて両方の診断に使う。
  const needResolve = (includeUser && userMcpServers.some(needsPathLookup))
    || (projectPath !== null && projectServers.some(needsPathLookup));
  if (needResolve && run !== undefined) {
    let path = "";
    try { path = await resolvePath(env, run); } catch { /* 引けなければ診断を出さない */ }
    if (path !== "") {
      if (includeUser) diagnostics.push(...executableDiagnostics(userMcpServers, path, "user"));
      if (projectPath !== null) diagnostics.push(...executableDiagnostics(projectServers, path, "project", projectPath));
    }
  }

  // 実体を失った entry を落とす。走査できたルートの分だけを対象にする。
  // 読めなかったルートが 1 つでもあれば行わない — 読めないだけのものを「消えた」と
  // 扱うと、実体が残っているのに pinned / 取得元が永久に失われる。
  const blocked = writable ? unreadableRoots(env, [
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

  return { items, issues, diagnostics };
}

/** 台帳を取り込む。1 件も無ければ registry を開かない。 */
async function absorb(env: Env): Promise<void> {
  const found = scanLedgers(env);
  if (found.length === 0) return;
  await update(env, registry => { absorbLedgers(env, registry, found); });
}
