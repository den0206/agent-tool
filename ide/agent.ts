import { AgentId, Source } from "../core/agent";

/** Cursor には CLI が無い（`cursor-agent` は存在しない）。異常ではないので未検出と扱わない。 */
export const cliName = (agent: AgentId): string | null =>
  ({ claude: "claude", cursor: null, codex: "codex", gemini: "gemini" })[agent];

/**
 * MCP の読み取り元。設定ファイルの直読みを優先し、Codex だけ設定が `config.toml` なので
 * CLI の JSON を使う。`Source` の MCP 部分はここから導出する（二重に書かない）。
 */
export function mcpSource(agent: AgentId): Source | null {
  switch (agent) {
    case "claude": return { kind: "file", root: "home", path: ".claude.json" }; // key: mcpServers
    case "cursor": return { kind: "file", root: "home", path: ".cursor/mcp.json" };
    case "gemini": return { kind: "file", root: "home", path: ".gemini/settings.json" };
    case "codex":  return { kind: "cli", command: ["codex", "mcp", "list", "--json"] };
  }
}

/** プラグインの読み取り元。書き込みは各 CLI に委譲する。 */
export function pluginSources(agent: AgentId): Source[] {
  switch (agent) {
    case "claude":
      return [{ kind: "file", root: "home", path: ".claude/plugins/installed_plugins.json" },
              { kind: "file", root: "home", path: ".claude/plugins/known_marketplaces.json" },
              { kind: "cli", command: ["claude", "plugin", "list", "--json"] }];
    case "codex":
      return [{ kind: "cli", command: ["codex", "plugin", "list", "--json"] }];
    case "cursor":
    case "gemini":
      return []; // Cursor の ~/.cursor/plugins は読み取り経路が未実測。推測で埋めない
  }
}
