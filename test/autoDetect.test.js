const {test} = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../out/web/browser/autoDetect.js');

// ページから採れた候補。`extractPageEvidence` が返す形だけを真似る。
const evidenceOf = (url, ...urls) => ({
  page: {url, title: 't', headings: []},
  candidates: urls.map((value, id) => ({id: String(id), kind: 'url', value})),
});

const SKILL = 'https://github.com/acme/skills/tree/main/skills/frontend-design';
const OTHER = 'https://github.com/acme/skills/tree/main/skills/backend-design';

// 呼び出し回数を数えられる依存。既定は「許可済み・鍵あり・枠あり・実在する」。
function deps(overrides = {}) {
  const calls = {allowed: 0, clear: 0, evidence: 0, key: 0, verify: 0, jev: 0, budget: 0};
  let clock = 0;
  return {
    calls,
    tick: (ms) => { clock += ms; },
    deps: {
      allowed: async () => { calls.allowed += 1; return overrides.allowed ?? true; },
      clear: async () => { calls.clear += 1; },
      evidence: async () => {
        calls.evidence += 1;
        return overrides.evidence === undefined ? evidenceOf('https://site.test/skills/frontend-design', SKILL)
          : overrides.evidence;
      },
      key: async () => { calls.key += 1; return 'key' in overrides ? overrides.key : 'test-key'; },
      budget: async () => { calls.budget += 1; return overrides.budget ?? true; },
      // 実 Jev は呼ばない。枠の判定は実装側が済ませたあとここへ来る。
      decide: async () => { calls.jev += 1; return jevAnswer(overrides); },
      verify: async () => { calls.verify += 1; return 'verify' in overrides ? overrides.verify : true; },
      now: () => clock,
    },
  };
}

// Jev の答え。既定は「Tool ページである・Skill」。
const jevAnswer = (overrides = {}) => ({
  isToolPage: overrides.isToolPage ?? 0.95,
  kind: {type: 'choice', choice: overrides.toolKind ?? 'skill', confidence: 0.9,
         probabilities: {skill: 0.9, subagent: 0, mcp: 0, plugin: 0, other: 0.1}},
});

test('許可が無ければページを読まない', async () => {
  const {automaticVisit} = await load();
  const d = deps({allowed: false});
  const result = await automaticVisit(1, 'https://site.test/skills/frontend-design', d.deps);
  assert.equal(result.kind, 'none');
  assert.equal(d.calls.evidence, 0);
  assert.equal(d.calls.verify, 0);
});

test('https 以外は権限の確認にも進まない', async () => {
  const {automaticVisit} = await load();
  for (const url of ['http://site.test/a', 'chrome://extensions', 'file:///tmp/a']) {
    const d = deps();
    assert.equal((await automaticVisit(2, url, d.deps)).kind, 'none', url);
    assert.equal(d.calls.allowed, 0, url);
  }
});

// 既知カタログは決定論的経路が正本。自動経路へ二重に入れない。
test('既知サイトは自動経路に入らない', async () => {
  const {automaticVisit} = await load();
  for (const url of ['https://github.com/acme/skills', 'https://skills.sh/acme/skills',
                     'https://agentsdirectory.dev/skills/foo']) {
    const d = deps();
    assert.equal((await automaticVisit(3, url, d.deps)).kind, 'none', url);
    assert.equal(d.calls.allowed, 0, url);
  }
});

test('ページ名と一致する 1 件なら found', async () => {
  const {automaticVisit} = await load();
  const d = deps();
  const result = await automaticVisit(4, 'https://site.test/skills/frontend-design', d.deps);
  assert.equal(result.kind, 'found');
  assert.equal(result.lead.name, 'frontend-design');
});

// 複数載っているページで 1 件に決めない。件数だけ出す。
test('複数候補は many で件数だけ返す', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: evidenceOf('https://site.test/list', SKILL, OTHER)});
  const result = await automaticVisit(5, 'https://site.test/list', d.deps);
  assert.deepEqual(result, {kind: 'many', count: 2});
  assert.equal(d.calls.verify, 0);
});

// Jev が「Tool を配っているページではない」と答えたら出さない（技術ブログなど）。
test('Tool ページでないと答えられたら none', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: evidenceOf('https://site.test/blog', 'https://github.com/facebook/react'),
                  isToolPage: 0.2});
  assert.equal((await automaticVisit(6, 'https://site.test/blog', d.deps)).kind, 'none');
  assert.equal(d.calls.jev, 1);
});

test('取得元に解決できる候補が無ければ Jev に訊かない', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: evidenceOf('https://site.test/owner', 'https://github.com/acme')});
  assert.equal((await automaticVisit(28, 'https://site.test/owner', d.deps)).kind, 'none');
  assert.equal(d.calls.jev, 0);
});

test('ページを読めなければ none', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: null});
  assert.equal((await automaticVisit(7, 'https://site.test/a', d.deps)).kind, 'none');
});

// 通信不能（null）を「無い」と言わない。ただし押していない利用者には黙る。
test('実在を確かめられなければ黙る', async () => {
  const {automaticVisit} = await load();
  // タブを分ける。同じタブ・同じ URL だと重複抑制の方で none になり、検査にならない。
  for (const [tabId, verify] of [[81, null], [82, false]]) {
    const d = deps({verify});
    const result = await automaticVisit(tabId, 'https://site.test/skills/frontend-design', d.deps);
    assert.equal(result.kind, 'none', String(verify));
    assert.equal(d.calls.verify, 1);
  }
});

test('同じ URL の連続イベントは 1 回に畳む', async () => {
  const {automaticVisit} = await load();
  const d = deps();
  const url = 'https://site.test/skills/frontend-design';
  assert.equal((await automaticVisit(9, url, d.deps)).kind, 'found');
  assert.equal((await automaticVisit(9, `${url}#section`, d.deps)).kind, 'none');
  assert.equal(d.calls.evidence, 1);
  // 弾かれた側は clear を通らない。直前に出したバッジを消さないため。
  assert.equal(d.calls.clear, 1);
  d.tick(600);
  assert.equal((await automaticVisit(9, url, d.deps)).kind, 'found');
  assert.equal(d.calls.evidence, 2);
});

test('URL が変われば畳まない', async () => {
  const {automaticVisit} = await load();
  const d = deps();
  assert.equal((await automaticVisit(10, 'https://site.test/skills/frontend-design', d.deps)).kind, 'found');
  await automaticVisit(10, 'https://site.test/skills/other', d.deps);
  assert.equal(d.calls.evidence, 2);
});

test('タブを閉じたら覚えていない', async () => {
  const {automaticVisit, forgetTab} = await load();
  const d = deps();
  const url = 'https://site.test/skills/frontend-design';
  await automaticVisit(11, url, d.deps);
  forgetTab(11);
  assert.equal((await automaticVisit(11, url, d.deps)).kind, 'found');
  assert.equal(d.calls.evidence, 2);
});

// 決定論で決まるページでは Jev を呼ばない。押さずに課金される分を増やさない。
test('直リンクで決まるページは Jev を呼ばない', async () => {
  const {automaticVisit} = await load();
  const d = deps();
  assert.equal((await automaticVisit(20, 'https://site.test/skills/frontend-design', d.deps)).kind, 'found');
  assert.equal(d.calls.jev, 0);
  assert.equal(d.calls.budget, 0);
});

test('まとめページも Jev を呼ばない', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: evidenceOf('https://site.test/list', SKILL, OTHER)});
  assert.deepEqual(await automaticVisit(21, 'https://site.test/list', d.deps), {kind: 'many', count: 2});
  assert.equal(d.calls.jev, 0);
});

// 直リンクが無いページ（実測: Supabase Docs）。ここだけ Jev に訊いて取得元を決める。
test('取得元しか分からないページは Jev に訊いて repo を返す', async () => {
  const {automaticVisit} = await load();
  const evidence = {
    page: {url: 'https://site.test/docs/ai-skills', title: 'AI Skills', headings: []},
    candidates: [
      {id: '0', kind: 'url', value: 'https://github.com/acme/agent-skills'},
      {id: '1', kind: 'command', value: 'npx skills add acme/agent-skills --skill foo'},
    ],
  };
  const d = deps({evidence});
  assert.deepEqual(await automaticVisit(22, 'https://site.test/docs/ai-skills', d.deps),
                   {kind: 'repo', repo: 'acme/agent-skills'});
  assert.equal(d.calls.jev, 1);
  assert.equal(d.calls.budget, 1);
});

test('鍵が無ければ Jev に進まない', async () => {
  const {automaticVisit} = await load();
  const d = deps({key: '', evidence: evidenceOf('https://site.test/docs', 'https://github.com/acme/skills')});
  assert.equal((await automaticVisit(23, 'https://site.test/docs', d.deps)).kind, 'none');
  assert.equal(d.calls.jev, 0);
});

test('鍵が無くても決定論で見つかる Skill は検知する', async () => {
  const {automaticVisit} = await load();
  const d = deps({key: ''});
  const result = await automaticVisit(29, 'https://site.test/skills/frontend-design', d.deps);
  assert.equal(result.kind, 'found');
  assert.equal(d.calls.jev, 0);
  assert.equal(d.calls.budget, 0);
  // 設定も読みに行かない。許可サイトの全遷移で storage を叩かないため。
  assert.equal(d.calls.key, 0);
});

test('枠を使い切ったら黙る', async () => {
  const {automaticVisit} = await load();
  const evidence = evidenceOf('https://site.test/docs', 'https://github.com/acme/skills');
  const d = deps({budget: false, evidence});
  assert.equal((await automaticVisit(24, 'https://site.test/docs', d.deps)).kind, 'none');
  assert.equal(d.calls.budget, 1);
  assert.equal(d.calls.jev, 0);
});

// Tool ページでないと答えられたら、同じ URL をもう一度訊かない（別タブでも）。
test('一度訊いた URL は再課金しない', async () => {
  const {automaticVisit} = await load();
  const evidence = evidenceOf('https://site.test/docs/again', 'https://github.com/acme/skills');
  const first = deps({evidence, isToolPage: 0.1});
  assert.equal((await automaticVisit(25, 'https://site.test/docs/again', first.deps)).kind, 'none');
  assert.equal(first.calls.jev, 1);
  const second = deps({evidence, isToolPage: 0.1});
  assert.equal((await automaticVisit(26, 'https://site.test/docs/again', second.deps)).kind, 'none');
  assert.equal(second.calls.jev, 0, '同じ URL でもう一度 Jev を呼んでいます');
});

test('同じ URL の同時検知は Jev を一度だけ呼ぶ', async () => {
  const {automaticVisit} = await load();
  const evidence = evidenceOf('https://site.test/docs/concurrent', 'https://github.com/acme/skills');
  let release;
  const first = deps({evidence, isToolPage: 0.1});
  first.deps.decide = async () => {
    first.calls.jev += 1;
    await new Promise(resolve => { release = resolve; });
    return jevAnswer({isToolPage: 0.1});
  };
  const second = deps({evidence, isToolPage: 0.1});
  const one = automaticVisit(30, 'https://site.test/docs/concurrent', first.deps);
  const two = automaticVisit(31, 'https://site.test/docs/concurrent', second.deps);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([one, two]);
  assert.equal(first.calls.jev + second.calls.jev, 1);
  assert.equal(first.calls.budget + second.calls.budget, 1);
});

test('MCP / Plugin は自動では告げない', async () => {
  const {automaticVisit} = await load();
  const d = deps({evidence: evidenceOf('https://site.test/mcp', 'https://github.com/acme/server'),
                  toolKind: 'mcp'});
  assert.equal((await automaticVisit(27, 'https://site.test/mcp', d.deps)).kind, 'none');
});

test('takeJevBudget は窓ごとに上限で止まり、窓が明ければ戻る', async () => {
  const {takeJevBudget} = await load();
  const {AUTO_JEV_LIMIT, AUTO_JEV_WINDOW_MS} = await import('../out/web/core/limits.js');
  let saved = {};
  const storage = {get: async (key) => ({[key]: saved[key]}),
                   set: async (items) => { saved = {...saved, ...items}; }};
  for (let i = 0; i < AUTO_JEV_LIMIT; i++) {
    assert.equal(await takeJevBudget(1000, storage), true, `${i} 回目`);
  }
  assert.equal(await takeJevBudget(1000, storage), false, '上限を超えて通しています');
  assert.equal(await takeJevBudget(1000 + AUTO_JEV_WINDOW_MS, storage), true);
  // どのサイトを見たかは持たない。
  assert.deepEqual(Object.keys(saved), ['autoJevBudget']);
  assert.deepEqual(Object.keys(saved.autoJevBudget).sort(), ['count', 'start']);
});
