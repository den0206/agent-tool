import { ChildProcessByStdio, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { AgentToolError } from "../core/errors";
import { redact } from "./mcpServer";

/** 出力とタイムアウトの上限。拡張のメモリにも CLI の待ち時間にも効く。 */
export const OUTPUT_LIMIT = 2 * 1024 * 1024;
export const TIMEOUT_MS = 180_000;

/**
 * `cmd.exe` が**引用符の中でも**解釈してしまう文字。
 *
 * Windows は `.cmd` / `.bat` を起動するために `cmd.exe` を経由する必要がある。
 * `& | < > ^` は引用符で囲めば literal になるので、`cmdLine` でクォートして通す
 * （MCP の URL に含まれる `?a=1&b=2` や、空白を含むヘッダ値は実在する）。
 *
 * 残すのはクォートでは無力化できないものだけ:
 *   `%VAR%`  … 引用符の中でも展開される
 *   `!VAR!`  … 遅延展開が有効な環境では引用符の中でも展開される
 *   `"`      … CreateProcess 側の引数分割と二重にかかり、安全に埋め込めない
 *   改行・NUL … コマンド行を分割する
 */
const SHELL_SYNTAX = /["%!\0]|\r|\n/;

/** 純粋関数にして全 OS でテストする（実行時に効くのは win32 だけ）。 */
export const hasShellSyntax = (command: readonly string[]): boolean =>
  command.some(part => SHELL_SYNTAX.test(part));

function assertNoShellSyntax(command: readonly string[]): void {
  if (hasShellSyntax(command)) {
    throw new AgentToolError("INVALID_NAME",
      "this command cannot be run on Windows because it contains shell syntax");
  }
}

/**
 * `cmd.exe` に渡す 1 トークン。引用符で囲めば空白も `cmd` のメタ文字も literal になる。
 * 囲むのは必要なときだけにする — 素で足りるトークンを囲むと差分が読みにくい。
 */
export function quoteForCmd(token: string): string {
  if (token === "") return "\"\"";
  // 空白は CreateProcess が、`& | < > ^ ( )` は cmd.exe が区切りとして読む。
  if (!/[\s&|<>^()]/.test(token)) return token;
  // 閉じ引用符の直前の `\` は CreateProcess が引用符のエスケープと読む。二重化する。
  return `"${token.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * `cmd.exe /d /s /c` に渡す 1 本の文字列。`/s` は外側の引用符 1 組を剥がすので、
 * 全体を包んでおけば中のトークンのクォートがそのまま CLI へ届く。
 *
 * `shell: true` は使わない。Node はそのときトークンを空白で連結するだけで
 * クォートしないため、`-H "Authorization: Bearer a b"` が 4 引数に割れる。
 */
export const cmdLine = (command: readonly string[]): string =>
  `"${command.map(quoteForCmd).join(" ")}"`;

/**
 * 外部コマンドを 1 回実行して標準出力を返す。
 * 走査から見た唯一のプロセス依存で、`Run` として注入する。
 */
export function run(command: string[],
                    options: { path?: string; cwd?: string; envOverride?: Record<string, string> } = {}):
  Promise<string> {
  const [file, ...args] = command;
  if (file === undefined) return Promise.resolve("");
  const onWindows = process.platform === "win32";
  if (onWindows) assertNoShellSyntax(command);

  return new Promise((resolve, reject) => {
    const shared = {
      cwd: options.cwd,
      // PATH を明示できるようにする。GUI から起動されたプロセスの PATH は
      // ログインシェルのものと違い、Homebrew 配下の CLI が 1 つも見つからない。
      // 互換検査は資格情報を引き継がせないため、環境そのものを差し替える。
      env: options.envOverride
        ?? (options.path === undefined ? process.env : { ...process.env, PATH: options.path }),
    };
    // Windows では .cmd / .bat も実行対象になるため cmd.exe を経由する。
    // `shell: true` ではなく自分でクォートした 1 本を渡し、`windowsVerbatimArguments`
    // で Node の再クォートを止める — こうしないと空白を含む引数が割れる。
    const child: ChildProcessByStdio<null, Readable, Readable> = onWindows
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmdLine(command)],
        { ...shared, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true })
      : spawn(file, args, { ...shared, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 200).unref();
    }, TIMEOUT_MS);
    timer.unref();

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.byteLength > OUTPUT_LIMIT) {
        exceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return current + chunk.toString();
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk as Buffer); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk as Buffer); });

    child.on("error", error => {
      clearTimeout(timer);
      reject(new AgentToolError("OPERATION_FAILED", `${file} could not be started: ${error.message}`));
    });
    child.on("close", exitCode => {
      clearTimeout(timer);
      if (exceeded) {
        return reject(new AgentToolError("OPERATION_FAILED", `${file} produced more than 2 MB of output`));
      }
      if (exitCode === 0) return resolve(stdout);
      // 引数にシークレットが載ることがあるので、必ずマスクしてから見せる。
      const shown = [file, ...redact(args)].slice(0, 3).join(" ");
      reject(new AgentToolError("OPERATION_FAILED",
        `\`${shown}\` exited with ${exitCode}: ${stderr.slice(-1024)}`));
    });
  });
}
