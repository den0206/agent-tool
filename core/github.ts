/** 取得元。`git clone` は使わず zipball を落とす。 */
export type GitHubSource = {
  readonly repo: string;        // "owner/name"
  readonly branch?: string;     // 未指定 = 既定ブランチ
  readonly subdir?: string;     // 未指定 = リポジトリ直下
  /**
   * ブランチ名に "/" を含む可能性があり、branch と subdir の境界が確定できない。
   * `tree/feature/x/skills/foo` は `feature/x` + `skills/foo` とも
   * `feature` + `x/skills/foo` とも読める。確認画面で直せるようにする。
   */
  readonly branchAmbiguous?: boolean;
};

/**
 * ブランチ未指定のときに使う ref。**既定ブランチ名は推測しない** —
 * `main` と決め打つと既定ブランチが `master` のリポジトリは取得も更新確認もできない。
 * `HEAD` は zipball・API・raw のどこでもリポジトリの既定ブランチに解決する。
 */
export const DEFAULT_REF = "HEAD";

export function archiveUrl(source: GitHubSource, revision?: string): string {
  const reference = revision
    ?? (source.branch === undefined ? DEFAULT_REF : `refs/heads/${source.branch}`);
  return `https://github.com/${source.repo}/archive/${reference}.zip`;
}

/** ブラウザ拡張へ渡す、取得元の Skill ディレクトリ URL。 */
export function sourcePageUrl(source: GitHubSource): string {
  const suffix = source.subdir === undefined ? "" : `/${source.subdir}`;
  return `https://github.com/${source.repo}/tree/${source.branch ?? DEFAULT_REF}${suffix}`;
}

/**
 * `registry.repos` のキー。`checkUpdates` が書き、`hasUpdate` と更新適用が読む。
 * 3 か所で組み立てるとズレて更新が永久に出なくなるので、ここだけに置く。
 */
export const sourceKey = (source: { repo: string; branch?: string }): string =>
  `${source.repo}#${source.branch ?? DEFAULT_REF}`;

/** `owner/name` として妥当か。パス要素として使う前に必ず通す。 */
const isRepoPath = (owner: string, name: string): boolean =>
  /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name)
  && !owner.startsWith(".") && !name.startsWith(".");

function toUrl(raw: string, hosts: string[]): URL | null {
  let text = raw.trim();
  if (hosts.some(host => text.startsWith(host + "/") || text.startsWith(`www.${host}/`))) {
    text = "https://" + text;                       // スキーム省略を受ける
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!hosts.includes(host)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

/** URL を repo / branch / それ以降のパスに割る。同じ解釈を 2 か所に書かない。 */
export type Components = {
  readonly repo: string;
  readonly branch?: string;
  /** ブランチより後ろの全セグメント。blob ならファイル名を含む。 */
  readonly path: string[];
  readonly isFile: boolean;
};

export function components(raw: string): Components | null {
  const url = toUrl(raw, ["github.com"]);
  if (url === null) return null;

  const parts = url.pathname.split("/").filter(part => part !== "");
  if (parts.length < 2) return null;
  const [owner, rawName, ...rest] = parts;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!isRepoPath(owner, name)) return null;
  const repo = `${owner}/${name}`;

  const marker = rest[0];
  if (marker !== "tree" && marker !== "blob") {
    // /issues や /pulls はリポジトリの指定ではない。
    return rest.length === 0 ? { repo, path: [], isFile: false } : null;
  }
  const reference = rest.slice(1);
  if (reference.length === 0) return { repo, path: [], isFile: false };
  // `/blob/` でも、パスの末尾に拡張子が無ければディレクトリを指している。GitHub は
  // `/blob/<ref>/<ディレクトリ>` を `/tree/` の表示へ読み替えるので、そのまま案内して
  // いるサイトがある（実測: aitmpl.com は Skill ディレクトリを `/blob/` で出す）。
  // 文字列として `blob` を信じると、名前も subdir も 1 段ずれ、raw が 404 になる。
  const path = reference.slice(1);
  const isFile = marker === "blob" && /\.[A-Za-z0-9]+$/.test(path[path.length - 1] ?? "");
  return { repo, branch: reference[0], path, isFile };
}

/**
 * 受ける形:
 *   https://github.com/owner/repo[.git]
 *   github.com/owner/repo                       (スキーム省略)
 *   .../tree/main[/skills/foo]                  (ブランチ・サブディレクトリ)
 *   .../blob/main/skills/foo/SKILL.md           (ファイル指定 → 親を採る)
 *   https://skills.sh/owner/repo/skill          (カタログ → owner/repo を採る)
 */
export function parseUrl(raw: string): GitHubSource | null {
  const fromCatalog = catalog(raw);
  if (fromCatalog !== null) return fromCatalog.source;

  const parts = components(raw);
  if (parts === null) return null;
  if (parts.branch === undefined) return { repo: parts.repo };

  const path = parts.isFile ? parts.path.slice(0, -1) : parts.path;   // SKILL.md → 親
  return {
    repo: parts.repo,
    branch: parts.branch,
    subdir: path.length === 0 ? undefined : path.join("/"),
    branchAmbiguous: parts.path.length > 0,
  };
}

/**
 * skills.sh の予約パス。`skills.sh/agent/claude-code` は owner/repo ではないので、
 * repo として受けると存在しないリポジトリを取得しに行く。
 */
const RESERVED: ReadonlySet<string> = new Set([
  "about", "agent", "agents", "api", "docs", "login", "new", "search",
  "terms", "privacy", "_next", "favicon.ico",
  // `skills.sh/site/<ドメイン>/<名前>` は GitHub 以外が配っているもの。
  // `site/open.feishu.cn` のような取得元にならない repo を作らない。
  "site",
]);

/**
 * GitHub 以外で Skill を案内しているサイト。追加・削除はこの配列の 1 エントリで済む。
 *
 * `fromPath` を持つサイトは URL だけで取得元が決まり、ネットワークに触れない。
 * 持たないサイトはページを 1 回読む必要がある（`needsPage` / `fromJsonLd`）。
 */
export type CatalogSite = {
  readonly host: string;
  /** 利用者に表示するサイト名。対応サイトの導線もこの宣言に追随させる。 */
  readonly label: string;
  readonly fromPath?: (parts: string[]) => { source: GitHubSource; skill?: string } | null;
};

export const CATALOG_SITES: readonly CatalogSite[] = [
  {
    // skills.sh/owner/repo/skill。3 番目はディレクトリ名であってパスではない
    // （`grilling` の実体は `skills/productivity/grilling`）ので subdir にはできない。
    host: "skills.sh",
    label: "skills.sh",
    fromPath: parts => {
      if (parts.length < 2 || RESERVED.has(parts[0].toLowerCase())) return null;
      if (!isRepoPath(parts[0], parts[1])) return null;
      return { source: { repo: `${parts[0]}/${parts[1]}` }, skill: parts[2] };
    },
  },
  // agentsdirectory.dev/skills/<slug>。slug だけで owner/repo が決まらないので、
  // 取得元はページの JSON-LD から読む。
  { host: "agentsdirectory.dev", label: "Agents Directory" },
];

/** URL 入力とブラウザ拡張の案内に出す、利用者が開ける対応サイト。 */
export const SUPPORTED_SITES: readonly { readonly label: string; readonly url: string }[] = [
  { label: "GitHub", url: "https://github.com/" },
  ...CATALOG_SITES.map(site => ({ label: site.label, url: `https://${site.host}/` })),
];

const CATALOG_HOSTS = CATALOG_SITES.map(site => site.host);

const siteOf = (url: URL): CatalogSite | undefined => {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return CATALOG_SITES.find(site => site.host === host);
};

/**
 * カタログページ。配布しているのは GitHub なので owner/repo を採る。
 * ページの HTML を漁る方法は採らない — 構造の変更で静かに壊れる。
 * 読むのは URL か、`fromJsonLd` が扱う schema.org のメタデータだけ。
 */
export function catalog(raw: string): { source: GitHubSource; skill?: string } | null {
  const url = toUrl(raw, CATALOG_HOSTS);
  if (url === null) return null;
  const site = siteOf(url);
  if (site?.fromPath === undefined) return null;
  return site.fromPath(url.pathname.split("/").filter(part => part !== ""));
}

/**
 * URL だけでは取得元が決まらないカタログ URL か。決まらなければ読みに行く URL を返す。
 * 対応外のサイトと、URL だけで決まるサイトは null。
 */
export function needsPage(raw: string): string | null {
  const url = toUrl(raw, CATALOG_HOSTS);
  if (url === null) return null;
  const site = siteOf(url);
  return site !== undefined && site.fromPath === undefined ? url.toString() : null;
}

/**
 * カタログページから取得元の URL を拾う。HTML の構造には依存せず、
 * schema.org の JSON-LD にある `codeRepository` / `url` だけを読む。
 * 拾えるのは、こちらが既に解釈できる URL（GitHub かカタログ）に限る。
 */
export function fromJsonLd(html: string): string | null {
  const blocks = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.slice(block.indexOf(">") + 1, block.lastIndexOf("<"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;                                   // 壊れたブロックで打ち切らない
    }
    for (const node of flatten(parsed)) {
      for (const key of ["codeRepository", "url"] as const) {
        const value = node[key];
        if (typeof value !== "string") continue;
        // 自分自身を指す url は解決にならない。取得元として読めるものだけ返す。
        if (parseUrl(value) !== null) return value;
      }
    }
  }
  return null;
}

/** JSON-LD は単体・配列・`@graph` のどれでも来る。 */
function flatten(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Record<string, unknown>;
  return [node, ...flatten(node["@graph"])];
}

/** 実在確認は HEAD 1 回だけ。本文は読まない。テストでは差し替える。 */
const headOk = (url: string): Promise<boolean> =>
  fetch(url, { method: "HEAD", cache: "no-store" })
    .then(response => response.status === 200, () => false);

/**
 * カタログ URL は subdir を約束しない（`skills.sh/owner/repo/<名前>` の 3 番目は
 * ディレクトリ名であってパスではない）。subdir が無いとアーカイブの中身を丸ごと
 * 持ってから探すことになり、大きいリポジトリは上限に当たって取り出せない
 * （実測: `github/awesome-copilot` は 105 MB あり、欲しいのは 10 KB）。
 *
 * 規約どおりの置き場に `SKILL.md` があるかを HEAD 1 回ずつで先に確かめる。
 * 上の候補が当たれば短絡復帰し、外れたときだけ下を叩く（成功経路は増やさない）。
 * どれも外れたら何も足さない（従来どおりアーカイブ全体から探す）ので退行しない。
 * カタログ名とディレクトリ名が違うことがあるため、外れは普通に起きる。
 *
 * 候補:
 *   - `skills/<名前>`        規約どおりの置き場（大半のリポジトリ）
 *   - `.agent-skills/<名前>` 隠しディレクトリ版。実測: `akillness/jeo-skills` は
 *                            この形で 250 件を持ち、圧縮 140 MB のためアーカイブ経路では取れない
 */
const SKILL_DIR_CANDIDATES = ["skills", ".agent-skills"] as const;

export async function narrowToSkill(
  source: GitHubSource, skill: string | undefined,
  exists: (url: string) => Promise<boolean> = headOk,
): Promise<GitHubSource> {
  if (skill === undefined || source.subdir !== undefined) return source;
  // パス要素として使えない名前は確かめもしない。`..` で置き場の外を指させない。
  if (!/^[\w.-]+$/.test(skill) || skill.startsWith(".")) return source;
  for (const dir of SKILL_DIR_CANDIDATES) {
    const subdir = `${dir}/${skill}`;
    const at = `https://raw.githubusercontent.com/${source.repo}/`
      + `${source.branch ?? DEFAULT_REF}/${subdir}/SKILL.md`;
    if (await exists(at)) return { ...source, subdir };
  }
  return source;
}

/** カタログ URL に含まれるスキル名。候補一覧の初期絞り込みに使う。 */
export const skillHint = (raw: string): string | undefined => catalog(raw)?.skill;
