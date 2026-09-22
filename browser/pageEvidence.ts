export type EvidenceCandidate = {
  readonly id: string;
  readonly kind: "url" | "command" | "jsonld";
  readonly value: string;
  readonly nearbyText?: string;
};

export type PageEvidence = {
  readonly page: {
    readonly url: string;
    readonly title: string;
    readonly description?: string;
    readonly headings: string[];
    /**
     * 利用者が見ている節の見出し。URL の `#...` がページ内の要素を指しているとき、
     * その要素だけから候補を採ったことを表す。**fragment 自体は送らない**
     * （OAuth の implicit flow のように token が入ることがある）。
     */
    readonly section?: string;
  };
  readonly candidates: EvidenceCandidate[];
};

/**
 * Runs inside the active page through chrome.scripting.executeScript.
 * Keep this function self-contained: Chrome serializes the function body and
 * does not carry module-scope helpers into the page.
 */
export function extractPageEvidence(): PageEvidence {
  const trim = (value: string, max: number): string =>
    value.replace(/\s+/g, " ").trim().slice(0, max);

  const safeUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (url.username !== "" || url.password !== "") return null;
      url.hash = "";
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      // `parseUrl` が受けるホストだけを候補にする。raw.githubusercontent.com は
      // 取得元に解決できず、選ばれても必ず「見つからない」になるので送らない。
      if (host !== "github.com") return null;
      // Repository resolution never needs query parameters. Dropping them also
      // avoids leaking tokens that some sites put in copied links.
      url.search = "";
      return url.toString();
    } catch {
      return null;
    }
  };

  /**
   * 利用者が見ている節。`#...` が指す要素の中だけから候補を採る。
   * まとめページ（「Top 10 …」）は 1 ページに何件も並び、ページ全体を渡すと
   * 「どれを見ているか」を表せない。目印が空のアンカーのこともあるので、
   * 取得元リンクを含む親まで数階層だけ遡る。タグ名・class には依存しない。
   */
  const sectionRoot = ((): Element | null => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (id === "") return null;
    let node: Element | null = null;
    try {
      node = document.getElementById(id) ?? document.querySelector(`[name="${CSS.escape(id)}"]`);
    } catch { return null; }
    for (let up = 0; node !== null && up < 5; up++) {
      if (node.querySelector('a[href*="github.com/"]') !== null) return node;
      node = node.parentElement;
    }
    return null;
  })();
  const root: Element | Document = sectionRoot ?? document;

  const candidates: Array<{ kind: "url" | "command" | "jsonld"; value: string; nearbyText?: string }> = [];
  const add = (kind: "url" | "command" | "jsonld", value: string, nearbyText?: string): void => {
    const clean = trim(value, 1200);
    if (clean === "") return;
    if (candidates.some(item => item.kind === kind && item.value === clean)) return;
    candidates.push({ kind, value: clean, nearbyText: nearbyText === undefined ? undefined : trim(nearbyText, 240) });
  };

  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const url = safeUrl(link.href);
    if (url !== null) add("url", url, link.textContent ?? link.getAttribute("aria-label") ?? "");
    if (candidates.length >= 96) break;
  }

  const jsonLd = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    for (const key of ["codeRepository", "url", "sameAs"]) {
      const found = node[key];
      const values = Array.isArray(found) ? found : [found];
      for (const item of values) {
        if (typeof item !== "string") continue;
        const url = safeUrl(item);
        if (url !== null) add("jsonld", url, key);
      }
    }
    if ("@graph" in node) walk(node["@graph"]);
  };
  // `executeScript` はこの関数を文字列にしてページへ送るので、`core/limits.ts` の
  // `PAGE_LIMIT` を参照できない。同じ 2 MB を直書きする。長さは UTF-16 単位で数える。
  let jsonLdLength = 0;
  for (const block of jsonLd.slice(0, 12)) {
    const body = block.textContent ?? "";
    jsonLdLength += body.length;
    if (jsonLdLength > 2 * 1024 * 1024) break;
    try { walk(JSON.parse(body)); } catch { /* malformed metadata */ }
  }

  /**
   * 導入コマンドは**一致した行だけ**を、値を潰してから送る。1 つの導入ブロックには
   * `export ANTHROPIC_API_KEY=sk-...` のような行が同居することがあり、丸ごと送ると
   * 外部サービスへ鍵が出る。潰し方は `ide/mcpServer.ts` の `redact` と同じ方針。
   * 取得元は `github.com/<owner>/<repo>` か `skills add <owner>/<repo>` から拾うので、
   * 値を潰しても判定は変わらない。
   */
  const installLine = /(?:github\.com\/|\b(?:npx|bunx|pnpm\s+dlx)\s+skills\s+add\b|\bclaude\s+plugin\b)/i;
  const scrub = (value: string): string => value
    // `Bearer` / `Basic` を先に潰す。後にすると `Authorization:` の規則が `Bearer` だけを
    // 食べ、値がそのまま残る（実測で確認した）。
    .replace(/\b(bearer|basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/([\w.-]*(?:key|token|secret|password|passwd|pwd|auth)[\w.-]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    // `--token <値>` のように空白で区切る形。フラグに限る（`acme/token-tools` のような
    // リポジトリ名を壊さない）。
    .replace(/(\s-{1,2}[\w-]*(?:key|token|secret|password|passwd|pwd|auth)[\w-]*\s+)\S+/gi, "$1[redacted]")
    .replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, "$1");

  let commands = 0;
  for (const node of Array.from(root.querySelectorAll<HTMLElement>("pre, code"))) {
    // `<pre><code>` は同じ本文を二重に返す。内側の code だけを外し、1 行ずつ扱うので
    // 複数 repo を 1 つの文字列に潰さない。
    if (node.tagName === "CODE" && node.parentElement?.tagName === "PRE") continue;
    for (const line of (node.textContent ?? "").split("\n")) {
      if (!installLine.test(line)) continue;
      add("command", scrub(line), scrub(trim(node.parentElement?.textContent ?? "", 240)));
      if (++commands >= 32 || candidates.length >= 128) break;
    }
    if (commands >= 32 || candidates.length >= 128) break;
  }

  const headingsIn = (scope: Element | Document): string[] =>
    Array.from(scope.querySelectorAll<HTMLElement>("h1, h2, h3"))
      .map(node => trim(node.textContent ?? "", 120))
      .filter(Boolean)
      .slice(0, 12);
  // 節に絞ったときは節の見出しを渡す。無ければページ全体の見出しに戻す。
  const scopedHeadings = sectionRoot === null ? [] : headingsIn(sectionRoot);
  const headings = scopedHeadings.length > 0 ? scopedHeadings : headingsIn(document);

  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content
    ?? document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content;

  return {
    page: {
      url: (() => {
        try {
          const url = new URL(location.href);
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch { return ""; }
      })(),
      title: trim(document.title, 200),
      description: description === undefined ? undefined : trim(description, 400),
      headings,
      section: scopedHeadings[0],
    },
    candidates: candidates.slice(0, 160).map((candidate, index) => ({ id: `c${index}`, ...candidate })),
  };
}
