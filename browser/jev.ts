import { PageEvidence } from "./pageEvidence.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 12_000;

type ChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

type NoulAnswer = { readonly type: "noul"; readonly noul: number };

/**
 * Jev に訊くのは「このページは Tool を配っているか」と、その種別だけにする。
 * **どれが取得元か・名前は何かは訊かない** — 候補から選ばせると外し、外れを補正する
 * 規則が別のページを壊す連鎖になった。解決は `aiDetect.ts` の照合が受け持つ。
 */
export type JevDecision = {
  readonly isToolPage: number;
  readonly kind: ChoiceAnswer;
};

export class JevError extends Error {
  constructor(readonly kind: "auth" | "rateLimit" | "network" | "invalid", message: string) {
    super(message);
  }
}

const finite01 = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function choice(value: unknown, allowed: ReadonlySet<string>): ChoiceAnswer {
  if (typeof value !== "object" || value === null) throw new JevError("invalid", "invalid Choice answer");
  const answer = value as Record<string, unknown>;
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !allowed.has(answer.choice)
      || !finite01(answer.confidence) || typeof answer.probabilities !== "object"
      || answer.probabilities === null) {
    throw new JevError("invalid", "invalid Choice answer");
  }
  const probabilities = answer.probabilities as Record<string, unknown>;
  for (const key of allowed) {
    if (!finite01(probabilities[key])) throw new JevError("invalid", "invalid Choice probabilities");
  }
  return {
    type: "choice",
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: Object.fromEntries([...allowed].map(key => [key, probabilities[key] as number])),
  };
}

function noul(value: unknown): NoulAnswer {
  if (typeof value !== "object" || value === null) throw new JevError("invalid", "invalid Noul answer");
  const answer = value as Record<string, unknown>;
  if (answer.type !== "noul" || !finite01(answer.noul)) throw new JevError("invalid", "invalid Noul answer");
  return { type: "noul", noul: answer.noul };
}

export async function decideWithJev(
  evidence: PageEvidence,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<JevDecision> {
  const questions: Record<string, unknown> = {
    is_tool_page: {
      type: "noul",
      // 「主に Tool の紹介ページか」とは訊かない。解説ガイドやドキュメントは「主に」では
      // ないので 0.75〜0.87 で揺れ、閾値をまたいで同じページが通ったり落ちたりする
      // （実測: Supabase の ai-skills ページ）。知りたいのは「ここから導入できるものが
      // あるか」なので、そう訊く。閾値は動かさない。
      instructions: evidence.page.section === undefined
        ? "This page tells the reader about at least one specific AI coding-agent tool, skill, subagent,"
          + " MCP server, or agent plugin that they can install, and points at where to get it."
          + " A page that only mentions such tools in passing, or only explains the concept, does not count."
        : `The reader is viewing the section "${evidence.page.section}" of this page, and the candidates below`
          + " were taken from that section only. That section tells the reader about a specific installable"
          + " AI coding-agent tool, skill, subagent, MCP server, or agent plugin, and points at where to get it."
          + " Judge that section, not whether the whole page is a listing.",
    },
    tool_kind: {
      type: "choice",
      instructions: "Which kind of AI coding-agent resource does this page primarily describe?",
      criteria: {
        skill: "An Agent Skill, usually distributed with SKILL.md.",
        subagent: "A subagent or agent definition.",
        mcp: "An MCP server.",
        plugin: "An agent plugin or marketplace plugin.",
        other: "None of these.",
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await request(ENDPOINT, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: { page: evidence.page, candidates: evidence.candidates },
        model: "jev-latest",
        questions,
      }),
    });
  } catch {
    throw new JevError("network", "Jev request failed");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) throw new JevError("auth", "Jev API key was rejected");
  if (response.status === 429) throw new JevError("rateLimit", "Jev rate limit reached");
  if (!response.ok) throw new JevError("network", `Jev request failed (${response.status})`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > RESPONSE_LIMIT) throw new JevError("invalid", "Jev response was too large");
  const text = (await response.text()).slice(0, RESPONSE_LIMIT + 1);
  if (text.length > RESPONSE_LIMIT) throw new JevError("invalid", "Jev response was too large");

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new JevError("invalid", "Jev returned invalid JSON"); }
  if (typeof parsed !== "object" || parsed === null) throw new JevError("invalid", "Jev returned an invalid response");
  const answers = (parsed as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) throw new JevError("invalid", "Jev response has no answers");
  const table = answers as Record<string, unknown>;

  return {
    isToolPage: noul(table.is_tool_page).noul,
    kind: choice(table.tool_kind, new Set(["skill", "subagent", "mcp", "plugin", "other"])),
  };
}
