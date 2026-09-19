const { strict: assert } = require("node:assert");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { API_RESPONSE_LIMIT, DIFF_TOTAL_LIMIT, diff, readLimitedText } = require("../out/ide/updater.js");

test("大きすぎる GitHub 応答は読み切らずに落とす", async () => {
  const body = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(API_RESPONSE_LIMIT);
      yield new Uint8Array(1);
    },
  };
  await assert.rejects(readLimitedText(body, API_RESPONSE_LIMIT), error => error.code === "FETCH_FAILED");
});

test("差分に載せる本文は合計で打ち切る", t => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-diff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const candidate = join(root, "candidate");
  mkdirSync(current); mkdirSync(candidate);
  for (let i = 0; i < 9; i += 1) writeFileSync(join(candidate, `${i}.md`), "x".repeat(250 * 1024));
  const files = diff(current, candidate, "tool").files;
  const retained = files.reduce((size, file) => size + Buffer.byteLength(file.before) + Buffer.byteLength(file.after), 0);
  assert.ok(retained <= DIFF_TOTAL_LIMIT);
  assert.equal(files.at(-1).path, "[additional changes omitted]");
});

test("更新差分は追加・削除・変更と manifest を要約する", t => {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-diff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const candidate = join(root, "candidate");
  mkdirSync(current); mkdirSync(candidate);
  writeFileSync(join(current, "removed.md"), "old");
  writeFileSync(join(current, "changed.md"), "old");
  writeFileSync(join(current, "package.json"), "{\"version\":\"1\"}");
  writeFileSync(join(candidate, "added.md"), "new");
  writeFileSync(join(candidate, "changed.md"), "new");
  writeFileSync(join(candidate, "package.json"), "{\"version\":\"2\"}");
  assert.deepEqual(diff(current, candidate, "tool").summary, {
    added: 1, removed: 1, changed: 2, manifestChanged: true, omitted: false,
  });
});

/**
 * 既定ブランチ名は推測しない。`main` で引くと既定ブランチが `master` のリポジトリが
 * 404 になり、追加も更新確認もできない。`HEAD` はどの ref でも既定ブランチに解決する。
 */
test("ブランチ未指定の SHA は HEAD で引く", async () => {
  const { resolveSha } = require("../out/ide/updater.js");
  const asked = [];
  const http = async url => {
    asked.push(url);
    return { status: 200, body: JSON.stringify({ sha: "abc" }), headers: {} };
  };
  assert.equal(await resolveSha({ repo: "o/r" }, http), "abc");
  assert.equal(await resolveSha({ repo: "o/r", branch: "master" }, http), "abc");
  assert.deepEqual(asked, [
    "https://api.github.com/repos/o/r/commits/HEAD",
    "https://api.github.com/repos/o/r/commits/master",
  ]);
});

test("見つからない取得元は HEAD を含む名前で理由を返す", async () => {
  const { resolveSha } = require("../out/ide/updater.js");
  await assert.rejects(
    resolveSha({ repo: "o/gone" }, async () => ({ status: 404, body: "", headers: {} })),
    error => error.code === "NOT_FOUND" && error.message.includes("o/gone#HEAD"));
});
