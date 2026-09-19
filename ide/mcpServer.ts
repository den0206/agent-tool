import { isObject } from "../core/json";

/**
 * MCP サーバー 1 件。実測した 2 形式に対応する。
 *   Claude:  {"type":"stdio","command":"npx","args":[...],"env":{}}
 *   Cursor:  {"command":"npx","args":[...]}
 */
export type Transport =
  | { readonly type: "stdio"; readonly command: string; readonly args: string[]; readonly env: Record<string, string> }
  | { readonly type: "http"; readonly url: string; readonly headers: Record<string, string> };

/**
 * CLI の `-s` に載る登録先。`ScopeId` とは別物で、`project`（`.mcp.json`、git 共有）と
 * `local`（`~/.claude.json`、そのマシンだけ）を潰さずに持つ。削除の宛先になる。
 */
export type MCPScope = "user" | "project" | "local";

export type MCPServer = {
  readonly name: string;
  readonly transport: Transport;
  /** エージェントが管理している。追加・削除の対象にしない。 */
  readonly isProtected: boolean;
  readonly enabled: boolean;
};

const stringMap = (value: unknown): Record<string, string> | null => {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
};

const stringList = (value: unknown): string[] | null => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return null;
  return value as string[];
};

/** `{"name": {...}}` を解釈する。`url` があれば HTTP、無ければ stdio。 */
export function parse(name: string, raw: Record<string, unknown>): MCPServer | null {
  const object = isObject(raw.transport) ? raw.transport : raw;
  const isProtected = raw.isBuiltIn === true || raw.managed === true;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;

  if (typeof object.url === "string") {
    const headers = stringMap(object.headers);
    if (headers === null) return null;
    return { name, transport: { type: "http", url: object.url, headers }, isProtected, enabled };
  }
  if (typeof object.command !== "string") return null;
  const args = stringList(object.args);
  const env = stringMap(object.env);
  if (args === null || env === null) return null;
  return { name, transport: { type: "stdio", command: object.command, args, env }, isProtected, enabled };
}

/** `{"mcpServers": {...}}` あるいは `{...}` から一括で読む。 */
export function parseAll(container: Record<string, unknown>): MCPServer[] {
  const servers = isObject(container.mcpServers) ? container.mcpServers : container;
  return Object.entries(servers)
    .flatMap(([name, value]) => {
      if (!isObject(value)) return [];
      const server = parse(name, value);
      return server === null ? [] : [server];
    })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const SECRET_FLAGS = new Set([
  "--token", "--api-key", "--apikey", "--secret", "--password", "--authorization", "-h", "--header",
]);

/** シークレットは表示の前に落とす。 */
export function redact(args: string[]): string[] {
  let hideNext = false;
  return args.map(argument => {
    const lower = argument.toLowerCase();
    const hide = hideNext;
    hideNext = SECRET_FLAGS.has(lower);
    if (hide) return "[redacted]";
    if (SECRET_FLAGS.has(lower)) return argument;
    const assigned = [...SECRET_FLAGS].find(flag => lower.startsWith(flag + "="));
    if (assigned) return argument.slice(0, argument.indexOf("=")) + "=[redacted]";
    if (lower.startsWith("authorization:")) return "Authorization: [redacted]";
    return argument;
  });
}

/** 1 行の要約。UI の説明欄に出す。認証情報は落とす。 */
export function summary(server: MCPServer): string {
  if (server.transport.type === "stdio") {
    return [server.transport.command, ...redact(server.transport.args)].join(" ");
  }
  try {
    const url = new URL(server.transport.url);
    url.username = "";
    url.password = "";
    if (url.search !== "") url.search = "[redacted]";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted URL]";
  }
}

/**
 * `@latest` 指定は起動のたびに最新を取るので、こちらが更新を管理する余地が無い。
 * 黙って壊れうるのでピン留めを促す。
 */
export function floatingPackage(server: MCPServer): string | null {
  if (server.transport.type !== "stdio") return null;
  const suffix = "@latest";
  const token = server.transport.args.find(item => item.endsWith(suffix));
  if (token) return token.slice(0, -suffix.length);
  const { command } = server.transport;
  return command.endsWith(suffix) ? command.slice(0, -suffix.length) : null;
}
