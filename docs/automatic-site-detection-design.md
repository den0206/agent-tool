# Agent Tool — Site-scoped Automatic Detection 設計案

> Status: Proposal（API 挙動を実機検証済み）  
> Target: Browser extension (Chrome / Edge / Brave)  
> Base: `main@6560b3cb8ad27cd45e935ac409b5794d087c6075`  
> Related: Jev-assisted detection Beta already merged into `main`

## 0. 実機検証の結果

使い捨ての probe 拡張を Chromium（Playwright 同梱, 1243）へ読み込ませて、この設計が前提にしている
Chrome 拡張 API の挙動を確かめた。結果は以下。**設計の一部はこれで成立しないことが分かった。**

| 検証 | 結果 | 設計への影響 |
|---|---|---|
| `optional_host_permissions: ["https://*/*"]` + `declarativeContent` を宣言した MV3 manifest | 読み込める。`getAll()` の `origins` は `host_permissions` の分だけ | §8.1 は成立する |
| `permissions.request()` をユーザー操作の外から呼ぶ | `This function must be called during a user gesture` で例外 | §8.5 は API 側が強制する |
| `permissions.contains({origins:["https://*/*"]})` | `false`。optional 宣言は権限ではない | §4.3 / §12.1 は成立する |
| `PageStateMatcher({css:[...]})` | 複合セレクタは登録可・配列は AND。子孫セレクタは `Invalid CSS selector` で例外 | §6.2 の書き方自体は正しい |
| `chrome.action.disable()` 後の `chrome.action.openPopup()` | **`Extension does not have a popup on the active tab`** | **§6 / Phase D は成立しない（削除）** |
| `webNavigation.onCompleted` をフィルタ無しで登録 | **host permission の無いホストのイベントも届く** | **§2.3 / §9.1 / §38 に穴（フィルタ必須）** |
| `addListener(cb, {url:[{hostEquals:"localhost"}]})` を後から張り替え | 動く。一致ホストだけが届く | 上の穴はこれで塞ぐ |

確定した設計修正:

1. **Stage 0（declarativeContent prefilter）を削除する。** MV3 の `ShowAction` は「既定で
   `chrome.action.disable()` し、ルール一致で有効化」でしか効かない。Agent Tool は popup が UI の
   全部（設定 / Jev key / 収集一覧 / Allowed Sites）なので、無関係なページで action を disable すると
   popup 自体が開けなくなる。加えて declarativeContent は service worker にイベントを返さないので、
   判定にも重複抑制にも使えない。→ `declarativeContent` 権限を足さない。
2. **`webNavigation` の listener は許可済み origin でフィルタする。**（§9.1）
3. **自動経路も Jev を呼ぶ。押さずに積む分に上限を置く。**（§9.5）
4. **`repo` / `many` を background の既存 state に載せる形を決める。**（§10.3）

## 1. 背景

現在のブラウザ拡張には、GitHub / skills.sh / Agents Directory の既知サイトを決定論的に自動検知する経路と、未対応サイトを利用者が明示的に開いて **Find tools on this page** を押したときだけ Jev を補助利用する Beta 経路がある。

未対応サイト側についても、利用者が一度「このサイトでは今後も自動検知してよい」と許可したサイトだけは、ページ遷移時に Tool を自動検知できるようにしたい。

ただし、次の条件は崩さない。

- 全 Web サイトを常時読み取る `<all_urls>` 相当の必須権限は要求しない。
- Tool と無関係なサイトで Chrome の permission dialog を出さない。
- サイト権限は利用者が明示的に許可した origin だけに限定する。
- Jev は取得元や Tool 名の決定主体にしない。決定論で解けない「Tool 配布ページか」の判断補助に限定する。
- Jev 単独判定だけで Install candidate を確定しない。既存の GitHub 実在確認・展開確認を必ず通す。
- 既知サイトの自動検知は今まで通り決定論的経路を正本とし、Jev を呼ばない。
- 権限を削除した時点から自動検知を停止する。
- Tool と無関係なページでは、利用者に視覚的なノイズを出さない。

この設計では、**Tool を探すために権限を要求するのではなく、Tool を確認できたサイトに対してのみ「今後このサイトで自動検知するか」を提案する**。

---

## 2. ゴール

### 2.1 機能ゴール

未対応サイトで一度 Tool を確認できたあと、利用者がその origin に対して自動検知を許可できる。

許可後はその origin 内のページ遷移時に以下を自動で行う。

1. ローカル evidence 抽出
2. 決定論的 resolver
3. 必要な場合だけ Jev
4. GitHub 実在確認
5. badge / popup への候補反映

### 2.2 UX ゴール

無関係なサイトでは何も起きない。

権限ダイアログを表示する前に、Agent Tool 自身の説明を出す。

Chrome permission dialog は、利用者が **「このサイトで自動検知を有効にする」** を押した直後にだけ出す。

### 2.3 セキュリティゴール

- 必須 host permission を全 Web に広げない。
- optional permission は exact origin に限定する。
- `https://*.example.com/*` のようにサブドメインへ自動展開しない。
- 未許可 origin では background から DOM を読まない。
- 未許可 origin の URL を background が受け取らない。`webNavigation` の listener は
  許可済み origin でフィルタする（フィルタ無しだと権限の無いホストの遷移も届く。§0 で実測）。
- Jev API key は既存 Beta と同じ trusted extension context のみ。
- ページ由来の install command は実行しない。
- 未知 host へ fetch しない。
- ページ本文全体を TypeSafe へ送らない。

---

## 3. 非ゴール

このフェーズでは以下を実装しない。

- 全 Web サイトを一括で自動検知する設定
- `<all_urls>` の必須 permission
- 「すべてのサイトで許可」ボタン
- eTLD+1 単位の自動許可
- `*.example.com` へのワイルドカード拡張
- Tool 推薦
- Tool 品質・安全性のスコアリング
- MCP / Plugin のブラウザからの導入
- ページ本文を LLM に渡して自由生成で repo / URL / Tool 名を推測する処理
- ページから見つけた shell command の自動実行
- 許可サイトの閲覧履歴保存
- 自動検知履歴の永続保存
- Jev 判定結果のテレメトリ

---

## 4. 設計原則

### 4.1 Deterministic first

優先順位は以下。

```text
known-site deterministic detection
        ↓
local page evidence extraction
        ↓
local deterministic resolution
        ↓
Jev only if local code cannot decide whether this is a Tool page
        ↓
GitHub deterministic verification
        ↓
user-visible candidate
```

Jev は「判断の最後の穴」を埋める。

### 4.2 Permission after proof

permission を取得するためにページを読むのではない。

現在の `activeTab` を使った手動スキャンで Tool の存在を確認した後にのみ、次回以降の自動検知 permission を提案する。

```text
manual scan
  ↓
Tool verified
  ↓
offer site automation
  ↓
user explicitly clicks allow
  ↓
chrome.permissions.request()
```

### 4.3 Chrome permission is the source of truth

許可サイト一覧の正本は独自 DB ではなく `chrome.permissions` とする。

必要なら表示用 metadata を別保存できるが、

- 自動検知可能か
- 許可済みか
- 削除済みか

は常に Chrome permission API の結果で判断する。

---

## 5. 全体フロー

```text
未対応サイトへ遷移
        │
        ├─ 未許可 origin → 何もしない（listener に届きもしない）
        │
        ▼
                   利用者が Agent Tool を開く
                               │
                               ▼
[Stage 1] activeTab manual scan
          extractPageEvidence()
                               │
                               ▼
                       narrowed()
                               │
                               ▼
                     resolveLocally()
                               │
                ┌──────────────┼──────────────┐
                │              │              │
              none           found          ask
                │              │              │
                │              │              ▼
                │              │             Jev
                │              │      is_tool_page only
                │              │              │
                └──────────────┴──────┬───────┘
                                      ▼
                              GitHub verification
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                          NG                    OK
                           │                     │
                  permission提案なし            ▼
                                         Tool候補表示
                                                │
                                                ▼
                              「このサイトで今後自動検知」
                                                │
                                                ▼
                               Agent Tool独自説明
                                                │
                                                ▼
                                      user clicks Allow
                                                │
                                                ▼
[Stage 2] chrome.permissions.request()
          exact origin only
                                                │
                                                ▼
[Stage 3] future navigation
          automaticVisit(tabId, url)
                                                │
                                                ▼
                               local → Jev fallback → verify
                                                │
                                                ▼
                                     badge / auto-open
```

---

## 6. Stage 0 — declarativeContent prefilter（不採用）

**この段は実装しない。** 当初は「Agent Tool で調べる価値がありそうなページか」を Chrome 側の
declarative rule で粗く絞る prefilter を置く案だった。実機検証（§0）で二点が確定して破棄した。

1. MV3 の `declarativeContent.ShowAction` は、既定で `chrome.action.disable()` しておき
   ルール一致で有効化する形でしか効かない。Agent Tool は popup が UI の全部
   （設定 / Jev key / 収集一覧 / Allowed Sites）なので、無関係なページで action を disable すると
   popup が開けなくなる。実測で `openPopup()` は
   `Extension does not have a popup on the active tab` を返す。
   prefilter が買うはずだった UX は、実際には負になる。
2. declarativeContent はルール一致を service worker へ通知しない。判定にも重複抑制にも
   使えないので、Stage 1 / Stage 3 のどちらの入力にもならない。

結果として、この段は権限（`declarativeContent`）を 1 つ増やすだけで何も減らさない。
`scripts/check-browser-package.mjs` の `allowedPermissions` も広げずに済ませる。

無関係なサイトで何も起きないことは、prefilter ではなく **permission そのもの**が保証する。
許可していない origin では listener にイベントが届かない（§9.1）。

## 7. Stage 1 — 手動スキャン

未許可サイトの詳細解析は現在の Beta を維持する。

### 7.1 起点

利用者が拡張 popup を開き、手動スキャンを実行する。

`activeTab + scripting` で現在タブだけを読む。

### 7.2 evidence

既存の `browser/pageEvidence.ts` を正本とする。

取得するもの:

- github.com link
- JSON-LD `codeRepository` / `url` / `sameAs`
- source を名乗る install command 行
- title
- headings
- short nearby text
- fragment が示す section

送らないもの:

- HTML 全文
- form values
- cookies
- localStorage
- sessionStorage
- browsing history
- URL credential
- query token
- fragment token
- install command block 全文
- secret-looking value

### 7.3 ローカル判定

`browser/aiDetect.ts` の既存方針を維持する。

```text
narrowed()
    ↓
resolveLocally()
```

直リンクで Tool が決まるなら Jev を呼ばない。

### 7.4 Jev fallback

コードだけでは Tool 配布ページか判定できない場合のみ Jev を使う。

Jev に問うのは原則:

- `is_tool_page`
- `tool_kind`

取得元 URL・Tool 名は Jev に生成させない。

### 7.5 permission 提案可能条件

自動検知 permission を提案できるのは以下。

#### found

GitHub 側で Tool 実体を確認済み。

提案可。

#### many

複数の実在候補をページから取得できている。

提案可。

#### repo

Jev を含む判定で Tool 配布ページと判断し、取得元 repo が一意に決まり、popup 側で Skill 一覧取得まで成功した場合にのみ提案可。

repo が決まっただけでは提案しない。

#### none

提案しない。

#### unverified

提案しない。

通信障害と Tool 不在を混同しない。

#### unsupported-kind

提案しない。

MCP / Plugin はブラウザの自動導入対象外。

---

## 8. Stage 2 — site permission の取得

### 8.1 Manifest

追加は `optional_host_permissions` の 1 項目だけ。**権限は増やさない。**

```json
{
  "permissions": [
    "webNavigation",
    "activeTab",
    "scripting",
    "storage"
  ],
  "optional_host_permissions": [
    "https://*/*"
  ]
}
```

既存 `host_permissions` は維持する。

`optional_host_permissions` に `https://*/*` を宣言しても、実際にアクセスできるのは runtime に利用者が許可した origin のみとする。インストール時の権限表示にも出ない。
`permissions.getAll().origins` は許可済みのものしか返さず、`permissions.contains({origins:["https://*/*"]})`
は `false` のままである（§0 で実測）。CLAUDE.md の「`<all_urls>` を要求しない」はこれで守れる。

`declarativeContent` は足さない（§6）。`scripts/check-browser-package.mjs` の
`allowedPermissions` は現在の 4 つのままにする。

### 8.2 origin 正規化

ポート付きの URL は許可対象にしない。match pattern はポートを表せないので、
落として `https://example.com/*` にすると**別ポートで動く無関係なサイトまで**許可することになる。
非既定ポートの https サイトでは CTA を出さない。

例:

```text
https://example.com/foo
→ https://example.com/*

https://catalog.example.com/foo
→ https://catalog.example.com/*
```

以下には広げない。

```text
https://*.example.com/*
https://*/*
```

### 8.3 対象 scheme

`https:` だけを対象とする。`optional_host_permissions` が `https://*/*` なので、
それ以外の scheme はそもそも要求できない。

localhost（http）も例外にしない。配布物に test 専用の host permission を混ぜないため
（§37）。ローカル fixture の検知は `automaticVisit()` をモジュールとして呼んで確かめる（§22 / §24）。

対象外:

- chrome:
- chrome-extension:
- file:
- data:
- javascript:

### 8.4 Agent Tool 独自説明

Chrome permission dialog の前に、Agent Tool で以下を表示する。

```text
example.com で自動検知しますか？

Agent Tool はこのサイトを閲覧したときだけ
Skill / Subagent 候補を自動的に確認します。

ローカル判定だけで判断できない場合に限り Jev を利用します。

許可対象:
example.com

[ 許可する ]
[ キャンセル ]
```

### 8.5 request の発火条件

`chrome.permissions.request()` はユーザー操作 handler からのみ呼ぶ。

禁止:

- navigation listener
- background automatic scan
- Jev result callback
- Tool found callback

から直接 request すること。

これは API 側が強制する。ユーザー操作の外から呼ぶと
`This function must be called during a user gesture` で例外になる（§0 で実測）ので、
規約違反はテストで検出できる。

### 8.6 popup が閉じる前提で書く

Chrome の permission dialog は拡張アイコンに紐づくネイティブ UI で、開くと popup が閉じることがある。
CTA は popup の manual scan カードに置く（§13.1）ので直撃する。

したがって:

- `request()` の戻り値で UI を組み立てない。
- popup を開き直したとき `permissions.contains()` で状態を復元し、許可済みなら CTA を出さない。
- 許可の結果を popup 側の変数に持たない。正本は `chrome.permissions`（§4.3）。

閉じるかどうかは Chrome のバージョンで揺れる。**自動テストできない**ので §36 の手動確認に項目として置く。

### 8.7 許可直後の再スキャン

`chrome.scripting.executeScript` は grant 後にしか効かない。CTA を押した瞬間に開いているタブは、
許可しただけでは何も起きない。`request()` が `true` を返したら、そのタブに対して
`automaticVisit()` を 1 回明示的に走らせる。

---

## 9. Stage 3 — 許可済みサイトの自動検知

### 9.1 起点

- `webNavigation.onCompleted`
- `webNavigation.onHistoryStateUpdated`

SPA も対象とする。**`frameId !== 0` は捨てる** — iframe の遷移でもイベントは来るが、
`executeScript` が読むのは主フレームなので、拾うと 1 ページで何度も読み、Jev も積む。

**listener は許可済み origin でフィルタして登録する。** フィルタ無しで登録すると、
host permission を持たないホストの遷移イベントまで届く（§0 で実測。github.com だけを許可した
probe 拡張に `127.0.0.1` の遷移が届いた）。DOM は読めないが URL は見えるので、
「未許可サイトでは何もしない」を実装で担保するにはフィルタが要る。

```ts
const filter = { url: hosts.map(hostEquals => ({ hostEquals })) };
chrome.webNavigation.onCompleted.addListener(handler, filter);
```

フィルタは登録時に固定されるので、許可の増減に追従して張り直す。

```ts
chrome.permissions.onAdded.addListener(() => void rewire());
chrome.permissions.onRemoved.addListener(() => void rewire());
```

`rewire()` は `permissions.getAll()` から origin を引き直し、
`removeListener` → `addListener` する。service worker の起動時にも 1 回走らせる。
これで §12.2 の「削除後は即停止」も listener の段で満たせる。

### 9.2 high-level API

新規モジュール:

`browser/autoDetect.ts`

概念 API:

```ts
export async function automaticVisit(
  tabId: number,
  url: string,
): Promise<void>;
```

### 9.3 automaticVisit

処理順:

1. supported catalog なら終了  
   既知サイトの既存経路が正本。
2. URL が http/https 以外なら終了
3. exact origin permission があるか確認
4. 前回と同一 normalized URL なら重複抑制
5. debounce
   **前ページのバッジを下ろすのはここを通り抜けたときだけ。** 先に下ろすと、SPA の
   `replaceState` で同じ URL の 2 回目が来たときに、直前に自分が出したバッジを消す。
6. `chrome.scripting.executeScript`
7. `extractPageEvidence()`
8. `narrowed()` → `resolveLocally()`
9. `found` / `many` だけを採る（§9.5）
10. GitHub 実在確認
11. result mapping
12. candidate state 反映（§10.3）
13. badge
14. `autoOpenEnabled` の既存挙動に合流

3 は listener のフィルタ（§9.1）と重複するが、フィルタの張り直しとイベントの競合を考えて
`automaticVisit` 側でももう一度 `permissions.contains()` を見る。

### 9.4 Jev API key がない場合

許可サイトでも Jev が必要なケースは判定不能になる。

- deterministic で `found` まで行けるものは検知
- Jev fallback が必要なら静かに `none` 相当
- 自動 popup で API key エラーを連打しない

popup を利用者が自分で開いた場合のみ、必要なら設定案内を表示する。

### 9.5 自動経路も Jev を呼ぶ。ただし上限を置く

自動経路は手動スキャンと同じ `detectWithJev()` を通す。決定論で決まるものは決定論で決め、
**コードが諦めたページだけ** Jev に「このページは Tool を配っているか」を訊く。

当初は「自動経路では Jev を呼ばない」で設計したが、それだと取得元しか書いていないページが
一切拾えない。実測: `https://supabase.com/docs/guides/ai-tools/ai-skills` は
Skill を名指しする直リンクが 1 本も無く（候補は repo のトップと docs のファイルだけ）、
`resolveLocally()` が `ask` を返して終わる。導入コマンドには
`npx skills add supabase/agent-skills --skill supabase` と書いてあるのに、
決定論だけでは「これは Tool 配布ページだ」と言い切れない。

代わりに、押さずに積む分へ上限を置く。

- `AUTO_JEV_LIMIT` 回 / `AUTO_JEV_WINDOW_MS`（`core/limits.ts`）。手動スキャンには掛けない。
- カウンタは `chrome.storage.local` の 1 キーに `{ start, count }` だけを置く。
  **どのサイトを見たかは保存しない。** service worker は止まるのでメモリには置けない。
- 訊き終えた URL は service worker のメモリに覚え、同じページを別タブで開いても再課金しない。
  読めなかっただけのもの（通信不能・枠切れ）は覚えない — 通信が戻れば出るはずのものを
  出ないまま固定しない。
- Beta トグルが切られている / 鍵が無いときは **Jev へ回る経路だけ**止まる。
  決定論で決まるページはそのまま検知する（鍵は推測の fallback だけの条件）。
- 枠と「訊き終えた URL」の確保は直列化する。同じページを複数タブで同時に開いても
  Jev は 1 回しか呼ばない。Jev が失敗したら記録を戻し、通信が戻れば再び訊けるようにする。

枠を使い切ったことは自動では告げない。利用者は押していないので、できることが無い。

## 10. 自動検知 result mapping

| `AiDetectResult` | 自動時の挙動 |
|---|---|
| `found` | badge `1`、必要なら既存 auto-open |
| `many` | badge に候補数。一覧は持たない（§10.3） |
| `repo` | skills.sh 形の URL に直して既存の一覧経路へ。badge は件数 |
| `none` | 何もしない |
| `unverified` | 自動通知しない |
| `unsupported-kind` | 自動通知しない |

### 10.1 unverified

自動 navigation のたびに「GitHub を確認できませんでした」を出すとノイズになる。

そのため自動経路では無表示。

利用者が popup を自分で開いたときにのみ確認不能状態を表示できる。

### 10.2 unsupported-kind

MCP / Plugin を検出しても自動 popup は開かない。

ブラウザ拡張の責務を Skill / Subagent に限定する既存方針を維持する。

### 10.3 既存 candidate state への載せ方

**ここが実装の山になる。** `background.ts` が持っているのは次の 3 つで、
`AiDetectResult` をそのまま置ける形になっていない。

```ts
const candidates = new Map<number, string>();          // タブごとに URL 1 本
const shown      = new Map<number, Index>();           // skillIndex 専用（source/subdir/entries）
const installed  = new Map<number, string>();
```

`activeCandidate()` の戻りも `{ url, index, installed }` で、popup 側の受け口もこの形に合わせてある。
`found` / `many` / `repo` を素直に足すと background の state と popup のメッセージ両方が増える。
§14.1 の「background を肥大化させない」と正面からぶつかる。

state を増やさずに済ませる形を採る。

- **`found`**: `lead.url` をそのまま `candidates` に入れる。popup は既存の解決経路を通る。
  background 側の変更は無い。
- **`many`**: badge に件数だけ出し、候補一覧は background に持たない。popup を開いたら
  既存の manual scan 導線（`showAiScanIfAvailable`）を走らせて、そこで一覧を出す。
  `many` は決定論で決まるので Jev を消費していない。popup 側で再実行しても課金は増えない。
- **`repo`**: 自動経路では出ない（§9.5）。Stage 1 は今まで通り `tab.ts` が
  `https://skills.sh/${repo}` のアダプタ URL に変換して既存経路へ渡す。

この形なら `candidates` / `shown` の型も `activeCandidate()` の戻りも変えずに済む。

---

## 11. 重複実行防止

### 11.1 問題

SPA / hydration / history change により同一 URL で複数イベントが発生しうる。

### 11.2 cache

service worker memory にのみ保持。

概念:

```ts
type ScanState = {
  url: string;
  fingerprint?: string;
  scannedAt: number;
};

const scans = new Map<number, ScanState>();
```

永続化しない。

### 11.3 debounce

300〜500 ms 程度を候補とする。

テストでは時間を注入可能にして deterministic にする。

### 11.4 fingerprint

必要なら以下から作る。

- normalized URL
- candidate repo identities
- title

同一 fingerprint なら Jev を再度呼ばない。

fingerprint も service worker memory のみ。

---

## 12. site permission 管理

`browser/sitePermissions.ts`

判定は 1 つしかない。**URL から exact origin pattern を作るところだけ**で、残りは
`chrome.permissions` の 1 行呼び出しである。ラッパを 5 本並べると、中身が 1 行の関数が
4 本増えるだけで守る不変条件は増えない。

```ts
/** `https://example.com/foo#x` → `https://example.com/*`。https 以外と、ホストが無い URL は `null`。 */
export function originPattern(url: string): string | null;
```

呼び出し側は `chrome.permissions` をそのまま使う。

```ts
const pattern = originPattern(url);
if (pattern === null) return;
await chrome.permissions.contains({ origins: [pattern] });   // 許可されているか
await chrome.permissions.request({ origins: [pattern] });    // ユーザー操作の中だけ（§8.5）
await chrome.permissions.remove({ origins: [pattern] });     // §12.2
(await chrome.permissions.getAll()).origins;                 // Allowed Sites（§12.1）
```

`getAll().origins` には manifest の `host_permissions`（github.com など）も混ざるので、
一覧に出すときは既知カタログのホストを除く。除外の基準は `core/github.ts` の `CATALOG_SITES`
を使い、Allowed Sites 側に第二の定義を置かない。

### 12.1 独自 DB を正本にしない

設定画面の Allowed Sites は `chrome.permissions.getAll()` から復元する。

### 12.2 Remove

```ts
chrome.permissions.remove({
  origins: ["https://example.com/*"],
});
```

削除成功後は即座に自動検知対象外になる。

---

## 13. 設定 UI

候補:

```text
AI-assisted detection (Beta)

Jev API key
••••••••••••••

Automatic detection

lazyskills.sh
Automatic detection enabled
[ Remove ]

smithery.ai
Automatic detection enabled
[ Remove ]
```

全サイト ON/OFF は提供しない。

### 13.1 現在サイトの提案

Tool 検証成功後のカードに:

```text
このサイトで今後も自動検知

このサイトを開いたとき、
Agent Tool が Skill / Subagent を自動的に探します。

[ 自動検知を有効にする ]
```

### 13.2 既に許可済み

同じ origin では permission CTA を出さない。

設定画面側で管理できる。

---

## 14. モジュール構成

```text
browser/
├── aiDetect.ts
├── aiSettings.ts
├── jev.ts
├── pageEvidence.ts
│
├── sitePermissions.ts    # new
├── autoDetect.ts         # new
│
├── background.ts
├── content.ts
├── tab.ts
└── manifest.json
```

### 14.1 background.ts

肥大化させない。

background は event wiring と既存 candidate state への橋渡しに限定する。listener は
許可済み origin でフィルタして張り、許可の増減で張り直す（§9.1）。

```ts
const handler = (details: { tabId: number; url: string }): void => {
  void automaticVisit(details.tabId, details.url);
};

async function rewire(): Promise<void> {
  const filter = { url: (await allowedHosts()).map(hostEquals => ({ hostEquals })) };
  for (const event of [chrome.webNavigation.onCompleted, chrome.webNavigation.onHistoryStateUpdated]) {
    event.removeListener(handler);
    event.addListener(handler, filter);
  }
}

chrome.permissions.onAdded.addListener(() => void rewire());
chrome.permissions.onRemoved.addListener(() => void rewire());
void rewire();                                    // service worker 起動時
```

既存の `onHistoryStateUpdated`（カタログの SPA 用、フィルタ無し）はそのまま残す。
自動検知の listener は別に張る — 1 本にまとめると、カタログ側までフィルタで落ちる。

自動判定本体は `autoDetect.ts`。

### 14.2 autoDetect.ts

Jev 固有の response schema を持たない。

`detectWithJev()` をそのまま使う。Jev の response schema は `jev.ts` に置いたままにする。
自動経路が足すのは、鍵・枠・訊き終えた URL の判定だけ（§9.5）。

### 14.3 sitePermissions.ts

`originPattern` だけを置く。`chrome.permissions` のラッパは書かない（§12）。

### 14.4 chrome.d.ts

`browser/chrome.d.ts` は使う分だけの手書きなので、以下を足す必要がある。

```ts
namespace permissions {
  function contains(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  function request(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  function remove(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  function getAll(): Promise<{ origins?: string[]; permissions?: string[] }>;
  const onAdded: { addListener(handler: () => void): void };
  const onRemoved: { addListener(handler: () => void): void };
}
namespace webNavigation {
  type Details = { tabId: number; url: string };
  type Filter = { url: { hostEquals?: string }[] };
  type Event = {
    addListener(handler: (details: Details) => void, filter?: Filter): void;
    removeListener(handler: (details: Details) => void): void;
  };
  const onCompleted: Event;
  const onHistoryStateUpdated: Event;   // 既存。removeListener と filter を足す
}
namespace action {
  function isEnabled(tabId?: number): Promise<boolean>;   // 使うなら
}
```

`scripting.executeScript` の既存の型（`func: () => T`）はそのままで足りる。

---

# 15. テスト方針

既存のテスト資産を維持する。

現在の構成:

- `test/*.test.js`: Node / CI
- `scripts/test-browser-e2e.mjs`: unpacked extension + Chromium
- `scripts/test-browser-catalogs.mjs`: 実 catalog
- `scripts/test-browser-jev.mjs`: 実サイト + 実 Jev API
- `scripts/e2e/popup-jev.mjs`: popup 導線を実ブラウザで確認
- `scripts/e2e/browser.mjs`: Playwright browser harness

今回も **Unit / Integration / Local Browser E2E / Real-site** を分ける。

---

## 16. Unit — sitePermissions

新規:

`test/sitePermissions.test.js`

### 16.1 originPattern

ケース:

```text
https://example.com/foo
→ https://example.com/*

https://sub.example.com/foo
→ https://sub.example.com/*

http://localhost:3000/foo
→ null                      # http は対象外（§8.3）

chrome://extensions
→ null

file:///tmp/a
→ null

javascript:alert(1)
→ null
```

### 16.2 ワイルドカード拡張禁止

```js
assert.notEqual(
  originPattern("https://sub.example.com/foo"),
  "https://*.example.com/*",
);
```

### 16.3 ポート・大文字・末尾スラッシュ

```text
https://Example.COM/foo     → https://example.com/*
https://example.com:8443/a  → null   # match pattern はポートを表せない
https://example.com         → https://example.com/*
```

ホスト名が空の URL（`https:///a`）は `null`。

### 16.4 request / remove / getAll のテストは書かない

`chrome.permissions` を呼ぶだけの経路にモックを当てても、確かめるのは
「引数をそのまま渡したか」だけで、モック自体の検証になる
（CLAUDE.md「モック自体を検証するテストは書かない」）。

渡す値の正しさは `originPattern` のテストで担保する。
実際に権限が付くこと・消えることは Playwright（§32）と手動確認（§36）で見る。

Allowed Sites が Chrome permission を正本にしていること（§12.1）は、
`getAll().origins` から既知カタログのホストを除く純粋関数を切り出して、そこだけ検査する。

---

## 17. Unit — autoDetect

新規:

`test/autoDetect.test.js`

依存は注入可能にする。

- permission checker
- evidence extractor
- detector
- announcer
- timer / clock

### 17.1 permission なし

期待:

- DOM extraction 0 回
- 決定論で決まるページは Jev 0 回
- GitHub verification 0 回
- badge 変更なし

### 17.2 permission あり

evidence extraction へ進む。

### 17.3 supported site

既知 catalog URL は automatic unknown-site path に入らない。

### 17.4 found

badge 1。

### 17.5 many

badge 件数だけ。候補一覧を state に持たない（§10.3）。

### 17.6 repo

直リンクが無く、Jev が Tool ページと答えたページ。取得元が 1 つに決まれば `repo`。
実測の基準ケースは Supabase Docs（§9.5）。

### 17.7 none

何もしない。

### 17.8 unverified

自動通知なし。

### 17.9 unsupported-kind

自動通知なし。MCP / Plugin はブラウザの導入対象外。

### 17.10 Jev の呼び出し回数

注入した `decide` の回数を固定する。

- 直リンクで決まるページ: 0 回
- まとめページ（`many`）: 0 回
- 取得元に解決できる候補が無いページ: 0 回
- 直リンクが無いページ: 1 回
- 鍵が無い / 枠切れ: 0 回
- 一度訊いた URL を別タブで開く: 0 回

枠そのものは `takeJevBudget` を注入ストレージで直接検査する。
保存するのが `{ start, count }` だけで、origin を含まないことも見る。

### 17.11 listener の張り直し

`permissions.onRemoved` 相当を発火させたあと、
`webNavigation.onCompleted.addListener` に渡された filter から
そのホストが消えていることを見る（§47.9）。

---

## 18. Unit — permission proposal

最重要 invariant:

**Tool が検証できただけでは `chrome.permissions.request()` を呼ばない。**

自動検知 permission の提案 state と request action を分離する。

例:

```text
manual scan
→ found
→ CTA visible
→ request count = 0

user click
→ request count = 1
```

### 18.1 Tool 無関係 fixture

一般 EC 相当:

```html
<h1>Product</h1>
<a href="https://github.com/company/repo">GitHub</a>
```

期待:

- permission proposal false
- permission request 0
- auto permission 0

### 18.2 技術ブログ相当

```html
<h1>How to use React</h1>
<pre>npm install react</pre>
<a href="https://github.com/facebook/react">GitHub</a>
```

期待:

- permission proposal false
- request 0

### 18.3 Tool fixture

```html
<h1>frontend-design</h1>

<a href="https://github.com/acme/skills/tree/main/skills/frontend-design">
Source
</a>

<pre>
npx skills add acme/skills --skill frontend-design
</pre>
```

GitHub verification mock success。

期待:

- result `found`
- permission CTA 可
- Chrome permission request はまだ 0

---

## 19. Unit — duplicate suppression

同 URL に短時間で複数イベント。

```text
automaticVisit()
automaticVisit()
automaticVisit()
```

期待:

- extraction 1
- detector 1
- Jev 最大 1
- verify 最大 1

URL 変更:

```text
/foo
→ /bar
```

は再検知。

### 19.1 test clock

実時間 sleep を避ける。

debounce scheduler / clock を注入するか、pure state machine を分離する。

CI の flaky 要因を増やさない。

---

## 20. Unit — Jev invariants

既存 `test/jev.test.js` を拡張する。

固定するもの:

- direct Tool link なら Jev を呼ばない
- repo-only でのみ Jev fallback（手動・自動の両方）
- 自動経路は枠を超えて呼ばない
- Jev `is_tool_page` だけで Install candidate を確定しない
- source が複数なら `none`
- MCP / Plugin は browser installer へ入らない
- malformed response reject
- API key が request body に入らない
- secret-looking text が payload に残らない
- query / credential / fragment が送られない

---

# 21. Playwright local E2E

新規:

`scripts/test-browser-auto-detect.mjs`

実サイトではなく localhost fixture を中心にする。

外部サイト障害や API rate limit に依存しない。

既存 `scripts/e2e/browser.mjs` を利用する。

---

## 22. Local fixture server

新規候補:

`scripts/e2e/site-fixtures.mjs`

Node の `http.createServer()` で十分。

**scheme に注意。** fixture は `http://localhost:<port>` になるが、
`optional_host_permissions` は `https://*/*` なので localhost には権限を付けられない
（§8.3 で https 限定と決めている）。テスト用 build に `http://localhost/*` を足すのは
§37 の「test-only host permission が混入しない」に反するので採らない。

したがって Playwright で確かめるのは次の 2 つに分ける。

- **拡張として**: 未許可 origin で何も起きないこと（§23）。fixture はそのまま使える。
- **モジュールとして**: 検知そのもの。`out/web/browser/autoDetect.js` を Node 側から
  直接呼び、evidence は `extractPageEvidence` をページ内で実行して取る
  （`scripts/test-browser-jev.mjs` と同じやり方）。permission checker は注入する。

fixture routes:

```text
/plain
/github-only
/blog
/tool-direct
/tool-repo-only
/tool-many
/spa
/secret
```

### /plain

Tool signal なし。

### /github-only

GitHub link だけ。

誤検知しない。

### /blog

GitHub link + code だが一般的技術記事。

permission 提案しない。

### /tool-direct

Skill 直リンク。

deterministic detection。

Jev 不要。

### /tool-repo-only

repo は分かるが Tool page 判定に Jev fallback が必要。

mock Jev を使う。

### /tool-many

複数 Tool。

勝手に 1 件選ばない。

### /spa

`history.pushState` で `/plain` → `/tool-direct` に変更。

reload なし。

### /secret

```text
export ANTHROPIC_API_KEY=sk-secret-value
Authorization: Bearer abc123
npx skills add acme/tools --skill foo
```

送信 payload に secret が残らないことを見る。

---

## 23. Playwright — permission 未許可

host permission をテスト用 build に追加しない。

Tool fixture へ遷移。

期待:

- automatic scan なし
- badge empty
- background が DOM extraction しない

これは「optional permission なしで勝手に読む」回帰を捕まえる。

---

## 24. Playwright — permission 取得済み状態

**テスト用 copy の manifest に localhost host permission を足す案は採らない。**
§37 の invariant に反し、配布物と違うものを検査することになる（§22 / §47.2）。

代わりに `automaticVisit()` をモジュールとして呼ぶ。permission checker を注入して
「許可済み」を表し、evidence は実ページから `extractPageEvidence` で取る。

```text
localhost/tool-direct をブラウザで開く
↓
extractPageEvidence() をページ内で実行
↓
automaticVisit 相当を注入済み permission checker で実行
↓
候補 1 件・Jev 呼び出し 0 回
```

拡張として動く形（badge が出るところまで）は §36 の手動確認で見る。

---

## 25. Playwright — SPA

`/spa` を開く。§24 と同じくモジュールとして呼ぶ。

初期状態:

- 候補なし

ページ内ボタン:

```js
history.pushState({}, "", "/tool-direct");
```

DOM も Tool fixture に変更。

期待:

- full reload なし
- pushState 後の DOM から候補 1 件
- 同一 URL の多重呼び出しで 1 回に畳まれる（§19）

---

## 26. Playwright — permission removal

permission 済み状態でまず Tool を検出。

その後 service worker から:

```js
chrome.permissions.remove({
  origins: ["http://127.0.0.1:<port>/*"]
});
```

別 Tool route へ遷移。

期待:

- badge 更新なし
- extraction なし
- Jev なし

重要 invariant:

**permission を削除した瞬間から自動解析しない。**

---

## 27. Playwright — Allowed Sites settings

permission 済み fixture で popup Settings を開く。

期待:

```text
Automatic detection

127.0.0.1
[ Remove ]
```

Remove 押下。

worker 側:

```js
chrome.permissions.contains(...)
```

が false。

UI からも行が消える。

---

## 28. Playwright — duplicate navigation

同じ SPA route に `replaceState` / `pushState` が複数回発生。

テスト hook で scan counter を観測する。

期待:

- 1 logical page state に対し scan 1 回
- Jev 最大 1 回

配布 build に telemetry を入れない。

テスト用 copy に限り service worker の test hook を入れるか、mock endpoint の request count で測る。

---

## 29. Playwright — Jev mock

Local E2E では実 Jev API を使わない。自動検知も Jev を通るので、mock は両方の導線で要る。

目的:

- deterministic
- offline
- API key 不要
- rate limit 無関係
- CI 昇格可能

候補:

1. Playwright route interception
2. テスト用 extension copy の endpoint 差し替え
3. localhost mock server

service worker fetch の route interception が環境で不安定なら、既存 `popup-jev.mjs` と同じく **テスト用 copy を編集する方式**を採用する。

配布物は不変。

---

## 30. Real-site / Real-Jev

既存 `scripts/test-browser-jev.mjs` を維持する。

将来 `--auto` モードを追加可能。

例:

```bash
node scripts/test-browser-jev.mjs --auto
```

確認:

- permission 済み test build
- manual scan button を押さない
- page navigation
- local deterministic resolve
- 必要なら real Jev fallback
- badge / index

Real-site test は CI に入れない。

---

## 31. 既存 catalog 回帰

`scripts/test-browser-catalogs.mjs`

`scripts/test-browser-e2e.mjs`

をそのまま維持する。

自動 unknown-site 機能を追加しても、

- GitHub
- skills.sh
- Agents Directory

は今まで通り deterministic path。

Jev request count = 0 を追加確認してもよい。

---

## 32. permission 周りの自動化限界

Playwright はネイティブの permission dialog を触れない。したがって:

| 状態 | 自動化 |
|---|---|
| 未許可プロファイルで起動 → 自動検知しない | できる |
| 許可済みプロファイルを用意して起動 → 自動検知する | できる |
| **CTA を押して「許可」を押す** | **できない** |
| permission 削除後に停止する | できる（`permissions.remove()` は SW から呼べる） |

許可済みプロファイルは、`permissions.request()` を通さずに作る。
`--load-extension` で上げた拡張の service worker から
`chrome.permissions.request()` は呼べない（ユーザー操作が要る）ので、
テスト用ホストを `host_permissions` に足した packaging は**作らない**
（§37 の「test-only host permission が混入しない」に反する）。

代わりに、Playwright の `context.serviceWorkers()[0].evaluate()` で
`chrome.permissions.getAll()` を読んで listener の張り方を確かめ、
自動検知そのものは `automaticVisit()` を直接呼んで確認する。
`scripts/test-browser-jev.mjs` が既に `out/web/browser/*.js` を直接 import して
段ごとに確かめているので、同じやり方でよい。

「許可を押す」導線は §36 の手動確認に残す。

---

# 33. テストマトリクス

| ケース | Unit | Playwright local | Real site |
|---|---:|---:|---:|
| 無関係ページで permission 提案なし | ✅ | ✅ | |
| GitHub link だけで誤検知しない | ✅ | ✅ | |
| Tool 検証後だけ permission CTA | ✅ | ✅ | |
| `originPattern` がサブドメイン・全 Web へ広げない | ✅ | | |
| 未許可ホストの遷移が listener に届かない | | ✅ | |
| 許可の増減で listener を張り直す | ✅ | ✅ | |
| Tool 発見だけでは permission request しない | ✅ | ✅ | |
| permission なしでは自動 scan しない | ✅ | ✅ | |
| permission ありなら遷移だけで検知 | ✅ | ✅ | |
| SPA pushState 自動検知 | | ✅ | |
| 同 URL 二重 scan 防止 | ✅ | ✅ | |
| permission 削除後は停止 | ✅ | ✅ | |
| direct Skill は Jev を呼ばない | ✅ | ✅ | ✅ |
| repo-only は Jev fallback（Stage 1 のみ） | ✅ | mock Jev | ✅ |
| 自動経路の Jev 呼び出しが枠で止まる | ✅ | | |
| 決定論で決まるページは自動でも Jev 0 回 | ✅ | ✅ | |
| secret redaction | ✅ | ✅ | |
| fragment 限定抽出 | ✅ | ✅ | ✅ |
| many は勝手に 1 件選ばない | ✅ | ✅ | ✅ |
| unverified を自動通知しない | ✅ | ✅ | |
| 既存 catalog 回帰 | ✅ | | ✅ |
| API key が content script から読めない | ✅ | ✅ | |
| `<all_urls>` 必須権限なし | invariant | package check | |
| 権限が 4 つから増えていない | invariant | package check | |

---

## 34. CI に入れるもの

初期実装時:

```text
test/sitePermissions.test.js    # originPattern だけ
test/autoDetect.test.js
test/jev.test.js
test/pageEvidence.test.js
test/browserBackground.test.js  # listener の張り直しを含む
```

および既存:

- typecheck
- invariant checks
- browser package check
- release checks

Local Playwright は最初は optional。

安定確認後、

```text
npm run test:browser:local
```

として CI 昇格を検討する。

---

## 35. CI に入れないもの

- 実 Jev API
- 実未対応 catalog
- GitHub API rate limit に依存するケース
- browser native permission prompt の UI 自動操作
- Chrome toolbar icon の実クリック

これらは manual / opt-in E2E。

---

## 36. 手動確認

Playwright で完全再現できない部分を明示する。

### Chrome / Edge / Brave

各ブラウザで:

1. 未対応 Tool ページを開く
2. Agent Tool を開く
3. 手動 scan
4. Tool 検証成功
5. 「このサイトで自動検知」
6. Agent Tool の説明
7. Chrome permission dialog
8. 許可
9. **許可直後、開いたままのタブで badge が出る**（§8.7）
10. 同 origin の別 Tool ページへ移動
11. manual scan なしで badge
12. permission Remove
13. 次の Tool ページでは自動検知しない

### popup が閉じるか（§8.6）

7 で Chrome permission dialog が出たとき、Agent Tool の popup が閉じるかを 3 ブラウザで見る。
閉じる場合でも:

- 許可は成立している
- popup を開き直すと CTA が消えている（`permissions.contains()` から復元できている）
- エラー表示が残らない

ことを確認する。Playwright では再現できない（§32）。

### セキュリティ確認

- content script から Jev API key を読めない
- `chrome.storage.local` access level が trusted contexts
- 未許可 origin で scripting を実行しない
- permission request が Tool 未確認サイトでは出ない
- 未許可サイトを普通に閲覧しても service worker が起きない
  （`chrome://extensions` の service worker を開いたまま遷移して確かめる）

---

# 37. Package / invariant checks

`scripts/check-browser-package.mjs` などで以下を固定する。

- 必須 `host_permissions` に `https://*/*` がない
- content script `matches` に `<all_urls>` がない
- optional host permission 以外で全 Web を取らない
- `permissions` は `webNavigation` / `activeTab` / `scripting` / `storage` の 4 つのまま
  （`allowedPermissions` を広げない。`declarativeContent` は足さない。§6）
- Jev endpoint は TypeSafe のみ
- browser package に test-only host permission が混入しない

---

## 38. Privacy / Store listing 更新

実装時に必須。

現在は Jev 通信条件として **Find tools on this page をクリックした場合**と記載している。

自動経路も Jev を呼ぶので、**この記述を広げる必要がある。**

```text
TypeSafe AI / Jev is contacted only when local resolution cannot decide
whether a page ships a tool, and only:

- when you click Find tools on this page, or
- on a site for which you explicitly enabled automatic detection.

Automatic detection is capped per hour. Only a counter is stored for that —
never the sites you visited.

Removing a site's permission stops automatic detection immediately.

Agent Tool does not see navigations on sites you have not allowed: the
navigation listener is scoped to the origins you granted.
```

明示するもの:

- exact origin permission
- optional permission
- Jev は local 判定で決まらないときだけ。自動経路には 1 時間あたりの上限がある
- 自動検知の navigation listener は許可済み origin に絞ってある
- full HTML 非送信
- browsing history 非保存
- site permission 一覧は Chrome permission API が正本

`PRIVACY.md` の Permissions 節に `optional_host_permissions` の行を足す。
README（英日）にも自動検知の有効化手順を 1 節足す。

---

## 39. 実装順

Phase A → **C** → B の順にする。CTA（B）を先に作ると、自動検知が本当に動くかを
確かめないまま UI と文言を決めることになる。C を先に通せば §9.5（Jev の上限）と
§10.3（candidate state の載せ方）が早く露出し、B の文言もそれに合わせて書ける。

### Phase A — permission model

1. `sitePermissions.ts`（`originPattern` だけ）
2. unit tests
3. manifest `optional_host_permissions`
4. `chrome.d.ts` に `permissions` / `webNavigation` を足す
5. package invariant（権限が 4 つのままであること）

### Phase C — automatic detection

1. `autoDetect.ts`
2. webNavigation wiring（許可済み origin のフィルタ + 張り直し。§9.1 / §14.1）
3. debounce / cache
4. result mapping（§10.3 の形。background の state を増やさない）
5. existing auto-open integration

### Phase B — UI proposal

1. Tool 検証済み時だけ CTA
2. Agent Tool explanation
3. permission request（popup が閉じても壊れない形。§8.6）
4. 許可直後の再スキャン（§8.7）
5. Allowed Sites settings
6. remove
7. `l10n/` ではなく `browser/_locales/{en,ja}/` を同時に更新

### Phase D — prefilter（削除）

実装しない。理由は §6。

### Phase E — Browser E2E

1. localhost fixture server
2. permissionなし
3. permission済み
4. SPA
5. permission removal
6. Jev mock
7. settings

### Phase F — Real site

既存 Jev / catalog scripts を回帰確認。

---

## 40. 実装前の確定事項

この設計では以下を確定とする。

1. 自動検知はサイト単位 exact origin。
2. 全サイト自動検知は提供しない。
3. optional permission request は Tool 検証後だけ提案する。
4. Chrome permission dialog は明示クリック後だけ。
5. declarativeContent prefilter は実装しない（§6）。
6. permission 正本は `chrome.permissions`。
7. Jev は local 判定の fallback。自動経路でも呼ぶが、1 時間あたりの上限を置く（§9.5）。
8. Jev だけで Install candidate にしない。
9. 既知 catalog は既存 deterministic path。
10. permission 削除後は即停止。
11. 自動経路の `unverified` は静かに扱う。
12. Node test と実 Chromium E2E の両方を持つ。
13. 実 Jev / 実 catalog は CI から分離する。
14. browser-native permission prompt 自体は手動確認を残す。
15. `webNavigation` の listener は許可済み origin でフィルタし、許可の増減で張り直す（§9.1）。
16. background の候補 state（`candidates` / `shown` / `activeCandidate()`）の形は変えない（§10.3）。
17. 許可済みサイトでは、popup を開いた時点で候補が出ている。手動スキャンのカードは出ない（§47.10）。

---

# 41. 採用判断

この方式を採用する。

最も重要な設計原則は次の一文。

> **Tool を見つけるためにサイト権限を要求するのではなく、Tool を確認できたサイトに対してのみ、その origin の自動検知権限を提案する。**

これにより、

- 無関係なサイトで permission dialog を出さない
- 全 Web 権限を持たない
- Jev への不要な送信を抑える
- 現在の Beta の安全境界を維持する
- 自動検知 UX を追加できる

という要求を同時に満たせる。

実機検証（§0）の後も、この判断は変えない。変わったのは手段の 2 つだけである。

- 無関係なサイトで何も起きないことは、prefilter ではなく **listener のフィルタ**が保証する。
- Jev への送信は、決定論で決まるページでは 0 回。自動経路には上限を置いて青天井にしない。

---

## 42. 参考

Chrome Extensions:

- Permissions API  
  https://developer.chrome.com/docs/extensions/reference/api/permissions
- Optional permissions  
  https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- webNavigation（イベントフィルタ）  
  https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-filtering
- scripting  
  https://developer.chrome.com/docs/extensions/reference/api/scripting
- User privacy  
  https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy
- Chrome Web Store user data policy  
  https://developer.chrome.com/docs/webstore/program-policies/user-data

TypeSafe / Jev:

- Introducing System One Models and Jev  
  https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Choice primitive  
  https://docs.typesafe.ai/primitives/choice
- Quickstart  
  https://docs.typesafe.ai/introduction/quickstart


---

# 43. 別スレッド・別担当者向けの実装引き継ぎ

この章は、現在の会話コンテキストを持たない別スレッド・別担当者でも、実装順・判断基準・注意点を取り違えないための実行ガイドとする。

## 43.1 最初に確認すること

実装を始める前に必ず以下を確認する。

1. 作業ブランチの base が最新 `main` から大きく乖離していないこと。
2. Jev Beta が既に `main` に存在すること。
3. `browser/pageEvidence.ts` / `browser/aiDetect.ts` / `browser/jev.ts` の責務分離が維持されていること。
4. `browser/background.ts` の既存 candidate / badge / auto-open 管理を確認すること。
5. 既存 Playwright:
   - `scripts/test-browser-e2e.mjs`
   - `scripts/test-browser-jev.mjs`
   - `scripts/e2e/popup-jev.mjs`
   - `scripts/e2e/browser.mjs`
   を読んでから新しい E2E を作ること。
6. `PRIVACY.md` と Chrome Web Store 向け文書が「手動 Jev 実行」の説明になっていることを認識すること。

main が更新されている場合は、まず差分を確認し、設計書の前提が壊れていないかを見る。

---

## 43.2 実装優先度

優先度は以下。

### P0 — 安全境界

最優先。ここが崩れる変更は UI が動いてもマージしない。

- exact origin のみ許可
- 未許可 origin で DOM を読まない
- 未許可 origin の遷移イベントを受け取らない（listener をフィルタする。§9.1）
- Tool 検証前に permission request を出さない
- permission request を user gesture 外から呼ばない
- `<all_urls>` を必須権限にしない
- Jev だけで Install candidate にしない
- permission remove 後は即停止
- secret / query / credential / fragment 非送信

- 自動経路の Jev 呼び出しに上限があり、上限の記録に origin を含めない（§9.5）

### P1 — permission model

- `sitePermissions.ts`（`originPattern` のみ）
- optional host permission
- `chrome.d.ts` の追加
- package invariant（権限が 4 つのまま）

### P2 — automatic detection core

- `autoDetect.ts`
- navigation event wiring（フィルタ + 張り直し）
- duplicate suppression
- result mapping（background の state を増やさない。§10.3）
- existing badge / auto-open 連携

### P3 — permission CTA / UX

- Tool 検証後だけ CTA
- Agent Tool の事前説明
- request button（popup が閉じても壊れない。§8.6）
- 許可直後の再スキャン（§8.7）
- 既許可 site では CTA 非表示
- settings で一覧 / remove

### P4 — declarativeContent prefilter（削除）

実装しない。理由は §6。

### P5 — Local Playwright E2E

- localhost fixture
- permission 未許可
- permission 済み
- SPA
- remove
- Jev mock

### P6 — Real-site / Real-Jev

最後。

実サイト差分を見ながら必要なら調整するが、実サイトに合わせて安全境界を緩めない。

---

# 44. 推奨実装順

以下の順番を推奨する。

## Step 1 — sitePermissions.ts を先に作る

理由:

自動検知より先に「どの site を読んでよいか」を独立モジュールとして確定させるため。

この段階では UI も navigation も触らない。

最低 API:

```ts
export function originPattern(url: string): string | null;
```

`chrome.permissions` のラッパ（`isAllowed` / `requestCurrentSite` / `removeSite` /
`allowedSites`）は書かない。中身が 1 行で、守る不変条件を増やさない（§12）。

### 完了条件

- exact origin になる
- wildcard subdomain を作らない
- unsupported scheme は null
- package invariant が通る

---

## Step 2 — Manifest の optional host permission

`optional_host_permissions` を追加する。

ただしこの時点では自動検知を起動しない。

### 完了条件

- package browser 成功
- `<all_urls>` 必須権限なし
- test build 以外で localhost 等の不要な host permission が混ざらない

---

## Step 3 — Permission CTA を manual flow に追加

既存手動 Jev Beta の検出結果に対してのみ追加する。

この段階では「許可後に自動検知」はまだ不要。

### 実装条件

CTA を出してよいのは:

- `found`
- `many`
- `repo` かつ一覧取得成功

出してはいけない:

- `none`
- `unverified`
- `unsupported-kind`

### 完了条件

- Tool が見つかっただけでは `permissions.request` は 0 回
- CTA click 後だけ request 1 回
- request origin が exact origin
- deny しても既存 manual flow は壊れない
- permission dialog で popup が閉じても、開き直すと CTA が消えている（§8.6）
- 許可直後、開いたままのタブで検知が走る（§8.7）
- `browser/_locales/{en,ja}/` のキーが揃っている

---

## Step 4 — Settings の Allowed Sites

`chrome.permissions.getAll()` を正本に表示する。

### 完了条件

- reload 後も Chrome permission から一覧復元
- Remove で permission が消える
- 独自 DB が空でも動く
- Jev API key settings と責務が混ざらない

---

## Step 5 — autoDetect.ts

ここで初めて automatic path を作る。

重要:

`autoDetect.ts` は Chrome API 呼び出しと判定ロジックを混ぜ過ぎない。

依存注入できるようにして Node test 可能にする。

### 最初の実装範囲

まずは:

- permission check
- evidence extraction
- `narrowed()` → `resolveLocally()`
- GitHub 実在確認（`confirms()`）
- result mapping

だけ。Jev は `detectWithJev()` の中からしか呼ばない（§9.5）。

debounce / cache は次 step でもよい。

### 完了条件

- permission なし → extraction 0
- permission あり → detection
- found → badge
- many → badge に件数（一覧は持たない）
- none → no-op
- unverified → no-op
- unsupported-kind → no-op
- **`decideWithJev` が 1 回も呼ばれない**（注入した偽実装で数える）

---

## Step 6 — background.ts へ navigation wiring

`background.ts` を太らせない。

event listener から `automaticVisit()` を呼ぶだけに近づける。

### 完了条件

- `onCompleted`
- `onHistoryStateUpdated`

の両方から呼ばれる。

既知 site は既存 path が正本で、新 automatic unknown-site path に二重投入されない。

listener は許可済み origin でフィルタして張る（§14.1）。加えて:

- `permissions.onAdded` / `onRemoved` で張り直す
- service worker 起動時にも 1 回張る
- カタログ用の既存 `onHistoryStateUpdated`（フィルタ無し）は別 listener のまま残す
- 許可を消した直後、同じタブの遷移で `automaticVisit` が呼ばれない

---

## Step 7 — duplicate suppression

SPA や hydration で多重発火するため必須。

### 完了条件

- 同一 URL 連続イベント → logical scan 1
- URL 変更 → 再 scan
- Jev 最大 1 回
- service worker 再起動時に永続 cache を要求しない

---

## Step 8 — Local Playwright fixture

外部サイトより先に localhost で E2E を固定する。

この時点で初めて browser integration が本当に通ることを確認する。

### 最低ケース

- permission 無し
- permission 済み direct tool
- SPA
- remove
- settings

---

## Step 9 — declarativeContent（削除）

実装しない。理由は §6。`declarativeContent` 権限も足さない。

---

## Step 10 — Privacy / Store 文書

コードと同時に更新する。

後回しにし過ぎない。

**Jev の通信条件が変わる**（自動経路からも呼ぶ）。新しい optional permission と
自動検知そのものと合わせて、`PRIVACY.md` / README（英日）/ ストア掲載文の 3 箇所。
リリース前必須。

---

## Step 11 — Real-site / Real-Jev

最後に確認する。

既存:

`scripts/test-browser-jev.mjs`

を拡張する場合も、local E2E の代わりにしない。

---

# 45. 推奨コミット分割

レビューしやすくするため、可能なら以下の単位でコミットする。

1. `feat(browser): add site-scoped permission helpers`
2. `test(browser): cover site permission boundaries`
3. `feat(browser): offer automatic detection for verified sites`
4. `feat(browser): list and revoke allowed sites`
5. `feat(browser): add automatic detection on allowed sites`
6. `test(browser): cover automatic detection state transitions`
7. `test(browser): add local automatic-detection e2e`
8. `docs(browser): disclose site-scoped automatic detection`

1 commit に全部押し込まない。

特に permission model と automatic detection は分ける。

---

# 46. 変更してはいけない既存設計

別スレッドで実装する際に、以下を「簡単になるから」という理由で変更しない。

## 46.1 known catalogs

GitHub / skills.sh / Agents Directory の deterministic path を Jev path へ統合しない。

## 46.2 Jev の役割

Jev に repo URL / Tool 名を自由生成させない。

## 46.3 all-sites permission

実装簡略化のために `<all_urls>` や `https://*/*` を必須 `host_permissions` へ移さない。

## 46.4 permission DB

Chrome permission と独自 storage の二重正本を作らない。

## 46.5 background.ts

巨大な condition tree を追加しない。`candidates` / `shown` / `installed` と
`activeCandidate()` の形を変えない（§10.3）。

## 46.6 unverified

通信失敗を `none` と同一視し、ユーザーへ「Tool はありません」と断定しない。

---

# 47. 特に壊しやすい点

## 47.1 activeTab と optional host permission の違い

`activeTab` は一時権限。

optional host permission は継続権限。

manual scan と automatic scan のコード経路を混同しない。

## 47.2 Playwright と Chrome UI

Playwright は toolbar icon / native permission prompt を完全には扱えない。

**「許可を押す」導線は自動化できない**（§32）。

`test build に host permission を付けて「許可済み」を再現する`案は採らない。
§37 の「browser package に test-only host permission が混入しない」に反し、
配布物と違うものをテストすることになる。

代わりに:

- service worker から `chrome.permissions.getAll()` を読んで listener の張り方を確かめる
- 自動検知そのものは `out/web/browser/autoDetect.js` を直接呼んで確かめる
  （`scripts/test-browser-jev.mjs` と同じやり方）
- native prompt 自体は manual check（§36）

## 47.3 service worker lifecycle

MV3 worker は停止・再起動する。

scan cache を correctness の正本にしない。

cache が消えても安全に再 scan できるようにする。

## 47.4 SPA

`onCompleted` だけでは不足。

`onHistoryStateUpdated` が必要。

ただし同じ URL の多重 event に注意。

## 47.5 repo-only

`repo` result は Tool 名まで確定していない。

一覧取得成功前に permission CTA を出さない。

## 47.6 many

複数候補を 1 件へ勝手に絞らない。

## 47.7 API key 不在

許可 site でも deterministic result は出せる。

自動経路は Jev を使わないので、API key の有無で自動検知の挙動は変わらない（§9.5）。

## 47.8 privacy text

権限と自動検知の説明を足さずにリリースしない。Jev の通信条件自体は変わらない。

## 47.9 webNavigation のフィルタ

フィルタを付け忘れると、許可していない全サイトの遷移で service worker が起きる。
DOM は読めないので機能は動いてしまい、テストも緑になる。**挙動では気づけない。**

`browserBackground.test.js` で「`addListener` に filter 付きで渡している」ことと、
「`permissions.onRemoved` 後に張り直している」ことを直接見る。

## 47.10 テスト用 build の host permission は自動検知の許可でもある

`scripts/e2e/popup-jev.mjs` は `activeTab` の代わりに、コピーした拡張の
`host_permissions` へ対象サイトを足している。許可の正本は `chrome.permissions` で、
**manifest 由来と実行時付与を区別できない**（`getAll()` は両方を混ぜて返す）ので、
このテストでは自動検知も動く。

実測: 直リンクの 6 ページは popup を開いた時点で既に `#found` が出ており、
「スキャンのカードが出ていない」で落ちた。製品の不具合ではなく、
**許可済みサイトの正しい挙動**（自動検知が先に解いたので手動スキャンが要らない）。

テスト側は「押す前に出ているならそれを結果として読む」に直した。取得元だけのページと
まとめページは自動経路では解けない（`repo` / `many`）ので、手動導線の検査は残る。

## 47.11 candidate state

`AiDetectResult` を background の state にそのまま足さない。`found` は URL 1 本で足り、
`many` は件数だけ、`repo` は自動経路に出ない（§10.3）。ここを広げると popup 側の
メッセージ形式まで波及する。

---

# 48. 実装中のレビュー観点

各 PR / commit で以下を見る。

### Security

- 未許可 origin の DOM を読んでいないか
- 未許可 origin の遷移イベントを受け取っていないか（listener に filter が付いているか）
- request origin が exact か
- secret が Jev payload に入らないか
- arbitrary URL を fetch していないか

### Architecture

- background.ts が肥大化していないか
- site permission と scan logic が分離されているか
- Jev schema が autoDetect に漏れていないか
- known catalog path と重複していないか
- background の candidate state と popup のメッセージ形式が増えていないか

### UX

- 無関係 site で何も出ないか
- permission prompt の前に説明があるか
- deny 後にしつこく再提案しないか
- remove が分かりやすいか

### Tests

- happy path だけでなく no-op path を固定しているか
- permission request count = 0 を検証しているか
- Jev call count = 0 の deterministic path を検証しているか
- 自動経路の Jev call count = 0 を検証しているか

---

# 49. PR 作成前チェックリスト

以下を全部確認してから PR を作成する。

## Build / static

- [ ] typecheck
- [ ] `npm test`
- [ ] `./scripts/check-invariants.sh`
- [ ] browser package success
- [ ] release changelog checks

## Permission

- [ ] 必須 host permission に全 Web がない
- [ ] optional origin が exact
- [ ] Tool 未確認 site で request 0
- [ ] user click 外から request 0
- [ ] remove 後に contains false
- [ ] `permissions` が 4 つのまま（`declarativeContent` を足していない）
- [ ] listener が許可済み origin で filter されている

## Detection

- [ ] known catalog regression なし
- [ ] direct Tool は Jev 0 回（手動・自動とも）
- [ ] repo-only だけ Jev fallback
- [ ] 自動経路の枠切れで黙る
- [ ] 枠の保存に origin が含まれない
- [ ] many を 1 件へ絞らない
- [ ] unverified 自動通知なし

## Browser

- [ ] localhost direct tool
- [ ] permission 未許可
- [ ] permission 済み
- [ ] SPA
- [ ] permission remove
- [ ] settings list/remove

## Privacy

- [ ] PRIVACY.md 更新
- [ ] browser store listing 更新
- [ ] README / README.ja の説明が実装と一致

---

# 50. 別スレッド開始時の推奨プロンプト

別スレッドで作業を再開する場合は、最低限以下を伝えれば続行できる。

```text
den0206/agent-tool の最新 main と、
docs/automatic-site-detection-design.md を読んでください。

この設計書を正本として、
site-scoped optional permission による automatic Tool detection を実装します。

必ず:
- P0 safety boundaries
- 実装優先度
- 推奨実装順
- テスト設計
- PR前チェック
を守ってください。

既知 catalog の deterministic path は変更せず、
Jev は手動スキャンの fallback に限定してください（自動経路では呼びません）。
§0 の実機検証結果と、そこで確定した 4 つの設計修正を前提にしてください。

まず main と設計書の差分を確認してから着手してください。
```

---

# 51. Definition of Done

この機能を「実装完了」とみなす条件。

1. Tool と無関係な site で permission dialog が出ない。
2. 未許可 site は自動で DOM を読まない。
3. verified Tool site にだけ automatic detection CTA が出る。
4. user click 後だけ exact origin permission を request する。
5. permission 済み site は navigation だけで Tool 検知できる。
6. deterministic path では Jev を呼ばない（手動・自動とも）。
7. 自動経路の Jev 呼び出しに上限があり、決定論で決まるページでは消費しない。
8. permission remove 後は即停止する。
9. SPA navigation でも動く。
10. duplicate scan を抑制する。
11. localhost Playwright E2E が通る。
12. 既存 catalog E2E を壊さない。
13. Privacy / Store disclosure が実装と一致する。
14. package に test-only permission が混ざらない。
15. 手動 Chrome / Edge / Brave 確認項目が完了している。
16. `permissions` が 4 つのまま増えていない。
17. 未許可 site の遷移で service worker が起きない。

