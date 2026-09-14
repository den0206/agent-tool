const { strict: assert } = require("node:assert");
const { join } = require("node:path");
const { test } = require("node:test");
const { claudeSkills, skillStore } = require("../out/ide/env.js");
const {
  assertMutable, assertSafeCreation, assertUserArtifact, assertValidName, isValidName,
} = require("../out/ide/writeGuard.js");
const { empty, upsert } = require("../out/ide/registry.js");
const { fakeEnv, link, makeDir, writeFileIn } = require("./helpers.js");

const code = expected => error => error.code === expected;

function fixture() {
  const env = fakeEnv();
  const registry = empty();
  makeDir(env.home);
  return {
    env,
    registry,
    managedSkill(name) {
      const dir = makeDir(join(skillStore(env), name));
      writeFileIn(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
      upsert(registry, { name, kind: "skill", pinned: false, disabled: false });
      return dir;
    },
  };
}

test("registry に載っている実体は触れる", () => {
  const f = fixture();
  assertMutable(f.managedSkill("mine"), f.env, f.registry);
});

/** 他のツールが入れたスキル。表示のみ・操作不可。 */
test("registry に無い外部スキルは拒否される", () => {
  const f = fixture();
  const dir = makeDir(join(skillStore(f.env), "find-skills"));
  assert.throws(() => assertMutable(dir, f.env, f.registry), code("NOT_IN_REGISTRY"));
});

test("実体置き場の外は拒否される", () => {
  const f = fixture();
  upsert(f.registry, { name: "canvas", kind: "skill", pinned: false, disabled: false });
  const outside = makeDir(join(f.env.home, ".cursor/skills-cursor/canvas"));
  assert.throws(() => assertMutable(outside, f.env, f.registry), code("WRITE_GUARD_DENIED"));
});

test("自分が張ったリンクは触れる", () => {
  const f = fixture();
  const target = f.managedSkill("mine");
  assertMutable(link(target, join(claudeSkills(f.env), "mine")), f.env, f.registry);
});

/**
 * Rule は managed ストアの外にあり、`assertMutable` の対象外（D-20）。
 * 手で置かれたものは `assertUserArtifact` で走査ホワイトリスト直下だけを許可する。
 */
test("Rule は既知ルート直下なら assertUserArtifact で通す", () => {
  const f = fixture();
  const claudeRule = join(f.env.home, ".claude", "rules", "testing.md");
  writeFileIn(claudeRule, "---\ndescription: t\n---\n");
  assertUserArtifact(claudeRule, "rule", f.env);

  const cursorRule = join(f.env.home, ".cursor", "rules", "style.mdc");
  writeFileIn(cursorRule, "---\ndescription: s\n---\n");
  assertUserArtifact(cursorRule, "rule", f.env);
});

test("Rule 相当の拡張子でも既知ルートの外は拒否する", () => {
  const f = fixture();
  const outside = join(f.env.home, "elsewhere", "testing.md");
  writeFileIn(outside, "---\ndescription: t\n---\n");
  assert.throws(() => assertUserArtifact(outside, "rule", f.env), code("WRITE_GUARD_DENIED"));
});

test("Rule のファイル拡張子は .md か .mdc に限る", () => {
  const f = fixture();
  const wrong = join(f.env.home, ".claude", "rules", "testing.txt");
  writeFileIn(wrong, "---\ndescription: t\n---\n");
  assert.throws(() => assertUserArtifact(wrong, "rule", f.env), code("WRITE_GUARD_DENIED"));
});

/** 他ツールが張ったリンクには触らない。 */
test("実体置き場の外を指すリンクは拒否される", () => {
  const f = fixture();
  const foreign = makeDir(join(f.env.home, "elsewhere", "codiff"));
  const path = link(foreign, join(claudeSkills(f.env), "codiff"));
  assert.throws(() => assertMutable(path, f.env, f.registry), code("SYMLINK_OUTSIDE_STORE"));
});

/** ホワイトリストの実装ミス 1 つで到達しうる場所（二重チェック）。 */
for (const relative of [
  ".codex/auth.json", ".gemini/oauth_creds.json", ".claude/settings.json",
  ".claude.json", ".codex/config.toml", ".cursor/mcp.json",
  ".codex/logs_2.sqlite", ".claude/settings.local.json",
]) {
  test(`無条件拒否のパス: ${relative}`, () => {
    const f = fixture();
    assert.throws(() => assertMutable(join(f.env.home, relative), f.env, f.registry),
      code("WRITE_GUARD_DENIED"));
  });
}

test("パス境界を跨ぐ .. は拒否される", () => {
  const f = fixture();
  upsert(f.registry, { name: "auth.json", kind: "skill", pinned: false, disabled: false });
  const escape = join(skillStore(f.env), "../../.codex/auth.json");
  assert.throws(() => assertMutable(escape, f.env, f.registry), code("WRITE_GUARD_DENIED"));
});

/** 前方一致だけだと `.agents/skills-other` が通ってしまう。 */
test("接頭辞が同じだけの別ディレクトリは拒否される", () => {
  const f = fixture();
  upsert(f.registry, { name: "x", kind: "skill", pinned: false, disabled: false });
  const sibling = makeDir(join(f.env.home, ".agents/skills-other/x"));
  assert.throws(() => assertMutable(sibling, f.env, f.registry), code("WRITE_GUARD_DENIED"));
});

test("管理ルートの親リンク経由の作成を拒否する", () => {
  const env = fakeEnv();
  const outside = makeDir(join(env.home, "..", `outside-${process.pid}-${Date.now()}`));
  makeDir(env.home);
  link(outside, join(env.home, ".agents"));
  assert.throws(
    () => assertSafeCreation(join(skillStore(env), "demo"), skillStore(env), env.home),
    code("WRITE_GUARD_DENIED"));
});

/**
 * リンクそのものは拒まない。`~/.agents` を dotfiles リポジトリへ張るのは普通の構成で、
 * 一律に弾くと有効化も更新もできなくなる。拒むのはホームの外へ出るリンクだけ。
 */
test("ホームの中に収まる親リンクは通す", () => {
  const env = fakeEnv();
  const dotfiles = makeDir(join(env.home, "dotfiles", ".agents"));
  link(dotfiles, join(env.home, ".agents"));
  assertSafeCreation(join(skillStore(env), "demo"), skillStore(env), env.home);
});


/** 作成方向のホワイトリスト。取得物が名乗った名前がそのままパス要素になる経路を塞ぐ。 */
for (const name of [
  "../../.claude/skills/evil", "..", ".", "a/b", "a\\b", "/etc/passwd", ".hidden", "",
  "apps/web:deploy", "with:colon", "line\nbreak", "nul\u0000byte",
]) {
  test(`パスとして解決される名前は拒否する: ${JSON.stringify(name)}`, () => {
    assert.ok(!isValidName(name), `${name} が通ってしまった`);
    assert.throws(() => assertValidName(name), code("INVALID_NAME"));
  });
}

for (const name of ["auth.json", "settings.json", ".claude.json", "config.toml", "logs.sqlite"]) {
  test(`保護対象の名前は拒否する: ${name}`, () => assert.ok(!isValidName(name)));
}

/** 文字種は絞らない。実在するスキル名を弾く方が実害になる。 */
for (const name of ["pdf", "artifact-design", "web_deploy", "skill.v2", "日本語スキル", "a-1"]) {
  test(`実在する形の名前は通る: ${name}`, () => {
    assert.ok(isValidName(name));
    assertValidName(name);
  });
}

test("255 バイトを超える名前は拒否する", () => {
  assert.ok(!isValidName("a".repeat(256)));
  assert.ok(isValidName("a".repeat(255)));
});
