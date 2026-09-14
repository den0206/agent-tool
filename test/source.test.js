const { strict: assert } = require("node:assert");
const { test } = require("node:test");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { AGENT_IDS, ruleRoots, skillRoots, subagentRoots, supports } = require("../out/core/agent.js");
const { mcpSource } = require("../out/ide/agent.js");
const { MCP_SOURCES, SOURCES, relativePath, sourcePath } = require("../out/ide/source.js");

/** 踏むと数百 MB の I/O が走る、または触ってはいけない領域。 */
const forbidden = [
  "projects",          // ~/.claude/projects  129 MB
  "sessions",          // ~/.codex/sessions    20 MB
  "logs_",             // ~/.codex/logs_2.sqlite 44 MB
  "file-history",      // ~/.claude/file-history 17 MB
  "cache",
  "archived_sessions",
  "auth.json",
  "oauth_creds.json",
];

const env = { home: join(tmpdir(), "fake-home"), appSupport: join(tmpdir(), "fake-home", "storage") };

test("列挙が空でない", () => {
  assert.ok(SOURCES.length >= 20, `SOURCES.length = ${SOURCES.length}`);
});

test("禁止パスを 1 つも含まない", () => {
  for (const source of SOURCES) {
    const path = relativePath(source);
    if (path === null) continue;
    for (const word of forbidden) {
      assert.ok(!path.toLowerCase().includes(word), `${path} が禁止語 '${word}' を含む`);
    }
  }
});

test("解決後の絶対パスも禁止語を含まない", () => {
  for (const source of SOURCES) {
    const path = sourcePath(source, env);
    if (path === null) continue;
    for (const word of forbidden) {
      assert.ok(!path.toLowerCase().includes(word), `${path} が禁止語 '${word}' を含む`);
    }
  }
});

test("全 Source がホーム内か拡張の保存領域内に収まる", () => {
  for (const source of SOURCES) {
    const path = sourcePath(source, env);
    if (path === null) continue;
    assert.ok(path.startsWith(env.home) || path.startsWith(env.appSupport),
      `${path} がどちらのルートにも属さない`);
  }
});

/** Agent 側にルートを宣言してもスキャナが読まなければ、一覧は黙って「未導入」になる。 */
test("Agent が宣言したルートは必ず走査対象に載る", () => {
  const scanned = new Set(SOURCES.map(relativePath).filter(path => path !== null));
  for (const agent of AGENT_IDS) {
    for (const root of [...skillRoots(agent), ...subagentRoots(agent), ...ruleRoots(agent)]) {
      assert.ok(scanned.has(root), `${agent} が読む ${root} が SOURCES に無い`);
    }
  }
});

test("MCP 対応のエージェントには読み取り経路がある", () => {
  for (const agent of AGENT_IDS.filter(a => supports(a, "mcp"))) {
    const source = mcpSource(agent);
    assert.ok(source !== null, `${agent} は MCP 対応だが mcpSource が無い`);
    assert.ok(MCP_SOURCES.some(known => JSON.stringify(known) === JSON.stringify(source)),
      `${agent} の mcpSource が MCP_SOURCES から漏れている`);
  }
});
