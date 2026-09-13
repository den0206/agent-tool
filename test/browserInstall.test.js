/**
 * ブラウザ拡張の書き込み経路。File System Access API はメモリ実装で差し替える
 * （`test/fakeFs.js`）。権限ダイアログとピッカーは実機確認に残るが、上書き・巻き戻し・
 * 台帳・収集一覧の突き合わせはここで回せる。
 */
const { afterEach, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { fakeRoot } = require("./fakeFs.js");
const { installFakeIndexedDB } = require("./fakeIdb.js");
const { install, InstallError, remove, willOverwrite } = require("../out/web/browser/install.js");
const { exists, readTree, removeEntry, reserve, writeTree, WriteError } =
  require("../out/web/browser/fs.js");
const { isRemovable } = require("../out/core/collection.js");
const { treeHash } = require("../out/core/hash.js");
const { LEDGER_DIR } = require("../out/core/ledger.js");
const { loadCollection } = require("../out/web/browser/store.js");

// 収集一覧は IndexedDB にある。テストごとに空から始める。
let restoreIdb = () => {};
beforeEach(() => { restoreIdb = installFakeIndexedDB(); });
afterEach(() => { restoreIdb(); });

const lead = (overrides = {}) => ({
  url: "https://github.com/owner/repo/tree/main/skills/pdf",
  source: { repo: "owner/repo", branch: "main", subdir: "skills/pdf" },
  kind: "skill", name: "pdf", proofs: ["skills/pdf/SKILL.md"], ...overrides,
});

const placement = (overrides = {}) =>
  ({ configDir: ".claude", sub: "skills", entry: "pdf", isDirectory: true, ...overrides });

const text = body => new TextEncoder().encode(body);

/** 取得を差し替える。実際の通信もアーカイブ展開も通さない。 */
const fetched = (files, sha = "a".repeat(40)) => async () => ({
  files, sha, source: { repo: "owner/repo", branch: "main", subdir: "skills/pdf" },
});

const request = (root, overrides = {}) => ({
  lead: lead(), agent: "claude", placement: placement(), root, overwrite: true,
  fetchFiles: fetched([{ path: "SKILL.md", bytes: text("---\nname: pdf\n---\n新版\n") }]),
  ...overrides,
});

// --- writeTree / readTree / reserve -------------------------------------

test("展開済みの中身を置き場の下へ書く", async () => {
  const store = fakeRoot();
  await writeTree(store.handle, ["pdf"], [
    { path: "SKILL.md", bytes: text("本文") },
    { path: "reference/api.md", bytes: text("api") },
  ]);
  assert.deepEqual(store.tree(), { "pdf/SKILL.md": "本文", "pdf/reference/api.md": "api" });
});

test("展開先の外を指すパスは書かない", async () => {
  const store = fakeRoot();
  await assert.rejects(
    () => writeTree(store.handle, ["pdf"], [{ path: "../escaped.md", bytes: text("x") }]),
    error => error instanceof WriteError);
  assert.deepEqual(store.tree(), {});
});

test("読み出しはパスと内容をそのまま返す", async () => {
  const store = fakeRoot().seed("pdf/SKILL.md", "本文").seed("pdf/ref/a.md", "a");
  const files = await readTree(store.handle, "pdf", true);
  assert.deepEqual(files.map(file => file.path).sort(), ["SKILL.md", "ref/a.md"]);
  assert.equal(await readTree(store.handle, "missing", true), null);
});

/**
 * IDE 拡張が張った symlink は `getDirectoryHandle` でも `entries()` でも見えないのに
 * 名前は埋まっている。`create: true` で失敗して初めて分かる。
 */
test("作れない名前は取得の前に止める", async () => {
  const store = fakeRoot({ blocked: new Set(["pdf"]) });
  assert.equal(await exists(store.handle, "pdf"), false);
  await assert.rejects(() => reserve(store.handle, "pdf", true), error => error instanceof WriteError);

  let fetchCalled = false;
  await assert.rejects(
    () => install(request(store.handle, {
      overwrite: false,
      fetchFiles: async () => { fetchCalled = true; return { files: [], source: {} }; },
    })),
    error => error instanceof InstallError && error.kind === "blocked");
  assert.equal(fetchCalled, false);              // 無駄にアーカイブを落とさない
});

// --- install ------------------------------------------------------------

test("導入すると実体・台帳・収集一覧が揃う", async () => {
  const store = fakeRoot();
  const item = await install(request(store.handle));

  assert.deepEqual(store.tree(), {
    "pdf/SKILL.md": "---\nname: pdf\n---\n新版\n",
    [`${LEDGER_DIR}/pdf.json`]: JSON.stringify({
      name: "pdf", kind: "skill", repo: "owner/repo", branch: "main",
      subdir: "skills/pdf", sha: "a".repeat(40),
    }, null, 2) + "\n",
  });
  assert.equal(item.name, "pdf");
  assert.equal(item.root, ".claude/skills");
  assert.equal(item.sha, "a".repeat(40));
  // 収集一覧の hash は、**書いたもの**から計算する（削除の可否判定に使う）。
  assert.equal(item.treeHash, await treeHash(await readTree(store.handle, "pdf", true)));
});

test("Subagent は .md 1 つとして書く", async () => {
  const store = fakeRoot({ name: "agents" });
  await install(request(store.handle, {
    lead: lead({ kind: "subagent", name: "reviewer", proofs: ["agents/reviewer.md"] }),
    placement: placement({ sub: "agents", entry: "reviewer.md", isDirectory: false }),
    fetchFiles: fetched([{ path: "reviewer.md", bytes: text("---\nname: reviewer\n---\n") }]),
  }));
  assert.equal(store.tree()["reviewer.md"], "---\nname: reviewer\n---\n");
});

test("同名があって上書きを許していなければ、何も触らない", async () => {
  const store = fakeRoot().seed("pdf/SKILL.md", "旧版");
  assert.equal(await willOverwrite(request(store.handle)), true);
  await assert.rejects(
    () => install(request(store.handle, { overwrite: false })),
    error => error instanceof InstallError && error.kind === "blocked");
  assert.equal(store.tree()["pdf/SKILL.md"], "旧版");
});

/** 上書きは「重ねる」ではなく「置き換える」。旧版にしか無いファイルを残さない。 */
test("上書きは旧版を残さず置き換える", async () => {
  const store = fakeRoot().seed("pdf/SKILL.md", "旧版").seed("pdf/old-only.md", "消えるはず");
  await install(request(store.handle));
  assert.deepEqual(Object.keys(store.tree()).sort(),
    [`${LEDGER_DIR}/pdf.json`, "pdf/SKILL.md"]);
});

/** 取得に失敗したときに元のものが消えていると、利用者は新旧どちらも失う。 */
test("取得に失敗しても既存の実体には触れない", async () => {
  const store = fakeRoot().seed("pdf/SKILL.md", "旧版");
  await assert.rejects(() => install(request(store.handle, {
    fetchFiles: async () => { throw new InstallError("fetchFailed", "network"); },
  })), error => error instanceof InstallError && error.kind === "fetchFailed");
  assert.equal(store.tree()["pdf/SKILL.md"], "旧版");
});

test("取得に失敗したら、確保しただけの空の置き場を片付ける", async () => {
  const store = fakeRoot();
  await assert.rejects(() => install(request(store.handle, {
    overwrite: false,
    fetchFiles: async () => { throw new InstallError("fetchFailed", "network"); },
  })), error => error instanceof InstallError);
  assert.deepEqual(store.tree(), {});
});

/**
 * 3 OS のどこかで作れない名前は、**消したり書いたりする前に**落とす。
 * 途中で落ちると旧版も新版も無い状態が残る。
 */
test("Windows で作れない名前は、何も消さずに止める", async () => {
  for (const bad of ["aux.md", "a:b.md", "trailing.", "q?.md"]) {
    const store = fakeRoot().seed("pdf/SKILL.md", "旧版");
    await assert.rejects(() => install(request(store.handle, {
      fetchFiles: fetched([{ path: "SKILL.md", bytes: text("新") },
                           { path: bad, bytes: text("x") }]),
    })), error => error instanceof InstallError && error.kind === "unusableName", bad);
    assert.equal(store.tree()["pdf/SKILL.md"], "旧版", bad);
  }
});

/**
 * 書き込みが途中で落ちたら旧版へ戻す。File System Access API に rename が無いので、
 * 退避 → 削除 → 書き込みの順になり、途中で落ちると新旧どちらも無い状態が作れてしまう。
 * `failWrite` で 2 ファイル目の書き込みだけを落とす。
 */
test("書き込みが途中で落ちたら旧版へ戻す", async () => {
  const store = fakeRoot({ failWrite: 2 })
    .seed("pdf/SKILL.md", "旧版").seed("pdf/ref.md", "参照");
  await assert.rejects(() => install(request(store.handle, {
    fetchFiles: fetched([{ path: "SKILL.md", bytes: text("新") },
                         { path: "ref.md", bytes: text("新参照") }]),
  })), /disk full/);
  assert.deepEqual(store.tree(), { "pdf/SKILL.md": "旧版", "pdf/ref.md": "参照" });
});

// --- remove -------------------------------------------------------------

test("導入時と同じ実体なら消し、台帳も落とす", async () => {
  const store = fakeRoot();
  const item = await install(request(store.handle));
  assert.deepEqual((await loadCollection()).map(entry => entry.name), ["pdf"]);

  assert.equal(await remove(item, store.handle, true), "removed");
  // 実体と台帳 1 件だけを消す。`.agent-tool` ごとの再帰削除はしない。
  assert.deepEqual(store.tree(), { ".agent-tool/": "" });
  assert.deepEqual(await loadCollection(), []);
});

test("手で書き換えられたものは消さない", async () => {
  const store = fakeRoot();
  const item = await install(request(store.handle));
  await writeTree(store.handle, ["pdf"], [{ path: "SKILL.md", bytes: text("手で直した") }]);
  assert.equal(await remove(item, store.handle, true), "changed");
  assert.equal(store.tree()["pdf/SKILL.md"], "手で直した");
  assert.equal(isRemovable(item, await treeHash(await readTree(store.handle, "pdf", true))), false);
});

test("既に消えているものは収集一覧から落とすだけ", async () => {
  const store = fakeRoot();
  const item = await install(request(store.handle));
  await removeEntry(store.handle, "pdf", true);
  assert.equal(await remove(item, store.handle, true), "missing");
});

test("台帳が取り込まれていても削除は成功する", async () => {
  const store = fakeRoot();
  const item = await install(request(store.handle));
  // IDE 拡張が取り込んで台帳を消した状態。
  const ledgerDir = await store.handle.getDirectoryHandle(LEDGER_DIR);
  await ledgerDir.removeEntry("pdf.json");
  assert.equal(await remove(item, store.handle, true), "removed");
});
