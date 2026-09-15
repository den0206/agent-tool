const {test} = require('node:test');
const assert = require('node:assert/strict');

const response = (body) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let read = false;
  return {
    ok: true,
    headers: {get: () => null},
    body: {
      getReader: () => ({
        read: async () =>
          read ? {done: true} : ((read = true), {done: false, value: bytes}),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
};

// 枠切れの応答（403 + x-ratelimit-remaining: 0）。fetchJson は !ok で null を返す。
const rateLimitedResponse = () => ({
  ok: false,
  status: 403,
  headers: {get: (key) => (key.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null)},
  body: null,
});

const request = (value) => {
  const result = {};
  queueMicrotask(() => {
    result.result = value;
    result.onsuccess?.();
  });
  return result;
};

const stubIndexedDB = () => ({
  open: () => {
    const result = {};
    queueMicrotask(() => {
      result.result = {
        transaction: () => ({
          objectStore: () => ({get: () => request(false)}),
        }),
        close: () => {},
      };
      result.onsuccess?.();
    });
    return result;
  },
});

test('自動表示を切っても検知のバッジと候補は残す', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  const badges = [];
  let opened = 0;
  let visit;
  globalThis.indexedDB = stubIndexedDB();
  globalThis.fetch = async () =>
    response({tree: [{path: 'pdf/SKILL.md', type: 'blob', size: 1}]});
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (listener) => {
          visit = listener;
        },
      },
    },
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {onRemoved: {addListener: () => {}}},
    action: {
      setBadgeText: async (value) => {
        badges.push(value);
      },
      setBadgeBackgroundColor: async () => {},
      // openPopup を実装側が `.catch(() => {})` で握るため、throw では回帰を検知できない。
      // 呼び出し回数を数えて明示的にゼロを確かめる。
      openPopup: async () => {
        opened += 1;
      },
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?auto-open-off=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://github.com/acme/tools/tree/main/skills'},
      {tab: {id: 1}},
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(badges, [{text: '1', tabId: 1}]);
    assert.equal(opened, 0);
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * GitHub API の枠切れ（403 + x-ratelimit-remaining: 0）で一覧が読めなかったときは、
 * 「並んでいない」と誤解させないよう "!" バッジと tooltip で告げる。popup は開かない
 * — 利用者ができるのは待つことだけで、開いても入れられるものは無い。
 */
test('API 枠切れで一覧が読めなかったら "!" バッジで告げる', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  const badges = [];
  const colors = [];
  const titles = [];
  let opened = 0;
  let visit;
  globalThis.indexedDB = stubIndexedDB();
  // 403 を返すたびに rate limit フラグが立つ経路を通す。
  globalThis.fetch = async () => rateLimitedResponse();
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {onRemoved: {addListener: () => {}}},
    i18n: {getMessage: (key) => (key === 'badgeRateLimited' ? 'rate limited' : '')},
    action: {
      setBadgeText: async (value) => { badges.push(value); },
      setBadgeBackgroundColor: async (value) => { colors.push(value); },
      setTitle: async (value) => { titles.push(value); },
      openPopup: async () => { opened += 1; },
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?rate-limit=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://github.com/acme/tools/tree/main/skills'},
      {tab: {id: 7}},
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(badges, [{text: '!', tabId: 7}]);
    assert.deepEqual(colors, [{color: '#c9411c', tabId: 7}]);
    assert.deepEqual(titles, [{tabId: 7, title: 'rate limited'}]);
    assert.equal(opened, 0);                        // popup は開かない
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});
