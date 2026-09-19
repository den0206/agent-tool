import { basename } from "node:path";
import { AgentId, AGENT_IDS } from "../core/agent";
import { Run } from "./env";
import { MCPServer } from "./mcpServer";

/** プロセス一覧の 1 行。UI が要るのは「動いているか」だけなので 3 列に絞る。 */
export type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
};

/**
 * 全プロセスを 1 回だけ取る。OS ごとにコマンドは違うが、
 * 「pid / ppid / コマンド行」の 3 列に揃えてから先は同じ処理にする。
 */
export async function snapshot(run: Run): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    // tasklist はコマンド行を持たないので、MCP の判別に使えない。
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,"
      + "CommandLine | ConvertTo-Json -Compress";
    const output = await run(["powershell", "-NoProfile", "-Command", script]).catch(() => "");
    return parseWindows(output);
  }
  const output = await run(["ps", "-eo", "pid,ppid,command"]).catch(() => "");
  return parsePs(output);
}

/** `  87139 87070 Cursor Helper: mcp-process` */
export function parsePs(output: string): ProcessRow[] {
  return output.split("\n").flatMap(line => {
    // コマンドは空白を含むので、先頭 2 列だけ切り出して残りを丸ごと使う。
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];      // ヘッダ行はここで落ちる
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
  });
}

export function parseWindows(output: string): ProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap(raw => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.ProcessId !== "number" || typeof item.CommandLine !== "string") return [];
    return [{
      pid: item.ProcessId,
      ppid: typeof item.ParentProcessId === "number" ? item.ParentProcessId : 0,
      command: item.CommandLine,
    }];
  });
}

/** パッケージ実行系はコマンド行に現れても対象を絞らない。 */
const GENERIC: ReadonlySet<string> = new Set([
  "npx", "npm", "exec", "node", "uvx", "uv", "run", "python", "python3",
  "deno", "bunx", "docker", "pipx", "-y", "--yes", "latest",
]);

/** `chrome-devtools-mcp@latest` → `chrome-devtools-mcp`。スコープ付きの先頭 `@` は残す。 */
export function stripVersion(token: string): string {
  const at = token.lastIndexOf("@");
  return at > 0 ? token.slice(0, at) : token;
}

/**
 * プロセスを一意に指す語。`npx -y chrome-devtools-mcp@latest` なら
 * `chrome-devtools-mcp` が拾える。`npx` や `-y` のような共通語では照合しない —
 * 無関係なプロセスに当たる。3 文字以下も切る（`uv` が全部に一致する）。
 */
export function signatures(server: MCPServer): string[] {
  const tokens: string[] = [];
  if (server.transport.type === "stdio") {
    for (const token of server.transport.args) {
      if (!token.startsWith("-")) tokens.push(stripVersion(token));
    }
    tokens.push(stripVersion(basename(server.transport.command)));
  } else {
    tokens.push(server.transport.url);
  }
  // サーバー名そのものは最後の手掛かり。設定に固有の語が無いことがある。
  tokens.push(server.name);
  return tokens.filter(token => token.length > 3 && !GENERIC.has(token));
}

/**
 * 登録済みの設定のうち、動いているものの名前。UI が答えたい問いは
 * 「この登録済みサーバーは動いているか」で、「動いている MCP を全部挙げよ」ではない。
 */
export function running(servers: MCPServer[], rows: ProcessRow[]): Set<string> {
  const live = new Set<string>();
  for (const server of servers) {
    if (!server.enabled) continue;
    const tokens = signatures(server);
    if (tokens.length === 0) continue;
    if (rows.some(row => tokens.some(token => row.command.includes(token)))) live.add(server.name);
  }
  return live;
}

/** View 表示中の 3 秒ポーリングから呼ぶ。key は "agent:serverName"。 */
export async function mcpStatus(servers: Partial<Record<AgentId, MCPServer[]>>, run: Run):
  Promise<Record<string, boolean>> {
  const rows = await snapshot(run);
  const status: Record<string, boolean> = {};
  for (const agent of AGENT_IDS) {
    const live = running(servers[agent] ?? [], rows);
    for (const server of servers[agent] ?? []) {
      status[`${agent}:${server.name}`] = live.has(server.name);
    }
  }
  return status;
}
