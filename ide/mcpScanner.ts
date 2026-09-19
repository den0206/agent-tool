import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AgentId, AGENT_IDS, supports } from "../core/agent";
import { mcpSource } from "./agent";
import { Env, Run } from "./env";
import { AgentToolError } from "../core/errors";
import { isObject } from "../core/json";
import { MCPScope, MCPServer, parse, parseAll } from "./mcpServer";
import { sourcePath } from "./source";
import { assertSafeCreation, exists } from "./writeGuard";

/** 設定ファイルの読み込み上限。`~/.claude.json` は履歴で数 MB まで育つので、
 *  単一ファイルの上限（20 MB）に合わせる。ここを絞ると読めた設定が黙って消える。 */
export const CONFIG_SIZE_LIMIT = 20 * 1024 * 1024;

const readConfigText = (path: string): string => {
  if (statSync(path).size > CONFIG_SIZE_LIMIT) {
    throw new AgentToolError("OPERATION_FAILED", `${basename(path)} is too large to read (limit 20 MB)`);
  }
  return readFileSync(path, "utf8");
};

/**
 * JSON からコメントを取り除く。純粋関数。
 *
 * 文字列リテラルを先に食ってそのまま書き戻す。中の `//` をコメント開始と読むと
 * `"url": "http://127.0.0.1:3845/mcp"` を壊して解釈する。
 */
export const stripComments = (text: string): string =>
  text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    match => match.startsWith("\"") ? match : "");

/**
 * 設定ファイルを 1 つ読む。失敗しても生のパーサ例外を UI に出さない。
 * 利用者に要るのは、どのファイルをどう直せばいいかの 1 行だけ。
 */
export function readJsonc(path: string): unknown {
  const text = readConfigText(path);
  try {
    return JSON.parse(text);
  } catch {
    // Cursor は `//` コメント入りの JSONC を受け付ける（実測）。
    try {
      return JSON.parse(stripComments(text));
    } catch {
      throw new AgentToolError("OPERATION_FAILED", `${basename(path)} is not valid JSON`);
    }
  }
}

function decode(value: unknown): MCPServer[] {
  if (!isObject(value)) {
    throw new AgentToolError("OPERATION_FAILED", "MCP server definitions could not be read");
  }
  return parseAll({ mcpServers: value });
}

/**
 * 読み取りは設定ファイルの直読みを優先する。`claude mcp list` は健全性チェックで
 * ネットワークを叩くうえ JSON 出力が無い（実測）。読み取り先は `mcpSource` が持つので、
 * ここでエージェントを直書きしない — 直書きすると増えたエージェントが黙って欠落する。
 */
export async function read(agent: AgentId, env: Env, run?: Run): Promise<MCPServer[]> {
  const source = mcpSource(agent);
  if (source === null) return [];

  if (source.kind === "cli") {
    if (!run) return [];
    const object = JSON.parse(await run(source.command)) as unknown;
    if (Array.isArray(object)) {
      return object.flatMap(item => {
        if (!isObject(item) || typeof item.name !== "string") {
          throw new AgentToolError("OPERATION_FAILED", "MCP list from the CLI could not be read");
        }
        const server = parse(item.name, item);
        if (server === null) {
          throw new AgentToolError("OPERATION_FAILED", "MCP list from the CLI could not be read");
        }
        return [server];
      });
    }
    if (isObject(object)) return decode(object.mcpServers ?? object);
    throw new AgentToolError("OPERATION_FAILED", "MCP list from the CLI could not be read");
  }

  const path = sourcePath(source, env);
  if (path === null) return [];
  let root: unknown;
  try {
    root = readJsonc(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!isObject(root)) throw new AgentToolError("OPERATION_FAILED", "MCP settings could not be read");
  return root.mcpServers === undefined ? [] : decode(root.mcpServers);
}

/** 走査に失敗したエージェントは空にして、理由を `issues` へ回す。 */
export async function scan(env: Env, run?: Run): Promise<{
  servers: Partial<Record<AgentId, MCPServer[]>>;
  issues: string[];
}> {
  const servers: Partial<Record<AgentId, MCPServer[]>> = {};
  const issues: string[] = [];
  for (const agent of AGENT_IDS) {
    try {
      servers[agent] = await read(agent, env, run);
    } catch (error) {
      servers[agent] = [];
      issues.push(`${agent} MCP: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { servers, issues };
}

/**
 * プロジェクト単位の MCP。サーバー名 → スコープを返す。
 *
 *   `<project>/.mcp.json`                            … git 共有（`-s project`）
 *   `~/.claude.json` の projects[path].mcpServers    … そのマシンだけ（`-s local`）
 *
 * スコープまで返すのは、削除コマンドに `-s` を正しく載せるため。
 * 取り違えるとユーザー全体の同名サーバーを消す。
 */
export function readProject(project: string, env: Env): Map<string, { server: MCPServer; scope: MCPScope }> {
  const out = new Map<string, { server: MCPServer; scope: MCPScope }>();
  for (const [path, scope] of [[join(project, ".mcp.json"), "project"], [join(env.home, ".claude.json"), "local"]] as const) {
    let root: unknown;
    try {
      root = readJsonc(path);
    } catch {
      continue;   // 未登録も壊れたファイルも、プロジェクト一覧は止めない
    }
    if (!isObject(root)) continue;
    // local は 98 KB の ~/.claude.json のうち、このプロジェクトの節だけを見る。
    const scoped = scope === "local"
      ? (isObject(root.projects) && isObject(root.projects[project]) ? root.projects[project] : {})
      : root;
    if (!isObject(scoped) || !isObject(scoped.mcpServers)) continue;
    for (const server of parseAll({ mcpServers: scoped.mcpServers })) {
      out.set(server.name, { server, scope });
    }
  }
  return out;
}

// MARK: - 追加・削除
// `mcp.json` に触るのはこのファイルだけ（設計決定 D-9）。Cursor は CLI を持たないので
// 直接編集し、他の 3 エージェントは各 CLI へ委譲する。

const cursorConfig = (env: Env): string => join(env.home, ".cursor", "mcp.json");

/** 各 CLI に渡す引数。純粋関数にしてテストする。 */
export function addCommand(server: MCPServer, agent: AgentId): string[] | null {
  const { transport } = server;
  const pairs = (flag: string, map: Record<string, string>): string[] =>
    Object.keys(map).sort().flatMap(key => [flag, `${key}=${map[key]}`]);
  const headers = (map: Record<string, string>): string[] =>
    Object.keys(map).sort().flatMap(key => ["-H", `${key}: ${map[key]}`]);

  switch (agent) {
    case "cursor":
      return null;                                  // CLI が無い。mcp.json を直接編集する
    case "claude":
    case "gemini": {
      // 名前は可変長の -e / -H より前に置く。後ろだと直前のフラグの値として食われる。
      const argv = [agent, "mcp", "add", "-s", "user", server.name];
      if (transport.type === "stdio") {
        // gemini は `--` を受けないので、コマンドと引数を位置引数で渡す。
        return [...argv, ...pairs("-e", transport.env),
                ...(agent === "claude" ? ["--"] : []), transport.command, ...transport.args];
      }
      return [...argv, "-t", "http", transport.url, ...headers(transport.headers)];
    }
    case "codex":
      return transport.type === "stdio"
        ? ["codex", "mcp", "add", ...pairs("--env", transport.env),
           server.name, "--", transport.command, ...transport.args]
        : ["codex", "mcp", "add", server.name, "--url", transport.url];  // ヘッダ指定は無い
  }
}

/**
 * `-s` は呼び出し側が持っているスコープをそのまま載せる。既定値で埋めると、
 * プロジェクトのサーバーを消したつもりで同名の user サーバーが消える。
 * codex はスコープの概念を持たない（`~/.codex/config.toml` だけ）。
 */
export const removeCommand = (name: string, agent: AgentId, scope: MCPScope): string[] | null =>
  agent === "cursor" ? null
    : agent === "codex" ? ["codex", "mcp", "remove", name]
      : [agent, "mcp", "remove", name, "-s", scope];

/** 入力を受ける前に形を確かめる。エージェント管理のサーバーには触らない。 */
export function validate(server: MCPServer, agent: AgentId): void {
  if (server.isProtected) {
    throw new AgentToolError("WRITE_GUARD_DENIED", "this MCP server is managed by the agent");
  }
  if (server.name === "" || server.name.startsWith("-") || !/^[\w.-]+$/.test(server.name)) {
    throw new AgentToolError("INVALID_NAME",
      "the MCP name must use letters, numbers, hyphens and underscores");
  }
  if (server.transport.type === "http") {
    let url: URL;
    try {
      url = new URL(server.transport.url);
    } catch {
      throw new AgentToolError("OPERATION_FAILED", "the MCP endpoint must be an HTTP or HTTPS URL");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
      throw new AgentToolError("OPERATION_FAILED", "the MCP endpoint must be an HTTP or HTTPS URL");
    }
    if (agent === "codex" && Object.keys(server.transport.headers).length > 0) {
      throw new AgentToolError("OPERATION_FAILED",
        "the Codex CLI cannot register these HTTP headers; set up authentication in Codex first");
    }
    return;
  }
  if (server.transport.command === "" || server.transport.command.startsWith("-")) {
    throw new AgentToolError("OPERATION_FAILED", "enter the MCP launch command");
  }
}

const encode = (server: MCPServer): Record<string, unknown> =>
  server.transport.type === "stdio"
    ? {
      command: server.transport.command,
      args: server.transport.args,
      ...(Object.keys(server.transport.env).length > 0 ? { env: server.transport.env } : {}),
    }
    : {
      url: server.transport.url,
      ...(Object.keys(server.transport.headers).length > 0 ? { headers: server.transport.headers } : {}),
    };

/**
 * `~/.cursor/mcp.json` は MCP 専用の小さいファイルなので直接編集して安全。
 * `~/.claude.json`（98 KB・全状態が同居）とは事情が違う。
 * `mcpServers` 以外のキーは触らない。書き込みはアトミック。
 */
export function editCursor(env: Env, mutate: (servers: Record<string, unknown>) => void): void {
  const path = cursorConfig(env);
  let root: Record<string, unknown> = {};
  let original: string | undefined;
  let mode: number | undefined;

  if (exists(path)) {
    const text = readConfigText(path);
    original = text;
    mode = statSync(path).mode & 0o777;
    try {
      JSON.parse(text);
    } catch {
      // コメント入りのファイルは書き換えない。読む側は飛ばして解釈できるが、
      // 書き戻すとコメントは復元されない。利用者が意図的に残した設定が消える。
      try {
        JSON.parse(stripComments(text));
        throw new AgentToolError("OPERATION_FAILED",
          "~/.cursor/mcp.json contains comments; edit it in Cursor instead");
      } catch (error) {
        if (error instanceof AgentToolError) throw error;
        throw new AgentToolError("OPERATION_FAILED",
          "the Cursor settings could not be read; nothing was changed");
      }
    }
    const parsed = JSON.parse(text) as unknown;
    if (!isObject(parsed)) {
      throw new AgentToolError("OPERATION_FAILED",
        "the Cursor settings could not be read; nothing was changed");
    }
    root = parsed;
  }

  if (root.mcpServers !== undefined && !isObject(root.mcpServers)) {
    throw new AgentToolError("OPERATION_FAILED",
      "the Cursor mcpServers section could not be read; nothing was changed");
  }
  const servers = isObject(root.mcpServers) ? { ...root.mcpServers } : {};
  mutate(servers);
  root.mcpServers = servers;

  assertSafeCreation(path, join(env.home, ".cursor"), env.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 読んだ後に他のプロセスが書いていたら、その変更を潰さない。
  if (original !== undefined && readConfigText(path) !== original) {
    throw new AgentToolError("OPERATION_FAILED",
      "the Cursor settings changed in another process; the edit was cancelled");
  }
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(root, null, 2) + "\n", { mode: mode ?? 0o600 });
  renameSync(temporary, path);
  chmodSync(path, mode ?? 0o600);
}

export async function add(server: MCPServer, agent: AgentId, env: Env, run?: Run): Promise<void> {
  if (!supports(agent, "mcp")) {
    throw new AgentToolError("OPERATION_FAILED", `${agent} does not support MCP`);
  }
  validate(server, agent);
  if (agent === "cursor") {
    return editCursor(env, servers => {
      if (servers[server.name] !== undefined) {
        throw new AgentToolError("ALREADY_EXISTS", `${server.name} is already registered`);
      }
      servers[server.name] = encode(server);
    });
  }
  const existing = await read(agent, env, run);
  if (existing.some(item => item.name === server.name)) {
    throw new AgentToolError("ALREADY_EXISTS", `${server.name} is already registered`);
  }
  const argv = addCommand(server, agent);
  if (argv === null || !run) {
    throw new AgentToolError("OPERATION_FAILED", `${agent} cannot register MCP servers here`);
  }
  await run(argv);
}

export async function remove(name: string, agent: AgentId, env: Env, run?: Run,
                             scope: MCPScope = "user"): Promise<void> {
  if (!supports(agent, "mcp")) {
    throw new AgentToolError("OPERATION_FAILED", `${agent} does not support MCP`);
  }
  if (name === "" || name.startsWith("-")) {
    throw new AgentToolError("INVALID_NAME", "the MCP name is not valid");
  }
  const existing = await read(agent, env, run).catch(() => []);
  if (existing.some(item => item.name === name && item.isProtected)) {
    throw new AgentToolError("WRITE_GUARD_DENIED", "this MCP server is managed by the agent");
  }
  if (agent === "cursor") {
    // Cursor は `~/.cursor/mcp.json` しか持たない。project / local を渡されたら消さない。
    if (scope !== "user") {
      throw new AgentToolError("OPERATION_FAILED", "Cursor registers MCP servers for the user only");
    }
    return editCursor(env, servers => { delete servers[name]; });
  }
  const argv = removeCommand(name, agent, scope);
  if (argv === null || !run) {
    throw new AgentToolError("OPERATION_FAILED", `${agent} cannot remove MCP servers here`);
  }
  await run(argv);
  // CLI の終了コードを信用せず、消えたことを読んで確かめる。
  // 読めなかったときは「消えていない」と決めつけない — 残っていると確認できたときだけ失敗にする。
  const remaining = await read(agent, env, run).catch(() => null);
  if (remaining !== null && remaining.some(item => item.name === name)) {
    throw new AgentToolError("OPERATION_FAILED",
      `${name} was not removed; the agent may be managing it`);
  }
}
