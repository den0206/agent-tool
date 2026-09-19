import {
  Collected, add as addCollected, keyOf, MAX_BROWSER_COLLECTION_ENTRIES,
} from "../core/collection.js";

/**
 * 永続化するのはディレクトリハンドル、収集一覧、設定 2 つだけ（設計決定 D-11）。
 * 閲覧した URL・ログ・診断履歴は持たない。
 */
const DB = "agent-tool";
const HANDLES = "handles";
const COLLECTION = "collection";

const open = (): Promise<IDBDatabase> =>
  new Promise((done, fail) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(COLLECTION)) db.createObjectStore(COLLECTION);
    };
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(request.error);
  });

async function run<T>(store: string, mode: IDBTransactionMode,
                      body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((done, fail) => {
      const request = body(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
  } finally {
    db.close();
  }
}

/** 導入先ルート（ホーム相対）ごとに 1 つのハンドルを覚える。 */
export const saveHandle = (root: string, handle: FileSystemDirectoryHandle): Promise<IDBValidKey> =>
  run(HANDLES, "readwrite", store => store.put(handle, root));

export const loadHandle = (root: string): Promise<FileSystemDirectoryHandle | undefined> =>
  run(HANDLES, "readonly", store => store.get(root));

export const dropHandle = (root: string): Promise<undefined> =>
  run(HANDLES, "readwrite", store => store.delete(root));

export const loadCollection = async (): Promise<Collected[]> =>
  (await run<Collected[] | undefined>(COLLECTION, "readonly", store => store.get("list"))) ?? [];

const saveCollection = (list: readonly Collected[]): Promise<IDBValidKey> =>
  run(COLLECTION, "readwrite", store => store.put(list, "list"));

/** 1 件足して保存する。上限の判断は core の純粋関数に任せる。 */
export async function collect(item: Collected): Promise<Collected[]> {
  const next = addCollected(await loadCollection(), item, MAX_BROWSER_COLLECTION_ENTRIES);
  await saveCollection(next);
  return next;
}

/**
 * まとめて落とす。1 件ずつ呼ぶと、件数ぶん一覧全体の read-modify-write が走る。
 * 0 件なら何も書かない。
 */
export async function forgetAll(items: readonly Collected[]): Promise<Collected[]> {
  const list = await loadCollection();
  if (items.length === 0) return list;
  const gone = new Set(items.map(keyOf));
  const next = list.filter(entry => !gone.has(keyOf(entry)));
  await saveCollection(next);
  return next;
}

export const forget = (item: Collected): Promise<Collected[]> => forgetAll([item]);

/**
 * UI 設定は収集一覧と同じ store に置く。`chrome.storage` を使うのは、書き込み前に
 * `TRUSTED_CONTEXTS` を掛ける必要がある Jev の 2 項目だけ（`aiSettings.ts`）。
 */
export const autoOpenEnabled = async (): Promise<boolean> =>
  (await run<boolean | undefined>(COLLECTION, "readonly", store => store.get("autoOpen"))) ?? true;

export const setAutoOpenEnabled = (on: boolean): Promise<IDBValidKey> =>
  run(COLLECTION, "readwrite", store => store.put(on, "autoOpen"));

/** 配色。CSS の `color-scheme` にそのまま入る値を持つ。既定はシステム追従。 */
export type Theme = "light dark" | "light" | "dark";

export const theme = async (): Promise<Theme> =>
  (await run<Theme | undefined>(COLLECTION, "readonly", store => store.get("theme"))) ?? "light dark";

export const setTheme = (value: Theme): Promise<IDBValidKey> =>
  run(COLLECTION, "readwrite", store => store.put(value, "theme"));
