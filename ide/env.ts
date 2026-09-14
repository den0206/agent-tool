import { join } from "node:path";

/**
 * パスの解決点。テストでは偽のホームを指す `Env` を渡す。
 * `appSupport` は拡張の `context.globalStorageUri.fsPath`（OS 別パスは VS Code が解決する）。
 */
export type Env = { readonly home: string; readonly appSupport: string };

/**
 * 外部コマンドの実行。走査から見た唯一のプロセス依存で、テストでは差し替える。
 * 拡張ホストを止めないため非同期にする。
 */
export type Run = (command: string[]) => Promise<string>;

/** スキル実体の置き場。Cursor と Codex がここを直読みする。 */
export const skillStore = (env: Env): string => join(env.home, ".agents", "skills");
/** 無効化したスキルの退避先。実体は消さない。 */
export const disabledStore = (env: Env): string => join(env.appSupport, "disabled-skills");
/** Subagent の実体。共有ルートの慣習が無いので拡張の保存領域に置く。 */
export const agentStore = (env: Env): string => join(env.appSupport, "agents");
export const disabledAgentStore = (env: Env): string => join(env.appSupport, "disabled-agents");
/** 永続化する唯一のファイル。 */
export const registryFile = (env: Env): string => join(env.appSupport, "registry.json");
/** Claude だけは共有ルートを読まないのでリンクを張る先。 */
export const claudeSkills = (env: Env): string => join(env.home, ".claude", "skills");

/**
 * 削除・移動してよいルート。ここ以外は触らない。
 * Rule は URL からの導入経路を持たず registry に載らないので `assertMutable` の
 * 対象外。走査で見つけたものは `assertUserArtifact` / `assertProjectArtifact` の
 * ホワイトリスト経路だけで削除する（D-20）。
 */
export const managedRoots = (env: Env): string[] =>
  [skillStore(env), disabledStore(env), agentStore(env), disabledAgentStore(env)];
