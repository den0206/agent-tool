# Agent Tool — 設計決定記録

## D-1. 対応環境

macOS、Linux、Windows のすべてで機能を提供する。OS 固有のパスは VS Code と
Node.js 標準ライブラリで解決し、リンクは macOS/Linux で symlink、Windows で
junction または hardlink を使う。

## D-2. 実装

すべての管理ロジックは拡張内の TypeScript モジュールで実行する。配布物に
プラットフォーム固有の実行ファイルは含めない。

## D-3. 保存先

可変メタデータは `context.globalStorageUri` の `registry.json` だけに保存する。
Skill と Subagent の実体はエージェントが読む既知の管理ルートに置く。

## D-4. 安全な書き込み

`writeGuard.ts`、`registry.ts`、`mcpScanner.ts` だけが書き込みを行う。
名前、親ディレクトリ、symlink/junction、管理ルートを検証してから操作する。

## D-5. 削除

削除は確認後に実行する。Undo と恒久バックアップは持たない。

## D-6. UI

Dashboard は表示中だけ一覧の再取得と MCP ポーリングを行う。View を閉じるか
非表示にした時点でタイマー、キャッシュ、スナップショットを破棄する。

## D-7. 信頼境界

未信頼ワークスペースと Remote 環境では書き込み操作を拒否する。走査対象は
`source.ts` のホワイトリストに限定する。

## D-8. プロセス状態

MCP サーバーの状態は登録済み定義とプロセス親子関係を照合して判断する。
ホームやワークスペースを再帰走査しない。

## D-9. 配布と検証

Node.js の型検査・テスト・不変条件検査を 3 OS で実行する。Cursor の E2E は
固定した Cursor Stable を macOS で実行する。第三者 GitHub Action は完全 SHA を使う。

## D-10. ブラウザ拡張の位置づけ

Chrome / Edge / Brave 向けの拡張を同じリポジトリで提供する。IDE 拡張とは独立して動作し、
ブラウザ拡張だけで検知から導入まで完結する。IDE 拡張の導入も起動も前提にしない。

localhost ブリッジと native messaging host は採らない。前者は IDE 拡張が待受主体になるため
未導入・未起動の利用者で導入が成立せず、後者は配布物にプラットフォーム固有の実行ファイルが
必要になり D-2 と衝突する。

## D-11. ブラウザからの書き込み

File System Access API を使う。利用者がディレクトリを選んで許可した範囲だけに書き込み、
ハンドルは IndexedDB に保持する。常駐プロセスを持たない。

Chromium はホームディレクトリ直下の選択を拒否するが、その配下は選べる。symlink は作れないため、
D-3 の共有ストアとリンクの方式はブラウザ側では再現しない（D-13）。

初回起動時はオンボーディングを popup で開き、利用者が使う Agent ごとに導入先ルートを
選ぶ。ピッカーはこの明示操作でだけ開く。以後は保存済みハンドルに `queryPermission()` を行い、
`granted` なら Agent を選ぶだけで導入する。権限が `prompt` のときは導入ボタンの操作で再許可を
求め、`denied` またはハンドル未設定のときだけオンボーディングの選択画面へ戻す。

## D-12. ブラウザ拡張が扱う種別

Skill と Subagent だけを扱う。

- MCP は URL に手がかりが無く、公式サイトの JSON を貼る既存導線が最頻である。
- Plugin は `installed_plugins.json` への登録が必要で、IDE 拡張も書き込みを CLI に委譲している。
  ファイルを置いてもエージェントが認識しない。Native Messaging Host で埋める案は
  Snap Chromium が到達できず、Windows の EV 証明書コストと配布物へバイナリを持ち込む必要が
  D-2 と衝突するため採らない。
- Rule は共有カタログの実体が観測できないため URL からの導入経路を持たない（D-20）。
  IDE 拡張の表示・削除だけに閉じ、ブラウザ拡張は扱わない。

`supports()` により、Gemini CLI は MCP だけを対象にするため導入先に現れない。Codex は Skill だけ。

## D-13. 実体の置き場

`~/.agents/skills` を読むエージェント（Cursor / Codex）には、そこへ 1 つだけ置く。存在しない
環境では各エージェント直下へ置く。Claude は `~/.agents` を読まないので常に `~/.claude/skills`
へ直接置く。

IDE 拡張が張った symlink はブラウザ拡張から辿れない。両者が入れたものは相互に不可視となる。

## D-14. 取得元の台帳

ブラウザ拡張は導入先ルートの `.agent-tool/<name>.json` に取得元と commit SHA を書く。
エントリごとに 1 ファイルにして read-modify-write を避ける。ブラウザ拡張はプロセス間ロックを
取れない。

IDE 拡張は走査時にこれを `registry.json` へ取り込み、取り込んだファイルを削除する。走査は
`.` で始まる名前を除外するため、台帳がスキルとして誤検出されることはない。取り込みにより、
IDE 拡張の削除・無効化・更新検知がそのまま働く。利用者が自分で置いた実体は台帳を持たないので
管理下に入らない。

台帳と実体ツリー SHA-256（D-11）は役割が違う。台帳はブラウザ拡張から IDE 拡張への片方向の
引き渡しに使い、SHA-256 はブラウザ拡張自身が削除してよいかの判定に使う。互いを代替しない。

## D-15. 実体を失った entry

IDE 拡張は、走査できたルートに属する entry だけを実体と照合し、実体が無ければ registry から
除く。走査できなかったルート（開いていないプロジェクト）の entry は残す。project スコープの
entry を巻き込んで消さないための条件である。

読めなかったルートが 1 つでもあれば除去は行わない。走査は「無い」も「読めない」も空として
返すので、区別せずに除くと、実体が残っているのに `pinned` / `disabled` / 取得元を失う。
除去は元に戻せないため、残しすぎる側へ倒す。

## D-16. ブラウザ拡張の検知

`host_permissions` は検知用の github.com / skills.sh / agentsdirectory.dev と、取得用の
raw.githubusercontent.com / codeload.github.com に限る。content script は候補を service worker へ渡す
だけで、ページへ UI を挿入しない。

検知時は `raw.githubusercontent.com` へ実在確認し、成功したら service worker が action popup を
開く。カタログ候補だけは実在確認では足りず（実体パスを約束しない）アーカイブを 1 本落として
展開できるかを見るが、これは**他の判定を全部通ったものにだけ**行う。導入済みのものを
見るたびに数 MB 落とさないよう、結果は URL 単位で service worker のメモリに持つ。覚えるのは
答えが出たときだけで、取得に失敗しただけのものは覚えない。

「今はしない」は覚えない。断るのはその表示に対してであって、そのページに対してではない。
覚えると解除条件が「service worker が停止するまで」という拡張の都合になり、利用者からは
いつ戻るのか決まらない。同じページをもう一度開けば、もう一度出す。導入済みかどうかは
収集一覧（IndexedDB）が持っているので、service worker が別に覚える必要も無い。自動表示はオンボーディングで有効にする既定 ON の設定とし、同じタブ・同じ候補には
セッション中 1 回だけ開く。開けない環境ではバッジだけを出し、toolbar action から候補を開けるようにする。
閲覧中の URL は外部へ送らない。
URL だけで取得元が決まらない agentsdirectory.dev は、開いているページの JSON-LD を DOM から
読む。入力フォームに貼られたときだけ取得しに行く。

## D-17. ブラウザ拡張の画面

toolbar action の popup を extension page とする。検知で開けない環境ではバッジだけを出し、
利用者が toolbar action から開けるようにする。設定と `Supported sites` は同じ popup 内で切り替え、
後者は native dialog で GitHub と対応カタログへのリンクを表示する。別ウィンドウは作らない。

## D-19. 置き場を指されたときの一覧と、ファイル単位の取得

`skills/` のように Skill が並ぶ置き場を指されたら、1 件ではなく一覧を出し、**行ごとに**導入する。
まとめて入れない — 20 件のうち欲しいのが 1 件、ということの方が多い。

取得はアーカイブではなく**ファイル単位**にする。カタログは subdir を約束せず、アーカイブを
丸ごと落とす経路しか無いと、大きいリポジトリからは 1 件も入れられない
（実測: `heygen-com/hyperframes` は圧縮 116 MB で取得上限 50 MB を超える。欲しいのは 104 KB）。

- 列挙は GitHub の tree API を **1 回**。`<ref>:<パス>` で部分木だけを読む
  （リポジトリ全体の tree は実測 2.7 MB、部分木なら 289 KB）。
- 実体は `raw.githubusercontent.com` から取る。CDN なので、未認証 60 req/時の枠を
  件数ぶん食わない。API を使うのは列挙の 1 回と commit SHA の 1 回だけである。
- 上限（件数・単一ファイル・合計）はアーカイブ経路と同じものを当てる。取り方が違うだけで、
  入ってくるものは同じ外部入力である。
- 書き込み・台帳・収集一覧は既存の経路をそのまま通す。取得のしかたを差し替えるだけにする。
- 枠切れ（403）と通信失敗は区別せず、一覧を出さない。覚え込まず、次に開けばもう一度試す。
- 切れた一覧（`truncated`）は使わない。「全部」でないものを全部として見せない。

`SKILL.md` を持たないディレクトリは一覧に出さない。押しても入らない行を並べない。

## D-18. リポジトリ構成と配布

`ide/` `browser/` `core/` に分け、`test/` はルートに集約する。ルートの `package.json` は 1 つ、
`browser/manifest.json` を別に持つ。

版は IDE 拡張とブラウザ拡張で同一にする。`release/Ver_X.Y.Z` が両方を組み立て、同じ GitHub
Release へ添付する。利用者が両方を使う際の対応関係を明確にし、リリース手順を 1 つに保つためである。
ブラウザの zip は Chrome Web Store と Edge Add-ons へ提出し、Brave は Chrome Web Store からの導入を案内する。

## D-20. Rule 種別の対象

Rule は Claude Code の `.claude/rules/*.md` と Cursor の `.cursor/rules/*.mdc` を扱う。
ただし **URL からの導入は行わない**。既に置かれている Rule を Dashboard に表示し、
削除だけを提供する。

- Rule は Skill / Subagent と違い、共有カタログが実質存在しない。プロジェクトごとの規約や
  個人の作業習慣を書くファイルで、GitHub 上の共有ライブラリとして流通する慣習が確認できない。
  ブラウザ拡張の検知、URL からの導入、台帳・収集一覧は用意しない。`kindOf` で `rules/` を
  含む URL は候補にせず、`DetectKind` にも Rule を含めない。
- 走査は各エージェントの読む場所だけ。user は `~/.claude/rules/` と `~/.cursor/rules/`、
  project は `<project>/.claude/rules/` と `<project>/.cursor/rules/`。Codex の `AGENTS.md` と
  Gemini の `GEMINI.md` は「単一ファイル階層マージ」方式で 1 リソース = 1 配置に乗らず、
  ファイル全体を書き換える経路は利用者の手編集を保護できないので対象外にする。
- 有効化・無効化（toggle）は提供しない。Rule は registry に載らず、退避先も持たない —
  `isTogglable` が `kind === "rule"` を排除する。Dashboard は表示・削除だけを出す。
- 削除は `removeUnmanaged` を通す。Claude は `<name>.md`、Cursor は `<name>.mdc` を消す。
  拡張はどちらのフォーマットにも変換せず、置き場ごとに拡張子を切り替える。
  **Skill / Subagent と違い、対象ルートを選ばれた行の agent 1 つに絞る。** Rule には
  共有ストアもリンクも無く、同名でもエージェントごとに無関係な別ファイルなので、
  全ルート一括で消すと片方を消したつもりでもう一方まで消える（D-5 によりゴミ箱は無い）。
  一覧も同じ理由で、同名 Rule をエージェントごとに別の行として出す。
- 実体には手を入れない。frontmatter の相互変換（Claude `paths:` ↔ Cursor `globs:`）も
  行わない。利用者が手で置いたものを見せて、消せるようにするだけに閉じる。
