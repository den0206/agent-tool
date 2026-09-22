// 未対応サイトの Tool ページを **popup に渡して**検知できるかを見る。
//
// モジュールを直接叩くだけでは、popup が開かない・ボタンが効かない形の不具合を
// 捕まえられない（実測で取りこぼした）。ここは実ブラウザに拡張を読み込み、
// 実 `chrome.*` API と実ページで popup の導線をそのまま通す。
//
// `activeTab` はツールバーアイコンのクリックで付与されるもので、Playwright は
// ブラウザ UI のボタンを押せない。**そこだけ**テスト用にコピーした拡張へ対象サイトの
// host 権限を足して代替し、付与そのものは手動確認に残す。配布物は変えない。
//
// その host 権限は、自動検知にとっては「利用者がこのサイトを許可した」ことそのものである
// （許可の正本は `chrome.permissions` で、manifest 由来と実行時付与を区別できない）。
// つまりこのテストの拡張では自動検知も動く。直リンクのページは popup を開いた時点で
// 既に候補が出ているので、**押す前に出ているならそれを結果として読む**。
// 押さないと出ないページ（取得元だけ・まとめ）は今まで通り手動導線を通る。
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { withBrowser } from "./browser.mjs";
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
/** 開いた時点でもう出ているか。自動検知が先に解いたページはここで決まる。 */
const settled = async (popup) =>
  !await hidden(popup, "#found") || !await hidden(popup, "#index")
  || !await hidden(popup, "#choices");

async function outcome(popup) {
  // `aria-busy` が下りるまで待つ。`#ai-scan-status` は走っている間「探しています…」を
  // 出すので、文字が入ったことを完了と読むと途中経過を結果として拾う。
  await popup.waitForFunction(() => {
    const shown = id => !document.getElementById(id).hidden;
    return shown("found") || shown("index") || shown("choices")
      || document.getElementById("ai-scan").getAttribute("aria-busy") === "false";
  }, null, { timeout: DETECT_TIMEOUT_MS }).catch(() => { /* 下で状態を読む */ });

  if (!await hidden(popup, "#found")) {
    return { kind: "found", name: await textOf(popup, "#found-name"),
             repo: await textOf(popup, "#found-repo") };
  }
  if (!await hidden(popup, "#choices")) {
    return { kind: "choices",
             names: await popup.$$eval("#choices-list .choice-name strong",
                                       nodes => nodes.map(node => node.textContent)) };
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
  let failed = 0;

  try {
    // MV3 の service worker は headless で上がらないので、既定どおり GUI で起こす。
    await withBrowser(chromium, { prefix: "agent-tool-popup-profile-", extensionDir: copied },
                      async (browser, worker) => {
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

          // Jev を通るページは、自動で解けていても手動導線を 1 度は通す。鍵を取りに行くのは
          // 手動側だけで、そこを通らないと「空の鍵で 401」のような受け渡しの不具合が残る。
          let auto = await settled(popup);
          if (auto && expect.manual === true) {
            await click(popup, await hidden(popup, "#index") ? "dismiss" : "index-dismiss");
            await popup.waitForTimeout(300);
            await popup.goto(popupUrl, { waitUntil: "load" });
            await popup.waitForTimeout(700);
            auto = await settled(popup);
          }
          if (!auto) {
            if (await hidden(popup, "#ai-scan")) {
              console.error(`✗ popup ${name}: スキャンのカードが出ていない`);
              failed++;
              continue;
            }
            await click(popup, "ai-scan-button");
          }
          const result = await outcome(popup);
          const via = auto ? "自動" : "手動";

          if (expect.name !== undefined) {
            assert.equal(result.kind, "found", `${name}: ${JSON.stringify(result)}`);
            assert.equal(result.name, expect.name, `${name}: 名前が違う`);
            assert.equal(result.repo, expect.repo, `${name}: 取得元が違う`);
            console.log(`ok popup ${name}（${via}）: ${result.repo} ${result.name}`);
          } else if (expect.entries === true) {
            assert.equal(result.kind, "index", `${name}: ${JSON.stringify(result)}`);
            assert.ok(result.repo.startsWith(expect.repo), `${name}: 取得元が違う（${result.repo}）`);
            assert.ok(result.entries.length > 0, `${name}: 一覧が空`);
            console.log(`ok popup ${name}（${via}）: ${result.repo} → ${result.entries.join(", ")}`);
          } else if (expect.choices === true) {
            assert.equal(result.kind, "choices", `${name}: ${JSON.stringify(result)}`);
            assert.ok(result.names.length > 1, `${name}: 候補が 1 件しかない`);
            // 一覧を出せるだけでなく、選んだ1件のHEAD確認後に導入画面へ進むことまで通す。
            await popup.$eval("#choices-list button", node => node.click());
            await popup.waitForFunction(() => !document.getElementById("found").hidden
              || (document.getElementById("choices").getAttribute("aria-busy") === "false"
                && document.getElementById("choices-status").textContent.trim() !== ""),
              null, { timeout: DETECT_TIMEOUT_MS });
            assert.equal(await hidden(popup, "#found"), false,
                         `${name}: ${await textOf(popup, "#choices-status")}`);
            console.log(`ok popup ${name}（${via}）: ${result.names.length} 件から1件を確認`);
          } else {
            assert.equal(result.kind, "status", `${name}: ${JSON.stringify(result)}`);
            assert.match(result.text, expect.status, `${name}: 文言が違う（${result.text}）`);
            console.log(`ok popup ${name}（${via}）: ${result.text}`);
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
    });
  } finally {
    rmSync(copied, { recursive: true, force: true });
  }
  return failed;
}
