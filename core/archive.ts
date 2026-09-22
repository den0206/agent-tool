import { ENTRY_LIMIT, EXTRACTED_SIZE_LIMIT, SINGLE_FILE_LIMIT } from "./limits.js";

/**
 * アーカイブの読み取りと検証。Web 標準だけで書き、IDE 拡張とブラウザ拡張で共有する。
 * 取得元は codeload の tar.gz 1 本にして、展開経路も検証もここに 1 つだけ置く。
 */

/**
 * アーカイブ内のパスを展開先の相対セグメントに落とす。外へ出るもの、
 * OS によって意味が変わるものは `null`。展開先の連結は呼び出し側が行う。
 */
export function safeSegments(entryName: string): string[] | null {
  if (entryName.includes("\0")) return null;
  const parts = entryName.split("/").filter(part => part !== "" && part !== ".");
  if (parts.some(part => part === ".." || part.includes("\\") || part.includes(":"))) return null;
  return parts.length === 0 ? null : parts;
}

/** Windows の予約デバイス名。拡張子が付いていても予約のまま（`aux.md` も作れない）。 */
const RESERVED_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 3 OS のどこかで**ファイル名として作れない**名前か。`safeSegments` とは目的が違う。
 * あちらは展開先から脱出させないための検査で、こちらは書けるかどうかである。
 * macOS では作れて Windows では作れない名前があるので、判定は OS に依存させない。
 *
 * 検知だけ通って導入で落ちるのを防ぐため、**消したり書いたりする前に**通す。
 * 途中で落ちると、旧実体を消した後で新しいものも書けていない状態が残る。
 */
export const unportableName = (name: string): boolean =>
  name === ""
  || new TextEncoder().encode(name).length > 255
  || /[<>:"|?*]/.test(name)
  || /[\u0000-\u001f]/.test(name)
  || /[. ]$/.test(name)
  || RESERVED_DEVICES.test(name);

/** 展開先に書けない名前を持つ最初のパス。全部書ける場合は `null`。 */
export const firstUnwritable = (paths: readonly string[]): string | null =>
  paths.find(path => path.split("/").some(unportableName)) ?? null;

export type TarEntry = {
  readonly path: string[];
  readonly kind: "file" | "directory" | "link";
  readonly bytes: Uint8Array;
};

const BLOCK = 512;
const decoder = new TextDecoder();

const text = (block: Uint8Array, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
};

const octal = (block: Uint8Array, offset: number, length: number): number => {
  const value = parseInt(text(block, offset, length).trim(), 8);
  return Number.isFinite(value) ? value : 0;
};

const isZeroBlock = (block: Uint8Array): boolean => block.every(byte => byte === 0);

class Reader {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  private available = 0;
  private done = false;
  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  async take(length: number): Promise<Uint8Array | null> {
    while (this.available < length && !this.done) {
      const chunk = await this.source.read();
      if (chunk.done) { this.done = true; break; }
      if (chunk.value.length === 0) continue;
      this.chunks.push(chunk.value);
      this.available += chunk.value.length;
    }
    if (this.available < length) return null;

    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.head];
      const count = Math.min(length - written, chunk.length - this.offset);
      result.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset === chunk.length) { this.head += 1; this.offset = 0; }
    }
    this.available -= length;
    if (this.head > 0) { this.chunks.splice(0, this.head); this.head = 0; }
    return result;
  }
}

export class ArchiveError extends Error {}

const fail: (message: string) => never = message => { throw new ArchiveError(message); };

export async function* readTarGz(
  stream: ReadableStream<Uint8Array>,
  limits = { entries: ENTRY_LIMIT, single: SINGLE_FILE_LIMIT, total: EXTRACTED_SIZE_LIMIT },
): AsyncGenerator<TarEntry> {
  const gunzipped = stream.pipeThrough(
    new DecompressionStream("gzip") as never) as ReadableStream<Uint8Array>;
  const reader = new Reader(gunzipped.getReader());
  let entries = 0;
  let total = 0;
  let override: string | null = null;

  const account = (size: number): void => {
    entries += 1;
    if (entries > limits.entries) fail("too many files in the archive");
    if (size > limits.single) fail("an extracted file is too large");
    total += size;
    if (total > limits.total) fail("the extracted archive is too large");
  };

  while (true) {
    const header = await reader.take(BLOCK);
    if (header === null) return;
    if (isZeroBlock(header)) return;

    const flag = String.fromCharCode(header[156]);
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // PAX / GNU の補助エントリも外部入力であり、通常ファイルと同じ資源上限に数える。
    // ここを数えないと、巨大な long-name / pax 本文だけでメモリ上限を迂回できる。
    if (flag === "L" || flag === "x" || flag === "X") {
      account(size);
      const body = await reader.take(padded);
      if (body === null) fail("the archive ended in the middle of an entry");
      const raw = decoder.decode(body.subarray(0, size));
      override = flag === "L" ? raw.replace(/\0+$/, "")
        : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(raw)?.[1] ?? null);
      continue;
    }
    if (flag === "g") {
      account(size);
      const body = await reader.take(padded);
      if (body === null) fail("the archive ended in the middle of an entry");
      continue;
    }

    const prefix = text(header, 345, 155);
    const name = override ?? (prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
    override = null;

    const isLink = flag === "1" || flag === "2";
    if (!isLink && flag !== "0" && flag !== "\0" && flag !== "5") {
      fail("the archive contains an unsupported file type");
    }

    const path = safeSegments(name);
    if (path === null) fail("the archive escapes the extraction directory");

    // directory / link は本文サイズが通常 0 だが、異常な入力でも上限を共通適用する。
    account(size);

    if (isLink) {
      const body = await reader.take(padded);
      if (body === null) fail("the archive ended in the middle of an entry");
      yield { path, kind: "link", bytes: new Uint8Array(0) };
      continue;
    }
    if (flag === "5") {
      if (padded > 0) {
        const body = await reader.take(padded);
        if (body === null) fail("the archive ended in the middle of an entry");
      }
      yield { path, kind: "directory", bytes: new Uint8Array(0) };
      continue;
    }

    const body = await reader.take(padded);
    if (body === null) fail("the archive ended in the middle of an entry");
    yield { path, kind: "file", bytes: body.slice(0, size) };
  }
}
