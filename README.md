# mywebview

プレゼン用 webview。複数モニターにまたがる枠なしウィンドウに Web ページを表示し、別モニターのコントロールパネルから操作する Electron アプリです。

## 機能

- 指定した位置・サイズ（既定: x=1280, y=0, 3840×720 = 1920×1080@150% のモニター 3 枚分）に枠なしで表示
- コントロールパネル
  - 表示中の URL の表示・入力（Enter で移動）
  - `url_list.txt` に登録した URL の一覧（クリックで表示）
  - 縮小プレビュー（16:9 ごとの区切り線付き）。プレビュー上でマウス・キーボード操作も可能
  - 疑似表示 ⇔ 実表示 の切り替え
- 疑似表示: 表示領域がモニターに収まらないとき（外部モニターが無い等）は、画面に出さずにオフスクリーンで描画し、プレビューだけで確認・操作できる
- スクロールバーは非表示（ページのレイアウト幅を指定幅のままにするため）

## 使い方

```sh
npm install
npm start                                   # 既定の URL・位置・サイズで起動
npm start -- https://example.com --x 1280 --y 0 --w 3840 --h 720
```

| オプション | 説明 |
|---|---|
| `URL` | 最初に表示する URL（既定: `https://www.google.com/`）。スキーム省略時は `https://` |
| `--x`, `--y` | 表示位置 |
| `--w` / `--width`, `--h` / `--height` | 表示サイズ |
| `--virtual` | 疑似表示で起動（モニターに出さずプレビューのみ） |
| `--real` | 実表示で起動（モニターに収まらなくても表示） |
| `--debug` | 起動時に指定値・実際の位置・ディスプレイ情報を表示 |

座標・サイズは DIP（表示倍率で換算後の値）です。150% 表示の 1920×1080 モニターは 1280×720 として扱われます。

### url_list.txt

1 行に 1 件、`表示名, URL` の形式で書きます。`#` で始まる行はコメントです。

```
google, https://www.google.com/
yahoo japan, https://www.yahoo.co.jp/
```

## Windows 用 ZIP の作成

```sh
npm run dist:win    # → dist/mywebview-<version>-win.zip
```

ZIP の構成:

```
url_list.txt
mywebview.bat   … これを起動（引数はそのまま渡される）
apps\           … アプリ本体
```

Linux 上でビルドできます（Wine は不要）。

## リリース手順

1. `package.json` の `version` を上げてコミット・push
2. ZIP を作成: `npm run dist:win`
   - `package.json` はアプリ本体に含まれるため、`package.json` を変更したら（メタデータだけでも）ZIP を作り直す
3. Release を作成して ZIP を添付:
   ```sh
   gh release create vX.Y.Z dist/mywebview-X.Y.Z-win.zip --target main --title vX.Y.Z --notes "..."
   ```

## ライセンス

MIT
