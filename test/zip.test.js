const { strict: assert } = require("node:assert");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { deflateRawSync } = require("node:zlib");
const { discard, stageZip } = require("../out/ide/fetcher.js");
const { install } = require("../out/ide/installer.js");
const { empty } = require("../out/ide/registry.js");
const { skillStore } = require("../out/ide/env.js");
const { fakeEnv, writeFileIn } = require("./helpers.js");

const code = expected => error => error.code === expected;

/** [name, body, { declared?, link? }] から deflate の zip を組む。CRC は読み手が見ないので 0。 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body = "", options = {}] of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(body);
    const data = name.endsWith("/") ? raw : deflateRawSync(raw);
    const method = name.endsWith("/") ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(options.declared ?? raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(((options.link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const skill = name => `---\nname: ${name}\ndescription: d\n---\n`;

test("Finder で圧縮したフォルダの Skill を取り出し、__MACOSX は捨てる", async () => {
  const staging = await stageZip({ name: "pdf.zip", bytes: zip([
    ["pdf/", ""],
    ["pdf/SKILL.md", skill("pdf")],
    ["pdf/scripts/run.sh", "echo hi"],
    ["__MACOSX/pdf/._SKILL.md", "junk"],
  ]) });
  try {
    assert.deepEqual(staging.candidates.map(c => [c.kind, c.name]), [["skill", "pdf"]]);
    assert.equal(readFileSync(join(staging.candidates[0].localPath, "scripts", "run.sh"), "utf8"), "echo hi");
    assert.equal(existsSync(join(staging.root, "pdf", "__MACOSX")), false);
  } finally {
    discard(staging);
  }
});

test("直下に SKILL.md だけを置いた zip は、ファイル名を Skill 名にする", async () => {
  const staging = await stageZip({ name: "my-skill.zip", bytes: zip([["SKILL.md", "---\ndescription: d\n---\n"]]) });
  try {
    assert.deepEqual(staging.candidates.map(c => [c.kind, c.name]), [["skill", "my-skill"]]);
  } finally {
    discard(staging);
  }
});

test("Subagent の .md 1 枚だけの zip も入れられる", async () => {
  const staging = await stageZip({ name: "x.zip", bytes: zip([["reviewer.md", skill("reviewer")]]) });
  try {
    assert.deepEqual(staging.candidates.map(c => [c.kind, c.name]), [["subagent", "reviewer"]]);
  } finally {
    discard(staging);
  }
});

test("展開先の外へ出る zip は丸ごと拒む", async () => {
  await assert.rejects(stageZip({ name: "x.zip", bytes: zip([["../evil/SKILL.md", skill("evil")]]) }),
    code("FETCH_FAILED"));
});

test("目次の申告より膨らむ zip は展開の途中で止める", async () => {
  await assert.rejects(stageZip({ name: "x.zip",
    bytes: zip([["a/SKILL.md", skill("a") + "x".repeat(100_000), { declared: 10 }]]) }),
  /zip file is corrupt/);
});

test("Skill の中の symlink は書かずに止める", async () => {
  await assert.rejects(stageZip({ name: "x.zip", bytes: zip([
    ["a/SKILL.md", skill("a")],
    ["a/ref.md", "/etc/passwd", { link: true }],
  ]) }), /is a link and cannot be installed/);
});

test("zip でないものは FETCH_FAILED にする", async () => {
  await assert.rejects(stageZip({ name: "x.zip", bytes: Buffer.from("not a zip") }), code("FETCH_FAILED"));
});

test("ファイルから読み、取得元を持たない entry として入れる", async () => {
  const env = fakeEnv();
  const file = writeFileIn(join(env.home, "dl", "pdf.zip"), zip([["pdf/SKILL.md", skill("pdf")]]));
  const staging = await stageZip({ path: file });
  try {
    const registry = empty();
    install(staging.candidates[0], staging, env, registry);
    assert.ok(existsSync(join(skillStore(env), "pdf", "SKILL.md")));
    const entry = registry.resources.find(item => item.name === "pdf");
    assert.equal(entry.repo, undefined);
  } finally {
    discard(staging);
  }
  assert.equal(existsSync(staging.root), false);
});
