import {
  createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { open as openZip, Entry, ZipFile } from "yauzl";
import { KindId } from "../core/agent";
import { AgentToolError } from "../core/errors";
import { safeSegments } from "../core/archive";
import { ENTRY_LIMIT, EXTRACTED_SIZE_LIMIT, PAGE_LIMIT, SINGLE_FILE_LIMIT, SIZE_LIMIT } from "../core/limits";
import * as frontmatter from "./frontmatter";
import { archiveUrl, GitHubSource } from "../core/github";
import { isInside, isValidName } from "./writeGuard";

/**
 * 取得した中身の解釈結果。自動では入れない —
 * README からのコマンド抽出は必ず外すので、確認画面を挟む。
 */
export type Candidate = {
  readonly kind: KindId;
  readonly name: string;
  readonly description?: string;
  /** 一時ディレクトリ内の実体。`discard()` か install で片付く。 */
  readonly localPath: string;
  /** Plugin CLI に渡す `plugin@marketplace`。展開ディレクトリ名は使わない。 */
  readonly installSelector?: string;
};

export type Staging = {
  readonly root: string;
  readonly source: GitHubSource;
  readonly candidates: Candidate[];
  readonly resolvedSha?: string;
};

const fail = (message: string): never => {
  throw new AgentToolError("FETCH_FAILED", message);
};

/** 一時領域だけを使う。成功・失敗・キャンセルの全経路で消す。 */
export const discard = (staging: { root: string }): void =>
  rmSync(staging.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

/**
 * カタログページを 1 枚読む。呼び出し側は本文を JSON-LD の抽出にだけ使い、
 * 読み終えたら捨てる（ファイルにも registry にも残さない）。
 */
export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) fail(`the page could not be read: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > PAGE_LIMIT) {
    await response.body?.cancel();
    fail("the page is too large to read (limit 2 MB)");
  }
  if (!response.body) fail("the page could not be read: empty response");
  const body = response.body!;

  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > PAGE_LIMIT) {
      await body.cancel();
      fail("the page is too large to read (limit 2 MB)");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** zip を落として展開し、中身から種別を判定する。`git clone` は使わない。 */
export async function stage(source: GitHubSource, options: {
  defaultBranch?: string;
  resolvedSha?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Staging> {
  const root = mkdtempSync(join(tmpdir(), "agent-tool-fetch-"));
  try {
    const archive = join(root, "archive.zip");
    await download(archiveUrl(source, options.defaultBranch ?? "main", options.resolvedSha),
      archive, source.repo, options.fetchImpl ?? fetch);

    const unpacked = join(root, "unpacked");
    const links = await extract(archive, unpacked);
    rmSync(archive, { force: true });          // zip 本体はもう要らない

    // zipball は `<repo>-<branch>/` を 1 段かぶせる。それを剥がす。
    const top = singleTopLevel(unpacked);
    const base = source.subdir === undefined ? top : join(top, source.subdir);
    if (!isPath(base)) fail(`${source.subdir ?? "/"} was not found in the archive`);

    // ディレクトリ名由来の候補も含めて、最後にもう一度名前を検査する。
    // ここを通った名前だけが `installer` でパスに使われる。
    const candidates = identify(base)
      .filter(candidate => isValidName(candidate.name))
      // symlink は展開していない。含む候補を入れると、欠けたまま導入が成功したように
      // 見える。ブラウザ拡張の `install.ts` と同じく、取り出す範囲内なら通さない。
      .filter(candidate => !links.some(link => isInside(link, candidate.localPath)));
    if (candidates.length === 0) {
      const blocked = links.find(link => isInside(link, base));
      fail(blocked === undefined
        ? "Neither SKILL.md nor plugin.json was found; the format is not supported"
        : `${relative(unpacked, blocked)} is a link and cannot be installed`);
    }
    return { root, source, candidates, resolvedSha: options.resolvedSha };
  } catch (error) {
    discard({ root });
    throw error;
  }
}

/**
 * codeload は GET に `Content-Length` を返す。判明した時点で上限を超えていれば
 * 本文を読まずに切る。返らない場合の保険として、書き込み量でも中断する。
 */
async function download(url: string, destination: string, repo: string,
                        fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) fail(`download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > SIZE_LIMIT) {
    await response.body?.cancel();
    fail(`the archive for ${repo} is too large (${Math.round(declared / 1024 / 1024)} MB, limit 50 MB)`);
  }
  if (!response.body) fail("download failed: empty response");

  let written = 0;
  const guard = async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      written += chunk.byteLength;
      if (written > SIZE_LIMIT) {
        fail(`the archive for ${repo} is too large (over 50 MB)`);
      }
      yield chunk;
    }
  };
  await pipeline(response.body as unknown as AsyncIterable<Uint8Array>, guard,
    createWriteStream(destination));
}

/**
 * zip を展開する。**各エントリを書く前に検査する。**
 * ディレクトリ横断（Zip Slip）、symlink、対応しない種別、サイズ上限を
 * ここで落とすので、展開後の木をもう一度歩き直さない。
 */
export function extract(archive: string, destination: string): Promise<string[]> {
  mkdirSync(destination, { recursive: true });
  return new Promise((done, reject) => {
    openZip(archive, { lazyEntries: true, autoClose: true }, (error, zip: ZipFile) => {
      if (error) return reject(new AgentToolError("FETCH_FAILED", `extraction failed: ${error.message}`));
      let entries = 0;
      let total = 0;
      /** 書かずに飛ばした symlink の展開先。取り出す候補の中にあれば `stage` が落とす。 */
      const links: string[] = [];
      const abort = (message: string): void => {
        zip.close();
        reject(new AgentToolError("FETCH_FAILED", `extraction failed: ${message}`));
      };
      zip.on("error", (streamError: Error) => abort(streamError.message));
      zip.on("end", () => done(links));
      zip.on("entry", (entry: Entry) => {
        entries += 1;
        if (entries > ENTRY_LIMIT) return abort("too many files in the archive");

        const target = safeJoin(destination, entry.fileName);
        if (target === null) return abort("the archive escapes the extraction directory");

        // 上位 16 bit が Unix のモード。symlink と特殊ファイルは取り出さない。
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        // symlink は書かずに飛ばす。リポジトリ直下の `CLAUDE.md` が symlink というだけで
        // 取得ごと諦めさせない。取り出したいものの中にあるかは `stage` が見る。
        if (mode === 0o120000) { links.push(target); return zip.readEntry(); }
        if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) {
          return abort("the archive contains an unsupported file type");
        }
        if (entry.fileName.endsWith("/")) {
          mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        if (entry.uncompressedSize > SINGLE_FILE_LIMIT) return abort("an extracted file is too large");
        total += entry.uncompressedSize;
        if (total > EXTRACTED_SIZE_LIMIT) return abort("the extracted archive is too large");

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return abort(streamError?.message ?? "entry could not be read");
          mkdirSync(dirname(target), { recursive: true });
          pipeline(stream, createWriteStream(target))
            .then(() => zip.readEntry())
            .catch((writeError: Error) => abort(writeError.message));
        });
      });
      zip.readEntry();
    });
  });
}

/** アーカイブ内のパスを展開先へ落とす。外へ出るものは null。検証は core と共有する。 */
export function safeJoin(root: string, entryName: string): string | null {
  const parts = safeSegments(entryName);
  if (parts === null) return null;
  const target = resolve(root, ...parts);
  return target === resolve(root) || target.startsWith(resolve(root) + sep) ? target : null;
}

const isPath = (path: string): boolean => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** zipball は `<repo>-<branch>/` を 1 段かぶせる。 */
export function singleTopLevel(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(name => !name.startsWith("."));
  } catch {
    return dir;
  }
  return entries.length === 1 ? join(dir, entries[0]) : dir;
}

/**
 * Subagent の `.md` か。
 *
 * `tools:` は見ない — **省略できる**（省略は「全ツールを継承」の意味で、実在する
 * Subagent の多くが持たない）。持っていることを条件にすると、ブラウザ拡張は
 * パスで拾えるものが IDE 拡張では 1 つも入らない、という食い違いになる。
 *
 * 代わりに `name` と `description` を条件にする。これは Subagent が必ず持つもので、
 * README や設計文書のような**ただの `.md` は frontmatter を持たない**ので混ざらない。
 */
export const isSubagentMatter = (matter: frontmatter.Frontmatter): boolean =>
  matter.tools !== undefined
  || (matter.name !== undefined && matter.description !== undefined);

/**
 * 取得した中身を見て決める。README のテキストからは推測しない。
 * symlink を含む候補は `stage` が落とすので、ここでは種別だけを見る。
 */
export function identify(base: string): Candidate[] {
  const found: Candidate[] = [];

  // marketplace を兼ねたリポジトリは plugin.json と skills/ の両方を持つ。
  // どちらかで打ち切ると片方が選べなくなるので、併記して確認画面で選ばせる。
  if (isPath(join(base, ".claude-plugin", "plugin.json"))) {
    found.push({
      kind: "plugin", name: basename(base), localPath: base,
      installSelector: pluginSelector(base),
    });
  }

  if (isPath(join(base, "SKILL.md"))) {
    const result = frontmatter.read(join(base, "SKILL.md"));
    if (result.status !== "parsed") {
      return [...found, { kind: "skill", name: basename(base), localPath: base }];
    }
    // frontmatter の `name` は取得先が書いた文字列で、こちらの管理下にない。
    // パス要素として使えない名前はディレクトリ名に落とす。
    const declared = result.matter.name !== undefined && isValidName(result.matter.name)
      ? result.matter.name : undefined;
    return [...found, {
      kind: "skill", name: declared ?? basename(base), localPath: base,
      description: result.matter.description,
    }];
  }

  // frontmatter を持つ `.md` は Subagent。
  const markdown = (() => {
    try {
      return readdirSync(base).filter(name => name.endsWith(".md") && !name.startsWith(".")).sort();
    } catch {
      return [];
    }
  })();
  const subagents = markdown.flatMap((file): Candidate[] => {
    const result = frontmatter.read(join(base, file));
    if (result.status !== "parsed" || !isSubagentMatter(result.matter)) return [];
    return [{
      kind: "subagent", name: file.slice(0, -3), localPath: join(base, file),
      description: result.matter.description,
    }];
  });
  if (subagents.length > 0) return [...found, ...subagents];

  return [...found, ...skillsUnder(base, 3)];
}

function pluginSelector(base: string): string | undefined {
  try {
    const object = JSON.parse(
      readFileSync(join(base, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { name?: unknown; plugins?: unknown };
    const marketplace = typeof object.name === "string" ? object.name : "";
    const first = Array.isArray(object.plugins) ? object.plugins[0] : undefined;
    const name = first !== null && typeof first === "object" && typeof (first as { name?: unknown }).name === "string"
      ? (first as { name: string }).name : "";
    return name !== "" && marketplace !== "" ? `${name}@${marketplace}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * リポジトリ直下を指された場合、スキルは何段か下に並んでいることがある。
 * `skills/<name>` だけでなく `skills/<category>/<name>` もあるので数段たどる。
 * Subagent の判定は指されたディレクトリ直下だけで行う — 下層の `.md` まで
 * frontmatter を読むと、ただの文書が候補に混ざる。
 */
export function skillsUnder(base: string, depth: number): Candidate[] {
  if (depth <= 0) return [];
  let children: string[];
  try {
    children = readdirSync(base).filter(name => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
  return children.flatMap(child => {
    const path = join(base, child);
    if (!isDirectory(path)) return [];
    return isPath(join(path, "SKILL.md")) ? identify(path) : skillsUnder(path, depth - 1);
  });
}
