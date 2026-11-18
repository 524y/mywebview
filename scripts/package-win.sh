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

# koffi（exe 表示用）の Windows 用バイナリ。npm install ではビルドしている OS の分しか入らないので取ってくる。
# koffi は <resources>/koffi/win32_x64/koffi.node も探す
KOFFI_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/koffi'].version")
mkdir -p "$STAGE/koffi"
(cd "$STAGE/koffi" && npm pack --silent "@koromix/koffi-win32-x64@$KOFFI_VERSION" >/dev/null && tar xzf ./*.tgz)
mkdir -p dist/win-unpacked/resources/koffi/win32_x64
cp "$STAGE/koffi/package/win32_x64/koffi.node" dist/win-unpacked/resources/koffi/win32_x64/
rm -rf "$STAGE/koffi"

cp -r dist/win-unpacked "$STAGE/apps"

# Windows 向けに改行を CRLF にする
sed 's/\r*$/\r/' url_list.txt > "$STAGE/url_list.txt"
printf '@echo off\r\nstart "" "%%~dp0apps\\mywebview.exe" %%*\r\n' > "$STAGE/mywebview.bat"

(cd "$STAGE" && zip -qr -9 "../$(basename "$ZIP")" url_list.txt mywebview.bat apps)
rm -rf "$STAGE"
echo "created: $ZIP"
