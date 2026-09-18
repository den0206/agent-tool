import { join } from "node:path";
import { AgentId, KindId } from "../core/agent";
import { agentStore, claudeSkills, Env, skillStore } from "./env";
import { AgentToolError } from "../core/errors";
import { entry, Registry } from "./registry";
import * as guard from "./writeGuard";

/**
 * 実体をどこに置くか。project はプロジェクト内に直接置き、リンクを張らない —
 * プロジェクトのファイルは git で共有されるもので、リンクでは他の人の手元で切れる。
 */
export type Place =
  | { readonly scope: "user" }
  | { readonly scope: "project"; readonly path: string };

export const USER: Place = { scope: "user" };

export type Layout = {
  /** 実体の置き場。 */
  readonly store: string;
  /** 各エージェントから見えるようにするリンク。 */
  readonly links: string[];
  /** リンクの種別。Skill はディレクトリ、Subagent は単一ファイル。 */
  readonly linkKind: "dir" | "file";
};

/**
 * 実体のルート（ホーム相対、`/` 区切り）を絶対パスに直す。
 * `..` で外へ出るものは受けない — registry は利用者が手で書き換えられるファイルである。
 */
const rootPath = (env: Env, root: string): string | null => {
  const parts = root.split("/").filter(part => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some(part => part === ".." || part.includes("\\"))) return null;
  return join(env.home, ...parts);
};

/**
 * 実体とリンクの置き場を決める。
 *
 * `root` は registry が記録した実体のルート（ホーム相対）。既定の管理ストアと違う場所を
 * 指しているとき（ブラウザ拡張が `~/.claude/skills` へ直接書いた分）は、そこを実体として
 * 扱い、**リンクは張らない** — 実体はもうエージェントが読む場所にあるので、
 * 足すと自分自身を指すリンクや、利用者が選んでいないエージェントへの配布になる。
 */
export function layout(name: string, kind: KindId, env: Env, place: Place = USER,
                       root?: string): Layout {
  // MCP / Plugin / Rule はこちらの管理ストアに実体を持たない。ここを素通りさせると
  // `~/.agents/skills/<name>` を指してしまい、同名の Skill を消しにいく。Rule は
  // URL からの導入経路を持たず（D-20）、`layout` の管理下には現れない。
  if (kind !== "skill" && kind !== "subagent") {
    throw new AgentToolError("OPERATION_FAILED",
      `${kind} is managed by the agent, not by Agent Tool`);
  }
  if (place.scope === "project") {
    // 一覧が読む場所にそのまま置く（`projectSkillRoots` / `projectSubagentRoot`）。
    return kind === "subagent"
      ? { store: join(place.path, ".claude", "agents", `${name}.md`), links: [], linkKind: "file" }
      : { store: join(place.path, ".claude", "skills", name), links: [], linkKind: "dir" };
  }
  const recorded = root === undefined ? null : rootPath(env, root);
  if (kind === "subagent") {
    const store = join(agentStore(env), `${name}.md`);
    if (recorded !== null && !guard.isSamePath(recorded, agentStore(env))) {
      return {
        store: join(recorded, `${name}.md`),
        links: [], linkKind: "file",
      };
    }
    return {
      store,
      // Subagent は共有ルートの慣習が無いのでリンクが 2 本要る。
      links: [join(env.home, ".claude", "agents", `${name}.md`),
              join(env.home, ".cursor", "agents", `${name}.md`)],
      linkKind: "file",
    };
  }
  if (recorded !== null && !guard.isSamePath(recorded, skillStore(env))) {
    return {
      store: join(recorded, name),
      links: [], linkKind: "dir",
    };
  }
  return {
    store: join(skillStore(env), name),
    // Claude だけは共有ルートを読まないのでリンクが要る。Cursor / Codex は直読み。
    links: [join(claudeSkills(env), name)],
    linkKind: "dir",
  };
}

/**
 * registry が記録した実体のルート。取り込んだものは管理ストアの外にあるので、
 * 実体を触る操作はすべてこれを通して `layout` を組む。
 */
const recordedRoot = (registry: Registry, name: string, kind: KindId, place: Place):
  string | undefined => place.scope === "project" ? undefined : entry(registry, name, kind)?.root;

/** その名前・種別の置き場。registry が記録したルートを反映する。 */
const planFor = (name: string, kind: KindId, env: Env, registry: Registry,
                 place: Place = USER): Layout =>
  layout(name, kind, env, place, recordedRoot(registry, name, kind, place));

const notFound = (name: string): never => {
  throw new AgentToolError("NOT_FOUND", `${name} was not found`);
};

const rollbackFailed = (original: unknown, rollback: unknown): never => {
  throw new AgentToolError("OPERATION_FAILED",
    `the operation failed and the original state could not be fully restored: ${original}; ${rollback}`);
};

/** 実体へのリンクを張り直す。既に別のものがある位置は上書きしない。 */
export function link(name: string, kind: KindId, env: Env, registry: Registry): void {
  guard.assertValidName(name);
  const plan = planFor(name, kind, env, registry);

  const previous = new Map<string, string>();
  for (const path of plan.links) {
    if (!guard.isLink(path)) continue;
    guard.assertMutable(path, env, registry);
    const target = guard.linkTarget(path);
    if (target !== null) previous.set(path, target);
  }
  for (const path of plan.links) {
    if (!guard.isLink(path) && guard.exists(path) && !guard.isManagedLink(path, plan.store)) {
      throw new AgentToolError("ALREADY_EXISTS", `${path} already holds something else; not overwriting`);
    }
  }

  const changed: string[] = [];
  try {
    for (const path of plan.links) {
      guard.prepare(path, join(path, ".."), env.home);
      if (guard.exists(path) || guard.isLink(path)) guard.removeLink(path);
      guard.createLink(plan.store, path, plan.linkKind);
      changed.push(path);
    }
  } catch (error) {
    try {
      for (const path of changed) {
        if (guard.isManagedLink(path, plan.store)) guard.removeLink(path);
      }
      for (const [path, target] of previous) {
        if (!guard.exists(path)) guard.createLink(target, path, plan.linkKind);
      }
    } catch (rollback) {
      rollbackFailed(error, rollback);
    }
    throw error;
  }
}

/**
 * リンクと実体を消し、registry から外す。
 * ゴミ箱へは送らないので、呼び出し前に必ず確認ダイアログを出す（設計決定 D-5）。
 */
export function remove(name: string, kind: KindId, env: Env, registry: Registry,
                       place: Place = USER): void {
  guard.assertValidName(name);
  const plan = planFor(name, kind, env, registry, place);

  // 検査を全部先に済ませてから壊す。
  const links = plan.links.filter(path => guard.isManagedLink(path, plan.store) || guard.isLink(path));
  const bodies = guard.exists(plan.store) ? [plan.store] : [];
  if (bodies.length === 0) notFound(name);
  // リンクは必ず管理ストアを指す。実体はプロジェクトや取り込んだルートにもあるので
  // `assertBody` が信頼の根で振り分ける。
  for (const path of links) {
    if (place.scope === "project") guard.assertProjectArtifact(path, kind, place.path, env);
    else guard.assertMutable(path, env, registry);
  }
  for (const path of bodies) guard.assertBody(path, kind, env, registry, place);

  for (const path of links) guard.removeLink(path);
  for (const path of bodies) guard.remove(path);
  const project = place.scope === "project" ? place.path : undefined;
  registry.resources = registry.resources.filter(item =>
    !(item.name === name && item.kind === kind && item.project === project));
}

/**
 * 他のツールが入れた実体を消す。registry に載っていないので `assertMutable` は通らない。
 * 代わりに「既知ルート直下にあること」だけを条件にする（`assertUserArtifact`）。
 *
 * 同じ名前が複数のルートに現れる（実体 + 各エージェントへのリンク）ので、
 * 走査ホワイトリストの全ルートを見て一括で消す。消した位置を返す。
 *
 * Rule だけは例外で、同名でもエージェントごとに無関係な別ファイル。`agent` を
 * 渡してそのルートだけに絞る（D-20）。
 */
export function removeUnmanaged(name: string, kind: KindId, env: Env,
                                place: Place = USER, agent?: AgentId): string[] {
  guard.assertValidName(name);
  if (kind !== "skill" && kind !== "subagent" && kind !== "rule") {
    throw new AgentToolError("OPERATION_FAILED",
      `${kind} is managed by the agent, not by Agent Tool`);
  }
  // Rule はエージェントごとに拡張子が違う（Claude=.md、Cursor=.mdc）。ルートの末尾で
  // 見分ける — 絶対パスの途中に `.cursor` を含むだけのプロジェクトで切り替えない。
  const cursorRules = join(".cursor", "rules");
  const leafFor = (root: string): string =>
    kind === "skill" ? name
    : kind === "rule" && root.endsWith(cursorRules) ? `${name}.mdc`
    : `${name}.md`;
  const roots = place.scope === "project"
    ? guard.projectRoots(kind, place.path, agent)
    : guard.userRoots(kind, env, agent);
  // リンク切れは `exists` が false になるので、リンクかどうかも見る。
  const targets = roots
    .map(root => join(root, leafFor(root)))
    .filter(path => guard.exists(path) || guard.isLink(path));
  if (targets.length === 0) notFound(name);

  // 検査を全部先に済ませてから壊す。
  for (const path of targets) {
    if (place.scope === "project") guard.assertProjectArtifact(path, kind, place.path, env);
    else guard.assertUserArtifact(path, kind, env);
  }
  for (const path of targets) guard.remove(path);
  return targets;
}
