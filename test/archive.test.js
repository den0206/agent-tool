const { test } = require("node:test");
const assert = require("node:assert/strict");
const { firstUnwritable, readTarGz, safeSegments, unportableName, ArchiveError } =
  require("../out/core/archive.js");
const { gzipSync } = require("node:zlib");
const { header, streamOf, tarGz } = require("./tarFixture.js");

const readAll = async buffer => {
  const found = [];
  for await (const entry of readTarGz(streamOf(buffer))) found.push(entry);
  return found;
};

const rejects = (buffer, message) =>
  assert.rejects(() => readAll(buffer), error =>
    error instanceof ArchiveError && error.message.includes(message));

// --- エントリ名の検証 ---------------------------------------------------

test("展開先の外へ出るパスを弾く", () => {
  assert.equal(safeSegments("../escape"), null);
  assert.equal(safeSegments("a/../../b"), null);
  assert.equal(safeSegments("a\\b"), null);
  assert.equal(safeSegments("C:/windows"), null);
  assert.equal(safeSegments("a\0b"), null);
  assert.equal(safeSegments(""), null);
  assert.equal(safeSegments("./"), null);
});

test("普通のパスはセグメントに割る", () => {
  assert.deepEqual(safeSegments("repo-main/skills/pdf/SKILL.md"),
    ["repo-main", "skills", "pdf", "SKILL.md"]);
  assert.deepEqual(safeSegments("./repo-main//a.md"), ["repo-main", "a.md"]);
});

// --- tar.gz の読み取り --------------------------------------------------

test("ファイルとディレクトリを読む", async () => {
  const found = await readAll(tarGz([
    ["repo-main/", null],
    ["repo-main/SKILL.md", "---\nname: pdf\n---\n"],
  ]));
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { path: ["repo-main"], kind: "directory", bytes: new Uint8Array(0) });
  assert.deepEqual(found[1].path, ["repo-main", "SKILL.md"]);
  assert.equal(new TextDecoder().decode(found[1].bytes), "---\nname: pdf\n---\n");
});

test("512 の倍数でない中身も正しく切り出す", async () => {
  const body = "x".repeat(1000);
  const [entry] = await readAll(tarGz([["a/b.txt", body]]));
  assert.equal(entry.bytes.length, 1000);
  assert.equal(new TextDecoder().decode(entry.bytes), body);
});

test("細かいチャンクでもエントリ境界をまたいで読める", async () => {
  const archive = tarGz([["a/SKILL.md", "body"]]);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset === archive.length) return controller.close();
      controller.enqueue(new Uint8Array(archive.subarray(offset, ++offset)));
    },
  });
  const found = [];
  for await (const entry of readTarGz(stream)) found.push(entry);
  const [entry] = found;
  assert.equal(new TextDecoder().decode(entry.bytes), "body");
});

test("symlink と hardlink は中身を返さず link として渡す", async () => {
  // リポジトリ直下の CLAUDE.md が symlink というだけで取得ごと諦めさせない。
  // 取り出したいものの中にあるかは呼び出し側が判断する。
  const found = await readAll(tarGz([
    ["a/link", "", "2", { link: "/etc/passwd" }],
    ["a/hard", "", "1", { link: "a/real" }],
    ["a/real.md", "body"],
  ]));
  assert.deepEqual(found.map(entry => entry.kind), ["link", "link", "file"]);
  assert.deepEqual(found[0].bytes, new Uint8Array(0));
  assert.equal(new TextDecoder().decode(found[2].bytes), "body");
});

test("デバイスなどの特殊ファイルを拒否する", async () => {
  await rejects(tarGz([["a/dev", "", "3"]]), "unsupported file type");
});

test("展開先の外へ出るエントリを拒否する", async () => {
  await rejects(tarGz([["../escape.md", "x"]]), "escapes");
});

test("prefix と本体を繋いだ長いパスを読む", async () => {
  const [entry] = await readAll(tarGz([["SKILL.md", "x", "0", { prefix: "repo-main/skills/pdf" }]]));
  assert.deepEqual(entry.path, ["repo-main", "skills", "pdf", "SKILL.md"]);
});

test("pax の長い名前を次のエントリに効かせる", async () => {
  const long = "repo-main/" + "d/".repeat(60) + "SKILL.md";
  const record = `${`${` path=${long}\n`.length + 3}`} path=${long}\n`;
  const found = await readAll(tarGz([
    ["PaxHeader", record, "x"],
    ["ignored-short-name", "body"],
  ]));
  assert.equal(found.length, 1);
  assert.equal(found[0].path.join("/"), long);
});

test("GNU の長い名前も読む", async () => {
  const long = "repo-main/" + "e/".repeat(60) + "SKILL.md";
  const found = await readAll(tarGz([
    ["././@LongLink", long + "\0", "L"],
    ["ignored", "body"],
  ]));
  assert.equal(found[0].path.join("/"), long);
});

test("上限を超えたら読むのをやめる", async () => {
  const many = Array.from({ length: 5 }, (_, index) => [`a/${index}.txt`, "x"]);
  await assert.rejects(async () => {
    for await (const _ of readTarGz(streamOf(tarGz(many)), { entries: 3, single: 10, total: 100 })) { /* 読み進める */ }
  }, error => error instanceof ArchiveError && error.message.includes("too many files"));

  await assert.rejects(async () => {
    for await (const _ of readTarGz(streamOf(tarGz([["a/big.txt", "xxxxx"]])),
      { entries: 10, single: 3, total: 100 })) { /* 読み進める */ }
  }, error => error instanceof ArchiveError && error.message.includes("too large"));

  await assert.rejects(async () => {
    for await (const _ of readTarGz(streamOf(tarGz([["a/1.txt", "xxx"], ["a/2.txt", "xxx"]])),
      { entries: 10, single: 10, total: 5 })) { /* 読み進める */ }
  }, error => error instanceof ArchiveError && error.message.includes("too large"));
});

/**
 * size 欄は符号なし 8 進。負は `take` に負値が渡って `RangeError` になり、`ArchiveError`
 * として扱えなくなる（上位のマスク経路を外れる）。base-256 は 0 と誤読して本文をヘッダとして読む。
 */
test("読めない size を ArchiveError として拒否する", async () => {
  for (const raw of ["-0000001234", "-0000000001", "\x80\0\0\0\0\0\0\0\x02\0\0\0"]) {
    const block = header("a/b.txt", 0, "0");
    block.write(raw + "\0", 124, "binary");
    await rejects(gzipSync(Buffer.concat([block, Buffer.alloc(512, 0x78), Buffer.alloc(1024, 0)])),
                  "invalid entry size");
  }
});

test("size 欄が空でもディレクトリは読める", async () => {
  const block = header("a", 0, "5");
  block.write("\0".repeat(12), 124);                      // size を NUL で埋める実装がある
  const found = await readAll(gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)])));
  assert.deepEqual(found.map(entry => [entry.path.join("/"), entry.kind]), [["a", "directory"]]);
});

test("途中で切れたアーカイブを黙って受け入れない", async () => {
  const whole = Buffer.concat([header("a/b.txt", 1000, "0"), Buffer.alloc(200, 0x78)]);
  await rejects(gzipSync(whole), "ended in the middle");
});

// --- 書ける名前か（脱出防止とは別の検査） -------------------------------

test("3 OS のどこかで作れない名前を落とす", () => {
  for (const name of ["aux", "aux.md", "CON", "com1.txt", "lpt9",
                      "faq?.md", "a<b", "a>b", 'a"b', "a|b", "a*b",
                      "trailing.", "trailing ", "", "a\u0001b"]) {
    assert.equal(unportableName(name), true, name);
  }
});

test("実在する形の名前は通す", () => {
  for (const name of ["SKILL.md", "auxiliary.md", "console.md", "com.md", "日本語",
                      "a-1_2.v3", ".gitignore", "README"]) {
    assert.equal(unportableName(name), false, name);
  }
});

test("書けない名前を持つ最初のパスを返す", () => {
  assert.equal(firstUnwritable(["SKILL.md", "docs/ok.md"]), null);
  assert.equal(firstUnwritable(["SKILL.md", "docs/aux.md"]), "docs/aux.md");
  assert.equal(firstUnwritable(["a/b?/c.md"]), "a/b?/c.md");
});
