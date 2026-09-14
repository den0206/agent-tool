import {
  cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { AgentId, AGENT_IDS, BUNDLED_SKILL_ROOTS, KindId, ruleRoots } from "../core/agent";
import { LEDGER_DIR } from "../core/ledger";
import { RULE_SOURCES, SKILL_SOURCES, SUBAGENT_SOURCES } from "./source";
import { agentStore, disabledAgentStore, Env, managedRoots } from "./env";
import { AgentToolError } from "../core/errors";
import { assertReadable, entry, Registry } from "./registry";

/**
 * 触ってよい対象の限定。「触ってはいけないパスの列挙」ではなく
 * 「触ってよい対象の限定」にしてあるので、新しいリソース種別を足しても安全側に倒れる。
 */

/**
 * ホワイトリストを通っても無条件で拒否する。ホワイトリストの実装ミス 1 つで
 * 到達しうる場所なので二重にする。`~/.codex/auth.json` は誤爆すると全ログインが飛ぶ。
 */
export const DENIED_NAMES: ReadonlySet<string> = new Set([
  "auth.json", "oauth_creds.json", "settings.json",
  "settings.local.json", ".claude.json", "config.toml", "mcp.json",
]);
export const DENIED_EXTENSIONS: ReadonlySet<string> = new Set(["sqlite", "sqlite-wal", "sqlite-shm"]);

/** Windows のパスは大文字小文字を区別しないので、比較の前に畳む。 */
const fold = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const key = (path: string): string => fold(resolve(path));

/** `..` で抜けられないよう、パス境界を見て判定する。 */
export const isInside = (path: string, root: string): boolean =>
  key(path).startsWith(key(root).endsWith(sep) ? key(root) : key(root) + sep);

const isSame = (a: string, b: string): boolean => key(a) === key(b);

/** 同じ場所を指すか。Windows の大文字小文字も畳んで比べる。 */
export const isSamePath = isSame;

export const isDenied = (path: string): boolean =>
  DENIED_NAMES.has(basename(path)) || DENIED_EXTENSIONS.has(extname(path).slice(1));

/** symlink と Windows の junction はどちらもここで真になる。hardlink は「リンク」ではない。 */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** リンク先を絶対パスで返す。相対リンクも解決する。 */
export function linkTarget(path: string): string | null {
  try {
    const destination = readlinkSync(path);
    return resolve(isAbsolute(destination) ? destination : join(dirname(path), destination));
  } catch {
    return null;
  }
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * 取得物が名乗った名前を、そのままパス要素に使ってよいか。純粋関数。
 *
 * 名前は取得先リポジトリの frontmatter 由来でこちらの管理下にない。
 * `../../../.claude` のような名前を join に渡すと管理ルートの外へ書けてしまう。
 * `assertMutable` は削除・移動しか守らないので、作成方向の穴をここで塞ぐ。
 *
 * 落とすのは危険なものだけで、文字種は絞らない — 実在するスキル名を弾く方が実害になる。
 */
export function isValidName(name: string): boolean {
  if (name === "" || Buffer.byteLength(name, "utf8") > 255) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;                    // 隠しファイルを作らせない
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes(":")) return false;                      // `apps/web:deploy` の区切り
  if (/\p{Cc}/u.test(name)) return false;                    // 改行や NUL
  return !isDenied(name);
}

/** 通らなければ throw する。作成の直前に必ず通す。 */
export function assertValidName(name: string): void {
  if (!isValidName(name)) {
    throw new AgentToolError("INVALID_NAME", `${name} cannot be used as a name`);
  }
}

/**
 * 削除・移動してよいか。許すのは 2 つだけ:
 *   1. 自分が張ったリンク（リンク先が実体置き場の配下）
 *   2. registry に載っている実体（実体置き場 or 退避ディレクトリの配下）
 * Windows の Subagent は hardlink なのでリンクとして見えず、実体との同一性で判定する。
 */
export function assertMutable(path: string, env: Env, registry: Registry): void {
  assertReadable(env);
  const target = resolve(path);

  assertNotBundled(target, env);
  if (isDenied(target)) {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is protected`);
  }

  if (isLink(target)) {
    const destination = linkTarget(target);
    if (!destination || !managedRoots(env).some(root => isInside(destination, root))) {
      throw new AgentToolError("SYMLINK_OUTSIDE_STORE", `${target} was not linked by Agent Tool`);
    }
    return;
  }

  // Subagent は `<name>.md` なので拡張子を落とす。Rule はここには到達しない —
  // 管理ストア（`managedRoots`）に Rule のルートを含めていないので、Rule ファイルは
  // 早い段階で WRITE_GUARD_DENIED として弾かれ、削除経路は `assertUserArtifact` を通る。
  const isSubagent = extname(target) === ".md";
  const name = isSubagent ? basename(target, ".md") : basename(target);
  const kind: KindId = isSubagent ? "subagent" : "skill";

  const root = managedRoots(env).find(candidate => isInside(target, candidate));
  if (root) {
    // 退避ディレクトリは appSupport の下にあり、ホームの外に置かれることがある。
    assertSafeCreation(target, root, isInside(root, env.home) ? env.home : env.appSupport);
  } else if (!isHardLinkedIntoStore(target, name, env)) {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is outside the managed roots`);
  }

  if (!entry(registry, name, kind)) {
    throw new AgentToolError("NOT_IN_REGISTRY", `${name} is managed by another tool`);
  }
}

/** Windows の Subagent は hardlink で配る。実体と同じ inode なら自分が張ったもの。 */
function isHardLinkedIntoStore(path: string, name: string, env: Env): boolean {
  if (process.platform !== "win32" || extname(path) !== ".md") return false;
  try {
    const link = statSync(path);
    return [agentStore(env), disabledAgentStore(env)].some(store => {
      try {
        const source = statSync(join(store, `${name}.md`));
        return source.ino === link.ino && source.dev === link.dev;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * 作成・移動先の途中にあるリンクを検査する。文字列上の配下判定だけでは、
 * `~/.agents/skills -> /outside` のような付け替えで管理外へ到達するため。
 *
 * リンクそのものは拒まない。`~/.claude` や `~/.agents` を dotfiles リポジトリへ張るのは
 * 普通の構成で、一律に弾くと有効化も更新もできなくなる。
 * 拒むのは信頼できる根（ホーム / プロジェクト）の外へ出るリンクだけ。
 */
export function assertSafeCreation(path: string, root: string, anchor?: string): void {
  const trusted = resolve(anchor ?? root);
  const boundary = resolve(root);
  const target = resolve(path);
  const deny = (): never => {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is outside the managed roots`);
  };
  if (!(isSame(target, boundary) || isInside(target, boundary))) deny();
  if (!(isSame(boundary, trusted) || isInside(boundary, trusted))) deny();

  const trustedParts = trusted.split(sep);
  const targetParts = dirname(target).split(sep);
  if (!trustedParts.every((part, i) => fold(part) === fold(targetParts[i] ?? "\u0000"))) deny();

  // リンク先は realpath で比較する。macOS の `/var` のように、根そのものが
  // symlink を含むことがあり、片側だけ解決すると同じ場所を別物と判定する。
  const trustedReal = realOrSelf(trusted);
  let current = trusted;
  for (const component of targetParts.slice(trustedParts.length)) {
    current = join(current, component);
    if (!isLink(current)) continue;
    const destination = linkTarget(current);
    const resolved = destination === null ? null : realOrSelf(destination);
    if (!resolved || !isInside(resolved, trustedReal)) {
      throw new AgentToolError("WRITE_GUARD_DENIED",
        `${current} is a symbolic link that leaves the trusted root`);
    }
    current = resolved;
  }
}

/**
 * 他のツールが入れた実体の置き場。走査ホワイトリストのうち、
 * ホーム直下の既知ルートから同梱ルートを除いたもの。
 */
export function userRoots(kind: KindId, env: Env, agent?: AgentId): string[] {
  // Rule は共有ストアもリンクも無く、同名でもエージェントごとに別ファイル。
  // どのエージェントの行から来たか分かるときは、そのルートだけに絞る —
  // 絞らないと片方を消したつもりでもう一方まで消える（D-20）。
  if (kind === "rule" && agent !== undefined) {
    return ruleRoots(agent).map(path => join(env.home, path));
  }
  const sources = kind === "skill" ? SKILL_SOURCES
    : kind === "rule" ? RULE_SOURCES
    : SUBAGENT_SOURCES;
  return sources.flatMap(source => {
    if (source.kind === "cli" || source.root !== "home") return [];
    return BUNDLED_SKILL_ROOTS.has(source.path) ? [] : [join(env.home, source.path)];
  });
}

/**
 * 他のツールが入れた実体を触ってよいか。registry には載っていないが、
 * 走査ホワイトリストの既知ルート**直下**にあるものだけを許す。
 *
 * 「誰が入れたか」ではなく「どこに在るか」で決める — 利用者から見れば
 * 一覧に出ているものは自分の資産で、入れた経路が違うだけで消せないのは通らない。
 * ただしリンクは辿らない。辿ると、リンク先の管理外ファイルまで消しにいく。
 */
export function assertUserArtifact(path: string, kind: KindId, env: Env): void {
  assertArtifact(path, kind, userRoots(kind, env), env.home, env);
}

/** プロジェクト内の Skill / Subagent / Rule の置き場。一覧が読む場所と同じにする。 */
export const projectRoots = (kind: KindId, project: string, agent?: AgentId): string[] => {
  if (kind === "skill") return [join(project, ".claude", "skills")];
  if (kind === "subagent") return [join(project, ".claude", "agents")];
  // `userRoots` と同じ理由でエージェント単位に絞る（D-20）。
  if (kind === "rule") {
    return (agent !== undefined ? ruleRoots(agent) : AGENT_IDS.flatMap(ruleRoots))
      .map(path => join(project, path));
  }
  return [];
};

/**
 * プロジェクト内の実体を触ってよいか。信頼の根はワークスペースで、
 * `.claude/skills` / `.claude/agents` の**直下**だけを許す。
 * ホームの管理ルートとは別の根なので、`assertMutable` ではなくこちらを通す。
 */
export function assertProjectArtifact(path: string, kind: KindId, project: string, env: Env): void {
  assertArtifact(path, kind, projectRoots(kind, project), project, env);
}

/**
 * registry が実体のルートを記録している entry の実体（設計決定 D-14 の取り込み分）。
 * ブラウザ拡張が書いた実体は管理ストアの外にあり、`assertMutable` の根では検証できない。
 * 代わりに「走査ホワイトリストの既知ルート**直下**」と「registry に載っている」の
 * 2 つで許す。どちらも `assertMutable` が見ているものと同じ強さの条件である。
 */
export function assertRecordedArtifact(path: string, kind: KindId, env: Env,
                                       registry: Registry): void {
  assertReadable(env);
  const target = resolve(path);
  const name = kind === "subagent" ? basename(target, ".md") : basename(target);
  if (!entry(registry, name, kind)) {
    throw new AgentToolError("NOT_IN_REGISTRY", `${name} is managed by another tool`);
  }
  assertUserArtifact(target, kind, env);
}

/**
 * 実体 1 件を触ってよいか。置き場ごとに信頼の根が違うので、ここで振り分ける。
 * 呼び出し側が分岐を持つと、経路が増えたときに片方だけ漏れる。
 */
export function assertBody(path: string, kind: KindId, env: Env, registry: Registry,
                           place: { readonly scope: "user" }
                                | { readonly scope: "project"; readonly path: string }): void {
  if (place.scope === "project") {
    assertProjectArtifact(path, kind, place.path, env);
    return;
  }
  // 管理ストアの中にあるものは、registry との同一性まで見る `assertMutable` で通す。
  if (managedRoots(env).some(root => isInside(path, root))) {
    assertMutable(path, env, registry);
    return;
  }
  assertRecordedArtifact(path, kind, env, registry);
}

function assertArtifact(path: string, kind: KindId, roots: string[], anchor: string, env: Env): void {
  if (kind !== "skill" && kind !== "subagent" && kind !== "rule") {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${kind} is managed by the agent`);
  }
  const target = resolve(path);
  assertNotBundled(target, env);
  if (isDenied(target) || basename(target).startsWith(".")) {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is protected`);
  }
  if (kind === "subagent" && extname(target) !== ".md") {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is not a subagent file`);
  }
  if (kind === "rule" && extname(target) !== ".md" && extname(target) !== ".mdc") {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is not a rule file`);
  }
  const parent = dirname(target);
  if (!roots.some(root => isSame(parent, root))) {
    throw new AgentToolError("WRITE_GUARD_DENIED",
      `${target} is not directly inside a known ${kind} root`);
  }
  // 既知ルートまでの経路が信頼の根の外へ張り替えられていないことを確かめる。
  assertSafeCreation(target, parent, anchor);
}

/** 同梱スキルとプラグインは、誰が入れたものでも触らない。 */
export function assertNotBundled(path: string, env: Env): void {
  const protectedRoots = [
    ...[...BUNDLED_SKILL_ROOTS].map(root => join(env.home, root)),
    join(env.home, ".codex", "plugins"),
    join(env.home, ".claude", "plugins"),
    join(env.home, ".cursor", "plugins"),
  ];
  const candidates = [resolve(path), realOrSelf(path)];
  const hit = candidates.some(candidate =>
    protectedRoots.some(root => isSame(candidate, root) || isInside(candidate, root)));
  if (hit) throw new AgentToolError("WRITE_GUARD_DENIED", `${path} is protected`);
}

// MARK: - 書き込み
// ここから下だけが実体とリンクを触る。呼び出し側は先に `assertMutable` /
// `assertValidName` を通し、作成系は `prepare` で作成先を検査してから使う（設計決定 D-9）。

/** 作成先を検査してから親ディレクトリを用意する。 */
export function prepare(path: string, root: string, anchor?: string): void {
  assertSafeCreation(path, root, anchor);
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * 実体へのリンクを張る。Windows では symlink に昇格が要るので、
 * ディレクトリは junction、ファイルは hardlink を使う（設計決定 D-4）。
 */
export function createLink(target: string, path: string, kind: "dir" | "file"): void {
  if (process.platform !== "win32") {
    symlinkSync(target, path);
    return;
  }
  if (kind === "dir") {
    symlinkSync(target, path, "junction");
    return;
  }
  try {
    linkSync(target, path);
  } catch (error) {
    // hardlink は同一ボリューム内でしか張れない。コピーへは落とさない —
    // 実体が 2 つになると、更新も無効化も片方にしか効かなくなる。
    throw new AgentToolError("OPERATION_FAILED",
      `${path} could not be hard-linked to ${target} (different volume?): ${(error as Error).message}`);
  }
}

/**
 * その位置が実体への「自分が張ったリンク」か。
 * Windows の hardlink はリンクとして見えないので、実体との同一性で判定する。
 */
export function isManagedLink(path: string, target: string): boolean {
  if (isLink(path)) {
    const destination = linkTarget(path);
    return destination !== null && isSame(destination, target);
  }
  if (process.platform !== "win32") return false;
  try {
    const a = statSync(path), b = statSync(target);
    return a.ino === b.ino && a.dev === b.dev && a.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * ブラウザ拡張が残した取得元の台帳（セキュリティ要件 §2.2.2）。
 * 消してよいのは、走査ルート直下の `.agent-tool/<name>.json` で、
 * 同じルートに実体（`<name>/` か `<name>.md`）があるものだけとする。
 */
export function assertLedger(path: string, root: string, env: Env): void {
  assertReadable(env);
  const target = resolve(path);
  const name = basename(target, ".json");

  if (extname(target) !== ".json" || !isValidName(name)) {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is not a source ledger`);
  }
  if (!isSame(dirname(target), join(root, LEDGER_DIR))) {
    throw new AgentToolError("WRITE_GUARD_DENIED", `${target} is not in ${LEDGER_DIR}`);
  }
  // ルートまでの経路がすり替えられていないこと。台帳だけを消すので anchor はホーム。
  assertSafeCreation(target, root, env.home);
  if (!existsSync(join(root, name)) && !existsSync(join(root, `${name}.md`))) {
    throw new AgentToolError("NOT_FOUND", `${name} has no artifact next to its ledger`);
  }
}

/**
 * 台帳 1 件だけを消す。指す実体には触れず、`.agent-tool` ごとの再帰削除もしない。
 * 取り込みで消えるのは台帳だけである。
 */
export function removeLedger(path: string, root: string, env: Env): void {
  assertLedger(path, root, env);
  unlinkSync(resolve(path));
}

/** リンクだけを外す。実体は消さない。 */
export function removeLink(path: string): void {
  unlinkSync(path);
}

/** 実体を消す。D-5 によりゴミ箱へは送らないので、呼び出し前に必ず確認を取る。 */
export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    // ボリュームをまたぐと rename は EXDEV で失敗する（退避先が別ドライブのとき）。
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export function copy(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export const exists = (path: string): boolean => existsSync(path);

/** OS の一時領域に作業用ディレクトリを作る。呼び出し側が全経路で `remove` する。 */
export const stagingDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
