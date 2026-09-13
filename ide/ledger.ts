import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { KindId } from "../core/agent";
import { decode as decodeLedger, Ledger, LEDGER_DIR } from "../core/ledger";
import { SINGLE_FILE_LIMIT } from "../core/limits";
import { Env } from "./env";
import { entry, Entry, Registry, upsert } from "./registry";
import { relativePath, SKILL_SOURCES, SUBAGENT_SOURCES, sourcePath } from "./source";
import { removeLedger } from "./writeGuard";

/**
 * ブラウザ拡張が残した取得元の台帳を registry へ取り込む（設計決定 D-14）。
 * 取り込めば、既存の削除・無効化・更新検知がそのまま働く。
 *
 * 読むのは走査ホワイトリストのルート直下の `.agent-tool` だけで、ここから
 * ホームやワークスペースへ広がることはない。
 */
export type Found = { readonly root: string; readonly file: string; readonly ledger: Ledger };

/** 台帳の 1 ファイルは小さい。単一ファイルの上限をそのまま使う。 */
const readLedger = (file: string): Ledger | null => {
  try {
    if (statSync(file).size > SINGLE_FILE_LIMIT) return null;
    return decodeLedger(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;                                 // 壊れていれば黙って無視する
  }
};

export function scan(env: Env): Found[] {
  const found: Found[] = [];
  for (const source of [...SKILL_SOURCES, ...SUBAGENT_SOURCES]) {
    const root = sourcePath(source, env);
    if (root === null || relativePath(source) === null) continue;
    const dir = join(root, LEDGER_DIR);
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;                                  // 台帳が無いルートが普通
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const ledger = readLedger(join(dir, name));
      // ファイル名と中の name がずれている台帳は信用しない。
      if (ledger === null || `${ledger.name}.json` !== name) continue;
      // 実体の無い台帳は取り込まない。取り込むと、存在しないものの entry を作っては
      // `prune` が消す往復が走査のたびに起きる。書き込みが途中で失敗すると残りうる。
      if (!existsSync(join(root, ledger.name)) && !existsSync(join(root, `${ledger.name}.md`))) {
        continue;
      }
      found.push({ root, file: join(dir, name), ledger });
    }
  }
  return found;
}

/**
 * 実体があるルートをホーム相対（`/` 区切り）で返す。ホームの外なら `undefined` —
 * 管理ストア（`appSupport` 配下）に在るものは `layout` の既定がそのまま正しい。
 */
export const homeRelativeRoot = (env: Env, root: string): string | undefined => {
  const rel = relative(env.home, root);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
};

const toEntry = (ledger: Ledger, root: string | undefined): Entry => ({
  name: ledger.name, kind: ledger.kind as KindId,
  repo: ledger.repo,
  ...(ledger.branch === undefined ? {} : { branch: ledger.branch }),
  ...(ledger.subdir === undefined ? {} : { subdir: ledger.subdir }),
  ...(ledger.sha === undefined ? {} : { sha: ledger.sha }),
  ...(root === undefined ? {} : { root }),
  pinned: false, disabled: false,
});

/**
 * registry へ足して台帳を消す。呼び出し側がロックの中で呼ぶ。
 * 台帳の削除に失敗しても registry の更新は残す — 次回に同じものを入れ直すだけで害はない。
 *
 * 実体のあるルートまで記録する。持たないと `layout` が管理ストアを指し、削除・無効化が
 * 実体を見失い、更新適用は別の場所へ新版を書いて実体を二重化する。
 */
export function absorb(env: Env, registry: Registry, found: readonly Found[]): void {
  for (const item of found) {
    const kind = item.ledger.kind as KindId;
    // `pinned` は利用者が決めたこと。入れ直しで黙って解除しない。
    const pinned = entry(registry, item.ledger.name, kind)?.pinned === true;
    upsert(registry, { ...toEntry(item.ledger, homeRelativeRoot(env, item.root)), pinned });
    try {
      removeLedger(item.file, item.root, env);
    } catch {
      /* 消せなくても取り込みは済んでいる。次回の走査でもう一度上書きする */
    }
  }
}

export const key = (name: string, kind: KindId, project?: string): string =>
  `${name} ${kind} ${project ?? ""}`;

/**
 * 実体を失った entry を落とす（設計決定 D-15）。
 * 照合するのは今回走査できたルートに属する entry だけにする。開いていない
 * プロジェクトの entry を巻き込んで消さないための条件である。
 */
export function prune(registry: Registry, params: {
  /** 今回の走査で見つかった `name kind project` の集合。 */
  readonly seen: ReadonlySet<string>;
  /** user スコープを走査したか。他プロジェクト欄では false になる。 */
  readonly scannedUser: boolean;
  /** 走査したプロジェクトの絶対パス。開いていなければ null。 */
  readonly scannedProject: string | null;
}): void {
  registry.resources = registry.resources.filter(item => {
    const scanned = item.project === undefined
      ? params.scannedUser
      : item.project === params.scannedProject;
    if (!scanned) return true;
    return params.seen.has(key(item.name, item.kind, item.project));
  });
}
