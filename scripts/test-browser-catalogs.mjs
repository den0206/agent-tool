#!/usr/bin/env node
// 任意の実サイト確認。CI には入れない: カタログ側の障害で通常テストを落とさない。
// 取り込むのはブラウザ向けの ESM 出力なので、このスクリプトも ESM にする
// （Node 20 は ESM を require できない）。
import assert from "node:assert/strict";
import { firstUnwritable } from "../out/web/core/archive.js";
import { lead, proofUrls } from "../out/web/core/detect.js";
import { download } from "../out/web/browser/install.js";
import { fromJsonLd, needsPage } from "../out/web/core/github.js";
import { PAGE_LIMIT } from "../out/web/core/limits.js";
import { placement, targets } from "../out/web/core/placement.js";
import {
  agentsDirectoryUrl, githubSkillUrl, githubSubagentUrl, skillsShUrl,
  warnIfGitHubRateLimited,
} from "./e2e/fixtures.mjs";

const isRejectedCatalog = error => error?.kind === "notFound" || error?.kind === "tooLarge";

// 対応サイトごとに 1 本引く。URL の選び方は fixtures.mjs に寄せて E2E と共有する。
const sites = [
  ["GitHub", githubSkillUrl],
  ["GitHub (subagent)", githubSubagentUrl],
  ["skills.sh", skillsShUrl],
  ["Agents Directory", agentsDirectoryUrl],
];

async function resolve(url) {
  if (needsPage(url) === null) return url;
  const response = await fetch(url, { cache: "no-store" });
  assert.ok(response.ok, `${url}: ${response.status}`);
  return fromJsonLd((await response.text()).slice(0, PAGE_LIMIT));
}

void (async () => {
  await warnIfGitHubRateLimited();
  for (const [site, randomUrl] of sites) {
    attempts:
    for (let attempt = 1; attempt <= 12; attempt++) {
      let url;
      let found;
      try {
        url = await randomUrl();
        found = lead(await resolve(url));
      } catch (error) {
        if (error instanceof TypeError) {
          console.log(`skip ${site}: network unavailable`);
          break attempts;
        }
        throw error;
      }
      assert.ok(found !== null, `${site}: no installable tool found`);
      try {
        for (const proof of proofUrls(found)) {
          const response = await fetch(proof, { method: "HEAD", cache: "no-store" });
          if (response.status !== 200) {
            if (attempt === 12) assert.fail(`${site}: ${proof}: ${response.status}`);
            console.log(`skip ${site}: ${proof} → ${response.status}`);
            continue attempts;
          }
        }
        const { files } = await download(found);
        assert.ok(files.length > 0, `${site}: no files extracted`);
        assert.ok(files.some(file => file.path === (found.kind === "skill" ? "SKILL.md" : `${found.name}.md`)),
          `${site}: tool entry was not extracted`);
        // 「検知はするが導入で落ちる」を実機なしで捕まえる。FSA の書き込みは試せないが、
        // 3 OS のどこかで作れない名前が入っていないかは取得結果だけで分かる。
        const bad = firstUnwritable([found.name, ...files.map(file => file.path)]);
        assert.equal(bad, null, `${site}: ${bad} cannot be written on every system`);
        const agent = targets(found.kind)[0];
        assert.ok(placement(agent, found.kind, found.name, false) !== null, `${site}: no destination`);
        console.log(`ok ${site}: ${url} → ${found.kind} ${found.name}`);
        break;
      } catch (error) {
        if (error instanceof TypeError) {
          console.log(`skip ${site}: network unavailable`);
          break attempts;
        }
        // API 枠切れや一時的な取得失敗は、別 URL を引き直しても同じ壁に当たる。
        // 実サイト由来の障害でオプトインテストを落とさないよう、サイトごと skip する。
        if (error?.kind === "fetchFailed") {
          console.log(`skip ${site}: ${error.message} (rate limit or transient fetch failure)`);
          break attempts;
        }
        if (found.proofs.length !== 0 || !isRejectedCatalog(error) || attempt === 12) throw error;
        console.log(`skip ${site}: ${url} → ${error.kind}`);
      }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
