import { ArchiveError, firstUnwritable, readTarGz } from "../core/archive.js";
import { Collected, isRemovable } from "../core/collection.js";
import { locateSkill, ToolLead } from "../core/detect.js";
import { GitHubSource, narrowToSkill } from "../core/github.js";
import { treeHash, TreeFile } from "../core/hash.js";
import { ledger, ledgerPath } from "../core/ledger.js";
import { BROWSER_ROLLBACK_LIMIT, CATALOG_EXTRACT_LIMIT, ENTRY_LIMIT, SINGLE_FILE_LIMIT, SIZE_LIMIT } from "../core/limits.js";
import { Placement, rootOf } from "../core/placement.js";
import { fetchFiles, listFiles, SkillEntry, TreeFetchError } from "../core/tree.js";
import { exists, readTree, removeEntry, removeLedgerFile, reserve, writeTree } from "./fs.js";
import { collect, forget } from "./store.js";
import { fetchJson } from "./fetch.js";

/**
 * codeload は tar.gz を返す。gzip は DecompressionStream で解ける。
 * SHA が取れていればそれを指す — 取得と記録がずれないようにする。
 * 取れなければ `HEAD` を使い、既定ブランチ名を推測しない（`master` のリポジトリがある）。
 */
export const archiveUrl = (source: GitHubSource, sha?: string): string =>
  `https://codeload.github.com/${source.repo}/tar.gz/`
  + (sha ?? (source.branch === undefined ? "HEAD" : `refs/heads/${encodeURIComponent(source.branch)}`));

/**
 * 導入時点の commit SHA。台帳に載せておかないと、IDE 拡張が取り込んだ直後に
 * 全件が「更新あり」に見える（`inventory.ts` の `hasUpdate`）。
 * 本文は要らないので bare SHA だけを受ける。
 */
export async function commitSha(source: GitHubSource): Promise<string | undefined> {
  const ref = source.branch ?? "HEAD";
  const response = await fetch(
    `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(ref)}`,
    { cache: "no-store", headers: { Accept: "application/vnd.github.sha" } },
  ).catch(() => null);
  if (response === null || !response.ok) return undefined;   // 上限に当たっても導入は止めない
  const sha = (await response.text()).trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

export class InstallError extends Error {
  constructor(
    readonly kind: "tooLarge" | "fetchFailed" | "notFound" | "blocked" | "unusableName",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 取得して、目的のものだけを取り出す。
 *
 * subdir が分かっているときは、その配下だけを残して他をその場で捨てる。
 * カタログ URL は subdir を持たないので一度まとめて持ち、`locateSkill` で
 * ディレクトリ名か SKILL.md の frontmatter `name` を突き合わせて探す。
 */
export async function download(
  lead: ToolLead,
): Promise<{ files: TreeFile[]; sha?: string; source: GitHubSource }> {
  // カタログは subdir を約束しない。規約どおりの置き場を先に 1 回だけ確かめる。
  // 当たれば、要らないものをその場で捨てながら読める。
  const source = await narrowToSkill(lead.source, lead.kind === "skill" ? lead.name : undefined);
  // SHA はどちらの経路も同じものを使う。落ちてから調べ直すと API を 1 回余計に使う
  // （未認証は 60 req/時）。読めなければ両経路とも従来どおり HEAD を使う。
  const sha = await commitSha(source);
  try {
    return await fromArchive(lead, source, sha);
  } catch (error) {
    // アーカイブが取得上限を超えるリポジトリでも、置き場が分かっていればファイル単位で
    // 取れる（実測: 圧縮 116 MB のリポジトリから 104 KB だけを取る）。**落ちたときだけ**
    // ここへ来るので、アーカイブで取れているものの経路は変えない。
    if (!(error instanceof InstallError) || error.kind !== "tooLarge") throw error;
    if (lead.kind !== "skill" || source.subdir === undefined) throw error;
    return fromFiles(lead, source, source.subdir, sha);
  }
}

/** 置き場が分かっているものを、アーカイブに触れずに取り出す。 */
async function fromFiles(
  lead: ToolLead, source: GitHubSource, base: string, sha: string | undefined,
): Promise<{ files: TreeFile[]; sha?: string; source: GitHubSource }> {
  try {
    // tree / raw は同じ commit を読む。別々の ref で読むと、途中の push で
    // 一覧と実体と台帳が食い違う。
    const pinned = sha === undefined ? source : { ...source, branch: sha };
    const listed = await listFiles(pinned, base, fetchJson);
    if (listed === null) {
      throw new InstallError("notFound", `${lead.name} was not found in ${source.repo}`);
    }
    return { files: await fetchFiles(pinned, base, listed, getBytes), sha, source };
  } catch (error) {
    throw asInstallError(error);
  }
}

async function fromArchive(
  lead: ToolLead, source: GitHubSource, sha: string | undefined,
): Promise<{ files: TreeFile[]; sha?: string; source: GitHubSource }> {
  const response = await fetch(archiveUrl(source, sha), { cache: "no-store" }).catch(() => null);
  if (response === null) {
    throw new InstallError("fetchFailed", "the archive could not be fetched");
  }
  if (response.status === 404) {
    throw new InstallError("notFound", `${source.repo} was not found on GitHub`);
  }
  if (!response.ok || response.body === null) {
    throw new InstallError("fetchFailed", `the archive could not be fetched (${response.status})`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > SIZE_LIMIT) {
    await response.body.cancel();
    throw new InstallError("tooLarge", "the archive is too large");
  }

  const want = source.subdir === undefined ? null : source.subdir.split("/");
  const limits = want === null
    ? { entries: ENTRY_LIMIT, single: SINGLE_FILE_LIMIT, total: CATALOG_EXTRACT_LIMIT }
    : undefined;

  const kept: TreeFile[] = [];
  const links: string[] = [];
  try {
    for await (const entry of readTarGz(response.body, limits)) {
      if (entry.kind === "directory") continue;
      const inside = entry.path.slice(1);                 // `<repo>-<ref>/` を剥がす
      if (want !== null && !want.every((part, index) => inside[index] === part)) continue;
      // リンクは書けないので中身を持たない。入れたいものの中にあれば後で止める。
      if (entry.kind === "link") { links.push(inside.join("/")); continue; }
      kept.push({ path: inside.join("/"), bytes: entry.bytes });
    }
  } catch (error) {
    throw error instanceof ArchiveError
      ? new InstallError("tooLarge", error.message) : error;
  }

  const base = want ?? locateSkill(kept, lead.name);
  if (base === null) {
    throw new InstallError("notFound", `${lead.name} was not found in ${source.repo}`);
  }

  // 入れるものの中にリンクがあれば止める。外にあるだけなら関係ない。
  const prefix = `${base.join("/")}/`;
  const inside = links.filter(path => base.length === 0 || path.startsWith(prefix));
  if (inside.length > 0) {
    throw new InstallError("fetchFailed", `${inside[0]} is a link and cannot be installed`);
  }

  let files = kept
    .filter(file => base.every((part, index) => file.path.split("/")[index] === part))
    .map(file => ({ path: file.path.split("/").slice(base.length).join("/"), bytes: file.bytes }))
    .filter(file => file.path !== "");
  // Subagent は .md 1 つ。取得元の subdir はその親ディレクトリなので名前で絞る。
  if (lead.kind === "subagent") files = files.filter(file => file.path === `${lead.name}.md`);
  if (files.length === 0) {
    throw new InstallError("notFound", `${lead.name} was not found in ${source.repo}`);
  }
  return { files, sha, source };
}

/**
 * カタログ候補を表示してよいか。取得物は保持も書き込みもしない。
 *
 * `null` は「判定できなかった」。取得そのものに失敗しただけなら、そのリポジトリに
 * 入っていないと分かったわけではない。false と混ぜると、通信が一瞬こけただけの候補を
 * 覚え込んで出さなくなる。
 */
export async function isExtractable(lead: ToolLead): Promise<boolean | null> {
  try {
    await download(lead);
    return true;
  } catch (error) {
    return error instanceof InstallError && error.kind !== "fetchFailed" ? false : null;
  }
}

/** 実体の取り方。既定はアーカイブ 1 本。 */
export type Fetched = { files: TreeFile[]; sha?: string; source: GitHubSource };

export type InstallRequest = {
  readonly lead: ToolLead;
  readonly agent: string;
  readonly placement: Placement;
  readonly root: FileSystemDirectoryHandle;
  /** 同名があったときに上書きしてよいか。呼び出し側が利用者に確認してから渡す。 */
  readonly overwrite: boolean;
  /**
   * 取得のしかたを差し替える。アーカイブが上限を超えるリポジトリでは、呼び出し側が
   * `filesFor` を渡してファイル単位で取る。書き込み・台帳・収集一覧は同じ経路を通す。
   */
  readonly fetchFiles?: () => Promise<Fetched>;
};

/** 実体 1 ファイル。`raw` は CDN なので、API の 60 req/時 を件数ぶん食わない。 */
const getBytes = async (url: string, limit: number): Promise<Uint8Array | null | "tooLarge"> => {
  const response = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (response === null || !response.ok || response.body === null) return null;
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body.cancel();
    return "tooLarge";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        return "tooLarge";
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};

const asInstallError = (error: unknown): unknown =>
  error instanceof TreeFetchError
    ? new InstallError(error.kind === "tooLarge" ? "tooLarge" : "fetchFailed", error.message)
    : error;

/**
 * 一覧の 1 件を、アーカイブに触れずに取り出す。
 * 大きいリポジトリはアーカイブが取得上限を超えるので、こちらでしか入れられない。
 */
export const filesFor = (
  source: GitHubSource, subdir: string, entry: SkillEntry,
) => async (): Promise<Fetched> => {
  const base = `${subdir}/${entry.name}`;
  try {
    // 一覧を出してから導入されるまでに branch が進んでも、1 件の内容は混ぜない。
    const sha = await commitSha(source);
    const pinned = sha === undefined ? source : { ...source, branch: sha };
    const files = await fetchFiles(pinned, base, entry.files, getBytes);
    return { files, sha, source: { ...source, subdir: base } };
  } catch (error) {
    throw asInstallError(error);
  }
};

export const willOverwrite = (request: Omit<InstallRequest, "overwrite">): Promise<boolean> =>
  exists(request.root, request.placement.entry);

/** 取得・展開・書き込み・台帳・収集一覧までを 1 回で行う。 */
export async function install(request: InstallRequest): Promise<Collected> {
  const { lead, placement, root } = request;
  const taken = await exists(root, placement.entry);
  if (!request.overwrite && taken) {
    throw new InstallError("blocked", placement.entry);
  }

  // 既にあるものは触らずに、まず取得できることを確かめる。取得に失敗したときに
  // 元のものが消えていると、利用者は何も残らないまま元の版も失う。
  if (!taken) {
    // IDE 拡張が張った symlink は一覧にも出ず、作ろうとして初めて失敗する。
    // 取得の前に分かれば、無駄に落とさずに済む。
    try {
      await reserve(root, placement.entry, placement.isDirectory);
    } catch {
      throw new InstallError("blocked", placement.entry);
    }
  }

  let files: TreeFile[];
  let sha: string | undefined;
  // 絞り込みが当たれば subdir が付く。台帳と収集一覧へはそちらを残す
  // （IDE 拡張の更新検知も、次からは要る分だけを見る）。
  let source: GitHubSource;
  try {
    ({ files, sha, source } = await (request.fetchFiles ?? (() => download(lead)))());
  } catch (error) {
    // 確保しただけの空の置き場は片付ける。元からあったものには触っていない。
    if (!taken) {
      await removeEntry(root, placement.entry, placement.isDirectory).catch(() => undefined);
    }
    throw error;
  }

  // 書けない名前が 1 つでもあれば、何も消さずにここで止める。消してから気づくと、
  // 旧版も新版も無い状態が残る。macOS で作れても Windows で作れない名前がある。
  const bad = firstUnwritable([placement.entry, ...files.map(file => file.path)]);
  if (bad !== null) {
    if (!taken) {
      await removeEntry(root, placement.entry, placement.isDirectory).catch(() => undefined);
    }
    throw new InstallError("unusableName", bad);
  }

  const base = placement.isDirectory ? [placement.entry] : [];
  const laid = placement.isDirectory
    ? files
    : [{ path: placement.entry, bytes: files[0].bytes }];
  // 上書きは「重ねる」ではなく「置き換える」。重ねると旧版にしか無いファイルが残り、
  // 新旧の混ざったものができる。File System Access API には rename がないため、旧版を
  // 退避してから置換し、失敗時は戻す。
  // ponytail: 退避はメモリ上。ブラウザ API に原子的な rename が入れば一時ファイルへ替える。
  let previous: TreeFile[] | null = null;
  if (taken) {
    try {
      previous = await readTree(root, placement.entry, placement.isDirectory, {
        entries: ENTRY_LIMIT,
        single: SINGLE_FILE_LIMIT,
        total: BROWSER_ROLLBACK_LIMIT,
      });
    } catch (error) {
      throw new InstallError("tooLarge",
        `the existing item is too large to safely back up in memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (taken && previous === null) throw new InstallError("blocked", placement.entry);
  let removed = false;
  try {
    if (taken) {
      await removeEntry(root, placement.entry, placement.isDirectory);
      removed = true;
      await reserve(root, placement.entry, placement.isDirectory);
    }
    await writeTree(root, base, laid);
  } catch (error) {
    if (taken && removed && previous !== null) {
      await removeEntry(root, placement.entry, placement.isDirectory).catch(() => undefined);
      await reserve(root, placement.entry, placement.isDirectory)
        .then(() => writeTree(root, base, previous))
        .catch(rollback => console.error("Agent Tool: restore", rollback));
    } else if (!taken) {
      await removeEntry(root, placement.entry, placement.isDirectory).catch(() => undefined);
    }
    throw error;
  }

  // 台帳は IDE 拡張へ取得元を渡すためだけのもの。削除の可否には使わない。
  // 書けなくても導入は済んでいる。収集一覧に載せないと利用者が消せなくなるので止めない。
  await writeTree(root, [], [{
    path: ledgerPath(lead.name),
    bytes: new TextEncoder().encode(
      JSON.stringify(ledger(lead.name, lead.kind, source, sha), null, 2) + "\n"),
  }]).catch(error => { console.error("Agent Tool: ledger", error); });

  const written = await readTree(root, placement.entry, placement.isDirectory);
  const item: Collected = {
    name: lead.name, kind: lead.kind, agent: request.agent, root: rootOf(placement),
    repo: source.repo,
    ...(source.branch === undefined ? {} : { branch: source.branch }),
    ...(source.subdir === undefined ? {} : { subdir: source.subdir }),
    ...(sha === undefined ? {} : { sha }),
    treeHash: await treeHash(written ?? []),
    installedAt: Date.now(),
  };
  await collect(item);
  return item;
}

/**
 * 削除。導入時の実体ツリー hash と一致するときだけ消す。
 * 手で直されたもの、IDE 拡張が更新したものは消さない。
 */
export async function remove(
  item: Collected, root: FileSystemDirectoryHandle, isDirectory: boolean,
): Promise<"removed" | "changed" | "missing"> {
  const entry = isDirectory ? item.name : `${item.name}.md`;
  const current = await readTree(root, entry, isDirectory);
  if (current === null) {
    await forget(item);
    return "missing";
  }
  if (!isRemovable(item, await treeHash(current))) return "changed";

  await removeEntry(root, entry, isDirectory);
  // 未取り込みの台帳が残っていると、IDE 拡張が消えた実体を登録してしまう。
  await removeLedgerFile(root, item.name)
    .catch(() => { /* 取り込み済みか、そもそも無い */ });
  await forget(item);
  return "removed";
}
