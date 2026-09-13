const { test } = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { ArchiveError, readTarGz } = require("../out/core/archive.js");
const { readTree, TreeReadLimitError } = require("../out/web/browser/fs.js");

const BLOCK = 512;
function header(name, size, flag) {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write(flag, 156);
  return block;
}
const pad = body => body.length % BLOCK === 0 ? body
  : Buffer.concat([body, Buffer.alloc(BLOCK - body.length % BLOCK)]);
function tar(entries) {
  const blocks = [];
  for (const [name, body, flag] of entries) {
    const bytes = Buffer.from(body);
    blocks.push(header(name, bytes.length, flag), pad(bytes));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks));
}
const streamOf = buffer => new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(buffer)); controller.close(); },
});

async function consume(buffer, limits) {
  for await (const _ of readTarGz(streamOf(buffer), limits)) { /* consume */ }
}

test("PAX/GNU 補助エントリも単一サイズ上限を超えられない", async () => {
  for (const flag of ["x", "L", "g"]) {
    await assert.rejects(
      () => consume(tar([["meta", "x".repeat(11), flag]]), { entries: 10, single: 10, total: 100 }),
      error => error instanceof ArchiveError && error.message.includes("too large"),
    );
  }
});

test("PAX/GNU 補助エントリも件数と合計サイズに数える", async () => {
  await assert.rejects(
    () => consume(tar([["pax1", "abc", "x"], ["pax2", "def", "x"]]),
      { entries: 1, single: 10, total: 100 }),
    error => error instanceof ArchiveError && error.message.includes("too many"),
  );
  await assert.rejects(
    () => consume(tar([["pax1", "abc", "x"], ["pax2", "def", "x"]]),
      { entries: 10, single: 10, total: 5 }),
    error => error instanceof ArchiveError && error.message.includes("too large"),
  );
});

const fileHandle = bytes => ({
  getFile: async () => ({ size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }),
});
const directory = entries => ({
  async *entries() { for (const entry of entries) yield entry; },
});
const rootWith = dir => ({ getDirectoryHandle: async () => dir });

test("既存ツリーの単一ファイルサイズを読み込み前に拒否する", async () => {
  const root = rootWith(directory([["large.bin", { kind: "file", ...fileHandle(new Uint8Array(11)) }]]));
  await assert.rejects(
    () => readTree(root, "skill", true, { entries: 10, single: 10, total: 100 }),
    error => error instanceof TreeReadLimitError && error.kind === "single",
  );
});

test("既存ツリーの件数と合計サイズを制限する", async () => {
  const entries = [
    ["a", { kind: "file", ...fileHandle(new Uint8Array(3)) }],
    ["b", { kind: "file", ...fileHandle(new Uint8Array(3)) }],
  ];
  await assert.rejects(
    () => readTree(rootWith(directory(entries)), "skill", true,
      { entries: 1, single: 10, total: 100 }),
    error => error instanceof TreeReadLimitError && error.kind === "entries",
  );
  await assert.rejects(
    () => readTree(rootWith(directory(entries)), "skill", true,
      { entries: 10, single: 10, total: 5 }),
    error => error instanceof TreeReadLimitError && error.kind === "total",
  );
});

// --- ブラウザの上書き退避 ---

const { install, InstallError } = require("../out/web/browser/install.js");
const { BROWSER_ROLLBACK_LIMIT, EXTRACTED_SIZE_LIMIT } = require("../out/core/limits.js");

/** 既存実体が `size` バイト 1 ファイルだけある置き場。消されたら記録する。 */
const rootHolding = (entry, size) => {
  const removed = [];
  const existing = directory([["big.bin", {
    kind: "file",
    getFile: async () => ({ size, arrayBuffer: async () => new ArrayBuffer(size) }),
  }]]);
  return {
    removed,
    root: {
      getFileHandle: async () => { throw new Error("not a file"); },
      getDirectoryHandle: async name =>
        name === entry ? existing : (() => { throw new Error("missing"); })(),
      removeEntry: async name => { removed.push(name); },
    },
  };
};

test("退避しきれない既存実体は、消さずに専用の理由で止める", async () => {
  const { root, removed } = rootHolding("pdf", BROWSER_ROLLBACK_LIMIT + 1);
  await assert.rejects(
    () => install({
      lead: { url: "https://example.test", source: { repo: "owner/repo", branch: "main" },
              kind: "skill", name: "pdf", proofs: [] },
      agent: "claude",
      placement: { configDir: ".claude", segments: ["skills"], entry: "pdf", isDirectory: true },
      root,
      overwrite: true,
      fetchFiles: async () => ({
        files: [{ path: "SKILL.md", bytes: new Uint8Array(4) }],
        sha: undefined,
        source: { repo: "owner/repo", branch: "main" },
      }),
    }),
    error => error instanceof InstallError && error.kind === "rollbackTooLarge",
  );
  // 退避できないと戻せない。**1 つも消さずに**止まっていること。
  assert.deepEqual(removed, []);
});

test("ブラウザの上書き退避は展開上限より小さいメモリ上限を使う", () => {
  assert.ok(BROWSER_ROLLBACK_LIMIT < EXTRACTED_SIZE_LIMIT);
});
