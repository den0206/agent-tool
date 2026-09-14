import { join } from "node:path";
import { AGENT_IDS, ruleRoots, skillRoots, subagentRoots, Source } from "../core/agent";
import { mcpSource, pluginSources } from "./agent";
import { Env } from "./env";

/**
 * 走査対象の全列挙。除外リストではなくホワイトリストにすることで、
 * 新しいディレクトリが増えても踏まない。
 *
 * 使用実績ログはここに入れない。読むのは使用状況の分析だけで、一覧走査が
 * 大量の履歴（`~/.claude/projects` 129 MB、`~/.codex/logs_2.sqlite` 44 MB）を
 * 踏むと一覧表示の応答目標が崩れる。
 */
const dirs = (paths: string[]): Source[] =>
  [...new Set(paths)].sort().map(path => ({ kind: "dir", root: "home", path }) as const);

const flat = <T>(f: (agent: (typeof AGENT_IDS)[number]) => T[]): T[] => AGENT_IDS.flatMap(f);

/** 各エージェントの `skillRoots` の和集合。ここには何も書かない（二重管理をしない）。 */
export const SKILL_SOURCES: Source[] = dirs(flat(skillRoots));

export const SUBAGENT_SOURCES: Source[] = [
  ...dirs(flat(subagentRoots)),
  { kind: "dir", root: "appSupport", path: "agents" },
];

/**
 * Rule の走査対象。各エージェントが直読みする `.claude/rules` と `.cursor/rules` だけ。
 * 共有ストアも退避先も無い（registry に載らず、無効化を提供しないため）（D-20）。
 */
export const RULE_SOURCES: Source[] = dirs(flat(ruleRoots));

export const MCP_SOURCES: Source[] = AGENT_IDS.map(mcpSource).filter((s): s is Source => s !== null);

export const PLUGIN_SOURCES: Source[] = flat(pluginSources);

/** 拡張自身の保存領域。 */
export const APP_SOURCES: Source[] = [
  { kind: "file", root: "appSupport", path: "registry.json" },
  { kind: "dir", root: "appSupport", path: "disabled-skills" },
  { kind: "dir", root: "appSupport", path: "disabled-agents" },
  { kind: "file", root: "home", path: ".agents/.skill-lock.json" }, // 読み取り専用
];

export const SOURCES: Source[] =
  [...SKILL_SOURCES, ...SUBAGENT_SOURCES, ...RULE_SOURCES,
   ...MCP_SOURCES, ...PLUGIN_SOURCES, ...APP_SOURCES];

/** ルート相対パス。CLI ケースは null。 */
export const relativePath = (source: Source): string | null =>
  source.kind === "cli" ? null : source.path;

export function sourcePath(source: Source, env: Env): string | null {
  if (source.kind === "cli") return null;
  return join(source.root === "home" ? env.home : env.appSupport, source.path);
}
