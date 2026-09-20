import { AiDetectResult, confirms, detectWithJev } from "./aiDetect.js";
import { decideWithJev } from "./jev.js";
import { jevApiKey, jevEnabled } from "./aiSettings.js";
import { originPattern } from "./sitePermissions.js";
import { extractPageEvidence, PageEvidence } from "./pageEvidence.js";
import { AUTO_JEV_LIMIT, AUTO_JEV_WINDOW_MS } from "../core/limits.js";
import { MAX_BROWSER_COLLECTION_ENTRIES } from "../core/collection.js";
import { needsPage, parseUrl } from "../core/github.js";
import { ToolLead } from "../core/detect.js";

/**
 * 許可済みサイトの自動検知。手動スキャンと同じ `detectWithJev()` を通す —
 * 決定論で決まるものは決定論で決め、コードが諦めたページだけ Jev に訊く。
 *
 * 自動経路は利用者が押さないので、**呼び出し回数に上限を置く**（`AUTO_JEV_LIMIT`）。
 * 許可したサイトを回遊するだけで積むのがここだけの性質で、手動スキャンには掛けない。
 */
export type AutoResult =
  | { readonly kind: "found"; readonly lead: ToolLead }
  /** 取得元だけ決まった。背景が skills.sh 形の URL に直して既存の一覧経路へ渡す。 */
  | { readonly kind: "repo"; readonly repo: string }
  /** ページが複数の Tool を載せている。件数だけ出し、選ぶのは popup に任せる。 */
  | { readonly kind: "many"; readonly count: number }
  | { readonly kind: "none" };

const NOTHING: AutoResult = { kind: "none" };

/**
 * 同じ URL を続けて見ない。SPA の pushState と `onCompleted` は同じページで両方来るし、
 * hydration で複数回来ることもある。この起動中のメモリにだけ置く。
 */
const seen = new Map<number, { url: string; at: number }>();
const DEBOUNCE_MS = 500;

/**
 * Jev に訊き終えた URL。タブをまたいで覚える — 同じページを別タブで開いても
 * もう一度課金しない。**この起動中のメモリにだけ置く**ので、service worker が
 * 止まれば消える。正しさの正本ではなく、無駄な呼び出しを減らすだけのもの。
 */
const asked = new Set<string>();

/** `asked` と永続枠は read-modify-write なので、予約だけは直列化する。
 * ponytail: global reservation; Jev の時間枠を上げて待ち時間が問題になれば URL ごとの予約にする。 */
let reservation = Promise.resolve();

async function reserveJev(
  key: string,
  budget: (now?: number) => Promise<boolean>,
): Promise<boolean> {
  let release!: () => void;
  const previous = reservation;
  reservation = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (asked.has(key) || !await budget()) return false;
    if (asked.size >= MAX_BROWSER_COLLECTION_ENTRIES) asked.delete(asked.values().next().value as string);
    asked.add(key);
    return true;
  } finally {
    release();
  }
}

/** タブを忘れる。`background.ts` の `onRemoved` から呼ぶ。 */
export const forgetTab = (tabId: number): void => { seen.delete(tabId); };

/** 比較用。fragment と query を落として、同じページを別物に見せない。 */
function normalized(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch { return null; }
}

/**
 * 自動経路が Jev を呼べる残り。窓（1 時間）と件数だけを持ち、**どのサイトを見たかは
 * 保存しない**。service worker は止まるので、メモリではなく `chrome.storage.local` に置く。
 */
const BUDGET = "autoJevBudget";

export async function takeJevBudget(
  now = Date.now(),
  storage: { get: (key: string) => Promise<Record<string, unknown>>;
             set: (items: Record<string, unknown>) => Promise<void> } = chrome.storage.local,
): Promise<boolean> {
  const stored = (await storage.get(BUDGET))[BUDGET];
  const budget = stored as { start?: number; count?: number } | undefined;
  const fresh = budget?.start === undefined || now - budget.start >= AUTO_JEV_WINDOW_MS;
  const start = fresh ? now : budget.start as number;
  const count = fresh ? 0 : budget.count ?? 0;
  if (count >= AUTO_JEV_LIMIT) return false;
  await storage.set({ [BUDGET]: { start, count: count + 1 } });
  return true;
}

/**
 * 1 ページ分の自動検知。呼び出し側（`background.ts`）は結果をバッジに映すだけにする。
 * 外部依存は引数で受ける。Chrome API に触れずに Node で検証できるようにするため。
 */
export async function automaticVisit(
  tabId: number,
  url: string,
  deps: {
    allowed: (pattern: string) => Promise<boolean>;
    /** 前のページの検知を下ろす。**読み直すと決めたときだけ**呼ぶ。 */
    clear: (tabId: number) => Promise<void>;
    evidence: (tabId: number) => Promise<PageEvidence | null>;
    key?: () => Promise<string>;
    budget?: (now?: number) => Promise<boolean>;
    decide?: typeof decideWithJev;
    verify?: (lead: ToolLead) => Promise<boolean | null>;
    now?: () => number;
  },
): Promise<AutoResult> {
  // 既知カタログは決定論的経路が正本。自動経路へ二重に入れない。
  if (parseUrl(url) !== null || needsPage(url) !== null) return NOTHING;

  const pattern = originPattern(url);
  if (pattern === null) return NOTHING;

  const key = normalized(url);
  if (key === null) return NOTHING;
  const at = (deps.now ?? Date.now)();
  const last = seen.get(tabId);
  if (last?.url === key && at - last.at < DEBOUNCE_MS) return NOTHING;

  // listener は許可済み origin で絞ってあるが、張り直しとイベントが競合しうるので
  // ここでももう一度見る。許可を消した直後に読み始めない。
  if (!await deps.allowed(pattern)) return NOTHING;
  seen.set(tabId, { url: key, at });
  // ここまで来た = 読み直す。前のページのバッジと候補はここで下ろす。
  // 重複イベントで弾かれた側は通らないので、直前に出したバッジを消さない。
  await deps.clear(tabId);

  const page = await deps.evidence(tabId);
  if (page === null) return NOTHING;

  const ask = deps.decide ?? decideWithJev;
  // Jev へ回るかは `detectWithJev` の中でしか分からない。鍵も枠も**実際に訊く直前**に取る。
  // 決定論で決まったページでは、設定を読みにも行かないし枠も消費しない。
  let charged = false;
  const decide: typeof decideWithJev = async (evidence) => {
    // 鍵は推測の fallback だけを止める。`detectWithJev` のローカル解決は鍵不要。
    const apiKey = await (deps.key ?? enabledKey)();
    if (apiKey === "" || !await reserveJev(key, deps.budget ?? takeJevBudget)) throw new BudgetExhausted();
    charged = true;
    return ask(evidence, apiKey);
  };

  let result: AiDetectResult;
  try {
    // 鍵は `decide` が自分で読む。`detectWithJev` は受け取った鍵を `decide` へ渡すだけなので、
    // ここでは空でよい（Jev へ出す鍵は上の `ask(evidence, apiKey)` が決める）。
    result = await detectWithJev(page, "", decide, deps.verify ?? confirms);
  } catch {
    // 枠切れ・鍵の失効・通信不能。自動経路は黙る — 利用者は押していない。
    // **覚えない。** 読めなかっただけのものを「訊き終えた」に潰すと、通信が戻っても
    // この起動中ずっと出なくなる（`background.ts` の `extracted` と同じ姿勢）。
    if (charged) asked.delete(key);
    return NOTHING;
  }

  switch (result.kind) {
    case "found": return result;
    case "repo": return { kind: "repo", repo: result.source.repo };
    case "many": return { kind: "many", count: result.leads.length };
    // `unverified`（通信不能）と `unsupported-kind`（MCP / Plugin）は自動では告げない。
    case "none": case "unverified": case "unsupported-kind": return NOTHING;
  }
}

/** 枠を使い切った印。`decide` の中からしか投げない。 */
class BudgetExhausted extends Error {}

/** Beta を切っているなら鍵があっても使わない。手動スキャンのカードと同じ条件にする。 */
const enabledKey = async (): Promise<string> =>
  await jevEnabled().catch(() => false) ? jevApiKey() : "";

/** 実際のタブから evidence を読む。`background.ts` が `automaticVisit` に渡す。 */
export async function evidenceFromTab(tabId: number): Promise<PageEvidence | null> {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageEvidence,
  }).catch(() => null);                              // 権限が消えた・タブが閉じた
  return result?.[0]?.result ?? null;
}
