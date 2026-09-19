// 組み立てたブラウザ拡張が、読み込む前に壊れていないかを見る。
// manifest と HTML が指すファイル、ESM の import 先、i18n のキーを突き合わせる。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (root === undefined) {
  console.error("usage: check-browser-package.mjs <dir>");
  process.exit(2);
}

const problems = [];
const check = (path, why) => {
  if (path === undefined) return;                 // manifest に無い項目は見ない
  if (!existsSync(join(root, path))) problems.push(`${why}: ${path} がありません`);
};

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

// --- 権限の最小化 ---
// webNavigation は対応サイトの SPA 遷移検知に使う。
// activeTab + scripting は、利用者が明示的に押したときだけ未対応ページを読む。
// storage は Jev API key を trusted extension contexts に限定して保持する。
// 新しい権限は用途とストア審査への影響を確認してから明示的に許可する。
const allowedPermissions = new Set(["webNavigation", "activeTab", "scripting", "storage"]);
for (const permission of manifest.permissions ?? []) {
  if (!allowedPermissions.has(permission)) {
    problems.push(`permissions: 想定外の権限 ${permission} が追加されています`);
  }
}

// --- manifest が指すもの ---
check(manifest.background.service_worker, "background");
for (const script of manifest.content_scripts.flatMap(entry => entry.js)) {
  check(script, "content_scripts");
}
check(manifest.options_page, "options_page");
for (const path of Object.values(manifest.icons ?? {})) check(path, "icons");

// service worker は ESM、content script は素のスクリプトでなければ読めない。
const worker = readFileSync(join(root, manifest.background.service_worker), "utf8");
if (manifest.background.type !== "module" && /^import /m.test(worker)) {
  problems.push("background が import を含むのに type: module ではありません");
}
for (const script of manifest.content_scripts.flatMap(entry => entry.js)) {
  const body = readFileSync(join(root, script), "utf8");
  if (/^(import|export) /m.test(body)) {
    problems.push(`${script} は content script なので ESM にできません`);
  }
}

// --- ESM の import 先 ---
const walk = dir => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? walk(join(dir, entry.name))
    : [join(dir, entry.name)]);

for (const file of walk(".").filter(path => path.endsWith(".js"))) {
  const body = readFileSync(join(root, file), "utf8");
  for (const match of body.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = relative(resolve(root), resolve(root, dirname(file), match[1]));
    check(target, `${file} の import`);
  }
}

// --- HTML が指すもの ---
for (const file of walk(".").filter(path => path.endsWith(".html"))) {
  const body = readFileSync(join(root, file), "utf8");
  for (const match of body.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(match[1])) continue;
    check(join(dirname(file), match[1]), `${file} の参照`);
  }
}

// --- 対応サイトと manifest の到達範囲 ---
// `CATALOG_SITES` を増やしても manifest は自動では広がらない。ホストが揃っていないと、
// 検知の判定だけ通って content script が入らない・取得が CORS で落ちる、が起きる。
// 実サイトのテストは Node の fetch なので素通りし、ここでしか気づけない。
// 読むのは出力元。staged の core/ には `type: module` の目印が無く、import すると
// Node が毎回警告を出す。中身は cp しただけなので同じものである。
const { CATALOG_SITES } = await import(pathToFileURL(resolve("out/web/core/github.js")).href);
const has = (patterns, pattern) => patterns.includes(pattern);
// `www.` 付きも要る。`toUrl` は `www.` を剥がして受けるので、利用者は www の URL を
// 貼れるし、www のページも見る。manifest 側が素のホストだけだと、そこで検知だけが死ぬ。
const missing = (patterns, host) => [
  `https://${host}/*`,
  `https://www.${host}/*`,
].filter(pattern => !has(patterns, pattern) && !has(patterns, `https://*.${host}/*`));

for (const site of CATALOG_SITES) {
  for (const [field, patterns] of [
    ["host_permissions", manifest.host_permissions ?? []],
    ["content_scripts.matches", manifest.content_scripts.flatMap(entry => entry.matches)],
  ]) {
    for (const pattern of missing(patterns, site.host)) {
      problems.push(`${field}: ${pattern} がありません（CATALOG_SITES に ${site.host} があります）`);
    }
  }
}

// --- i18n のキー ---
const locales = readdirSync(join(root, "_locales"));
const messages = Object.fromEntries(locales.map(locale =>
  [locale, JSON.parse(readFileSync(join(root, "_locales", locale, "messages.json"), "utf8"))]));

const used = new Set();
for (const match of readFileSync(join(root, "manifest.json"), "utf8").matchAll(/__MSG_(\w+)__/g)) {
  used.add(match[1]);
}
for (const file of walk(".").filter(path => path.endsWith(".js") || path.endsWith(".html"))) {
  const body = readFileSync(join(root, file), "utf8");
  // リテラルがそのまま第 1 引数になっているものだけを拾う。`getMessage(cond ? a : b)` の
  // `cond` 側の文字列を、文言キーと取り違えない。
  for (const match of body.matchAll(/getMessage\(\s*"([^"]+)"\s*[,)]/g)) used.add(match[1]);
  for (const match of body.matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g)) used.add(match[1]);
  for (const match of body.matchAll(/data-i18n="([^"]+)"/g)) used.add(match[1]);
}
for (const [locale, table] of Object.entries(messages)) {
  for (const key of used) {
    if (!(key in table)) problems.push(`_locales/${locale}: ${key} がありません`);
  }
}

if (problems.length > 0) {
  console.error("::error::組み立てたブラウザ拡張に不足があります");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`✓ manifest・import・HTML・i18n の参照が揃っています（${locales.join(" / ")}）`);
