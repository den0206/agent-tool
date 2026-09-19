import { AgentId, AGENT_IDS, configDir, skillRoots, subagentRoots, supports } from "./agent.js";
import { DetectKind } from "./detect.js";

/**
 * ブラウザ拡張の導入先。ホーム相対のディレクトリと、その下に作る名前だけを決める。
 * 絶対パスは持てない — File System Access API のハンドルからは basename しか得られない。
 *
 * 利用者に選んでもらうのは **エージェントの設定ディレクトリ**（`~/.claude`）にする。
 * `skills` と `agents` はそこから辿れるので、ピッカーを出す回数がエージェントごとに 1 回で済む。
 */
export type Placement = {
  /** 利用者が選ぶディレクトリ（ホーム相対）。 */
  readonly configDir: string;
  /** 設定ディレクトリから見た置き場。無ければ作る。 */
  readonly sub: string;
  /** その下に作るもの。Skill はディレクトリ、Subagent は `.md` ファイル。 */
  readonly entry: string;
  readonly isDirectory: boolean;
};

/** Cursor と Codex はどちらもここを読む。1 つ置けば両方から使える。 */
export const SHARED_CONFIG_DIR = ".agents";
const SHARED_SKILL_ROOT = `${SHARED_CONFIG_DIR}/skills`;

/** 一覧や台帳で使うホーム相対のルート。 */
export const rootOf = (where: Placement): string => `${where.configDir}/${where.sub}`;

/** 選んでもらう必要のあるディレクトリの全列挙。設定画面がこの順で並べる。 */
export const CONFIG_DIRS: readonly string[] =
  [".claude", ".cursor", ".codex", SHARED_CONFIG_DIR];

/** その種別を導入できるエージェント。Gemini は MCP だけなので現れない。 */
export const targets = (kind: DetectKind): AgentId[] =>
  AGENT_IDS.filter(agent => supports(agent, kind) && roots(agent, kind).length > 0);

const roots = (agent: AgentId, kind: DetectKind): string[] =>
  kind === "skill" ? skillRoots(agent) : subagentRoots(agent);

/**
 * 置き場を決める。共有ストアを読むエージェントで、かつ利用者が共有ストアを許可済みなら
 * そこへ 1 つ置く。読まないエージェント（Claude）と未許可のときは各エージェント直下へ。
 */
export function placement(
  agent: AgentId, kind: DetectKind, name: string,
  sharedRootAvailable: boolean,
): Placement | null {
  if (!supports(agent, kind)) return null;
  const available = roots(agent, kind);
  if (available.length === 0) return null;

  const shared = sharedRootAvailable && available.includes(SHARED_SKILL_ROOT);
  const where = {
    configDir: shared ? SHARED_CONFIG_DIR : configDir(agent),
    sub: shared || kind === "skill" ? "skills" : "agents",
  };
  // 選んだ置き場がそのエージェントの読む場所に入っていること。推測で書かない。
  if (!available.includes(`${where.configDir}/${where.sub}`)) return null;

  return kind === "skill"
    ? { ...where, entry: name, isDirectory: true }
    : { ...where, entry: `${name}.md`, isDirectory: false };
}

/** `.claude/skills` を設定ディレクトリと置き場に割る。収集一覧が持つのはこの形。 */
export const splitRoot = (root: string): { configDir: string; sub: string } => {
  const at = root.indexOf("/");
  return at < 0
    ? { configDir: root, sub: "" }
    : { configDir: root.slice(0, at), sub: root.slice(at + 1) };
};

/**
 * 設定されているフォルダの状態。
 *
 * File System Access API のハンドルから得られるのは末尾の名前だけで、絶対パスは取れない。
 * 設定ディレクトリ名（`.claude` `.cursor` `.codex` `.agents`）はエージェント間で
 * 重複しないので、名前が一致すればそのエージェントのものと判断できる。一致しなければ
 * 別のフォルダが入っているので、導入させずに設定し直してもらう。
 */
export type RootState =
  | { readonly kind: "unset" }
  | { readonly kind: "ok" }
  /** 別のフォルダが設定されている。`chosen` は設定されている方の名前。 */
  | { readonly kind: "mismatch"; readonly chosen: string };

/**
 * @param savedName 設定ディレクトリのキーで覚えているハンドルの名前。無ければ null。
 */
export const rootStateOf = (configDir: string, savedName: string | null): RootState =>
  savedName === null ? { kind: "unset" }
    : savedName === configDir ? { kind: "ok" }
    : { kind: "mismatch", chosen: savedName };
