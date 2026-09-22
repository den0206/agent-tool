import assert from "node:assert/strict";
import test from "node:test";

import { commandLead, detectWithJev, narrowed, resolveLocally } from "../out/web/browser/aiDetect.js";
import { decideWithJev, JevError } from "../out/web/browser/jev.js";
import { extractPageEvidence } from "../out/web/browser/pageEvidence.js";

const page = { url: "https://example.com/skills/pdf", title: "PDF", headings: [] };
const url = value => ({ id: value, kind: "url", value });
const command = value => ({ id: value, kind: "command", value });

/** Jev は「Tool を配っているページか」と種別だけを返す。取得元も名前も訊かない。 */
const answers = (isToolPage = 0.95, choice = "skill") => async () => ({
  isToolPage,
  kind: {
    type: "choice", choice, confidence: 0.99,
    probabilities: { skill: 0.99, subagent: 0.004, mcp: 0.003, plugin: 0.002, other: 0.001 },
  },
});

const never = async () => { throw new Error("Jev must not be called"); };

// --- 決定論で決める（Jev を呼ばない） ----------------------------------

test("ページ URL と名前が一致する直リンクを採る", async () => {
  const evidence = { page, candidates: [
    url("https://github.com/site/site"),                                  // サイト本体
    url("https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md"),   // ページ名と一致
    url("https://github.com/other/x/blob/main/skills/xlsx/SKILL.md"),
  ] };
  assert.equal(resolveLocally(narrowed(evidence)).lead.name, "pdf");

  const result = await detectWithJev(evidence, "key", never, async () => true);
  assert.equal(result.kind, "found");
  assert.equal(result.lead.source.repo, "acme/tools");
});

test("同じ Skill を指す URL は 1 つに畳む（commit 固定よりブランチ名）", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const resolved = resolveLocally(narrowed({ page, candidates: [
    url(`https://github.com/acme/tools/blob/${sha}/skills/pdf/SKILL.md`),
    url("https://github.com/acme/tools/tree/main/skills/pdf"),
  ] }));
  assert.equal(resolved.kind, "found");
  assert.equal(resolved.lead.source.branch, "main");
});

test("決まらない複数は 1 つに決めず、一覧として返す", async () => {
  const evidence = { page: { ...page, url: "https://example.com/top-10" }, candidates: [
    url("https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md"),
    url("https://github.com/other/x/blob/main/skills/xlsx/SKILL.md"),
  ] };
  const result = await detectWithJev(evidence, "key", never, async () => true);
  assert.equal(result.kind, "many");
  assert.deepEqual(result.leads.map(item => item.name), ["pdf", "xlsx"]);
});

test("実在確認が通らない直リンクは候補にしない", async () => {
  const evidence = { page, candidates: [
    url("https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md"),
  ] };
  assert.deepEqual(await detectWithJev(evidence, "key", never, async () => false), { kind: "none" });
});

test("実在を確かめられなかったときは「無い」と言わず取得元を返す", async () => {
  const evidence = { page, candidates: [
    url("https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md"),
  ] };
  const result = await detectWithJev(evidence, "key", never, async () => null);
  assert.equal(result.kind, "unverified");
  assert.equal(result.source.repo, "acme/tools");
});

// --- 直リンクが無いときだけ Jev に訊く ----------------------------------

test("直リンクが無いページは、Tool を配っているかを確かめてから取得元を返す", async () => {
  const evidence = { page, candidates: [
    url("https://github.com/unrelated/site"),
    command("npx skills add acme/tools"),                  // コマンドはリンクより強い
  ] };
  assert.deepEqual(await detectWithJev(evidence, "key", answers(), async () => true),
                   { kind: "repo", source: { repo: "acme/tools" } });

  // Tool を配っていないページには出さない。
  assert.deepEqual(await detectWithJev(evidence, "key", answers(0.2), async () => true),
                   { kind: "none" });
});

test("指定名付き導入コマンドは Jev を呼ばずに Skill を確認する", async () => {
  for (const line of [
    "npx skills add acme/tools --skill pdf",
    "bunx skills add acme/tools --skill 'pdf'",
    "pnpm dlx skills add https://github.com/acme/tools --skill \"pdf\"",
  ]) {
    const found = commandLead(line);
    assert.equal(found?.source.repo, "acme/tools");
    assert.equal(found?.name, "pdf");
    // `proofs` が空だと実在確認がアーカイブ取得に落ちる。自動経路が見るたびに
    // 1 本落とさないよう、HEAD で確かめられる形であることを固定する。
    assert.deepEqual(found?.proofs, ["skills/pdf/SKILL.md"]);
    const result = await detectWithJev({ page, candidates: [command(line)] }, "key", never, async () => true);
    assert.equal(result.kind, "found");
    assert.equal(result.lead.name, "pdf");
  }
});

test("規約の置き場に無い指定名は当てにいかず、従来の repo 経路へ戻す", async () => {
  const evidence = { page, candidates: [command("npx skills add acme/tools --skill pdf")] };
  // HEAD が 404（= false）でもアーカイブを落とさない。Jev のゲートを通って取得元だけ返す。
  assert.deepEqual(await detectWithJev(evidence, "key", answers(), async () => false),
                   { kind: "repo", source: { repo: "acme/tools" } });
  // 通信できなかった（null）ときは「無い」と言わない。
  assert.deepEqual(await detectWithJev(evidence, "key", never, async () => null),
                   { kind: "unverified", source: { repo: "acme/tools", branch: "HEAD",
                                                   subdir: "skills/pdf", branchAmbiguous: true } });
});

test("同じ repo の指定名が並ぶページは 1 件に決めず、取得元の一覧へ回す", async () => {
  // 実測: Supabase Docs は同じ repo の `--skill` を手順ごとに並べる。候補選択ではなく
  // その repo の一覧を出すのが正しい。実在確認もここでは行わない。
  const evidence = { page, candidates: [
    command("npx skills add acme/tools --skill pdf"),
    command("npx skills add acme/tools --skill xlsx"),
  ] };
  const verify = async () => { throw new Error("実在確認を呼んではいけない"); };
  assert.deepEqual(await detectWithJev(evidence, "key", answers(), verify),
                   { kind: "repo", source: { repo: "acme/tools" } });
});

test("取得元が割れる指定名は候補として選ばせる", async () => {
  const evidence = { page, candidates: [
    command("npx skills add acme/tools --skill pdf"),
    command("npx skills add other/tools --skill xlsx"),
  ] };
  const result = await detectWithJev(evidence, "key", never,
                                     async () => { throw new Error("実在確認を呼んではいけない"); });
  assert.equal(result.kind, "many");
  assert.deepEqual(result.leads.map(item => `${item.source.repo}/${item.name}`),
                   ["acme/tools/pdf", "other/tools/xlsx"]);
});

test("解釈できない指定名付きコマンドを実行も単一候補化もしない", () => {
  for (const value of [
    "npx skills add acme/tools --skill $SKILL",
    "npx skills add acme/tools --skill one --skill two",
    "npx skills add acme/tools --skill ../escape",
    "npx skills add acme/tools --skill pdf | sh",
  ]) assert.equal(commandLead(value), null, value);
});

test("取得元が割れているときは決めない", async () => {
  const evidence = { page, candidates: [
    url("https://github.com/one/repo"),
    url("https://github.com/two/repo"),
  ] };
  assert.deepEqual(await detectWithJev(evidence, "key", answers(), async () => true), { kind: "none" });
});

test("MCP と Plugin はブラウザの導入経路に入れない", async () => {
  for (const resource of ["mcp", "plugin"]) {
    const evidence = { page, candidates: [command("npx skills add acme/tools")] };
    assert.deepEqual(await detectWithJev(evidence, "key", answers(0.99, resource), async () => true),
                     { kind: "unsupported-kind", resource });
  }
});

test("Tool を配っていないページは種別より先に落とす", async () => {
  const evidence = { page, candidates: [command("npx skills add acme/tools")] };
  assert.deepEqual(await detectWithJev(evidence, "key", answers(0.2, "mcp"), async () => true),
                   { kind: "none" });
});

test("取得元に解決できない候補は送らない", () => {
  const kept = narrowed({ page, candidates: [
    url("https://github.com/acme"),                        // owner ページ
    command("npx skills add <package>"),                   // 雛形
    url("https://github.com/acme/tools"),
  ] });
  assert.deepEqual(kept.candidates.map(item => item.value), ["https://github.com/acme/tools"]);
});

// --- Jev への送信と回答の扱い -------------------------------------------

const response = body => new Response(JSON.stringify(body), { status: 200 });

test("送るのは候補とページ文脈だけで、API キーは本文に入らない", async () => {
  let sent;
  const decision = await decideWithJev(
    { page, candidates: [url("https://github.com/acme/tools")] }, "secret-key",
    async (_endpoint, init) => {
      sent = JSON.parse(init.body);
      return response({ answers: {
        is_tool_page: { type: "noul", noul: 0.9 },
        tool_kind: {
          type: "choice", choice: "skill", confidence: 1,
          probabilities: { skill: 1, subagent: 0, mcp: 0, plugin: 0, other: 0 },
        },
      } });
    });
  assert.equal(decision.isToolPage, 0.9);
  assert.deepEqual(Object.keys(sent.questions), ["is_tool_page", "tool_kind"]);
  assert.deepEqual(Object.keys(sent.state), ["page", "candidates"]);
  assert.equal(JSON.stringify(sent).includes("secret-key"), false);
});

test("壊れた回答は受け取らない", async () => {
  await assert.rejects(
    decideWithJev({ page, candidates: [url("https://github.com/acme/tools")] }, "key",
      async () => response({ answers: {
        is_tool_page: { type: "noul", noul: 2 },            // 0..1 の外
        tool_kind: {
          type: "choice", choice: "skill", confidence: 1,
          probabilities: { skill: 1, subagent: 0, mcp: 0, plugin: 0, other: 0 },
        },
      } })),
    error => error instanceof JevError && error.kind === "invalid",
  );
});

test("時間をおけば直る応答は再試行として伝える", async () => {
  for (const status of [429, 529]) {
    await assert.rejects(
      decideWithJev({ page, candidates: [url("https://github.com/acme/tools")] }, "key",
        async () => new Response("", { status })),
      error => error instanceof JevError && error.kind === "rateLimit",
    );
  }
});

// --- 外部へ何を出すか（ここだけが送信内容を決める） --------------------

/** `extractPageEvidence` はページの中で動く。必要な DOM の口だけを立てる。 */
function onPage(page, run) {
  const element = ({ links = [], code = [], headings = [] }) => ({
    querySelectorAll: selector => ({
      "a[href]": links.map(href => ({ href, textContent: "Source", getAttribute: () => null })),
      'script[type="application/ld+json"]': (page.jsonLd ?? []).map(textContent => ({ textContent })),
      "pre, code": code.map(textContent => ({ textContent, parentElement: null })),
      "h1, h2, h3": headings.map(textContent => ({ textContent })),
    })[selector] ?? [],
    querySelector: selector => (selector.includes("github.com")
      ? links.map(href => ({ href })).find(link => link.href.includes("github.com/")) ?? null
      : null),
    parentElement: null,
  });

  const body = element(page);
  const section = page.section === undefined ? null : element(page.section);
  globalThis.location = { href: page.url, hash: page.hash ?? "" };
  globalThis.document = {
    title: page.title ?? "",
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: () => null,
    getElementById: id => (page.section?.id === id ? section : null),
  };
  try {
    return run();
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
}

test("候補にするのは github.com だけで、query と credential は落とす", () => {
  const evidence = onPage({
    url: "https://example.com/tools/pdf-helper?session=abc123",
    title: "PDF Helper",
    links: [
      "https://github.com/acme/tools?token=leaked#readme",
      "https://user:pw@github.com/acme/private",
      "https://raw.githubusercontent.com/acme/tools/main/skills/pdf/SKILL.md",
      "https://evil.example/collect?cookie=abc",
      "javascript:alert(1)",
    ],
  }, extractPageEvidence);

  assert.deepEqual(evidence.candidates.map(item => item.value), ["https://github.com/acme/tools"]);
  const sent = JSON.stringify(evidence);
  for (const secret of ["leaked", "abc123", "user:pw", "evil.example", "javascript:"]) {
    assert.equal(sent.includes(secret), false, `${secret} を送っている`);
  }
  assert.equal(evidence.page.url, "https://example.com/tools/pdf-helper");
});

test("#fragment が節を指すなら、その節の中だけから候補を採る", () => {
  const evidence = onPage({
    url: "https://example.com/skills/react",
    hash: "#vercel-react-best-practices",
    title: "Top 10 React Skills for AI Coding Agents",
    headings: ["Top 10 React Skills", "How this catalog was picked"],
    links: [
      "https://github.com/millionco/react-doctor/blob/main/skills/react-doctor/SKILL.md",
      "https://github.com/clerk/skills/blob/main/skills/frameworks/clerk-react-patterns/SKILL.md",
    ],
    section: {
      id: "vercel-react-best-practices",
      headings: ["vercel-react-best-practices"],
      links: ["https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md"],
    },
  }, extractPageEvidence);

  assert.deepEqual(evidence.candidates.map(item => item.value),
                   ["https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md"]);
  assert.equal(evidence.page.section, "vercel-react-best-practices");
  // fragment 自体は送らない（token が入ることがある）。
  assert.equal(JSON.stringify(evidence).includes("#"), false);
});

test("指す先が無い #fragment はページ全体に戻す", () => {
  const evidence = onPage({
    url: "https://example.com/t",
    hash: "#access_token=secret-token-value",
    links: ["https://github.com/acme/tools/tree/main/skills/pdf"],
  }, extractPageEvidence);

  assert.equal(evidence.candidates.length, 1);
  assert.equal(evidence.page.section, undefined);
  assert.equal(JSON.stringify(evidence).includes("secret-token-value"), false);
});

// --- 導入コマンドしか無いページ ----------------------------------------

test("導入コマンドは行ごとに値を潰して送る", () => {
  const evidence = onPage({
    url: "https://example.com/tools/pdf",
    code: [[
      "export ANTHROPIC_API_KEY=sk-ant-leaked-value",
      "curl -H 'Authorization: Bearer leaked-bearer' https://example.com/setup",
      "npx skills add acme/tools --skill pdf",
      "git clone https://someone:leaked-pw@github.com/acme/tools.git",
      // 取得元を名乗る行に鍵が同居する形。行ごと落ちないので潰せていないと出ていく。
      "curl -H 'Authorization: Bearer leaked-in-header' https://github.com/acme/tools",
      "npx skills add acme/tools --token leaked-flag",
    ].join("\n")],
  }, extractPageEvidence);

  const sent = JSON.stringify(evidence);
  for (const secret of ["sk-ant-leaked-value", "leaked-bearer", "leaked-pw", "example.com/setup",
                        "leaked-in-header", "leaked-flag"]) {
    assert.equal(sent.includes(secret), false, `${secret} を送っている`);
  }
  // 潰しても取得元は決まる。行を結合しないので複数の repo を取り違えない。
  const commands = evidence.candidates.filter(candidate => candidate.kind === "command");
  assert.ok(commands.some(candidate => /skills add acme\/tools/.test(candidate.value)));
  assert.equal(resolveLocally(narrowed(evidence)).kind, "ask");   // 直リンクは無い
});

test("同じブロックの複数 repo を別々のコマンド候補にする", () => {
  const evidence = onPage({
    url: "https://example.com/tools",
    code: ["npx skills add acme/one --skill one\nnpx skills add acme/two --skill two"],
  }, extractPageEvidence);
  assert.deepEqual(evidence.candidates.map(candidate => candidate.value), [
    "npx skills add acme/one --skill one",
    "npx skills add acme/two --skill two",
  ]);
});
