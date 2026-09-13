/**
 * IndexedDB のメモリ実装。`browser/store.ts` が使う分だけを持つ。
 *
 * 収集一覧はブラウザ拡張の削除の可否判定そのものなので、導入・削除のテストは
 * ここを通らないと組めない。ハンドラは呼び出し後に代入されるため、要求の完了は
 * すべて microtask へ遅らせる（本物と同じ順序になる）。
 */

const settle = (request, run) => {
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });
  return request;
};

/** テストごとに呼んで `globalThis.indexedDB` を空にする。後片付けを返す。 */
function installFakeIndexedDB() {
  const stores = new Map();
  const previous = globalThis.indexedDB;

  const objectStore = name => {
    const map = stores.get(name);
    return {
      get: key => settle({}, () => map.get(key)),
      put: (value, key) => settle({}, () => (map.set(key, value), key)),
      delete: key => settle({}, () => (map.delete(key), undefined)),
      getAllKeys: () => settle({}, () => [...map.keys()]),
    };
  };

  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: name => { stores.set(name, new Map()); },
    transaction: () => ({ objectStore }),
    close: () => {},
  };

  globalThis.indexedDB = {
    open: () => {
      const request = { result: db };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return () => { globalThis.indexedDB = previous; };
}

module.exports = { installFakeIndexedDB };
