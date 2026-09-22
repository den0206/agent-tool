#!/usr/bin/env node
// 未対応サイトの Tool ページを、Jev 補助検知で拾えることを実ブラウザ・実 API で見る。
// CI には入れない: 実サイト・実 API・API key が要る（test-browser-catalogs.mjs と同格）。
//
// 事前準備:
//   npm run package:browser
//   npx playwright install chromium
//   JEV_TOKEN=<key> を環境変数か .secret に置く（無ければ skip する）
// 実行:
//   node scripts/test-browser-jev.mjs              # 固定ケースを検査する
//   node scripts/test-browser-jev.mjs <URL>        # 任意ページを段ごとに診断する
//
// 固定ケースは popup の導線をそのまま通す（`e2e/popup-jev.mjs`）。URL を渡した診断モードだけ
// はモジュール単位で見て、どの段で落ちたかを出力に出す。抽出はどちらも拡張と同じ
// `extractPageEvidence` を、拡張と同じやり方（ページの中で関数を実行する）で動かす。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirms, detectWithJev, narrowed } from "../out/web/browser/aiDetect.js";
import { decideWithJev } from "../out/web/browser/jev.js";
import { extractPageEvidence } from "../out/web/browser/pageEvidence.js";
import { catalog, needsPage, parseUrl } from "../out/web/core/github.js";
import { withBrowser } from "./e2e/browser.mjs";
import { warnIfGitHubRateLimited } from "./e2e/fixtures.mjs";
import { checkPopup } from "./e2e/popup-jev.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

const jevToken = () => {
  if (process.env.JEV_TOKEN !== undefined && process.env.JEV_TOKEN !== "") return process.env.JEV_TOKEN;
  const secret = resolve(here, "../.secret");
  if (!existsSync(secret)) return "";
  const line = readFileSync(secret, "utf8").split("\n").find(row => row.startsWith("JEV_TOKEN="));
  return line === undefined ? "" : line.slice("JEV_TOKEN=".length).trim();
};

// 未対応サイトの Tool ページ。対応サイトを増やしたらここから外す（下で検査する）。
// 固定 URL にするのは、Jev の判定を測るのに「ページが毎回変わらないこと」が要るため。
// 消えたら赤くする方針は fixtures.mjs と同じ。
const cases = [
  {
    name: "agenticskills.io（Skill 直リンク）",
    url: "https://agenticskills.io/skills/react-best-practices",
    expect: { repo: "vercel-labs/agent-skills", name: "react-best-practices" },
  },
  {
    name: "agenticskills.io（commit 固定とブランチが並ぶ）",
    url: "https://agenticskills.io/skills/taste-skill",
    expect: { repo: "Leonxlnx/taste-skill", name: "taste-skill" },
  },
  {
    name: "agenticskills.io（導入コマンドの例が並ぶ）",
    url: "https://agenticskills.io/skills/find-skills",
    expect: { repo: "vercel-labs/skills", name: "find-skills" },
  },
  {
    // Skill ディレクトリを `/blob/` で案内している（GitHub が `/tree/` へ読み替える形）。
    name: "aitmpl.com（blob URL で案内）",
    url: "https://www.aitmpl.com/component/skill/creative-design/frontend-design",
    expect: { repo: "davila7/claude-code-templates", name: "frontend-design" },
  },
  {
    // まとめページだが URL の末尾が Tool 名を名乗っている。候補 11 件から照合で決まる。
    name: "lazyskills.sh（URL が Tool 名を名乗る）",
    url: "https://lazyskills.sh/skills/frontend-design",
    expect: { repo: "anthropics/skills", name: "frontend-design" },
  },
  {
    name: "lazyskills.sh（まとめページの #fragment）",
    url: "https://lazyskills.sh/skills/react#vercel-react-best-practices",
    expect: { repo: "vercel-labs/agent-skills", name: "react-best-practices" },
  },
  {
    // 直リンクが無く Jev に訊く唯一のケース。同じ repo の `--skill` が並ぶので
    // 1 件に決めず、取得元だけを渡して popup の一覧に名前を決めさせる。
    name: "Supabase Docs（リポジトリだけ分かる）",
    url: "https://supabase.com/docs/guides/ai-tools/ai-skills",
    expect: { repo: "supabase/agent-skills", entries: true, manual: true },
  },
  {
    // 1 件に決め打たず、候補を並べて利用者に選ばせる。
    name: "lazyskills.sh（まとめページ）",
    url: "https://lazyskills.sh/skills/react",
    expect: { choices: true },
  },
];


// URL を 1 つ渡すと、そのページだけを診断モードで見る（`diagnose-jev-page` が使う）。
// 落ちた段を出力で示すためのもので、期待値は持たない。
const target = process.argv[2];
const probes = target === undefined ? [] : [{ name: "指定 URL", url: target, expect: null }];

const GOTO_TIMEOUT_MS = 45_000;

const apiKey = jevToken();
if (apiKey === "") {
  console.log("skip Jev 補助検知: JEV_TOKEN が無い（環境変数か .secret に置く）");
  process.exit(0);
}

// 鍵が無いときに playwright まで要求しない。未導入も落とさず skip する
// （`npm run test:browser` は先に `playwright install chromium` を流す）。
const chromium = await import("playwright").then(module => module.chromium, () => null);
if (chromium === null) {
  console.log("skip Jev 補助検知: playwright が入っていません（npm ci）");
  process.exit(0);
}

let failed = 0;
await warnIfGitHubRateLimited();
// 診断モードのときだけブラウザを起こす。固定ケースは popup 側が自分で起動する。
if (probes.length > 0) {
  console.log("\n== 指定 URL の診断（段ごと）==");
  await withBrowser(chromium, { prefix: "agent-tool-jev-" }, async browser => {
    for (const { name, url, expect } of probes) {
      // 対応サイトになったものを Jev で測り続けない（決定論的経路が正本）。
      if (parseUrl(url) !== null || needsPage(url) !== null || catalog(url) !== null) {
        console.log(`skip ${name}: 対応サイトです。決定論的経路（diagnose-tool-page）で見てください`);
        continue;
      }

      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        // 拡張の `chrome.scripting.executeScript({ func })` と同じ、関数をページで実行する形。
        const extracted = await page.evaluate(extractPageEvidence);
        const evidence = narrowed(extracted);
        if (expect === null) {
          console.log(`\n--- 1 抽出（絞り込み前 ${extracted.candidates.length} 件 → 後 ${evidence.candidates.length} 件）`);
          for (const item of evidence.candidates) console.log(`  ${item.id} ${item.kind}: ${item.value.slice(0, 120)}`);
          console.log(`  送信サイズ: ${JSON.stringify(evidence).length} bytes`);
        }
        assert.ok(evidence.candidates.length > 0, `${name}: 候補が 1 つも取れていません`);

        // 診断モードでは Jev の回答を素で見せる。どの段で落ちたかを出力で示すため。
        let decision;
        const result = await detectWithJev(evidence, apiKey, async (...args) => {
          decision = await decideWithJev(...args);
          return decision;
        }, confirms);
        if (expect === null) {
          console.log("--- 2 Jev の回答");
          console.log(decision === undefined
            ? "  呼んでいない（直リンクから決定論で決まった）"
            : `  is_tool_page=${decision.isToolPage.toFixed(2)} (>=0.80 が必要)`
              + ` / tool_kind=${decision.kind.choice}`);
          console.log(`--- 3 解決と実在確認 → ${result.kind}`);
        }
        // `repo` は「取得元まで決まった。名前は popup の一覧が決める」。名前まで期待して
        // いないケースではこれで合格とする。
        const found = result.kind === "found" ? result.lead
          : result.kind === "repo" ? { source: result.source, name: "(一覧から選ぶ)" }
          : result.kind === "many" ? { source: { repo: `${result.leads.length} 件` }, name: "(個別ページへ)" }
          : null;
        if (found === null) {
          console.error(`✗ ${name}: ${url} → ${result.kind}`
            + `（候補: ${evidence.candidates.map(item => item.value).join(" | ")}）`);
          failed++;
          continue;
        }
        console.log(`ok ${name}: ${url} → ${found.source.repo} ${found.name}`);
        if (expect === null) continue;
        assert.equal(found.source.repo, expect.repo, `${name}: 取得元が違います`);
        if (expect.name !== undefined) assert.equal(found.name, expect.name, `${name}: 名前が違います`);
      } catch (error) {
        // 実サイト・実 API 側の障害でオプトインテストを落とさない。枠切れも同じ扱い。
        if (error instanceof TypeError || error?.kind === "network" || error?.kind === "rateLimit") {
          console.log(`skip ${name}: ${error.message}`);
          continue;
        }
        console.error(`✗ ${name}: ${url} → ${error.message}`);
        failed++;
      } finally {
        await page.close().catch(() => { /* すでに閉じた */ });
      }
    }
  });
}

// 未対応サイトの Tool ページを popup へ渡して、検知できるかを見る。
// 診断モード（URL 指定）では回さない — 調べたいのはそのページで、回帰ではない。
if (target === undefined) {
  console.log(`\n== 未対応サイトの Tool ページを popup で検知（${cases.length} 件）==`);
  failed += await checkPopup(chromium, resolve(here, "../vsix/browser"), cases, apiKey);
}

process.exitCode = failed === 0 ? 0 : 1;
