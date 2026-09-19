---
name: add-catalog-site
description: Agent Tool の検知・導入対応サイトを1つ増やす。カタログサイトの URL を渡されたとき、IDE 拡張とブラウザ拡張の両方で検知・導入・削除・一覧が同じように動く状態まで、テストごと仕上げる。「対応サイトを増やす」「このサイトに対応して」「add a catalog site」やカタログ URL を渡されたときに使う。
---

# 対応サイトを増やす

渡された URL のサイトを、GitHub / skills.sh / Agents Directory と**同じ扱い**にする。

## 絶対に外さない4点

1. **IDE 拡張とブラウザ拡張で差が出ない。** 判定は `core/github.ts` と `core/detect.ts` だけに置く。
   どちらか片方にしか無い分岐を作らない。
2. **自動テストを必ず書く。** 既存サイトと同じ場所に、同じ粒度で足す。
   「実機で見た」は完了条件にしない。
3. **「対応した」は検知率で言う。** 1ページ通っただけでは何も分かっていない。
   §1.2 で 25 件以上を数え、落ちたものの内訳を言えるようにする。
4. **既にある検知・導入を壊さない。** 追加は `CATALOG_SITES` の 1 エントリに閉じる。
   既存サイトの判定や取得経路を書き換えない。§5 の回帰確認を必ず通す。

---

## 0. 先に「もう対応しているサイト」を外す

**既に対応しているサイトなら、ここでやることは無い。** 増やす作業ではなく、
1 件が検知・導入できない調査である。判定してから進む。

```bash
npm run compile
node --input-type=module -e '
import { catalog, parseUrl, needsPage } from "./out/web/core/github.js";
const url = process.argv[1];
console.log("catalog  :", JSON.stringify(catalog(url)));
console.log("parseUrl :", JSON.stringify(parseUrl(url)));
console.log("needsPage:", needsPage(url));' "<渡された URL>"
```

| 結果 | どうする |
|---|---|
| 全部 `null` | 未対応のサイト。§1 へ進む |
| **どれか 1 つでも `null` 以外** | **もう対応している。ここで止める。** |

対応済みのサイトで個別のページが検知・導入できないときは、
[`diagnose-tool-page`](../diagnose-tool-page/SKILL.md) の手順で、
どの段（判定 / 実在確認 / 展開確認 / 取得）で落ちているかを切り分ける。
`CATALOG_SITES` を触る必要はまず無い。

---

## 1. サイトを調べる（ここを飛ばさない）

### 1.1 取得元の在り処を決める

URL の形で作り方が分かれる。**実際に取得して確かめる**。憶測で決めない。
**個別ページ**（スキル1件のページ）を見ること。トップページの JSON-LD は
FAQ マークアップだけ、ということがある。

```bash
# (a) URL に owner/repo が入っているか
#     例 https://skills.sh/vercel-labs/agent-skills/react-best-practices → 入っている
# (b) 入っていなければ、個別ページの JSON-LD に取得元があるか
PAGE=$(mktemp); trap 'rm -f "$PAGE"' EXIT
curl -sL "<個別ページの URL>" -o "$PAGE" -w "code=%{http_code} bytes=%{size_download}\n"
grep -c -F 'application/ld+json' "$PAGE"
grep -c -F 'codeRepository' "$PAGE"
```

| 調べた結果 | 作り方 |
|---|---|
| URL に `owner/repo` が入っている | `fromPath` を書く。ネットワークに触れず解決できる |
| 入っていないが JSON-LD に `codeRepository` か `url` がある | `fromPath` を**書かない**。`needsPage` → `fromJsonLd` に載る |
| どちらも無い | **対応できない。** §1.3 を読んでから利用者に伝える |

`grep -c` が **0 を返したら要注意**。IDE 拡張は `fetchPage` で**サーバの HTML** を読み、
ブラウザ拡張の content script は**描画後の DOM** を読む。サーバ側に無くクライアントで
注入される値は、**ブラウザだけ動いて IDE が落ちる**。`curl` で取れない値は使わない。

**ソフト 404 に注意。** SPA は存在しない slug でも HTTP 200 と完全な HTML を返す。
`code=200` は「そのページがある」ことの証明にならない。取得元が拾えるかで判断する。

### 1.2 検知率を数える（必須）

1ページ試して通っても、対応したことにはならない。**個別ページを 25 件以上**無作為に取り、
内訳を数える。落ちる原因は分類ごとに対処が違う。

**URL の集め方はサイトごとに違う。** `sitemap.xml` は3通りある。

| 形 | 例 | 集め方 |
|---|---|---|
| 個別ページを直接並べる `<urlset>` | 多くの Next.js サイト | `<loc>` をそのまま使う |
| `<sitemapindex>` で1段挟む | skills.sh（`sitemap-skills-N.xml`） | 子の sitemap を引いてから `<loc>` |
| そもそも無い（HTML が返る） | agentsdirectory.dev | 一覧ページの `href` を拾う |

`scripts/test-browser-catalogs.mjs` の `sites` に、既存2サイトぶんの動く集め方がある。
新しいサイトのものもそこへ足すので、先にそちらを書いて使い回すのが早い。

集めた URL を本番と同じ判定にかけ、分類する。

```js
import { detectPage, proofUrls } from "./out/web/core/detect.js";   // npm run compile 後

const counts = { 検知: 0, 取得元なし: 0, 候補外: 0, 実在せず: 0, 展開確認待ち: 0 };
for (const url of pick) {                     // pick = 無作為に選んだ 25 件以上
  const html = await (await fetch(url, { cache: "no-store" })).text();
  const found = detectPage(url, html);
  if (found === null) { counts.候補外++; console.log("候補外", url); continue; }
  // proofs が空 = 実在確認はアーカイブの展開に回る。HEAD では測れない
  if (found.proofs.length === 0) { counts.展開確認待ち++; continue; }
  const codes = [];
  for (const p of proofUrls(found)) codes.push((await fetch(p, { method: "HEAD" })).status);
  if (codes.includes(200)) counts.検知++;
  else { counts.実在せず++; console.log("実在せず", url, found.proofs.join(",")); }
}
console.log(counts);
```

`detectPage` が `null` のときは、`fromJsonLd`（または `catalog`）まで戻って
「取得元が拾えていない」のか「拾えたが種別判定で落ちた」のかを分ける。

| 内訳 | 意味 | 対処 |
|---|---|---|
| **取得元なし** | ページから取得元を拾えない | 抽出の問題。`fromPath` / JSON-LD の読み方を見直す。サイトが個別ページで取得元を出していないだけのこともある |
| **候補外** | 取得元は拾えたが `lead` / `kindOf` が落とした | **こちらの問題の疑いが濃い。** §1.4 を見る |
| **実在せず** | 取得元の `SKILL.md` が 404 | **サイト側のデータ誤り。** 直せない。落とすのが正しい |
| **展開確認待ち** | `proofs` が空。別のカタログへ解決した | 正常。実在は `isExtractable` が確かめる。§1.5 |

**「実在せず」を自分の不具合と取り違えない。** カタログは存在しないパスを載せることがある
（実測でおよそ 20 件に 1 件）。実在確認で落ちるのは設計どおりの動作である。
利用者へは「サイト側のデータ誤り」と明示して伝える。

数えた結果は、対応の可否を決める材料としてそのまま利用者へ渡す。

### 1.3 取得元がページ本文にしか無いサイト

JSON-LD が無く、リンクや内部データにしか取得元が無いサイトは**対応しない**。
調べ直さなくて済むように、試して駄目だった読み方を記す（Next.js の実サイトで実測）。

| 読み方 | なぜ駄目か（実測） |
|---|---|
| `<a href="https://github.com/...">` を拾う | 実ページ 7 件のうち 2 件で取れない。Suspense の境界がサーバ HTML に流れておらず、値が RSC の payload 側にしか無い |
| ページ中の GitHub URL が 1 つならそれを採る | 本文のリンクを拾う。あるページは `dotnet/templating/wiki/...` を 4 本持っていた |
| フレームワークの内部データ（`__next_f` の `"githubUrl"` など）を読む | 実ページ 7 件すべてで一意に取れたが、フレームワークのシリアライズ形式であって公開 API ではない。更新で予告なく変わる |
| タグ・class 名・入れ子を辿る | 見た目の変更で静かに壊れる |

対応できないと伝えるときは、**サイト側が何をすれば対応できるか**も一緒に渡す。

- 個別ページのサーバ HTML に schema.org の JSON-LD を出し、`codeRepository`
  （または `url`）に GitHub の URL を入れる。こちら側の追加は 1 エントリで済む
- または URL に `owner/repo` を含める（skills.sh と同じ形）

### 1.4 「候補外」の読み解き（IDE 拡張との食い違いが出る場所）

**IDE 拡張は中身で判断し（`identify` が `SKILL.md` を探す）、ブラウザ拡張はパスの形で
判断する（`core/detect.ts` の `kindOf`）。**「候補外」はここが食い違っている疑いがある。

落ちた URL を見つけたら、必ずこれを確かめる。

```bash
# 実体はあるか（IDE 拡張はこれがあれば Skill として入れる）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>/SKILL.md"
```

**200 が返るなら、ブラウザ拡張だけが落としている＝不変条件 1 の違反である。**
サイトの追加とは別の不具合として扱い、`core/detect.ts` を直す。実測で当たった形:

| 形 | 現状 | 備考 |
|---|---|---|
| `plugins/<名前>/skills/<名前>` | `kindOf` が `plugins` を見て落とす | 実体は Skill で `SKILL.md` を持つ。IDE 拡張は同じ URL を Skill として入れる。素の GitHub URL でも再現する |
| `skills/` を持たない置き場（`naming-house/SKILL.md`、リポジトリ直下の `SKILL.md`） | `kindOf` が目印を見つけられず落とす | パス名では当てられない。受けるなら実在確認を根拠にする必要がある |

直す場合は「検知しない」で止まる性質を壊さないこと。抽出を誤っても
`parseUrl` → `kindOf` → `proofs` の実在確認 → `isExtractable` のどれかで止まり、
**別のリポジトリが入ることはない**。この順序が安全弁なので、飛ばさない。

### 1.5 カタログが別のカタログを指すことがある

`fromJsonLd` は `parseUrl` が読める URL なら何でも返すので、**GitHub とは限らない**。
実測で agentsdirectory.dev の JSON-LD は skills.sh を指していた。

```
https://agentsdirectory.dev/skills/grill-me/
  → JSON-LD の url = https://www.skills.sh/mattpocock/skills/grill-me
  → lead() はカタログとして解決し、proofs は空（実在確認は isExtractable が行う）
```

`proofs` が空の候補を「確認できなかった」と数えないこと。確認の場所が違うだけである。

---

## 2. 変更する場所

順に全部やる。1つでも欠けると片方の拡張だけ壊れる。

| ファイル | 何を足すか |
|---|---|
| `core/github.ts` | `CATALOG_SITES` に1エントリ。`{ host, label, fromPath? }` |
| `browser/manifest.json` | `host_permissions` と `content_scripts[].matches` に `https://<host>/*` と `https://www.<host>/*` の**両方** |
| `test/fetcher.test.js` | `parseUrl` / `needsPage` / `catalog` / `skillHint`（IDE 側の解決） |
| `test/browserCore.test.js` | `lead` / `detectPage`、末尾の一覧表、`SUPPORTED_SITES` |
| `test/agentTool.test.js` | `isSupportedUrl` |
| `scripts/test-browser-catalogs.mjs` | `sites` に1件（実サイトの手動確認） |
| `README.md` / `README.ja.md` | 対応サイトの表。**日英を同時に** |
| `PRIVACY.md` / `docs/browser-store-listing.md` / `docs/agent-tool-security.md` | 通信先とホスト権限の一覧 |
| `CHANGELOG.md` | `[Unreleased]` に**英語**で1行 |

`SUPPORTED_SITES` は `CATALOG_SITES` から自動で導かれる。手で足さない。

ホスト権限を書くドキュメントは 3 つあり、サイト数を数え上げている箇所もある
（`grep -rn '<既存ホスト>' docs/ PRIVACY.md` で洗い出す）。1 つ漏らすと審査の回答とズレる。

### `fromPath` を書くときの注意

`RESERVED` は **skills.sh 専用**の予約パス集合である。別サイトの予約語をここへ混ぜない。
そのサイト固有の除外が要るなら、そのサイトの `fromPath` の中に閉じて書く。

`fromPath` は `url.pathname.split("/")` の結果を受ける。**percent-encode されたまま**なので、
デコードが要るなら自分で行い、`isRepoPath` を必ず通してから `repo` に入れる。

### `www.` を書く前に引く

`check-browser-package.mjs` は `https://www.<host>/*` も要求するが、**実際に解決するとは
限らない**（`www.` が NXDOMAIN のサイトがある）。`host www.<host>` で確かめ、解決しない場合は
その旨をコミットメッセージか PR に残す。存在しないホストへの権限要求は審査で説明を求められる。

---

## 3. 差分を出さないための確認

`core/` に置けば自動的に揃う。揃わないのは次の4つだけなので、ここだけ見る。

| 確認 | やり方 |
|---|---|
| manifest の到達範囲 | `npm run package:browser`。`CATALOG_SITES` と manifest の突き合わせが走る |
| JSON-LD の在り処 | §1.1 の `grep`。サーバ HTML に無ければ非対応 |
| パスの形で落としていないか | §1.4。`SKILL.md` が 200 なのに候補外なら食い違っている |
| カタログ名 ≠ ディレクトリ名 | 実体の `SKILL.md` の frontmatter `name` と突き合う。IDE は `identify`、ブラウザは `locateSkill`。**両方のテストを書く** |

### 自動検知（SPA 遷移）の経路

ブラウザ拡張の自動検知は `content.ts` → `background.ts` の `visit()` を通る。
**content script が送るのは JSON-LD だけ**なので、JSON-LD で決まらないサイトは
自動検知だけ動かない（URL を貼れば動く、という片肺になる）。ページ本文が要るサイトを
足すなら、`background.ts` 側でも本文を読む経路が要る。読むのは **IDE 拡張と同じ
サーバの HTML** にすること。描画後の DOM を読むと両拡張で検知結果がずれる。

SPA 遷移は `chrome.webNavigation.onHistoryStateUpdated` が拾い、content script へ
`rescan` を送り直す。切り分けるときは「バッジ（紫の 1）が出るか」を先に聞く。
出て popup が開かないなら `chrome.action.openPopup()` 側、バッジも出ないなら検知側である。

---

## 4. テスト（必須）

既存サイトの書き方をそのまま真似る。新しい型を作らない。

```bash
npm test                          # 固定フィクスチャ。ネットワークに触れない
node scripts/test-browser-catalogs.mjs     # 手動: 実サイトで追加したサイトを確認する
```

`test/browserCore.test.js` の「対応サイトの複数 Tool を検知し、導入先を選べる」にある
`fixtures`（サイト名・URL・種別・名前）へ行を足すのが最小の追加になる。
**同じサイトから2件**入れる（1件だと URL の形ではなく偶然で通ることがある）。
Subagent を出すサイトなら Subagent の行も足す。

`scripts/test-browser-catalogs.mjs` は、**本番が通る判定をそのまま呼ぶ**こと
（現状は `fromJsonLd` + `lead`。検知の分岐を足したなら `detectPage` へ寄せる）。
スクリプト側だけ別の組み立てをすると、本番の分岐を一度も通さないまま緑になる。

---

## 5. 完了条件

```bash
npm run typecheck && npm test
./scripts/check-invariants.sh
npm run package:browser
node scripts/test-browser-catalogs.mjs     # 手動確認
```

固定テストとパッケージ検査が緑になってから報告する。報告には**§1.2 の検知率**を必ず含め、
落ちたものは「こちらの問題」「サイト側のデータ誤り」に分けて示す。
`test-browser-catalogs.mjs` は実サイトを叩く手動確認なので、失敗・スキップ時は URL と理由を
明示し、こちらの問題かサイト側かを切り分けてから伝える。

---

## やらないこと

- ページの HTML 構造に依存した抽出（タグ・class 名・入れ子を辿る、リンクを拾う）。
  静かに壊れる。§1.3 に実測を残してある
- フレームワークの内部シリアライズ（RSC の payload 等）を読むこと。公開 API ではない
- `<all_urls>` の要求。ホストは必要な分だけ
- IDE 拡張とブラウザ拡張で別々の判定を書くこと
- 1ページ試した結果で「対応した」と報告すること
- テストを後回しにして「実機で確認した」で済ませること
