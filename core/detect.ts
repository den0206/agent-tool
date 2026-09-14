import { HEAD_BYTES, parse } from "./frontmatter.js";
import { catalog, components, DEFAULT_REF, fromJsonLd, GitHubSource, needsPage, parseUrl } from "./github.js";

/**
 * ブラウザ拡張が扱う種別。MCP は URL に手がかりが無く、Plugin は CLI への登録が必要なので
 * どちらも扱わない（設計決定 D-12）。Rule は共有カタログが存在しないため、URL からの
 * 導入経路を持たず、IDE 拡張の表示・管理だけに閉じる（D-20）。
 */
export type DetectKind = "skill" | "subagent";

/**
 * 「追加できる Tool」の候補。**URL だけでは種別は確定しない**ので、パス名で候補にして
 * `proofs` の実在を確かめてから利用者に見せる。
 */
export type ToolLead = {
  readonly url: string;
  readonly source: GitHubSource;
  readonly kind: DetectKind;
  readonly name: string;
  /**
   * `raw.githubusercontent.com` 上のパス。**どれか 1 つでも 200 なら本物**。
   * 空 = 確認不要（カタログページは配布物そのものが Skill だと分かっている）。
   */
  readonly proofs: readonly string[];
};

/** 実在確認に投げる URL。アーカイブは落とさない — 見ているだけで数 MB は取らない。 */
export const proofUrls = (lead: ToolLead): string[] =>
  lead.proofs.map(path =>
    `https://raw.githubusercontent.com/${lead.source.repo}/`
    + `${lead.source.branch ?? DEFAULT_REF}/${encodeURI(path)}`);

/** パス名だけで種別を当てる。ネットワークに触れない絞り込み。 */
export function kindOf(path: readonly string[]): DetectKind | null {
  const lower = new Set(path.map(part => part.toLowerCase()));
  // Plugin / MCP / Rule はブラウザから導入しない。見分けた上で落とす（Skill と誤認させない）。
  if (lower.has(".claude-plugin") || lower.has("plugins")) return null;
  if (lower.has("rules")) return null;
  if (lower.has("agents") || lower.has("subagents")) return "subagent";
  if (lower.has("skills")) return "skill";
  return null;
}

/**
 * 受ける形:
 *   https://skills.sh/owner/repo/skill      → Skill（カタログ。3 番目がスキル名）
 *   .../tree|blob/main/skills/foo           → Skill
 *   .../blob/main/agents/foo.md             → Subagent
 */
export function lead(raw: string): ToolLead | null {
  const url = raw.trim();

  // カタログはリポジトリのトップを拾わない — 名前が決まらず、出すものが無い。
  const fromCatalog = catalog(url);
  if (fromCatalog !== null) {
    const skill = fromCatalog.skill;
    return skill === undefined ? null
      : { url, source: fromCatalog.source, kind: "skill", name: skill, proofs: [] };
  }

  const parts = components(url);
  if (parts === null || parts.branch === undefined || parts.path.length === 0) return null;
  const kind = kindOf(parts.path);
  if (kind === null) return null;
  const source = parseUrl(url);
  if (source === null) return null;

  const file = parts.path.join("/");
  if (kind === "subagent") {
    // Subagent は .md ファイル 1 つ。ディレクトリを指されても中身のファイル名が
    // 分からず確認できないので、その場合は候補にしない。
    if (!parts.isFile) return null;
    const last = parts.path[parts.path.length - 1];
    return { url, source, kind, name: last.replace(/\.md$/, ""), proofs: [file] };
  }

  const directory = parts.isFile ? parts.path.slice(0, -1) : parts.path;
  return {
    url, source, kind,
    name: directory[directory.length - 1] ?? source.repo,
    proofs: [parts.isFile ? file : `${file}/SKILL.md`],
  };
}

/** 既定の置き場。ここに並ぶものを一覧にする。 */
export const SKILL_INDEX_DIR = "skills";

/**
 * **1 件ではなく一覧**を出すページか。Skill が並ぶディレクトリを指す URL を受ける。
 *
 *   github.com/<owner>/<repo>/tree/<branch>/skills   → その下を列挙する
 *   skills.sh/<owner>/<repo>                         → 既定の `skills/` を列挙する
 *
 * 判定はここまでで、列挙は `core/tree.ts` が GitHub の tree API で行う。
 * アーカイブを落とさないので、取得上限を超える大きいリポジトリからも 1 件ずつ入れられる。
 */
export function skillIndex(
  raw: string,
): { url: string; source: GitHubSource; subdir: string } | null {
  const url = raw.trim();

  // カタログのリポジトリページ。スキル名が無い = 1 件に決まらない。
  const fromCatalog = catalog(url);
  if (fromCatalog !== null) {
    return fromCatalog.skill === undefined
      ? { url, source: fromCatalog.source, subdir: SKILL_INDEX_DIR } : null;
  }

  const parts = components(url);
  if (parts === null || parts.branch === undefined || parts.isFile) return null;
  // 置き場そのものを指しているときだけ。`skills/pdf` は 1 件の Skill である。
  const last = parts.path[parts.path.length - 1];
  if (last === undefined || last.toLowerCase() !== SKILL_INDEX_DIR) return null;
  const source = parseUrl(url);
  return source === null ? null : { url, source, subdir: parts.path.join("/") };
}

/** content script が渡した URL と JSON-LD から、ブラウザ表示用の候補を作る。 */
export function detectPage(url: string, jsonLd = ""): ToolLead | null {
  const resolved = needsPage(url) === null ? url : fromJsonLd(jsonLd);
  return resolved === null ? null : lead(resolved);
}

/** カタログは実体パスを約束しないため、展開確認に通った候補だけを返す。 */
export async function verifiedPage(
  url: string, jsonLd: string, canExtract: (found: ToolLead) => Promise<boolean>,
): Promise<ToolLead | null> {
  const found = detectPage(url, jsonLd);
  return found === null || (found.proofs.length === 0 && !await canExtract(found)) ? null : found;
}

/**
 * 展開した中身から、カタログが指すスキルのディレクトリを探す。
 *
 * カタログの名前はディレクトリ名とは限らない。`skills.sh` が出す
 * `vercel-react-best-practices` の実体は `skills/react-best-practices` で、
 * 一致するのは **SKILL.md の frontmatter `name`** の方である。
 * ディレクトリ名で当たらなければ frontmatter を読んで突き合わせる。
 */
export function locateSkill(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  name: string,
): string[] | null {
  const decoder = new TextDecoder();
  const candidates = files
    .map(file => ({ file, parts: file.path.split("/") }))
    .filter(item => item.parts[item.parts.length - 1] === "SKILL.md" && item.parts.length >= 2)
    .sort((a, b) => a.parts.length - b.parts.length);      // 浅い方を先に見る

  const byDirectory = candidates.find(item => item.parts[item.parts.length - 2] === name);
  if (byDirectory !== undefined) return byDirectory.parts.slice(0, -1);

  for (const item of candidates) {
    const head = decoder.decode(item.file.bytes.subarray(0, HEAD_BYTES));
    const result = parse(head);
    if (result.status === "parsed" && result.matter.name === name) {
      return item.parts.slice(0, -1);
    }
  }
  return null;
}
