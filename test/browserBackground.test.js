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

test('自動表示を切っても検知のバッジと候補は残す', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  const badges = [];
  let opened = 0;
  let visit;
  const request = (value) => {
    const result = {};
    queueMicrotask(() => {
      result.result = value;
      result.onsuccess?.();
    });
    return result;
  };
  globalThis.indexedDB = {
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
  };
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
