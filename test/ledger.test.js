const { strict: assert } = require("node:assert");
const { chmodSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { absorb, key, prune, scan } = require("../out/ide/ledger.js");
const { LEDGER_DIR } = require("../out/core/ledger.js");
const { empty, entry, upsert } = require("../out/ide/registry.js");
const { assertLedger, assertRecordedArtifact, removeLedger } = require("../out/ide/writeGuard.js");
const { layout, link, remove: removeManaged, USER } = require("../out/ide/skillManager.js");
const { install } = require("../out/ide/installer.js");

const code = expected => error => error.code === expected;
const { fakeEnv, makeDir, writeFileIn } = require("./helpers.js");

/** ブラウザ拡張が置いた状態を偽のホームに作る。 */
function fixture() {
  const env = fakeEnv();
  makeDir(env.home);
  const root = join(env.home, ".claude", "skills");
  return {
    env,
    root,
    /** 実体と台帳をまとめて置く。 */
    skill(name, ledger = { name, kind: "skill", repo: "owner/repo", sha: "abc" }) {
      writeFileIn(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
      writeFileIn(join(root, LEDGER_DIR, `${name}.json`), JSON.stringify(ledger));
      return join(root, LEDGER_DIR, `${name}.json`);
    },
    subagent(name) {
      writeFileIn(join(env.home, ".claude", "agents", `${name}.md`), `---\nname: ${name}\n---\n`);
      return writeFileIn(
        join(env.home, ".claude", "agents", LEDGER_DIR, `${name}.json`),
        JSON.stringify({ name, kind: "subagent", repo: "owner/repo" }));
    },
    /** 台帳だけを置く（実体が無い状態）。 */
    orphan(name) {
      return writeFileIn(join(root, LEDGER_DIR, `${name}.json`),
        JSON.stringify({ name, kind: "skill", repo: "owner/repo" }));
    },
  };
}

// --- 走査 ---------------------------------------------------------------

test("走査ルート直下の台帳を拾う", () => {
  const f = fixture();
  f.skill("pdf");
  f.subagent("reviewer");
  const found = scan(f.env);
  assert.deepEqual(found.map(item => item.ledger.name).sort(), ["pdf", "reviewer"]);
  assert.deepEqual(found.map(item => item.ledger.kind).sort(), ["skill", "subagent"]);
});

test("台帳が無いルートは黙って飛ばす", () => {
  assert.deepEqual(scan(fixture().env), []);
});

test("壊れた台帳は拾わない", () => {
  const f = fixture();
  writeFileIn(join(f.root, LEDGER_DIR, "broken.json"), "{ not json");
  writeFileIn(join(f.root, LEDGER_DIR, "empty.json"), "{}");
  writeFileIn(join(f.root, LEDGER_DIR, "plugin.json"),
    JSON.stringify({ name: "plugin", kind: "plugin", repo: "owner/repo" }));
  assert.deepEqual(scan(f.env), []);
});

test("ファイル名と中の name がずれた台帳は信用しない", () => {
  const f = fixture();
  writeFileIn(join(f.root, "pdf", "SKILL.md"), "---\nname: pdf\n---\n");
  writeFileIn(join(f.root, LEDGER_DIR, "pdf.json"),
    JSON.stringify({ name: "other", kind: "skill", repo: "owner/repo" }));
  assert.deepEqual(scan(f.env), []);
});

test("json 以外は読まない", () => {
  const f = fixture();
  writeFileIn(join(f.root, LEDGER_DIR, "notes.txt"), "x");
  assert.deepEqual(scan(f.env), []);
});

// --- 取り込み -----------------------------------------------------------

test("取り込むと registry に載り、台帳は消える", () => {
  const f = fixture();
  const file = f.skill("pdf");
  const registry = empty();

  absorb(f.env, registry, scan(f.env));
  // `root` まで載せる。実体は管理ストアではなくブラウザ拡張が許可されたルートにある。
  assert.deepEqual(registry.resources, [{
    name: "pdf", kind: "skill", repo: "owner/repo", sha: "abc",
    root: ".claude/skills", pinned: false,
  }]);
  assert.equal(existsSync(file), false);
  // 実体には触れない
  assert.equal(existsSync(join(f.root, "pdf", "SKILL.md")), true);
  // .agent-tool ごとは消さない
  assert.equal(existsSync(join(f.root, LEDGER_DIR)), true);
});

test("取得元の任意キーは持っていた分だけ移す", () => {
  const f = fixture();
  f.skill("pdf", { name: "pdf", kind: "skill", repo: "owner/repo" });
  const registry = empty();
  absorb(f.env, registry, scan(f.env));
  assert.deepEqual(Object.keys(registry.resources[0]).sort(),
    ["kind", "name", "pinned", "repo", "root"]);
});

test("同じ名前を二度取り込んでも 1 件のまま", () => {
  const f = fixture();
  const registry = empty();
  f.skill("pdf");
  absorb(f.env, registry, scan(f.env));
  f.skill("pdf", { name: "pdf", kind: "skill", repo: "owner/repo", sha: "def" });
  absorb(f.env, registry, scan(f.env));
  assert.equal(registry.resources.length, 1);
  assert.equal(registry.resources[0].sha, "def");
});

// --- WriteGuard ---------------------------------------------------------

test("実体が無い台帳は消さない", () => {
  const f = fixture();
  const file = f.orphan("ghost");
  assert.throws(() => removeLedger(file, f.root, f.env), error => error.code === "NOT_FOUND");
  assert.equal(existsSync(file), true);
});

test("台帳以外は台帳の経路では消せない", () => {
  const f = fixture();
  f.skill("pdf");
  // 実体そのもの
  assert.throws(() => assertLedger(join(f.root, "pdf"), f.root, f.env),
    error => error.code === "WRITE_GUARD_DENIED");
  // .agent-tool の外にある json
  assert.throws(() => assertLedger(join(f.root, "pdf.json"), f.root, f.env),
    error => error.code === "WRITE_GUARD_DENIED");
  // ルート違い
  assert.throws(() => assertLedger(join(f.root, LEDGER_DIR, "pdf.json"),
    join(f.env.home, ".cursor", "skills"), f.env),
    error => error.code === "WRITE_GUARD_DENIED");
});

test("パスに使えない名前の台帳は消さない", () => {
  const f = fixture();
  writeFileIn(join(f.root, "x", "SKILL.md"), "---\nname: x\n---\n");
  const file = writeFileIn(join(f.root, LEDGER_DIR, ".hidden.json"), "{}");
  assert.throws(() => assertLedger(file, f.root, f.env),
    error => error.code === "WRITE_GUARD_DENIED");
  assert.equal(readdirSync(join(f.root, LEDGER_DIR)).length, 1);
});

// --- 実体を失った entry -------------------------------------------------

const managed = (name, project) => ({
  name, kind: "skill", repo: "owner/repo", pinned: false,
  ...(project === undefined ? {} : { project }),
});

test("走査したルートで実体が無い entry を落とす", () => {
  const registry = empty();
  upsert(registry, managed("kept"));
  upsert(registry, managed("gone"));
  prune(registry, {
    seen: new Set([key("kept", "skill")]),
    scannedUser: true, scannedProject: null,
  });
  assert.deepEqual(registry.resources.map(item => item.name), ["kept"]);
});

test("走査していない user スコープは落とさない", () => {
  const registry = empty();
  upsert(registry, managed("gone"));
  prune(registry, { seen: new Set(), scannedUser: false, scannedProject: null });
  assert.deepEqual(registry.resources.map(item => item.name), ["gone"]);
});

test("開いていないプロジェクトの entry を巻き込まない", () => {
  const registry = empty();
  upsert(registry, managed("here", "/work/a"));
  upsert(registry, managed("elsewhere", "/work/b"));
  prune(registry, { seen: new Set(), scannedUser: false, scannedProject: "/work/a" });
  assert.deepEqual(registry.resources.map(item => item.name), ["elsewhere"]);
});

test("同じ名前でも user と project を混同しない", () => {
  const registry = empty();
  upsert(registry, managed("pdf"));
  upsert(registry, managed("pdf", "/work/a"));
  prune(registry, {
    seen: new Set([key("pdf", "skill", "/work/a")]),
    scannedUser: true, scannedProject: "/work/a",
  });
  assert.deepEqual(registry.resources.map(item => item.project), ["/work/a"]);
});

// --- inventory との結線 -------------------------------------------------

const { inventory } = require("../out/ide/inventory.js");
const { load } = require("../out/ide/registry.js");

test("writable なら一覧を組むついでに取り込む", async () => {
  const f = fixture();
  const file = f.skill("pdf");
  const { items } = await inventory({
    env: f.env, projectPath: null, run: async () => "", writable: true,
  });
  const pdf = items.find(item => item.name === "pdf");
  assert.equal(pdf.origin, "managed");         // 取り込んだ結果が同じ走査に出る
  assert.equal(pdf.repoUrl, "owner/repo");
  assert.equal(existsSync(file), false);
  assert.equal(load(f.env).resources.length, 1);
});

test("writable でなければ registry に触らない", async () => {
  const f = fixture();
  const file = f.skill("pdf");
  const { items } = await inventory({ env: f.env, projectPath: null, run: async () => "" });
  assert.equal(items.find(item => item.name === "pdf").origin, "user");
  assert.equal(existsSync(file), true);         // 台帳は残る
  assert.deepEqual(load(f.env).resources, []);
});

test("実体を手で消したあとの entry は次の走査で落ちる", async () => {
  const f = fixture();
  f.skill("pdf");
  await inventory({ env: f.env, projectPath: null, run: async () => "", writable: true });
  assert.equal(load(f.env).resources.length, 1);

  require("node:fs").rmSync(join(f.root, "pdf"), { recursive: true, force: true });
  await inventory({ env: f.env, projectPath: null, run: async () => "", writable: true });
  assert.deepEqual(load(f.env).resources, []);
});

test("実体の無い台帳は取り込まない", () => {
  // 書き込みが途中で失敗すると台帳だけが残る。取り込むと、存在しないものの entry を
  // 作っては prune が消す往復が走査のたびに起きる。
  const f = fixture();
  f.orphan("ghost");
  f.skill("pdf");
  assert.deepEqual(scan(f.env).map(item => item.ledger.name), ["pdf"]);
});

/**
 * `chmod 000` で「読めない」を作るので、権限検査を素通りする実行者では成立しない。
 * Windows に POSIX の権限が無いのと同じ理由で、root でも飛ばす（Docker / devcontainer）。
 */
const cannotRevokeRead = process.platform === "win32" || process.getuid?.() === 0;

test("読めないルートがあるときは entry を落とさない", { skip: cannotRevokeRead }, async () => {
  // 権限・退避されたクラウド同期・切れたネットワークホームでは走査が空になる。
  // これを「消えた」と扱うと、実体が残っているのに pinned / 取得元を失う。
  const f = fixture();
  f.skill("pdf");
  await inventory({ env: f.env, projectPath: null, run: async () => "", writable: true });
  assert.equal(load(f.env).resources.length, 1);

  chmodSync(f.root, 0o000);
  try {
    const { issues } = await inventory({
      env: f.env, projectPath: null, run: async () => "", writable: true,
    });
    assert.equal(load(f.env).resources.length, 1);          // 残っている
    assert.ok(issues.some(issue => issue.includes(f.root))); // 黙って諦めない
  } finally {
    chmodSync(f.root, 0o755);
  }
});

test("実体の無い台帳があっても registry は安定する", async () => {
  const f = fixture();
  f.orphan("ghost");
  for (let round = 0; round < 2; round++) {
    await inventory({ env: f.env, projectPath: null, run: async () => "", writable: true });
    assert.deepEqual(load(f.env).resources, []);
  }
  assert.equal(existsSync(join(f.root, LEDGER_DIR, "ghost.json")), true);  // 消しはしない
});

// --- 取り込んだ実体の操作 -----------------------------------------------
// 取り込みは registry へ `root` を載せる。載せないと `layout` が管理ストアを指し、
// 実体はブラウザ拡張が許可されたルートにあるので操作が届かない。

/** 取り込み済みの状態にして、registry を返す。 */
const absorbed = async f => {
  await inventory({ env: f.env, projectPath: null, run: async () => "", writable: true });
  return load(f.env);
};

test("取り込んだ実体は、あるルートから削除できる", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = await absorbed(f);
  assert.equal(entry(registry, "pdf", "skill").root, ".claude/skills");

  removeManaged("pdf", "skill", f.env, registry);
  assert.equal(existsSync(join(f.root, "pdf")), false);
  assert.equal(entry(registry, "pdf", "skill"), undefined);
});

test("取り込んだ Subagent も、あるルートから削除できる", async () => {
  const f = fixture();
  f.subagent("reviewer");
  const registry = await absorbed(f);
  assert.equal(entry(registry, "reviewer", "subagent").root, ".claude/agents");

  removeManaged("reviewer", "subagent", f.env, registry);
  assert.equal(existsSync(join(f.env.home, ".claude", "agents", "reviewer.md")), false);
});

test("取り込んだ実体にはリンクを張らない（自分自身を指すリンクを作らない）", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = await absorbed(f);
  assert.deepEqual(layout("pdf", "skill", f.env, USER, ".claude/skills").links, []);
  // 既定の置き場のままなら、これまでどおり Claude 用のリンクを張る。
  assert.deepEqual(layout("pdf", "skill", f.env, USER, ".agents/skills").links,
    [join(f.env.home, ".claude", "skills", "pdf")]);
  assert.deepEqual(layout("pdf", "skill", f.env, USER).links,
    [join(f.env.home, ".claude", "skills", "pdf")]);
  link("pdf", "skill", f.env, registry);
  assert.equal(existsSync(join(f.env.home, ".agents", "skills", "pdf")), false);
});

test("更新の宛先は取り込んだルートの実体になる（二重化しない）", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = await absorbed(f);
  const plan = layout("pdf", "skill", f.env, USER, entry(registry, "pdf", "skill").root);
  assert.equal(plan.store, join(f.root, "pdf"));
  assert.notEqual(plan.store, join(f.env.home, ".agents", "skills", "pdf"));
});

test("取り込んだものは、同じ名前で二度入らない", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = await absorbed(f);
  const staging = { root: makeDir(join(f.env.home, "staging")), source: { repo: "owner/repo" } };
  const candidate = {
    kind: "skill", name: "pdf",
    localPath: writeFileIn(join(staging.root, "pdf", "SKILL.md"), "---\nname: pdf\n---\n")
      .replace(/[\\/]SKILL\.md$/, ""),
  };
  assert.throws(() => install(candidate, staging, f.env, registry), code("ALREADY_EXISTS"));
});

test("取り込み直しで pinned を解除しない", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = empty();
  absorb(f.env, registry, scan(f.env));
  upsert(registry, { ...entry(registry, "pdf", "skill"), pinned: true });

  f.skill("pdf", { name: "pdf", kind: "skill", repo: "owner/repo", sha: "def" });
  absorb(f.env, registry, scan(f.env));
  assert.equal(entry(registry, "pdf", "skill").pinned, true);
  assert.equal(entry(registry, "pdf", "skill").sha, "def");
});

test("registry の root が外を指していても管理ストアに落ちる", () => {
  const f = fixture();
  for (const root of ["../outside", "..", "", "./", "a\\b"]) {
    assert.equal(layout("pdf", "skill", f.env, USER, root).store,
      join(f.env.home, ".agents", "skills", "pdf"));
  }
});

test("registry に無い名前は、既知ルート直下でも触れない", () => {
  const f = fixture();
  f.skill("pdf");
  assert.throws(() => assertRecordedArtifact(join(f.root, "pdf"), "skill", f.env, empty()),
    code("NOT_IN_REGISTRY"));
});

test("記録されたルートでも、既知ルート直下でなければ触れない", async () => {
  const f = fixture();
  f.skill("pdf");
  const registry = await absorbed(f);
  // registry には載っているが、`~/.claude/skills/pdf/pdf` は既知ルートの直下ではない。
  assert.throws(
    () => assertRecordedArtifact(join(f.root, "pdf", "pdf"), "skill", f.env, registry),
    code("WRITE_GUARD_DENIED"));
  // ホワイトリストに無いルートの直下も通さない。
  assert.throws(
    () => assertRecordedArtifact(join(f.env.home, "elsewhere", "pdf"), "skill", f.env, registry),
    code("WRITE_GUARD_DENIED"));
});
