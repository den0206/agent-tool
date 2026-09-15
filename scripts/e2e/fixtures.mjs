// 対応サイトごとに 1 本ずつ URL を引く。E2E とカタログスクリプトの共通ロジック。
// 固定 URL にはせず、消えたら赤くする方針（既存 githubSubagents と同じ）。
// 取り込み先は 2 か所（test-browser-e2e.mjs / test-browser-catalogs.mjs）だが、
// URL の選び方を 2 か所に書かないためにここへ寄せる。
import assert from "node:assert/strict";
import { fromJsonLd } from "../../out/web/core/github.js";
import { lead } from "../../out/web/core/detect.js";

const text = async url => {
  const response = await fetch(url, { cache: "no-store" });
  assert.ok(response.ok, `${url}: ${response.status}`);
  return response.text();
};
const pick = values => values[Math.floor(Math.random() * values.length)];
const matches = (body, pattern) => [...body.matchAll(pattern)].map(match => match[1]);

// GitHub Skill 単体。anthropics/skills から 1 本引く。
// 例示 URL: https://github.com/anthropics/skills/tree/main/skills/algorithmic-art
const anthropicsSkills = [
  "algorithmic-art", "artifacts-builder", "brand-guidelines", "canva-design",
  "docx", "pdf", "pptx", "webapp-testing", "xlsx",
];
export const githubSkillUrl = async () =>
  `https://github.com/anthropics/skills/tree/main/skills/${pick(anthropicsSkills)}`;

// GitHub Skill インデックス URL。/tree/main/skills を指すもの。
// 例示 URL: https://github.com/anthropics/skills/tree/main/skills
const skillIndexRepos = [
  "anthropics/skills",
  "vercel-labs/agent-skills",
];
export const githubSkillsIndexUrl = async () =>
  `https://github.com/${pick(skillIndexRepos)}/tree/main/skills`;

// Subagent はカタログに出ないので、GitHub の実リポジトリを固定で見る。
// カタログスクリプトが使っているセットを再利用する。
const githubSubagents = ["code-refactorer", "content-writer", "frontend-designer", "vibe-coding-coach"];
export const githubSubagentUrl = async () =>
  `https://github.com/iannuttall/claude-agents/blob/main/agents/${pick(githubSubagents)}.md`;

// skills.sh のカタログページ。sitemap から拾う。
// 例示 URL: https://www.skills.sh/heygen-com/hyperframes/hyperframes-cli
export const skillsShUrl = async () => {
  const maps = matches(await text("https://www.skills.sh/sitemap.xml"),
                       /<loc>([^<]*sitemap-skills[^<]*)<\/loc>/g);
  assert.ok(maps.length > 0, "skills.sh: no skill sitemap found");
  const urls = matches(await text(pick(maps)), /<loc>(https:\/\/[^<]+)<\/loc>/g);
  assert.ok(urls.length > 0, "skills.sh: no skill URL found");
  return pick(urls);
};

// GitHub API の残量を測り、少なければ警告する。0 だと `listSkills` / `download` が
// fetchFailed で落ち、テスト結果からは実装バグと区別が付かなくなる。判定は止めないが、
// 出力側で「サイトが悪い」と「枠が悪い」を取り違えないよう、実行前に印を残す。
export const warnIfGitHubRateLimited = async () => {
  try {
    const response = await fetch("https://api.github.com/rate_limit", { cache: "no-store" });
    if (!response.ok) return;
    const core = (await response.json()).resources?.core;
    if (core === undefined) return;
    const resetIn = Math.max(0, core.reset - Math.floor(Date.now() / 1000));
    if (core.remaining < 10) {
      console.warn(
        `⚠ GitHub API remaining=${core.remaining}. Some checks will be skipped or badges may stay empty.`
        + ` Reset in ${resetIn}s (${Math.ceil(resetIn / 60)} min).`);
    }
  } catch { /* preflight は失敗しても本体を止めない */ }
};

// Agents Directory のカタログページ。一覧から JSON-LD で解決可能なものを拾う。
// 例示 URL: https://agentsdirectory.dev/skills/azure-diagnostics/
export const agentsDirectoryUrl = async () => {
  const paths = [...new Set(matches(await text("https://agentsdirectory.dev/skills"),
                                    /href="(\/skills\/[^"?#]+)"/g))];
  assert.ok(paths.length > 0, "Agents Directory: no skill URL found");
  for (let left = Math.min(paths.length, 12); left > 0; left--) {
    const index = Math.floor(Math.random() * paths.length);
    const url = `https://agentsdirectory.dev${paths.splice(index, 1)[0]}`;
    const source = fromJsonLd(await text(url));
    if (source !== null && lead(source) !== null) return url;
  }
  throw new Error("Agents Directory: no installable skill URL found");
};
