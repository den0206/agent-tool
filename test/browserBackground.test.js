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

/**
 * 既に入っているものは**バッジを出さず**、popup を開いたときにだけ「導入済み」として
 * 見せる。毎回勧めないという方針は変えないが、開いた本人には「このページのものは入って
 * いる」と分かるようにする。
 */
test('導入済みの検知はバッジを出さず、popup を開いたときにだけ返す', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  const badges = [];
  let opened = 0;
  let visit;
  // 収集一覧に「同じ取得元から入った」という記録があり、実体も残っている場合だけ
  // 「導入済み」を返す。FSA で `present` を返せるようハンドルもモックする。
  const presentDir = {
    entries: async function* () {
      yield ['pdf', {}];                          // 探している名前が実在する
    },
  };
  const handle = {
    name: '.claude',
    queryPermission: async () => 'granted',
    getDirectoryHandle: async (sub) => sub === 'skills' ? presentDir : Promise.reject(),
  };
  globalThis.indexedDB = {
    open: () => {
      const result = {};
      queueMicrotask(() => {
        result.result = {
          transaction: (storeName) => ({
            objectStore: () => ({
              get: (key) => {
                if (storeName === 'collection' && key === 'list') {
                  return request([
                    {name: 'pdf', kind: 'skill', repo: 'acme/repo', root: '.claude/skills'},
                  ]);
                }
                if (storeName === 'handles' && key === '.claude') return request(handle);
                return request(undefined);
              },
              getAllKeys: () => request([]),
            }),
          }),
          close: () => {},
        };
        result.onsuccess?.();
      });
      return result;
    },
  };
  // カタログ URL は proofs が空なので、実在確認の HEAD は呼ばれない。
  globalThis.fetch = async () => {
    throw new Error('fetch は呼ばれないはず');
  };
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 3}],
    },
    action: {
      setBadgeText: async (value) => { badges.push(value); },
      setBadgeBackgroundColor: async () => {},
      openPopup: async () => { opened += 1; },
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?already-installed=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://skills.sh/acme/repo/pdf'},
      {tab: {id: 3}},
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(badges, []);                   // バッジは出さない
    assert.equal(opened, 0);                        // popup も自動では開かない
    // popup を開いた側からの問い合わせ。導入済みの URL が返る。
    const answer = await new Promise((resolve) => {
      visit({type: 'candidate'}, {}, resolve);
    });
    assert.deepEqual(answer, {
      url: '',
      index: null,
      installed: 'https://skills.sh/acme/repo/pdf',
    });
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * 別リポジトリの同名 Skill が収集一覧にあるだけでは「導入済み」と表示しない。
 * 名前一致だけで判定した過去のバグでは、`mattpocock/skills/grill-me` を
 * 見に行くと他所から入れた `grill-me` に反応して赤字で「導入済み」と出ていた。
 */
test('別リポジトリの同名 Skill だけでは「導入済み」と扱わない', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
  // 収集一覧には別リポジトリの `grill-me` が入っている。
  globalThis.indexedDB = {
    open: () => {
      const result = {};
      queueMicrotask(() => {
        result.result = {
          transaction: (storeName) => ({
            objectStore: () => ({
              get: (key) => {
                if (storeName === 'collection' && key === 'list') {
                  return request([
                    {name: 'grill-me', kind: 'skill', repo: 'someone-else/skills'},
                  ]);
                }
                return request(undefined);
              },
              getAllKeys: () => request([]),
            }),
          }),
          close: () => {},
        };
        result.onsuccess?.();
      });
      return result;
    },
  };
  // extractable の判定でアーカイブを取りにいくが、この検証では通信を切って落とす。
  // 「導入済み」扱いにしないことだけ確かめられれば十分。
  globalThis.fetch = async () => { throw new Error('no network'); };
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 11}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      openPopup: async () => {},
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?wrong-repo=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://skills.sh/mattpocock/skills/grill-me'},
      {tab: {id: 11}},
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const answer = await new Promise((resolve) => {
      visit({type: 'candidate'}, {}, resolve);
    });
    assert.equal(answer.installed, '');           // 赤字の「導入済み」は出さない
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * 収集一覧に残っていても、実体が消えていれば「導入済み」を出さず、その場で一覧から
 * 落とす。IDE 拡張・ファイルシステム・手動削除など、ブラウザ拡張の外で消された経路
 * に対応する。FSA の許可が生きているときにだけ確かめられる — 許可が取れないときは
 * `installedFromSameSource` が false を返して「導入済み」を出さない（次のテストで担保）。
 */
test('収集一覧に残っていても実体が消えていれば「導入済み」を出さず落とす', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
  let stored = [
    {name: 'pdf', kind: 'skill', repo: 'acme/repo', root: '.claude/skills'},
  ];
  const written = [];
  // `.claude/skills` を指すが中身が空のハンドル。`pdf` が見つからないので "missing"。
  const skillsDir = {
    entries: async function* () { /* 何も置いていない */ },
  };
  const handle = {
    name: '.claude',                           // rootStateOf('.claude', '.claude') が ok
    queryPermission: async () => 'granted',
    getDirectoryHandle: async (sub) => sub === 'skills' ? skillsDir : Promise.reject(),
  };
  globalThis.indexedDB = {
    open: () => {
      const result = {};
      queueMicrotask(() => {
        result.result = {
          transaction: (storeName) => ({
            objectStore: () => ({
              get: (key) => {
                if (storeName === 'collection' && key === 'list') return request(stored);
                // ハンドルは configDir（`.claude`）だけを鍵にして保存する。
                if (storeName === 'handles' && key === '.claude') return request(handle);
                return request(undefined);
              },
              getAllKeys: () => request([]),
              put: (value, key) => {
                if (storeName === 'collection' && key === 'list') {
                  written.push(value);
                  stored = value;
                }
                return request(undefined);
              },
            }),
          }),
          close: () => {},
        };
        result.onsuccess?.();
      });
      return result;
    },
  };
  globalThis.fetch = async () => { throw new Error('no network'); };
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 21}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      openPopup: async () => {},
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?stale-entry=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://skills.sh/acme/repo/pdf'},
      {tab: {id: 21}},
    );
    // stillOnDisk は 非同期のイテレータを回すので、待ちの回数を増やしておく。
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const answer = await new Promise((resolve) => {
      visit({type: 'candidate'}, {}, resolve);
    });
    assert.equal(answer.installed, '');           // 赤字の「導入済み」は出さない
    // 収集一覧からその1件が落ちている（forgetAll が呼ばれて空の配列を書く）。
    assert.deepEqual(written.at(-1), []);
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * FSA の許可が切れているとき（サービスワーカーが冷えて `queryPermission` が
 * `prompt` を返すとき）、収集一覧に記録があっても「導入済み」と出さない。
 * 記録を信じ切ると、ブラウザ拡張の外で削除されたものが冷える度に復活する。
 */
test('FSA の許可が取れないときは収集一覧に記録があっても「導入済み」を出さない', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
  // `queryPermission` が `prompt` を返す = 冷えた service worker と同じ状態。
  const handle = {
    name: '.claude',
    queryPermission: async () => 'prompt',
    getDirectoryHandle: async () => { throw new Error('should not reach'); },
  };
  globalThis.indexedDB = {
    open: () => {
      const result = {};
      queueMicrotask(() => {
        result.result = {
          transaction: (storeName) => ({
            objectStore: () => ({
              get: (key) => {
                if (storeName === 'collection' && key === 'list') {
                  return request([
                    {name: 'grill-me', kind: 'skill', repo: 'mattpocock/skills', root: '.claude/skills'},
                  ]);
                }
                if (storeName === 'handles' && key === '.claude') return request(handle);
                return request(undefined);
              },
              getAllKeys: () => request([]),
            }),
          }),
          close: () => {},
        };
        result.onsuccess?.();
      });
      return result;
    },
  };
  globalThis.fetch = async () => { throw new Error('no network'); };
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    webNavigation: {onHistoryStateUpdated: {addListener: () => {}}},
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 31}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      openPopup: async () => {},
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?prompt-permission=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://skills.sh/mattpocock/skills/grill-me'},
      {tab: {id: 31}},
    );
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const answer = await new Promise((resolve) => {
      visit({type: 'candidate'}, {}, resolve);
    });
    assert.equal(answer.installed, '');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});
