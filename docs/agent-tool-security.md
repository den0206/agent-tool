# Agent Tool — セキュリティ要件

> 設計の前提は [vscode-cursor-extension-design-questions.md](vscode-cursor-extension-design-questions.md) を参照。
> WriteGuard の実装詳細は [agent-tool-data-spec.md](agent-tool-data-spec.md) を参照。

---

## 1. 脅威モデル

Agent Tool が守る対象:

| 資産 | 脅威 |
|---|---|
| `~/.claude/`・`~/.cursor/` 配下の設定ファイル | 不正な上書き・削除 |
| `registry.json` | 破損・競合書き込み |
| ユーザーの認証情報（`auth.json` 等） | 誤削除・漏洩 |
| MCP サーバー設定（`mcp.json`） | 不正な書き換え |
| プロジェクト外ファイル | path traversal による到達 |

信頼しない入力源:

- GitHub リポジトリの frontmatter（`name` フィールドが `../` を含む可能性）
- ユーザーが貼り付けた URL
- MCP サーバーの出力（`stdout` / `stderr`）

---

## 2. WriteGuard 不変条件（現行と同等を維持）

Skill / Subagent の実体とリンクに対する書き込み・削除は、すべて `writeGuard.ts` を通す。
`registry.json` は `registry.ts`、`mcp.json` は `mcpScanner.ts` が扱う（§3）。この 3 ファイル以外は `node:fs` の書き込み系 API を呼ばない。
ブラウザ拡張が残した取得元の台帳の削除も `writeGuard.ts` の専用パスを通す（§2.2.2）。

### 2.1 名前検証（`assertValidName`）

取得物の名前（frontmatter の `name`）をパス要素に使う前に検証する:

```
拒否条件:
  - 空文字列 / 256 バイト超
  - "." または ".."
  - "." で始まる（隠しファイル）
  - "/" または "\" を含む
  - ":" を含む
  - 制御文字（改行・NUL 等）を含む
  - 拒否ファイル名リストに一致する
```

### 2.2 削除・移動ガード（`assertMutable`）

許可条件（どちらか一方を満たすこと）:

1. **自分が張ったリンク** — リンク先が `managedRoots` の配下である
   （macOS / Linux は symlink、Windows は junction / hardlink。hardlink は
   `fs.stat` の `ino` がストア内実体と一致することで判定する）
2. **registry.json に記録された実体** — `managedRoots` または退避ディレクトリの配下にある

二重ガード: ホワイトリストを通過しても `deniedNames` / `deniedExtensions` で拒否する。

### 2.2.1 プロジェクト内の実体（`assertProjectArtifact`）

project スコープの実体は `managedRoots` の外（ワークスペース内）にあるので `assertMutable` は通らない。
代わりに置き場で決める:

- `<workspace>/.claude/skills` または `<workspace>/.claude/agents` の**直下**にあること
- 信頼の根はワークスペース。そこまでの経路にワークスペース外を指すリンクが無いこと（`assertSafeCreation`）
- 隠しファイル・拒否ファイル名・同梱ルートは `assertUserArtifact` と同じく拒否する

`apps/web:deploy` のような修飾名はサブディレクトリのもので直下ではない。`assertValidName` が `:` を
拒否するため、そもそも作成・削除の対象にならない（一覧では `isManageable` が false になる）。

### 2.2.1.1 取り込んだ実体（`assertRecordedArtifact`）

ブラウザ拡張が書いた実体は自分が許可されたルート（`~/.claude/skills` など）にあり、
`managedRoots` の外なので `assertMutable` は通らない。registry の `Entry.root` が
その場所を記録しているので、置き場と registry の 2 つで許す:

- `userRoots` の**直下**にあること（`assertUserArtifact` と同じ条件。リンクは辿らない）
- 同じ名前・種別が `registry.json` に載っていること

`assertBody` が置き場で 3 つを振り分ける。呼び出し側に分岐を持たせない
（経路が増えたときに片方だけ検査が漏れるのを防ぐ）:

| 実体の場所 | 通すガード |
|---|---|
| ワークスペース内 | `assertProjectArtifact` |
| `managedRoots` の配下 | `assertMutable` |
| それ以外（`Entry.root` が記録したルート） | `assertRecordedArtifact` |

### 2.2.2 取得元の台帳（`assertLedger`）

ブラウザ拡張が残した `<導入先ルート>/.agent-tool/<name>.json` を、取り込み後に削除する。

- 親ディレクトリが走査ホワイトリスト上のルート直下の `.agent-tool` であること
- ファイル名が `<name>.json` で、`<name>` が `assertValidName` を通ること
- 実体（`<name>/` または `<name>.md`）が同じルートに存在すること
- 削除するのは台帳ファイル 1 件だけ。`.agent-tool` ディレクトリごとの再帰削除は行わない

台帳が指す実体そのものには触れない。取り込みで消えるのは台帳だけである。

### 2.3 作成ガード（`assertSafeCreation`）

作成先の親ディレクトリに含まれる symlink / junction が管理ルート外を指していないか検査する。
`~/.claude -> /outside` のような付け替えで管理外への書き込みを防ぐ。

### 2.4 拒否リスト（変更なし）

```
ファイル名: auth.json, oauth_creds.json, settings.json,
           settings.local.json, .claude.json, config.toml, mcp.json

拡張子:     sqlite, sqlite-wal, sqlite-shm
```

`mcp.json` 自体は拒否リストに入っているが、`MCPManager` は JSON を安全に編集する専用パスを持つ。
直接の `removeItem` / `copyItem` は通らない。

---

## 3. 書き込み権限の制限

| 操作 | 書き込み主体 | 禁止事項 |
|---|---|---|
| Skill / Subagent の追加・削除・更新 | `writeGuard.ts` 経由のみ | `writeGuard.ts` の外から `fs.writeFile` / `fs.rename` しない |
| MCP 設定の追加・削除 | `mcpScanner.ts` の専用パスのみ | `mcp.json` の直接上書き禁止 |
| `registry.json` の書き込み | `registry.ts` のみ | 他モジュールは `registry.ts` の API 経由で読み書きする |
| 取得元の台帳の削除 | `writeGuard.ts` の専用パスのみ | 台帳が指す実体には触れない。`.agent-tool` の再帰削除をしない |
| 一時ファイル | `try/finally` で確実に削除 | 残骸を残さない |

全操作の `storagePath` は絶対パスとして検証する。破壊的操作では `selector.sourcePath` を
直接信用せず、最新インベントリと照合して1件に確定してから WriteGuard を通す。

---

## 4. 未信頼ワークスペース

VS Code の `workspace.isTrusted` が `false` の場合:

- **許可**: `inventory` コマンドによる一覧取得（読み取りのみ）
- **禁止**: `add` / `remove` / `update-apply` / `mcp-add` / `mcp-remove`
- UI: 書き込みボタンを無効化し、信頼バナーを表示する（[UI 設計 8.2](agent-tool-ui-design.md#82-未信頼ワークスペース) 参照）

---

## 5. Remote 環境

`vscode.env.remoteName` が非 null（SSH / Dev Container / Codespaces）の場合:

- **一覧表示は許可する**。既知の走査対象を読み取り専用で表示する
- **書き込み操作はすべて拒否する**。追加・削除・更新適用などはローカルウィンドウでのみ行う
- `inventory` には `writable: false` を渡し、台帳の取り込みや entry の除去など走査中の副作用も止める
- UI: Remote の一覧は read-only バナーを表示し、変更操作は実行時にも拒否する
- この方針は [UI 設計 8.1](agent-tool-ui-design.md#81-remote-環境)、`product-requirements.md`、`CLAUDE.md` の「Remote では書き込みを行わない」と揃える

---

## 6. プロセス間ロック

複数 Cursor ウィンドウの同時書き込みを防ぐ:

- **方式**: `fs.openSync(lockPath, 'wx')` の `O_EXCL` フラグで原子的にロックファイルを生成する
- **タイムアウト**: 10 秒。50 ms ポーリングで再試行し、超過したら `LOCK_TIMEOUT` エラーを返す
- **解放**: 正常終了時は `fs.unlinkSync(lockPath)`。クラッシュで残った stale ロックは mtime が 30 秒超なら削除して再試行する
- **npm `proper-lockfile` は使わない**（Windows でのプロセス死活確認の挙動差を避けるため）

```typescript
// registry.ts 内の実装イメージ
async function withRegistryLock<T>(storagePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(storagePath, 'registry.lock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // stale ロック判定（30秒超）
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) { fs.unlinkSync(lockPath); continue; }
      } catch {}
      if (Date.now() >= deadline) throw new AgentToolError('LOCK_TIMEOUT', 'Registry lock timeout');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try { return await fn(); }
  finally { try { fs.unlinkSync(lockPath); } catch {} }
}
```

---

## 7. HTTP 応答のシークレットマスク

`fetch()` の応答テキストは 2 MB で打ち切り、ユーザーへ表示する前に以下のパターンを置換する:

```
--token <value>       → --token [REDACTED]
Authorization: ...    → Authorization: [REDACTED]
Bearer <value>        → Bearer [REDACTED]
```

- raw レスポンスボディはメモリ上でのみ処理し、ディスクに書かない
- エラー通知が閉じたらマスク済み要約も破棄する
- 永続ログは作らない

---

## 8. ダウンロード・取得

- **公開リポジトリのみ・未認証**（初版スコープ）
- `fetch()` に `cache: 'no-store'` を指定する（HTTP キャッシュファイルを生やさない）
- ダウンロード先は `path.join(os.tmpdir(), 'agent-tool-fetch-<uuid>')` とし `try/finally` で削除する
- アーカイブは tar.gz で取り、展開は `core/archive.ts` の `readTarGz` だけで行う。
  エントリ名は `safeSegments` で検証し、取り出したものには `assertValidName` を適用してから移動する
- GitHub API 応答は 2 MB、アーカイブは 50 MB、展開後は 200 MB、単一ファイルは 20 MB で打ち切る
- アーカイブはメモリへ全量保持せず、`ReadableStream` から 1 エントリずつ一時領域へ流す

---

## 9. 拡張の権限スコープ

`package.json` で要求するパーミッション（VS Code Extension Manifest）:

```json
{
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "未信頼ワークスペースでは一覧表示のみ利用できます"
    },
    "virtualWorkspaces": false
  },
  "extensionKind": ["ui"]
}
```

- `extensionKind: ["ui"]` — ローカル UI Extension として動作。Remote Host では起動しない
- `capabilities.untrustedWorkspaces.supported: "limited"` — VS Code 自身にも未信頼時の制約を宣言し、runtime guard と二重化する
- `capabilities.virtualWorkspaces: false` — ファイルシステム前提の操作を virtual workspace へ広げない
- ネットワークアクセス: IDE 拡張は GitHub API（公開エンドポイント）のみ。認証情報を送らない。
  ブラウザ拡張だけは、利用者が明示的に有効化して実行したときに限り `api.typesafe.ai` へ
  利用者自身の API key を送る（§10.5）
- テレメトリ: 一切収集しない

### 9.1 外部コマンドの起動（`exec.ts`）

外部コマンドはプロセス一覧取得・PATH 解決・各エージェント CLI への委譲だけに使う。
起動コマンドと引数は貼り付けられた JSON 由来なので、シェルに解釈させない。

- macOS / Linux は引数配列のまま `spawn` する。シェルを経由しない
- Windows は `.cmd` / `.bat` を起動するため `cmd.exe /d /s /c` を経由する。
  `shell: true` は使わない（Node はそのとき引数を空白で連結するだけでクォートせず、
  `-H "Authorization: Bearer a b"` が 4 引数に割れる）。`cmdLine` が各トークンを
  クォートし、`windowsVerbatimArguments` で Node の再クォートを止める
- 引用符で無力化できない文字（`%` `!` `"`・改行・NUL）を含むコマンドは実行しない。
  `& | < > ^ ( )` と空白はクォートして通す（MCP の URL の `&` や、空白を含む
  ヘッダ値は実在する）
- 出力は各 2 MB、実行は 180 秒で打ち切る。失敗メッセージの引数は `redact` を通す

---

## 10. ブラウザ拡張

### 10.1 信頼境界

ブラウザ拡張はファイルシステムへの既定の到達権を持たない。書けるのは、利用者が
`showDirectoryPicker()` で選んで許可したディレクトリの配下だけである。

| 資産 | 守り方 |
|---|---|
| 許可外のディレクトリ | ハンドルを持たないため到達できない |
| ホームディレクトリ直下 | Chromium が選択を拒否する（`kDontBlockChildren`） |
| `~/Library`（macOS）・システム領域 | Chromium が全面的に拒否する |
| 利用者が自分で置いた実体 | 導入時の実体ツリー SHA-256 と一致しないため削除対象にならない |

信頼しない入力源は IDE 拡張と同じ（frontmatter の `name`、貼り付けた URL）に加え、
**閲覧中のページの DOM**（JSON-LD）を含む。JSON-LD から採るのは `codeRepository` と `url` だけで、
既に解釈できる URL に限って受け入れる。ページの HTML 構造には依存しない。

### 10.2 権限スコープ

```json
{
  "manifest_version": 3,
  "host_permissions": [
    "https://github.com/*",
    "https://skills.sh/*",
    "https://agentsdirectory.dev/*",
    "https://api.github.com/*",
    "https://raw.githubusercontent.com/*",
    "https://codeload.github.com/*"
  ],
  "permissions": ["webNavigation"]
}
```

- `<all_urls>` と `unlimitedStorage` を要求しない。自動検知は github.com / skills.sh / agentsdirectory.dev だけで動く。未対応サイトは `activeTab + scripting` で、利用者のクリック時に現在タブだけを読む（§10.5）。永続化するのは小さな IndexedDB メタデータ、ディレクトリハンドル、`chrome.storage.local` の Jev 設定だけで、通常の拡張ストレージ枠に収める。
- 取得のために `raw.githubusercontent.com`（実在確認）、`api.github.com`（commit SHA）、
  `codeload.github.com`（アーカイブ）へ通信する。IDE 拡張と同じ公開エンドポイントだけを使う。
- commit SHA を台帳に載せないと、IDE 拡張が取り込んだ直後に全件が「更新あり」に見える
  （`inventory.ts` の `hasUpdate` は `latestSha !== entry.sha` で判定する）。既定ブランチ名は
  推測せず、`HEAD` を使う。
- 閲覧中の URL を自動で外部サービスへ送らない。実在確認に投げるのは GitHub のパスだけである。
  §10.5 の手動スキャンだけが例外で、対象は利用者がクリックしたその 1 ページに限る。
- テレメトリは一切収集しない。

### 10.3 書き込みと削除

- ファイルシステムに触る口は `browser/fs.ts` だけに置く。File System Access API は
  `writeGuard.ts` を通れないので、名前の検証（`safeSegments`）を通る経路が 1 つであることを
  `check-invariants.sh` が機械で数える。
- 作成前に `assertValidName`（`core/`）を通す。tar の各エントリにも同じ検証を適用する。
- 脱出防止（`safeSegments`）とは別に、**書けるかどうか**を `unportableName` で見る。Windows の
  予約デバイス名・`<>:"|?*`・末尾のピリオドと空白は、macOS では作れて Windows では作れない。
  取得物の全パスと導入先の名前をまとめて検査し、**1 つでも駄目なら何も消さずに止める**。
  消してから気づくと、旧版も新版も無い状態が残る。
- 書く直前に同名の実体を確認し、あれば上書きの確認を求める。記録ではなく実態を見る。
- 上書きは**取得できてから**旧実体を消し、その後に書く。重ねて書くと旧版にしか無いファイルが
  残り、新旧の混ざったものになる。取得に失敗した時点では旧実体はまだ消していない。
- 上書き時の rollback 用旧実体はメモリへ退避するため **64 MB** を上限とする。これを超える実体は旧版を消さずに停止し、
  展開上限 200 MB をそのまま rollback に使って新旧ツリーを同時保持しない。
- `skills` / `agents` を作るのは導入のときだけにする。許可を貰うだけ・一覧を確かめるだけの
  場面で、使うか分からないフォルダを利用者のディレクトリに作らない。
- 削除前に収集一覧の実体ツリー SHA-256 を再計算し、一致する場合だけ削除する。手動変更・
  IDE 管理下への移行を含め、一致しなければ何も削除しない。
- `removeEntry({ recursive: true })` は実体 1 件に対してのみ呼ぶ。導入先ルートと `.agent-tool` を対象にしない。
- 台帳は取得元の引き渡しだけに使い、削除の可否判定には使わない（判定は実体ツリー SHA-256）。
- 拒否ファイル名・拒否拡張子は IDE 拡張と同じリストを `core/` で共有する。

### 10.4 取得

- 公開リポジトリのみ・未認証。`fetch` に `cache: 'no-store'` を指定する。
- codeload の `tar.gz` を `DecompressionStream('gzip')` でストリーム展開する。tar の各エントリは
  `assertValidName`、種別（通常ファイルまたはディレクトリ）、各上限を検査し、リンクと特殊ファイルを拒否する。
- アーカイブ 50 MB、展開後 200 MB、単一ファイル 20 MB の上限は `core/` で IDE 拡張と共有する。
- 取得と展開は extension の popup で行う。MV3 の service worker はアイドルで停止するため使わない。
- カタログ候補の展開確認はアーカイブを 1 本丸ごと落とす（実測で数 MB）。ネットワークに
  触れない判定・実在確認・導入済み判定を**全部先に**通し、出すと決まったものだけを確かめる。
  結果は service worker のメモリに URL 単位で持ち、同じページを見るたびに落とし直さない。

### 10.5 Jev 補助の手動検知（未対応サイト・**Beta**）

**この機能は Beta である。** 試験的な位置づけで、外部 API（TypeSafe の Jev）と利用者の
API key に依存する。既定は無効、利用者が鍵を登録して有効化しない限り一切動かない。
今後の版で変更・撤去することがあり、撤去手順は
`docs/agent-tool-release-plan.md`「Beta 機能の撤去」に置く。
Beta である旨は UI（設定と未対応ページのカード）と README・ストア掲載文にも出す。

対応サイトの決定論的検知はこの経路を一切通らない。Jev が落ちても、鍵が無くても、
既存の検知・導入は同じように動く — これが Beta として同梱できる前提である。

- `<all_urls>` を要求しない。読むのは `activeTab + scripting` で、利用者のクリック直後の
  現在タブ 1 枚だけ。自動では実行しない。
- **どれを入れるかは Jev に訊かない。** 訊くのは「このページは Tool を配っているか」と
  その種別だけで、取得元と名前はコードが決める。候補から選ばせていたときは、外れを補正する
  規則が別のページを壊す連鎖になった。解決は次の順で、**決まらなければ当てにいかない**。

  1. ページの URL 末尾・`#fragment` と、候補から `lead()` が取り出した名前を照合する
  2. 直リンクが 1 件に決まればそれ。複数残れば一覧として返し、利用者が選ぶ
  3. 直リンクが 1 つも無いときだけ Jev に訊き、取得元は**導入コマンドに書かれた repo**を
     リンクより優先する。それでも割れるなら出さない

- 送るのはローカルで抽出・正規化した有限個の候補（`browser/pageEvidence.ts`）だけにする。
  URL 候補は github.com に限り、query と credential を落とす。
  HTML 全文、フォーム入力値、Cookie、storage、閲覧履歴は送らない。
- コードブロックは**取得元を名乗る行だけ**を採り、`key` / `token` / `secret` / `password` /
  `auth` への代入、`Bearer` / `Basic`、URL の userinfo を `[redacted]` に潰してから送る
  （`ide/mcpServer.ts` の `redact` と同じ方針）。導入ブロックには
  `export ANTHROPIC_API_KEY=…` が同居することがあり、丸ごと送ると鍵が外部へ出る。
- 実在を**確かめられなかった**（通信不能）ときは「このページに Tool は無い」と言わず、
  取得元を添えて「読めなかった」と出す。不在と未確認を同じ見た目に潰さない。
- URL に `#fragment` があり、それがページ内の要素を指すときは、**その要素の中だけ**から
  候補を採る（まとめページの 1 件を指す形）。送るのは節の見出しだけで、**fragment 自体は
  送らない** — implicit flow の access token が入ることがある。絞れた分だけ送信量は減る。
- Jev は**選ぶだけ**で、文字列を生成させない。回答は未信頼入力として扱い、候補 id の
  ホワイトリスト・確率・confidence を検証してから使う（`browser/jev.ts`）。
- 候補由来の `owner/repo` は他の経路と同じ検証（`core/github.ts` の `parseUrl`）を通す。
  ページ本文の正規表現から `GitHubSource` を直接組み立てない。
- AI の判定だけで導入しない。既存の GitHub 実在確認・展開確認（`isExtractable`）と
  Preview・利用者確認を必ず通す。同じ lead を二度確認しない。
- 名前が決まらないときは推測で導入候補にしない。取得元だけを popup へ返し、
  `skills/` の列挙（GitHub API）から利用者に選ばせる。実在確認が落ちたときも同じ。
- ページから抽出した導入コマンドを**実行しない**。`npx skills add owner/repo --skill foo` は
  取得元と名前の手がかりとしてだけ読み、導入は既存の GitHub 取得・安全な展開経路へ変換する。
- Jev が選んだ URL をそのまま `fetch` しない。取得先は既存の GitHub エンドポイントへ
  正規化できるものだけで、未知ホストのアーカイブや raw ファイルは取りに行かない。
- 証拠の強さでゲートを分ける。**閾値そのものは下げない**（下げると弱い証拠の側が一緒に緩む）。

  | 経路 | 証拠 | Jev | 結果 |
  |---|---|---|---|
  | 照合で 1 件に決まる直リンク | パスが種別と名前を名指し、raw の HEAD で確認 | 呼ばない | `found` |
  | 直リンクが複数 | どれも実在しうる | 呼ばない | `many`（一覧） |
  | 直リンクが無く、取得元が 1 つ | 置き場は推測。`skills/` の列挙で確かめる | `is_tool_page` 0.80 以上 | `repo` |
  | 直リンクが無く、取得元が割れる | 決め手が無い | — | `none` |

- 確率と confidence は**次段の決定論的確認へ進めてよいかを決める内部値**にとどめる。
  「この Tool は 92% 安全」のような表示はしない（PRD の「信頼度を数値化しない」は
  導入物の安全性・品質の話で、こちらは候補選択の一意性の話である）。
- API key は `chrome.storage.local` に置き、書き込む前に `setAccessLevel`
  (`TRUSTED_CONTEXTS`) で content script から読めなくする。`minimum_chrome_version: 123`
  はこの API の下限である。key は Authorization ヘッダだけに載せ、ログへ出さない。
- 応答は 256 KB で打ち切り、12 秒でタイムアウトする。失敗・低確率・通信不能でも
  対応サイトの動作を変えない。

### 10.6 残存リスク

| リスク | 扱い |
|---|---|
| スクリプトを同梱した配布物で Safe Browsing の確認が出る | 利用者に確認を委ねる。回避しない |
| Brave は File System Access API を既定で無効にしている | ピッカーを開く前に関数の有無を見る。「取り消した」と混ぜず、`brave://flags` を開いて `File System` を探す手順を出す（項目 id は版で変わるため深いリンクにしない）。有効にできない版では Chrome / Edge を案内する |
| ブラウザ再起動後に再許可が 1 回必要 | 仕様。popup の導入操作に組み込む |
| IDE 拡張が張った symlink を辿れない | 相互に不可視。D-13 の通り受け入れる |
| 隠しディレクトリをピッカーで選べない | OS 別の手順を、ピッカーを開く前に表示する |
| 導入先の取り違え | ハンドルから basename しか得られず、`~/.cursor/skills` と `~/.claude/skills` を区別できない。検出しない。ピッカーを開く前に期待するパスを示すに留める |
