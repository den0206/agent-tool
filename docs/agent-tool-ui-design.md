# Agent Tool — UI 情報設計

> 設計の前提は [vscode-cursor-extension-design-questions.md](vscode-cursor-extension-design-questions.md) を参照。
> モジュール API 仕様は [agent-tool-cli-api.md](agent-tool-cli-api.md) を参照。

---

## 1. Activity Bar パネル構成

Cursor の Activity Bar に **Agent Tool** アイコンを追加する。クリックで以下の Tree View を開く。

```
AGENT TOOL                                    [＋ Add] [⟳ Refresh]
─────────────────────────────────────────────────────────────────
▾ 🌐 Environment
    ● claude     1.2.3    /usr/local/bin/claude
    ● cursor     0.45.0   /usr/local/bin/cursor
    ○ codex      —        not found
    ○ gemini     —        not found

▾ 📁 Current Project  (/path/to/project)
  ▾ Claude Code
    ▾ Skills
        ✓ my-skill        [⬆] [⊘] [🗑]
    ▾ Subagents
        ✓ my-agent
    ▾ MCP Servers
        ● running-server  [●]
    ▾ Plugins
        (none)

▾ 👤 User Global
  ▾ Claude Code
    ▾ Skills
        ✓ global-skill  ⬆2  [⬆] [⊘] [🗑]
    ▾ Subagents
        (none)
    ▾ MCP Servers
        ● my-mcp      [●]
    ▾ Plugins
        ✓ ponytail
  ▸ Cursor
  ▸ Codex
  ▸ Gemini CLI
─────────────────────────────────────────────────────────────────
```

**アイコン凡例:**

| 記号 | 意味 |
|---|---|
| `●` / `○` | CLI: found / not found。MCP Server: running / stopped |
| `✓` | Tool: active |
| `⬆` | 更新あり（数字付きは件数） |
| `[⬆]` | 更新ボタン（インライン） |
| `[🗑]` | 削除ボタン |
| `[●]` | MCP ステータス表示（クリックでプロセス情報） |
| `⚠` / `✗` | 診断: 要確認 / 壊れている |

---

## 2. Environment セクション

`scanPath()` の結果を一覧の上に折りたたみで表示する（View 表示時に 1 回、手動更新で引き直す）。

```
▾ 🌐 Environment
    ● claude     1.2.3    /usr/local/bin/claude
    ● cursor     0.45.0   /Applications/Cursor.app/...
    ○ codex      —        not found  [インストール方法を見る ↗]
    ○ gemini     —        not found  [インストール方法を見る ↗]
```

- 各 Agent に、`対応形式`、`導入済み`、CLI または設定ディレクトリの検出状態を別々に表示する。
  Cursor は CLI を持たないため、設定ディレクトリの検出だけを表示する。
- 1 つも見つからないときは一覧の上に警告バナーを出す（§8.4）
- 手動更新ボタンで再スキャンできる

---

## 3. Tree View アイテム詳細

### 3.1 Skill / Subagent アイテム

```
[アイコン] [名前]  [更新バッジ]  [インラインボタン]
```

| 状態 | 表示例 |
|---|---|
| 有効・更新なし | `✓ my-skill                [🗑]` |
| 有効・更新あり | `✓ my-skill  ⬆             [⬆] [🗑]` |
| ピン留め | `✓ my-skill · 📌 固定中` — 更新を追わない。`•••` から切り替える |
| 版が固定できていない MCP | `✓ chrome · 実行中 · 版を固定してください` — `@latest` 指定 |

カードを開くと、説明・使い方・場所・取得元を出す。

`@latest` 指定の MCP は、起動のたびに中身が変わるのでこちらが更新を管理できない。
黙って壊れうるので行に警告を出し、カードを開いたときにパッケージ名を添えて理由を書く
（判定は `mcpServer.floatingPackage`）。

**最終使用は出さない。** 使用実績は `~/.claude/projects`（129 MB）や `logs_*.sqlite` を読まないと
分からず、一覧表示の応答目標を壊す。走査ホワイトリストにも入れない（`ide/source.ts`）。

説明・使い方・場所・取得元は、カードそのものをクリックするとカードの直下に開き、
もう一度クリックすると閉じる（Enter / Space も同じ）。`•••` は管理操作だけを出す。

管理下で有効な Skill の `•••` には「別のスコープへコピー」を出す。user と Current Project の
宛先を選ぶと、確認画面で source と destination をそのまま示し、「既存ファイルは上書きしない」と
明示する。コピー後も元は残す。Subagent、Rule、MCP、Plugin、管理外の Skill には出さない。

取得元を持つ管理下の有効 Skill には「別の AI Agent に追加」も出す。取得元をブラウザで開き、
ブラウザ拡張の導入先選択で Agent を選ぶ。元の Skill は変更しない。

### 3.4 診断

Dashboard の `環境を診断` は inventory の診断を集約して表示する。追加の再帰走査、ネットワーク取得、
MCP コマンドの起動、履歴の保存はしない。

`環境` と `環境を診断` は Dashboard 最下部に左寄せの見出しで置き、初期表示では閉じる。見出しを
押すとその表示中だけ開閉し、設定や診断結果を永続化しない。検出済み CLI はバージョンと実行ファイルの
絶対パスを表示する。

```
⚠ 環境を診断: 3 件
  ✗ deploy: 壊れたリンク
    ~/.claude/skills/deploy
  ⚠ github: 起動コマンドを PATH で解決できません
  ⚠ docs: user と project の両方に登録されています
  ⚠ lint: 同名の実体が 2 件あります
    ~/.claude/skills/lint
    ~/.agents/skills/lint
```

- `⚠` は要確認、`✗` は読み込み不能な実体を表す。自動修復・自動削除はしない。
- 同名競合は、優先順位が Agent と scope ごとに検証済みでない限り「有効なコピー」を表示しない。
- 対象の実体パスを表示する。解決操作や比較は既存の Explorer・削除・再導入を利用者が明示して行う。

### 3.2 MCP Server アイテム

```
● running-server   [●]     ← クリックで pid/コマンドをポップアップ
○ stopped-server
```

MCP Server の起動状態は View 表示中のみ 3 秒ポーリング（`mcp-status` コマンド）で更新する。
View を閉じるとポーリングを停止する。

### 3.3 他のプロジェクト

User Global の一覧の下にドロップダウンを置き、現在のワークスペース以外のプロジェクトを 1 件選んで
その project スコープのツールを見せる。

```
▾ Other projects
    [ プロジェクトを選択 ▾ ]
    /path/to/other-project
    ✓ their-skill              ← クリックで説明・場所を開く（再クリックで閉じる）
```

- 候補は `~/.claude.json` の `projects` キーのうち、実在してツールを持つプロジェクトだけ（`knownProjects`）。
  ホームは走査しない（不変条件 3）。
- ツールの有無は直下の `.claude/skills`・`.claude/agents`・`.mcp.json` と、
  `~/.claude.json` の `projects[path].mcpServers` だけで決める。候補全件に深さ 3 の走査は掛けない。
- 走査するのは選ばれた 1 件だけ（`inventory` の `user: false`）。Webview から届くパスは信頼せず、候補に載っているものだけ受け付ける。
- Plugin は `projectPath` が選んだパスと一致するものだけ。他プロジェクト分は載せない。
- 走査失敗は空一覧にせず、理由を出す（メイン一覧の `issues` と同じ）。
- 表示は読み取り専用。管理できるのは開いているワークスペースの project スコープだけで、
  他プロジェクトの実体には `projectPath` を渡さない（`isManageable` が false になる）。
- MCP の起動状態は出さない。ポーリングは user スコープの登録だけを見ている。
- 結果は Webview 側にだけ置き、View を閉じたら捨てる。

---

## 4. 操作フロー

### 4.1 ツール追加

**方法 A: コマンドパレットから URL 貼り付け**

```
1. Cmd+Shift+P → "Agent Tool: Add Skill"
2. Quick Input が開く
   "GitHub URL を貼り付けてください"
   > https://github.com/example/my-skill
3. スコープ選択 Quick Pick（ワークスペースが開いていないときは出さず user に入れる）
   ● User Global       すべてのプロジェクトで使えます
   ○ Current Project   /path/to/project
4. 取得・インストール中（プログレスバー）
5. 完了 → Tree View が自動更新
```

**方法 B: クリップボード自動検出**

クリップボードに GitHub URL がある状態でパネルを開くと、
Tree View 上部に候補カードを表示する:

```
╔═════════════════════════════════════════╗
║ クリップボードに URL があります           ║
║ https://github.com/example/my-skill     ║
║ [追加する]  [閉じる]                     ║
╚═════════════════════════════════════════╝
```

### 4.2 ツール削除

```
1. アイテムの [🗑] をクリック
2. 確認ダイアログ（→ セクション 5.1）
3. [削除] 実行 → remove()
4. 通知バー: "my-skill を削除しました"
   → Undo は提供しない（設計決定 D-5）。取り消せないことは 5.1 の確認ダイアログで示す
```

### 4.3 更新（差分プレビュー → 適用）

```
1. アイテムの [⬆] をクリック
2. update-preview コマンド実行
3. VS Code Diff Editor が開く
   左ペイン: 現在バージョン（abc123）
   右ペイン: 最新バージョン（def456）
4. Diff Editor の前に、追加・削除・変更ファイル数、manifest/configuration の変更、
   本文を省略したファイルを要約して表示する
5. ユーザーが差分を確認
6. エディタ上部の通知バー:
   "my-skill の更新を適用しますか？"  [適用] [キャンセル]
7. [適用] → 確認ダイアログ（→ セクション 5.2）
8. update-apply コマンド実行
9. 通知バー: "更新しました"
```

---

## 5. 確認ダイアログ仕様

すべての確認ダイアログは VS Code `window.showWarningMessage` または専用モーダルで表示する。

### 5.1 削除確認

```
┌─────────────────────────────────────────────┐
│ ⚠  my-skill を削除しますか？                  │
│                                              │
│ 対象: ~/.claude/commands/my-skill.md         │
│ エージェント: Claude Code                     │
│ スコープ: User Global                        │
│                                              │
│ この操作は取り消せません。                    │
│ 実体とリンクを完全に削除します。              │
│                                              │
│            [キャンセル]  [削除]              │
└─────────────────────────────────────────────┘
```

### 5.2 更新適用確認

```
┌─────────────────────────────────────────────┐
│ ⬆  my-skill を更新しますか？                  │
│                                              │
│ 現在: abc123  →  最新: def456                │
│ 対象: ~/.claude/commands/my-skill.md         │
│                                              │
│ ピン留めを解除して更新します。               │
│                                              │
│            [キャンセル]  [更新を適用]        │
└─────────────────────────────────────────────┘
```

### 5.3 MCP サーバー設定変更確認

```
┌─────────────────────────────────────────────┐
│ ⚠  MCP サーバー設定を変更しますか？           │
│                                              │
│ 操作: 追加                                   │
│ サーバー名: my-server                        │
│ コマンド: node /path/to/server.js            │
│ 設定ファイル: ~/.cursor/mcp.json             │
│ エージェント: Cursor                         │
│                                              │
│            [キャンセル]  [変更する]          │
└─────────────────────────────────────────────┘
```

---

## 6. コマンド一覧

パレットに出すのは、引数なしで実行できる 4 つだけにする。

| コマンド ID | タイトル（日本語） | 説明 |
|---|---|---|
| `agent-tool.addSkill` | GitHubからSkillを追加 | URL を入力してインストール（スコープを選ぶ） |
| `agent-tool.addMcp` | MCPサーバーを追加 | JSON・HTTP URL・起動コマンドから追加 |
| `agent-tool.refreshInventory` | ツールを再読み込み | キャッシュを破棄して再走査 |
| `agent-tool.checkUpdates` | 更新を確認 | 取得元の最新 SHA を引き、更新バッジを立てる |

残りは**選んだツール**を引数に取るので `contributes.commands` に出さない。パレットからは
引数が来ず、押しても無反応になるためである。呼ぶのはカードの `•••`（`openToolActions`）と
Webview だけにする。

| コマンド ID | 説明 |
|---|---|
| `agent-tool.openToolActions` | カードの `•••` から呼ぶ操作一覧 |
| `agent-tool.togglePin` | 更新の固定を切り替え（固定中は更新を追わない） |
| `agent-tool.copySkill` | 管理下 Skill を別スコープへコピー（確認あり・上書きなし） |
| `agent-tool.removeTool` | ツールを削除（確認あり） |
| `agent-tool.previewUpdate` | 更新をプレビュー（Diff Editor を開く） |
| `agent-tool.applyUpdate` | 更新を適用（確認あり） |
| `agent-tool.installPreview` | 確認画面から導入する。成否を返す |
| `agent-tool.inventory.focus` | Dashboard を開く。Status Bar のバッジから呼ぶ |

CLI の再検出は手動更新（`refreshInventory`）に含める。MCP のプロセス情報は表示中の
3 秒ポーリングで出すので、専用コマンドは持たない。

---

## 7. Status Bar

Cursor の Status Bar 右端に更新件数バッジを表示する。

```
[⬆ 3 updates]
```

- クリックで Dashboard にフォーカスする（`agent-tool.inventory.focus`）
- 更新なしのときは非表示
- `inventory` の `hasUpdate: true` な件数をカウントする。件数が立つのは
  `checkUpdates` を実行したあと（`registry.repos` に `latestSha` が入ったとき）

---

## 8. エラー表示

### 8.1 Remote 環境（SSH / Dev Container / Codespaces）

一覧の上にバナーを表示する。書き込み操作は実行時にも拒否する:

```
╔═════════════════════════════════════════════╗
║ ⚠ Agent Tool はローカル環境でのみ動作します  ║
║ Remote 接続中は操作できません。              ║
╚═════════════════════════════════════════════╝
```

### 8.2 未信頼ワークスペース

一覧の上にバナーを表示する。書き込み操作は実行時にも拒否する:

```
╔══════════════════════════════════════════════╗
║ 🔒 未信頼ワークスペース — 一覧のみ表示します  ║
║ 操作するにはワークスペースを信頼してください。 ║
║ [ワークスペースを信頼する ↗]                  ║
╚══════════════════════════════════════════════╝
```

### 8.3 WriteGuard 拒否

操作失敗時は通知バー（エラー）で表示する:

| エラーコード | 表示メッセージ |
|---|---|
| `WRITE_GUARD_DENIED` | `<path> は保護対象です` |
| `INVALID_NAME` | `<name> は名前として使えません（取得元の指定を確認してください）` |
| `NOT_IN_REGISTRY` | `<name> は他のツールが管理しています` |
| `SYMLINK_OUTSIDE_STORE` | `<path> は Agent Tool が張ったリンクではありません` |
| `LOCK_TIMEOUT` | `書き込みロックを取得できませんでした（他のウィンドウが操作中の可能性があります）` |

### 8.4 CLI 未検出（`scanPath()` が 1 つも見つけない）

```
╔══════════════════════════════════════════════╗
║ ⚠ AI エージェント CLI が見つかりません        ║
║ claude / cursor のいずれもインストールされて   ║
║ いないか、PATH に含まれていません。            ║
║ [セットアップガイドを見る ↗]                  ║
╚══════════════════════════════════════════════╝
```

---

## 9. ファイル監視によるリアルタイム更新

TS 拡張は `vscode.workspace.createFileSystemWatcher` と `RelativePattern` で以下を監視する。
変更を検知したら `inventory` コマンドを再実行して Tree View を更新する（キャッシュを破棄）。

| 監視パターン | 対象 |
|---|---|
| `~/.agents/skills/**` | 管理対象の共有 Skill |
| `~/.claude/skills/**` | Claude Skill |
| `~/.cursor/skills/**` | Cursor Skill |
| `~/.codex/skills/**` | Codex Skill |
| `~/.claude/agents/**` | User Global サブエージェント |
| `~/.cursor/agents/**` | Cursor サブエージェント |
| `<workspaceFolder>/.claude/skills/**` | Current Project スキル |
| `<workspaceFolder>/.claude/agents/**` | Current Project サブエージェント |
| `<workspaceFolder>/.claude/rules/**` | Current Project Claude Rule |
| `<workspaceFolder>/.cursor/rules/**` | Current Project Cursor Rule |
| `<workspaceFolder>/.mcp.json` | Current Project MCP |
| `~/.cursor/mcp.json` | Cursor MCP 設定 |
| `~/.claude.json` | Claude MCP・プロジェクト設定 |
| `~/.gemini/settings.json` | Gemini MCP 設定 |

**注意:**
- `~/.claude/projects/` や `logs_*.sqlite` は監視対象に含めない（大容量・高頻度）
- ファイル監視は `globPattern` を最小限に絞り、ホワイトリスト外を監視しない
- View が非表示になったら watcher、ポーリング、キャッシュを破棄する。再表示時に全件再走査する

---

## 10. ブラウザ拡張

### 10.1 画面構成

画面は toolbar action の popup 1 枚だけとする。ツールバーのアイコンから開き、検知時は
`chrome.action.openPopup()` を使う。開けない環境ではバッジだけを出す。専用タブや別ウィンドウは持たない。

### 10.2 オンボーディング

最初に popup を開いたとき、使う Agent だけを選んで導入先を許可する。スキップは
可能で、未設定の Agent を初めて選んだときにも同じ設定画面を出す。

```
AGENT TOOL

最初に導入先を設定します
選んだフォルダの配下だけへ書き込めます。

Claude Code  [導入先を選ぶ]
Cursor       [導入先を選ぶ]
Codex        [導入先を選ぶ]

[後で設定する]                         [完了]
```

- 「導入先を選ぶ」を押したときだけ `showDirectoryPicker({ mode: 'readwrite' })` を開く。
- 選択後はハンドルを IndexedDB に保存する。絶対パスは表示・検証できないため、選んだディレクトリ名だけを確認する。
- 検知時に popup を自動表示する設定は既定で ON。オンボーディングと設定画面で変更できる。

### 10.3 検知

- content script は対応する 3 サイトで候補を検知し、実在確認後に popup を開く。ページ上部の
  バナーや Shadow DOM の UI は表示しない。
- 同じタブ・同じ候補にはセッション中に 1 回だけ開く。
- 自動表示を OFF にした場合はアイコンのバッジだけを更新し、クリック時に候補を表示する。
- 収集一覧に**同じ GitHub リポジトリ**から入れた記録があり、許可済みのハンドルで実体を確かめられたものは
  バッジも自動表示も出さない。popup を開いたときだけ「導入済み」を出し、導入ボタンを隠す。
  許可が無く確かめられないときは通常の検知として出す。検知の側では収集一覧を書き換えない。
- 名前だけが一致するもの（別の取得元や IDE 拡張が入れたもの）は通常の検知として出す。上書きは導入時の確認が止める。
- **Skill が並ぶ置き場**（`.../tree/<branch>/skills`、カタログのリポジトリページ）を指された
  ときは、1 件ではなく**一覧**を出す。バッジには件数を出す。判定は `skillIndex`。

### 10.3.1 一覧（置き場を指されたとき）

```
┌─────────────────────────────────────────────┐
│ Skill  このフォルダの Skill 20 件            │
│ heygen-com/hyperframes/skills               │
│                                             │
│ 導入先  [ Claude Code            ▾ ]        │
│ ~/.claude/skills                            │
│ ─────────────────────────────────────────── │
│ embedded-captions      6 ファイル  [ 導入 ] │
│ faceless-explainer     4 ファイル  [ 導入 ] │
│ hyperframes-cli       11 ファイル  [ 導入 ] │
│ …                                           │
│                                  [ 今はしない ] │
└─────────────────────────────────────────────┘
```

- **まとめては入れない。** 行ごとに利用者が決める。入った行のボタンは「導入済み」にして
  押せないままにし、他の行はそのまま残す。
- 導入先は一覧の上で 1 回だけ選ぶ。置き場は全行で同じで、変わるのは名前だけである。
- 列挙は GitHub の tree API を **1 回**だけ使い、実体は `raw.githubusercontent.com` から
  ファイル単位で取る。アーカイブを落とさないので、取得上限を超える大きいリポジトリからも
  1 件ずつ入れられる（実測: 圧縮 116 MB のリポジトリから 104 KB だけを取る）。

### 10.4 導入フロー

```
1. 検知により popup が開く、またはツールバーのアイコンから URL を貼る
2. popup に候補を表示する
   ┌─────────────────────────────────────────────┐
   │ スキル「pdf」 — example/my-skills           │
   │ 説明文（frontmatter の description）         │
   │                                             │
   │ 導入先                                       │
   │   ● Claude Code      ~/.claude/skills       │
   │   ○ Cursor           （許可が必要です）      │
   │   ○ Codex            （許可が必要です）      │
   │                             [導入する]       │
   └─────────────────────────────────────────────┘
3. 未設定または失効した導入先を選んだら、ピッカーを開く前に OS 別の手順を出す
   「macOS では Cmd+Shift+. を押すと隠しフォルダが表示されます」
4. 導入先ルートそのものを選ぶ → 選択したディレクトリ名を確認 → IndexedDB に保持
5. 以後の導入は Agent 選択 → [導入する] だけで、ピッカーを開かない
6. 取得・展開（進捗表示）
7. 同名があれば上書き確認
8. 完了 → 収集一覧に追加
```

- その種別に対応するエージェントは常に全て並べ、許可済みかどうかを注記で示す。
  選択肢が毎回同じで、初回に何ができるかが分かる。
- Gemini CLI は MCP だけを対象にするため現れない。Codex は Skill だけに現れる。
- popup を閉じる操作はキャンセルとして扱い、取得・展開の中途状態を残さない。

### 10.5 削除

収集一覧から、自分が入れ、導入時の実体ツリー SHA-256 と一致するものだけ削除できる。
手動変更されたものは削除せず、変更されたためブラウザ拡張では削除できないと表示する。
確認ダイアログは IDE 拡張の 5.1 と同じく、取り消せないことを示す。

### 10.6 エラー表示

| 状況 | 表示 |
|---|---|
| ディレクトリ許可が失効した | 「もう一度許可してください」と再許可ボタン |
| 選ばれた場所が想定と違う | 絶対パスは得られないため、選択したディレクトリ名を示し、導入先ルートを選び直すよう求める |
| 取得が上限を超えた | 上限値と実測値を示して中止する |
| 実在確認が通らない | popup を開かない。利用者には何も見せない |
| Plugin のページを見ている | 何も出さない（ブラウザ拡張は Plugin を扱わない） |

パス・コマンド・差分は IDE 拡張と同じく verbatim で表示する。
