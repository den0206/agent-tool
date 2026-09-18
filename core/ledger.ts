import { DetectKind } from "./detect.js";
import { GitHubSource } from "./github.js";

/**
 * 取得元の台帳（設計決定 D-14）。ブラウザ拡張が書き、IDE 拡張が registry へ取り込んで消す。
 * エントリごとに 1 ファイルにして read-modify-write を避ける — ブラウザ拡張はロックを取れない。
 */
export type Ledger = {
  readonly name: string;
  readonly kind: DetectKind;
  readonly repo: string;
  readonly branch?: string;
  readonly subdir?: string;
  /** 導入時点の commit SHA。 */
  readonly sha?: string;
};

/** ルート直下のこのディレクトリに置く。走査は `.` 始まりを除くので誤検出されない。 */
export const LEDGER_DIR = ".agent-tool";

export const ledgerPath = (name: string): string => `${LEDGER_DIR}/${name}.json`;

/**
 * 台帳を組み立てる。`pinned` は利用者が IDE 拡張で決める状態なので持たない。
 * 実体ツリー hash も持たない（用途が違う。削除の可否判定はブラウザ拡張の収集一覧で行う）。
 */
export const ledger = (
  name: string, kind: DetectKind, source: GitHubSource, sha?: string,
): Ledger => ({
  name, kind, repo: source.repo,
  ...(source.branch === undefined ? {} : { branch: source.branch }),
  ...(source.subdir === undefined ? {} : { subdir: source.subdir }),
  ...(sha === undefined ? {} : { sha }),
});

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * 台帳を読む。壊れていれば `null` を返して黙って無視する — 取り込めないだけで、
 * 実体は走査で見つかるので利用者が失うものは無い。
 */
export function decode(raw: unknown): Ledger | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = str(record.name), repo = str(record.repo), kind = str(record.kind);
  if (name === undefined || repo === undefined) return null;
  if (kind !== "skill" && kind !== "subagent") return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return {
    name, kind, repo,
    ...(str(record.branch) === undefined ? {} : { branch: str(record.branch)! }),
    ...(str(record.subdir) === undefined ? {} : { subdir: str(record.subdir)! }),
    ...(str(record.sha) === undefined ? {} : { sha: str(record.sha)! }),
  };
}
