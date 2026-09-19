/**
 * 実体ツリーの SHA-256。導入直後に計算して収集一覧へ入れ、削除前に再計算して照合する。
 * ファイルは読まない — パスと内容を受け取るだけにして、走査は ide / browser が担う。
 */
export type TreeFile = { readonly path: string; readonly bytes: Uint8Array };

const encoder = new TextEncoder();

/**
 * パスを並べ替えてから、`path\n` と長さと内容を順に流す。
 * 走査順の違いで値が変わらないようにする。`crypto.subtle` は Node と ブラウザの両方にある。
 */
export async function treeHash(files: readonly TreeFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts = sorted.flatMap(file =>
    [encoder.encode(`${file.path}\n${file.bytes.length}\n`), file.bytes]);
  // Node と DOM で Blob の引数型が違い、どちらも SharedArrayBuffer 由来を受けない。
  // 実際に渡すのは通常の Uint8Array なので、型だけ外して両方の lib で通す。
  const digest = await crypto.subtle.digest("SHA-256",
    await new Blob(parts as unknown as never[]).arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
