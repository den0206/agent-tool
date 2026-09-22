const { strict: assert } = require("node:assert");
const { readdirSync, readFileSync, utimesSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { registryFile } = require("../out/ide/env.js");
const { REGISTRY_SIZE_LIMIT, decode, empty, entry, load, read, save, update, upsert, withRegistryLock } =
  require("../out/ide/registry.js");
const { fakeEnv, makeDir, writeFileIn } = require("./helpers.js");

const seed = (env, body) => writeFileIn(registryFile(env), body);

/** キーが 1 つ足りないだけで失敗させると、導入済みリソースの取得元がまとめて失われる。 */
test("欠けているキーは既定値で埋める", () => {
  const registry = decode({ resources: [{ name: "a", kind: "skill" }] });
  assert.equal(registry.resources[0].pinned, false);
  assert.deepEqual(registry.repos, {});
  assert.deepEqual(registry.agents, {});
});

test("name か kind が無いリソースは読み飛ばす", () => {
  assert.equal(decode({ resources: [{ kind: "skill" }, { name: "a", kind: "skill" }] })
    .resources.length, 1);
});

/** load は握り潰し、read は投げる。壊れた registry の上に保存すると出所情報が飛ぶ。 */
test("壊れた registry は read では投げ、load では空になる", () => {
  const env = fakeEnv();
  seed(env, "{ broken");
  assert.throws(() => read(env));
  assert.deepEqual(load(env).resources, []);
});

test("registry が無ければ空を返す", () => {
  assert.deepEqual(read(fakeEnv()).resources, []);
});

test("大きすぎる registry は読み込まない", () => {
  const env = fakeEnv();
  seed(env, Buffer.alloc(REGISTRY_SIZE_LIMIT + 1, 0x20));
  assert.throws(() => read(env), error => error.code === "OPERATION_FAILED");
  assert.deepEqual(load(env).resources, []);
});

test("読み戻せない大きさの registry は保存しない", async () => {
  const env = fakeEnv();
  const registry = empty();
  registry.resources.push({
    name: "x".repeat(REGISTRY_SIZE_LIMIT), kind: "skill", pinned: false,
  });
  await assert.rejects(save(env, registry), error => error.code === "OPERATION_FAILED");
  assert.deepEqual(readdirSync(env.appSupport).filter(name => name.endsWith(".tmp")), []);
});

test("自分より新しいスキーマは拒否する", () => {
  const env = fakeEnv();
  seed(env, JSON.stringify({ schemaVersion: "2", resources: [] }));
  assert.throws(() => read(env), error => error.code === "SCHEMA_UNSUPPORTED");
});

test("保存した内容を読み戻せる", async () => {
  const env = fakeEnv();
  const registry = empty();
  upsert(registry, { name: "mine", kind: "skill", repo: "https://example.com/x", pinned: true });
  await save(env, registry);
  assert.equal(entry(read(env), "mine", "skill").repo, "https://example.com/x");
  assert.equal(entry(read(env), "mine", "skill").pinned, true);
});

/** 既定値と変わらないフィールドは書き出さない。キーはソートして diff を読みやすくする。 */
test("既定値を書き出さず、キーをソートする", async () => {
  const env = fakeEnv();
  const registry = empty();
  upsert(registry, { name: "mine", kind: "skill", pinned: false });
  await save(env, registry);
  const raw = readFileSync(registryFile(env), "utf8");
  assert.ok(!raw.includes("\"pinned\""), raw);
  assert.ok(raw.indexOf("\"kind\"") < raw.indexOf("\"name\""), raw);
});

/** 書き込み中のクラッシュで全リソースの出所情報を失わないため。 */
test("保存は一時ファイルを残さない", async () => {
  const env = fakeEnv();
  await save(env, empty());
  assert.deepEqual(readdirSync(env.appSupport).filter(name => name.endsWith(".tmp")), []);
});

test("update は read-modify-write を 1 度で行う", async () => {
  const env = fakeEnv();
  await update(env, registry => upsert(registry, { name: "a", kind: "skill", pinned: false }));
  await update(env, registry => upsert(registry, { name: "b", kind: "skill", pinned: false }));
  assert.deepEqual(read(env).resources.map(resource => resource.name), ["a", "b"]);
});

/** 複数ウィンドウが同時に書いても、後から始めた側が前の変更を消さない。 */
test("同時に走る update が互いの変更を消さない", async () => {
  const env = fakeEnv();
  await Promise.all(["a", "b", "c"].map(name =>
    update(env, registry => upsert(registry, { name, kind: "skill", pinned: false }))));
  assert.deepEqual(read(env).resources.map(resource => resource.name).sort(), ["a", "b", "c"]);
});

/** プロセスがクラッシュして残ったロックは、待ち続けずに回収する。 */
test("古いロックは回収して先へ進む", async () => {
  const env = fakeEnv();
  makeDir(env.appSupport);
  const lockPath = join(env.appSupport, "registry.lock");
  writeFileSync(lockPath, "");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockPath, stale, stale);
  assert.equal(await withRegistryLock(env, () => "done"), "done");
});

test("ロックは処理の後に解放される", async () => {
  const env = fakeEnv();
  await assert.rejects(withRegistryLock(env, () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withRegistryLock(env, () => "next"), "next");
});
