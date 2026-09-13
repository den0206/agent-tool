/**
 * File System Access API のメモリ実装。ブラウザ拡張の書き込み経路
 * （`browser/fs.ts` と `browser/install.ts`）を `node:test` で回すために使う。
 *
 * 本物に寄せるのは、**呼び出し側の分岐に効くところだけ**にする:
 *   - 無いものを開くと `NotFoundError`、種別違いは `TypeMismatchError`
 *   - `create: true` でなければ作らない
 *   - `blocked` の名前は `create: true` でも `NotFoundError` にする
 *     （IDE 拡張が張った symlink は一覧にも出ないのに作れない、という実測の挙動）
 */

const fail = (name, message) => {
  const error = new Error(message);
  error.name = name;
  throw error;
};

const bytesOf = source => {
  if (source instanceof Uint8Array) return Uint8Array.from(source);
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return new TextEncoder().encode(String(source));
};

function fileHandle(node, name, budget) {
  return {
    kind: "file",
    name,
    getFile: async () => ({
      size: node.bytes.length,
      arrayBuffer: async () => node.bytes.buffer.slice(
        node.bytes.byteOffset, node.bytes.byteOffset + node.bytes.length),
    }),
    createWritable: async () => {
      // 書き込みの途中で落ちる状況を作る。巻き戻しの経路はここでしか通せない。
      // 落とすのは指定した 1 回だけにする — 巻き戻しの書き込みまで落とすと、
      // 戻せたかどうかが見えなくなる。
      if (budget !== undefined && ++budget.count === budget.failAt) {
        fail("QuotaExceededError", "disk full");
      }
      const chunks = [];
      return {
        write: async source => { chunks.push(bytesOf(source)); },
        close: async () => {
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const joined = new Uint8Array(total);
          let at = 0;
          for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
          node.bytes = joined;
        },
      };
    },
  };
}

/**
 * @param name  ハンドルの名前。`rootState` は設定ディレクトリ名と突き合わせる。
 * @param blocked 作成を拒む名前の集合（symlink 相当）。
 * @param budget  何回目の書き込みを落とすか。`{ failAt, count }`。
 */
function directoryHandle(node, name, blocked = new Set(), budget) {
  const handle = {
    kind: "directory",
    name,
    async *entries() {
      for (const [child, value] of [...node.children].sort(([a], [b]) => a < b ? -1 : 1)) {
        yield [child, value.children === undefined
          ? fileHandle(value, child) : directoryHandle(value, child, blocked, budget)];
      }
    },
    getDirectoryHandle: async (child, options = {}) => {
      const found = node.children.get(child);
      if (found === undefined) {
        if (options.create !== true) fail("NotFoundError", `${child} was not found`);
        if (blocked.has(child)) fail("NotFoundError", `${child} cannot be created`);
        const created = { children: new Map() };
        node.children.set(child, created);
        return directoryHandle(created, child, blocked, budget);
      }
      if (found.children === undefined) fail("TypeMismatchError", `${child} is a file`);
      return directoryHandle(found, child, blocked, budget);
    },
    getFileHandle: async (child, options = {}) => {
      const found = node.children.get(child);
      if (found === undefined) {
        if (options.create !== true) fail("NotFoundError", `${child} was not found`);
        if (blocked.has(child)) fail("NotFoundError", `${child} cannot be created`);
        const created = { bytes: new Uint8Array(0) };
        node.children.set(child, created);
        return fileHandle(created, child, budget);
      }
      if (found.children !== undefined) fail("TypeMismatchError", `${child} is a directory`);
      return fileHandle(found, child, budget);
    },
    removeEntry: async (child, options = {}) => {
      const found = node.children.get(child);
      if (found === undefined) fail("NotFoundError", `${child} was not found`);
      if (found.children !== undefined && found.children.size > 0 && options.recursive !== true) {
        fail("InvalidModificationError", `${child} is not empty`);
      }
      node.children.delete(child);
    },
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
  };
  return handle;
}

/** 空の置き場を 1 つ作る。`tree()` で中身を平たいオブジェクトとして取り出せる。 */
function fakeRoot(options = {}) {
  const node = { children: new Map() };
  const budget = options.failWrite === undefined
    ? undefined : { failAt: options.failWrite, count: 0 };
  const handle = directoryHandle(node, options.name ?? "skills", options.blocked, budget);
  const walk = (current, prefix, out) => {
    for (const [name, value] of current.children) {
      const path = `${prefix}${name}`;
      if (value.children === undefined) out[path] = new TextDecoder().decode(value.bytes);
      else if (value.children.size === 0) out[`${path}/`] = "";
      else walk(value, `${path}/`, out);
    }
    return out;
  };
  return {
    handle,
    /** 置いてあるファイルを `{ "pdf/SKILL.md": "本文" }` の形で返す。 */
    tree: () => walk(node, "", {}),
    /** 既存の中身を直接置く。取得前からあるものを作るのに使う。 */
    seed(path, body) {
      const parts = path.split("/");
      let current = node;
      for (const part of parts.slice(0, -1)) {
        if (!current.children.has(part)) current.children.set(part, { children: new Map() });
        current = current.children.get(part);
      }
      current.children.set(parts[parts.length - 1], { bytes: new TextEncoder().encode(body) });
      return this;
    },
  };
}

module.exports = { fakeRoot };
