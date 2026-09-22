import { lead, proofUrls, ToolLead } from "../core/detect.js";
import { DEFAULT_REF, GitHubSource, parseUrl } from "../core/github.js";
import { isExtractable } from "./install.js";
import { decideWithJev } from "./jev.js";
import { EvidenceCandidate, extractPageEvidence, PageEvidence } from "./pageEvidence.js";

const PAGE_THRESHOLD = 0.80;

export type AiDetectResult =
  | { readonly kind: "found"; readonly lead: ToolLead }
  /** 取得元は決まったが名前は決めない。popup が `skills/` を列挙して選ばせる。 */
  | { readonly kind: "repo"; readonly source: GitHubSource }
  /** ページが複数の Tool を載せている。1 つに決めず、利用者に選ばせる。 */
  | { readonly kind: "many"; readonly leads: ToolLead[] }
  | { readonly kind: "none" }
  /** 取得元は決まったが、通信できず実在を確かめられなかった。「無い」とは言わない。 */
  | { readonly kind: "unverified"; readonly source: GitHubSource }
  | { readonly kind: "unsupported-kind"; readonly resource: "mcp" | "plugin" };

/**
 * 導入コマンドの本文から `owner/repo` を拾う。`github.com/` に続く 2 セグメントか、
 * `skills add owner/repo` の形だけを見る。最初のスラッシュを拾うと
 * `npx skills add github.com/acme/tools` から `github.com/acme` を取ってしまう。
 */
const repoFromCommand = (command: string): string | undefined =>
  command.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s"'),\]/]|$)/i)?.[1]
  ?? command.match(/\bskills\s+add\s+([\w.-]+\/[\w.-]+)/i)?.[1];

/**
 * `skills add` のうち、実行せずに意味を確定できる単一 Skill 指定だけを読む。
 * shell を解釈しないので、変数・パイプ・複数フラグなどはここを通らず従来の repo 経路へ戻る。
 */
export function commandLead(command: string): ToolLead | null {
  const matched = command.match(
    /^\s*(?:npx|bunx|pnpm\s+dlx)\s+skills\s+add\s+(?:(?:https?:\/\/)?github\.com\/)?([\w.-]+\/[\w.-]+)(?:\.git)?\s+--skill\s+(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+))\s*$/i,
  );
  if (matched === null) return null;
  const [, repo, quoted, singleQuoted, bare] = matched;
  const name = quoted ?? singleQuoted ?? bare;
  if (name === undefined || name.startsWith(".")) return null;
  // `lead()` へ URL として渡し、repo と名前を他の URL 経路と同じ検証で作る。
  // 規約どおりの置き場を指す形にして、実在確認を **HEAD 1 回**で済ませる。カタログ形
  // （`skills.sh/...`）にすると `proofs` が空になり、自動経路がページを見るたびに
  // アーカイブを 1 本落とす。置き場が規約から外れているものはここで決めない。
  return lead(`https://github.com/${repo}/tree/${DEFAULT_REF}/skills/${name}`);
}

/**
 * ページ本文由来の文字列から `GitHubSource` を直接組み立てない。URL に戻して
 * `parseUrl` の検証（`isRepoPath`）を通す — 他の経路と同じ関門を通さないと、
 * `..` や `.foo` を repo として取得しに行ける。
 */
function sourceFrom(candidate: EvidenceCandidate): ReturnType<typeof parseUrl> {
  const parsed = parseUrl(candidate.value);
  if (parsed !== null) return parsed;
  if (candidate.kind !== "command") return null;
  const repo = repoFromCommand(candidate.value);
  return repo === undefined ? null : parseUrl(`https://github.com/${repo}`);
}

/** `blob/<40 桁 SHA>` のように commit を固定した URL か。 */
const pinned = (value: string): boolean => /\/(?:blob|tree)\/[0-9a-f]{40}(?:\/|$)/i.test(value);

/**
 * 候補が指しているものの同一性。URL でもコマンドでも同じ鍵になる。
 * 解決できないもの（owner ページ、`npx skills add <package>` のような雛形）は `null`。
 */
function identity(candidate: EvidenceCandidate): string | null {
  if (candidate.kind === "command") {
    const repo = repoFromCommand(candidate.value);
    return repo === undefined ? null : `root:${repo}`;
  }
  const source = parseUrl(candidate.value);
  if (source === null) return null;
  const found = lead(candidate.value);
  return found === null ? `root:${source.repo}` : `${found.kind}:${source.repo}:${found.name}`;
}

/**
 * 取得元に解決できない候補を落とす。owner ページや `npx skills add <package>` のような
 * 雛形は、選ばれても必ず「見つからない」になるので送らない。
 *
 * **畳み込みはここでしない。** 以前は「どれが取得元か」を Jev の Choice に訊いていて、
 * 同じものを指す候補が並ぶと確率が割れたため畳んでいた。その問いを廃したので不要になり、
 * むしろ畳むと導入コマンドが URL に吸収されて取得元が決まらなくなる（実測: Supabase）。
 */
export function narrowed(evidence: PageEvidence): PageEvidence {
  return { ...evidence, candidates: evidence.candidates.filter(item => identity(item) !== null) };
}

/**
 * 既定の実在確認。`proofs` があるなら **HEAD 1 回**で足りる（`background.ts` の
 * 自動検知と同じ判定）。アーカイブを落とすのは、カタログ候補のように置き場が
 * 分からない = `proofs` が空のときだけにする。
 */
export async function confirms(found: ToolLead): Promise<boolean | null> {
  if (found.proofs.length === 0) return isExtractable(found);
  // 一度も応答が返っていないなら「無い」とは言えない。通信不能を不在に潰さない。
  let reached = false;
  for (const url of proofUrls(found)) {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" }).catch(() => null);
    if (response?.status === 200) return true;
    if (response !== null) reached = true;
  }
  return reached ? false : null;
}

/**
 * ページ自身が名乗っている名前。URL のパス要素と `#fragment` だけを見る。
 *
 * 見出しは使わない — まとめページの見出しには載っている Tool 全部の名前が並ぶので、
 * 混ぜると全件が「一致」してしまう（実測で確認した）。
 */
function claimedNames(page: PageEvidence["page"]): Set<string> {
  const names = new Set<string>();
  try {
    const url = new URL(page.url);
    for (const part of url.pathname.split("/").filter(Boolean)) names.add(part.toLowerCase());
  } catch { /* 送っていない URL は照合しない */ }
  if (page.section !== undefined) names.add(page.section.toLowerCase());
  return names;
}

/**
 * Jev を呼ばずに、候補とページの照合だけで決める。
 *
 * **「どれが取得元か」はたいてい計算できる。** ページの URL 末尾と、候補から
 * `lead()` が取り出した Skill 名が一致すれば、それが答えである（実測: lazyskills.sh の
 * `/skills/frontend-design` は候補 11 件のうち `frontend-design` の 1 件に決まる）。
 * モデルに選ばせると外し、外れを補正する規則が別のページを壊す — その連鎖を断つ。
 *
 * 決まらなければ「一覧」を返す。**常に正しい答えが 1 つある**ので、当てにいく必要がない。
 */
export function resolveLocally(evidence: PageEvidence): AiDetectResult | { kind: "ask" } {
  // 同じ Skill を指す URL が複数あることがある（`blob/<sha>/…` と `tree/main/…` など）。
  // 1 つに畳まないと「2 件ある」と誤って読める。更新が追えるブランチ名の方を残す。
  const found = new Map<string, ToolLead>();
  for (const candidate of evidence.candidates.filter(item => item.kind !== "command")) {
    const resolved = lead(candidate.value);
    if (resolved === null) continue;
    const key = `${resolved.kind}:${resolved.source.repo}:${resolved.name}`;
    const previous = found.get(key);
    if (previous === undefined || (pinned(previous.url) && !pinned(candidate.value))) {
      found.set(key, resolved);
    }
  }
  const direct = [...found.values()];
  if (direct.length === 0) return { kind: "ask" };          // 手がかりが弱い。Jev に訊く

  const claimed = claimedNames(evidence.page);
  const matched = direct.filter(found => claimed.has(found.name.toLowerCase()));
  const picked = matched.length === 1 ? matched[0] : direct.length === 1 ? direct[0] : null;
  return picked === null ? { kind: "many", leads: direct } : { kind: "found", lead: picked };
}

/**
 * 未対応ページから導入候補を出す。
 *
 * 決定論で決まるものは決定論で決める。Jev に訊くのは**コードが諦めたとき**、
 * すなわち Skill を名指しする直リンクが 1 つも無いページだけで、訊くのも
 * 「このページは Tool を配っているか」の 1 問に限る。どれを入れるかは訊かない。
 */
export async function detectWithJev(
  raw: PageEvidence,
  apiKey: string,
  decide: typeof decideWithJev = decideWithJev,
  verify: (lead: ToolLead) => Promise<boolean | null> = confirms,
): Promise<AiDetectResult> {
  const evidence = narrowed(raw);
  if (evidence.candidates.length === 0) return { kind: "none" };

  const local = resolveLocally(evidence);
  if (local.kind === "found") {
    const verified = await verify(local.lead);
    if (verified === true) return local;
    // 確かめられなかった（`null`）を「このページに Tool は無い」と言わない。利用者は
    // 押して待った側なので、取得元だけ返して「読めなかった」と出す。
    return verified === null ? { kind: "unverified", source: local.lead.source } : { kind: "none" };
  }
  if (local.kind === "many") return local;                  // 一覧は利用者が選ぶ

  // 指定名付きコマンドは、GitHub のリンクより「何を入れるか」という強い手がかりになる。
  // ただし URL 直リンクの照合より後に置く。
  const named = new Map<string, ToolLead>();
  for (const candidate of evidence.candidates) {
    if (candidate.kind !== "command") continue;
    const found = commandLead(candidate.value);
    if (found !== null) named.set(`${found.source.repo}:${found.name}`, found);
  }
  const leads = [...named.values()];
  // 取得元が割れているときだけ候補選択へ渡す。**同じ repo の名前が並ぶページ**
  // （実測: Supabase Docs の導入手順）は、その repo の一覧を出す方が正しい。
  if (new Set(leads.map(item => item.source.repo)).size > 1) return { kind: "many", leads };
  if (leads.length === 1) {
    const verified = await verify(leads[0]);
    if (verified === true) return { kind: "found", lead: leads[0] };
    if (verified === null) return { kind: "unverified", source: leads[0].source };
    // 規約の置き場に無い（frontmatter の `name` で指している、`.agent-skills/` に置いて
    // いる等）。アーカイブを落として当てにいかず、名前を捨てて従来の repo 経路へ戻す。
    // 実体の照合は導入時の `narrowToSkill` / `locateSkill` が行う。
  }

  // ここから先は推測になる。ページが Tool を配っていることを Jev に確かめてから進む。
  const decision = await decide(evidence, apiKey);
  // 種別より先に「配っているか」を見る。Choice は必ず 1 つ選ぶので、Tool を配っていない
  // ページでも `mcp` / `plugin` が返り、「MCP は非対応」と誤って告げてしまう。
  if (decision.isToolPage < PAGE_THRESHOLD) return { kind: "none" };
  if (decision.kind.choice === "mcp" || decision.kind.choice === "plugin") {
    return { kind: "unsupported-kind", resource: decision.kind.choice };
  }

  // 取得元は、リンクより**導入コマンド**に書かれたものを優先する。コマンドは
  // 「入れ方」そのものなので、ページに並ぶ参考リンクより強い証拠である。
  const repos = (kinds: (candidate: EvidenceCandidate) => boolean): GitHubSource[] => {
    const found = new Map<string, GitHubSource>();
    for (const candidate of evidence.candidates.filter(kinds)) {
      const source = sourceFrom(candidate);
      if (source !== null) found.set(source.repo, { repo: source.repo });
    }
    return [...found.values()];
  };
  const sources = repos(item => item.kind === "command");
  const picked = sources.length > 0 ? sources : repos(item => item.kind !== "command");
  // 取得元が割れているなら決めない。推測で無関係なリポジトリを見せない。
  return picked.length === 1 ? { kind: "repo", source: picked[0] } : { kind: "none" };
}

export async function evidenceFromActiveTab(): Promise<PageEvidence | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  const result = await chrome.scripting.executeScript<PageEvidence>({
    target: { tabId: tab.id },
    func: extractPageEvidence,
  });
  return result[0]?.result ?? null;
}
