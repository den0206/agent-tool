#!/usr/bin/env node
// unpacked 拡張を Chromium に読み込み、対応サイトの URL を開いてバッジ表示まで通ることを見る。
// CI には入れない: 実サイト・実ネットワークの障害で通常テストを落とさない
// （test-browser-catalogs.mjs と同格の任意確認）。
//
// 事前準備:
//   npm run package:browser       # vsix/browser/ に unpacked を組み立てる
//   npx playwright install chromium
// 実行:
//   npm run test:browser
// GUI が無い環境:
//   xvfb-run -a npm run test:browser
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  agentsDirectoryUrl, githubSkillUrl, githubSkillsIndexUrl, skillsShUrl,
  warnIfGitHubRateLimited,
} from "./e2e/fixtures.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const extensionDir = resolve(here, "../vsix/browser");

if (!existsSync(extensionDir)) {
  console.error(`unpacked 拡張が見つかりません: ${extensionDir}`);
  console.error("`npm run package:browser` を先に流してください。");
  process.exit(2);
}

// 実測: HEAD 実在確認 → zip 展開確認 → バッジ設定まで数秒〜十数秒。余裕を持たせる。
const BADGE_TIMEOUT_MS = 60_000;
const GOTO_TIMEOUT_MS = 45_000;

// unpacked 拡張は persistent context にしか読ませられない。userDataDir は毎回捨てる。
// 空文字を渡す挙動は Playwright の版で変わるため、明示的に一時ディレクトリを掘る。
const userDataDir = mkdtempSync(join(tmpdir(), "agent-tool-e2e-"));

// --headless=new でも MV3 は動くが、環境依存で service worker が上がらないことがある。
// GUI 無しの場所は README のとおり xvfb-run で回す。
let context;

const cleanup = async () => {
  await context?.close().catch(() => { /* すでに閉じている */ });
  rmSync(userDataDir, { recursive: true, force: true });
};

// service worker の起動を待つ。--load-extension は同期に上がらない。
const waitForWorker = async () => {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent("serviceworker", { timeout: 15_000 });
};

// バッジが埋まるまで service worker 側で 250 ms ごとに読み直す。
// 実装は `chrome.action.setBadgeText({ text, tabId })` を叩くので、tabId を渡す必要がある。
const waitForBadge = async (worker, tabId) => worker.evaluate(async ({ tabId, deadline }) => {
  const start = Date.now();
  while (Date.now() - start < deadline) {
    const text = await chrome.action.getBadgeText({ tabId });
    if (text !== "") return text;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return "";
}, { tabId, deadline: BADGE_TIMEOUT_MS });

// Playwright の page と chrome の tabId を突き合わせる。SPA で URL が変わりうるので、
// prefix ではなく最終 URL でクエリして、無ければ active/currentWindow に落とす。
const tabIdFor = async (worker, page) => worker.evaluate(async url => {
  const [byUrl] = await chrome.tabs.query({ url });
  if (byUrl?.id !== undefined) return byUrl.id;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id;
}, page.url());

const cases = [
  {
    name: "GitHub Skill 単体",
    pickUrl: githubSkillUrl,
    expect: badge => badge === "1",
    describe: () => "badge='1' で 1 件検知",
  },
  {
    name: "skills.sh Skill 単体",
    pickUrl: skillsShUrl,
    expect: badge => badge === "1",
    describe: () => "badge='1' で 1 件検知",
  },
  {
    name: "agentsdirectory Skill",
    pickUrl: agentsDirectoryUrl,
    expect: badge => badge === "1",
    describe: () => "badge='1' で 1 件検知",
  },
  {
    name: "GitHub Skill インデックス",
    pickUrl: githubSkillsIndexUrl,
    expect: badge => /^\d+$/.test(badge) && Number(badge) >= 1,
    describe: () => "badge が件数（>=1）で一覧検知",
  },
];

let failed = 0;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  console.log("\n== 拡張を読み込んだ実ブラウザの検知（test-browser-e2e）==");
  await warnIfGitHubRateLimited();
  const worker = await waitForWorker();

  // 起動直後の about:blank タブは邪魔になるので閉じる（残っていれば）。
  for (const page of context.pages()) {
    if (page.url() === "about:blank") await page.close().catch(() => { /* すでに閉じた */ });
  }

  for (const { name, pickUrl, expect, describe } of cases) {
    let url;
    try {
      url = await pickUrl();
    } catch (error) {
      if (error instanceof TypeError) { console.log(`skip ${name}: network unavailable`); continue; }
      console.error(`✗ ${name}: URL 選定に失敗: ${error.message}`);
      failed++;
      continue;
    }

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
      // networkidle は SPA で戻ってこないことがあるので気長に待たない。
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const tabId = await tabIdFor(worker, page);
      if (tabId === undefined) {
        console.error(`✗ ${name}: ${url} → tabId が取れませんでした`);
        failed++;
        continue;
      }
      const badge = await waitForBadge(worker, tabId);
      if (!expect(badge)) {
        console.error(`✗ ${name}: ${url} → badge=${JSON.stringify(badge)}（期待: ${describe()}）`);
        failed++;
      } else {
        console.log(`ok ${name}: ${url} → badge=${badge}`);
      }
    } catch (error) {
      if (error instanceof TypeError) { console.log(`skip ${name}: network unavailable`); continue; }
      // タブが先に消えると `chrome.action.getBadgeText({ tabId })` が投げる。検知の結果では
      // なく計測の取りこぼしなので、実サイト由来の障害と同じく skip する（catalogs と同じ
      // 方針）。ここで落とすと `&&` で繋いだ後続スクリプトまで実行されなくなる。
      if (/No tab with id/.test(String(error.message))) {
        console.log(`skip ${name}: タブが先に閉じてバッジを読めませんでした`);
        continue;
      }
      console.error(`✗ ${name}: ${url} → ${error.message}`);
      failed++;
    } finally {
      await page.close().catch(() => { /* すでに閉じた */ });
    }
  }
} finally {
  await cleanup();
}

process.exitCode = failed === 0 ? 0 : 1;
