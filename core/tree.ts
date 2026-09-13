import { DEFAULT_REF, GitHubSource } from "./github.js";
import { TreeFile } from "./hash.js";
import { ENTRY_LIMIT, EXTRACTED_SIZE_LIMIT, SINGLE_FILE_LIMIT } from "./limits.js";

/**
 * `skills/` のように Skill が並ぶディレクトリを、アーカイブを落とさずに読む。
 *
 * 大きいリポジトリはアーカイブが取得上限を超えて 1 件も入れられない
 * （実測: `heygen-com/hyperframes` は圧縮 116 MB。欲しいのは 104 KB）。
 * GitHub の tree API は `<ref>:<パス>` で部分木だけを返すので、そこから **1 件ずつ**取り出す。
 *
 * API を叩くのは列挙の 1 回だけ。実体は `raw.githubusercontent.com`（CDN）から取るので、
 * 未認証 60 req/時の枠を件数ぶん食わない。
 */

/** 実体 1 ファイル。パスは置き場からの相対。 */
export type SkillFile = { readonly path: string; readonly size: number };

/** 列挙で見つかった Skill 1 件。`files` は `<subdir>/<name>/` からの相対パス。 */
export type SkillEntry = {
  readonly name: string;
  readonly files: readonly SkillFile[];
};

/** API の応答。取れなければ `null`（枠切れ・通信失敗・非公開を区別しない）。 */
export type GetJson = (url: string) => Promise<unknown | null>;
/** `tooLarge` は、呼び出し元が本文を上限までしか読まなかった印。 */
export type GetBytes = (url: string, limit: number) => Promise<Uint8Array | null | "tooLarge">;

/** 部分木の指定。`<ref>:<パス>` は git の記法で、tree API がそのまま受ける。 */
const treeUrl = (source: GitHubSource, subdir: string): string =>
  `https://api.github.com/repos/${source.repo}/git/trees/`
  + `${source.branch ?? DEFAULT_REF}:${encodePath(subdir)}?recursive=1`;

const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

const rawUrl = (source: GitHubSource, path: string): string =>
  `https://raw.githubusercontent.com/${source.repo}/${source.branch ?? DEFAULT_REF}/`
  + encodePath(path);

type Node = { path: string; type: string; size?: number };

const nodes = (raw: unknown): Node[] | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const tree = (raw as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) return null;
  const found: Node[] = [];
  for (const item of tree) {
    if (typeof item !== "object" || item === null) continue;
    const node = item as Record<string, unknown>;
    if (typeof node.path !== "string" || typeof node.type !== "string") continue;
    found.push({
      path: node.path, type: node.type,
      ...(typeof node.size === "number" ? { size: node.size } : {}),
    });
  }
  return found;
};

/** 一覧が信用できない（途中で切れている）なら使わない。 */
const truncated = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && (raw as { truncated?: unknown }).truncated === true;

/**
 * `subdir` の直下に並ぶ Skill を列挙する。API は 1 回だけ叩く。
 *
 * リポジトリ全体の tree は読まない — 実測で 2.7 MB あり、部分木なら 289 KB で足りる。
 * `SKILL.md` を持たないディレクトリは返さない。押しても入らない行を並べない。
 */
export async function listSkills(
  source: GitHubSource, subdir: string, get: GetJson,
): Promise<SkillEntry[]> {
  const raw = await get(treeUrl(source, subdir));
  const tree = nodes(raw);
  // 切れている一覧は「全部」ではない。出すと入らないものが混ざるので使わない。
  if (tree === null || truncated(raw)) return [];

  const byName = new Map<string, { path: string; size: number }[]>();
  for (const node of tree) {
    if (node.type !== "blob") continue;
    const at = node.path.indexOf("/");
    if (at <= 0) continue;                       // 直下のファイルは Skill ではない
    const name = node.path.slice(0, at);
    const files = byName.get(name) ?? [];
    files.push({ path: node.path.slice(at + 1), size: node.size ?? 0 });
    byName.set(name, files);
  }

  const found: SkillEntry[] = [];
  for (const [name, files] of byName) {
    if (!files.some(file => file.path === "SKILL.md")) continue;
    found.push({ name, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export class TreeFetchError extends Error {
  constructor(readonly kind: "tooLarge" | "fetchFailed", message: string) {
    super(message);
  }
}

/**
 * 置き場 1 つぶんのファイルを読む。`listSkills` と同じ部分木の読み方で、1 件だけを見る。
 * `SKILL.md` を持たなければ `null` — Skill の実体ではない。
 */
export async function listFiles(
  source: GitHubSource, base: string, get: GetJson,
): Promise<SkillFile[] | null> {
  const raw = await get(treeUrl(source, base));
  const tree = nodes(raw);
  // 「読めなかった」と「Skill ではない」を混ぜない。API の枠切れを
  // 「見つかりません」と言うと、利用者は直しようのない案内を受け取る。
  if (tree === null || truncated(raw)) {
    throw new TreeFetchError("fetchFailed", "the repository listing could not be read");
  }
  const files = tree
    .filter(node => node.type === "blob")
    .map(node => ({ path: node.path, size: node.size ?? 0 }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return files.some(file => file.path === "SKILL.md") ? files : null;
}

/**
 * 置き場 1 つぶんの実体を取る。**上限はアーカイブ経路と同じものを当てる** — 取得のしかたが
 * 違うだけで、入ってくるものは同じ外部入力である。
 */
export async function fetchFiles(
  source: GitHubSource, base: string, files: readonly SkillFile[], getBytes: GetBytes,
): Promise<TreeFile[]> {
  if (files.length > ENTRY_LIMIT) {
    throw new TreeFetchError("tooLarge", "too many files in the skill");
  }
  let declaredTotal = 0;
  for (const file of files) {
    if (file.size > SINGLE_FILE_LIMIT) {
      throw new TreeFetchError("tooLarge", `${file.path}: a file is too large`);
    }
    declaredTotal += file.size;
    if (declaredTotal > EXTRACTED_SIZE_LIMIT) {
      throw new TreeFetchError("tooLarge", "the skill is too large");
    }
  }

  const got: TreeFile[] = [];
  let actualTotal = 0;
  for (const file of files) {
    const limit = Math.min(SINGLE_FILE_LIMIT, EXTRACTED_SIZE_LIMIT - actualTotal);
    const bytes = await getBytes(rawUrl(source, `${base}/${file.path}`), limit);
    if (bytes === "tooLarge") {
      throw new TreeFetchError("tooLarge", `${file.path}: a file is too large`);
    }
    if (bytes === null) {
      throw new TreeFetchError("fetchFailed", `${file.path} could not be fetched`);
    }
    // 宣言された大きさを超えて受け取らない。上限の検査を後追いで無効にしない。
    if (bytes.length > SINGLE_FILE_LIMIT) {
      throw new TreeFetchError("tooLarge", `${file.path}: a file is too large`);
    }
    actualTotal += bytes.length;
    if (actualTotal > EXTRACTED_SIZE_LIMIT) {
      throw new TreeFetchError("tooLarge", "the skill is too large");
    }
    got.push({ path: file.path, bytes });
  }
  return got;
}
