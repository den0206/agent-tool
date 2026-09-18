import { join } from "node:path";
import { Env } from "./env";
import { AgentToolError } from "../core/errors";
import { Candidate, Staging } from "./fetcher";
import { entry, Registry, upsert } from "./registry";
import { layout, link, Place, USER } from "./skillManager";
import * as guard from "./writeGuard";

/** 取得物が staging の外を指していないか。展開時の検査に対する二重チェック。 */
function assertStaged(candidate: Candidate, staging: Staging): void {
  if (guard.isLink(candidate.localPath)
    || !guard.isInside(candidate.localPath, staging.root)
    || !guard.exists(candidate.localPath)) {
    throw new AgentToolError("FETCH_FAILED", "the fetched item points outside the staging area");
  }
}

/**
 * 確認画面で選ばれた候補を実際に入れる。
 * 実体を置き場に置き、registry に記録し、各エージェント用のリンクを張る。
 */
export function install(candidate: Candidate, staging: Staging, env: Env, registry: Registry,
                        place: Place = USER): void {
  if (candidate.kind !== "skill" && candidate.kind !== "subagent") {
    throw new AgentToolError("OPERATION_FAILED", `adding a ${candidate.kind} is not supported here`);
  }
  // 作成もガードを通す。`assertMutable` は削除・移動しか守らないので、
  // ここを素通しにすると取得先の名乗り 1 つで管理ルートの外へ書ける。
  guard.assertValidName(candidate.name);
  assertStaged(candidate, staging);

  const project = place.scope === "project" ? place.path : undefined;
  const plan = layout(candidate.name, candidate.kind, env, place);
  if (guard.exists(plan.store)) {
    throw new AgentToolError("ALREADY_EXISTS", `${candidate.name} is already installed`);
  }
  // 取り込んだ entry は実体が管理ストアの外にある。`plan.store` の不在だけで判断すると、
  // 同じものを別の場所にもう 1 つ作ってしまう。
  if (entry(registry, candidate.name, candidate.kind, project)?.root !== undefined) {
    throw new AgentToolError("ALREADY_EXISTS", `${candidate.name} is already installed`);
  }

  // プロジェクトへ入れるときの信頼の根はワークスペース。ホームの管理ルートではない。
  const anchor = place.scope === "project" ? place.path
    : guard.isInside(plan.store, env.home) ? env.home : env.appSupport;
  guard.prepare(plan.store, join(plan.store, ".."), anchor);
  try {
    guard.copy(candidate.localPath, plan.store);
  } catch (error) {
    if (guard.exists(plan.store)) guard.remove(plan.store);
    throw error;
  }

  const before = registry.resources.slice();
  upsert(registry, {
    name: candidate.name,
    kind: candidate.kind,
    repo: staging.source.repo,
    branch: staging.source.branch,
    subdir: staging.source.subdir,
    sha: staging.resolvedSha,
    pinned: false,
    project,
  });
  try {
    // プロジェクトの実体は一覧が読む場所にそのまま置くので、リンクは張らない。
    if (place.scope === "user") link(candidate.name, candidate.kind, env, registry);
  } catch (error) {
    registry.resources = before;
    for (const path of plan.links) {
      if (guard.isManagedLink(path, plan.store)) guard.removeLink(path);
    }
    guard.remove(plan.store);
    throw error;
  }
}
