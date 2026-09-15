const { strict: assert } = require("node:assert");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { discard, extract, fetchPage, identify, isSubagentMatter, safeJoin, singleTopLevel, stage } = require("../out/ide/fetcher.js");
const { PAGE_LIMIT } = require("../out/core/limits.js");
const { archiveUrl, catalog, fromJsonLd, narrowToSkill, needsPage, parseUrl, skillHint, sourceKey } = require("../out/core/github.js");
const { fakeEnv, makeDir, writeFileIn } = require("./helpers.js");
const { writeZip } = require("./zipFixture.js");

const code = expected => error => error.code === expected;

// --- GitHub URL ---

test("リポジトリ URL を読む", () => {
  assert.deepEqual(parseUrl("https://github.com/owner/repo"), { repo: "owner/repo" });
  assert.deepEqual(parseUrl("https://github.com/owner/repo.git"), { repo: "owner/repo" });
});

/** ブランチ名に "/" を含むと境界が確定できない。曖昧であることを持って返す。 */
test("tree 以下はブランチとサブディレクトリに割り、曖昧さを残す", () => {
  assert.deepEqual(parseUrl("https://github.com/owner/repo/tree/main/skills/pdf"),
    { repo: "owner/repo", branch: "main", subdir: "skills/pdf", branchAmbiguous: true });
  assert.deepEqual(parseUrl("https://github.com/owner/repo/tree/main"),
    { repo: "owner/repo", branch: "main", subdir: undefined, branchAmbiguous: false });
});

test("GitHub 以外と壊れた URL は受け取らない", () => {
  assert.equal(parseUrl("https://example.com/owner/repo"), null);
  assert.equal(parseUrl("https://github.com/owner"), null);
  assert.equal(parseUrl("https://github.com/owner/repo/raw/main"), null);
  assert.equal(parseUrl("https://github.com/own er/repo"), null);
  assert.equal(parseUrl("not a url"), null);
});

// --- カタログサイト ---

test("URL に owner/repo を含むカタログはネットワークに触れず解決する", () => {
  assert.deepEqual(parseUrl("https://www.skills.sh/anthropics/skills/frontend-design"),
    { repo: "anthropics/skills" });
  assert.equal(skillHint("https://skills.sh/anthropics/skills/frontend-design"), "frontend-design");
  assert.equal(needsPage("https://skills.sh/anthropics/skills/frontend-design"), null);
  assert.equal(catalog("https://skills.sh/agent/claude-code"), null);   // 予約パス
});

test("URL だけで決まらないカタログはページの URL を返す", () => {
  assert.equal(needsPage("https://agentsdirectory.dev/skills/frontend-design/"),
    "https://agentsdirectory.dev/skills/frontend-design/");
  assert.equal(needsPage("agentsdirectory.dev/skills/frontend-design"),
    "https://agentsdirectory.dev/skills/frontend-design");
  assert.equal(catalog("https://agentsdirectory.dev/skills/frontend-design/"), null);
  assert.equal(needsPage("https://example.com/skills/x"), null);        // 対応外のサイト
});

/** HTML の構造は見ない。読むのは schema.org の codeRepository / url だけ。 */
test("JSON-LD から取得元の URL を拾う", () => {
  const block = body => `<script type="application/ld+json">${body}</script>`;
  assert.equal(
    fromJsonLd(block(JSON.stringify([{ "@type": "SoftwareApplication",
      url: "https://www.skills.sh/anthropics/skills/frontend-design" }]))),
    "https://www.skills.sh/anthropics/skills/frontend-design");
  assert.equal(
    fromJsonLd(block(JSON.stringify({ "@graph": [{ codeRepository: "https://github.com/o/r" }] }))),
    "https://github.com/o/r");
  // 壊れたブロックで打ち切らず、後ろのブロックを読む
  assert.equal(fromJsonLd(block("{ broken") + block(JSON.stringify({ url: "https://github.com/o/r" }))),
    "https://github.com/o/r");
  // 自分自身や対応外の URL は解決にならない
  assert.equal(fromJsonLd(block(JSON.stringify({ url: "https://agentsdirectory.dev/skills/x" }))), null);
  assert.equal(fromJsonLd("<html>https://github.com/o/r</html>"), null);
});

test("カタログページは上限を超えたら読まない", async () => {
  const oversize = { ok: true, headers: { get: () => String(PAGE_LIMIT + 1) }, body: { cancel: async () => {} } };
  await assert.rejects(fetchPage("https://agentsdirectory.dev/skills/x", async () => oversize),
    code("FETCH_FAILED"));
  const missing = { ok: false, status: 404, headers: { get: () => null } };
  await assert.rejects(fetchPage("https://agentsdirectory.dev/skills/x", async () => missing),
    code("FETCH_FAILED"));
});

test("Content-Length がなくても読み込み中にページ上限を打ち切る", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const response = {
    ok: true,
    headers: new Map(),
    body: {
      cancel: async () => { cancelled = true; },
      async *[Symbol.asyncIterator]() { yield chunk; yield chunk; yield chunk; },
    },
  };
  await assert.rejects(fetchPage("https://agentsdirectory.dev/skills/x", async () => response),
    code("FETCH_FAILED"));
  assert.equal(cancelled, true);
});

/** 既定ブランチ名は推測しない。`main` と決め打つと `master` のリポジトリが取れない。 */
test("zipball の URL を組み立てる", () => {
  assert.equal(archiveUrl({ repo: "o/r" }), "https://github.com/o/r/archive/HEAD.zip");
  assert.equal(archiveUrl({ repo: "o/r", branch: "master" }),
    "https://github.com/o/r/archive/refs/heads/master.zip");
  assert.equal(archiveUrl({ repo: "o/r" }, "abc"), "https://github.com/o/r/archive/abc.zip");
});

test("registry.repos のキーはブランチ未指定を HEAD で表す", () => {
  assert.equal(sourceKey({ repo: "o/r" }), "o/r#HEAD");
  assert.equal(sourceKey({ repo: "o/r", branch: "dev" }), "o/r#dev");
});

// --- カタログの置き場を先に当てる ---

/**
 * カタログ URL は subdir を持たない。アーカイブを丸ごと持ってから探すと、
 * 大きいリポジトリは上限に当たって取り出せない（実測 105 MB のリポジトリで、
 * 欲しいのは 10 KB）。規約どおりの `skills/<名前>` を HEAD 1 回で先に確かめる。
 */
test("規約どおりの置き場に当たれば subdir を載せる", async () => {
  const seen = [];
  const source = await narrowToSkill({ repo: "o/r" }, "pdf", async url => {
    seen.push(url);
    return true;
  });
  assert.deepEqual(source, { repo: "o/r", subdir: "skills/pdf" });
  // 既定ブランチ名は推測しない。`HEAD` は raw でも解決する。
  assert.deepEqual(seen, ["https://raw.githubusercontent.com/o/r/HEAD/skills/pdf/SKILL.md"]);
});

/** カタログ名とディレクトリ名は一致しないことがある。外れは普通に起きる。 */
test("外れたら取得元を変えない", async () => {
  assert.deepEqual(await narrowToSkill({ repo: "o/r" }, "pdf", async () => false), { repo: "o/r" });
});

test("branch があればその ref で確かめる", async () => {
  const seen = [];
  await narrowToSkill({ repo: "o/r", branch: "dev" }, "pdf", async url => {
    seen.push(url);
    return false;
  });
  // どれも外れれば候補すべてを HEAD するが、ref はどれも branch を通す。
  assert.deepEqual(seen, [
    "https://raw.githubusercontent.com/o/r/dev/skills/pdf/SKILL.md",
    "https://raw.githubusercontent.com/o/r/dev/.agent-skills/pdf/SKILL.md",
  ]);
});

/**
 * `skills/` が外れたときだけ `.agent-skills/` を試す。実測: `akillness/jeo-skills`
 * は 250 件の Skill を `.agent-skills/<名前>/SKILL.md` に置いていて、規約どおりの
 * `skills/` は無い。圧縮 140 MB のためアーカイブ経路では tooLarge で落ちる。
 */
test("隠しディレクトリの置き場にも当たる", async () => {
  const seen = [];
  const source = await narrowToSkill({ repo: "o/r" }, "plannotator", async url => {
    seen.push(url);
    return url.endsWith("/.agent-skills/plannotator/SKILL.md");
  });
  assert.deepEqual(source, { repo: "o/r", subdir: ".agent-skills/plannotator" });
  assert.deepEqual(seen, [
    "https://raw.githubusercontent.com/o/r/HEAD/skills/plannotator/SKILL.md",
    "https://raw.githubusercontent.com/o/r/HEAD/.agent-skills/plannotator/SKILL.md",
  ]);
});

test("`skills/` が当たるなら隠しディレクトリは確かめない", async () => {
  const seen = [];
  const source = await narrowToSkill({ repo: "o/r" }, "pdf", async url => {
    seen.push(url);
    return true;                                 // 上の候補で短絡復帰する
  });
  assert.deepEqual(source, { repo: "o/r", subdir: "skills/pdf" });
  assert.equal(seen.length, 1);                  // 成功経路の HEAD 回数は変えない
});

test("すでに subdir が分かっているなら確かめない", async () => {
  const source = { repo: "o/r", subdir: "skills/a" };
  const nope = async () => assert.fail("確認してはいけない");
  assert.deepEqual(await narrowToSkill(source, "pdf", nope), source);
});

/** `..` や `/` を含む名前で置き場の外を指させない。確認そのものを行わない。 */
test("スキル名が無い・パス要素に使えない名前は確かめない", async () => {
  const nope = async () => assert.fail("確認してはいけない");
  for (const skill of [undefined, "..", "a/b", "a\\b", ".hidden", "", "a b"]) {
    assert.deepEqual(await narrowToSkill({ repo: "o/r" }, skill, nope), { repo: "o/r" }, String(skill));
  }
});

// --- Zip Slip ---

test("展開先の外へ出るパスを弾く", () => {
  const root = join(tmpdir(), "unpack");
  assert.equal(safeJoin(root, "../evil"), null);
  assert.equal(safeJoin(root, "a/../../evil"), null);
  assert.equal(safeJoin(root, "/etc/passwd"), join(root, "etc/passwd"));  // 先頭の / は落ちる
  assert.equal(safeJoin(root, "a\\b"), null);
  assert.equal(safeJoin(root, "C:/evil"), null);
  assert.equal(safeJoin(root, "ok/file.md"), join(root, "ok/file.md"));
});

// --- extract ---

test("zip を展開する", async () => {
  const env = fakeEnv();
  const archive = writeZip(join(makeDir(env.home), "a.zip"), [
    { name: "repo-main/SKILL.md", data: "---\nname: pdf\n---\n" },
  ]);
  const out = join(env.home, "out");
  await extract(archive, out);
  assert.ok(readFileSync(join(out, "repo-main", "SKILL.md"), "utf8").includes("name: pdf"));
});

/** アーカイブ 1 つで管理ルートの外へ書かれないこと。 */
test("展開先の外を指すエントリを拒否する", async () => {
  const env = fakeEnv();
  const archive = writeZip(join(makeDir(env.home), "evil.zip"), [
    { name: "../escaped.md", data: "x" },
  ]);
  await assert.rejects(extract(archive, join(env.home, "out")), code("FETCH_FAILED"));
  assert.equal(existsSync(join(env.home, "escaped.md")), false);
});

test("symlink は書かずに飛ばし、アーカイブごと諦めない", async () => {
  // 実在のスキル集はリポジトリ直下の CLAUDE.md を symlink にしていることがある。
  // それだけで取得を失敗させると、中のスキルが 1 つも入れられなくなる。
  const env = fakeEnv();
  const archive = writeZip(join(makeDir(env.home), "link.zip"), [
    { name: "repo-main/evil", data: "/etc/passwd", unixMode: 0o120777 },
    { name: "repo-main/skills/pdf/SKILL.md", data: "---\nname: pdf\n---\n" },
  ]);
  const out = join(env.home, "out");
  await extract(archive, out);
  assert.equal(existsSync(join(out, "repo-main", "evil")), false);
  assert.equal(existsSync(join(out, "repo-main", "skills", "pdf", "SKILL.md")), true);
});

// --- 種別判定 ---

test("SKILL.md があれば Skill として拾う", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "pdf"));
  writeFileIn(join(base, "SKILL.md"), "---\nname: pdf\ndescription: d\n---\n");
  assert.deepEqual(identify(base).map(c => [c.kind, c.name, c.description]), [["skill", "pdf", "d"]]);
});

/** frontmatter の name は取得先が書いた文字列。使えない名前はディレクトリ名に落とす。 */
test("パスに使えない name はディレクトリ名に落とす", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "safe"));
  writeFileIn(join(base, "SKILL.md"), "---\nname: ../../evil\n---\n");
  assert.equal(identify(base)[0].name, "safe");
});

test("tools を持つ .md は Subagent として拾う", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "agents"));
  writeFileIn(join(base, "reviewer.md"), "---\nname: reviewer\ntools: Read\n---\n");
  assert.deepEqual(identify(base).map(c => [c.kind, c.name]), [["subagent", "reviewer"]]);
});

/**
 * `tools:` は省略できる（省略 = 全ツール継承）。持っていることを条件にすると、
 * 実在する Subagent の多くが IDE 拡張から入らない。
 */
test("tools を省略した .md も Subagent として拾う", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "agents"));
  writeFileIn(join(base, "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews code\nmodel: sonnet\n---\n本文\n");
  assert.deepEqual(identify(base).map(c => [c.kind, c.name, c.description]),
    [["subagent", "reviewer", "reviews code"]]);
});

test("frontmatter を持たない .md は候補にしない", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "agents"));
  writeFileIn(join(base, "README.md"), "# 使い方\n\nここに説明を書く。\n");
  writeFileIn(join(base, "CONTRIBUTING.md"), "---\n見出しではない区切り\n");
  assert.deepEqual(identify(base), []);
});

test("description の無い frontmatter だけでは Subagent にしない", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "docs"));
  // 文書の先頭に title だけを置く形式は Subagent ではない。
  writeFileIn(join(base, "notes.md"), "---\ntitle: 設計メモ\nname: notes\n---\n");
  assert.deepEqual(identify(base), []);
});

test("Subagent の判定は純粋関数で、両拡張の条件を揃える", () => {
  assert.equal(isSubagentMatter({ tools: "Read" }), true);
  assert.equal(isSubagentMatter({ name: "x", description: "d" }), true);
  assert.equal(isSubagentMatter({ name: "x" }), false);
  assert.equal(isSubagentMatter({ description: "d" }), false);
  assert.equal(isSubagentMatter({}), false);
});

/**
 * `name` と `description` を持つ `.md` は Subagent とは限らない。frontmatter 付きの
 * 文書は普通にあるので、1 枚あるだけで `skills/` の中身が隠れてはいけない。
 */
test("frontmatter を持つ文書があっても skills/ の中身を隠さない", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "repo"));
  writeFileIn(join(base, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: PDF\n---\n");
  writeFileIn(join(base, "skills", "csv", "SKILL.md"), "---\nname: csv\ndescription: CSV\n---\n");
  writeFileIn(join(base, "CONTRIBUTING.md"),
    "---\nname: contributing\ndescription: how to help\n---\n# Hi\n");
  assert.deepEqual(identify(base).map(c => [c.kind, c.name]),
    [["skill", "csv"], ["skill", "pdf"]]);
});

test("skills/<category>/<name> の配置まで辿る", () => {
  const env = fakeEnv();
  const base = makeDir(join(env.home, "repo"));
  writeFileIn(join(base, "skills", "docs", "pdf", "SKILL.md"), "---\nname: pdf\n---\n");
  assert.deepEqual(identify(base).map(c => c.name), ["pdf"]);
});

test("zipball の 1 段目を剥がす", () => {
  const env = fakeEnv();
  const root = makeDir(join(env.home, "unpacked"));
  makeDir(join(root, "repo-main"));
  assert.equal(singleTopLevel(root), join(root, "repo-main"));
});

// --- ダウンロードの上限 ---

test("Content-Length が上限を超えていれば本文を読まない", async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", String(60 * 1024 * 1024)]]),
    body: { cancel: async () => { cancelled = true; } },
  });
  await assert.rejects(stage({ repo: "o/r" }, { fetchImpl }), /too large/);
  assert.equal(cancelled, true);
});

/** Content-Length が返らない場合の保険。 */
test("書き込み量でも上限を打ち切る", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    body: (async function* () { for (let i = 0; i < 60; i++) yield chunk; })(),
  });
  await assert.rejects(stage({ repo: "o/r" }, { fetchImpl }), /too large/);
});

// --- 取り出す範囲の symlink ---

/** zip の中身をそのまま返す `fetch`。stage の経路を通したいので本物の zip を流す。 */
const serveZip = archive => async () => ({
  ok: true, status: 200, headers: new Map(),
  body: (async function* () { yield readFileSync(archive); })(),
});

/**
 * symlink は展開していない。入れるものの中にあるまま候補に出すと、
 * 欠けたファイルごと導入が成功したように見える。
 */
test("取り出す候補の中に symlink があれば候補にしない", async () => {
  const env = fakeEnv();
  const archive = writeZip(join(makeDir(env.home), "inside.zip"), [
    { name: "repo-main/skills/pdf/SKILL.md", data: "---\nname: pdf\n---\n" },
    { name: "repo-main/skills/pdf/ref.md", data: "../../../etc/passwd", unixMode: 0o120777 },
  ]);
  await assert.rejects(
    stage({ repo: "o/r", subdir: "skills/pdf" }, { fetchImpl: serveZip(archive) }),
    /is a link and cannot be installed/);
});

test("取り出す範囲の外の symlink は取得を妨げない", async () => {
  const env = fakeEnv();
  const archive = writeZip(join(makeDir(env.home), "outside.zip"), [
    { name: "repo-main/CLAUDE.md", data: "skills/pdf/SKILL.md", unixMode: 0o120777 },
    { name: "repo-main/skills/pdf/SKILL.md", data: "---\nname: pdf\n---\n" },
  ]);
  const staging = await stage({ repo: "o/r", subdir: "skills/pdf" },
    { fetchImpl: serveZip(archive) });
  try {
    assert.deepEqual(staging.candidates.map(c => [c.kind, c.name]), [["skill", "pdf"]]);
  } finally {
    discard(staging);
  }
});

test("HTTP エラーは FETCH_FAILED にする", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, headers: new Map() });
  await assert.rejects(stage({ repo: "o/r" }, { fetchImpl }), code("FETCH_FAILED"));
});
