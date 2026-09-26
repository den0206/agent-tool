# Agent Tool — データ・ロック仕様

## 保存先

可変メタデータは VS Code の `globalStorageUri` に置く `registry.json` だけとする。
管理対象の Skill と Subagent の実体はエージェントが読む既知の管理ルートに置く。

## `registry.json`

`schemaVersion` は `"1"`。保持するのは 3 つだけ:

| キー | 内容 |
|---|---|
| `resources` | 管理下の Skill / Subagent（名前、種別、取得元、SHA、固定、project スコープのパス、実体のルート） |
| `repos` | 取得元ごとの最新 SHA と確認日時。キーは `<repo>#<ref>`（`core/github.ts` の `sourceKey`）。ブランチ未指定は `#HEAD` |
| `agents` | エージェント CLI の手動パス指定 |

自動検出できるもの、使用実績、除外リストは持たない。
未知の将来スキーマは `SCHEMA_UNSUPPORTED` として拒否し、既定値と同じフィールドは書き出さない。

診断結果、信頼レビューの取得結果、Profile、利用回数・最終使用日時は `registry.json` に保存しない。
診断は inventory の生の観測値から都度導出し、既存の一覧キャッシュと同じ寿命で破棄する。

## ロックと書き込み

`registry.ts` は `registry.lock` を `O_EXCL` で作成してプロセス間排他を行う。
書き込みは一時ファイルを `rename` してアトミックに確定し、ロックは `finally` で削除する。

ロックには保持者の PID を書き、回収は経過時間ではなく保持者の生死で決める。導入の実体コピーは
同期で走ってイベントループを止めるため、時間で回収すると作業中の保持者から奪って 2 プロセスが
同時に書き込む。PID が読めないロック（書く前のクラッシュ、旧版が残したもの）だけ mtime 30 秒で回収する。

PID が生きていても 10 分を超えたロックは回収する。PID は再利用されるので、生死だけで決めると
無関係なプロセスが番号を拾った時点で書き込みが永久に止まり、`registry.lock` の手動削除しか
復旧手段が無くなる。展開上限（200 MB）のコピーがこの時間に届くことはない。

## 管理ルート

| ルート | 用途 |
|---|---|
| `~/.agents/skills/` | 管理対象 Skill の実体 |
| `<globalStorageUri>/agents/` | 管理対象 Subagent の実体 |

Rule（`~/.claude/rules/*.md` と `~/.cursor/rules/*.mdc`）は URL からの導入経路を持たず、
registry にも載らないので管理ルートには含まない。走査と削除だけを提供する（D-20）。

`writeGuard.ts` は名前、親ディレクトリ、リンク先、管理ルートを検証してから作成、移動、削除する。
macOS/Linux では symlink、Windows では junction または hardlink を使う。

## 資源管理

- 一覧キャッシュはメモリだけに保持し、手動更新、書き込み後、View 非表示で破棄する。
- project 内の深さ制限走査は symlink / junction を辿らず、workspace 外へ走査を広げない。
- ダウンロード、展開、staging は OS の一時ディレクトリに作り、`finally` で削除する。
- HTTP キャッシュ、ログ、診断履歴、Undo スナップショットを保存しない。
- registry、GitHub API 応答、差分本文の合計は 2 MB を上限とする。
- `registry.json` は読み込み時だけでなく保存前にも 2 MB を検査し、自分で読めないファイルを作らない。
- HTTP 応答の上限は `Content-Length` だけに依存せず、ストリームの読み込み中に byte 数で打ち切る。
  全文を読んでから切り詰める実装は上限として扱わない。
- 読み取る設定ファイルは単一ファイルと同じ 20 MB を上限とする。`~/.claude.json` は履歴で育つ。
- MCP の状態確認は前回の確認中には重ねて実行しない。非表示・破棄後の結果は保持しない。
- MCP の健全性確認で設定済みコマンドを起動しない。PATH 上の解決可否と、View 表示中の既存
  プロセス照合だけを使う。

## ブラウザ拡張の保存先

| 保存先 | 内容 |
|---|---|
| IndexedDB | 許可済みディレクトリハンドル（エージェント別）、導入した Skill / Subagent の収集一覧、`autoOpenOnDetection` と `theme` の設定 |
| `chrome.storage.local` | Jev 補助検知の有効フラグと、利用者自身の Jev API key |

Jev の 2 項目だけ IndexedDB に置かないのは、書き込み前に `setAccessLevel`
(`TRUSTED_CONTEXTS`) を掛けて content script から読めなくするためである
（`docs/agent-tool-security.md` §10.5）。他の設定を移す理由にはしない。

収集一覧の上限は `core/` の `MAX_BROWSER_COLLECTION_ENTRIES = 100` とし、超えた分は古い順に捨てる。各項目は取得元、commit SHA、導入先、日時、
導入直後に計算した実体ツリーの SHA-256 だけを持つ。ログ、診断履歴、閲覧した URL は保持しない。
`autoOpenOnDetection` は既定で `true` の boolean だけを持つ。
`theme` は CSS の `color-scheme` にそのまま渡す文字列で、既定はシステム追従の `light dark`。他に `light` と `dark` を取る。
ハンドルは `requestPermission()` の再取得が必要になるため、ブラウザ再起動後の初回操作で
利用者の操作を1回求める。

## 取得元の台帳

ブラウザ拡張は実体を書いた導入先ルートに、エントリごとの台帳を置く。

```
<導入先ルート>/.agent-tool/<name>.json
```

| キー | 内容 |
|---|---|
| `name` | 実体の名前（ディレクトリ名または `.md` のファイル名） |
| `kind` | `skill` または `subagent` |
| `repo` / `branch` / `subdir` | 取得元 |
| `sha` | 導入時点の commit SHA |

エントリごとに 1 ファイルとし、read-modify-write を行わない。ブラウザ拡張はプロセス間ロックを
取れないため、共有ファイルへの追記や部分削除を避ける。`pinned` は IDE 拡張が
持つため台帳には持たない。実体ツリー SHA-256 も持たない（用途が違う。下記）。

IDE 拡張は走査時に未取り込みの台帳を見つけると、`registry.json` へ `Entry` として追加し、
読み終えた台帳ファイルを削除する。走査は `.` で始まる名前を除外するので、台帳が Skill として
誤検出されることはない。

取り込む `Entry` には**実体のルート**（`root`、ホーム相対・`/` 区切り）を載せる。
ブラウザ拡張の実体は自分が許可されたルート（`~/.claude/skills` など）にあり、IDE 拡張の
管理ストア（`~/.agents/skills`）とは別の場所である。`root` を持たないと `layout` が管理ストアを
指し、削除が実体を見失い、更新適用は管理ストアへ新版を書いて実体を二重化する。
`root` が管理ストアと同じか、ホームの外を指す場合は既定の置き場として扱う。

`root` のある実体にはリンクを張らない。実体はすでにエージェントが読む場所にあるので、
足すと自分自身を指すリンクか、利用者が選んでいないエージェントへの配布になる。
`root` のある実体は管理ストアの外にあるため、`assertMutable` の信頼の根では検証できない。
`writeGuard.assertBody` が置き場で振り分け、`assertRecordedArtifact` が
「走査ホワイトリストの既知ルート**直下**」と「registry に載っている」の 2 つで許す。

取り込み直しでは `pinned` を引き継ぐ。利用者が決めた状態を、入れ直しで黙って解除しない。

取り込みと除去は `ide/ledger.ts` が行い、未信頼ワークスペースと Remote では走らせない
（`inventory` の `writable` が false になる）。台帳が 1 件も無ければ registry を開かない。

| 記録 | 置き場 | 用途 |
|---|---|---|
| 台帳（取得元・commit SHA） | 導入先ルートの `.agent-tool/` | ブラウザ拡張から IDE 拡張への片方向の引き渡し |
| 実体ツリー SHA-256 | IndexedDB の収集一覧 | ブラウザ拡張自身が削除してよいかの判定 |

## 実体の置き場（ブラウザ拡張）

| 導入先 | 置き場 |
|---|---|
| Claude Code | `~/.claude/skills/<name>/`、`~/.claude/agents/<name>.md` |
| Cursor / Codex | `~/.agents/skills/<name>/`（無ければ `~/.cursor/skills` `~/.codex/skills`） |
| Cursor の Subagent | `~/.cursor/agents/<name>.md` |

`~/.agents/skills` は Cursor と Codex の両方が読むため、存在する環境では実体を 1 つに保てる。
Claude は読まないので常に `~/.claude` 側へ直接置く。ブラウザ拡張は symlink を作れない。

## 実体を失った entry

IDE 拡張は走査のたび、**走査できたルートに属する entry** だけを実体と照合し、実体が無ければ
`registry.json` から除く。走査できなかったルートの entry は残す。開いていないプロジェクトの
project スコープ entry を巻き込まないための条件である。

「無い」と「読めない」を同じに扱わない。走査は両方を空として返すが、除去の前に走査ルートへ
`accessSync(R_OK | X_OK)` を当て、**読めないルートが 1 つでもあれば除去そのものを行わない**。
権限・退避されたクラウド同期・切れたネットワークホームで一時的に読めないだけのものを
「消えた」と扱うと、実体が残っているのに `pinned` / 取得元が永久に失われる。
読めなかったルートは `issues` に出して黙って諦めない。
