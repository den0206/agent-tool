import { join } from "node:path";
import { AgentId, KindId } from "../core/agent";
import { agentStore, claudeSkills, disabledAgentStore, disabledStore, Env, skillStore } from "./env";
import { AgentToolError } from "../core/errors";
import { entry, Entry, Registry, upsert } from "./registry";
import * as guard from "./writeGuard";

/**
 * 有効化・無効化・削除。
 *
 * 有効/無効は全エージェント一括。Cursor と Codex は `~/.agents/skills/` を直読みするので、
 * エージェント別の on/off は原理的に不可能。
 */
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
  /** 無効化したときの退避先。project は退避しないので持たない。 */
  readonly parked?: string;
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
 * 退避先だけは管理ストアのものを使う（プロジェクトと違い、退避先が要る）。
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
        parked: join(disabledAgentStore(env), `${name}.md`),
        links: [], linkKind: "file",
      };
    }
    return {
      store,
      parked: join(disabledAgentStore(env), `${name}.md`),
      // Subagent は共有ルートの慣習が無いのでリンクが 2 本要る。
      links: [join(env.home, ".claude", "agents", `${name}.md`),
              join(env.home, ".cursor", "agents", `${name}.md`)],
      linkKind: "file",
    };
  }
  if (recorded !== null && !guard.isSamePath(recorded, skillStore(env))) {
    return {
      store: join(recorded, name),
      parked: join(disabledStore(env), name),
      links: [], linkKind: "dir",
    };
  }
  return {
    store: join(skillStore(env), name),
    parked: join(disabledStore(env), name),
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

/** 有効化・無効化は退避先がある user だけ。プロジェクト内に隠し退避先を作らない。 */
const parkedOf = (plan: Layout, name: string): string => {
  if (plan.parked === undefined) {
    throw new AgentToolError("OPERATION_FAILED",
      `${name} belongs to the project; enable and disable are not available there`);
  }
  return plan.parked;
};

const notFound = (name: string): never => {
  throw new AgentToolError("NOT_FOUND", `${name} was not found`);
};

const rollbackFailed = (original: unknown, rollback: unknown): never => {
  throw new AgentToolError("OPERATION_FAILED",
    `the operation failed and the original state could not be fully restored: ${original}; ${rollback}`);
};

const entryFor = (registry: Registry, name: string, kind: KindId): Entry =>
  entry(registry, name, kind)
  ?? { name, kind, pinned: false, disabled: false };

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

/** 実体を置き場に戻し、リンクを張り直す。 */
export function enable(name: string, kind: KindId, env: Env, registry: Registry): void {
  guard.assertValidName(name);
  const plan = planFor(name, kind, env, registry);
  const parked = parkedOf(plan, name);
  const wasParked = !guard.exists(plan.store);

  if (wasParked) {
    if (!guard.exists(parked)) notFound(name);
    guard.assertMutable(parked, env, registry);
    // 戻す先も検査する。`plan.store` は registry の `root` から組むが、registry は
    // 利用者が手で書き換えられるファイルで、壊れていれば既知ルートの外を指しうる。
    // `disable` と `remove` が実体に掛けているのと同じ検査を、こちら側にも掛ける。
    guard.assertBody(plan.store, kind, env, registry, USER);
    guard.prepare(plan.store, join(plan.store, ".."),
      guard.isInside(plan.store, env.home) ? env.home : env.appSupport);
    guard.move(parked, plan.store);
  }
  try {
    link(name, kind, env, registry);
    upsert(registry, { ...entryFor(registry, name, kind), disabled: false });
  } catch (error) {
    try {
      for (const path of plan.links) {
        if (guard.isManagedLink(path, plan.store)) guard.removeLink(path);
      }
      if (wasParked && guard.exists(plan.store) && !guard.exists(parked)) {
        guard.move(plan.store, parked);
      }
    } catch (rollback) {
      rollbackFailed(error, rollback);
    }
    throw error;
  }
}

/**
 * リンクを外し、実体を退避ディレクトリへ移す。実体は消さない。
 *
 * 前提の検査を全部先に済ませてから壊す。破壊の順序は実体の退避 → リンクの解除。
 * 逆にすると、途中で失敗したときに「リンクが無いだけ」の見えない状態が残る。
 * この順なら残るのはリンク切れで、一覧が「読み込めません」として拾える。
 */
export function disable(name: string, kind: KindId, env: Env, registry: Registry): void {
  guard.assertValidName(name);
  const plan = planFor(name, kind, env, registry);
  const parked = parkedOf(plan, name);

  if (!guard.exists(plan.store)) notFound(name);
  // 実体は管理ストアの外にあることがある（取り込んだ分）。信頼の根で振り分ける。
  guard.assertBody(plan.store, kind, env, registry, USER);
  if (guard.exists(parked)) {
    throw new AgentToolError("ALREADY_EXISTS", `${parked} already holds something else; not overwriting`);
  }
  const links = plan.links.filter(path => guard.isManagedLink(path, plan.store));
  for (const path of links) guard.assertMutable(path, env, registry);

  try {
    guard.prepare(parked, join(parked, ".."),
      guard.isInside(parked, env.home) ? env.home : env.appSupport);
    guard.move(plan.store, parked);
    for (const path of links) guard.removeLink(path);
    upsert(registry, { ...entryFor(registry, name, kind), disabled: true });
  } catch (error) {
    try {
      if (guard.exists(parked) && !guard.exists(plan.store)) {
        guard.move(parked, plan.store);
      }
      for (const path of links) {
        if (!guard.exists(path)) guard.createLink(plan.store, path, plan.linkKind);
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

  // `disable` と同じ理由で、検査を全部先に済ませてから壊す。
  const links = plan.links.filter(path => guard.isManagedLink(path, plan.store) || guard.isLink(path));
  const bodies = [plan.store, plan.parked]
    .filter((path): path is string => path !== undefined && guard.exists(path));
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

  // `disable` と同じ理由で、検査を全部先に済ませてから壊す。
  for (const path of targets) {
    if (place.scope === "project") guard.assertProjectArtifact(path, kind, place.path, env);
    else guard.assertUserArtifact(path, kind, env);
  }
  for (const path of targets) guard.remove(path);
  return targets;
}
