// main.js
const { app, BrowserWindow, dialog, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs } = require('node:util');

const DEFAULTS = {
  url: 'https://www.google.com/',
  // 座標は DIP（表示倍率で換算後の値）。1920x1080@150% のモニターは 1280x720 として扱われる
  x: 1280, y: 0, width: 3840, height: 720,
};

const PREVIEW_INTERVAL_MS = 500; // プレビュー更新間隔
const PREVIEW_WIDTH = 1280;      // プレビュー画像の幅（px）
const INTERACTIVE_INTERVAL_MS = 100; // プレビュー上で操作中の更新間隔
const INTERACTIVE_HOLD_MS = 2000;    // 最後の操作からこの時間は速い更新を続ける

// プレビューから転送を許可する入力イベント
const INPUT_TYPES = new Set(['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel', 'keyDown', 'keyUp', 'char']);

// 表示用ウィンドウが他のウィンドウに隠れていても描画を止めない（プレビュー用）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// スキームが無ければ https:// を補う（例: example.com）。不正なら null
function normalizeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

// 引数を解析する
//   開発時:       electron . [URL] [--x N] [--y N] [--w N] [--h N] [--virtual | --real] [--debug]
//   パッケージ後: mywebview [URL] [--x N] [--y N] [--w N] [--h N] [--virtual | --real] [--debug]
//   --virtual: 疑似表示（画面に出さずプレビューのみ） / --real: 実表示（モニターに収まらなくても表示）
//   どちらも無ければ、表示領域がモニターに収まらないときに疑似表示
function parseOptions() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(app.isPackaged ? 1 : 2),
    options: {
      x:      { type: 'string' },
      y:      { type: 'string' },
      w:      { type: 'string' },
      h:      { type: 'string' },
      width:  { type: 'string' },
      height: { type: 'string' },
      debug:  { type: 'boolean' },
      virtual: { type: 'boolean' },
      real:   { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false, // Chromium のスイッチ等の未知オプションは無視
  });

  const toInt = (name, value, fallback, min) => {
    if (value === undefined || value === true) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      throw new Error(`--${name} には ${min} 以上の整数を指定してください: ${value}`);
    }
    return n;
  };

  if (values.virtual === true && values.real === true) {
    throw new Error('--virtual と --real は同時に指定できません');
  }

  const rawUrl = positionals[0] ?? DEFAULTS.url;
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`不正な URL です: ${rawUrl}`);

  return {
    url,
    x:      toInt('x', values.x, DEFAULTS.x, -Infinity),
    y:      toInt('y', values.y, DEFAULTS.y, -Infinity),
    width:  toInt('w', values.w ?? values.width, DEFAULTS.width, 1),
    height: toInt('h', values.h ?? values.height, DEFAULTS.height, 1),
    debug:  values.debug === true,
    virtual: values.virtual === true,
    real:   values.real === true,
  };
}

// url_list.txt の場所
//   パッケージ後: <zip>/apps/mywebview.exe → <zip>/url_list.txt（無ければ exe と同じ場所）
//   開発時:       プロジェクト直下
function findUrlListPath() {
  const candidates = app.isPackaged
    ? [path.join(path.dirname(process.execPath), '..', 'url_list.txt'),
       path.join(path.dirname(process.execPath), 'url_list.txt')]
    : [path.join(__dirname, 'url_list.txt')];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

// 1 行 1 件:「表示名, URL」または「URL」。空行と # で始まる行は無視
function loadUrlList() {
  const file = findUrlListPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file, items: [], error: `読み込めません: ${e.message}` };
  }
  const items = [];
  const invalid = [];
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const comma = s.indexOf(',');
    const name = comma >= 0 ? s.slice(0, comma).trim() : s;
    const url = normalizeUrl(comma >= 0 ? s.slice(comma + 1) : s);
    if (url) items.push({ name: name || url, url });
    else invalid.push(i + 1);
  });
  return { file, items, error: invalid.length ? `不正な行: ${invalid.join(', ')} 行目` : null };
}

// 表示領域 b が接続中のモニターで完全に覆われているか
function coveredByDisplays(b) {
  const covered = screen.getAllDisplays().reduce((sum, { bounds: a }) => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return sum + (w > 0 && h > 0 ? w * h : 0);
  }, 0);
  return covered >= b.width * b.height;
}

const intersects = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// コントロールパネルの位置: 表示用ウィンドウと重ならない一番左のディスプレイ（無ければプライマリ）
function panelBoundsFor(displayBounds) {
  const free = screen.getAllDisplays()
    .filter((d) => !intersects(d.bounds, displayBounds))
    .sort((a, b) => a.bounds.x - b.bounds.x);
  const wa = (free[0] ?? screen.getPrimaryDisplay()).workArea;
  // Windows は作業領域にタスクバーが反映されるので高さいっぱいに使う。
  // それ以外（Linux の Wayland 等）は反映されないことがあるので余白を取る
  const width = Math.min(1100, wa.width - 40);
  const height = process.platform === 'win32' ? wa.height : Math.min(800, wa.height - 100);
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width, height,
  };
}

app.whenReady().then(() => {
  let opts;
  try {
    opts = parseOptions();
  } catch (e) {
    // Windows の GUI アプリではコンソール出力が見えないのでダイアログでも表示
    console.error(e.message);
    dialog.showErrorBox('mywebview', `${e.message}\n\n引数: ${process.argv.slice(1).join(' ')}`);
    app.exit(1);
    return;
  }

  const bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };

  // 表示モード
  //   疑似表示: 画面には出さずにオフスクリーンで指定サイズのまま描画し、プレビューだけに表示する
  //   実表示:   実際にウィンドウを表示し、それをキャプチャしてプレビューする
  // 指定が無ければ、表示領域が接続中のモニターに収まらない（外部モニターが無い等）ときに疑似表示
  let virtual = opts.virtual ? true : opts.real ? false : !coveredByDisplays(bounds);

  let display = null;      // 表示用ウィンドウ（モード切替で作り直す）
  let switching = false;   // 作り直し中は「閉じたら終了」を無効にする

  // ---- コントロールパネル ----
  const panel = new BrowserWindow({
    ...panelBoundsFor(bounds),
    title: 'mywebview コントロールパネル',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  panel.removeMenu();
  panel.loadFile(path.join(__dirname, 'panel', 'index.html'));

  const sendToPanel = (channel, ...args) => {
    if (!panel.isDestroyed()) panel.webContents.send(channel, ...args);
  };
  const alive = () => display && !display.isDestroyed();

  // プレビューの縦横比・区切り位置は「実際の」ウィンドウサイズに合わせる
  // （OS 側でサイズが制限されると指定値と異なることがある）
  const currentBounds = () => (virtual
    ? { ...bounds, virtual: true }
    : { ...display.getContentBounds(), virtual: false });
  const onBoundsChange = () => {
    if (alive()) sendToPanel('display:bounds', currentBounds());
  };

  // ---- プレビュー ----
  let lastFrame = null; // パネルの読み込み前に描画された分を初期表示に使う
  const sendFrame = (img) => {
    if (img.isEmpty()) return;
    lastFrame = img.resize({ width: PREVIEW_WIDTH, quality: 'good' }).toJPEG(75);
    sendToPanel('preview:frame', lastFrame);
  };

  let previewTimer = null;
  let capturing = false;
  let previewOn = true;

  // プレビュー上で操作している間は、一時的に更新間隔を短くする
  let interactive = false;
  let interactiveTimer = null;
  const previewInterval = () => (interactive ? INTERACTIVE_INTERVAL_MS : PREVIEW_INTERVAL_MS);
  const fps = () => Math.max(1, Math.round(1000 / previewInterval()));
  const applyRate = () => {
    if (!alive()) return;
    if (virtual) display.webContents.setFrameRate(fps());
    else if (previewOn) setPreview(true); // タイマーを新しい間隔で張り直す
  };
  const markInteractive = () => {
    clearTimeout(interactiveTimer);
    interactiveTimer = setTimeout(() => { interactive = false; applyRate(); }, INTERACTIVE_HOLD_MS);
    if (!interactive) { interactive = true; applyRate(); }
  };

  const setPreview = (on) => {
    clearInterval(previewTimer);
    previewTimer = null;
    if (!alive()) return;
    if (virtual) {
      // オフスクリーン描画: 内容が変わったときだけ paint が来る。プレビュー OFF 中は描画自体を止める
      if (on) {
        display.webContents.startPainting();
        display.webContents.invalidate(); // 静止ページでも 1 フレーム描画させる
      } else {
        display.webContents.stopPainting();
      }
      return;
    }
    if (!on) return;
    previewTimer = setInterval(async () => {
      if (capturing || !alive() || panel.isDestroyed()) return;
      capturing = true;
      try {
        sendFrame(await display.webContents.capturePage());
      } catch {
        // ページ遷移中などはキャプチャに失敗することがあるので無視
      } finally {
        capturing = false;
      }
    }, previewInterval());
  };

  // ---- 表示用ウィンドウ ----
  function createDisplay(url) {
    const win = new BrowserWindow({
      ...bounds,
      frame: false,            // タイトルバーなし
      show: false,
      webPreferences: { backgroundThrottling: false, offscreen: virtual },
    });
    display = win;
    // オフスクリーンでも作成時は画面サイズに制限されるので、作成直後に指定サイズへ設定し直す
    if (virtual) win.setBounds(bounds);

    // 複数モニターにまたがる場合、作成時に OS 側でサイズが調整されることがあるので、
    // 表示後にもう一度位置とサイズを設定する
    win.once('ready-to-show', () => {
      if (!virtual) {
        win.showInactive(); // パネルからフォーカスを奪わない
        win.setBounds(bounds);
      }
      onBoundsChange();
      if (opts.debug) {
        const displays = screen.getAllDisplays().map((d, i) =>
          `#${i + 1} bounds=${JSON.stringify(d.bounds)} scale=${d.scaleFactor}`).join('\n');
        dialog.showMessageBox({
          title: 'mywebview debug',
          message: `指定: ${JSON.stringify(bounds)}\n実際: ${JSON.stringify(win.getBounds())}` +
            `${virtual ? '（疑似表示）' : ''}\n\nディスプレイ:\n${displays}`,
        });
      }
    });
    // target=_blank 等の新規ウィンドウは同じウィンドウで開く
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      win.loadURL(u);
      return { action: 'deny' };
    });
    // スクロールバーを非表示にする（表示されているとその幅だけページのレイアウト幅が狭くなるため）。
    // ホイール等でのスクロールはそのまま可能
    win.webContents.on('dom-ready', () => {
      win.webContents.insertCSS(
        '::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; }',
        { cssOrigin: 'user' },
      ).catch(() => {});
    });
    const onNavigate = () => sendToPanel('display:url', win.webContents.getURL());
    win.webContents.on('did-navigate', onNavigate);
    win.webContents.on('did-navigate-in-page', onNavigate);
    win.on('resize', onBoundsChange);
    win.on('move', onBoundsChange);
    win.on('show', onBoundsChange);

    if (virtual) {
      win.webContents.setFrameRate(fps());
      win.webContents.on('paint', (_e, _dirty, img) => {
        if (previewOn && display === win && !panel.isDestroyed()) sendFrame(img);
      });
    }

    // 表示用ウィンドウを閉じたらアプリを終了（モード切替での作り直しは除く）
    win.on('closed', () => { if (!switching && display === win) app.quit(); });

    win.loadURL(url).catch(() => {}); // 読み込み失敗はページ側に表示される
    setPreview(previewOn);
    onBoundsChange();
  }

  // 疑似表示 ⇔ 実表示 の切り替え（表示用ウィンドウを作り直し、同じ URL を読み込み直す）
  function setVirtual(next) {
    if (next === virtual) return virtual;
    const url = (alive() && display.webContents.getURL()) || opts.url;
    switching = true;
    clearInterval(previewTimer);
    previewTimer = null;
    if (alive()) display.destroy();
    virtual = next;
    lastFrame = null;
    createDisplay(url);
    switching = false;
    return virtual;
  }

  createDisplay(opts.url);

  // ---- パネルからの要求 ----
  ipcMain.handle('panel:init', () => ({
    url: (alive() && display.webContents.getURL()) || opts.url,
    list: loadUrlList(),
    requested: bounds,
    bounds: currentBounds(),
    frame: lastFrame,
    previewOn,
    virtual,
  }));
  ipcMain.handle('panel:navigate', (_e, raw) => {
    const url = normalizeUrl(raw);
    if (!url) return `不正な URL です: ${raw}`;
    if (alive()) display.loadURL(url).catch(() => {}); // 読み込み失敗はページ側に表示される
    return null;
  });
  ipcMain.handle('panel:set-preview', (_e, on) => {
    previewOn = Boolean(on);
    setPreview(previewOn);
    return previewOn;
  });
  ipcMain.handle('panel:set-virtual', (_e, on) => setVirtual(Boolean(on)));
  ipcMain.handle('panel:reload-list', () => loadUrlList());

  // プレビュー上の操作を表示用ウィンドウへ転送
  ipcMain.on('panel:input', (_e, ev) => {
    if (!alive() || !ev || !INPUT_TYPES.has(ev.type)) return;
    if (ev.type === 'mouseDown' || ev.type === 'keyDown') {
      if (!display.webContents.isFocused()) display.webContents.focus();
    }
    display.webContents.sendInputEvent(ev);
    markInteractive();
  });
  // IME で確定した文字列（日本語入力など）
  ipcMain.on('panel:insert-text', (_e, text) => {
    if (!alive() || typeof text !== 'string' || !text) return;
    display.webContents.insertText(text);
    markInteractive();
  });

  // パネルを閉じたらアプリを終了
  panel.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
