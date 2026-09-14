import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Env } from "./env";
import * as frontmatter from "./frontmatter";
import { relativePath, RULE_SOURCES, SKILL_SOURCES, SUBAGENT_SOURCES, sourcePath } from "./source";
import { isLink } from "./writeGuard";

/**
 * エージェントが実際に読み込めるか。リンク切れと SKILL.md 欠落は読み込まれないので、
 * 一覧で「有効」と表示してはいけない。
 */
export type Status =
  | "ok"
  /** リンク先が存在しない。 */
  | "brokenLink"
  /** ディレクトリはあるが SKILL.md が無い。 */
  | "noSkillFile"
  /** frontmatter が先頭 4 KB に収まっていない。 */
  | "truncatedFrontmatter"
  /** `---` で始まっていない。 */
  | "missingFrontmatter";

export type Skill = {
  /** ディレクトリ名。frontmatter の name とズレることがある。 */
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  /** 見つかったルート（ホーム相対）。 */
  readonly root: string;
  readonly status: Status;
};

export const isLoadable = (status: Status): boolean =>
  status !== "brokenLink" && status !== "noSkillFile";

const statusOf = (result: frontmatter.FrontmatterResult): Status =>
  result.status === "parsed" ? "ok"
    : result.status === "truncated" ? "truncatedFrontmatter" : "missingFrontmatter";

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** リンク切れ。`existsSync` はリンク先を見るので false になる。 */
const isBrokenLink = (path: string): boolean => isLink(path) && !existsSync(path);

const entries = (root: string): string[] => {
  try {
    return readdirSync(root).sort();
  } catch {
    return [];
  }
};

/**
 * 「無い」のか「読めない」のか。走査は両方を空として扱うが、registry から実体の
 * 無い entry を落とす `prune` は区別しないといけない。読めないだけのルートを
 * 「消えた」と扱うと、実体が残っているのに pinned / disabled / 取得元を失う。
 */
export const isUnreadable = (root: string): boolean => {
  if (!existsSync(root)) return false;
  try {
    accessSync(root, constants.R_OK | constants.X_OK);
    return false;
  } catch {
    return true;                                 // 権限・退避されたクラウド同期・切れたネットワークホーム
  }
};

/** 走査できたはずなのに読めなかったルート。1 つでもあれば `prune` は行わない。 */
export const unreadableRoots = (env: Env, extra: readonly string[] = []): string[] => [
  ...[...SKILL_SOURCES, ...SUBAGENT_SOURCES, ...RULE_SOURCES]
    .map(source => sourcePath(source, env))
    .filter((root): root is string => root !== null),
  ...extra,
].filter(isUnreadable);

/** 走査ホワイトリストの全スキルルートを見る。列挙外のパスは触らない。 */
export const scanSkills = (env: Env): Skill[] =>
  SKILL_SOURCES.flatMap(source => {
    const root = sourcePath(source, env), label = relativePath(source);
    return root === null || label === null ? [] : scanSkillRoot(root, label);
  });

export function scanSkillRoot(root: string, label: string): Skill[] {
  return entries(root)
    .filter(name => !name.startsWith("."))   // .system / .sync-manifest.json などは対象外
    .flatMap(name => {
      const skill = readSkill(name, root, label);
      return skill === null ? [] : [skill];
    });
}

function readSkill(name: string, root: string, label: string): Skill | null {
  const path = join(root, name);
  if (isBrokenLink(path)) return { name, path, root: label, status: "brokenLink" };

  try {
    if (!statSync(path).isDirectory()) return null;   // ただのファイルはスキルではない
  } catch {
    return null;
  }

  if (!existsSync(join(path, "SKILL.md"))) {
    return { name, path, root: label, status: "noSkillFile" };
  }
  const result = frontmatter.read(join(path, "SKILL.md"));
  return {
    name, path, root: label, status: statusOf(result),
    description: result.status === "parsed" ? result.matter.description : undefined,
  };
}

/** Subagent は単一の `.md`。共有ルートの慣習が無いので各エージェントの下を直接見る。 */
export type Subagent = Skill;

export const scanSubagents = (env: Env): Subagent[] =>
  SUBAGENT_SOURCES.flatMap(source => {
    const root = sourcePath(source, env), label = relativePath(source);
    return root === null || label === null ? [] : scanSubagentRoot(root, label);
  });

export function scanSubagentRoot(root: string, label: string): Subagent[] {
  return entries(root)
    .filter(name => name.endsWith(".md") && !name.startsWith("."))
    .flatMap((file): Subagent[] => {
      const path = join(root, file);
      // 識別子はファイル名。frontmatter の name とズレると有効化・無効化が実体を見失う。
      const name = file.slice(0, -3);
      if (isBrokenLink(path)) return [{ name, path, root: label, status: "brokenLink" }];
      if (!existsSync(path)) return [];
      const result = frontmatter.read(path);
      return [{
        name, path, root: label, status: statusOf(result),
        description: result.status === "parsed" ? result.matter.description : undefined,
      }];
    });
}

/**
 * Rule は Claude の `.md` と Cursor の `.mdc` の 2 拡張子。走査は両方を拾う（D-20）。
 * 識別子（`name`）はファイル名から拡張子を落としたもの。Cursor は `.md` を無視するので、
 * `.mdc` と `.md` の間で重複することはない。
 */
export type Rule = Skill;

export const scanRules = (env: Env): Rule[] =>
  RULE_SOURCES.flatMap(source => {
    const root = sourcePath(source, env), label = relativePath(source);
    return root === null || label === null ? [] : scanRuleRoot(root, label);
  });

/**
 * ルール専用の走査。Cursor は `.mdc`、Claude は `.md`。ルート名で拡張子を切り替える。
 *
 * サブディレクトリも見る — Cursor は `.cursor/rules/**` を読み、実際の置き場も
 * `rules/common/` のように分けられている。修飾名はプロジェクトの Skill と同じ
 * `common:api` 形式にし、`isManageable` が `:` を弾くので削除対象にはならない。
 */
export function scanRuleRoot(root: string, label: string, prefix = "", depth = 2): Rule[] {
  const ext = label === ".cursor/rules" ? ".mdc" : ".md";
  return entries(root)
    .filter(file => !file.startsWith("."))
    .flatMap((file): Rule[] => {
      const path = join(root, file);
      if (!file.endsWith(ext)) {
        // リンクされたディレクトリには降りない。辿ると走査ホワイトリストの外
        // （`rules/linked -> ~/Documents`）まで読んでしまう。
        return depth > 0 && !isLink(path) && isDirectory(path)
          ? scanRuleRoot(path, label, `${prefix}${file}:`, depth - 1) : [];
      }
      const name = `${prefix}${file.slice(0, -ext.length)}`;
      if (isBrokenLink(path)) return [{ name, path, root: label, status: "brokenLink" }];
      if (!existsSync(path)) return [];
      const result = frontmatter.read(path);
      return [{
        name, path, root: label, status: statusOf(result),
        description: result.status === "parsed" ? result.matter.description : undefined,
      }];
    });
}
