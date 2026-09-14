import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Env } from "./env";
import { readJsonc } from "./mcpScanner";

/** プロジェクト配下を歩く深さ。これ以上は掘らない。 */
export const SKILL_DEPTH = 3;
export const NOT_WALKED: ReadonlySet<string> =
  new Set(["node_modules", "Pods", "vendor", "target", "dist", "build", "out"]);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * プロジェクト内の `.claude/skills` を探す。サブディレクトリは `SKILL_DEPTH` まで。
 * ホームやワークスペース全体は再帰走査しない（走査ホワイトリストの例外はここだけ）。
 */
export function projectSkillRoots(project: string): { prefix: string; path: string }[] {
  const found: { prefix: string; path: string }[] = [];
  walk(project, "", SKILL_DEPTH, found);
  return found;
}

function walk(dir: string, prefix: string, depth: number,
              found: { prefix: string; path: string }[]): void {
  const skills = join(dir, ".claude", "skills");
  if (isDirectory(skills)) found.push({ prefix, path: skills });
  if (depth <= 0) return;
  let children: string[];
  try {
    children = readdirSync(dir).filter(name => !name.startsWith(".") && !NOT_WALKED.has(name)).sort();
  } catch {
    return;
  }
  for (const child of children) {
    const path = join(dir, child);
    if (!isDirectory(path)) continue;
    walk(path, prefix === "" ? child : `${prefix}/${child}`, depth - 1, found);
  }
}

/** Subagent はプロジェクト直下だけ。走査もそこしか見ていない。 */
export const projectSubagentRoot = (project: string): string => join(project, ".claude", "agents");

/**
 * Rule はプロジェクト直下だけを見る。Claude と Cursor で置き場が違うので両方を返す。
 * 呼び出し側は 2 つのルートをそれぞれ走査し、ラベル（相対パス）で区別する（D-20）。
 */
export const projectRuleRoots = (project: string): { path: string; label: string }[] => [
  { path: join(project, ".claude", "rules"), label: ".claude/rules" },
  { path: join(project, ".cursor", "rules"), label: ".cursor/rules" },
];

/** 中身のあるディレクトリか。隠しファイルだけの置き場は「無い」と扱う。 */
const hasEntries = (path: string): boolean => {
  try {
    return readdirSync(path).some(name => !name.startsWith("."));
  } catch {
    return false;
  }
};

/**
 * ドロップダウンに出す価値があるか。プロジェクト直下の既知の置き場を stat するだけで決める。
 *
 * ponytail: 深さ 3 の再帰走査（`projectSkillRoots`）はここでは回さない。
 * 候補全件に掛けると一覧表示の応答目標を超える。モノレポの下位ディレクトリにしか
 * Skill が無いプロジェクトは候補に出ないが、選んだあとの走査では拾う。
 */
const hasTools = (project: string, localMcp: boolean): boolean =>
  localMcp
  || existsSync(join(project, ".mcp.json"))
  || hasEntries(join(project, ".claude", "skills"))
  || hasEntries(projectSubagentRoot(project))
  || projectRuleRoots(project).some(({ path }) => hasEntries(path));

/**
 * Claude Code が開いたことのあるプロジェクトのうち、ツールを持つものだけ。
 * `~/.claude.json` の `projects` キーだけを読み、ホームは走査しない（不変条件 3）。
 * MCP の local 登録は同じファイルにあるので、追加の読み取りをしない。
 */
export function knownProjects(env: Env): string[] {
  let root: unknown;
  try {
    root = readJsonc(join(env.home, ".claude.json"));
  } catch {
    return [];   // 未作成も壊れたファイルも、一覧は止めない
  }
  const projects = (root as { projects?: unknown } | null)?.projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return [];
  return Object.entries(projects as Record<string, unknown>)
    .filter(([path, node]) => {
      const servers = (node as { mcpServers?: unknown } | null)?.mcpServers;
      const localMcp = typeof servers === "object" && servers !== null
        && Object.keys(servers).length > 0;
      return isDirectory(path) && hasTools(path, localMcp);
    })
    .map(([path]) => path)
    .sort();
}
