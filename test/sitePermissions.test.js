const {test} = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../out/web/browser/sitePermissions.js');

test('originPattern は開いている origin ちょうど 1 つにする', async () => {
  const {originPattern} = await load();
  assert.equal(originPattern('https://example.com/foo'), 'https://example.com/*');
  assert.equal(originPattern('https://sub.example.com/foo?q=1#x'), 'https://sub.example.com/*');
  assert.equal(originPattern('https://example.com'), 'https://example.com/*');
  assert.equal(originPattern('https://Example.COM/foo'), 'https://example.com/*');
});

test('originPattern はサブドメインへ広げない', async () => {
  const {originPattern} = await load();
  const pattern = originPattern('https://sub.example.com/foo');
  assert.notEqual(pattern, 'https://*.example.com/*');
  assert.ok(!pattern.includes('*.'), pattern);
});

// match pattern はポートを表せない。落とすと別ポートまで許可してしまう。
test('originPattern は非既定ポートを拒否する', async () => {
  const {originPattern} = await load();
  assert.equal(originPattern('https://example.com:8443/a'), null);
});

test('originPattern は https 以外を受けない', async () => {
  const {originPattern} = await load();
  for (const url of ['http://example.com/a', 'http://localhost:3000/a', 'chrome://extensions',
                     'chrome-extension://abc/tab.html', 'file:///tmp/a', 'data:text/html,x',
                     'javascript:alert(1)', 'https://', 'not a url', '']) {
    assert.equal(originPattern(url), null, url);
  }
});

test('patternHost は hostEquals に渡せる形だけを返す', async () => {
  const {patternHost} = await load();
  assert.equal(patternHost('https://example.com/*'), 'example.com');
  assert.equal(patternHost('https://*/*'), null);
  assert.equal(patternHost('https://*.example.com/*'), null);
  assert.equal(patternHost('<all_urls>'), null);
});

// getAll() には manifest の host_permissions も混ざる。対応サイトは既存の決定論的経路の
// ものなので、Allowed Sites にも自動検知の対象にも出さない。
test('grantedSites は同梱の host_permissions を除く', async () => {
  const {grantedSites} = await load();
  const got = grantedSites([
    'https://github.com/*', 'https://api.github.com/*', 'https://raw.githubusercontent.com/*',
    'https://codeload.github.com/*', 'https://api.typesafe.ai/*',
    'https://skills.sh/*', 'https://www.skills.sh/*',
    'https://agentsdirectory.dev/*', 'https://www.agentsdirectory.dev/*',
    'https://lazyskills.sh/*', 'https://smithery.ai/*',
  ]);
  assert.deepEqual(got, ['https://lazyskills.sh/*', 'https://smithery.ai/*']);
});

test('grantedSites は空でも落ちない', async () => {
  const {grantedSites} = await load();
  assert.deepEqual(grantedSites([]), []);
});
