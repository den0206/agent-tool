const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detectPage, kindOf, lead, proofUrls, verifiedPage } = require("../out/core/detect.js");
const { placement, rootOf, splitRoot, targets, SHARED_CONFIG_DIR, CONFIG_DIRS } =
  require("../out/core/placement.js");
const { decode, ledger, ledgerPath, LEDGER_DIR } = require("../out/core/ledger.js");
const { add, isRemovable, MAX_BROWSER_COLLECTION_ENTRIES } =
  require("../out/core/collection.js");
const { treeHash } = require("../out/core/hash.js");
const { PAGE_LIMIT } = require("../out/core/limits.js");

// --- 検知 ---------------------------------------------------------------

test("ブラウザの JSON 読み込みは上限を超えたら中止する", async () => {
  const { fetchJson, readText } = await import("../out/web/browser/fetch.js");
  let cancelled = false;
  let reads = 0;
  const response = {
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => reads++ === 0
          ? { done: false, value: new Uint8Array(PAGE_LIMIT + 1) }
          : { done: true, value: undefined },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }),
    },
  };
  assert.equal(await fetchJson("https://api.github.com/example", async () => response), null);
  assert.equal(cancelled, true);

  const chunked = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5678"));
      controller.close();
    },
  }));
  assert.equal(await readText(chunked, 7), null);
});

/** 入れる前に何をするものかを出す。読むのは frontmatter の先頭 4 KB だけ。 */
test("導入前の説明は SKILL.md の先頭だけを読む", async () => {
  const { description } = await import("../out/web/browser/fetch.js");
  const found = lead("https://github.com/o/r/tree/main/skills/pdf");
  const original = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(url);
      return new Response("---\nname: pdf\ndescription: fills forms\n---\n" + "x".repeat(200_000));
    };
    assert.equal(await description(found), "fills forms");
    assert.match(seen[0], /raw\.githubusercontent\.com\/o\/r\/main\/skills\/pdf\/SKILL\.md$/);

    // 閉じ `---` が 4 KB の外にあるものは「説明なし」と混ぜず、出さない。
    globalThis.fetch = async () => new Response("---\n" + "# ".repeat(4000) + "\ndescription: late\n---\n");
    assert.equal(await description(found), null);

    globalThis.fetch = async () => new Response("nope", { status: 404 });
    assert.equal(await description(found), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("パス名から Skill と Subagent を当てる", () => {
  assert.equal(kindOf(["skills", "pdf"]), "skill");
  assert.equal(kindOf(["agents", "reviewer.md"]), "subagent");
  assert.equal(kindOf(["subagents", "reviewer.md"]), "subagent");
});

/** Rule は D-20 により URL からの導入対象外。検知しない。 */
test("Rule は URL から検知しない", () => {
  assert.equal(kindOf(["rules", "testing.md"]), null);
  assert.equal(kindOf([".claude", "rules", "testing.md"]), null);
  assert.equal(kindOf([".cursor", "rules", "style.mdc"]), null);
  // ただし "rules" という語そのものは落とさない。`skills/` の下なら Skill のまま。
  assert.equal(kindOf(["skills", "rules", "SKILL.md"]), "skill");
  assert.equal(kindOf(["agents", "rules", "x.md"]), "subagent");
});

test("Plugin と MCP は候補にしない", () => {
  assert.equal(kindOf(["plugins", "foo"]), null);
  assert.equal(kindOf([".claude-plugin", "plugin.json"]), null);
  assert.equal(kindOf(["src", "index.ts"]), null);
  // plugins を含むなら skills があっても拾わない
  assert.equal(kindOf(["plugins", "foo", "skills", "bar"]), null);
});

test("Skill のディレクトリ URL は SKILL.md を根拠にする", () => {
  const found = lead("https://github.com/owner/repo/tree/main/skills/pdf");
  assert.equal(found.kind, "skill");
  assert.equal(found.name, "pdf");
  assert.deepEqual(found.proofs, ["skills/pdf/SKILL.md"]);
  assert.deepEqual(proofUrls(found), [
    "https://raw.githubusercontent.com/owner/repo/main/skills/pdf/SKILL.md",
  ]);
});

test("SKILL.md を直接指されたら親を採る", () => {
  const found = lead("https://github.com/owner/repo/blob/main/skills/pdf/SKILL.md");
  assert.equal(found.name, "pdf");
  assert.deepEqual(found.proofs, ["skills/pdf/SKILL.md"]);
});

/**
 * GitHub は `/blob/<ref>/<ディレクトリ>` を `/tree/` の表示へ読み替えるので、
 * Skill ディレクトリを `/blob/` で案内しているカタログがある（実測: aitmpl.com）。
 * `blob` を文字どおり「ファイル」と読むと、名前も subdir も 1 段ずれ、raw が 404 になる。
 */
test("拡張子の無い blob URL はディレクトリとして読む", () => {
  const found = lead("https://github.com/owner/repo/blob/main/cli-tool/components/skills/design/frontend");
  assert.equal(found.name, "frontend");
  assert.equal(found.source.subdir, "cli-tool/components/skills/design/frontend");
  assert.deepEqual(found.proofs, ["cli-tool/components/skills/design/frontend/SKILL.md"]);
  // 拡張子があるものは今までどおりファイルとして読む。
  assert.equal(lead("https://github.com/owner/repo/blob/main/skills/pdf/SKILL.md").name, "pdf");
});

test("Subagent はファイル指定だけを受ける", () => {
  const file = lead("https://github.com/owner/repo/blob/main/agents/reviewer.md");
  assert.equal(file.kind, "subagent");
  assert.equal(file.name, "reviewer");
  assert.deepEqual(file.proofs, ["agents/reviewer.md"]);
  // ディレクトリだと中のファイル名が分からず確認できない
  assert.equal(lead("https://github.com/owner/repo/tree/main/agents"), null);
});

/** Rule は D-20 により URL からの導入対象外。lead も返さない。 */
test("Rule の URL は lead を返さない", () => {
  assert.equal(lead("https://github.com/owner/repo/blob/main/.claude/rules/testing.md"), null);
  assert.equal(lead("https://github.com/owner/repo/blob/main/.cursor/rules/style.mdc"), null);
});

test("カタログはスキル名があるときだけ候補にする", () => {
  const found = lead("https://skills.sh/owner/repo/grilling");
  assert.equal(found.kind, "skill");
  assert.equal(found.name, "grilling");
  assert.deepEqual(found.proofs, []);            // 実在確認は不要
  assert.equal(lead("https://skills.sh/owner/repo"), null);
});

test("content script の URL と JSON-LD から検知する", () => {
  const found = detectPage("https://agentsdirectory.dev/skills/pdf", `
    <script type="application/ld+json">{"codeRepository":"https://github.com/acme/tools/tree/main/skills/pdf"}</script>
  `);
  assert.deepEqual(found, {
    url: "https://github.com/acme/tools/tree/main/skills/pdf",
    source: { repo: "acme/tools", branch: "main", subdir: "skills/pdf", branchAmbiguous: true },
    kind: "skill", name: "pdf", proofs: ["skills/pdf/SKILL.md"],
  });
});

test("展開できないカタログ項目は検知しない", async () => {
  const found = await verifiedPage("https://agentsdirectory.dev/skills/azure-rbac", `
    <script type="application/ld+json">{"url":"https://skills.sh/microsoft/azure-skills/azure-rbac"}</script>
  `, async candidate => {
    assert.equal(candidate.name, "azure-rbac");
    return false;
  });
  assert.equal(found, null);
});

test("対応外の URL とリポジトリのトップは拾わない", () => {
  assert.equal(lead("https://example.com/skills/pdf"), null);
  assert.equal(lead("https://github.com/owner/repo"), null);
  assert.equal(lead("https://github.com/owner/repo/issues/1"), null);
  assert.equal(lead(""), null);
});

// --- 配置 ---------------------------------------------------------------

test("Skill の導入先は Claude / Cursor / Codex", () => {
  assert.deepEqual(targets("skill"), ["claude", "cursor", "codex"]);
});

test("Subagent の導入先は Claude と Cursor だけ", () => {
  assert.deepEqual(targets("subagent"), ["claude", "cursor"]);
});

test("共有ストアがあれば Cursor と Codex は同じ場所に置く", () => {
  for (const agent of ["cursor", "codex"]) {
    assert.deepEqual(placement(agent, "skill", "pdf", true),
      { configDir: SHARED_CONFIG_DIR, sub: "skills", entry: "pdf", isDirectory: true });
  }
});

test("共有ストアが無ければ各エージェント直下へ退避する", () => {
  assert.equal(rootOf(placement("cursor", "skill", "pdf", false)), ".cursor/skills");
  assert.equal(rootOf(placement("codex", "skill", "pdf", false)), ".codex/skills");
});

test("Claude は共有ストアを読まないので常に自分の下へ置く", () => {
  // 共有ストアを許可済みでも Claude はそこを読まない。
  assert.equal(rootOf(placement("claude", "skill", "pdf", true)), ".claude/skills");
});

test("Subagent は .md ファイルとして置く", () => {
  assert.deepEqual(placement("claude", "subagent", "reviewer", true),
    { configDir: ".claude", sub: "agents", entry: "reviewer.md", isDirectory: false });
});

test("利用者に選ばせるのは設定ディレクトリだけ", () => {
  // `skills` と `agents` はそこから辿る。ピッカーはエージェントごとに 1 回で済む。
  assert.deepEqual([...CONFIG_DIRS], [".claude", ".cursor", ".codex", ".agents"]);
  for (const agent of ["claude", "cursor", "codex"]) {
    for (const kind of ["skill", "subagent"]) {
      const where = placement(agent, kind, "x", false);
      if (where === null) continue;
      assert.ok(CONFIG_DIRS.includes(where.configDir), `${agent} ${kind}`);
    }
  }
});

test("ルートは設定ディレクトリと置き場に割り戻せる", () => {
  const where = placement("claude", "skill", "pdf", false);
  assert.deepEqual(splitRoot(rootOf(where)), { configDir: ".claude", sub: "skills" });
  assert.deepEqual(splitRoot(".agents/skills"), { configDir: ".agents", sub: "skills" });
});

test("非対応の組み合わせには置き場を返さない", () => {
  assert.equal(placement("codex", "subagent", "reviewer", false), null);
  assert.equal(placement("gemini", "skill", "pdf", false), null);
});

// --- 台帳 ---------------------------------------------------------------

test("台帳は取得元と commit SHA だけを持つ", () => {
  const entry = ledger("pdf", "skill", { repo: "owner/repo", branch: "main", subdir: "skills/pdf" }, "abc123");
  assert.deepEqual(entry,
    { name: "pdf", kind: "skill", repo: "owner/repo", branch: "main", subdir: "skills/pdf", sha: "abc123" });
  assert.equal("pinned" in entry, false);
  assert.equal("disabled" in entry, false);
  assert.equal("treeHash" in entry, false);
});

test("未指定のキーは書き出さない", () => {
  assert.deepEqual(ledger("pdf", "skill", { repo: "owner/repo" }),
    { name: "pdf", kind: "skill", repo: "owner/repo" });
});

test("台帳の置き場はルート直下の隠しディレクトリ", () => {
  assert.equal(LEDGER_DIR, ".agent-tool");
  assert.equal(ledgerPath("pdf"), ".agent-tool/pdf.json");
});

test("往復しても同じ台帳になる", () => {
  const entry = ledger("pdf", "skill", { repo: "owner/repo", branch: "main" }, "abc");
  assert.deepEqual(decode(JSON.parse(JSON.stringify(entry))), entry);
});

test("壊れた台帳は読まない", () => {
  for (const broken of [null, [], "x", 1, {}, { name: "pdf" },
                        { name: "pdf", kind: "skill", repo: "no-slash" },
                        { name: "pdf", kind: "plugin", repo: "owner/repo" },
                        { name: "", kind: "skill", repo: "owner/repo" }]) {
    assert.equal(decode(broken), null, JSON.stringify(broken));
  }
});

// --- 収集一覧 -----------------------------------------------------------

const collected = (name, at) => ({
  name, kind: "skill", agent: "claude", root: ".claude/skills",
  repo: "owner/repo", treeHash: `hash-${name}`, installedAt: at,
});

test("同じ導入先の同名は 1 件に保つ", () => {
  const list = add([collected("pdf", 1)], { ...collected("pdf", 2), treeHash: "new" });
  assert.equal(list.length, 1);
  assert.equal(list[0].treeHash, "new");
});

test("上限を超えたら古い順に捨てる", () => {
  let list = [];
  for (let index = 0; index < MAX_BROWSER_COLLECTION_ENTRIES + 1; index++) {
    list = add(list, collected(`skill-${index}`, index));
  }
  assert.equal(list.length, MAX_BROWSER_COLLECTION_ENTRIES);
  assert.equal(list[0].name, "skill-1");                 // 最古が落ちた
  assert.equal(list[list.length - 1].name, `skill-${MAX_BROWSER_COLLECTION_ENTRIES}`);
});

test("実体ツリー hash が一致するときだけ削除を許す", () => {
  const list = [collected("pdf", 1)];
  const entry = list[0];
  assert.equal(isRemovable(entry, "hash-pdf"), true);
  assert.equal(isRemovable(entry, "changed"), false);     // 手で書き換えられた
  assert.equal(isRemovable(undefined, "hash-pdf"), false); // 自分が入れたものではない
});

// --- ツリー hash --------------------------------------------------------

const bytes = text => new TextEncoder().encode(text);

test("走査順が違っても同じ hash になる", async () => {
  const a = [{ path: "SKILL.md", bytes: bytes("one") }, { path: "b/c.txt", bytes: bytes("two") }];
  assert.equal(await treeHash(a), await treeHash([...a].reverse()));
});

test("内容もパスも hash に効く", async () => {
  const base = [{ path: "SKILL.md", bytes: bytes("one") }];
  assert.notEqual(await treeHash(base), await treeHash([{ path: "SKILL.md", bytes: bytes("two") }]));
  assert.notEqual(await treeHash(base), await treeHash([{ path: "OTHER.md", bytes: bytes("one") }]));
});

test("長さを混ぜるので境界をずらしても衝突しない", async () => {
  const first = [{ path: "a", bytes: bytes("xy") }, { path: "b", bytes: bytes("z") }];
  const second = [{ path: "a", bytes: bytes("x") }, { path: "b", bytes: bytes("yz") }];
  assert.notEqual(await treeHash(first), await treeHash(second));
});

// --- カタログの実体を探す -----------------------------------------------

const { locateSkill } = require("../out/core/detect.js");
const file = (path, body = "") => ({ path, bytes: new TextEncoder().encode(body) });

test("ディレクトリ名が一致すればそれを採る", () => {
  assert.deepEqual(locateSkill([
    file("skills/pdf/SKILL.md", "---\nname: pdf\n---\n"),
    file("skills/other/SKILL.md", "---\nname: other\n---\n"),
  ], "pdf"), ["skills", "pdf"]);
});

test("ディレクトリ名が違えば frontmatter の name で探す", () => {
  // skills.sh は vercel-react-best-practices と出すが、実体は skills/react-best-practices。
  assert.deepEqual(locateSkill([
    file("skills/react-best-practices/SKILL.md", "---\nname: vercel-react-best-practices\n---\n"),
    file("skills/deploy/SKILL.md", "---\nname: deploy-to-vercel\n---\n"),
  ], "vercel-react-best-practices"), ["skills", "react-best-practices"]);
});

test("候補が複数あれば浅い方を採る", () => {
  assert.deepEqual(locateSkill([
    file("examples/nested/pdf/SKILL.md", "---\nname: pdf\n---\n"),
    file("skills/pdf/SKILL.md", "---\nname: pdf\n---\n"),
  ], "pdf"), ["skills", "pdf"]);
});

test("どちらでも当たらなければ null", () => {
  assert.equal(locateSkill([file("skills/other/SKILL.md", "---\nname: other\n---\n")], "pdf"), null);
  assert.equal(locateSkill([file("README.md", "x")], "pdf"), null);
  assert.equal(locateSkill([], "pdf"), null);
});

test("リポジトリ直下の SKILL.md は候補にしない", () => {
  // 親ディレクトリが無いと名前が決まらない。
  assert.equal(locateSkill([file("SKILL.md", "---\nname: pdf\n---\n")], "pdf"), null);
});

// --- カタログの予約パス -------------------------------------------------

const { catalog, fromJsonLd, needsPage, SUPPORTED_SITES } = require("../out/core/github.js");
const { skillIndex } = require("../out/core/detect.js");
const { listSkills, listFiles, fetchFiles } = require("../out/core/tree.js");

test("skills.sh の site は GitHub の取得元ではない", () => {
  // /site/<ドメイン>/<名前> は GitHub 以外が配っているもの。
  assert.equal(catalog("https://www.skills.sh/site/open.feishu.cn/lark-vc-agent"), null);
  assert.equal(lead("https://www.skills.sh/site/open.feishu.cn/lark-vc-agent"), null);
});

test("www つきのカタログも読む", () => {
  const found = lead("https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices");
  assert.equal(found.source.repo, "vercel-labs/agent-skills");
  assert.equal(found.name, "vercel-react-best-practices");
});

test("対応サイトの複数 Tool を検知し、導入先を選べる", () => {
  const fixtures = [
    ["GitHub Skill", "https://github.com/acme/tools/tree/main/skills/pdf", "skill", "pdf"],
    ["GitHub Skill", "https://github.com/acme/tools/tree/main/skills/release", "skill", "release"],
    ["GitHub Subagent", "https://github.com/acme/tools/blob/main/agents/reviewer.md", "subagent", "reviewer"],
    ["GitHub Subagent", "https://github.com/acme/tools/blob/main/subagents/planner.md", "subagent", "planner"],
    ["skills.sh", "https://skills.sh/acme/tools/pdf", "skill", "pdf"],
    ["skills.sh", "https://skills.sh/acme/tools/release", "skill", "release"],
    ["Agents Directory", "https://agentsdirectory.dev/skills/pdf", "skill", "pdf"],
    ["Agents Directory", "https://agentsdirectory.dev/skills/release", "skill", "release"],
  ];

  for (const [site, url, kind, name] of fixtures) {
    const resolved = needsPage(url) === null ? url : fromJsonLd(
      `<script type="application/ld+json">{"codeRepository":"https://github.com/acme/tools/tree/main/skills/${name}"}</script>`,
    );
    const found = lead(resolved);
    assert.equal(found?.kind, kind, site);
    assert.equal(found?.name, name, site);
    // File System Access API へ渡す直前の導入リクエスト。テストは実ファイルを書かない。
    const agent = targets(found.kind)[0];
    const destination = placement(agent, found.kind, found.name, false);
    assert.ok(destination !== null, site);
    assert.equal(destination.entry, found.kind === "skill" ? name : `${name}.md`, site);
  }
});

test("対応サイト一覧は GitHub とカタログ宣言から作る", () => {
  assert.deepEqual(SUPPORTED_SITES, [
    { label: "GitHub", url: "https://github.com/" },
    { label: "skills.sh", url: "https://skills.sh/" },
    { label: "Agents Directory", url: "https://agentsdirectory.dev/" },
  ]);
});

// --- Skill が並ぶディレクトリ -------------------------------------------

/**
 * 置き場そのものを指されたら、1 件ではなく一覧を出す。
 * 大きいリポジトリはアーカイブが取得上限を超えるので、ここが唯一の入口になる。
 */
test("置き場を指す URL は一覧の足がかりにする", () => {
  assert.deepEqual(skillIndex("https://github.com/acme/tools/tree/main/skills"), {
    url: "https://github.com/acme/tools/tree/main/skills",
    source: { repo: "acme/tools", branch: "main", subdir: "skills", branchAmbiguous: true },
    subdir: "skills",
  });
  // Plugin の中の置き場も同じ。実体は Skill である。
  assert.equal(skillIndex("https://github.com/acme/tools/tree/main/plugins/x/skills").subdir,
    "plugins/x/skills");
  // カタログのリポジトリページは既定の置き場を見る。
  assert.deepEqual(skillIndex("https://www.skills.sh/acme/tools"),
    { url: "https://www.skills.sh/acme/tools", source: { repo: "acme/tools" }, subdir: "skills" });
});

test("1 件に決まる URL と対象外は一覧にしない", () => {
  assert.equal(skillIndex("https://github.com/acme/tools/tree/main/skills/pdf"), null);
  assert.equal(skillIndex("https://www.skills.sh/acme/tools/pdf"), null);
  // `/blob/` でも拡張子が無ければディレクトリと読む（GitHub も `/tree/` へ読み替える）。
  assert.equal(skillIndex("https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md"), null);
  assert.equal(skillIndex("https://github.com/acme/tools"), null);
  assert.equal(skillIndex("https://example.com/acme/tools/tree/main/skills"), null);
});

const tree = (paths, extra = {}) => ({
  ...extra,
  tree: paths.map(([path, size]) => size === undefined
    ? { path, type: "tree", sha: "x" }
    : { path, type: "blob", sha: "x", size }),
});

test("置き場の部分木だけを 1 回読んで列挙する", async () => {
  const seen = [];
  const got = await listSkills({ repo: "acme/tools", branch: "main" }, "skills", async url => {
    seen.push(url);
    return tree([["pdf/SKILL.md", 10], ["pdf/ref/a.md", 20], ["release/SKILL.md", 5]]);
  });
  // リポジトリ全体の tree は読まない。`<ref>:<パス>` で部分木を指す。
  assert.deepEqual(seen,
    ["https://api.github.com/repos/acme/tools/git/trees/main:skills?recursive=1"]);
  assert.deepEqual(got, [
    { name: "pdf", files: [{ path: "SKILL.md", size: 10 }, { path: "ref/a.md", size: 20 }] },
    { name: "release", files: [{ path: "SKILL.md", size: 5 }] },
  ]);
});

/** 押しても入らない行を並べない。 */
test("SKILL.md を持たないディレクトリと直下のファイルは出さない", async () => {
  const got = await listSkills({ repo: "acme/tools" }, "skills", async () =>
    tree([["README.md", 3], ["docs/notes.md", 4], ["pdf/SKILL.md", 10]]));
  assert.deepEqual(got.map(entry => entry.name), ["pdf"]);
});

test("切れた一覧と取れなかった応答は使わない", async () => {
  const full = [["pdf/SKILL.md", 10]];
  assert.deepEqual(await listSkills({ repo: "a/b" }, "skills", async () => tree(full, { truncated: true })), []);
  assert.deepEqual(await listSkills({ repo: "a/b" }, "skills", async () => null), []);
  assert.deepEqual(await listSkills({ repo: "a/b" }, "skills", async () => ({ message: "rate limited" })), []);
});

/**
 * 置き場が分かっていれば 1 件だけを読める。アーカイブが取得上限を超えるリポジトリで、
 * 単体ページからの導入がここを通る。
 */
test("置き場 1 つぶんのファイルを読む", async () => {
  const seen = [];
  const got = await listFiles({ repo: "acme/tools" }, "skills/pdf", async url => {
    seen.push(url);
    return tree([["SKILL.md", 10], ["ref/a.md", 20]]);
  });
  assert.deepEqual(seen,
    ["https://api.github.com/repos/acme/tools/git/trees/HEAD:skills/pdf?recursive=1"]);
  assert.deepEqual(got, [{ path: "SKILL.md", size: 10 }, { path: "ref/a.md", size: 20 }]);
  // SKILL.md が無ければ Skill の実体ではない。
  assert.equal(await listFiles({ repo: "a/b" }, "docs", async () => tree([["a.md", 1]])), null);
});

/** API の枠切れを「見つかりません」と言わない。利用者が直しようのない案内を出さない。 */
test("読めなかったことと Skill でないことを混ぜない", async () => {
  await assert.rejects(listFiles({ repo: "a/b" }, "skills/pdf", async () => null),
    /could not be read/);
  await assert.rejects(
    listFiles({ repo: "a/b" }, "skills/pdf", async () => ({ message: "API rate limit exceeded" })),
    /could not be read/);
  await assert.rejects(
    listFiles({ repo: "a/b" }, "skills/pdf", async () => tree([["SKILL.md", 1]], { truncated: true })),
    /could not be read/);
});

test("実体は raw から取り、branch が無ければ HEAD を使う", async () => {
  const seen = [];
  const files = await fetchFiles({ repo: "acme/tools" }, "skills/pdf",
    [{ path: "SKILL.md", size: 3 }, { path: "ref/a.md", size: 2 }], async url => {
      seen.push(url);
      return new Uint8Array([1, 2, 3]);
    });
  assert.deepEqual(seen, [
    "https://raw.githubusercontent.com/acme/tools/HEAD/skills/pdf/SKILL.md",
    "https://raw.githubusercontent.com/acme/tools/HEAD/skills/pdf/ref/a.md",
  ]);
  assert.deepEqual(files.map(file => file.path), ["SKILL.md", "ref/a.md"]);
});

/** 取り方が違うだけで、入ってくるものは同じ外部入力である。 */
test("ファイル単位の取得にもアーカイブと同じ上限を当てる", async () => {
  const nope = async () => assert.fail("上限を超えたら取りに行かない");
  const huge = [{ path: "SKILL.md", size: 21 * 1024 * 1024 }];
  await assert.rejects(fetchFiles({ repo: "a/b" }, "skills/pdf", huge, nope), /too large/);
  const many = Array.from({ length: 10_001 }, (unused, at) => ({ path: `f${at}`, size: 1 }));
  await assert.rejects(fetchFiles({ repo: "a/b" }, "skills/pdf", many, nope), /too many files/);
});

test("取れなかったファイルは黙って飛ばさない", async () => {
  await assert.rejects(
    fetchFiles({ repo: "a/b" }, "skills/pdf", [{ path: "SKILL.md", size: 3 }], async () => null),
    /could not be fetched/);
});

test("本文が上限を超えたら取得側の打ち切りを通す", async () => {
  await assert.rejects(
    fetchFiles({ repo: "a/b" }, "skills/pdf", [{ path: "SKILL.md", size: 1 }], async (url, limit) => {
      assert.equal(limit, 20 * 1024 * 1024);
      return "tooLarge";
    }),
    /too large/,
  );
});

// --- 設定されているフォルダの状態 ---------------------------------------

const { rootStateOf } = require("../out/core/placement.js");

test("名前が一致すればそのエージェントのもの", () => {
  assert.deepEqual(rootStateOf(".cursor", ".cursor"), { kind: "ok" });
});

test("別のフォルダが設定されていれば、その名前を返す", () => {
  // 絶対パスは取れないので、確かめられるのも見せられるのも名前だけ。
  assert.deepEqual(rootStateOf(".cursor", ".claude"), { kind: "mismatch", chosen: ".claude" });
  assert.deepEqual(rootStateOf(".cursor", "skills"), { kind: "mismatch", chosen: "skills" });
});

test("何も無ければ未設定", () => {
  assert.deepEqual(rootStateOf(".cursor", null), { kind: "unset" });
});
