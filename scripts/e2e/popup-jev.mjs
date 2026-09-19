// 未対応サイトの Tool ページを **popup に渡して**検知できるかを見る。
//
// モジュールを直接叩くだけでは、popup が開かない・ボタンが効かない形の不具合を
// 捕まえられない（実測で取りこぼした）。ここは実ブラウザに拡張を読み込み、
// 実 `chrome.*` API と実ページで popup の導線をそのまま通す。
//
// `activeTab` はツールバーアイコンのクリックで付与されるもので、Playwright は
// ブラウザ UI のボタンを押せない。**そこだけ**テスト用にコピーした拡張へ対象サイトの
// host 権限を足して代替し、付与そのものは手動確認に残す。配布物は変えない。
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOTO_TIMEOUT_MS = 45_000;
const DETECT_TIMEOUT_MS = 60_000;

/** popup のボタンは背面タブでも押せるようにする（前面は対象ページに譲る）。 */
const click = (page, id) => page.evaluate(target => {
  document.getElementById(target).click();
}, id);

const textOf = (page, selector) => page.$eval(selector, node => node.textContent.trim());
const hidden = (page, selector) => page.$eval(selector, node => node.hidden);

/** 対象サイトの host 権限だけを足した拡張のコピーを作る。 */
function testBuild(source, origins) {
  const dir = mkdtempSync(join(tmpdir(), "agent-tool-popup-"));
  cpSync(source, dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.host_permissions = [...new Set([...manifest.host_permissions,
                                           ...origins.map(origin => `${origin}/*`)])];
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * popup が出した結果を読む。カード・一覧・状態表示のどれに出たかで返す。
 * どれも出ないまま待ち切ったら、その時点の状態を返して呼び出し側に判定させる。
 */
async function outcome(popup) {
  // `aria-busy` が下りるまで待つ。`#ai-scan-status` は走っている間「探しています…」を
  // 出すので、文字が入ったことを完了と読むと途中経過を結果として拾う。
  await popup.waitForFunction(() => {
    const shown = id => !document.getElementById(id).hidden;
    return shown("found") || shown("index")
      || document.getElementById("ai-scan").getAttribute("aria-busy") === "false";
  }, null, { timeout: DETECT_TIMEOUT_MS }).catch(() => { /* 下で状態を読む */ });

  if (!await hidden(popup, "#found")) {
    return { kind: "found", name: await textOf(popup, "#found-name"),
             repo: await textOf(popup, "#found-repo") };
  }
  if (!await hidden(popup, "#index")) {
    return { kind: "index", repo: await textOf(popup, "#index-repo"),
             entries: await popup.$$eval("#index-list li .name", nodes => nodes.map(n => n.textContent)) };
  }
  return { kind: "status", text: await textOf(popup, "#ai-scan-status") };
}

export async function checkPopup(chromium, extensionDir, cases, apiKey) {
  const origins = [...new Set(cases.map(item => new URL(item.url).origin))];
  const copied = testBuild(extensionDir, origins);
  const userDataDir = mkdtempSync(join(tmpdir(), "agent-tool-popup-profile-"));
  let browser;
  let failed = 0;

  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: false,                    // MV3 の service worker は headless で上がらない
      args: [`--disable-extensions-except=${copied}`, `--load-extension=${copied}`,
             "--no-first-run", "--no-default-browser-check"],
    });
    const worker = browser.serviceWorkers()[0]
      ?? await browser.waitForEvent("serviceworker", { timeout: 20_000 });
    const id = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${id}/browser/tab.html`;

    // 鍵は設定画面から入れる。ここで「保存すると有効になる」も一緒に通る。
    const popup = await browser.newPage();
    await popup.goto(popupUrl, { waitUntil: "load" });
    await popup.waitForTimeout(600);
    await click(popup, "open-settings");
    await popup.waitForTimeout(300);
    assert.equal(await popup.$eval("#jev-enabled", node => node.disabled), true,
                 "鍵が無いのにトグルを押せる");
    await popup.evaluate(key => {
      document.getElementById("jev-api-key").value = key;
      document.getElementById("jev-save").click();
    }, apiKey);
    await popup.waitForTimeout(500);
    assert.equal(await popup.$eval("#jev-enabled", node => node.checked), true,
                 "鍵を保存しても有効にならない");

    const site = await browser.newPage();
    for (const { name, url, expect } of cases) {
      try {
        await site.goto(url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
        await site.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        await site.bringToFront();
        // popup は開くたびに新しい文脈になる。実際の使われ方と同じく開き直す。
        await popup.goto(popupUrl, { waitUntil: "load" });
        await popup.waitForTimeout(700);

        if (await hidden(popup, "#ai-scan")) {
          console.error(`✗ popup ${name}: スキャンのカードが出ていない`);
          failed++;
          continue;
        }
        await click(popup, "ai-scan-button");
        const result = await outcome(popup);

        if (expect.name !== undefined) {
          assert.equal(result.kind, "found", `${name}: ${JSON.stringify(result)}`);
          assert.equal(result.name, expect.name, `${name}: 名前が違う`);
          assert.equal(result.repo, expect.repo, `${name}: 取得元が違う`);
          console.log(`ok popup ${name}: ${result.repo} ${result.name}`);
        } else if (expect.entries === true) {
          assert.equal(result.kind, "index", `${name}: ${JSON.stringify(result)}`);
          assert.ok(result.repo.startsWith(expect.repo), `${name}: 取得元が違う（${result.repo}）`);
          assert.ok(result.entries.length > 0, `${name}: 一覧が空`);
          console.log(`ok popup ${name}: ${result.repo} → ${result.entries.join(", ")}`);
        } else {
          assert.equal(result.kind, "status", `${name}: ${JSON.stringify(result)}`);
          assert.match(result.text, expect.status, `${name}: 文言が違う（${result.text}）`);
          console.log(`ok popup ${name}: ${result.text}`);
        }
      } catch (error) {
        // 実サイト・実 API 側の障害でオプトインテストを落とさない。
        if (error instanceof TypeError) {
          console.log(`skip popup ${name}: network unavailable`);
          continue;
        }
        console.error(`✗ popup ${name}: ${error.message.split("\n")[0]}`);
        failed++;
      }
    }

    // 鍵を消したら Beta を丸ごと閉じる（鍵の無い「有効」を残さない）。
    await popup.goto(popupUrl, { waitUntil: "load" });
    await popup.waitForTimeout(600);
    await click(popup, "open-settings");
    await popup.waitForTimeout(300);
    await click(popup, "jev-delete");
    await popup.waitForTimeout(400);
    assert.equal(await popup.$eval("#jev-enabled", node => node.disabled), true,
                 "鍵を消してもトグルが押せる");
    console.log("ok popup 鍵の保存と削除でトグルの活性が切り替わる");
  } finally {
    await browser?.close().catch(() => { /* すでに閉じている */ });
    rmSync(copied, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
  return failed;
}
