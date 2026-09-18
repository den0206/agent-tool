const { strict: assert } = require("node:assert");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { agentStore, claudeSkills, skillStore } = require("../out/ide/env.js");
const { install } = require("../out/ide/installer.js");
const { layout, remove, removeUnmanaged } = require("../out/ide/skillManager.js");
const { empty } = require("../out/ide/registry.js");
const { isManagedLink } = require("../out/ide/writeGuard.js");
const { fakeEnv, makeDir, writeFileIn } = require("./helpers.js");

const code = expected => error => error.code === expected;

const stagedSkill = (env, name, body = "hello") => {
  const root = makeDir(join(env.home, "staging"));
  writeFileIn(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n`);
  return {
    staging: { root, source: { repo: "owner/repo", branch: "main" }, candidates: [], resolvedSha: "abc123" },
    candidate: { kind: "skill", name, localPath: join(root, name) },
  };
};

// --- install ---

test("実体を置き場に入れ、Claude 用のリンクを張る", () => {
  const env = fakeEnv();
  const registry = empty();
  const { staging, candidate } = stagedSkill(env, "pdf");
  install(candidate, staging, env, registry);

  const store = join(skillStore(env), "pdf");
  assert.ok(existsSync(join(store, "SKILL.md")));
  assert.ok(isManagedLink(join(claudeSkills(env), "pdf"), store));
  const entry = registry.resources.find(item => item.name === "pdf");
  assert.equal(entry.repo, "owner/repo");
  assert.equal(entry.sha, "abc123");
});

test("同名が既にあれば入れない", () => {
  const env = fakeEnv();
  const registry = empty();
  const { staging, candidate } = stagedSkill(env, "pdf");
  install(candidate, staging, env, registry);
  assert.throws(() => install(candidate, staging, env, registry), code("ALREADY_EXISTS"));
});

/** 取得先の名乗り 1 つで管理ルートの外へ書けないこと。 */
test("パスとして解決される名前は入れない", () => {
  const env = fakeEnv();
  const { staging } = stagedSkill(env, "ok");
  const candidate = { kind: "skill", name: "../evil", localPath: join(staging.root, "ok") };
  assert.throws(() => install(candidate, staging, env, empty()), code("INVALID_NAME"));
});

test("staging の外を指す取得物は入れない", () => {
  const env = fakeEnv();
  const { staging } = stagedSkill(env, "ok");
  const outside = makeDir(join(env.home, "elsewhere", "evil"));
  assert.throws(
    () => install({ kind: "skill", name: "evil", localPath: outside }, staging, env, empty()),
    code("FETCH_FAILED"));
});

// --- remove ---

test("削除はリンクと実体を消し、registry から外す", () => {
  const env = fakeEnv();
  const registry = empty();
  const { staging, candidate } = stagedSkill(env, "pdf");
  install(candidate, staging, env, registry);

  remove("pdf", "skill", env, registry);
  assert.equal(existsSync(join(skillStore(env), "pdf")), false);
  assert.equal(existsSync(join(claudeSkills(env), "pdf")), false);
  assert.deepEqual(registry.resources, []);
});

test("実体が無いものは削除できない", () => {
  const env = fakeEnv();
  assert.throws(() => remove("ghost", "skill", env, empty()), code("NOT_FOUND"));
});

// --- Subagent の配置 ---

test("Subagent は 2 本のリンクを張る", () => {
  const env = fakeEnv();
  const registry = empty();
  const path = writeFileIn(join(env.home, "staging", "reviewer.md"),
    "---\nname: reviewer\ntools: Read\n---\n");
  install({ kind: "subagent", name: "reviewer", localPath: path },
    { root: join(env.home, "staging"), source: { repo: "owner/repo" } }, env, registry);

  const store = join(agentStore(env), "reviewer.md");
  assert.equal(readFileSync(store, "utf8").includes("tools: Read"), true);
  for (const dir of [".claude/agents", ".cursor/agents"]) {
    assert.ok(isManagedLink(join(env.home, dir, "reviewer.md"), store), dir);
  }
});

test("Subagent の実体は .md で管理する", () => {
  const env = fakeEnv();
  const plan = layout("reviewer", "subagent", env);
  assert.ok(plan.store.endsWith(join("agents", "reviewer.md")));
  assert.equal(plan.linkKind, "file");
});

// --- Rule ---

/** Rule は URL からの導入経路を持たず、`layout` の管理下に現れない（D-20）。 */
test("Rule は install / layout の対象外", () => {
  const env = fakeEnv();
  const path = writeFileIn(join(env.home, "staging", "testing.md"),
    "---\ndescription: t\n---\n");
  assert.throws(
    () => install({ kind: "rule", name: "testing", localPath: path },
      { root: join(env.home, "staging"), source: { repo: "owner/repo" } }, env, empty()),
    code("OPERATION_FAILED"));
  assert.throws(() => layout("testing", "rule", env), code("OPERATION_FAILED"));
});

/** 手で置いた Rule は `removeUnmanaged` で消せる。Claude は .md、Cursor は .mdc。 */
test("Rule は removeUnmanaged で削除できる（.md と .mdc）", () => {
  const env = fakeEnv();
  const claudePath = writeFileIn(join(env.home, ".claude", "rules", "testing.md"),
    "---\ndescription: t\n---\n");
  const cursorPath = writeFileIn(join(env.home, ".cursor", "rules", "style.mdc"),
    "---\ndescription: s\n---\n");
  const removedClaude = removeUnmanaged("testing", "rule", env);
  assert.deepEqual(removedClaude, [claudePath]);
  assert.equal(existsSync(claudePath), false);

  const removedCursor = removeUnmanaged("style", "rule", env);
  assert.deepEqual(removedCursor, [cursorPath]);
  assert.equal(existsSync(cursorPath), false);
});

/**
 * 同名でも Claude と Cursor の Rule は無関係な別ファイル。Skill / Subagent と同じ
 * 「全ルート一括削除」に乗せると、片方を消したつもりでもう一方まで消える（D-20）。
 */
test("同名 Rule は選ばれたエージェントの分だけ消す", () => {
  const env = fakeEnv();
  const claudePath = writeFileIn(join(env.home, ".claude", "rules", "testing.md"),
    "---\ndescription: claude 用\n---\n");
  const cursorPath = writeFileIn(join(env.home, ".cursor", "rules", "testing.mdc"),
    "---\ndescription: cursor 用（別内容）\n---\n");

  assert.deepEqual(removeUnmanaged("testing", "rule", env, undefined, "cursor"), [cursorPath]);
  assert.equal(existsSync(cursorPath), false);
  assert.equal(existsSync(claudePath), true, "Claude の Rule は残る");

  assert.deepEqual(removeUnmanaged("testing", "rule", env, undefined, "claude"), [claudePath]);
  assert.equal(existsSync(claudePath), false);
});

// --- 種別ごとの宛先 ---

/**
 * Plugin と MCP はこちらの管理ストアに実体を持たない。`layout` を素通りさせると
 * `~/.agents/skills/<name>` を指し、同名の Skill を消しにいく。
 * D-5 でゴミ箱を経由しないので、取り違えは復旧できない。
 */
for (const kind of ["plugin", "mcp"]) {
  test(`${kind} は管理ストアの実体として扱わない`, () => {
    const env = fakeEnv();
    assert.throws(() => layout("github@openai-curated-remote", kind, env), code("OPERATION_FAILED"));
    assert.throws(() => remove("github@openai-curated-remote", kind, env, empty()), code("OPERATION_FAILED"));
  });
}

test("同名の Skill があっても Plugin の削除で巻き込まない", () => {
  const env = fakeEnv();
  const registry = empty();
  const { staging, candidate } = stagedSkill(env, "ponytail");
  install(candidate, staging, env, registry);

  assert.throws(() => remove("ponytail", "plugin", env, registry), code("OPERATION_FAILED"));
  assert.ok(existsSync(join(skillStore(env), "ponytail", "SKILL.md")), "Skill の実体は残る");
});

// --- project スコープ ---

const project = env => makeDir(join(env.home, "workspace"));
const at = path => ({ scope: "project", path });

test("project スコープはプロジェクト内に置き、user 側には作らない", () => {
  const env = fakeEnv();
  const registry = empty();
  const workspace = project(env);
  const { staging, candidate } = stagedSkill(env, "pdf");
  install(candidate, staging, env, registry, at(workspace));

  assert.ok(existsSync(join(workspace, ".claude/skills/pdf/SKILL.md")));
  // user の置き場にもリンク先にも触らない。同名の user スキルと混ざらない。
  assert.equal(existsSync(join(skillStore(env), "pdf")), false);
  assert.equal(existsSync(join(claudeSkills(env), "pdf")), false);
  assert.equal(registry.resources.find(item => item.name === "pdf").project, workspace);
});

test("同名の user と project は別の実体として扱う", () => {
  const env = fakeEnv();
  const registry = empty();
  const workspace = project(env);
  install(stagedSkill(env, "pdf").candidate, stagedSkill(env, "pdf").staging, env, registry);
  const second = stagedSkill(env, "pdf");
  install(second.candidate, second.staging, env, registry, at(workspace));
  assert.equal(registry.resources.filter(item => item.name === "pdf").length, 2);

  // プロジェクトのものを消しても user の実体は残る。
  remove("pdf", "skill", env, registry, at(workspace));
  assert.equal(existsSync(join(workspace, ".claude/skills/pdf")), false);
  assert.ok(existsSync(join(skillStore(env), "pdf")));
  assert.equal(registry.resources.filter(item => item.name === "pdf").length, 1);
  assert.equal(registry.resources[0].project, undefined);
});

test("project スコープはリンクを持たない", () => {
  const env = fakeEnv();
  const registry = empty();
  const workspace = project(env);
  const plan = layout("pdf", "skill", env, at(workspace));
  assert.deepEqual(plan.links, []);
});

test("プロジェクトの .claude/skills 直下以外は消さない", () => {
  const env = fakeEnv();
  const workspace = project(env);
  writeFileIn(join(workspace, ".claude/skills/nested/deep/SKILL.md"), "---\nname: deep\n---\n");
  writeFileIn(join(workspace, "src/evil/SKILL.md"), "---\nname: evil\n---\n");
  assert.throws(() => removeUnmanaged("evil", "skill", env, at(workspace)), code("NOT_FOUND"));
  // 直下にあるものは消せる
  assert.deepEqual(removeUnmanaged("nested", "skill", env, at(workspace)),
    [join(workspace, ".claude/skills/nested")]);
});
