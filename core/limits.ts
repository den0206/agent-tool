/**
 * 取得と展開の上限。IDE 拡張とブラウザ拡張で同じ値を使う。
 * 緩めるのは、実測で不足が確認され、新しい上限と回収経路をテストできる場合だけにする。
 */

/** monorepo のアーカイブは subdir が 20 KB でも数百 MB になり得る。 */
export const SIZE_LIMIT = 50 * 1024 * 1024;
export const EXTRACTED_SIZE_LIMIT = 200 * 1024 * 1024;
export const SINGLE_FILE_LIMIT = 20 * 1024 * 1024;
export const ENTRY_LIMIT = 10_000;
/** カタログページの HTML。JSON-LD を読むだけなので本文は保持しない。 */
export const PAGE_LIMIT = 2 * 1024 * 1024;

/**
 * カタログ URL は取得元の subdir が分からず、一度まとめてメモリに載せてから探す。
 * 実測でスキル集のアーカイブは 0.5〜4 MB なので、ここだけ低く抑える。
 */
export const CATALOG_EXTRACT_LIMIT = 64 * 1024 * 1024;

/**
 * ブラウザの上書き rollback は既存ツリーをメモリに退避するため、展開上限より低く抑える。
 * 新旧ツリーを同時に保持したときの popup のメモリ急増を防ぐ。
 */
export const BROWSER_ROLLBACK_LIMIT = 64 * 1024 * 1024;

/**
 * 許可済みサイトの自動検知が Jev を呼べる回数と、その窓（1 時間）。
 *
 * 自動経路は利用者が押さないので、許可したサイトを回遊するだけで呼び出しが積む。
 * 押して待つ手動スキャンには掛けない — 上限はあくまで「勝手に使われる分」に置く。
 */
export const AUTO_JEV_WINDOW_MS = 60 * 60 * 1000;
export const AUTO_JEV_LIMIT = 30;
