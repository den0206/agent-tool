---
name: diagnose-tool-page
description: 対応サイトの Tool ページなのに Agent Tool が検知・導入できないとき、どの段で落ちているかを切り分けて直す。「このページが検知されない」「導入できない」「検知はするが入らない」と言われて URL を渡されたときに使う。対応サイトでなければ調査せず add-catalog-site か diagnose-jev-page へ回す。
---

# 検知・導入できないページを調べる

渡された URL が **対応サイトなのに** 検知・導入できない、を扱う。

## 絶対に守る3点

1. **既存の検知・導入を壊さない。** 直すときは**落ちたときだけ通る分岐**を足す。
   いま通っている経路は書き換えない。直したあとに §5 の回帰確認を必ず通す。
   書き換えても影響を出さずに改善(リファクタリング等)できる場合はユーザーに提示した上で対応する
2. **対応サイトでなければ調査しない。** §0 で止めて
   [`add-catalog-site`](../add-catalog-site/SKILL.md) か
   [`diagnose-jev-page`](../diagnose-jev-page/SKILL.md) へ回す。
3. **直せないものは直さない。** §4 に当たったら実装せず、**原因と根拠**を利用者へ返す。
   サイト側のデータ誤りを、こちらの不具合として直そうとしない。

---

## 0. 先にやる2つ（順番を守る）

### 0.1 GitHub API の残量を見る

**調査で枠を使い切ると「検知されない」を自作自演する。** 未認証は 60 req/時（IP 単位）で、
一覧と commit SHA がここを使う。枠切れは 403 で返り、一覧も出なくなる。

```bash
python3 -c "
import time,json,urllib.request
d=json.load(urllib.request.urlopen('https://api.github.com/rate_limit'))['resources']['core']
print('remaining:', d['remaining'], '/ reset まで', max(0,int(d['reset']-time.time())), '秒')"
```

残量が一桁なら、API を使う確認（`listFiles` / `listSkills` / `commitSha`）は後回しにする。
枠切れのまま測ると、**サイトの問題と枠の問題を取り違える**。

### 0.2 対応サイトかを判定する

```bash
npm run compile
node --input-type=module -e '
import { catalog, parseUrl, needsPage } from "./out/web/core/github.js";
const url = process.argv[1];
console.log("catalog  :", JSON.stringify(catalog(url)));
console.log("parseUrl :", JSON.stringify(parseUrl(url)));
console.log("needsPage:", needsPage(url));' "<URL>"
```

| 結果                        | どうする                                     |
| --------------------------- | -------------------------------------------- |
| どれか 1 つでも `null` 以外 | 対応サイト。§1 へ進む                        |
| **全部 `null`**             | **対応サイトではない。ここで調査を止める。** |

対応サイトでないときは、こう伝えて終わる。このSkillでの実装も調査も続けない。

> このサイトはまだ対応していません。行き先は2つあります。
> URL 規約か JSON-LD で取得元が決まるサイトなら `add-catalog-site`（決定論的に対応する）。
> ページの本文からしか分からないなら `diagnose-jev-page`（Jev 補助検知で拾う）。

---

## 1. どの段で落ちているかを固定する

**推測で直さない。** 検知は段が分かれていて、段ごとに原因も対処も違う。
次を丸ごと流し、落ちた段を特定してから §2 を見る。

```bash
node --input-type=module -e '
import { detectPage, skillIndex, proofUrls } from "./out/web/core/detect.js";
import { isExtractable, download } from "./out/web/browser/install.js";
import { needsPage } from "./out/web/core/github.js";
const url = process.argv[1];

// カタログは本文を読まないと取得元が決まらない。content script と同じものを渡す。
let page = "";
if (needsPage(url) !== null) page = await (await fetch(url)).text();

const at = skillIndex(url);
console.log("1 一覧ページか :", at === null ? "いいえ（単体）" : JSON.stringify(at));
const found = detectPage(url, page);
console.log("2 判定         :", found === null ? "×候補にならない" : `${found.kind} ${found.name}`);
if (found === null) process.exit(0);
console.log("  取得元       :", JSON.stringify(found.source));

console.log("3 実在確認     :", found.proofs.length === 0 ? "proofs なし（展開で確かめる）" : "");
for (const p of proofUrls(found)) {
  console.log("   ", (await fetch(p, { method: "HEAD" })).status, p);
}
try {
  const r = await download(found);
  console.log("4 取得         : 成功", r.files.length, "ファイル subdir=", r.source.subdir ?? "-");
} catch (e) { console.log("4 取得         : ×", e.kind, e.message); }
console.log("5 検知に出るか :", await isExtractable(found));' "<URL>"
```

**同じ URL で 2 回流す。** `codeload` は `content-length` を返すときと返さないときがあり、
同じページが「圧縮上限で落ちる」「展開上限で落ちる」と**別の顔で失敗する**。
1 回の観測で原因を決めない。

---

## 2. 段ごとの原因と対処

### 2-1. 判定で落ちる（`detectPage` が `null`）

ネットワークに触れない段なので、**必ずこちらの問題**である。

| 形                           | 原因                                     | 対処                                                          |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| 取得元が `null`              | カタログのページから取得元を拾えていない | `fromJsonLd` / `fromPath` を見る。サイトが出していないなら §4 |
| 取得元は出るが候補にならない | `kindOf` がパスの形で落としている        | 下を確認                                                      |

`kindOf` はパスの形だけで種別を当てる。**IDE 拡張は中身で判断する**（`identify` が
`SKILL.md` を探す）ので、ここで落とすと拡張どうしで食い違う。必ず実体を確かめる。

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>/SKILL.md"
```

**200 なら不変条件 1 違反である。** `core/detect.ts` を直す。実測で当たった形:

- `plugins/<名前>/skills/<名前>` — Plugin の中の Skill は実体。`kindOf` は**末尾に近い目印**を採る
- `skills/` を持たない置き場（`naming-house/SKILL.md`、リポジトリ直下の `SKILL.md`）

### 2-2. 実在確認で落ちる（`proofs` が 404）

**サイト側のデータ誤り。こちらでは直せない。** 実測でおよそ 20 件に 1 件ある。

```
skills.sh の githubUrl = remotion-dev/skills/tree/main/skills/remotion
実体は skills/remotion-best-practices ほか。skills/remotion は存在しない
```

落とすのが正しい動作である。§4 として利用者へ返す。

### 2-3. 展開確認で落ちる（`isExtractable` が false）

`proofs` が空のカタログ候補は、アーカイブを 1 本落として中身を確かめる。上限は 3 つある。

| 上限                    | 値     | どこで効くか                                                        |
| ----------------------- | ------ | ------------------------------------------------------------------- |
| `SIZE_LIMIT`            | 50 MB  | ダウンロード（圧縮）。`content-length` があれば本文を読む前に落ちる |
| `CATALOG_EXTRACT_LIMIT` | 64 MB  | subdir が分からない取得の展開（メモリ）                             |
| `EXTRACTED_SIZE_LIMIT`  | 200 MB | subdir が分かっている取得の展開                                     |

リポジトリの実寸はアーカイブを落とさずに測れる。

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/git/trees/HEAD?recursive=1" | python3 -c "
import json,sys;d=json.load(sys.stdin)
b=[e for e in d['tree'] if e['type']=='blob']
print('ファイル', len(b), '/ 展開', round(sum(e.get('size',0) for e in b)/1024/1024,1), 'MB')"
```

**対処は上限を緩めることではない。**（`CLAUDE.md`: 緩めるのは実測で不足が確認され、
新しい上限と回収経路をテストできる場合だけ）。置き場を特定して、要る分だけ取る。

1. `narrowToSkill` が `skills/<名前>/SKILL.md` を当てれば subdir が決まり、展開の上限が
   64 MB から 200 MB へ移る（絞り込みながら読むのでメモリも数十 KB で済む）
2. それでも圧縮 50 MB を超えるなら、**ファイル単位**で取る。`listFiles` で置き場の
   ファイル一覧を読み（API 1 回）、`fetchFiles` が `raw.githubusercontent.com`（CDN）から取る。
   アーカイブに一切触れない

実測: 圧縮 116 MB / 展開 190 MB のリポジトリから、目的の 104 KB だけを取れる。

### 2-4. 取得はできるが画面に出ない

ここまで全部通るのにブラウザで出ないなら、**コードではなく読み込みを疑う**。

- **`vsix/browser` を取り込み直したか。** 古い読み込みは popup に URL 入力欄だけを出す。
  本物のデグレと見分けがつかない（実測で、取り込み直しだけで解消した報告がある）
- バッジ（紫の数字）は出るか
  - 出ない → 検知側。§1 をもう一度
  - 出るが popup が開かない → `chrome.action.openPopup()` 側
  - popup に入力フォームだけ → 候補が無い。`{type:"candidate"}` の応答を見る
- `alreadyInstalled` が真になっていないか（入れたものは勧め直さない。仕様）

組み立て済みの service worker は Node でも動かせる。`chrome` と `indexedDB` を
差し替えて `vsix/browser/browser/background.js` を読み込み、`visited` を 1 回流せば、
ブラウザを開かずに「検知されるか」を確かめられる。

---

## 3. 直すときの規律

**既存の検知・導入に影響を出さないことが最優先。** 次を全部守る。

- 足すのは**落ちたときだけ通る分岐**にする。`catch` の中、`null` のときの代替など。
  いま成功している経路の中身は書き換えない
- 判定は `core/` の 1 か所に置く。IDE 拡張とブラウザ拡張で別々に書かない
- 上限は緩めない。§2-3 のとおり、要る分だけ取る方へ寄せる
- **「読めなかった」と「無い」を混ぜない。** API の枠切れを「見つかりません」と出すと、
  利用者は直しようのない案内を受け取る。`fetchFailed` と `notFound` を分ける
- 失敗を握り潰さない。飛ばしたものがあるなら画面か例外に出す
- 直す前に §1 の出力を控え、直したあと同じものを流して**段が進んだこと**を示す

---

## 4. 実装しないと判断する条件

次に当たったら**直さない**。原因と根拠（測った数字・叩いた URL とその応答）を利用者へ返す。

| 条件                                                               | 根拠の示し方                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 取得元の `SKILL.md` が 404（サイト側のデータ誤り）                 | 叩いた raw の URL と 404、リポジトリの実際の中身                             |
| 配布元が GitHub でない（skills.sh の `/site/<ドメイン>/`）         | ページの Source 欄、`api.github.com/users/<名前>` が 404                     |
| Plugin そのものを指している（`plugins/<名前>`、`.claude-plugin/`） | 扱わないのは設計決定 D-12                                                    |
| 圧縮 50 MB 超で、置き場も特定できない                              | 実寸（圧縮・展開・ファイル数）と、`skills/<名前>/SKILL.md` が 404 であること |
| カタログが取得元を出していない                                     | ページに JSON-LD も名前付きデータ項目も無いこと                              |

サイト側の問題なら、**サイトが何をすれば直るか**も添える。

---

## 5. 完了条件（回帰確認を含む）

```bash
npm run typecheck && npm test
./scripts/check-invariants.sh
npm run package:browser
```

これに加えて、**既存の検知経路が通ることを必ず確かめる**。直した対象だけを見て終わらない。

```bash
node scripts/test-browser-catalogs.mjs     # GitHub / GitHub(subagent) / skills.sh / Agents Directory
```

さらに、直接それぞれを 1 本ずつ通す（`test-browser-catalogs.mjs` は無作為に引くので、
落ちた経路が毎回当たるとは限らない）。

```bash
node --input-type=module -e '
import { detectPage } from "./out/web/core/detect.js";
import { download } from "./out/web/browser/install.js";
for (const url of [
  "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-view-transitions",
  "https://github.com/iannuttall/claude-agents/blob/main/agents/content-writer.md",
  "https://www.skills.sh/mattpocock/skills/diagnosing-bugs",
]) {
  const f = detectPage(url, "");
  try { const r = await download(f); console.log("✓", f.name, r.files.length, "ファイル"); }
  catch (e) { console.log("×", url, e.kind, e.message); }
}'
```

報告には **§1 の出力（直す前と後）** を載せる。どの段が進んだのかを、言葉ではなく出力で示す。

利用者に見える変更なら `CHANGELOG.md` の `[Unreleased]` に英語で 1 行、
仕様が変わったなら該当する `docs/agent-tool-*.md` を直す。

---

## やらないこと

- 対応サイトでない URL の調査。§0.2 で止めて `add-catalog-site` か `diagnose-jev-page` へ回す
- 上限（50 MB / 64 MB / 200 MB / 10,000 件）を緩めること
- いま通っている経路を書き換えること。足すのは落ちたときの分岐だけ
- サイト側のデータ誤りを、こちらの不具合として回避実装すること
- ページの HTML 構造（タグ・class 名・入れ子）に依存した抽出
- 1 回の観測で原因を決めること。`codeload` は同じ URL で違う落ち方をする
- 枠切れのまま測って「サイトが悪い」と結論すること
