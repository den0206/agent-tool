// 使い捨てプロファイルでブラウザを 1 台起こす。3 本のスクリプトが同じ
// mkdtemp → launchPersistentContext → close → rmSync を書かないために置く。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param chromium     playwright の chromium（呼び出し側が import 済みのものを渡す）
 * @param options      prefix: 一時プロファイル名、extensionDir: unpacked 拡張、
 *                     headless: 拡張を読むときは MV3 の service worker が上がらないので既定 false
 * @param body         (context, worker) を受け取る。worker は extensionDir があるときだけ渡す
 */
export async function withBrowser(chromium, options, body) {
  const { prefix, extensionDir, headless = extensionDir === undefined } = options;
  const userDataDir = mkdtempSync(join(tmpdir(), prefix));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: extensionDir === undefined ? [] : [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    // --load-extension は同期に上がらない。既に居れば待たない。
    const worker = extensionDir === undefined ? undefined
      : context.serviceWorkers()[0]
        ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
    return await body(context, worker);
  } finally {
    await context?.close().catch(() => { /* すでに閉じている */ });
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
