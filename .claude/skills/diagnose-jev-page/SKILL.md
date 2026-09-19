---
name: diagnose-jev-page
description: 未対応サイトの Tool ページを Jev 補助検知で拾えるようにする。対応サイトではない URL を渡されて「検知されない」「Jev で見つからない」と言われたときに使う。サイト固有の実装を足さず、候補の作り方と照合（抽出・絞り込み・照合・質問文）だけで汎用に直す。対応サイトなら diagnose-tool-page へ回す。
---

# 未対応ページが Jev 検知に乗らないのを調べる

渡された URL が **対応サイトではない** のに Jev 補助検知でも拾えない、を扱う。

この機能は **Beta** である（`docs/agent-tool-security.md` §10.5）。撤去できる形を保つこと自体が
仕様なので、`core/` に Jev 固有の型を漏らさない。撤去手順は
`docs/agent-tool-release-plan.md`「Beta 機能の撤去」にある。

## 絶対に守る3点

1. **「どれが取得元か」をモデルに訊かない。** Jev が答えるのは「このページは Tool を
   配っているか」と種別だけで、取得元と名前は `resolveLocally` の照合が決める。
   モデルに選ばせて外れを補正し始めると、1 サイト直すたびに別のサイトが壊れる
   （実測でその連鎖を起こした）。閾値も下げない。
2. **送る情報を増やさない。** 増やすなら `PRIVACY.md`・`docs/browser-store-listing.md`・
   `docs/agent-tool-security.md` §10.5 を同時に直す。ページ全文・フォーム値は送らない。
3. **決定論的経路を Jev に置き換えない。** 対応サイトは `core/github.ts` が正本。
   URL 規約か JSON-LD で解けるサイトなら [`add-catalog-site`](../add-catalog-site/SKILL.md) の方が正しい。

---

## 0. 先にやる3つ（順番を守る）

### 0.1 どのSkillの担当かを決める

```bash
npm run compile
node --input-type=module -e '
import { catalog, parseUrl, needsPage } from "./out/web/core/github.js";
const url = process.argv[1];
console.log("catalog  :", JSON.stringify(catalog(url)));
console.log("parseUrl :", JSON.stringify(parseUrl(url)));
console.log("needsPage:", needsPage(url));' "<URL>"
```

| 結果 | 担当 |
|---|---|
| どれか 1 つでも `null` 以外 | **対応サイト。** [`diagnose-tool-page`](../diagnose-tool-page/SKILL.md) へ回す |
| 全部 `null` | ここで続ける |

全部 `null` でも、**URL 規約だけで `owner/repo` と名前が決まるサイト**なら
`add-catalog-site` の方が良い（ネットワークにも AI にも触れずに解ける）。
Jev が要るのは、URL にも JSON-LD にも取得元が出ていないページである。

### 0.2 鍵とGitHub APIの残量

```bash
node --input-type=module -e '
const r = await fetch("https://api.github.com/rate_limit").then(x => x.json());
console.log("GitHub remaining:", r.resources.core.remaining);'
```

`JEV_TOKEN` は環境変数か `.secret` に置く。**出力・ログ・コミットに鍵を出さない。**
GitHub の残量が一桁なら実在確認が `fetchFailed` で落ち、「サイトが悪い」と取り違える。

### 0.3 段を固定する

```bash
npm run package:browser
node scripts/test-browser-jev.mjs "<URL>"
```

実ブラウザでページを開き、拡張と同じ `extractPageEvidence` を同じやり方で動かして、
**1 抽出 → 2 Jev の回答（呼ばないこともある）→ 3 解決と実在確認** を段ごとに出す。推測で直さない。

---

## 1. 段ごとの原因と対処

解決は 3 段で、落ちた段によって直す場所が違う。

```
抽出 → 照合（決定論）→ 足りなければ Jev に 1 問だけ
```

### 1-1. 候補が 0 件

ページが github.com のリンクも導入コマンドも出していない。**まず本当に無いかを確かめる。**

```bash
node --input-type=module -e '
const html = await (await fetch(process.argv[1])).text();
console.log("github リンク:", [...html.matchAll(/github\.com\/[\w.-]+\/[\w.-]+/g)].length);
console.log("skills add  :", /skills\s+add/.test(html));' "<URL>"
```

どちらにも無いなら §3。ページが取得元を出していない。

### 1-2. 照合が外れて「一覧」になる（`many`）

`resolveLocally` は **ページの URL 末尾・`#fragment`** と、候補から `lead()` が取り出した
Skill 名を突き合わせる。一致が 1 件なら決まり、複数・ゼロなら一覧になる。

一覧は**誤りではない**。まとめページで 1 件に決め打つ方が誤りである。個別ページに
`#fragment` があるなら、そこを開けば 1 件に決まる。

照合に見出しや本文を足したくなったら止まること。**まとめページの見出しには載っている
Tool 全部の名前が並ぶ**ので、混ぜると全件が「一致」して壊れる（実測済み）。

### 1-3. 直リンクはあるのに実在確認で落ちる

`confirms` は `proofs` があれば raw の HEAD 1 回。**サイト側のデータ誤りと決めつける前に、
実体を叩く。** `SKILL.md` が 200 なら `core/` の読み違いで、直すのはこちら側である。

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>/SKILL.md"
```

```
実測: aitmpl.com は Skill ディレクトリを `/blob/` で案内していた（GitHub は
     `/blob/<ref>/<dir>` を `/tree/` へ読み替えるので画面上は正しく開く）。
     → `components()` で「末尾に拡張子が無ければディレクトリ」と読む
```

`core/` を直したら `node scripts/test-browser-catalogs.mjs` まで流す。

### 1-4. 直リンクが無く、取得元が割れる

`aiDetect` は**導入コマンドに書かれた repo** をリンクより優先する。コマンドは「入れ方」
そのもので、ページに並ぶ参考リンクより強い。それでも 2 つ以上に割れたら出さない
（推測で無関係なリポジトリを見せない）。

ここで足すとしたら「コマンドから repo を読む形」の追加であって、サイト名の分岐ではない。

### 1-5. `is_tool_page` が 0.80 未満

直リンクが 1 つも無いページでだけ効く。**閾値を下げない。** 問い方が合っているかを疑う。

```
実測: 「このページは主に Tool を説明しているか」と訊いていたため、解説ガイドが
     0.75〜0.87 で揺れて同じページが通ったり落ちたりした。
     →「導入できるものを伝えて入手先を示しているか」に変えて 0.86〜0.87 に安定。
        対照（普通のガイド）は 0.14〜0.15 まで下がり、判別力はむしろ上がった
```

問い方を変えたら**必ず対照ページでも測る**。片方を通すために締めると、もう片方が落ちる。

---

## 2. 直すときの規律

- 直す場所は4つ。**抽出**（`pageEvidence.ts`）・**絞り込み**（`narrowed`）・
  **照合**（`resolveLocally`）・**質問文**（`jev.ts`）。ゲートの数値は触らない
- 「どれが取得元か」をモデルに戻さない。外れを補正する規則は別のページを壊す
- 例外は §1-3 で実体が 200 だったとき。`core/` の読み違いなので `core/` を直す。
  そのときは決定論的経路の回帰（`node scripts/test-browser-catalogs.mjs`）まで必ず流す
- 抽出はページの HTML 構造（タグ・class・入れ子）に依存させない。壊れたときに静かに死ぬ
- `pageEvidence.ts` の関数は**ページの中で動く**。module scope のヘルパを参照しない
  （`chrome.scripting.executeScript` は関数本体だけを送る）
- 候補を増やしたら**送信量も増える**。上限（件数・長さ）を合わせて見直す
- サイト固有の分岐を `narrowed` に足さない。ホスト名で分けたくなったら、それは
  `add-catalog-site` の仕事である
- 直す前に §0.3 の出力を控え、直したあと同じものを流して**段が進んだこと**を示す

---

## 3. 実装しないと判断する条件

次に当たったら**直さない**。原因と根拠（出力・叩いた URL とその応答）を利用者へ返す。

| 条件 | 根拠の示し方 |
|---|---|
| ページが GitHub の取得元をどこにも出していない | HTML の grep 結果（リンク 0 本・`skills add` 無し） |
| 案内されている取得元が 404 | 叩いた raw の URL と 404、リポジトリの実際の中身 |
| 配布元が GitHub でない | ページの Source 欄、`api.github.com/users/<名前>` が 404 |
| MCP / Plugin のページ | 扱わないのは設計決定 D-12。`unsupported-kind` を出すのが正しい動作 |
| `is_tool_page` が低く、実際に一覧・記事ページ | Jev の回答（`is_tool_page` の値）とページの性質 |

---

## 4. 完了条件（回帰確認を含む）

```bash
npm run typecheck && npm test
./scripts/check-invariants.sh
npm run package:browser
```

加えて、**Jev 経路と既存の決定論的経路の両方**を流す。直した対象だけを見て終わらない。

```bash
node scripts/test-browser-jev.mjs        # 固定ケース（未対応サイトの各パターン）
node scripts/test-browser-catalogs.mjs            # GitHub / GitHub(subagent) / skills.sh / Agents Directory
```

汎用に効いた修正なら、`scripts/test-browser-jev.mjs` の `cases` に **そのページを 1 本足す**。
ページが対応サイトになったら、このスクリプトは自分で skip して決定論的経路へ回すよう促す。

報告には §0.3 の出力（直す前と後）を載せる。どの段が進んだのかを、言葉ではなく出力で示す。

利用者に見える変更なら `CHANGELOG.md` の `[Unreleased]` に英語で 1 行、
仕様が変わったなら `docs/agent-tool-security.md` §10.5（この機能の正本）を直す。
テストの範囲を変えたら `docs/agent-tool-test-plan.md` も直す。

---

## やらないこと

- 閾値（`PAGE_THRESHOLD` 0.80）を下げて通すこと
- 「どれが取得元か」を Jev に訊き直すこと
- 送る情報を増やすこと（ページ全文・フォーム値・`<all_urls>`）
- ページの HTML 構造に依存した抽出
- `narrowed` にサイト固有の分岐を足すこと。それは `add-catalog-site` の仕事
- 対応サイトの調査。§0.1 で `diagnose-tool-page` へ回す
- 鍵を出力・ログ・コミットに出すこと
- AI の判定だけで導入できるようにすること。実在確認と利用者確認は外さない
