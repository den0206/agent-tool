#!/bin/bash
# ブラウザ拡張を組み立てる。Chrome Web Store と Edge Add-ons へ同じ zip を出す。
# `vsix/browser/` は Chrome の「パッケージ化されていない拡張機能を読み込む」で読める形にする。
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE="vsix/browser"
OUT="vsix/agent-tool-browser.zip"

npx tsc -p browser/tsconfig.json

rm -rf "$STAGE"
mkdir -p "$STAGE/browser"
cp browser/manifest.json "$STAGE/"
cp -R browser/_locales "$STAGE/_locales"
cp browser/tab.html browser/tab.css browser/detection.css "$STAGE/browser/"
cp -R browser/icons "$STAGE/browser/icons"
cp -R out/web/browser/. "$STAGE/browser/"
cp -R out/web/core "$STAGE/core"

# manifest と HTML が指すものが実際にあるか。読み込んで初めて気づくのを避ける。
node scripts/check-browser-package.mjs "$STAGE"

rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OLDPWD/$OUT" .)
echo "$STAGE  (読み込み用)"
echo "$OUT  $(wc -c < "$OUT" | tr -d ' ') bytes"
