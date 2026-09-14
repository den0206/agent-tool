const { strict: assert } = require("node:assert");
const { join } = require("node:path");
const { test } = require("node:test");
const { disabledStore, registryFile, skillStore } = require("../out/ide/env.js");
const { inventory, hasUpdate } = require("../out/ide/inventory.js");
const { fakeEnv, makeDir, writeFileIn } = require("./helpers.js");

const skill = (root, name, description = "d") =>
  writeFileIn(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);

const seedRegistry = (env, registry) =>
  writeFileIn(registryFile(env), JSON.stringify({ schemaVersion: "1", ...registry }));

const find = (items, name) => items.find(item => item.name === name);

/** 実体と各エージェントのリンクは 1 行にまとめる。 */
test("同名のスキルを 1 件にまとめ、見えるエージェントを並べる", async () => {
  const env = fakeEnv();
  skill(skillStore(env), "shared");                       // ~/.agents/skills（Cursor / Codex が直読み）
  skill(join(env.home, ".claude/skills"), "shared");      // Claude 用のリンク先
  const { items } = await inventory({ env, projectPath: null });
  const item = find(items, "shared");
  assert.equal(item.kind, "skill");
  assert.deepEqual(item.agents.sort(), ["claude", "codex", "cursor"]);
  assert.equal(item.enabled, true);
  assert.equal(item.summary, "d");
});

/** 退避先を読まないと、無効化したものを再有効化する手段がなくなる。 */
test("無効化した実体を退避先から拾う", async () => {
  const env = fakeEnv();
  skill(disabledStore(env), "parked");
  const { items } = await inventory({ env, projectPath: null });
  const item = find(items, "parked");
  assert.equal(item.enabled, false);
  assert.deepEqual(item.agents, []);        // 退避中はどのエージェントからも見えない
});

/** 同梱ルートにしか無いものだけ bundled。ユーザーが同名を持てばそれは自分のもの。 */
test("同梱スキルと自分のスキルを取り違えない", async () => {
  const env = fakeEnv();
  skill(join(env.home, ".cursor/skills-cursor"), "canvas");
  skill(join(env.home, ".cursor/skills-cursor"), "both");
  skill(skillStore(env), "both");
  const { items } = await inventory({ env, projectPath: null });
  assert.equal(find(items, "canvas").origin, "bundled");
  assert.equal(find(items, "both").origin, "user");
});

test("registry に載っているものは managed になる", async () => {
  const env = fakeEnv();
  skill(skillStore(env), "mine");
  seedRegistry(env, { resources: [{ name: "mine", kind: "skill", repo: "https://example.com/mine" }] });
  const item = find((await inventory({ env, projectPath: null })).items, "mine");
  assert.equal(item.origin, "managed");
  assert.equal(item.repoUrl, "https://example.com/mine");
});

/** リンク切れは「有効」にしない。エージェントは読み込めない。 */
test("リンク切れのスキルはどのエージェントにも数えない", async () => {
  const env = fakeEnv();
  makeDir(join(env.home, ".claude/skills"));
  require("node:fs").symlinkSync(join(env.home, "gone"), join(env.home, ".claude/skills/dead"), "junction");
  const item = find((await inventory({ env, projectPath: null })).items, "dead");
  assert.deepEqual(item.agents, []);
});

test("projectPath が null ならプロジェクトは走査しない", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  skill(join(project, ".claude/skills"), "local-skill");
  const { items } = await inventory({ env, projectPath: null });
  assert.equal(find(items, "local-skill"), undefined);
});

test("プロジェクトのスキルを project スコープで返す", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  skill(join(project, ".claude/skills"), "local-skill");
  skill(join(project, "apps/web/.claude/skills"), "deploy");
  const { items } = await inventory({ env, projectPath: project });
  assert.equal(find(items, "local-skill").scope, "project");
  // サブディレクトリのスキルは修飾名で区別する。
  assert.equal(find(items, "apps/web:deploy").scope, "project");
});

/**
 * Claude Rule と Cursor Rule の両方が Dashboard に出る。Rule は URL からの導入経路を
 * 持たないので `origin: "user"` になり、pin と更新は出さない（D-20）。
 */
test("Rule は Claude と Cursor の両方を user スコープで拾う", async () => {
  const env = fakeEnv();
  writeFileIn(join(env.home, ".claude", "rules", "testing.md"),
    "---\ndescription: run tests\n---\n");
  writeFileIn(join(env.home, ".cursor", "rules", "style.mdc"),
    "---\ndescription: Style guide\n---\n");
  const { items } = await inventory({ env, projectPath: null });
  const testing = find(items, "testing");
  const style = find(items, "style");
  assert.equal(testing.kind, "rule");
  assert.equal(testing.scope, "user");
  assert.equal(testing.origin, "user");
  assert.deepEqual(testing.agents, ["claude"]);
  assert.equal(style.kind, "rule");
  assert.deepEqual(style.agents, ["cursor"]);
});

test("プロジェクトの Rule も両エージェント分を project スコープで返す", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  writeFileIn(join(project, ".claude", "rules", "api.md"),
    "---\ndescription: API rules\n---\n");
  writeFileIn(join(project, ".cursor", "rules", "ui.mdc"),
    "---\ndescription: UI rules\n---\n");
  const { items } = await inventory({ env, projectPath: project });
  assert.equal(find(items, "api").scope, "project");
  assert.equal(find(items, "ui").scope, "project");
});

test("MCP サーバーを設定ファイルから読む", async () => {
  const env = fakeEnv();
  writeFileIn(join(env.home, ".cursor/mcp.json"),
    '{ // comment\n "mcpServers": { "figma": { "command": "npx", "args": ["-y", "figma"] } } }');
  const item = find((await inventory({ env, projectPath: null })).items, "figma");
  assert.equal(item.kind, "mcp");
  assert.deepEqual(item.agents, ["cursor"]);
  assert.equal(item.summary, "npx -y figma");
  assert.equal(item.floating, undefined);       // 版が固定されているものに警告は出さない
});

/**
 * `@latest` は起動のたびに最新を取るので、こちらが更新を管理する余地が無い。
 * 判定は `floatingPackage` が持っているので、一覧まで届いていることを確かめる。
 */
test("@latest 指定の MCP を一覧で警告する", async () => {
  const env = fakeEnv();
  writeFileIn(join(env.home, ".cursor/mcp.json"),
    '{"mcpServers":{"chrome":{"command":"npx","args":["-y","chrome-devtools-mcp@latest"]}}}');
  const item = find((await inventory({ env, projectPath: null })).items, "chrome");
  assert.equal(item.floating, "chrome-devtools-mcp");
});

test("プロジェクトの MCP でも @latest を警告する", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  writeFileIn(join(project, ".mcp.json"),
    '{"mcpServers":{"shared":{"command":"npx","args":["-y","pkg@latest"]}}}');
  const item = find((await inventory({ env, projectPath: project })).items, "shared");
  assert.equal(item.floating, "pkg");
});

/** 走査に失敗したエージェントで一覧全体を落とさない。 */
test("壊れた MCP 設定は issues に回して一覧は返す", async () => {
  const env = fakeEnv();
  skill(skillStore(env), "mine");
  writeFileIn(join(env.home, ".cursor/mcp.json"), "{ not json");
  const { items, issues } = await inventory({ env, projectPath: null });
  assert.ok(find(items, "mine"));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /cursor MCP/);
});

test("プロジェクトの MCP はスコープ付きで返す", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  writeFileIn(join(project, ".mcp.json"), '{"mcpServers":{"shared":{"command":"node"}}}');
  const item = find((await inventory({ env, projectPath: project })).items, "shared");
  assert.equal(item.scope, "project");
  assert.match(item.summary, /^project /);
});

test("user: false はユーザー資産を走査しない", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  skill(skillStore(env), "mine");
  skill(join(project, ".claude/skills"), "theirs");
  writeFileIn(join(env.home, ".cursor/mcp.json"), "{ not json");
  const { items, issues } = await inventory({ env, projectPath: project, user: false });
  assert.equal(find(items, "mine"), undefined);
  assert.ok(find(items, "theirs"));
  assert.deepEqual(issues, []);
});

test("他プロジェクトの Plugin は今見ているプロジェクトに混ぜない", async () => {
  const env = fakeEnv();
  const project = makeDir(join(env.home, "proj"));
  const run = async (command) => {
    if (!command.includes("plugin")) throw new Error(command.join(" "));
    const plugins = [
      { id: "ours@here", scope: "project", projectPath: project, enabled: true },
      { id: "theirs@there", scope: "project", projectPath: "/other/proj", enabled: true },
      { id: "global@user", scope: "user", enabled: true },
    ];
    return command[0] === "claude" ? JSON.stringify(plugins) : JSON.stringify({ installed: [] });
  };
  const { items } = await inventory({ env, projectPath: project, run });
  assert.deepEqual(items.filter(item => item.kind === "plugin").map(item => item.name).sort(),
    ["global@user", "ours@here"]);
});

// --- 更新判定 ---

test("最新 SHA が登録済みと違えば更新あり", () => {
  const registry = { repos: { "https://example.com/x#HEAD": { latestSha: "b" } } };
  const entry = { name: "x", kind: "skill", repo: "https://example.com/x", sha: "a", pinned: false };
  assert.equal(hasUpdate(entry, registry), true);
  assert.equal(hasUpdate({ ...entry, sha: "b" }, registry), false);
});

/** 固定中は遅れていても数えない。更新しないと利用者が決めたもの。 */
test("固定中は更新ありにしない", () => {
  const registry = { repos: { "https://example.com/x#HEAD": { latestSha: "b" } } };
  assert.equal(hasUpdate(
    { name: "x", kind: "skill", repo: "https://example.com/x", sha: "a", pinned: true }, registry), false);
});
