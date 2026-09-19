# Agent Tool — テスト計画

## 自動テスト

Node.js `node:test` で TypeScript モジュールと VS Code API モックを検証する。
テストは偽ホームを使い、実ユーザーのエージェント設定を読み書きしない。

| 対象 | 確認内容 |
|---|---|
| WriteGuard / Registry | パス検証、原子的書き込み、ロック、設定・registry の読込上限 |
| 走査 | ホワイトリスト外を読まない |
| 追加・更新・削除 | 実体、リンク、設定の変更先 |
| Plugin | CLI コマンドと scope |
| Dashboard | 表示中のみポーリングし、重複実行せず非表示時に解放 |
| 台帳の取り込み | 未取り込みの台帳を registry へ入れ、読んだ台帳だけを消す |
| 台帳の WriteGuard | 実体が無い台帳、`.agent-tool` の外、名前が不正なものを消さない |
| 実体を失った entry | 走査できたルートの分だけ除き、開いていないプロジェクトを残す |

ブラウザ拡張は `core/` の純粋関数と、File System Access API / IndexedDB を
メモリ実装（`test/fakeFs.js` / `test/fakeIdb.js`）へ差し替えた書き込み経路を
同じ `node:test` で検証する。

| 対象 | 確認内容 |
|---|---|
| 書き込み（`writeTree` / `readTree` / `reserve`） | 置き場の下へ書き、展開先の外を指すパスを拒み、作れない名前を取得の前に落とす |
| 導入（`install`） | 実体・台帳・収集一覧が揃う。上書きは重ねず置き換える |
| 導入の失敗 | 取得に失敗しても既存に触れない。確保しただけの置き場を片付ける。書ける名前かを消す前に見る |
| 上書きの巻き戻し | 書き込みが途中で落ちたら旧版へ戻す（API に rename が無いため退避 → 削除 → 書き込みの順になる） |
| 削除（`remove`） | 導入時の実体ツリー hash と一致するときだけ消し、台帳 1 件も落とす。手で直されたものは消さない |

| 対象 | 確認内容 |
|---|---|
| URL 判定 | 検知と入力フォームが同じ結果を返す。対応外の URL を拾わない |
| カタログ事前確認 | JSON-LD が解決しても、アーカイブから抽出できない項目は候補にしない |
| 種別判定 | パス名から Skill / Subagent を当て、Plugin と MCP を返さない |
| 配置先の決定 | エージェントと共有ストアの有無から置き場を決める |
| tar 展開 | ヘッダ、`assertValidName`、リンク拒否、各上限での打ち切り |
| 実体ツリー hash | 導入直後と再計算時が一致し、変更後は削除を拒否する |
| 収集一覧の退避 | 101件目で最古を捨てる対象を返す（一覧を受け取る純粋関数） |
| 書ける名前か | Windows の予約デバイス名・`<>:"\|?*`・末尾のピリオドと空白を落とし、実在する名前は通す |
| 台帳の生成 | 取得元と commit SHA を書き、pinned と実体ツリー hash を持たない |
| 対応サイト導線 | GitHub・skills.sh・Agents Directory の複数 URL を固定フィクスチャで解決し、Skill / Subagent の検知と導入先候補を確認する。実ファイル・実サイトは触らない |
| IDE の追加経路 | Skill / Subagent の URL、MCP の構造化入力、Plugin の CLI 委譲をそれぞれ確認する |

実サイトの応答は CI に混ぜず、`npm run test:browser` を手動で回す。PR は落とさない —
カタログ側の障害で開発を止めないためである。このスモークテストは GitHub の検証済み Skill 群と Subagent、
skills.sh・Agents Directory の公開一覧からランダムに選んだ URL を解決し、検知・GitHub
アーカイブからの Tool 抽出・**3 OS で書ける名前かの検査**・導入先決定までを確認する。
`notFound`、`tooLarge`、GitHub の実体確認に失敗した候補は、拡張と同じく候補から除外して次を選ぶ。
書き込みは行わない。

前半のカタログ確認で分かるのは「URL → 取得元 → 展開」までである。後半は Playwright で
組み立て済み拡張を Chromium に読み込み、各カタログを開いてツールバーバッジの表示まで確認する。次は原理的に届かないので、
手動確認に残す。

| 届かないもの | 理由 |
|---|---|
| ピッカーと権限ダイアログ（`configHandle` / `requestPermission`） | ネイティブ UI で、拡張から操作できない |
| symlink が実在しても `getDirectoryHandle` に見えないこと | ブラウザと OS の組み合わせでしか起きない（メモリ実装では `blocked` で模す） |
| DOM から読む JSON-LD（`content.ts`） | スクリプトが見るのは `fetch` したサーバ HTML で、読み出し元が違う |
| SPA 遷移（`onHistoryStateUpdated` → `rescan`） | ブラウザのイベント |

Jev 補助の手動検知（Beta）は、外部 API を叩かない範囲を `node:test` で固定する。

| 対象 | 確認内容 |
|---|---|
| 送信内容（`pageEvidence`） | github.com 以外・query・credential・fragment を送らない。`#fragment` が指す節だけに絞る |
| 候補の絞り込み（`narrowed`） | 取得元に解決できない候補と雛形コマンドを落とす |
| 照合（`resolveLocally`） | URL 末尾と名前が一致する直リンクを採る。同じ Skill の重複を畳む。複数なら一覧 |
| 回答の検証（`jev`） | 問いは 2 つだけ、確率の範囲、API key が送信本文に入らない |
| ゲート（`aiDetect`） | 直リンクがあれば Jev を呼ばない。無いときだけ訊き、取得元が割れたら出さない |
| 種別 | MCP / Plugin をブラウザの導入経路に入れない |

実 API と実サイトを使う確認は `node scripts/test-browser-jev.mjs`（`npm run test:browser` の
最後）に分け、CI では動かさない。`JEV_TOKEN` が無ければ skip する。

本体は **未対応サイトの Tool ページを popup へ渡して検知できるか**を見る
（`scripts/e2e/popup-jev.mjs`）。モジュールを直接叩くだけでは popup が開かない・ボタンが
効かない形の不具合を取りこぼすので（実測で取りこぼした）、実ブラウザに拡張を読み込み、
実ページと実 `chrome.*` API で導線をそのまま通す。ページごとに期待する結果を持つ。

| 形 | 期待 |
|---|---|
| Skill の直リンクがある | カードに取得元と名前が出る（Jev を呼ばない） |
| commit 固定とブランチが並ぶ | 同じ Skill として 1 件に畳む |
| 導入コマンドの例が並ぶ | 雛形を拾わず、コマンドの repo を採る |
| `/blob/` でディレクトリを案内 | ディレクトリとして読む |
| URL の末尾が Tool 名を名乗るまとめ | 照合で 1 件に決まる |
| `#fragment` が節を指す | その節だけから決まる |
| 直リンクが無い | Jev に訊いてから `skills/` を列挙し、一覧に出す |
| まとめページ | 1 件に決め打たず、件数を伝える |

加えて、鍵の保存で有効になり削除で非活性へ戻ることを同じ導線で確かめる。
`activeTab` の付与と、`setAccessLevel` が使えない環境で popup が通常どおり開くことは
自動化できないので**手動確認に残す**。付与はツールバーアイコンのクリックに紐づき
Playwright から押せないため、テスト用にコピーした拡張へ対象サイトの host 権限を足して
代替する（配布物は変えない）。

URL を 1 つ渡すと、そのページだけをモジュール単位で段ごとに診断する（`diagnose-jev-page` が使う）。

一方、manifest の到達範囲は Node の `fetch` が素通りしてしまうので、`CATALOG_SITES` の host が
`host_permissions` と `content_scripts.matches` に入っているかを `check-browser-package.mjs` が
突き合わせる（CI で毎回動く）。

## CI

Linux、macOS、Windows で `npm run typecheck` と `npm test` を実行する。
Linux で不変条件検査、ブラウザ拡張の組み立て検査（`npm run package:browser`）、
リリース検査を実行する。`CURSOR_URL` と `CURSOR_SHA256` が
リポジトリ変数に設定されている場合は、macOS で固定 Cursor Stable の E2E と
VSIX サイズ検査も実行する。

## 手動確認

File System Access API とピッカーは自動化せず、リリース前に実機で確認する。
ネイティブダイアログに土台を組まない。

- 初回オンボーディング、Agent ごとのディレクトリ許可、ブラウザ再起動後の再許可、隠しディレクトリの選択
- 検知時の popup、同一タブ・候補の重複抑止、自動表示 ON / OFF 設定
- 導入、上書き確認、削除
- Chrome、Edge、Brave で対応サイトの検知、Supported sites モーダル、導入操作

## リリース前

配布した VSIX の初回起動、複数ウィンドウのロック、RSS、保存容量を実機で確認する。
ブラウザ拡張は Chrome / Edge / Brave で検知から導入までを通す。
