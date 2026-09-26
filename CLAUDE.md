# CLAUDE.md — Agent Tool 作業ガイド

AI エージェントの周辺リソース（MCP / Skills / Subagents / Plugins）を管理する
Cursor 拡張 **Agent Tool** と、Skill / Subagent を検知して導入するブラウザ拡張。
実装は TypeScript に統一し、macOS / Linux / Windows で全機能を提供する。

## 設計の正本

| ファイル | 役割 |
|---|---|
| `docs/product-requirements.md` | 移行後の対象機能・完了条件 |
| `docs/vscode-cursor-extension-design-questions.md` | 設計決定と理由 |
| `docs/agent-tool-cli-api.md` | 管理ロジックの TypeScript モジュール API |
| `docs/agent-tool-data-spec.md` | ストレージ・ロック |
| `docs/agent-tool-ui-design.md` | Tree View と操作フロー |
| `docs/agent-tool-security.md` | WriteGuard・権限・信頼境界 |
| `docs/agent-tool-test-plan.md` | TypeScript と Cursor の検証 |
| `docs/agent-tool-release-plan.md` | Phase 0 の改名・撤去と開発・配布順序 |

Agent Tool の判断では `docs/agent-tool-*.md` を優先する。仕様を複製せず、該当する正本を更新する。

## 実装境界

- 製品・拡張名は **Agent Tool**、拡張 ID は `agent-tool`。
- リポジトリとローカルディレクトリは`agent-tool`とする。
- macOSアプリ、旧CHANGELOG、配布・署名・公証資産は置かない。
- TypeScript は `ide/` `browser/` `core/`、テストはルートの `test/`、スクリプトは `scripts/` に置く。
- サブプロセスの CLI は持たない。外部コマンドはプロセス一覧取得と PATH 解決だけに限る。
- 走査・判定・書き込み・WriteGuard は `ide/` のモジュールが担当する。
- `core/` は OS にもブラウザにも依存しない判定と取得だけを置く。MCP と Plugin は上げない。
- ブラウザ拡張は Chrome / Edge / Brave 対象。書き込みは File System Access API だけで行い、
  扱うのは Skill と Subagent に限る。IDE 拡張の導入も起動も前提にしない。
- OS 分岐は `process.platform` で行い、リンクは macOS / Linux が symlink、Windows が junction / hardlink。

## 完了の定義

```bash
npm run typecheck && npm test
./scripts/check-invariants.sh
./scripts/release-changelog.sh --check && ./scripts/test-release-changelog.sh
```

Cursor E2E追加後は固定Cursor Stableでも検証する。3 OS で同じスクリプトを回す。
CI はローカルと同じスクリプトを呼び、別ロジックを持たせない。

## 絶対に守る不変条件

1. ファイル書き込みは3経路だけに置く。Skill / Subagent の実体とリンクは `writeGuard.ts`、
   `registry.json` は `registry.ts`、Cursor の `mcp.json` は `mcpScanner.ts` が扱う。
   ブラウザ拡張が残した取得元の台帳の削除も `writeGuard.ts` の専用パスを通す。
2. 削除・移動・リンク作成は `writeGuard.ts` を通す。作成前に `assertValidName`、
   親ディレクトリの symlink / junction は `assertSafeCreation` で検証する。
3. 走査対象は `Source` のホワイトリストだけにする。ホームを再帰走査せず、project の深さ制限走査は
   symlink / junction を辿らない。
4. 壊れた registry の上で書き込みを始めない。read-modify-write はプロセス間ロック内で行い、
   registry はアトミックに保存する。
5. 未信頼ワークスペースでは一覧だけを許可し、Remote 環境では書き込みを行わない。
6. UI 文言は `l10n/` と `browser/_locales/` の英語・日本語を同時に更新する。
7. ブラウザ拡張は利用者が許可したディレクトリの外へ書き込まない。`<all_urls>` を要求しない。

不変条件スクリプトの許可リストを広げる場合は、ユーザーデータへ到達しない理由を
スクリプト内に記す。

## ストレージ・メモリ管理

リソース管理ツール自身がディスクとメモリを増やさないことを機能要件として扱う。

- 可変メタデータは `<globalStorageUri>/registry.json` だけ。`registry.lock` は保持者の PID だけを持つロック inode。
- `registry.json` は読み込み時と保存前の両方で 2 MB 上限を検査する。
- Skill / Subagent 実体は管理対象データであり、キャッシュではない。既存配置を再利用し、コピーを重複させない。
- ログ、診断履歴、Undo スナップショット、インベントリ、差分を永続化しない。
- 走査結果の180秒キャッシュは拡張のメモリだけに置き、手動更新・書き込み直後・View 非表示で破棄する。
- MCP の3秒ポーリングとファイル監視は対象 View の表示中だけ動かし、再表示時に再走査する。
- 外部コマンドの stdout / stderr は各2 MBで打ち切り、マスク済みの直近分だけをメモリ保持する。
- HTTP は `fetch` に `cache: 'no-store'` を指定し、アーカイブをメモリに載せずファイルへ流す。
- 外部レスポンスの上限は読み込み中に byte 数で打ち切る。`response.text()` / `json()` / `arrayBuffer()` の後から
  `slice` して上限に見せかけない。`Content-Length` は事前拒否にだけ使い、欠落・虚偽に備えて実測も制限する。
- ダウンロード50 MB、展開後200 MB、単一ファイル20 MB、カタログページ2 MB、外部コマンド出力2 MBの上限を維持する。
- 一時ダウンロード・展開・staging は OS の一時領域に置き、成功・失敗・キャンセルの全経路で削除する。
- 一覧では frontmatter の先頭4 KBだけを読む。本文は詳細表示中だけ保持し、閉じたら破棄する。
- Tree View は表示に必要な DTO だけを保持し、Inventory や本文を複製して常駐させない。
- ブラウザ拡張が永続化するのは IndexedDB のディレクトリハンドル、収集一覧、検知の自動表示と配色の設定、
  `chrome.storage.local` の Jev 設定（有効フラグと API key。Beta 機能）と自動検知の Jev 呼び出し枠
  （窓の開始時刻と回数の 2 値だけ）だけ。件数上限を持つ。
  閲覧した URL、ログ、診断履歴は保持しない。上限値は `core/` で IDE 拡張と共有する。
- 目標は一覧表示300 ms未満（メモリキャッシュ時）、常駐増分65 MB未満、VSIX 20 MB未満。

上限を緩めるのは、実測で不足が確認され、新しい上限と回収経路をテストできる場合だけにする。

## 実装パターン

- 外部依存は関数の引数で注入する。実装が1つの interface や class を作らない。
- Agent は文字列ユニオン型（`AgentId`）と網羅的な `switch` を使う。
- OS 操作は端へ寄せ、判定を純粋関数にして `node:test` で検証する。
- 入力は構造化オブジェクトで受け、区切り文字列から復元しない。
- 失敗は `AgentToolError` の安定したエラーコードとマスク済みメッセージで返す。
- Node.js / VS Code API の標準機能を優先し、必要になるまで依存を増やさない。

## テスト

- テストは偽ホーム（`os.tmpdir()` 配下）を使い、実ユーザーのホームへ到達させない。
- 走査ホワイトリスト、WriteGuard、ロック、移行衝突、出力上限を優先する。
- View のライフサイクル、Remote / Workspace Trust、OS 別のリンク種別を検証する。
- Cursor E2E は固定URLとSHA-256のCursor Stable実行ファイルを明示して、全PRで起動する。
- UI スナップショットやモック自体を検証するテストは書かない。
- テスト件数を仕様に固定しない。完了条件は全テスト成功とする。

## ローカライズ・コミット

- IDE 拡張の文言は `l10n/`、ブラウザ拡張は `browser/_locales/{en,ja}/` で管理する。
  形式は揃えず、英日のキーが揃っているかを `check-invariants.sh` が検査する。
- パス・コマンド・差分は verbatim で表示する。
- 日本語の Conventional Commits を使う。コミットと push はユーザーが求めた場合だけ行う。
- 利用者に見える変更は `CHANGELOG.md` の `[Unreleased]` に英語で追加する。
- README を変える場合は英語版と日本語版を同時に更新する。
- 役割が重なる文書・スクリプト・設定を増やさない。
- 実装後は `/ponytail:ponytail-review` で過剰実装を確認する。

## 配布・依存管理

- 開発・CI は Node 24 LTS、npm、`package-lock.json`、Node標準 `node:test`を使う。拡張の `engines.node` は `>=20` を維持し、Node 20 でも起動できる状態を保つ。
- 依存は必要最小限の正確な版に固定し、`ignore-scripts=true`、第三者Actionのcommit SHA固定を守る。
- Publisherは`yuuki-sakai`。alpha / betaはGitHub Releases、安定版は同じVSIXをOpen VSXからGitHubの順に公開する。
- IDE拡張とブラウザ拡張は同じ版で配布する。`release/Ver_X.Y.Z` が両方を組み立て、同じGitHub Releaseへ添付する。
- ブラウザ拡張はChrome Web StoreとEdge Add-onsへ同じzipを出す。
- VSIXにバイナリを同梱せず、署名・公証も行わない。最初の公開前と配布経路変更時に、配布VSIXからの初回起動を実機確認する。
- 定期canaryは設けない。リリース前にRSSとAgent Tool自身の保存容量を計測する。
