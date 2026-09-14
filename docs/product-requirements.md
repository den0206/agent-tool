# Agent Tool — プロダクト要件書

AI コーディングエージェントの Skill、Subagent、Rule、MCP サーバー、Plugin を管理する
Cursor 拡張と、Skill と Subagent の検知・導入を担うブラウザ拡張。

| 項目 | IDE 拡張 | ブラウザ拡張 |
|---|---|---|
| 識別子 | `agent-tool` | `browser/manifest.json` |
| 対象 | Cursor / VS Code | Chrome / Edge / Brave |
| 対象 OS | macOS / Linux / Windows | 同左 |
| 実装 | TypeScript | TypeScript |
| 永続メタデータ | `globalStorageUri/registry.json` | IndexedDB のディレクトリハンドル、収集一覧、自動表示設定 |

両者は独立して動作する。ブラウザ拡張は IDE 拡張の導入も起動も前提にしない。

## IDE 拡張の機能

- Dashboard でユーザー全体とワークスペースのツールを一覧表示する。
- 公開 GitHub URL から Skill、Subagent、Plugin を追加する。Rule は URL からの追加を提供せず、
  既に置かれているものの表示・削除だけを担う（D-20）。
- 構造化 JSON、HTTP URL、または安全なコマンドから MCP サーバーを追加する。
- 削除、有効化、無効化、更新プレビュー、更新適用を提供する。
- Plugin の設定変更は対象 CLI の実行コマンドを表示して確認を求める。
- ブラウザ拡張が残した取得元の台帳を走査時に `registry.json` へ取り込む。

## ブラウザ拡張の機能

- 初回オンボーディングで利用する Agent の導入先を一度だけ許可する。
- 対応サイトの閲覧中に、そのページが Skill / Subagent なら検知し、拡張の popup を開く。
- カタログ由来の候補は、GitHub アーカイブから実体を抽出できることを確認してから検知する。
- 貼り付けた URL を検知と同じ判定で解析する。
- 導入先のエージェントを選び、File System Access API で実体を書き込む。
- 自分が入れたものを削除する。
- 導入したものをブラウザ内の収集一覧に保持する。
- `Supported sites` から GitHub と対応カタログを開ける。

MCP と Plugin は扱わない。ローカルの導入済み一覧も表示しない。スコープはユーザー全体だけとする。

## 安全性

- IDE 拡張の書き込みは `writeGuard.ts`、`registry.ts`、`mcpScanner.ts` に限定する。
- 未信頼ワークスペースと Remote 環境では書き込みを拒否する。
- 走査対象は `source.ts` のホワイトリストに限定する。
- ブラウザ拡張は利用者が許可したディレクトリの外へ書き込まない。
- 可変メタデータ以外のキャッシュ、ログ、Undo スナップショットを保存しない。

## リリース条件

- `npm run typecheck`、`npm test`、不変条件検査、リリース検査が通る。
- Linux、macOS、Windows で型検査とテストが通る。
- Cursor Stable の E2E と VSIX の 20 MB 上限を確認する。
- ブラウザ拡張は Chrome / Edge / Brave で検知から導入までを実機確認する。
