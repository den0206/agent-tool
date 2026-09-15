import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { KindId } from "../core/agent";
import { Env } from "./env";
import { AgentToolError } from "../core/errors";
import { Candidate, discard, stage, Staging } from "./fetcher";
import { DEFAULT_REF, GitHubSource, sourceKey } from "../core/github";
import { Entry, Registry, update as updateRegistry, upsert } from "./registry";
import { layout, Place, USER } from "./skillManager";
import * as guard from "./writeGuard";

/** Diff Editor に渡す 1 ファイル分。 */
export type UpdateDiff = {
  readonly currentSha: string | null;
  readonly latestSha: string;
  readonly files: { path: string; before: string; after: string }[];
  readonly summary: {
    added: number;
    removed: number;
    changed: number;
    manifestChanged: boolean;
    omitted: boolean;
  };
};

/** 差分に載せる 1 ファイルの上限。これを超えるものは要約だけ出す。 */
export const DIFF_TEXT_LIMIT = 256 * 1024;
/** 差分画面へ一度に渡す本文の総量。1 ファイルの上限だけでは常駐メモリを守れない。 */
export const DIFF_TOTAL_LIMIT = 2 * 1024 * 1024;
export const DIFF_FILE_LIMIT = 10_000;
export const API_RESPONSE_LIMIT = 2 * 1024 * 1024;

export type Http = (url: string, headers: Record<string, string>) =>
  Promise<{ status: number; body: string; headers: Record<string, string> }>;

export async function readLimitedText(body: AsyncIterable<Uint8Array> | null,
                                      limit: number): Promise<string> {
  if (body === null) throw new AgentToolError("FETCH_FAILED", "GitHub returned an empty response");
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new AgentToolError("FETCH_FAILED", "GitHub response is too large to read");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const defaultHttp: Http = async (url, headers) => {
  const response = await fetch(url, { headers, cache: "no-store" });
  return {
    status: response.status,
    body: await readLimitedText(response.body as unknown as AsyncIterable<Uint8Array> | null,
      API_RESPONSE_LIMIT),
    headers: Object.fromEntries(response.headers),
  };
};

export const repoKey = (entry: Entry): string | null =>
  entry.repo === undefined ? null : sourceKey({ repo: entry.repo, branch: entry.branch });

/**
 * 最新のコミット SHA を引く。取得と適用で同じ revision を掴むために使う。
 * ブランチ未指定は `HEAD` で引く。既定ブランチ名は推測しない（`DEFAULT_REF`）。
 */
export async function resolveSha(source: GitHubSource, http: Http = defaultHttp): Promise<string> {
  const branch = source.branch === undefined ? DEFAULT_REF : encodeURIComponent(source.branch);
  const result = await http(`https://api.github.com/repos/${source.repo}/commits/${branch}`,
    { Accept: "application/vnd.github+json" });
  if (result.status === 403 || result.status === 429) {
    throw new AgentToolError("FETCH_FAILED", "GitHub rate limit reached; try again later");
  }
  if (result.status === 404) {
    throw new AgentToolError("NOT_FOUND", `${sourceKey(source)} was not found`);
  }
  if (result.status !== 200) {
    throw new AgentToolError("FETCH_FAILED", `GitHub responded with HTTP ${result.status}`);
  }
  const sha = (JSON.parse(result.body) as { sha?: unknown }).sha;
  if (typeof sha !== "string" || sha === "") {
    throw new AgentToolError("FETCH_FAILED", "the GitHub response did not contain a commit SHA");
  }
  return sha;
}

function managedEntry(registry: Registry, name: string, kind: KindId, project?: string): Entry {
  const entry = registry.resources.find(item =>
    item.name === name && item.kind === kind && item.project === project);
  if (!entry || entry.repo === undefined) {
    throw new AgentToolError("NOT_IN_REGISTRY", `${name} has no known source, so it cannot be updated`);
  }
  if (entry.pinned) throw new AgentToolError("OPERATION_FAILED", `${name} is pinned`);
  return entry;
}

/**
 * 取得と適用は同じ revision を掴む。
 * 先に確認済みの SHA があればそれを、無ければ今の HEAD を解決して固定する。
 */
async function stageEntry(entry: Entry, registry: Registry, options: {
  http?: Http; fetchImpl?: typeof fetch;
}): Promise<{ staging: Staging; candidate: Candidate; sha: string }> {
  const source: GitHubSource = { repo: entry.repo!, branch: entry.branch, subdir: entry.subdir };
  const key = repoKey(entry);
  const sha = (key === null ? undefined : registry.repos[key]?.latestSha)
    ?? await resolveSha(source, options.http ?? defaultHttp);
  const staging = await stage(source, { resolvedSha: sha, fetchImpl: options.fetchImpl });
  const candidate = staging.candidates.find(item => item.name === entry.name && item.kind === entry.kind);
  if (!candidate) {
    discard(staging);
    throw new AgentToolError("NOT_FOUND", `${entry.name} was not found in the fetched archive`);
  }
  return { staging, candidate, sha };
}

/** registry の `project` が実体の置き場を決める。未設定なら user。 */
const placeOf = (entry: Entry): Place =>
  entry.project === undefined ? USER : { scope: "project", path: entry.project };

const destinationFor = (entry: Entry, env: Env): string => {
  // `root` を渡さないと、取り込んだ実体（`~/.claude/skills` など）の隣ではなく
  // 管理ストアへ新版を書き、実体が 2 つになる。
  const plan = layout(entry.name, entry.kind, env, placeOf(entry), entry.root);
  // project は退避先を持たないので、実体はつねに置き場にある。
  return entry.disabled && plan.parked !== undefined ? plan.parked : plan.store;
};

/** 実体の相対パスを集める。ディレクトリでなければそれ自身だけ。 */
function files(root: string): { paths: string[]; truncated: boolean } {
  try {
    if (!statSync(root).isDirectory()) return { paths: [""], truncated: false };
  } catch {
    return { paths: [], truncated: false };
  }
  const paths: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (item.isSymbolicLink()) continue;
      if (paths.length >= DIFF_FILE_LIMIT) { truncated = true; return; }
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else paths.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return { paths, truncated };
}

const readText = (path: string): string => {
  try {
    if (statSync(path).size > DIFF_TEXT_LIMIT) return "[file too large to show]";
    const text = readFileSync(path, "utf8");
    return text.includes("\0") ? "[binary file]" : text;
  } catch {
    return "";
  }
};

function diff(current: string, candidate: string, name: string): Pick<UpdateDiff, "files" | "summary"> {
  const beforeFiles = files(current);
  const afterFiles = files(candidate);
  const beforePaths = new Set(beforeFiles.paths);
  const afterPaths = new Set(afterFiles.paths);
  const paths = [...new Set([...beforeFiles.paths, ...afterFiles.paths])].sort();
  const result: UpdateDiff["files"] = [];
  const summary = { added: 0, removed: 0, changed: 0, manifestChanged: false, omitted: false };
  let total = 0;
  let omitted = 0;
  const at = (root: string, path: string): string => path === "" ? root : join(root, path);
  for (const path of paths) {
    const beforeExists = beforePaths.has(path);
    const afterExists = afterPaths.has(path);
    const before = readText(at(current, path));
    const after = readText(at(candidate, path));
    if (beforeExists && afterExists && before === after) continue;
    if (!beforeExists) summary.added += 1;
    else if (!afterExists) summary.removed += 1;
    else summary.changed += 1;
    if (/(^|\/)(package\.json|gemini-extension\.json|plugin\.json)$/.test(path)) {
      summary.manifestChanged = true;
    }
    const size = Buffer.byteLength(before) + Buffer.byteLength(after);
    if (total + size > DIFF_TOTAL_LIMIT) { omitted += 1; continue; }
    total += size;
    result.push({ path: path === "" ? name : path, before, after });
  }
  const reasons = [
    ...(omitted > 0 ? [`${omitted} file(s) did not fit in the 2 MB diff budget`] : []),
    ...(beforeFiles.truncated || afterFiles.truncated
      ? ["more than 10,000 files; the rest were not scanned"] : []),
  ];
  if (reasons.length > 0) result.push({
    path: "[additional changes omitted]", before: "", after: reasons.join("\n"),
  });
  summary.omitted = omitted > 0 || beforeFiles.truncated || afterFiles.truncated;
  return { files: result, summary };
}

export function diffFiles(current: string, candidate: string, name: string): UpdateDiff["files"] {
  return diff(current, candidate, name).files;
}

export function diffSummary(current: string, candidate: string, name: string): UpdateDiff["summary"] {
  return diff(current, candidate, name).summary;
}

/**
 * 更新差分。返した本文は Diff Editor へ渡し、Editor を閉じたら破棄する。
 * 一時展開はこの関数の中で片付ける — 適用は同じ SHA を掴み直して取り直す。
 */
export async function updatePreview(params: {
  env: Env; registry: Registry; name: string; kind: KindId; project?: string;
  http?: Http; fetchImpl?: typeof fetch;
}): Promise<UpdateDiff> {
  const entry = managedEntry(params.registry, params.name, params.kind, params.project);
  const { staging, candidate, sha } = await stageEntry(entry, params.registry, params);
  try {
    const current = destinationFor(entry, params.env);
    return {
      currentSha: entry.sha ?? null,
      latestSha: sha,
      ...diff(current, candidate.localPath, entry.name),
    };
  } finally {
    discard(staging);
  }
}

/**
 * 更新を適用する。適用中に失敗したら同じ呼び出しの中で元へ戻す。
 * 復元にも失敗したときは控えを消さない — 旧実体はそこにしか残っていない。
 */
export async function updateApply(params: {
  env: Env; registry: Registry; name: string; kind: KindId; project?: string;
  http?: Http; fetchImpl?: typeof fetch;
}): Promise<{ appliedSha: string }> {
  const { env } = params;
  const entry = managedEntry(params.registry, params.name, params.kind, params.project);
  const { staging, candidate, sha } = await stageEntry(entry, params.registry, params);
  const destination = destinationFor(entry, env);
  const backup = join(staging.root, "previous");
  // 復元に失敗したときだけ一時領域を残す。旧実体はそこにしか無い。
  let keepBackup = false;

  try {
    // プロジェクトの実体も、取り込んだ実体も、ホームの管理ルートの外にある。
    // 信頼の根が違うので `assertBody` に振り分けさせる。
    const place = placeOf(entry);
    guard.assertBody(destination, entry.kind, env, params.registry, place);
    guard.prepare(destination, join(destination, ".."), place.scope === "project" ? place.path
      : guard.isInside(destination, env.home) ? env.home : env.appSupport);

    const hadExisting = guard.exists(destination);
    try {
      if (hadExisting) guard.move(destination, backup);
      guard.copy(candidate.localPath, destination);
      await updateRegistry(env, latest => {
        const current = latest.resources.find(item =>
          item.name === entry.name && item.kind === entry.kind && item.project === entry.project);
        if (!current) throw new AgentToolError("NOT_IN_REGISTRY", `${entry.name} is no longer managed`);
        if (current.pinned) throw new AgentToolError("OPERATION_FAILED", `${entry.name} is pinned`);
        upsert(latest, { ...current, sha });
      });
      upsert(params.registry, { ...entry, sha });
    } catch (error) {
      try {
        if (guard.exists(destination)) guard.remove(destination);
        if (hadExisting) guard.move(backup, destination);
      } catch (rollback) {
        // 控えは消さない。ここで畳むと戻す手段が一つも残らない。
        keepBackup = true;
        throw new AgentToolError("OPERATION_FAILED",
          `the update failed and the original could not be restored: ${error}; ${rollback}. `
          + `The previous copy is kept at ${backup}`);
      }
      throw error;
    }
    return { appliedSha: sha };
  } finally {
    if (!keepBackup) discard(staging);
  }
}
