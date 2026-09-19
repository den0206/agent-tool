import { AgentId, AGENT_IDS } from "../core/agent";
import { cliName } from "./agent";
import { Env, Run } from "./env";
import { AgentToolError } from "../core/errors";
import { isObject, str } from "../core/json";
import { readJsonc } from "./mcpScanner";
import { join } from "node:path";

/**
 * 導入済みプラグイン。読むのは CLI の JSON 出力で、書き込みは
 * `claude plugin` / `codex plugin` に委譲する。
 */
export type InstalledPlugin = {
  readonly id: string;          // "name@marketplace"
  readonly agent: AgentId;
  readonly version?: string;
  readonly scope: "user" | "project" | "local";
  readonly projectPath?: string;
  readonly enabled: boolean;
  /** marketplace 側で自動更新が有効。こちらは手を出さない。 */
  readonly autoUpdate: boolean;
  /** エージェント同梱。ユーザーが入れたものと混ぜない。 */
  readonly isBundled: boolean;
};

/** 読み取り経路があるのは Claude と Codex だけ。Cursor は未実測なので推測で埋めない。 */
const READABLE: readonly AgentId[] = ["claude", "codex"];

/** `~/.claude/plugins/known_marketplaces.json` の `autoUpdate` を拾う。 */
function autoUpdateMarketplaces(env: Env): Set<string> {
  try {
    const root = readJsonc(join(env.home, ".claude", "plugins", "known_marketplaces.json"));
    if (!isObject(root)) return new Set();
    return new Set(Object.entries(root)
      .filter(([, value]) => isObject(value) && value.autoUpdate === true)
      .map(([key]) => key));
  } catch {
    return new Set();
  }
}

export async function read(agent: AgentId, env: Env, run?: Run): Promise<InstalledPlugin[]> {
  if (!READABLE.includes(agent) || !run) return [];
  const object = JSON.parse(await run([cliName(agent)!, "plugin", "list", "--json"])) as unknown;
  const list = agent === "claude"
    ? object
    : isObject(object) ? object.installed : undefined;
  if (!Array.isArray(list)) {
    throw new AgentToolError("OPERATION_FAILED", "Plugin list from the CLI could not be read");
  }
  const auto = autoUpdateMarketplaces(env);
  return list.map(raw => {
    const item = isObject(raw) ? raw : {};
    const id = str(item[agent === "claude" ? "id" : "pluginId"]);
    if (id === undefined) {
      throw new AgentToolError("OPERATION_FAILED", "Plugin identifier is missing");
    }
    return {
      id,
      agent,
      version: str(item.version),
      scope: str(item.scope) === "project" ? "project" : str(item.scope) === "local" ? "local" : "user",
      projectPath: str(item.projectPath),
      enabled: item.enabled !== false,
      autoUpdate: auto.has(id.split("@").pop() ?? ""),
      // Codex は自社の既定プラグインに `installPolicy: INSTALLED_BY_DEFAULT` を付けて返す（実測）。
      // 混ぜると自分で入れた分が埋もれ、消してもエージェントが入れ直すものに削除を出すことになる。
      isBundled: item.isBuiltIn === true || item.managed === true
        || item.scope === "managed" || item.installPolicy === "INSTALLED_BY_DEFAULT",
    };
  });
}

export async function scan(env: Env, run?: Run): Promise<{ plugins: InstalledPlugin[]; issues: string[] }> {
  const plugins: InstalledPlugin[] = [];
  const issues: string[] = [];
  for (const agent of AGENT_IDS) {
    try {
      plugins.push(...await read(agent, env, run));
    } catch (error) {
      issues.push(`${agent} Plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { plugins, issues };
}
