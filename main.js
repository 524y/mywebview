// main.js
const { app, BrowserWindow, dialog, screen, ipcMain, powerSaveBlocker, desktopCapturer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { parseExe, launchExe } = require('./exe');

// 何も表示しない（黒い画面）。起動時に表示対象を指定しなかったとき
const BLANK = `data:text/html,${encodeURIComponent('<html style="background:#000;cursor:none"><!--mywebview-blank--></html>')}`;
const isBlank = (url) => typeof url === 'string' && url.startsWith('data:') && url.includes('mywebview-blank');

const DEFAULTS = {
  url: BLANK,
  // 座標は DIP（表示倍率で換算後の値）。1920x1080@150% のモニターは 1280x720 として扱われる
  x: 1280, y: 0, width: 3840, height: 720,
};

const PREVIEW_INTERVAL_MS = 500; // プレビュー更新間隔
const PREVIEW_WIDTH = 1280;      // プレビュー画像の幅（px）
const INTERACTIVE_INTERVAL_MS = 100; // プレビュー上で操作中の更新間隔
const INTERACTIVE_HOLD_MS = 2000;    // 最後の操作からこの時間は速い更新を続ける
const RETRY_MS = 5000;         // 読み込みに失敗したとき、再試行するまでの時間
const QUICK_CLOSE_MS = 3000;   // 表示してすぐにページがウィンドウを閉じたら、作り直さない（繰り返しを防ぐ）
const FOCUS_POLL_MS = 300;     // フォーカスの場所を調べる間隔（パネルに表示する）
const REPLACE_DELAY_MS = 1000; // モニター構成が変わってから置き直すまでの時間（OS がウィンドウを動かし終えるのを待つ）
const CURTAIN_LOAD_MS = 10000;  // 幕のページの読み込みを待つ上限（幕の画像の読み込みを含む）
const CURTAIN_STEP_MS = 10000;  // 幕の 1 回の動き（2.5 秒）を待つ上限
const CURTAIN_RETRY_MS = 10000; // この時間内に幕のウィンドウを続けて作り直すときは、少し待つ
const TRANSITION_EFFECTS = ['none', 'fade', 'tiles', 'tiles-fade', 'tiles-flip']; // 切り替え効果（transition.js）
const TRANSITION_ORDERS = ['random', 'rows', 'cols']; // タイルの順番: ランダム / 左上から右へ、行ごとに / 左上から下へ、列ごとに
const TRANSITION_STEP_MS = 5000;  // 切り替え前の画面の取得・表示を待つ上限（超えたら効果なしで切り替える）
const TRANSITION_LOAD_MS = 10000; // 新しいページの読み込みを待つ上限（超えたら読み込み途中でも見せる）
const TRANSITION_EXE_MS = 15000;  // 新しく起動した exe のウィンドウが出るのを待つ上限
const TRANSITION_SETTLE_MS = 500;      // 読み込み後、ページが描き終わるのを待つ時間
const TRANSITION_EXE_SETTLE_MS = 1000; // exe を前に出した後、配置・描画が落ち着くのを待つ時間

// プレビューから転送を許可する入力イベント
const INPUT_TYPES = new Set(['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel', 'keyDown', 'keyUp', 'char']);

// 表示用ウィンドウが他のウィンドウに隠れていても描画を止めない（プレビュー用）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 二重起動しない（同じ表示領域に 2 組のウィンドウが出る）。2 つ目は何もせず終了し、1 つ目のパネルを前に出す
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

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

// 表示対象（URL または exe）の文字列を解析する。exe の相対パスは url_list.txt のある場所が基準
//   → { exe: { file, args, text } } | { url } | null
function parseTarget(raw) {
  const exe = parseExe(raw, path.dirname(findUrlListPath()));
  if (exe) return { exe };
  const url = normalizeUrl(raw);
  return url ? { url } : null;
}

// 引数を解析する
//   開発時:       electron . [URL|EXE] [--x N] [--y N] [--w N] [--h N] [--virtual | --real] [--debug]
//   パッケージ後: mywebview [URL|EXE] [--x N] [--y N] [--w N] [--h N] [--virtual | --real] [--debug]
//   --x/--y/--w/--h を 1 つも指定しなければ、プライマリ以外のモニター全部を表示領域にする（無ければ既定値で疑似表示）
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
      grid:   { type: 'string' },
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

  // 切り替え効果のタイルの数（横×縦）。既定は 3×3 台のモニター（HDMI 1 本分）が横に 3 つ並んだ 9×3
  const grid = (values.grid === undefined || values.grid === true ? '9x3' : String(values.grid)).match(/^(\d+)[x×*](\d+)$/i);
  if (!grid || +grid[1] < 1 || +grid[2] < 1) throw new Error(`--grid は 9x3 のように指定してください: ${values.grid}`);

  const raw = positionals[0] ?? DEFAULTS.url;
  if (!parseTarget(raw)) throw new Error(`不正な URL です: ${raw}`);

  return {
    target: raw,
    // 位置・サイズを 1 つも指定しなければ、モニターの構成から自動で決める（autoLayout()）
    auto: [values.x, values.y, values.w, values.width, values.h, values.height].every((v) => v === undefined),
    x:      toInt('x', values.x, DEFAULTS.x, -Infinity),
    y:      toInt('y', values.y, DEFAULTS.y, -Infinity),
    width:  toInt('w', values.w ?? values.width, DEFAULTS.width, 1),
    height: toInt('h', values.h ?? values.height, DEFAULTS.height, 1),
    debug:  values.debug === true,
    virtual: values.virtual === true,
    real:   values.real === true,
    cols:   +grid[1],
    rows:   +grid[2],
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

// 1 行 1 件:「表示名, URL」または「URL」（URL の代わりに exe も可）。空行と # で始まる行は無視
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
    const t = parseTarget(comma >= 0 ? s.slice(comma + 1) : s);
    const url = t?.exe?.text ?? t?.url;
    if (url) items.push({ name: name || url, url });
    else invalid.push(i + 1);
  });
  return { file, items, error: invalid.length ? `不正な行: ${invalid.join(', ')} 行目` : null };
}

// 想定外のエラーは url_list.txt と同じ場所の mywebview-error.log に記録する
let logged = 0;
function logError(e) {
  console.error(e);
  if (logged++ >= 100) return; // 同じエラーが繰り返されてもファイルを大きくしない（起動ごとに 100 件まで）
  try {
    fs.appendFileSync(path.join(path.dirname(findUrlListPath()), 'mywebview-error.log'),
      `${new Date().toISOString()} ${e?.stack ?? e}\n`);
  } catch {
    // 書き込めない場所でも動き続ける
  }
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

// 表示領域の自動決定: プライマリ以外のモニターをすべて囲む長方形
//   → { bounds, notes }（notes: パネルに出す注意）| null（拡張モニターが無い）
function autoLayout() {
  const primary = screen.getPrimaryDisplay();
  let ext = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  if (!ext.length) return null;
  const notes = [];
  const union = (ds) => {
    const x = Math.min(...ds.map((d) => d.bounds.x));
    const y = Math.min(...ds.map((d) => d.bounds.y));
    const right = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width));
    const bottom = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
    return { x, y, width: right - x, height: bottom - y };
  };
  let b = union(ext);
  if (intersects(b, primary.bounds)) {
    // プライマリを挟んで両側に拡張モニターがある（囲むとプライマリまで覆う）: 広い方の側だけを使う
    const p = primary.bounds;
    const right = ext.filter((d) => d.bounds.x >= p.x + p.width);
    const rest = ext.filter((d) => !right.includes(d));
    const area = (ds) => ds.reduce((s, d) => s + d.bounds.width * d.bounds.height, 0);
    if (right.length && rest.length) {
      ext = area(right) >= area(rest) ? right : rest;
      b = union(ext);
      notes.push('拡張モニターがプライマリの両側にあるため、片側のモニターだけに表示しています');
    }
  }
  if (!coveredByDisplays(b)) {
    notes.push('拡張モニターの並びが長方形になっていないため、表示領域の一部はどのモニターにも映りません');
  }
  if (new Set(ext.map((d) => d.scaleFactor)).size > 1) {
    notes.push('拡張モニターの表示倍率（拡大率）がそろっていないため、正しく表示されない場合があります');
  }
  return { bounds: b, notes };
}

// コントロールパネルの位置・サイズ: ディスプレイの作業領域いっぱい（Windows はタスクバーを除いた範囲）
//   自動配置ではプライマリ。指定時は表示用ウィンドウと重ならない一番左のディスプレイ（無ければプライマリ）
function panelBoundsFor(displayBounds, usePrimary) {
  const free = usePrimary ? [] : screen.getAllDisplays()
    .filter((d) => !intersects(d.bounds, displayBounds))
    .sort((a, b) => a.bounds.x - b.bounds.x);
  return { ...(free[0] ?? screen.getPrimaryDisplay()).workArea };
}

app.whenReady().then(() => {
  if (!firstInstance) return;
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

  // 表示領域。自動配置ではモニター構成が変わると中身を置き換える（参照は保ったまま）
  const layout = opts.auto ? autoLayout() : null;
  const bounds = layout ? { ...layout.bounds } : { x: opts.x, y: opts.y, width: opts.width, height: opts.height };

  // 表示モード
  //   疑似表示: 画面には出さずにオフスクリーンで指定サイズのまま描画し、プレビューだけに表示する
  //   実表示:   実際にウィンドウを表示し、それをキャプチャしてプレビューする
  // 指定が無ければ、自動配置で拡張モニターがあれば実表示（並びが長方形でなくても）。
  // それ以外は、表示領域が接続中のモニターに収まらない（外部モニターが無い等）ときに疑似表示
  const autoVirtual = (l) => (l ? false : !coveredByDisplays(bounds));
  let virtual = opts.virtual ? true : opts.real ? false : opts.auto ? autoVirtual(layout) : !coveredByDisplays(bounds);
  // 表示領域についての注意（パネルに出し続ける）
  const layoutNotesFor = (l) => {
    if (!opts.auto) return [];
    if (l) return l.notes;
    return [`拡張モニターが見つからないため、既定のサイズ（${bounds.width}×${bounds.height}）で` +
      `${virtual ? '疑似表示しています' : '表示しています'}`];
  };
  let layoutNotes = layoutNotesFor(layout);

  let display = null;       // 表示用ウィンドウ（Web ページ。モード切替で作り直す。exe を前に出している間は隠す）
  let displayReady = false; // 表示用ウィンドウの最初の描画が済んだか（済む前に出すと白い画面が見える）
  let switching = false;    // 作り直し中は「閉じたら終了」を無効にする
  const exes = new Map();   // 起動中の exe（キー: exe の指定文字列 → launchExe() の戻り値）
  let front = null;         // 前に出している exe（null なら Web ページ）
  let history = [];         // 前に出した順（後ろほど新しい）。exe か 'web'。exe を閉じたときに 1 つ前に戻すのに使う
  let lastUrl = DEFAULTS.url; // 最後に表示した URL（黒い画面のこともある）
  let status = '';          // パネルに出す状態メッセージ
  let quitting = false;
  let retryTimer = null;    // 読み込み失敗後の再試行
  let focusOnShow = false;  // 最初の描画が済んで表示用ウィンドウを出すときに、フォーカスを移す

  // 操作せずに映し続けても、モニターのスリープ・スクリーンセーバーに入らせない
  powerSaveBlocker.start('prevent-display-sleep');

  // ---- コントロールパネル ----
  const panel = new BrowserWindow({
    ...panelBoundsFor(bounds, opts.auto),
    title: 'mywebview コントロールパネル',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  panel.maximize(); // 置いたディスプレイいっぱいに（作業領域に合わせて置いてから最大化する）
  panel.removeMenu();
  panel.loadFile(path.join(__dirname, 'panel', 'index.html'));
  // パネルにファイルやリンクを落としても、パネル自体を別のページに移動させない
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  // パネルが異常終了したら読み込み直す（状態は panel:init で復元される）
  //   少し待つ（起動に失敗し続ける場合に、休みなく繰り返さない）。待つ間に終了していたら何もしない
  panel.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (!panel.isDestroyed()) panel.reload(); }, 1000);
  });
  app.on('second-instance', () => {
    if (panel.isMinimized()) panel.restore();
    panel.focus();
  });

  const sendToPanel = (channel, ...args) => {
    if (!panel.isDestroyed()) panel.webContents.send(channel, ...args);
  };
  const alive = () => display && !display.isDestroyed();
  // 入力欄に出す URL（黒い画面のときは空）
  const shownUrl = (url) => (isBlank(url) ? '' : url);
  const currentTarget = () => (front ? front.text : alive() ? shownUrl(display.webContents.getURL() || lastUrl) : '');
  // 前に出しているもの（リストで表示中にする）: exe の指定文字列 / 'web'（ブラウザ表示）/ ''（何も無い）
  const selectedKey = () => (front ? front.text : alive() ? 'web' : '');
  // ブラウザ表示の今の URL（exe を前に出している間も。リストのブラウザ表示の行に出す）
  //   → { url, canGoBack, canGoForward } | null（ブラウザ表示が無い）。url は黒い画面のときは空
  const webState = () => {
    if (!alive()) return null;
    const h = display.webContents.navigationHistory;
    return { url: shownUrl(display.webContents.getURL() || lastUrl), canGoBack: h.canGoBack(), canGoForward: h.canGoForward() };
  };
  const sendWeb = () => sendToPanel('display:web', webState());
  const sendSelected = () => {
    sendToPanel('display:selected', selectedKey());
    sendWeb();
  };
  const setStatus = (m) => { status = m; sendToPanel('display:status', m); };
  // Web ページの状態。exe を前に出している間は、exe の状態表示を上書きしない
  const setWebStatus = (m) => { if (!front) setStatus(m); };

  // ここから先の想定外のエラーは、ダイアログを出さず（本番中に出ると操作を妨げる）記録して動き続ける
  process.on('unhandledRejection', logError);
  process.on('uncaughtException', (e) => {
    logError(e);
    setStatus(`内部エラー（mywebview-error.log に記録しました）: ${e?.message ?? e}`);
  });
  const sendRunning = () => sendToPanel('display:running', [...exes.keys()]);
  // 前に出している exe のウィンドウのキャプチャ用 ID（desktopCapturer の DesktopCapturerSource.id と同じ形式）
  const sourceId = () => (front?.hwnd ? `window:${front.hwnd}:0` : null);
  // exe は疑似表示できない（他のプロセスのウィンドウは画面外に描画させられない）ので、常に実表示
  const exeNote = () => (coveredByDisplays(bounds) ? '' : '表示領域がモニターに収まらないため、正しく表示されない場合があります');

  // プレビューの縦横比・区切り位置は「実際の」ウィンドウサイズに合わせる
  // （OS 側でサイズが制限されると指定値と異なることがある）
  const currentBounds = () => {
    if (front) {
      const r = front.rect(); // 物理ピクセル
      return { ...(r ? screen.screenToDipRect(null, r) : bounds), virtual: false, exe: true };
    }
    // 表示用ウィンドウが無いとき（exe で起動して、それを閉じた後等）は指定値
    return virtual || !alive()
      ? { ...bounds, virtual }
      : { ...display.getContentBounds(), virtual: false };
  };
  const onBoundsChange = () => sendToPanel('display:bounds', currentBounds());

  // ---- プレビュー ----
  let lastFrame = null; // パネルの読み込み前に描画された分を初期表示に使う
  const sendFrame = (img) => {
    if (img.isEmpty()) return;
    lastFrame = img.resize({ width: PREVIEW_WIDTH, quality: 'good' }).toJPEG(75);
    sendToPanel('preview:frame', lastFrame);
  };

  let previewTimer = null;
  let capturing = false;
  // モニターに表示している（実表示で表示領域がモニターに収まる）ときは、起動時はプレビュー OFF（負荷を減らす）。
  // 疑似表示ではプレビューでしか見えないので ON
  let previewOn = virtual || !coveredByDisplays(bounds);

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
    on = on && !front; // exe を前に出している間は、パネル側で exe のウィンドウを動画でキャプチャする
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
      maximizable: false,
      webPreferences: {
        backgroundThrottling: false,
        offscreen: virtual,
        // ページの全画面表示（Google スライドのスライドショー・動画の全画面ボタン等）でも、ウィンドウを
        // 1 つのモニターに縮めない（ページ側は全画面になり、表示領域いっぱいに広がる）
        disableHtmlFullscreenWindowResize: true,
      },
    });
    display = win;
    displayReady = false;
    const createdAt = Date.now();
    let failed = false; // 読み込みに失敗して再試行中
    // オフスクリーンでも作成時は画面サイズに制限されるので、作成直後に指定サイズへ設定し直す
    if (virtual) win.setBounds(bounds);

    // 複数モニターにまたがる場合、作成時に OS 側でサイズが調整されることがあるので、
    // 表示後にもう一度位置とサイズを設定する
    win.once('ready-to-show', () => {
      if (display === win) displayReady = true;
      if (!virtual && !front) { // exe を前に出していたら、Web ページに切り替えたときに出す
        win.showInactive(); // パネルからフォーカスを奪わない（パネルで選んだときは下で移す）
        win.setBounds(bounds);
        if (focusOnShow && display === win) win.focus();
      }
      if (display === win) focusOnShow = false;
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
      // 空のウィンドウを開いてから中身を入れるページ（window.open() の後で移動先を設定する等）の about:blank は
      // 読み込まない（表示中のページが真っ白な画面に置き換わるだけになる）
      if (u === 'about:blank') return { action: 'deny' };
      win.loadURL(u).catch(() => {}); // 読み込み失敗は did-fail-load で扱う
      return { action: 'deny' };
    });
    // 編集中の確認（beforeunload）を出すページでも、パネルからの切り替えを止めさせない
    win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
    // 読み込み失敗（ネットワークの切断等）は真っ白になるだけなので、パネルに出して、読み込めるまで再試行する
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 (ERR_ABORTED): 別の URL への切り替え・ダウンロード等
      failed = true;
      setWebStatus(`読み込めません（${desc}）。${RETRY_MS / 1000} 秒ごとに再試行します: ${failedUrl}`);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        // 失敗したページのままのときだけ（ページを表示したままの失敗（未対応のスキーム等）では再試行しない）
        if (display === win && !win.isDestroyed() && win.webContents.getURL() === failedUrl) {
          win.loadURL(failedUrl).catch(() => {});
        }
      }, RETRY_MS);
    });
    // ページの異常終了（メモリ不足等）は読み込み直す
    win.webContents.on('render-process-gone', (_e, { reason }) => {
      if (reason === 'clean-exit') return;
      setWebStatus(`ページが異常終了したため、読み込み直しました（${reason}）`);
      // 少し待つ（起動に失敗し続ける場合に、休みなく繰り返さない）
      setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 1000);
    });
    // スクロールバーを非表示にする（表示されているとその幅だけページのレイアウト幅が狭くなるため）。
    // ホイール等でのスクロールはそのまま可能
    win.webContents.on('dom-ready', () => {
      win.webContents.insertCSS(
        '::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; }',
        { cssOrigin: 'user' },
      ).catch(() => {});
    });
    const onNavigate = () => {
      if (display !== win) return;
      if (!front) sendToPanel('display:url', shownUrl(win.webContents.getURL())); // exe を前に出している間は入力欄を変えない
      sendWeb();
    };
    win.webContents.on('did-navigate', onNavigate);
    // 読み込めた（失敗時は did-navigate が来ない）
    win.webContents.on('did-navigate', () => {
      if (failed) setWebStatus('');
      failed = false;
    });
    win.webContents.on('did-navigate-in-page', onNavigate);
    // 最大化・全画面にされる（Win+↑・画面端へのドラッグ等）と 1 つのモニターに収まるので、表示領域に戻す
    const keepBounds = () => setImmediate(() => {
      if (win.isDestroyed()) return;
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      if (!virtual) win.setBounds(bounds);
    });
    win.on('maximize', keepBounds);
    win.on('enter-full-screen', keepBounds);
    win.on('resize', onBoundsChange);
    win.on('move', onBoundsChange);
    win.on('show', onBoundsChange);

    if (virtual) {
      win.webContents.setFrameRate(fps());
      win.webContents.on('paint', (_e, _dirty, img) => {
        if (previewOn && display === win && !panel.isDestroyed()) sendFrame(img);
      });
    }

    // 表示用ウィンドウが閉じられたら（ページの window.close()・Alt+F4 等）、最後に選んだ URL で作り直す。
    // アプリの終了はパネルから（モード切替での作り直し・終了時は除く）
    win.on('closed', () => {
      if (switching || quitting || display !== win) return;
      display = null;
      if (Date.now() - createdAt < QUICK_CLOSE_MS) {
        setStatus('ページがすぐにウィンドウを閉じたため、表示をやめました');
        sendToPanel('display:url', currentTarget());
        sendSelected();
        return;
      }
      createDisplay(lastUrl);
      setStatus('表示用ウィンドウが閉じられたため、表示し直しました');
    });

    win.loadURL(url).catch(() => {}); // 読み込み失敗は did-fail-load で扱う
    setPreview(previewOn);
    onBoundsChange();
  }

  // 幕は画面消去の黒いウィンドウより手前（黒いウィンドウを出し直したら、幕も出し直す）
  const curtainShown = () => curtainWin && !curtainWin.isDestroyed() && curtainWin.isVisible();
  // ---- 画面を消す（表示領域を最前面の黒いウィンドウで覆う。Web ページ・exe のどちらの上にも出る） ----
  // プレビューには裏の実際の内容が映り続ける（消している間に次の準備ができる）
  //   疑似表示の間は出さない（モニターに出していない。表示領域がパネルのモニターに重なることもある）。
  //   消していたことは覚えておき、実表示に戻ったら消し直す（幕も同じ。placeCovers()）
  let blackout = false;
  let blackWin = null;
  //   戻したときは、消す前にフォーカスがあったのが表示側なら、表示側に戻す
  let refocusOnRestore = false;
  // 黒いウィンドウを今の状態に合わせる（消していて実表示なら表示領域に出し、そうでなければ隠す）
  function placeBlack() {
    if (blackout && !virtual) {
      if (!blackWin || blackWin.isDestroyed()) {
        blackWin = new BrowserWindow({
          ...bounds, frame: false, show: false, backgroundColor: '#000000', hasShadow: false,
          focusable: false, skipTaskbar: true, resizable: false, alwaysOnTop: true,
        });
        blackWin.setAlwaysOnTop(true, 'screen-saver'); // exe のウィンドウより上に出す
        blackWin.loadURL(`data:text/html,${encodeURIComponent('<html style="background:#000;cursor:none"></html>')}`);
      }
      blackWin.showInactive(); // パネルからフォーカスを奪わない
      blackWin.setBounds(bounds); // 複数モニターにまたがると作成時に OS 側でサイズが調整されることがある
      if (curtainShown()) curtainWin.moveTop();
    } else if (blackWin && !blackWin.isDestroyed()) {
      blackWin.hide();
    }
  }
  function setBlackout(on) {
    if (on && virtual) return false; // 疑似表示の間は、新しく消せない（消していたことは覚えたまま）
    const next = Boolean(on);
    if (next && !blackout) refocusOnRestore = focusBeforePanel() === 'display';
    const restoring = blackout && !next;
    blackout = next;
    if (restoring && refocusOnRestore) setImmediate(focusFront); // 黒いウィンドウを隠してから
    placeBlack();
    sendToPanel('display:blackout', blackout && !virtual);
    return blackout && !virtual;
  }

  // ---- 緞帳（幕を下ろして表示領域を隠す・上げて見せる。透明なウィンドウを最前面に重ねて幕を動かす） ----
  //   幕の絵柄は url_list.txt と同じ場所の curtain.png / .jpg / .webp（無ければ CSS で描いた赤い幕）。
  //   閉めている間もプレビューには裏の実際の内容が映る。開けたら、閉める前に表示側にあったフォーカスを戻す
  //   動いている間に押し直したら、その位置から向きを変える（押した回数だけ順に動かすことはしない）
  let curtainClosed = false; // 閉めている（疑似表示の間は出さないが、覚えておいて実表示に戻ったら出し直す）
  let curtainWin = null;
  let curtainQueue = Promise.resolve(); // 幕のウィンドウの作り直しを 1 つずつ行う
  let refocusOnCurtainOpen = false;
  function curtainImage() {
    const dir = path.dirname(findUrlListPath());
    const file = ['curtain.png', 'curtain.jpg', 'curtain.jpeg', 'curtain.webp']
      .map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    return file ? pathToFileURL(file).href : '';
  }
  // 幕のウィンドウ broken を作り直す（順番待ち。reviveCurtain()）
  const reviveCurtainLater = (broken) => {
    curtainQueue = curtainQueue.then(() => reviveCurtain(broken)).catch(logError);
  };
  function curtainWindow() {
    if (curtainWin && !curtainWin.isDestroyed()) return curtainWin;
    const win = new BrowserWindow({
      ...bounds, frame: false, show: false, transparent: true, hasShadow: false,
      focusable: false, skipTaskbar: true, resizable: false, alwaysOnTop: true,
      webPreferences: { backgroundThrottling: false },
    });
    curtainWin = win;
    win.setAlwaysOnTop(true, 'screen-saver'); // exe のウィンドウより上に出す
    // 幕のページが異常終了したら作り直す（透明なウィンドウなので、閉めていても裏が見えてしまう）
    win.webContents.on('render-process-gone', (_e, { reason }) => {
      if (reason === 'clean-exit' || curtainWin !== win) return;
      logError(new Error(`幕のページが異常終了しました（${reason}）`));
      reviveCurtainLater(win);
    });
    // クリックは幕で受け止める（閉めている間は、裏の表示用ウィンドウ・exe を誤って操作させない）
    win.loadFile(path.join(__dirname, 'panel', 'curtain.html'), { query: { img: curtainImage() } });
    return win;
  }
  // p を ms だけ待つ。終わらなければ（幕のページが固まった・描画が止まった等）エラーにする
  const within = (p, ms, what) => {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}が ${ms / 1000} 秒待っても終わりません`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  // 幕を動かす。instant: 動きを見せずに、すぐその状態にする
  //   → 動き終わったら true。動いている間に次の指示が来たら false（幕のページが、その位置から次の指示に移る）
  async function moveCurtain(win, close, instant = false) {
    if (win.webContents.isLoading()) {
      await within(new Promise((r) => win.webContents.once('did-finish-load', r)), CURTAIN_LOAD_MS, '幕の読み込み');
    }
    const show = () => {
      // 待っている間に、開け直された・疑似表示になった・作り直されたときは出さない
      if (!curtainClosed || virtual || win.isDestroyed()) return;
      win.showInactive(); // パネルからフォーカスを奪わない
      win.setBounds(bounds); // 複数モニターにまたがると作成時に OS 側でサイズが調整されることがある
    };
    if (close && !instant) show(); // 下りてくる動きを見せる
    const done = await within(
      win.webContents.executeJavaScript(`curtain(${close}, ${instant})`), CURTAIN_STEP_MS, '幕の動き');
    if (close && instant && done) show(); // 閉めた状態にしてから出す
    return done;
  }
  // 閉めているはずの幕を、動きは省いてすぐ閉めた状態で出す（幕のウィンドウを作り直したとき）
  async function recloseCurtain(message) {
    try {
      await moveCurtain(curtainWindow(), true, true);
      if (message) setStatus(message);
    } catch (e) {
      logError(e);
      setStatus('幕を出せません。「画面を消す」で隠してください（mywebview-error.log に記録しました）');
    }
  }
  // 幕のウィンドウ broken が使えなくなった（異常終了・固まった・読み込めない）ので作り直す。
  // 閉めているはずなら、すぐ閉めた状態で出す。パネルにも出す（幕が一度消えたことに気づけるように）
  let curtainRevivedAt = 0;
  async function reviveCurtain(broken) {
    if (curtainWin !== broken) return; // 既に作り直した
    // 作り直してもすぐ使えなくなる場合に、休みなく繰り返さない
    if (Date.now() - curtainRevivedAt < CURTAIN_RETRY_MS) await new Promise((r) => setTimeout(r, 1000));
    curtainRevivedAt = Date.now();
    if (!broken.isDestroyed()) broken.destroy();
    curtainWin = null;
    if (!curtainClosed) return; // 開けているなら、次に閉めるときに作る
    await recloseCurtain('幕のウィンドウに異常があったため、幕を出し直しました（mywebview-error.log に記録しました）');
  }
  function setCurtain(close) {
    if (close && virtual) return false; // 疑似表示の間は、新しく閉められない（閉めていたことは覚えたまま）
    close = Boolean(close);
    if (close === curtainClosed) return curtainClosed && !virtual;
    curtainClosed = close;
    if (close) refocusOnCurtainOpen = focusBeforePanel() === 'display';
    sendToPanel('display:curtain', close);
    const win = close ? curtainWindow() : curtainWin; // 開けるときに無ければ（作り直せなかった等）何も出ていない
    if (!win || win.isDestroyed()) return close;
    // 前の動きが終わるのを待たずに指示する（幕のページが、今の位置から向きを変える）
    moveCurtain(win, close).then((done) => {
      // 開け終わったら隠す（透明でも最前面にあると負荷がかかる）。その間に閉め直されていたら隠さない
      if (done && !close && !curtainClosed) {
        if (!win.isDestroyed()) win.hide();
        if (refocusOnCurtainOpen) focusFront();
      }
    }).catch((e) => {
      logError(e);
      reviveCurtainLater(win);
    });
    return close;
  }
  // 幕・画面消去のウィンドウを今の状態に合わせる: 実表示なら表示領域に出し（置き直し）、疑似表示の間は隠す。
  //   疑似表示に切り替わっても、閉めていた・消していたことは覚えておき、実表示に戻ったら出し直す
  //   （モニターが一時的に外れただけで、隠していた内容が見えてしまわないように）
  function placeCovers() {
    placeBlack();
    const win = curtainWin && !curtainWin.isDestroyed() ? curtainWin : null;
    if (virtual) {
      if (win) win.hide(); // 閉めた状態のまま隠しておく
    } else if (curtainClosed) {
      if (win) {
        win.showInactive();
        win.setBounds(bounds);
      } else {
        curtainQueue = curtainQueue.then(() => { if (curtainClosed && !virtual) return recloseCurtain(); }).catch(logError);
      }
    }
    // パネルには、今モニターに出ているかを伝える（疑似表示の間は、どちらのボタンも使えない）
    sendToPanel('display:blackout', blackout && !virtual);
    sendToPanel('display:curtain', curtainClosed && !virtual);
  }

  // 疑似表示 ⇔ 実表示 の切り替え（表示用ウィンドウを作り直し、同じ URL を読み込み直す）
  function setVirtual(next) {
    if (front || next === virtual) return virtual; // exe は常に実表示
    const url = (alive() && display.webContents.getURL()) || lastUrl;
    switching = true;
    clearInterval(previewTimer);
    previewTimer = null;
    if (alive()) display.destroy();
    virtual = next;
    // 幕・画面消去は、疑似表示の間は隠し、実表示に戻したら出し直す（表示用ウィンドウを出す前に）
    const covers = [curtainClosed && '幕', blackout && '画面消去'].filter(Boolean).join('・');
    placeCovers();
    lastFrame = null;
    createDisplay(url);
    switching = false;
    if (covers && !virtual) setStatus(`実表示に戻ったため、${covers}を元に戻しました`);
    return virtual;
  }

  // ---- 切り替え効果（試作） ----
  //   切り替え前の画面を静止画で撮って一番手前の透明なウィンドウに出し、その裏で新しい表示に切り替えて
  //   読み込みを待ってから、静止画を消していく（フェード・タイルをランダムに 1 枚ずつ等。transition.js）
  //   疑似表示・幕を閉めている・画面を消しているときは、効果なしで切り替える（モニターには見えない）
  let transition = { effect: 'none', ms: 2000, order: 'random' };
  let transWin = null;
  let transBusy = false; // 効果の途中（その間の切り替えは効果なしで行い、続きの効果がそのまま見せる）
  function transitionWindow() {
    if (transWin && !transWin.isDestroyed()) return transWin;
    const win = new BrowserWindow({
      ...bounds, frame: false, show: false, transparent: true, hasShadow: false,
      focusable: false, skipTaskbar: true, resizable: false, alwaysOnTop: true,
      webPreferences: { backgroundThrottling: false },
    });
    transWin = win;
    win.setAlwaysOnTop(true, 'screen-saver'); // exe のウィンドウより上に出す
    // 異常終了したら捨てる（次の切り替えで作り直す。静止画が残って新しい表示を隠さないよう、すぐ隠す）
    win.webContents.on('render-process-gone', (_e, { reason }) => {
      if (reason === 'clean-exit') return;
      logError(new Error(`切り替え効果のページが異常終了しました（${reason}）`));
      if (transWin === win) transWin = null;
      win.destroy();
    });
    win.loadFile(path.join(__dirname, 'panel', 'transition.html'));
    return win;
  }
  const toShot = (img, x, y, w, h) => ({ src: `data:image/jpeg;base64,${img.toJPEG(90).toString('base64')}`, x, y, w, h });
  // 今モニターに出ている表示を撮る → transition.js の cover() に渡す形。撮れなければ null
  //   Web ページはページだけを撮る。exe は表示領域に重なるモニターの画面ごとに撮る
  async function captureFront() {
    if (!front) {
      if (!alive() || !displayReady || !display.isVisible()) return null;
      const img = await display.webContents.capturePage();
      return img.isEmpty() ? null : [toShot(img, 0, 0, 1, 1)];
    }
    const ds = screen.getAllDisplays().filter((d) => {
      const b = d.bounds;
      return b.x < bounds.x + bounds.width && bounds.x < b.x + b.width && b.y < bounds.y + bounds.height && bounds.y < b.y + b.height;
    });
    if (!ds.length) return null;
    const size = {
      width: Math.max(...ds.map((d) => Math.round(d.bounds.width * d.scaleFactor))),
      height: Math.max(...ds.map((d) => Math.round(d.bounds.height * d.scaleFactor))),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const shots = [];
    for (const d of ds) {
      const s = sources.find((v) => v.display_id === String(d.id));
      if (!s || s.thumbnail.isEmpty()) return null; // 一部でも撮れなければ効果なし（古い表示が欠けて見える）
      const b = d.bounds;
      shots.push(toShot(s.thumbnail, (b.x - bounds.x) / bounds.width, (b.y - bounds.y) / bounds.height,
        b.width / bounds.width, b.height / bounds.height));
    }
    return shots;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 切り替えた後の表示が出そろうのを待つ（上限あり。新しいページの読み込み・exe のウィンドウが見つかるまで）
  async function waitShown() {
    await sleep(100);
    const start = Date.now();
    if (!front) {
      while (Date.now() - start < TRANSITION_LOAD_MS && !front &&
          (!alive() || !displayReady || display.webContents.isLoading())) await sleep(100);
      await sleep(TRANSITION_SETTLE_MS);
      return;
    }
    const exe = front;
    while (Date.now() - start < TRANSITION_EXE_MS && front === exe && !exe.ended && !(exe.hwnd && exe.rect())) await sleep(100);
    await sleep(TRANSITION_EXE_SETTLE_MS);
  }
  // 静止画を消して切り替え効果のウィンドウを隠す（次に出したときに古い静止画が見えないよう、消してから隠す）
  async function hideTransition(win) {
    if (!win || win.isDestroyed()) return;
    try {
      await within(win.webContents.executeJavaScript('clear()'), TRANSITION_STEP_MS, '切り替え効果の片付け');
    } catch (e) {
      logError(e);
      win.destroy(); // 静止画が残ったままかもしれないので捨てる（次の切り替えで作り直す）
      if (transWin === win) transWin = null;
      return;
    }
    if (!win.isDestroyed()) win.hide();
  }
  // action（表示を切り替える関数。エラーならメッセージを返す）を、切り替え効果をかけて行う
  async function switchWithEffect(action) {
    const { effect, ms, order } = transition;
    if (effect === 'none' || transBusy || virtual || curtainClosed || blackout) return action();
    transBusy = true;
    let win = null;
    try {
      // 切り替え前の画面を出す。うまくいかなければ効果なしで切り替える（本番の切り替えを止めない）
      try {
        const shots = await within(captureFront(), TRANSITION_STEP_MS, '切り替え前の画面の取得');
        if (!shots || virtual || curtainClosed || blackout) return action();
        win = transitionWindow();
        if (win.webContents.isLoading()) {
          await within(new Promise((r) => win.webContents.once('did-finish-load', r)), TRANSITION_STEP_MS, '切り替え効果の読み込み');
        }
        win.showInactive(); // パネルからフォーカスを奪わない（透明なので、静止画を描くまでは何も変わらない）
        win.setBounds(bounds); // 複数モニターにまたがると作成時に OS 側でサイズが調整されることがある
        win.moveTop();
        const drawn = await within(win.webContents.executeJavaScript(
          `cover(${JSON.stringify(shots)}, ${opts.cols}, ${opts.rows})`), TRANSITION_STEP_MS, '切り替え前の画面の表示');
        if (!drawn) throw new Error('切り替え前の画面を表示できません');
      } catch (e) {
        logError(e);
        await hideTransition(win);
        win = null;
        return action();
      }
      const err = action();
      if (err) return err;
      await waitShown();
      await within(win.webContents.executeJavaScript(`reveal(${JSON.stringify(effect)}, ${ms}, ${JSON.stringify(order)})`),
        ms + TRANSITION_STEP_MS, '切り替え効果');
      return null;
    } catch (e) {
      logError(e);
      return null;
    } finally {
      await hideTransition(win);
      transBusy = false;
    }
  }
  function setTransition(next) {
    const effect = TRANSITION_EFFECTS.includes(next?.effect) ? next.effect : transition.effect;
    const ms = Number.isFinite(next?.ms) ? Math.min(Math.max(Math.round(next.ms), 200), 20000) : transition.ms;
    const order = TRANSITION_ORDERS.includes(next?.order) ? next.order : transition.order;
    transition = { effect, ms, order };
    if (effect !== 'none' && !virtual) transitionWindow(); // 先に読み込んでおく（最初の切り替えで待たないよう）
    return transition;
  }

  // ---- 表示の切り替え ----
  // 前に出すものを切り替える（next: exe か null = Web ページ）。前に出ていたものは隠す（exe は最小化）
  //   focus: 前に出したウィンドウにフォーカスを移す（パネルで選んだとき）。疑似表示の Web ページは画面に無いので移さない
  function bringToFront(next, { focus = false } = {}) {
    const prev = front;
    front = next;
    history = history.filter((v) => v !== (next ?? 'web'));
    history.push(next ?? 'web');
    // 先に出してから隠す（逆だと一瞬デスクトップが見える）
    focusOnShow = false;
    if (next) {
      next.show({ focus }); // ウィンドウがまだ無ければ、見つかったときにフォーカスを移す
      // 前に出そうとした exe が終了していた（show() の中で気づく）ときは、onExeChange() が 1 つ前の表示に
      // 戻し終えている。続けると、戻した表示用ウィンドウを隠してしまう（何も映らなくなる）
      if (front !== next) return;
      if (alive() && !virtual) display.hide();
    } else if (alive() && !virtual && displayReady) { // 最初の描画前なら ready-to-show で出る
      display.showInactive(); // パネルからフォーカスを奪わない（パネルで選んだときは下で移す）
      display.setBounds(bounds);
      display.moveTop();
      if (focus) display.focus();
    } else if (focus && !virtual) {
      focusOnShow = true;
    }
    if (prev && prev !== next) prev.hide();
    setPreview(previewOn);
    sendToPanel('preview:source', sourceId());
    sendToPanel('display:url', currentTarget());
    sendSelected();
    onBoundsChange();
    setStatus(next ? exeNote() : '');
  }

  // exe の状態が変わった（launchExe() の onChange）
  function onExeChange(exe, message) {
    if (quitting) return;
    if (exe.ended) {
      if (exes.get(exe.text) === exe) exes.delete(exe.text);
      history = history.filter((v) => v !== exe);
      if (front === exe) {
        front = null; // 終了した exe を隠そうとしないよう、先に外す
        // 1 つ前に表示していたものに戻し、フォーカスも移す。無ければ何も表示しない
        const prev = history.at(-1);
        if (prev) {
          bringToFront(prev === 'web' ? null : prev, { focus: true });
        } else {
          sendToPanel('preview:source', null);
          sendToPanel('display:url', currentTarget());
          sendSelected();
          onBoundsChange();
        }
      }
      sendRunning();
      if (message) setStatus(`${exe.name}: ${message}`);
      return;
    }
    if (exe !== front) return; // 背面の exe の変化（ウィンドウが見つかった等）はパネルに出さない
    sendToPanel('preview:source', sourceId());
    onBoundsChange();
    if (message !== undefined) setStatus([message, exeNote()].filter(Boolean).join('　'));
  }

  // 表示対象（URL または exe）を切り替える。エラーならメッセージを返す
  //   exe は起動中ならそのまま前に出し、前に出ていた exe は閉じずに最小化しておく
  //   focus: 前に出したウィンドウにフォーカスを移す（パネルで選んだとき）
  function show(raw, { focus = false } = {}) {
    const t = parseTarget(raw);
    if (!t) return `不正な URL です: ${raw}`;
    if (t.url) {
      lastUrl = t.url;
      clearTimeout(retryTimer); // 前の URL の再試行で、この切り替えを取り消さない
      if (alive()) display.loadURL(t.url).catch(() => {}); // 読み込み失敗は did-fail-load で扱う
      else createDisplay(t.url);
      bringToFront(null, { focus });
      return null;
    }
    if (process.platform !== 'win32') return 'exe の表示は Windows のみ対応しています';
    let exe = exes.get(t.exe.text);
    const isNew = !exe;
    if (isNew) {
      try {
        exe = launchExe(t.exe, () => screen.dipToScreenRect(null, bounds), (m) => onExeChange(exe, m));
      } catch (e) {
        return `exe を起動できません: ${e.message}`;
      }
      exes.set(t.exe.text, exe);
      sendRunning();
    }
    bringToFront(exe, { focus });
    if (isNew && !exe.ended) setStatus(['起動中…', exeNote()].filter(Boolean).join('　')); // 終了の表示は上書きしない
    return null;
  }

  const startError = show(opts.target, { focus: true }); // 起動時のフォーカスも表示側に（パネルは後から選べる）
  if (startError) {
    console.error(startError);
    dialog.showErrorBox('mywebview', startError);
    app.exit(1);
    return;
  }
  // mywebview を終了するときは、起動中の exe をすべて閉じる
  app.on('before-quit', () => {
    quitting = true;
    for (const exe of exes.values()) exe.close();
  });

  // モニター構成の変化（ケーブルの抜き差し・モニターの電源・スリープ復帰等）で OS がウィンドウを動かすので、
  // 落ち着いてから置き直す（背面のものは、前に出すときに置き直される）
  let replaceTimer = null;
  const replaceLater = () => {
    clearTimeout(replaceTimer);
    replaceTimer = setTimeout(() => {
      if (opts.auto) relayout();
      if (front) front.show();
      else if (alive() && displayReady && (!virtual || opts.auto)) display.setBounds(bounds); // 疑似表示はサイズだけ
      placeCovers();
      onBoundsChange();
    }, REPLACE_DELAY_MS);
  };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, replaceLater);

  // 自動配置: モニター構成が変わったら表示領域を決め直す。拡張モニターがすべて外れたら、元の表示領域のまま
  // （ケーブルが一時的に抜けただけで、表示中のページのレイアウトを変えないため）
  function relayout() {
    const l = autoLayout();
    if (l) Object.assign(bounds, l.bounds);
    // 表示モードを指定していなければ、拡張モニターの有無に合わせて切り替える（exe 表示中は常に実表示）
    if (!opts.virtual && !opts.real && !front) {
      const next = autoVirtual(l);
      if (next !== virtual) {
        setVirtual(next);
        // 疑似表示はプレビューでしか見えないので ON にする
        if (next && !previewOn) {
          previewOn = true;
          setPreview(true);
          sendToPanel('display:preview', true);
        }
      }
    }
    layoutNotes = layoutNotesFor(l);
    // パネルをプライマリに置き直す。既にプライマリで最大化されていれば触らない（最大化し直すとパネルが
    // アクティブになり、表示側からフォーカスを奪う。モニターが一瞬切れただけで発表者のキー操作が効かなくなる）
    if (!panel.isDestroyed() && !(panel.isMaximized() &&
        screen.getDisplayMatching(panel.getBounds()).id === screen.getPrimaryDisplay().id)) {
      const onDisplay = focusState() === 'display';
      if (panel.isMaximized()) panel.unmaximize();
      panel.setBounds(panelBoundsFor(bounds, true));
      panel.maximize();
      if (onDisplay) focusFront(); // 置き直しでパネルに移ったフォーカスを、表示側に戻す
    }
    sendToPanel('display:layout', { requested: { ...bounds }, notes: layoutNotes });
  }

  // ---- フォーカスの場所（パネルに表示する） ----
  //   'display': 表示側（Web ページ・前に出している exe）/ 'panel': コントロールパネル / 'other': 他のアプリ等
  //   exe のウィンドウは他のプロセスのものでイベントが来ないので、定期的に調べて変わったときだけ送る
  const focusState = () => {
    let onDisplay = false;
    try {
      onDisplay = front ? front.focused() : alive() && !virtual && display.isFocused();
    } catch {
      // exe のウィンドウが閉じた直後等は調べられないことがある
    }
    if (onDisplay) return 'display';
    return !panel.isDestroyed() && panel.isFocused() ? 'panel' : 'other';
  };
  let focus = focusState();
  let prevFocus = focus; // 1 つ前のフォーカスの場所（パネルのボタンを押す前にどこにあったか）
  setInterval(() => {
    const next = focusState();
    if (next === focus) return;
    prevFocus = focus;
    sendToPanel('display:focus', (focus = next));
  }, FOCUS_POLL_MS);
  // パネルを操作する直前のフォーカスの場所（ボタンを押すとパネルに移るので、その前）
  const focusBeforePanel = () => {
    const now = focusState();
    if (now !== 'panel') return now;
    return focus === 'panel' ? prevFocus : focus; // まだ定期の確認で気づいていなければ、focus が直前の場所
  };
  // 前に出しているもの（Web ページ・exe）にフォーカスを移す
  const focusFront = () => {
    if (front) front.focus();
    else if (alive() && !virtual) display.focus();
  };

  // ---- パネルからの要求 ----
  ipcMain.handle('panel:init', () => ({
    url: currentTarget(),
    selected: selectedKey(),
    web: webState(),
    list: loadUrlList(),
    requested: { ...bounds },
    layoutNotes,
    bounds: currentBounds(),
    frame: lastFrame,
    source: sourceId(),
    running: [...exes.keys()],
    blackout: blackout && !virtual, // 疑似表示の間は出していない（実表示に戻ったら出し直す）
    curtain: curtainClosed && !virtual,
    focus,
    status,
    previewOn,
    virtual,
    transition,
    grid: { cols: opts.cols, rows: opts.rows },
  }));
  ipcMain.handle('panel:navigate', (_e, raw) => switchWithEffect(() => show(raw, { focus: true })));
  // ブラウザ表示に戻す（読み込み直さず、今のページのまま前に出す）
  ipcMain.handle('panel:show-web', () => switchWithEffect(() => {
    if (alive()) {
      bringToFront(null, { focus: true });
      return null;
    }
    return show(lastUrl, { focus: true }); // 閉じていたら（すぐ閉じるページ等）最後の URL で開き直す
  }));
  // exe を閉じる（text 省略時は前に出ている exe）。exe は枠を消しているので閉じるボタンが無い
  ipcMain.handle('panel:close-exe', (_e, text) => {
    const exe = text ? exes.get(text) : front;
    if (!exe) return;
    exe.close(); // すぐに閉じれば、onExeChange() で一覧から消えて 1 つ前の表示に戻る
    if (!exe.ended) {
      setStatus(`${exe.name}: 終了を指示しました` +
        (exe === front ? '' : '（保存の確認などが出ている場合は、前に出して操作してください）'));
    }
  });
  ipcMain.handle('panel:set-preview', (_e, on) => {
    previewOn = Boolean(on);
    setPreview(previewOn);
    return previewOn;
  });
  ipcMain.handle('panel:set-virtual', (_e, on) => setVirtual(Boolean(on)));
  ipcMain.handle('panel:set-blackout', (_e, on) => setBlackout(on));
  ipcMain.handle('panel:set-curtain', (_e, close) => setCurtain(close));
  ipcMain.handle('panel:set-transition', (_e, t) => setTransition(t));
  ipcMain.handle('panel:reload-list', () => loadUrlList());
  // ブラウザ表示の「戻る」「進む」「再読み込み」（exe を前に出している間も、裏のページに対して行う）
  //   ボタンを押すとパネルにフォーカスが移るので、押す前に表示側にあったら戻す
  const refocus = () => { if (focusBeforePanel() === 'display') focusFront(); };
  ipcMain.handle('panel:web-back', () => {
    if (alive() && display.webContents.navigationHistory.canGoBack()) display.webContents.navigationHistory.goBack();
    refocus();
  });
  ipcMain.handle('panel:web-forward', () => {
    if (alive() && display.webContents.navigationHistory.canGoForward()) display.webContents.navigationHistory.goForward();
    refocus();
  });
  ipcMain.handle('panel:web-reload', () => {
    if (!alive()) return;
    clearTimeout(retryTimer); // 読み込み失敗後の再試行は、この再読み込みで置き換える
    display.webContents.reload();
    refocus();
  });

  // プレビュー上の操作を表示用ウィンドウへ転送
  ipcMain.on('panel:input', (_e, ev) => {
    if (!ev || !INPUT_TYPES.has(ev.type)) return;
    if (front) {
      const b = currentBounds();
      front.mouse(ev, ev.x / b.width, ev.y / b.height);
      return;
    }
    if (!alive()) return;
    if (ev.type === 'mouseDown' || ev.type === 'keyDown') {
      if (!display.webContents.isFocused()) display.webContents.focus();
    }
    display.webContents.sendInputEvent(ev);
    markInteractive();
  });
  // IME で確定した文字列（日本語入力など）
  ipcMain.on('panel:insert-text', (_e, text) => {
    if (front || !alive() || typeof text !== 'string' || !text) return;
    display.webContents.insertText(text);
    markInteractive();
  });

  // パネルを閉じたらアプリを終了（誤って閉じても本番が止まらないよう確認する）
  //   確認を出している間も動き続ける（showMessageBoxSync は答えるまでメインプロセスを止めるので、出したまま
  //   気づかないと、読み込みの再試行・表示用ウィンドウの作り直し・exe の配置・プレビューがすべて止まる）
  let confirming = false;
  panel.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (confirming) return;
    confirming = true;
    dialog.showMessageBox(panel, {
      // 'none': Windows はアイコンの種類に応じた音を鳴らすので、アイコンを出さない（本番中に音を出さない）
      type: 'none', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: 'mywebview を終了しますか？',
      detail: exes.size ? '起動中のアプリも閉じます。' : '',
    }).then(({ response }) => {
      if (response === 0) app.quit(); // before-quit で quitting になり、パネルも確認なしで閉じる
    }).finally(() => { confirming = false; });
  });
  panel.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
