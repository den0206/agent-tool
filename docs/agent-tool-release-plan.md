# Agent Tool — リリース計画

## 現在の構成

- 拡張機能と管理ロジックは TypeScript で実装する。
- `ide/` `browser/` `core/` に分け、`test/` はルートに集約する。
- ルートの `package.json` は 1 つ。ブラウザ拡張は `browser/manifest.json` を持つ。
- VSIX は Node.js 依存だけを含み、サイズ上限は 20 MB とする。
- `scripts/` にローカルと CI で共通の検査スクリプトを置く。

IDE拡張とブラウザ拡張は同じ版で配布する。`release/Ver_X.Y.Z` の push で両方を組み立て、
VSIX、ブラウザzip、それぞれのSHA-256を同じGitHub Releaseへ添付する。

`CHANGELOG.md` は 1 つに保つ。

## Beta 機能の撤去

Beta として同梱している機能（現在は Jev 補助の手動検知。`docs/agent-tool-security.md` §10.5）は、
**撤去できる形で入れる**ことを条件に同梱する。撤去するときは次の順で行う。

### 1. 利用者のデータを消す版を先に出す

**いちばん見落としやすいのはここである。** 拡張の更新では `chrome.storage.local` は消えない
（消えるのは利用者が拡張を削除したときだけ）。機能のコードだけ消すと、**Jev API key が
誰も読まないまま利用者のブラウザに残り続ける**。

撤去版の service worker の起動時に 1 回だけ次を実行し、次の版まで残す。

```ts
// 撤去した Beta 機能が残した鍵と設定を回収する。1 版だけ置いて、次の版で消す。
void chrome.storage.local.remove(["jevApiKey", "jevEnabled"]);
```

`chrome.storage.local` を使う機能が他に無くなったら、`permissions` から `storage` を外すのは
**この回収版の次の版**にする。権限を先に外すと回収コードが動かない。

### 2. コードと設定を外す

| 対象 | 何をするか |
|---|---|
| `browser/jev.ts` `browser/aiDetect.ts` `browser/aiSettings.ts` `browser/pageEvidence.ts` | 削除 |
| `browser/tab.ts` `browser/tab.html` `browser/tab.css` | スキャンのカードと設定欄、`ai*` の分岐を外す |
| `browser/manifest.json` | `activeTab` / `scripting` / `storage`、`host_permissions` の `api.typesafe.ai` を外す |
| `scripts/check-browser-package.mjs` | 許可リストから同じ権限を外す（**広げた許可は必ず戻す**） |
| `browser/_locales/{en,ja}` | `ai*` のキーを両方から外す |
| `test/jev.test.js` `scripts/test-browser-jev.mjs` | 削除。`package.json` の `test:browser` から外す |
| `.claude/skills/diagnose-jev-page/` | 削除。`diagnose-tool-page` の振り分けを 1 つに戻す |

`core/` は触らない。Jev 固有の型を `core/` へ漏らしていないので、決定論的経路は独立して残る。

### 3. 対外的な記載を戻す

- `PRIVACY.md` の TypeSafe の節と権限の説明、`docs/browser-store-listing.md` のデータ使用開示
- ストアの権限申告（**権限が減る方向の更新は審査で問題にならない**。増やすときだけ理由が要る）
- `README.md` と `README.ja.md`（英日同時）、`docs/product-requirements.md`
- `CHANGELOG.md` の `[Unreleased]` に、撤去したことと鍵を消したことを英語で 1 行

### 4. 確認

`./scripts/check-invariants.sh` と `npm run package:browser` を通し、組み立てた
`vsix/browser/manifest.json` に外した権限が残っていないことを目で見る。
実機では、鍵を登録した状態の版から撤去版へ更新し、`chrome.storage.local` が空になることを
`chrome://extensions` のサービスワーカーのコンソールで確認する。

## リリース前の確認

```bash
npm run typecheck
npm test
./scripts/check-invariants.sh
./scripts/release-changelog.sh --check
./scripts/test-release-changelog.sh
npm run package
npm run package:browser
```

Cursor Stable の E2E を実行し、VSIX のサイズが 20 MB 未満であることも確認する。

## 配布

1. `release/Ver_<semver>` ブランチで検査を通す。
2. push時に `.github/workflows/release.yml` が検査し、`package.json` と `browser/manifest.json` を
   ブランチ名と同じ版へそろえ、VSIXとブラウザzipを一度だけ組み立ててSHA-256を記録する。
3. 安定版は `OVSX_PAT` が設定されている場合だけOpen VSXに公開する。
4. VSIX、ブラウザzipとそれぞれのSHA-256を同じGitHub Releaseに添付する。

Open VSX の公開を実行して失敗した場合は、Workflowを停止してGitHub Releaseを作らない。alpha / betaはGitHub Releasesだけに公開する。

## ブラウザ拡張の配布

**最初の配布先は Chrome Web Store とする。** Chrome の公開で Chrome と Brave の利用者へ
案内でき、承認済みの同じ zip を Edge Add-ons にも提出できる。各ストアの審査はそれぞれ受ける。
自前のダウンロードページは持たない。

1. `release/Ver_<semver>` ブランチを push する。workflow が `browser/manifest.json` も同じ版へ更新し、
   `vsix/agent-tool-browser.zip` を同じGitHub Releaseへ添付する。
2. Chrome の `CHROME_CLIENT_ID`、`CHROME_CLIENT_SECRET`、`CHROME_REFRESH_TOKEN`、
   `CHROME_PUBLISHER_ID`、`CHROME_EXTENSION_ID` がすべてGitHub Secretsにあれば、workflowが
   Chrome Web Storeへzipをアップロードして申請する。1つでも未登録ならこの申請だけをスキップする。
   初回はDeveloper Dashboardで2段階認証、ストア掲載、Privacy / Distributionを設定する。
3. Chrome の承認後、同じzipを Edge Add-ons へ Partner Center から提出する。初回の製品作成と掲載情報の設定もここで行う。
4. Brave は Chrome Web Store からの導入を案内し、Chrome と同じ zip を手動確認する
   （`brave://flags` で File System Access API を有効化する案内は拡張内の文言が持つ）。

Edge Add-ons の自動申請は今後行う。Chrome 承認後だけ実行できる明示的なゲートと、Edge の
package upload / publish の両方を完了まで確認する処理を備えてから戻す。

ストア審査は `host_permissions` の用途説明を求められる。要求するのは github.com /
skills.sh / agentsdirectory.dev の 3 つだけで、`<all_urls>` は要求しない。
用途説明とプライバシー診断の回答は [`docs/browser-store-listing.md`](browser-store-listing.md)
に、公開するプライバシーポリシーは [`PRIVACY.md`](../PRIVACY.md) に用意している。

Chrome Web Store APIの呼び出し自体が失敗すると、Open VSX公開とGitHub Releaseの前にworkflowを失敗させる。
各ストアの審査は非同期であり、申請後の審査却下を他方のストアから自動で取り消すことはできない。
