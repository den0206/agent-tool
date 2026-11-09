import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { ArchiveError, safeSegments, TarEntry } from "../core/archive";
import { ENTRY_LIMIT, EXTRACTED_SIZE_LIMIT, SINGLE_FILE_LIMIT, SIZE_LIMIT } from "../core/limits";

/**
 * 利用者が手元から渡した zip を読む。目次（central directory）が末尾にあるので、
 * tar.gz と違って先頭から流せない。目次を読んでから 1 エントリずつ展開する。
 * 50 MB 上限の範囲では要らない ZIP64・暗号化・stored / deflate 以外は拒む。
 * 名前・件数・サイズの検査は tar.gz と同じ `core/` の関数と上限を使う。
 */
const fail: (message: string) => never = message => { throw new ArchiveError(message); };

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export function* readZip(size: number,
                         read: (offset: number, length: number) => Buffer): Generator<TarEntry> {
  if (size > SIZE_LIMIT) fail("the zip file is too large (limit 50 MB)");
  const at = (offset: number, length: number): Buffer => {
    if (offset < 0 || offset + length > size) fail("the zip file is truncated");
    const bytes = read(offset, length);
    if (bytes.length !== length) fail("the zip file is truncated");
    return bytes;
  };

  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = at(size - tailLength, tailLength);
  const eocd = tail.lastIndexOf(EOCD);
  if (eocd < 0 || eocd + 22 > tail.length) fail("the file is not a zip archive");
  const count = tail.readUInt16LE(eocd + 10);
  const directory = at(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
  if (count === 0xffff) fail("ZIP64 archives are not supported");
  if (count > ENTRY_LIMIT) fail("too many files in the archive");

  let total = 0;
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
      fail("the zip directory is corrupt");
    }
    const flags = directory.readUInt16LE(cursor + 8);
    const method = directory.readUInt16LE(cursor + 10);
    const compressed = directory.readUInt32LE(cursor + 20);
    const declared = directory.readUInt32LE(cursor + 24);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const mode = directory.readUInt32LE(cursor + 38) >>> 16;
    const local = directory.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength
      + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
    if (next > directory.length) fail("the zip directory is corrupt");
    const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor = next;

    const path = safeSegments(name);
    if (path === null) fail("the archive escapes the extraction directory");
    // Finder の「圧縮」が付ける AppleDouble。中身ではないので展開しない。
    if (path[0] === "__MACOSX") continue;
    if ((flags & 1) !== 0) fail("encrypted zip files are not supported");
    if (declared > SINGLE_FILE_LIMIT) fail("an extracted file is too large");
    total += declared;
    if (total > EXTRACTED_SIZE_LIMIT) fail("the extracted archive is too large");

    if ((mode & S_IFMT) === S_IFLNK) {
      yield { path: path, kind: "link", bytes: new Uint8Array(0) };
      continue;
    }
    if (name.endsWith("/")) {
      yield { path: path, kind: "directory", bytes: new Uint8Array(0) };
      continue;
    }

    const header = at(local, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) fail("the zip file is corrupt");
    const raw = at(local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), compressed);
    let bytes: Buffer;
    if (method === 0) bytes = raw;
    else if (method === 8) {
      // 目次の申告より大きく膨らむもの（zip bomb）は展開の途中で止める。
      try {
        bytes = inflateRawSync(raw, { maxOutputLength: Math.max(declared, 1) });
      } catch {
        return fail("the zip file is corrupt");
      }
    } else return fail("the zip file uses an unsupported compression method");
    if (bytes.length !== declared) fail("the zip file is corrupt");
    yield { path: path, kind: "file", bytes };
  }
}

/** ファイルを開いたまま読む。全量をメモリに載せない。 */
export function* readZipFile(file: string): Generator<TarEntry> {
  const fd = openSync(file, "r");
  try {
    yield* readZip(fstatSync(fd).size, (offset, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, readSync(fd, buffer, 0, length, offset));
    });
  } finally {
    closeSync(fd);
  }
}
