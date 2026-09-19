import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AgentId, AGENT_IDS, configDir, displayName } from "../core/agent";
import { cliName } from "./agent";
import { Env, Run } from "./env";

/**
 * GUI から起動されたプロセスの PATH はターミナルと違う。macOS の launchd 起動では
 * `/usr/bin:/bin:/usr/sbin:/sbin` だけになり、Homebrew 配下の CLI が 1 つも見つからない。
 */
function knownDirs(env: Env): string[] {
  if (process.platform === "win32") {
    return [join(env.home, "AppData", "Roaming", "npm"),
            join(env.home, ".local", "bin"),
            join(env.home, ".bun", "bin")];
  }
  return ["/opt/homebrew/bin", "/usr/local/bin",
          join(env.home, ".local", "bin"),
          join(env.home, ".bun", "bin"),
          join(env.home, ".volta", "bin")];
}

/**
 * ログインシェルの PATH を解決する。mise / asdf / nvm の shim もこれで拾える。
 * プロセスが生きている間だけ持ち、永続化しない（ズレの原因になる）。
 */
export async function resolvePath(env: Env, run: Run): Promise<string> {
  const command = process.platform === "win32"
    ? ["powershell", "-NoProfile", "-Command", "$env:PATH"]
    : [process.env.SHELL ?? "/bin/zsh", "-l", "-c", "echo $PATH"];
  const resolved = await run(command).then(out => out.trim()).catch(() => "");
  const dirs = (resolved === "" ? process.env.PATH ?? "" : resolved)
    .split(delimiter).filter(dir => dir !== "");
  // 保険は常に足す。ログインシェルが拾えても mise 等で漏れることがある。
  for (const dir of knownDirs(env)) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs.join(delimiter);
}

export type AgentInfo = {
  readonly id: AgentId;
  readonly displayName: string;
  readonly found: boolean;
  readonly path: string | null;
  readonly version: string | null;
  /** 設定ディレクトリはあるが CLI が無い。既存リソースの表示だけ許す。 */
  readonly configOnly: boolean;
};

const isExecutable = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** PATH を自分で辿る。`which` / `where` の有無に依存しない。 */
export function which(cli: string, path: string): string | null {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, cli + extension.toLowerCase());
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 出力書式がバラバラなので緩く読む。実測:
 *   `2.1.236 (Claude Code)` / `codex-cli 0.153.2` / `0.46.0`
 */
export function parseVersion(output: string): string | null {
  const line = output.split("\n")[0] ?? output;
  for (const token of line.split(/[ \t()]+/)) {
    const candidate = token.replace(/^v/, "");
    if (/^\d+(\.\d+)+/.test(candidate)) return candidate;
  }
  return null;
}

const hasConfigDir = (agent: AgentId, env: Env): boolean => {
  try {
    return statSync(join(env.home, configDir(agent))).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 「非対応」と「未検出」を混ぜない。Cursor は CLI を持たないので、
 * 設定ディレクトリの有無だけで判定する（未検出とは別の状態）。
 */
export async function detect(agent: AgentId, env: Env, path: string, run: Run,
                             override?: string): Promise<AgentInfo> {
  const base = { id: agent, displayName: displayName(agent) };
  const config = hasConfigDir(agent, env);
  const cli = cliName(agent);
  if (cli === null) {
    return { ...base, found: config, path: null, version: null, configOnly: false };
  }
  // 手動指定は毎回実在を確かめる。消えていたら指定が無かったものとして PATH に戻る。
  const manual = override !== undefined && isExecutable(override) ? override : null;
  const found = manual ?? which(cli, path);
  if (found === null) {
    return { ...base, found: false, path: null, version: null, configOnly: config };
  }
  // バージョンが取れなくても「検出済み・バージョン不明」として扱う。
  const version = await run([found, "--version"]).then(parseVersion).catch(() => null);
  return { ...base, found: true, path: found, version, configOnly: false };
}

export async function scanPath(env: Env, run: Run,
                               overrides: Partial<Record<AgentId, string>> = {}): Promise<AgentInfo[]> {
  const path = await resolvePath(env, run);
  const withPath: Run = command => run(command);
  return Promise.all(AGENT_IDS.map(agent => detect(agent, env, path, withPath, overrides[agent])));
}
