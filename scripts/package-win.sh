#!/bin/sh
# electron-builder の出力（dist/win-unpacked）から配布用 ZIP を作る
#   mywebview-<version>-win.zip
#   ├─ url_list.txt
#   ├─ mywebview.bat   … apps\mywebview.exe を引数付きで起動
#   └─ apps\           … Electron 本体一式
set -eu
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
STAGE=dist/zip-staging
ZIP="dist/mywebview-${VERSION}-win.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
cp -r dist/win-unpacked "$STAGE/apps"

# Windows 向けに改行を CRLF にする
sed 's/\r*$/\r/' url_list.txt > "$STAGE/url_list.txt"
printf '@echo off\r\nstart "" "%%~dp0apps\\mywebview.exe" %%*\r\n' > "$STAGE/mywebview.bat"

(cd "$STAGE" && zip -qr -9 "../$(basename "$ZIP")" url_list.txt mywebview.bat apps)
rm -rf "$STAGE"
echo "created: $ZIP"
