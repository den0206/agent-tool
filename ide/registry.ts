import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AgentId, AGENT_IDS, KindId } from "../core/agent";
import { Env, registryFile } from "./env";
import { AgentToolError } from "../core/errors";
import { str } from "../core/json";

export const SCHEMA_VERSION = "1";
export const REGISTRY_SIZE_LIMIT = 2 * 1024 * 1024;

export type Entry = {
  name: string;
  kind: KindId;
  repo?: string;
  branch?: string;
  subdir?: string;
  sha?: string;
  /** 上流が方針転換したときに更新を止める。 */
  pinned: boolean;
  /** project スコープで入れたプロジェクトの絶対パス。未設定は user スコープ。 */
  project?: string;
  /**
   * 実体があるルート（ホーム相対、`/` 区切り）。未設定は管理ストア（`layout` の既定）。
   *
   * ブラウザ拡張は自分が許可されたルート（`~/.claude/skills` など）へ直接書くので、
   * 取り込んだ entry の実体は管理ストアに無い。ここを持たないと `layout` が
   * `~/.agents/skills/<name>` を指し、削除が実体を見失い、更新適用は
   * 別の場所に新版を書いて実体を二重化する。
   */
  root?: string;
};

export type RepoState = { etag?: string; latestSha?: string; checkedAt?: string };
/** 保存してよいのは利用者が決めたことだけ。自動検出できるものは持たない。 */
export type AgentSetting = { path?: string };

export type Registry = {
  schemaVersion: string;
  resources: Entry[];
  repos: Record<string, RepoState>;
  agents: Partial<Record<AgentId, AgentSetting>>;
};

export const empty = (): Registry => ({
  schemaVersion: SCHEMA_VERSION,
  resources: [], repos: {}, agents: {},
});

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

/**
 * 欠けているキーは既定値で埋める。1 つ足りないだけで失敗させると、
 * 導入済みリソースの取得元がまとめて失われる。フィールドは今後も増える。
 */
export function decode(raw: unknown): Registry {
  const root = obj(raw);
  // 文字列でも数値でも来る。`str()` を通すと数値の 2 が「書かれていない」になり、
  // 数として比べないと `"10" > "2"` が false になる。どちらも未来の schema を読めると
  // 誤判定し、decode が未知のフィールドを落とした registry を書き戻す。
  const version = root.schemaVersion ?? SCHEMA_VERSION;
  const known = (typeof version === "string" || typeof version === "number")
    && Number(version) <= Number(SCHEMA_VERSION);
  if (!known) {
    throw new AgentToolError("SCHEMA_UNSUPPORTED",
      `registry.json uses schema ${String(version)}; update Agent Tool to read it`);
  }
  const agents: Partial<Record<AgentId, AgentSetting>> = {};
  for (const [key, value] of Object.entries(obj(root.agents))) {
    if (!(AGENT_IDS as readonly string[]).includes(key)) continue;
    agents[key as AgentId] = { path: str(obj(value).path) };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    resources: arr(root.resources).map(obj).flatMap(entry => {
      const name = str(entry.name), kind = str(entry.kind);
      if (!name || !kind) return [];
      return [{
        name, kind: kind as KindId,
        repo: str(entry.repo), branch: str(entry.branch),
        subdir: str(entry.subdir), sha: str(entry.sha),
        pinned: entry.pinned === true,
        project: str(entry.project),
        root: str(entry.root),
      }];
    }),
    repos: Object.fromEntries(Object.entries(obj(root.repos)).map(([key, value]) => {
      const state = obj(value);
      return [key, { etag: str(state.etag), latestSha: str(state.latestSha), checkedAt: str(state.checkedAt) }];
    })),
    agents,
  };
}

/** 既定値と変わらないフィールドは書き出さない。キーはソートして diff を読みやすくする。 */
function encode(registry: Registry): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value !== "object" || value === null) return value;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== false)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return Object.fromEntries(entries.map(([k, v]) => [k, sort(v)]));
  };
  return JSON.stringify(sort(registry), null, 2) + "\n";
}

export function load(env: Env): Registry {
  try {
    return read(env);
  } catch {
    return empty();
  }
}

/**
 * `load` と違い壊れていたら投げる。`load` は既定値で握り潰すので、
 * そのまま保存すると利用者の全リソースの出所情報を空で上書きしてしまう。
 */
export function read(env: Env): Registry {
  let raw: string;
  try {
    if (statSync(registryFile(env)).size > REGISTRY_SIZE_LIMIT) {
      throw new AgentToolError("OPERATION_FAILED", "registry.json is too large to read (limit 2 MB)");
    }
    raw = readFileSync(registryFile(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
  return decode(JSON.parse(raw));
}

/**
 * 壊れた registry.json の上で破壊的操作を始めない。実体を移動・削除した後で
 * 保存が落ちると、ファイルは動いたのに registry には残る食い違いになる。先に落とす。
 */
export const assertReadable = (env: Env): void => void read(env);

/** アトミックに書く。書き込み中のクラッシュで全リソースの出所情報を失わないため。 */
function write(env: Env, registry: Registry): void {
  mkdirSync(env.appSupport, { recursive: true });
  const destination = registryFile(env);
  const temporary = destination + ".tmp";
  const body = encode(registry);
  if (Buffer.byteLength(body) > REGISTRY_SIZE_LIMIT) {
    throw new AgentToolError("OPERATION_FAILED", "registry.json is too large to save (limit 2 MB)");
  }
  writeFileSync(temporary, body);
  renameSync(temporary, destination);
}

const STALE_LOCK_MS = 30_000;
/**
 * PID が生きていても、これを超えたロックは回収する。PID は再利用されるので、
 * 生死だけで判断すると無関係なプロセスが番号を拾った時点で書き込みが永久に止まり、
 * 利用者に `registry.lock` の手動削除しか残らない。展開上限（200 MB）のコピーが
 * この時間に届くことはないので、作業中の保持者から奪う心配はない。
 */
const ABANDONED_LOCK_MS = 10 * 60_000;

/**
 * 保持者が居なくなったロックか。導入の実体コピーは同期（`cpSync`）でイベントループを
 * 止めるため、経過時間だけで回収すると作業中の保持者から奪って 2 プロセスが同時に書き込む。
 * PID を書く前に落ちた場合と旧版が残したロックのためだけに、mtime を残す。
 */
function abandoned(lockPath: string): boolean {
  const held = Date.now() - statSync(lockPath).mtimeMs;
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return held > STALE_LOCK_MS;
  // シグナル 0 は存在確認だけを行う。EPERM は他ユーザーのプロセスで、生きている。
  try { process.kill(pid, 0); return held > ABANDONED_LOCK_MS; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/**
 * プロセス間の排他。`wx`（`O_CREAT | O_EXCL`）による原子的生成は 3 OS で同一に動く。
 * `flock` や `proper-lockfile` は Windows での挙動差を避けるため使わない。
 */
export async function withRegistryLock<T>(env: Env, body: () => Promise<T> | T): Promise<T> {
  mkdirSync(env.appSupport, { recursive: true });
  const lockPath = join(env.appSupport, "registry.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      // 誰が持っているかを書く。回収の判断に使うので、作成と同じ try の中で書き切る。
      const descriptor = openSync(lockPath, "wx");
      try { writeSync(descriptor, String(process.pid)); } finally { closeSync(descriptor); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // クラッシュで残ったロックは回収する。生きた保持者からは奪わない。
      try {
        if (abandoned(lockPath)) { unlinkSync(lockPath); continue; }
      } catch { /* 直前に他プロセスが解放した */ }
      if (Date.now() >= deadline) {
        throw new AgentToolError("LOCK_TIMEOUT",
          "the write lock could not be acquired; another window may be making changes");
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await body();
  } finally {
    try { unlinkSync(lockPath); } catch { /* 既に無ければよい */ }
  }
}

/** read-modify-write を 1 つの排他区間にまとめる。 */
export function update(env: Env, change: (registry: Registry) => void | Promise<void>): Promise<Registry> {
  return withRegistryLock(env, async () => {
    const registry = read(env);
    await change(registry);
    write(env, registry);
    return registry;
  });
}

export const save = (env: Env, registry: Registry): Promise<Registry> =>
  withRegistryLock(env, () => {
    assertReadable(env);
    write(env, registry);
    return registry;
  });

/**
 * 同じ名前・種別が user と project の両方にありうる。`project` まで一致を見ないと、
 * プロジェクトのものを消したつもりで user のものを消す。
 */
const same = (e: Entry, name: string, kind: KindId | undefined, project?: string): boolean =>
  e.name === name && (kind === undefined || e.kind === kind) && e.project === project;

export const entry = (registry: Registry, name: string, kind?: KindId, project?: string):
  Entry | undefined => registry.resources.find(e => same(e, name, kind, project));

export function upsert(registry: Registry, value: Entry): void {
  const index = registry.resources.findIndex(e => same(e, value.name, value.kind, value.project));
  if (index >= 0) registry.resources[index] = value;
  else registry.resources.push(value);
}

/** 手動指定された CLI パスだけを取り出す。 */
export function cliOverrides(registry: Registry): Partial<Record<AgentId, string>> {
  const out: Partial<Record<AgentId, string>> = {};
  for (const agent of AGENT_IDS) {
    const path = registry.agents[agent]?.path;
    if (path) out[agent] = path;
  }
  return out;
}
