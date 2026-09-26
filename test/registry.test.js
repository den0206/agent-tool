const { strict: assert } = require("node:assert");
const { readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } = require("node:fs");
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
  // "10" は文字列比較では "2" より小さく見え、数値の 2 は「文字列でない」ので
  // 見落とされる。どちらも通すと decode が未知のフィールドを落として書き戻す。
  for (const version of ["2", "10", "abc", 2, 10, {}]) {
    seed(env, JSON.stringify({ schemaVersion: version, resources: [] }));
    assert.throws(() => read(env), error => error.code === "SCHEMA_UNSUPPORTED", version);
  }
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

const lockIn = (env, body) => {
  makeDir(env.appSupport);
  const lockPath = join(env.appSupport, "registry.lock");
  writeFileSync(lockPath, body);
  return lockPath;
};

/** プロセスがクラッシュして残ったロックは、待ち続けずに回収する。 */
test("居なくなった保持者のロックは回収して先へ進む", async () => {
  const env = fakeEnv();
  lockIn(env, "2147483647");                       // どの OS でも走っていない PID
  assert.equal(await withRegistryLock(env, () => "done"), "done");
});

/** PID を書く前に落ちた場合と旧版が残したロック。時間でしか判断できない。 */
test("PID の無い古いロックは回収して先へ進む", async () => {
  const env = fakeEnv();
  const lockPath = lockIn(env, "");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockPath, stale, stale);
  assert.equal(await withRegistryLock(env, () => "done"), "done");
});

/**
 * 導入の実体コピーは同期で走りイベントループを止める。時間で回収すると、
 * 作業中の保持者から別プロセスが奪って 2 つが同時に書き込む。
 */
test("生きている保持者のロックは古くても回収しない", async () => {
  const env = fakeEnv();
  const lockPath = lockIn(env, String(process.pid));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockPath, stale, stale);
  const attempt = withRegistryLock(env, () => "acquired");
  const waited = new Promise(resolve => setTimeout(() => resolve("waited"), 300));
  assert.equal(await Promise.race([attempt, waited]), "waited");
  unlinkSync(lockPath);                            // 保持者が解放した
  assert.equal(await attempt, "acquired");
});

/**
 * PID は再利用される。生死だけで決めると、無関係なプロセスが番号を拾った時点で
 * 書き込みが永久に止まり、`registry.lock` の手動削除しか復旧手段が無くなる。
 */
test("生きている保持者でも限度を超えたロックは回収する", async () => {
  const env = fakeEnv();
  const lockPath = lockIn(env, String(process.pid));
  const ancient = new Date(Date.now() - 11 * 60_000);
  utimesSync(lockPath, ancient, ancient);
  assert.equal(await withRegistryLock(env, () => "done"), "done");
});

test("ロックは処理の後に解放される", async () => {
  const env = fakeEnv();
  await assert.rejects(withRegistryLock(env, () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withRegistryLock(env, () => "next"), "next");
});
