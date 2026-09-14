---
description: main へ入れる前に、変更一式をこのリポジトリ固有の観点でレビューする
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(npm run:*), Bash(./scripts/check-invariants.sh), Bash(./scripts/release-changelog.sh:*), Bash(./scripts/test-release-changelog.sh)
---

# マージ前レビュー

`main` へ入れる前に、変更一式を**このリポジトリ固有の観点で**レビューする。
汎用の指摘ではなく、**ここで壊れると実ユーザーのデータが飛ぶ**箇所を優先して見る。

対象は `git diff main...HEAD`（ブランチ全体）。ファイル単位ではなく**変更の意図**を見る。

## レビュー対象

- ブランチの差分: !`git diff --stat main...HEAD 2>/dev/null || echo "(main 上。未コミット分を見る)"`
- 未コミット: !`git status -s`

## 1. 不変条件（最優先・機械検査と同じ観点）

まず走らせる:

```bash
./scripts/check-invariants.sh
```

緑でも、**検査の許可リストを広げていないか**を目で確認する。
許可リストへの追加は「なぜユーザーの資源ではないのか」が
スクリプト内のコメントで説明できていなければ**不合格**。

| 観点 | 落ちる条件 |
|---|---|
| 設定ファイルの書き込み | `PermissionWriter` / `Registry` / `MCPScanner` 以外で書いている。`~/.claude.json` を読んで書き戻している |
| 削除・移動 | `WriteGuard.assertMutable` を通らずに `removeItem` / `moveItem` している |
| ホワイトリスト走査 | `Source` の列挙にないパスを読んでいる。`projects` / `sessions` を一覧スキャンから読んでいる |
| View 非表示で解放 | watcher / ポーリング / CLI キャッシュが View 非表示後も残る |
| 破壊的操作の可逆性 | 無効化が「退避」ではなく「削除」になっている。権限削除でバックアップを取っていない |

## 2. ストレージ・メモリ

- **無駄なファイルを作っていないか。** 可変メタデータは `registry.json` だけ。
  管理対象実体以外のキャッシュ・ログ・Undo スナップショットを足していないか
- `URLSession` が `.ephemeral` のままか
- ダウンロード・zip展開・stagingがTypeScriptの`finally`で確実に消えるか。
  **失敗経路とキャンセル経路も**通るか
- 大きいファイルを `Data` で丸ごとメモリに載せていないか
- 一覧のために本文まで読んでいないか（frontmatter は先頭 4 KB）
- 役割の重なるスクリプト・ドキュメントを新設していないか

## 3. 正しさ

- **偽ホームで完結しているか。** 新しいテストが実ユーザーの `~/.claude` に触れていないか
  （`Environment.test(home:)` を使っているか）
- 空白を含むパスで動くか（App Support は必ず空白を含む。`path(percentEncoded: false)`）
- symlink のリンク切れを「有効」と表示していないか
- 「非対応」「未検出」「未集計」「未使用」を同じ見た目に潰していないか。
  **消してよいものと消してはいけないものが区別できなくなる**
- 失敗を握り潰していないか。UI に出ているか
- 新しい判定ロジックが純粋関数として切り出され、テストされているか

## 4. ローカライズ

- 追加した文言が `ja` / `en` の**両方**にあるか
- `String` を返す計算プロパティで `String(localized:)` を使っているか
- 引数 2 つ以上の文言で、英語側が positional（`%1$@` / `%2$lld`）か
- 翻訳対象でないもの（差分本文・パス・コマンド）が `Text(verbatim:)` か

## 5. 配布への影響

`package.json` / `scripts/` / `.github/workflows/` を
触っている場合のみ:

- `package.json`の`engines.vscode`とCIのNode 24 LTSが仕様と一致するか
- CI とローカルで**同じスクリプト**を呼んでいるか（CI 専用ロジックを足していないか）
- `README.md` と `README.ja.md` の**両方**を更新したか
- Universal CLI の両arch、VSIX 20 MB上限、Open VSX→GitHubの公開順を壊していないか
- CLI・VSIX組み立て・配布経路を変えた場合、配布VSIXからの初回CLI起動を実機確認したか

## 6. 過剰実装

`/ponytail:ponytail-review` を回す。ただし**採用しない指摘**:
不変条件・入力検証・エラー処理・アクセシビリティ・可逆性を削るもの。

加えて目視で:

- 実装が 1 つしかないものに protocol / interface を切っていないか（DESIGN 3.6）
- 使われていないコード・設定・ファイルが残っていないか

## 7. ドキュメント

- 仕様が変わったのに `docs/agent-tool-*.md` が古いままになっていないか
- READMEの日英版が同期しているか
- 利用者に見える変更なのに `CHANGELOG.md` の `[Unreleased]` に項目が無いか
  （**英語**で書く。版見出しへは移さない）

## 8. 完了の定義

```bash
npm run typecheck && npm test
./scripts/check-invariants.sh
./scripts/release-changelog.sh --check && ./scripts/test-release-changelog.sh
```

`package.json`が定めるNodeテスト・型検査・VSIX組み立ても実行する。

## 出力

**合格 / 要修正**をはっきり述べる。要修正なら、指摘ごとに
`ファイル:行` ・ 何が問題か ・ どう直すか を 1 項目 1〜2 行で挙げ、
**重大なもの（不変条件・データ損失）から順に**並べる。

自動テストできない箇所（稼働中エージェントへの反映、配布VSIX内の未署名CLI初回起動）に触れる変更なら、
**実機で確認すべき項目**を併せて挙げる。
