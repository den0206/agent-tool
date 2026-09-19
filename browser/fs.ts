import { safeSegments } from "../core/archive.js";
import { TreeFile } from "../core/hash.js";
import { LEDGER_DIR } from "../core/ledger.js";
import { ENTRY_LIMIT, EXTRACTED_SIZE_LIMIT, SINGLE_FILE_LIMIT } from "../core/limits.js";
import { RootState, rootStateOf } from "../core/placement.js";
import { dropHandle, loadHandle, saveHandle } from "./store.js";

/**
 * File System Access API はハンドルから basename しか返さない。絶対パスは持てないので、
 * 利用者には「導入先ルートそのものを選んでください」と頼み、選ばれたものは名前だけで示す。
 */

export class PickerError extends Error {
  constructor(
    /** `unavailable` はブラウザがピッカーを出せない。Brave は既定で無効にしている。 */
    readonly kind: "cancelled" | "wrongFolder" | "unavailable",
    readonly chosen?: string,
  ) { super(kind); }
}

/** 設定されているフォルダの状態。判定そのものは core の純粋関数に置く。 */
export const rootState = async (configDir: string): Promise<RootState> =>
  rootStateOf(configDir, (await loadHandle(configDir))?.name ?? null);

/** 設定を取り消す。 */
export const clearRoot = (configDir: string): Promise<void> => dropHandle(configDir);

/** 覚えているハンドルを使えるようにする。権限が切れていれば操作の中で訊き直す。 */
async function revive(configDir: string, pick: boolean): Promise<FileSystemDirectoryHandle | null> {
  const saved = await loadHandle(configDir);
  // 別のフォルダが入っていたら使わない。呼び出し側が設定し直させる。
  if (saved === undefined || saved.name !== configDir) return null;
  if (await saved.queryPermission({ mode: "readwrite" }) === "granted") return saved;
  if (!pick) return null;
  return await saved.requestPermission({ mode: "readwrite" }) === "granted" ? saved : null;
}

/**
 * 設定ディレクトリのハンドルを得る。`pick` が false ならピッカーを出さない
 * （設定済みかの確認に使う）。
 *
 * 選んでもらうのは**エージェントの設定ディレクトリそのもの**に限る。`skills` のような
 * 下位のフォルダを受け取ると、`~/.claude/skills` を Cursor の設定として保存できてしまい、
 * 名前だけでは見分けられない。`skills` と `agents` は設定ディレクトリから辿る。
 *
 * `force` は覚えているものを使わず必ずピッカーを開く。「選び直す」はこれを使う。
 */
export async function configHandle(
  configDir: string, pick: boolean, force = false,
): Promise<FileSystemDirectoryHandle | null> {
  if (!force) {
    const config = await revive(configDir, pick);
    if (config !== null) return config;
  }
  if (!pick) return null;

  // Brave は File System Access API を既定で無効にしている。関数ごと無い場合があるので、
  // 呼ぶ前に見る。押しても何も起きない、という状態を作らない。
  if (typeof showDirectoryPicker !== "function") throw new PickerError("unavailable");

  let handle: FileSystemDirectoryHandle;
  try {
    // `startIn` は指定しない。ホームは指せず、Documents から始めても遠いだけ。
    // `id` を渡しておくと、2 回目からは前回の場所から開く。
    handle = await showDirectoryPicker({
      id: configDir.replace(/[^\w]/g, "_"), mode: "readwrite",
    });
  } catch (error) {
    // 利用者が閉じたのか、ブラウザが出さなかったのかを混ぜない。混ぜると
    // 「押しても無反応」を黙って受け入れることになる。
    if (error instanceof DOMException && error.name === "AbortError") throw new PickerError("cancelled");
    // 画面には案内だけを出す。原因の特定に要るので、生の失敗は console に残す。
    console.error("Agent Tool: showDirectoryPicker", error);
    throw new PickerError("unavailable");
  }
  // 名前が違っても覚える。「いま何が設定されているか」を画面に出すため。
  // 書き込みには使わない（`revive` が名前を見て弾く）。
  await saveHandle(configDir, handle);
  if (handle.name !== configDir) throw new PickerError("wrongFolder", handle.name);
  return handle;
}

/**
 * 置き場のハンドルを得る。`create` が真のときだけ `skills` / `agents` を作る。
 * 許可を貰うだけ・様子を見るだけの場面で、使うか分からないフォルダを作らない。
 */
export async function placeHandle(
  where: { configDir: string; sub: string }, pick: boolean,
  options: { force?: boolean; create?: boolean } = {},
): Promise<FileSystemDirectoryHandle | null> {
  const config = await configHandle(where.configDir, pick, options.force === true);
  if (config === null) return null;
  return await config.getDirectoryHandle(where.sub, { create: options.create === true }).catch(() => null);
}

/** ピッカーが出せないときの案内。Brave だけ直し方が分かっているので分ける。 */
export const pickerUnavailable = (): string => {
  const key = "brave" in navigator ? "pickerUnavailableBrave" : "pickerUnavailable";
  return chrome.i18n.getMessage(key);
};

/**
 * 隠しフォルダはピッカーに出ない。開く前に OS 別の手順を出す。
 * ピッカーの表示は拡張から操作できないので、助けられるのは文言だけ。
 */
export const pickerHint = (path: string): string => {
  const agent = navigator.userAgent;
  const key = agent.includes("Mac") ? "pickerIntroMac"
    : agent.includes("Windows") ? "pickerIntroWindows" : "pickerIntroLinux";
  return chrome.i18n.getMessage(key, [path]);
};

/**
 * 書き込みの失敗は握りつぶさない。`NotAllowedError` なのか `TypeMismatchError` なのかで
 * 手の打ちようが変わるのに、「作れませんでした」だけでは何も分からない。
 */
export class WriteError extends Error {
  constructor(readonly path: string, readonly cause: unknown) {
    const reason = cause instanceof DOMException ? `${cause.name}: ${cause.message}`
      : cause instanceof Error ? cause.message : String(cause);
    super(`${path}: ${reason}`);
  }
}

/** 既存ツリーをメモリへ退避・hash化するときの資源上限超過。 */
export class TreeReadLimitError extends Error {
  constructor(readonly kind: "entries" | "single" | "total", readonly path: string) {
    super(kind === "entries" ? "too many files in the existing tree"
      : kind === "single" ? `${path}: an existing file is too large`
      : "the existing tree is too large");
  }
}

export type TreeReadLimits = { readonly entries: number; readonly single: number; readonly total: number };
const DEFAULT_TREE_READ_LIMITS: TreeReadLimits = {
  entries: ENTRY_LIMIT, single: SINGLE_FILE_LIMIT, total: EXTRACTED_SIZE_LIMIT,
};

const dirOf = async (root: FileSystemDirectoryHandle, segments: string[],
                     create: boolean): Promise<FileSystemDirectoryHandle> => {
  let current = root;
  for (const segment of segments) current = await current.getDirectoryHandle(segment, { create });
  return current;
};

/** 展開済みの中身を書き出す。名前の検証は core と同じ `safeSegments` を通す。 */
export async function writeTree(
  root: FileSystemDirectoryHandle, base: string[], files: readonly TreeFile[],
): Promise<void> {
  for (const file of files) {
    const segments = safeSegments(file.path);
    if (segments === null) throw new WriteError(file.path, "unsafe path");
    const full = [...base, ...segments].join("/");
    try {
      const parent = await dirOf(root, [...base, ...segments.slice(0, -1)], true);
      const handle = await parent.getFileHandle(segments[segments.length - 1], { create: true });
      const writable = await handle.createWritable();
      // DOM 型は SharedArrayBuffer 由来を受けない。実際に渡すのは通常の Uint8Array。
      try { await writable.write(file.bytes as unknown as BufferSource); }
      finally { await writable.close(); }
    } catch (error) {
      throw error instanceof WriteError ? error : new WriteError(full, error);
    }
  }
}

/**
 * 実体を読み出して hash / rollback に使う。外部取得物と同じく件数・単一・合計サイズを
 * 走査中に制限し、巨大な既存ディレクトリを無制限に extension context へ載せない。
 */
export async function readTree(
  root: FileSystemDirectoryHandle, entry: string, isDirectory: boolean,
  limits: TreeReadLimits = DEFAULT_TREE_READ_LIMITS,
): Promise<TreeFile[] | null> {
  let entries = 0;
  let total = 0;
  const readFile = async (handle: FileSystemFileHandle, path: string): Promise<TreeFile> => {
    entries += 1;
    if (entries > limits.entries) throw new TreeReadLimitError("entries", path);
    const file = await handle.getFile();
    if (file.size > limits.single) throw new TreeReadLimitError("single", path);
    total += file.size;
    if (total > limits.total) throw new TreeReadLimitError("total", path);
    return { path, bytes: new Uint8Array(await file.arrayBuffer()) };
  };

  if (!isDirectory) {
    const file = await root.getFileHandle(entry).catch(() => null);
    return file === null ? null : [await readFile(file, entry)];
  }
  const dir = await root.getDirectoryHandle(entry).catch(() => null);
  if (dir === null) return null;
  const files: TreeFile[] = [];
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, child] of handle.entries()) {
      const path = `${prefix}${name}`;
      if (child.kind === "directory") await walk(child, `${path}/`);
      else files.push(await readFile(child, path));
    }
  };
  await walk(dir, "");
  return files;
}

/**
 * 置き場を確保する。**作ってみるまで使えるかは分からない。**
 *
 * IDE 拡張が張った symlink は、`getDirectoryHandle` でも `entries()` でも見えないのに
 * 名前は埋まっている。`create: true` で `NotFoundError` になって初めて分かる。
 * 呼び出し側はここで失敗したら「触れない名前」として扱う。
 */
export async function reserve(
  root: FileSystemDirectoryHandle, entry: string, isDirectory: boolean,
): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> {
  try {
    return isDirectory
      ? await root.getDirectoryHandle(entry, { create: true })
      : await root.getFileHandle(entry, { create: true });
  } catch (error) { throw new WriteError(entry, error); }
}

export const exists = async (root: FileSystemDirectoryHandle, entry: string): Promise<boolean> => {
  const asFile = await root.getFileHandle(entry).then(() => true, () => false);
  return asFile || await root.getDirectoryHandle(entry).then(() => true, () => false);
};

/**
 * 実体 1 件だけを消す。導入先ルートそのものと `.agent-tool` は対象にしない
 * （セキュリティ要件 §10.3）。
 */
export async function removeEntry(
  root: FileSystemDirectoryHandle, entry: string, isDirectory: boolean,
): Promise<void> {
  const segments = safeSegments(entry);
  if (segments === null || segments.length !== 1 || segments[0].startsWith(".")) {
    throw new Error(`refusing to remove ${entry}`);
  }
  await root.removeEntry(segments[0], { recursive: isDirectory });
}

/**
 * 台帳 1 件だけを消す。`.agent-tool/<name>.json` に限り、再帰削除はしない。
 * 消し方をここに集めておくと、書き込み経路がこのファイルだけで数え切れる。
 */
export async function removeLedgerFile(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  const segments = safeSegments(name);
  if (segments === null || segments.length !== 1 || segments[0].startsWith(".")) {
    throw new Error(`refusing to remove ledger ${name}`);
  }
  const dir = await root.getDirectoryHandle(LEDGER_DIR);
  await dir.removeEntry(`${segments[0]}.json`);
}
