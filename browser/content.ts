/**
 * 見ている URL を service worker へ送るだけ。判定も UI も持たない
 * （content script は ES モジュールを読み込めない）。
 *
 * SPA の遷移は `chrome.webNavigation.onHistoryStateUpdated` が service worker 側で拾う。
 * content script から `history.pushState` を差し替えても、ページ本体は別の JavaScript 世界で
 * 動いているので呼ばれない。ここでやるのは最初の 1 回と、JSON-LD の受け渡しだけにする。
 *
 * 全体を即時関数で包む。content script が二重に注入されても、トップレベルの `const` が
 * ぶつかって `Identifier ... has already been declared` にならないようにする。
 */
(() => {
  /**
   * 送れなくてもページ側は動かす。
   *
   * `sendMessage` は拡張を入れ直した直後など、**同期的に** `Extension context invalidated.`
   * を投げることがある。`.catch()` では捕まらないので try で囲う。
   */
  const send = (message: Record<string, unknown>): void => {
    try {
      void chrome.runtime.sendMessage(message).catch(() => { /* service worker が不在 */ });
    } catch {
      /* 拡張が入れ替わった。このページの content script はもう用済み */
    }
  };

  const report = (): void => {
    // URL だけで取得元が決まらないカタログのために、ページの JSON-LD を添える。
    // HTML 全体は送らない。読むのは service worker 側の `fromJsonLd` だけ。
    // content script は ES モジュールを読めないので `PAGE_LIMIT` を参照できない。
    // 同じ 2 MB を直書きする。長さは UTF-16 単位で数える。
    const limit = 2 * 1024 * 1024;
    let jsonLd = "";
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      const remaining = limit - jsonLd.length;
      if (remaining <= 0) break;
      jsonLd += node.outerHTML.slice(0, remaining);
    }
    send({ type: "visited", url: location.href, jsonLd });
  };

  // SPA の遷移を service worker が拾ったら、その時点の URL と JSON-LD を送り直す。
  chrome.runtime.onMessage.addListener(message => {
    if ((message as { type?: string }).type === "rescan") report();
  });

  report();
})();
