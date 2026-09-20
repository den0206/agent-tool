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

/**
 * 自動検知の配線は `background.js` の読み込み時に必ず走る。許可サイトを見ないテストでは
 * 「1 件も許可していない」状態を返す。`grantedSites` が空なら listener は張られない。
 */
const navigationStubs = (origins = []) => ({
  webNavigation: {
    onCompleted: {addListener: () => {}, removeListener: () => {}},
    onHistoryStateUpdated: {addListener: () => {}, removeListener: () => {}},
  },
  permissions: {
    getAll: async () => ({origins}),
    contains: async () => false,
    onAdded: {addListener: () => {}},
    onRemoved: {addListener: () => {}},
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
    ...navigationStubs(),
    tabs: {onRemoved: {addListener: () => {}}},
    action: {
      setBadgeText: async (value) => {
        badges.push(value);
      },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
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
    ...navigationStubs(),
    tabs: {onRemoved: {addListener: () => {}}},
    i18n: {getMessage: (key) => (key === 'badgeRateLimited' ? 'rate limited' : '')},
    action: {
      setBadgeText: async (value) => { badges.push(value); },
      setBadgeBackgroundColor: async (value) => { colors.push(value); },
      setBadgeTextColor: async () => {},
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
    ...navigationStubs(),
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 3}],
    },
    action: {
      setBadgeText: async (value) => { badges.push(value); },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
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
    ...navigationStubs(),
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 11}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
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
 * ハンドルが IndexedDB に無いときは「導入済み」を出さない。同じ basename の別フォルダを
 * 選んでいる可能性があるので、検知の側では収集一覧から落とさない。
 */
test('設定ディレクトリのハンドルが無ければ「導入済み」を出さず、収集一覧も書き換えない', async () => {
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
  globalThis.indexedDB = {
    open: () => {
      const result = {};
      queueMicrotask(() => {
        result.result = {
          transaction: (storeName) => ({
            objectStore: () => ({
              get: (key) => {
                if (storeName === 'collection' && key === 'list') return request(stored);
                // ハンドルは持っていない（利用者が一度も許可していない状態）。
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
    ...navigationStubs(),
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 21}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      openPopup: async () => {},
    },
  };
  try {
    await import(
      `../out/web/browser/background.js?no-handle=${Date.now()}`
    );
    visit(
      {type: 'visited', url: 'https://skills.sh/acme/repo/pdf'},
      {tab: {id: 21}},
    );
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const answer = await new Promise((resolve) => {
      visit({type: 'candidate'}, {}, resolve);
    });
    assert.equal(answer.installed, '');           // ハンドルが無いので「導入済み」は出さない
    assert.deepEqual(written, []);                // 収集一覧は検知の側で書き換えない
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * FSA の許可が `prompt`（冷えた service worker）でも、ハンドルと収集一覧が残っていれば
 * 「導入済み」として popup で見せる。ブラウザを開き直すたびに「導入済み」が消えると、
 * 実際には入っているものが未導入のように見える回帰になる。
 */
test('許可が prompt でもハンドルと記録があれば「導入済み」を出す', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
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
    ...navigationStubs(),
    tabs: {
      onRemoved: {addListener: () => {}},
      query: async () => [{id: 31}],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
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
    assert.equal(answer.installed, 'https://skills.sh/mattpocock/skills/grill-me');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * 許可が `denied`（利用者が明示的に拒否した）ときは、記録があっても「導入済み」を出さない。
 * 拒否は「読ませない」という意思表示なので、記録を根拠に断言しない。
 */
test('許可が denied なら記録があっても「導入済み」を出さない', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
  const handle = {
    name: '.claude',
    queryPermission: async () => 'denied',
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
                if (storeName === 'collection' && key === 'list') return request([
                  {name: 'pdf', kind: 'skill', repo: 'acme/repo', root: '.claude/skills'},
                ]);
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
    ...navigationStubs(),
    tabs: {onRemoved: {addListener: () => {}}, query: async () => [{id: 51}]},
    action: {
      setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {}, openPopup: async () => {},
    },
  };
  try {
    await import(`../out/web/browser/background.js?denied=${Date.now()}`);
    visit({type: 'visited', url: 'https://skills.sh/acme/repo/pdf'}, {tab: {id: 51}});
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const answer = await new Promise((resolve) => visit({type: 'candidate'}, {}, resolve));
    assert.equal(answer.installed, '');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * 別 Agent へ追加した状態では、同じ取得元の記録が複数並ぶ。1 件目の許可が切れていても、
 * どこかの Agent に実体が残っていれば「導入済み」と出す — 先頭 1 件だけ見ると、
 * 「別 Agent に追加」を使った利用者だけ「導入済み」が消える回帰になる。
 */
test('別 Agent への追加で複数記録が並んでも、どれか 1 件でも残っていれば「導入済み」を出す', async () => {
  const saved = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    indexedDB: globalThis.indexedDB,
  };
  let visit;
  const presentDir = {
    entries: async function* () { yield ['pdf', {}]; },
  };
  // `.cursor` はまだ許可が取れない（`prompt`）。`.claude` は許可済みで実体あり。
  const cursor = {
    name: '.cursor', queryPermission: async () => 'prompt',
    getDirectoryHandle: async () => { throw new Error('should not reach'); },
  };
  const claude = {
    name: '.claude', queryPermission: async () => 'granted',
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
                if (storeName === 'collection' && key === 'list') return request([
                  {name: 'pdf', kind: 'skill', repo: 'acme/repo', root: '.cursor/skills', agent: 'cursor'},
                  {name: 'pdf', kind: 'skill', repo: 'acme/repo', root: '.claude/skills', agent: 'claude'},
                ]);
                if (storeName === 'handles' && key === '.claude') return request(claude);
                if (storeName === 'handles' && key === '.cursor') return request(cursor);
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
  globalThis.fetch = async () => { throw new Error('fetch は呼ばれないはず'); };
  globalThis.chrome = {
    runtime: {onMessage: {addListener: (listener) => { visit = listener; }}},
    ...navigationStubs(),
    tabs: {onRemoved: {addListener: () => {}}, query: async () => [{id: 41}]},
    action: {
      setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {}, openPopup: async () => {},
    },
  };
  try {
    await import(`../out/web/browser/background.js?multi-agent=${Date.now()}`);
    visit({type: 'visited', url: 'https://skills.sh/acme/repo/pdf'}, {tab: {id: 41}});
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const answer = await new Promise((resolve) => visit({type: 'candidate'}, {}, resolve));
    assert.equal(answer.installed, 'https://skills.sh/acme/repo/pdf');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/**
 * 自動検知の listener は許可済みホストで絞って張る。絞らずに張ると、権限を持たない
 * ホストの遷移まで届く（DOM は読めないが URL は見える）。挙動では気づけないので
 * 「addListener に何を渡したか」を直接見る。
 */
test('自動検知の listener は許可済みホストで絞る', async () => {
  const saved = {chrome: globalThis.chrome, indexedDB: globalThis.indexedDB};
  const filters = [];
  let onRemoved;
  globalThis.indexedDB = stubIndexedDB();
  globalThis.chrome = {
    runtime: {onMessage: {addListener: () => {}}},
    tabs: {onRemoved: {addListener: () => {}}},
    action: {},
    webNavigation: {
      onCompleted: {
        addListener: (_handler, filter) => filters.push(filter),
        removeListener: () => {},
      },
      onHistoryStateUpdated: {addListener: () => {}, removeListener: () => {}},
    },
    permissions: {
      // 同梱の host_permissions は自動検知の対象にしない。残るのは site.test だけ。
      getAll: async () => ({
        origins: ['https://github.com/*', 'https://skills.sh/*', 'https://site.test/*'],
      }),
      contains: async () => false,
      onAdded: {addListener: () => {}},
      onRemoved: {addListener: (handler) => { onRemoved = handler; }},
    },
  };
  try {
    await import(`../out/web/browser/background.js?filter=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(filters, [{url: [{hostEquals: 'site.test'}]}]);

    // 許可を消したら張り直す。フィルタは登録時に固定されるので、消しただけでは届き続ける。
    globalThis.chrome.permissions.getAll = async () => ({origins: ['https://github.com/*']});
    onRemoved();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(filters.length, 1, '許可ゼロで listener を張り直している');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.indexedDB = saved.indexedDB;
  }
});

/** 収集一覧も設定も空。`stubIndexedDB` は `false` を返すので自動検知の経路では使えない。 */
const emptyIndexedDB = () => {
  const reply = (value) => {
    const result = {};
    queueMicrotask(() => { result.result = value; result.onsuccess?.(); });
    return result;
  };
  return {
    open: () => reply({
      transaction: () => ({objectStore: () => ({get: () => reply(undefined)})}),
      close: () => {},
    }),
  };
};

/**
 * SPA は読み込み直後に `replaceState` を呼ぶことがあり、同じ URL で `onCompleted` と
 * `onHistoryStateUpdated` が続けて来る。2 回目で前ページの検知を下ろすと、
 * **直前に自分が出したバッジ**を消してしまう。下ろすのは読み直すときだけにする。
 */
test('同じ URL の重複イベントで自動検知のバッジを消さない', async () => {
  const saved = {chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB};
  const badges = [];
  let nav;
  globalThis.indexedDB = emptyIndexedDB();
  globalThis.fetch = async () => ({status: 200, ok: true, headers: {get: () => null}});
  globalThis.chrome = {
    runtime: {onMessage: {addListener: () => {}}},
    tabs: {onRemoved: {addListener: () => {}}, query: async () => []},
    action: {
      setBadgeText: async (value) => { badges.push(value.text); },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async () => {},
      openPopup: async () => {},
    },
    scripting: {
      executeScript: async () => [{result: {
        page: {url: 'https://site.test/skills/frontend-design', title: 't', headings: []},
        candidates: [{id: '0', kind: 'url',
          value: 'https://github.com/acme/skills/tree/main/skills/frontend-design'}],
      }}],
    },
    webNavigation: {
      onCompleted: {addListener: (handler) => { nav = handler; }, removeListener: () => {}},
      onHistoryStateUpdated: {addListener: (handler) => { nav = handler; }, removeListener: () => {}},
    },
    permissions: {
      getAll: async () => ({origins: ['https://site.test/*']}),
      contains: async () => true,
      onAdded: {addListener: () => {}},
      onRemoved: {addListener: () => {}},
    },
    storage: {local: {get: async () => ({}), set: async () => {}, setAccessLevel: async () => {}}},
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await import(`../out/web/browser/background.js?dup=${Date.now()}`);
    await settle();
    const url = 'https://site.test/skills/frontend-design';
    nav({tabId: 1, url, frameId: 0});
    await settle();
    assert.deepEqual(badges, ['1']);
    nav({tabId: 1, url, frameId: 0});
    await settle();
    assert.deepEqual(badges, ['1'], 'バッジを消しています');
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.indexedDB;
  }
});

// iframe の遷移でも `onCompleted` は来る。拾うと 1 ページで何度も読み、Jev も積む。
test('サブフレームの遷移では自動検知しない', async () => {
  const saved = {chrome: globalThis.chrome, indexedDB: globalThis.indexedDB};
  let scanned = 0;
  let nav;
  globalThis.indexedDB = emptyIndexedDB();
  globalThis.chrome = {
    runtime: {onMessage: {addListener: () => {}}},
    tabs: {onRemoved: {addListener: () => {}}, query: async () => []},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
             setBadgeTextColor: async () => {}, setTitle: async () => {}},
    scripting: {executeScript: async () => { scanned += 1; return [{result: null}]; }},
    webNavigation: {
      onCompleted: {addListener: (handler) => { nav = handler; }, removeListener: () => {}},
      onHistoryStateUpdated: {addListener: () => {}, removeListener: () => {}},
    },
    permissions: {
      getAll: async () => ({origins: ['https://site.test/*']}),
      contains: async () => true,
      onAdded: {addListener: () => {}},
      onRemoved: {addListener: () => {}},
    },
    storage: {local: {get: async () => ({}), set: async () => {}, setAccessLevel: async () => {}}},
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await import(`../out/web/browser/background.js?frame=${Date.now()}`);
    await settle();
    nav({tabId: 2, url: 'https://site.test/ad-frame', frameId: 3});
    await settle();
    assert.equal(scanned, 0, 'サブフレームでページを読んでいます');
    nav({tabId: 2, url: 'https://site.test/page', frameId: 0});
    await settle();
    assert.equal(scanned, 1);
  } finally {
    globalThis.chrome = saved.chrome;
    globalThis.indexedDB = saved.indexedDB;
  }
});
