import { CATALOG_SITES } from "../core/github.js";

/**
 * 自動検知を許可する単位。**利用者が開いている origin ちょうど 1 つ**にする。
 *
 * `https:` だけを受ける。manifest の `optional_host_permissions` は https 全体なので、
 * それ以外の scheme はそもそも要求できない（localhost の http も例外にしない —
 * 配布物に test 専用の host permission を混ぜないため）。
 *
 * サブドメインへ広げない。`*.example.com` へのワイルドカードを作ると、
 * 利用者が見たことのないホストまで巻き込む。
 */
export function originPattern(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname === "") return null;
  // match pattern はポートを表せない。落とすと別アプリまで許可してしまうため拒否する。
  if (parsed.port !== "") return null;
  // `hostname` は小文字化済み。
  return `https://${parsed.hostname}/*`;
}

/** `https://example.com` + `/*` の pattern から `example.com` を出す。`hostEquals` に入る形。 */
export const patternHost = (pattern: string): string | null =>
  pattern.match(/^https:\/\/([^/*:]+)\/\*$/)?.[1] ?? null;

/**
 * 利用者が自分で許可したサイトだけを残す。`permissions.getAll()` には manifest の
 * `host_permissions`（github.com / 対応カタログ / API ホスト）も混ざるが、それらは
 * 既存の決定論的経路のものなので Allowed Sites に出さないし、自動検知の対象にもしない。
 *
 * 除外の基準は `CATALOG_SITES` を正本にする — ここに第二の一覧を置くと、
 * 対応サイトを増やしたときに片方だけ古くなる。
 */
export function grantedSites(origins: readonly string[]): string[] {
  const builtin = new Set<string>(["github.com", "api.github.com", "raw.githubusercontent.com",
                                   "codeload.github.com", "api.typesafe.ai"]);
  for (const site of CATALOG_SITES) { builtin.add(site.host); builtin.add(`www.${site.host}`); }
  const sites = new Set<string>();
  for (const origin of origins) {
    const host = patternHost(origin);
    if (host !== null && !builtin.has(host)) sites.add(origin);
  }
  return [...sites].sort();
}
