// テスト用の最小 tar.gz ライター。展開側の検査を実物のアーカイブで通すために使う。
// 実装側は読むだけなので、チェックサムなど読み側が見ないフィールドは埋めない。
const { gzipSync } = require("node:zlib");
const BLOCK = 512;

function header(name, size, flag, extra = {}) {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write(flag, 156);
  if (extra.link) block.write(extra.link, 157);
  block.write("ustar\0", 257);
  block.write("00", 263);
  if (extra.prefix) block.write(extra.prefix, 345);
  // チェックサムは読み側で見ていないので空白のままでよい
  block.write("        ", 148);
  return block;
}

const pad = body => {
  const rest = body.length % BLOCK;
  return rest === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK - rest, 0)]);
};

/** entries: [name, content|null, flag?, extra?] */
function tarGz(entries) {
  const blocks = [];
  for (const [name, content, flag = content === null ? "5" : "0", extra] of entries) {
    const body = content === null ? Buffer.alloc(0) : Buffer.from(content, "utf8");
    blocks.push(header(name, body.length, flag, extra), pad(body));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));                 // 終端
  return gzipSync(Buffer.concat(blocks));
}

const streamOf = buffer => new ReadableStream({
  start(controller) {
    // 途中で切れたチャンクをまたげることも見る
    for (let at = 0; at < buffer.length; at += 100) {
      controller.enqueue(new Uint8Array(buffer.subarray(at, at + 100)));
    }
    controller.close();
  },
});

module.exports = { header, streamOf, tarGz };
