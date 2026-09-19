<p align="center">
  <img src="media/icon.png" width="160" alt="Agent Tool アイコン">
</p>

**Skillを見つけて、かんたん導入！**

# Agent Tool

[![CI](https://github.com/den0206/agent-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/den0206/agent-tool/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/den0206/agent-tool?include_prereleases&sort=semver)](https://github.com/den0206/agent-tool/releases)
[![Open VSX](https://img.shields.io/open-vsx/v/yuuki-sakai/agent-tool)](https://open-vsx.org/extension/yuuki-sakai/agent-tool)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agent Toolは、同じ検知・導入ロジックを共有する2つの拡張からなります。AIコーディングエージェントのSkill、Subagent、Rule、MCPサーバー、Pluginを横断管理する**[Cursor / VS Code拡張](#ide拡張)**と、ブラウザで見つけたSkillとSubagentをページを離れずに導入する、Chrome / Edge / Brave向けの**[ブラウザ拡張](#ブラウザ拡張)**です。

### IDE拡張([Cursor](https://open-vsx.org/extension/yuuki-sakai/agent-tool))

<p align="center">
  <img src="media/demo.gif" width="1200" alt="IDE拡張でPluginを導入する動作">
</p>

### ブラウザ拡張([Chrome](https://chromewebstore.google.com/detail/agent-tool/allbohfeiidaiemnagikcghaialfafhp))

#### 自動検知

<p align="center">
  <img src="media/auto-detect-browser.png" width="720" alt="対応ページでSkillを検知して自動的に開いたAgent Toolのポップアップ">
</p>

#### 入力検知

<p align="center">
  <img src="media/input-detect-browser.png" width="720" alt="skills.shの対応URLをAgent Toolの入力欄へ貼り付ける画面">
</p>

## 概要

コーディングエージェントが使うリソースを、1つの場所から確認・管理できます。IDE拡張は各エージェントが対応する配置場所を走査し、エージェントが所有する操作は公式CLIへ委譲します。ブラウザ拡張は、利用者が自分で選んだフォルダの中だけに書き込みます。

## 主な機能

- Skill、Subagent、Rule、MCPサーバー、Pluginを1つのダッシュボードで確認
- GitHubと対応カタログからSkill / Subagentを導入
- GitHubサブディレクトリ内のPluginを含むClaude Code / Codex Pluginの導入
- 説明、場所、スコープ、有効状態、更新の確認
- 管理対象ファイルをコピーせず、ユーザー領域とプロジェクト領域を管理
- Chrome / Edge / Brave の拡張から、ブラウザで見つけたSkillとSubagentをそのまま導入 — IDE拡張は不要
- **Beta:** 任意で自分のJev APIキーを登録し、未対応サイトを手動解析してGitHub由来のSkill / Subagent候補を探せる。登録して有効にするまで動かず、既存の対応サイトではJevを使わず従来の決定論的検知を維持する。今後の版で変更・撤去することがある
- macOS / Linux / Windowsで動作

## 対応サイト

次のサイトのURLを拡張のURL欄に貼り付けられます。

| サイト                                           | URLの例                                               | 取得元の決め方                                                                 |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| [GitHub](https://github.com/)                    | `https://github.com/owner/repo/tree/main/skills/pdf`  | URLから決まります。                                                            |
| [skills.sh](https://skills.sh/)                  | `https://skills.sh/anthropics/skills/frontend-design` | URLから決まります（パスに`owner/repo`を含みます）。                            |
| [Agents Directory](https://agentsdirectory.dev/) | `https://agentsdirectory.dev/skills/frontend-design/` | ページを1回読み、schema.orgのJSON-LDメタデータだけからリポジトリを特定します。 |

サイトは`core/github.ts`の`CATALOG_SITES`で宣言します。両方の拡張がここを読むので、1エントリで両方に届きます。ブラウザ拡張はこれに加えてmanifestへホストを足す必要があります。ページのHTMLは走査しません。URLに`owner/repo`を含まないサイトは、JSON-LDの`codeRepository`または`url`を公開している必要があります。

## IDE拡張

Cursor / VS Code 向けの拡張です。対応する配置場所を走査して1つのTree Viewに表示し、導入、削除、有効化、更新は利用できる場合に各エージェントのCLIへ委譲します。

### 必要環境

- Node.js 20以降に対応するCursorまたはVS Code
- 確認・管理したいエージェントのCLI（Claude Code、Codexなど）
- リモート取得またはPlugin Marketplace登録時のインターネット接続

### インストール

[GitHub Releases](https://github.com/den0206/agent-tool/releases)から`.vsix`ファイルをダウンロードし、次のコマンドでインストールできます。

```bash
code --install-extension agent-tool-X.Y.Z.vsix
# または Cursor で: cursor --install-extension agent-tool-X.Y.Z.vsix
```

拡張機能ビューの「VSIXからのインストール…」も使えます。安定版は[Open VSX](https://open-vsx.org/extension/yuuki-sakai/agent-tool)にも公開します。

### 使い方

1. CursorまたはVS CodeでAgent Toolを開き、Activity Barから起動します。
2. ダッシュボードのユーザー全体・プロジェクト欄を確認します。
3. 追加操作から、[対応サイト](#対応サイト)のGitHubまたはカタログURLを貼り付けます。
4. 検出されたSkill、Subagent、Rule、MCP、Pluginを選び、操作を確認します。
5. 再走査やリモート更新の確認には更新操作を使います。

Pluginの導入はClaude CodeまたはCodexへ委譲します。Claude CodeではMarketplaceを登録してからPluginを導入します。

<p align="center">
  <img src="media/demo.gif" width="1200" alt="IDE拡張でPluginを導入する動作">
</p>

## ブラウザ拡張

Chrome、Edge、Brave向けの拡張です。[対応サイト](#対応サイト)を閲覧中にSkillとSubagentを検知し、ページを離れずに導入します。IDE拡張は不要ですが、併用時は次回の走査で導入済みの項目をIDE拡張でも管理できます。

### 必要環境

- Chrome、Edge、またはBrave（BraveはFile System Access APIを既定で無効にしているため、拡張が`brave://flags`での有効化手順を案内します）
- 初回導入時に選択するエージェントの設定ディレクトリ

### インストール

最初の公開先はChrome Web Storeです。公開前は、次のコマンドで組み立てて手元で読み込めます。

```bash
npm run package:browser
```

`vsix/browser/`が作成されます。`chrome://extensions`（Edge / Braveでは対応する拡張管理ページ）で**デベロッパーモード**を有効にし、**パッケージ化されていない拡張機能を読み込む**からこのフォルダを選択してください。同時に作られる`vsix/agent-tool-browser.zip`は、`release/Ver_<semver>`でVSIXと同じGitHub Releaseへ添付し、Chrome Web StoreとEdge Add-onsへ提出するファイルです。

### 使い方

1. GitHub、skills.sh、Agents DirectoryのSkillまたはSubagentページを開きます。検知するとポップアップが自動で開きます。`github.com/<owner>/<repo>/tree/<branch>/skills`のようにSkillが並ぶフォルダや、カタログのリポジトリページを開くと、一覧を出して1件ずつ導入できます。

   <p align="center">
     <img src="media/auto-detect-browser.png" width="720" alt="対応ページでSkillを検知して自動的に開いたAgent Toolのポップアップ">
   </p>

   自動表示を使わない場合は、**設定**からオフにできます。

2. または拡張アイコンを開き、対応URLを直接貼り付けます。先に対象ページを開く必要はありません。

   <p align="center">
     <img src="media/input-detect-browser.png" width="720" alt="skills.shの対応URLをAgent Toolの入力欄へ貼り付ける画面">
   </p>

3. ドロップダウンから対象エージェントを選び、**Install**を押します。初回はブラウザのフォルダ選択画面で設定ディレクトリ（`~/.claude`、`~/.cursor`、`~/.codex`、または共有の`~/.agents`）を選択します。選択は以後も使われます。
4. 未対応サイトでは、任意で**設定**にJev APIキーを登録して**AIによる検出（Beta）**を有効にできます。キーを保存するまでトグルは押せず、**削除**でいつでも消せます。その場合だけ「このページからToolを探す」が表示され、クリックした現在タブを一時的に解析します。TypeSafeへ送るのは候補リンク・導入コマンド断片・限定したページ文脈だけで、選択後も既存のGitHub実在確認を通してから通常の導入画面へ進みます。
5. **設定**では導入済み一覧の確認・削除、フォルダ権限の再付与、ポップアップテーマ（System / Light / Dark）の変更ができます。

### プライバシー

- 書き込むのは、File System Access APIを通じて利用者が選んだフォルダだけです。`<all_urls>`は要求しません。
- 閲覧URLは保存しません。ディレクトリハンドル、導入済み一覧、UI設定はローカルに保持し、任意のJev APIキーと有効化設定はcontent scriptから読めないよう制限した拡張ストレージへ保存します。
- Jevへの通信は未対応ページで利用者が明示的に解析した場合だけです。HTML全文、フォーム入力値、Cookie、閲覧履歴は送りません。
- 取得元は書き出したファイルの隣に記録します。IDE拡張を併用している場合、次回の走査で取り込まれ、ダッシュボードから削除・更新できます。
- 詳細は[`PRIVACY.md`](PRIVACY.md)を確認してください。

## 開発

Node.js 24 が必要です（CI と揃えています。`engines.node` は `>=20` のままなので Node.js 20 でもビルドできます）。

```bash
npm ci
npm run check          # 型検査・テスト・不変条件検査
npm run package         # IDE拡張 → vsix/agent-tool.vsix
npm run package:browser # ブラウザ拡張 → vsix/agent-tool-browser.zip
```

拡張のキャッシュはメモリだけに保持します。IDE拡張の可変メタデータはCursorの`globalStorageUri`に置く`registry.json`だけとし、一時ダウンロード・展開物は成功・失敗を問わず削除します。ブラウザ拡張が永続化するのはIndexedDBのディレクトリハンドル、導入済み一覧、2つの設定だけです。詳しくは[プライバシー](#プライバシー)を参照してください。

CursorまたはVS CodeでF5を押すと、拡張機能開発ホストを起動できます。

### 任意の実サイト確認

CIには入れない任意スクリプトが1つあります。カタログ側の障害で`npm test`を落とさないためです。

```bash
npm run test:browser
```

2段階で走ります。(1) 対応カタログから URL を1本ずつ引き、検知〜取得まで通す。(2) 組み立て済みの`vsix/browser/`をPlaywrightでChromiumに読ませ、各カタログURLを開いたときにツールバーバッジが埋まることを確かめる。初回だけChromiumバイナリ（約78 MiB）を落とし、2回目以降はダウンロードを飛ばします。スクリプトが取得ステップを内包しているため事前準備は不要です。ディスプレイが無い環境では`xvfb-run -a`で包んで実行します。

## リリース

**IDE拡張:** `release/Ver_X.Y.Z`という名前のブランチを作成してpushします。GitHub Actionsが検査を実行し、VSIXを1回だけ生成してSHA-256を記録し、GitHub Releaseへ添付します。`OVSX_PAT` Secretを設定した場合、安定版はOpen VSXにも公開します。

**両方の拡張:** `release/Ver_<semver>`をpushします。GitHub Actionsが`package.json`と`browser/manifest.json`を同じ版にそろえ、検査、VSIXとブラウザzipの組み立て、SHA-256の記録、1つのGitHub Releaseへの添付を行います。安定版は`OVSX_PAT`を設定していればOpen VSXにも公開します。Chrome Web Storeへの申請は必要なSecretsがすべて設定されている場合だけ自動実行し、Chromeの承認後に同じzipをEdge Add-onsへ手動提出します。提出文面と公開順は[`docs/browser-store-listing.md`](docs/browser-store-listing.md)と[リリース計画](docs/agent-tool-release-plan.md#ブラウザ拡張の配布)を参照してください。

## ドキュメント

- [プロダクト要件](docs/product-requirements.md)
- [設計決定](docs/vscode-cursor-extension-design-questions.md)
- [モジュールAPI](docs/agent-tool-cli-api.md)
- [ストレージと移行](docs/agent-tool-data-spec.md)
- [セキュリティ](docs/agent-tool-security.md)
- [テスト計画](docs/agent-tool-test-plan.md)
- [リリース計画と進捗](docs/agent-tool-release-plan.md)
- [ブラウザ拡張ストア提出文面](docs/browser-store-listing.md)
- [プライバシーポリシー](PRIVACY.md)

## ライセンス

[MIT](LICENSE)

[English](README.md)
