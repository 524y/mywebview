// panel.js — コントロールパネル
const $ = (sel) => document.querySelector(sel);
const urlInput = $('#url');
const msg = $('#msg');
const listEl = $('#list');
const previewBtn = $('#preview-toggle');
const previewWrap = $('#preview-wrap');
const img = $('#preview-img');
const video = $('#preview-video'); // exe 表示中のプレビュー（ウィンドウのキャプチャ）

let currentUrl = '';
let previewOn = true;

// ---- 現在の URL（入力欄に出す） ----
function setCurrentUrl(url) {
  currentUrl = url;
  if (document.activeElement !== urlInput) urlInput.value = url; // 入力中は上書きしない
}

// ---- 表示中のもの・フォーカスの場所（リストに出す） ----
//   ブラウザ表示は 1 行にまとめ、今の URL を出す（地図等、操作で URL が変わっても追える）。
//   その行を押すと読み込み直さずに戻る。URL の項目を押すと、その URL を読み込み直す
let selected = '';        // 前に出しているもの: exe の指定文字列 / 'web' / ''
let web = null;           // ブラウザ表示の状態 { url, canGoBack, canGoForward }（無ければ null）
let focusWhere = 'other'; // 'display' | 'panel' | 'other'
function markList() {
  for (const b of listEl.querySelectorAll('button.item')) {
    b.classList.toggle('current', Boolean(selected) && b.dataset.key === selected);
    b.classList.toggle('focused', focusWhere === 'display'); // 表示中の項目にだけ見える（CSS）
  }
}
window.api.onSelected((key) => { selected = key; markList(); });
window.api.onFocus((where) => { focusWhere = where; markList(); });
window.api.onWeb((next) => {
  const had = Boolean(web);
  web = next;
  if (had !== Boolean(next)) renderList(); // 行を出す・消す
  else updateWebRow();
});
// ブラウザ表示の行の URL・「戻る」「進む」ボタンだけを更新する（地図の操作等で頻繁に来るので、リスト全体は作り直さない）
function updateWebRow() {
  const li = listEl.querySelector('li.web');
  if (!li || !web) return;
  const u = li.querySelector('.u');
  u.textContent = web.url || '（何も表示していません：黒い画面）';
  u.title = web.url;
  li.querySelector('.back').disabled = !web.canGoBack;
  li.querySelector('.forward').disabled = !web.canGoForward;
}
const sameUrl = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');

async function navigate(url) {
  msg.textContent = ''; // exe の状態メッセージは応答より先に届くので、応答後には消さない
  const err = await window.api.navigate(url);
  if (err) msg.textContent = err;
}
async function showWeb() {
  msg.textContent = '';
  const err = await window.api.showWeb();
  if (err) msg.textContent = err;
}

$('#bar').addEventListener('submit', (e) => {
  e.preventDefault();
  urlInput.blur();
  navigate(urlInput.value);
});
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { urlInput.value = currentUrl; urlInput.blur(); }
});
urlInput.addEventListener('focus', () => urlInput.select());

// ---- URL リスト ----
let listData = { file: '', items: [], error: null };
let running = []; // 起動中の exe（指定文字列）
// url_list.txt に無い起動中の exe（入力欄から起動したもの）の表示名: exe のファイル名
const exeName = (text) => text.replace(/^"([^"]+)".*$|^(\S+\.exe).*$/i, '$1$2').split('\\').pop();

// 1 行分（key: 表示中かを判定する値）
function listItem({ name, url, key, onClick }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item';
  b.dataset.key = key;
  b.innerHTML = '<span class="name"></span><span class="badge focus">フォーカス</span><span class="u"></span>';
  b.querySelector('.name').textContent = name;
  b.querySelector('.u').textContent = url;
  b.querySelector('.u').title = url;
  b.addEventListener('click', onClick);
  li.append(b);
  return li;
}

function renderList(data = listData) {
  listData = data;
  const { file, items, error } = data;
  $('#list-path').textContent = file;
  $('#list-path').title = file;
  $('#list-error').textContent = error ?? (items.length ? '' : 'URL が登録されていません');
  const rows = [];
  if (web) {
    const li = listItem({ name: 'ブラウザ表示', url: web.url, key: 'web', onClick: showWeb });
    li.classList.add('web');
    li.querySelector('.item').title = '今のページのまま前に出します（読み込み直しません）';
    const navBtn = (cls, text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn close ${cls}`;
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      li.append(b);
    };
    navBtn('back', '← 戻る', '1 つ前のページに戻ります', () => window.api.webBack());
    navBtn('forward', '進む →', '戻る前のページに進みます', () => window.api.webForward());
    navBtn('reload', '⟳ 再読込', 'ページを読み込み直します', () => window.api.webReload());
    rows.push(li);
  }
  // url_list.txt に無い起動中の exe（入力欄から起動したもの）も出して、戻ったり終了したりできるようにする
  const extra = running.filter((r) => !items.some((it) => it.url === r)).map((r) => ({ name: exeName(r), url: r }));
  for (const { name, url } of [...items, ...extra]) {
    const li = listItem({ name, url, key: url, onClick: () => navigate(url) });
    if (running.includes(url)) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '起動中';
      li.querySelector('.name').after(badge);
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'btn close';
      c.textContent = '終了';
      c.title = 'このアプリを閉じます';
      c.addEventListener('click', () => window.api.closeExe(url));
      li.append(c);
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      li.querySelector('.item').title = 'アプリを起動します';
    } else {
      li.querySelector('.item').title = 'この URL を読み込みます（ブラウザ表示の今のページは置き換わります）';
    }
    rows.push(li);
  }
  listEl.replaceChildren(...rows);
  updateWebRow();
  markList();
}
$('#list-reload').addEventListener('click', async () => renderList(await window.api.reloadList()));
window.api.onRunning((list) => { running = list; renderList(); });

// ---- プレビュー ----
// 表示領域を 16:9 ごとに区切った位置（0〜1）を返す。48:9 なら [1/3, 2/3]
function splitPoints({ width, height }) {
  const seg = (height * 16) / 9;
  const pts = [];
  // 高さが 0 だと seg も 0 でループが終わらず、パネルが固まる（exe が高さ 0 のウィンドウを作ったとき等）
  if (!(seg > 0)) return pts;
  for (let x = seg; x < width - 0.5; x += seg) pts.push(x / width);
  return pts;
}

let requested = null; // 起動時に指定した位置とサイズ
let displaySize = { width: 1, height: 1 }; // 表示領域の実サイズ（操作の座標変換用）

function setupPreview(bounds) {
  displaySize = { width: bounds.width, height: bounds.height };
  if (typeof bounds.virtual === 'boolean') setModeState(bounds.virtual);
  const exe = Boolean(bounds.exe);
  modeBtn.disabled = exe; // exe は常に実表示
  $('#exe-close').hidden = !exe;
  img.hidden = exe;
  video.hidden = !exe;
  $('#frame').title = exe
    ? 'クリックで操作（exe がアクティブになり、キー入力は exe が直接受け取ります）'
    : 'クリックで操作（キー入力もページに送られます）';
  const pts = splitPoints(bounds);
  const n = pts.length + 1;
  $('#frame').style.aspectRatio = `${bounds.width} / ${bounds.height}`;
  const screens = (bounds.width / ((bounds.height * 16) / 9)).toFixed(2).replace(/\.00$/, '');
  const differs = requested && (requested.width !== bounds.width || requested.height !== bounds.height);
  $('#preview-info').textContent =
    `表示領域 ${bounds.width}×${bounds.height}（位置 ${bounds.x}, ${bounds.y}） — 16:9 × ${screens} 画面分` +
    (bounds.virtual ? '　※ 疑似表示（モニターには表示していません）' : '') +
    (exe ? '　※ exe 表示中（マウス操作はアプリによって効かないことがあります）' : '') +
    (differs ? `　※ 指定 ${requested.width}×${requested.height} から OS により変更されています` : '');

  const mark = (pos) => { const i = document.createElement('i'); i.style.left = `${pos * 100}%`; return i; };
  $('#ruler-top').replaceChildren(...pts.map(mark));
  $('#ruler-bottom').replaceChildren(...pts.map(mark));

  const frame = $('#frame');
  frame.querySelectorAll('.split, .label').forEach((el) => el.remove());
  for (const p of pts) {
    const line = document.createElement('div');
    line.className = 'split';
    line.style.left = `${p * 100}%`;
    frame.append(line);
  }
  // 各区画の中央に番号を表示
  const edges = [0, ...pts, 1];
  for (let k = 0; k < n; k++) {
    const label = document.createElement('div');
    label.className = 'label';
    label.style.left = `${((edges[k] + Math.min(edges[k + 1], 1)) / 2) * 100}%`;
    label.textContent = `${k + 1}`;
    frame.append(label);
  }
}

function setPreviewState(on) {
  previewOn = on;
  previewBtn.classList.toggle('on', on);
  previewBtn.textContent = on ? 'プレビュー ON' : 'プレビュー OFF';
  previewWrap.hidden = !on;
  updateVideo();
}
previewBtn.addEventListener('click', async () => setPreviewState(await window.api.setPreview(!previewOn)));
window.api.onPreview(setPreviewState);

// ---- 表示領域の自動配置（モニター構成が変わると決め直される） ----
function setLayoutNotes(notes) {
  const el = $('#layout-note');
  el.textContent = notes.map((n) => `⚠ ${n}`).join('\n');
  el.hidden = !notes.length;
}
window.api.onLayout(({ requested: r, notes }) => {
  requested = r;
  setLayoutNotes(notes);
});

// ---- 表示モード（疑似表示 ⇔ 実表示） ----
const modeBtn = $('#mode-toggle');
let virtualMode = false;
function setModeState(v) {
  virtualMode = v;
  modeBtn.textContent = v ? '疑似表示' : '実表示';
  modeBtn.classList.toggle('on', !v);
  blackoutBtn.disabled = v; // 疑似表示ではモニターに出していない
  blackoutBtn.title = v ? '疑似表示中は使えません' : '表示領域（モニター）を真っ黒にします';
  curtainBtn.disabled = v;
  curtainBtn.title = v ? '疑似表示中は使えません' : '表示領域（モニター）に幕を下ろします';
}

// ---- 画面を消す ----
const blackoutBtn = $('#blackout');
let blackout = false;
function setBlackoutState(on) {
  blackout = on;
  blackoutBtn.classList.toggle('active', on);
  blackoutBtn.textContent = on ? '画面を戻す' : '画面を消す';
  $('#frame').classList.toggle('blackout', on);
}
blackoutBtn.addEventListener('click', async () => setBlackoutState(await window.api.setBlackout(!blackout)));
window.api.onBlackout(setBlackoutState);

// ---- 緞帳 ----
const curtainBtn = $('#curtain');
let curtainClosed = false;
function setCurtainState(closed) {
  curtainClosed = closed;
  curtainBtn.classList.toggle('active', closed);
  curtainBtn.textContent = closed ? '幕を開ける' : '幕を閉める';
  $('#frame').classList.toggle('curtain', closed);
}
curtainBtn.addEventListener('click', async (e) => {
  // ダブルクリック・連打の 2 回目以降は数えない（開けてすぐ閉め直してしまう）。キーボードで押したときは 0
  if (e.detail > 1) return;
  setCurtainState(await window.api.setCurtain(!curtainClosed));
});
window.api.onCurtain(setCurtainState);
// ---- 切り替え効果 ----
const effectSel = $('#effect');
const effectMs = $('#effect-ms');
const effectOrder = $('#effect-order');
function setTransitionState({ effect, ms, order }) {
  effectSel.value = effect;
  if (![...effectMs.options].some((o) => +o.value === ms)) effectMs.append(new Option(`${ms / 1000} 秒`, ms));
  effectMs.value = String(ms);
  effectMs.disabled = effect === 'none';
  effectOrder.value = order;
  effectOrder.disabled = !effect.startsWith('tiles');
}
const sendTransition = async () => setTransitionState(
  await window.api.setTransition({ effect: effectSel.value, ms: +effectMs.value, order: effectOrder.value }));
effectSel.addEventListener('change', sendTransition);
effectMs.addEventListener('change', sendTransition);
effectOrder.addEventListener('change', sendTransition);

modeBtn.addEventListener('click', async () => {
  modeBtn.disabled = true;
  try {
    setModeState(await window.api.setVirtual(!virtualMode));
    // 疑似表示はプレビューでしか見えないので、OFF なら ON にする
    if (virtualMode && !previewOn) setPreviewState(await window.api.setPreview(true));
  } finally {
    modeBtn.disabled = false;
  }
});

let lastObjectUrl = null;    // 表示中のフレーム
let loadingObjectUrl = null; // 読み込み中のフレーム
function showFrame(jpeg) {
  const objUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  // 前のフレームの読み込みが終わる前に次が来ると、前の分の onload は来ない（読み込みに失敗したときも）。
  // ここで解放しないと、長時間のうちに溜まり続ける
  if (loadingObjectUrl) URL.revokeObjectURL(loadingObjectUrl);
  loadingObjectUrl = objUrl;
  img.onload = () => {
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = objUrl;
    loadingObjectUrl = null;
  };
  img.src = objUrl;
}
window.api.onFrame(showFrame);

// exe のウィンドウをキャプチャして動画で表示する（プレビュー OFF 中は止める）
let exeSource = null;  // キャプチャするウィンドウの ID（無ければ null）
let streamSource = null;
let stream = null;
let videoGen = 0;      // 取得待ちの間に次の要求が来たら、古い方の結果は捨てる
async function updateVideo() {
  const want = previewOn ? exeSource : null;
  if (want === streamSource) return;
  const gen = ++videoGen;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  streamSource = want;
  video.srcObject = null;
  if (!want) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: want,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
      } },
    });
    if (gen !== videoGen) { s.getTracks().forEach((t) => t.stop()); return; } // 待っている間に変わった
    stream = s;
    video.srcObject = s;
  } catch (e) {
    if (gen === videoGen) msg.textContent = `プレビューを取得できません: ${e.message}`;
  }
}
window.api.onSource((id) => { exeSource = id; updateVideo(); });
$('#exe-close').addEventListener('click', () => window.api.closeExe());
window.api.onStatus((m) => { msg.textContent = m; });

// ---- プレビュー上の操作を転送 ----
const frame = $('#frame');
const kbd = $('#kbd');
const BUTTONS = ['left', 'middle', 'right'];

// プレビュー上の位置 → 表示領域の座標
function toDisplay(e) {
  const r = frame.getBoundingClientRect();
  const clamp = (v, max) => Math.min(Math.max(v, 0), max - 1);
  return {
    x: Math.round(clamp(((e.clientX - r.left) / r.width) * displaySize.width, displaySize.width)),
    y: Math.round(clamp(((e.clientY - r.top) / r.height) * displaySize.height, displaySize.height)),
  };
}
function keyMods(e) {
  const m = [];
  if (e.shiftKey) m.push('shift');
  if (e.ctrlKey) m.push('control');
  if (e.altKey) m.push('alt');
  if (e.metaKey) m.push('meta');
  return m;
}
function mouseMods(e) {
  const m = keyMods(e);
  if (e.buttons & 1) m.push('leftButtonDown');
  if (e.buttons & 2) m.push('rightButtonDown');
  if (e.buttons & 4) m.push('middleButtonDown');
  return m;
}

let dragging = false;
frame.addEventListener('mousedown', (e) => {
  e.preventDefault();
  kbd.focus({ preventScroll: true }); // 以降のキー入力をページへ送る
  dragging = true;
  window.api.input({
    type: 'mouseDown', ...toDisplay(e), button: BUTTONS[e.button] ?? 'left',
    clickCount: e.detail || 1, modifiers: mouseMods(e),
  });
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  window.api.input({
    type: 'mouseUp', ...toDisplay(e), button: BUTTONS[e.button] ?? 'left',
    clickCount: e.detail || 1, modifiers: mouseMods(e),
  });
});
// マウス移動は 1 フレームに 1 回にまとめて送る
let pendingMove = null;
function onMove(e) {
  if (!dragging && e.currentTarget === window) return; // ドラッグ中以外はプレビュー上だけ
  const first = !pendingMove;
  pendingMove = { type: 'mouseMove', ...toDisplay(e), modifiers: mouseMods(e) };
  if (first) requestAnimationFrame(() => { window.api.input(pendingMove); pendingMove = null; });
}
frame.addEventListener('mousemove', (e) => { if (!dragging) onMove(e); });
window.addEventListener('mousemove', (e) => { if (dragging) onMove(e); });
frame.addEventListener('contextmenu', (e) => e.preventDefault());
frame.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? displaySize.height : 1; // 行・ページ単位を px に
  window.api.input({
    type: 'mouseWheel', ...toDisplay(e), deltaX: -e.deltaX * k, deltaY: -e.deltaY * k,
    canScroll: true, modifiers: keyMods(e),
  });
}, { passive: false });

// キーボード（DOM の key → Electron の keyCode）
const KEYMAP = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space',
  Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};
const toKeyCode = (key) => KEYMAP[key] ?? (key.length === 1 || /^F\d{1,2}$/.test(key) ? key : null);
const isComposing = (e) => e.isComposing || e.key === 'Process' || e.keyCode === 229;

kbd.addEventListener('keydown', (e) => {
  if (isComposing(e)) return; // IME 変換中は compositionend でまとめて送る
  const keyCode = toKeyCode(e.key);
  if (!keyCode) return; // Shift 単体など
  e.preventDefault();
  const modifiers = keyMods(e);
  window.api.input({ type: 'keyDown', keyCode, modifiers });
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
  if (plain && e.key.length === 1) window.api.input({ type: 'char', keyCode: e.key, modifiers });
  if (plain && e.key === 'Enter') window.api.input({ type: 'char', keyCode: '\r', modifiers });
});
kbd.addEventListener('keyup', (e) => {
  if (isComposing(e)) return;
  const keyCode = toKeyCode(e.key);
  if (!keyCode) return;
  e.preventDefault();
  window.api.input({ type: 'keyUp', keyCode, modifiers: keyMods(e) });
});
kbd.addEventListener('compositionend', (e) => {
  if (e.data) window.api.insertText(e.data);
  kbd.value = '';
});
kbd.addEventListener('input', (e) => { if (!e.isComposing) kbd.value = ''; });

window.api.onUrl(setCurrentUrl);
window.api.onBounds(setupPreview);

// ---- 初期化 ----
(async () => {
  const s = await window.api.init();
  requested = s.requested;
  setLayoutNotes(s.layoutNotes);
  running = s.running;
  focusWhere = s.focus;
  selected = s.selected;
  web = s.web;
  renderList(s.list);
  setCurrentUrl(s.url);
  setupPreview(s.bounds);
  setPreviewState(s.previewOn);
  setModeState(s.virtual);
  if (s.frame && !img.src) showFrame(s.frame);
  if (s.status) msg.textContent = s.status;
  setBlackoutState(s.blackout);
  setCurtainState(s.curtain);
  setTransitionState(s.transition);
  for (const o of effectSel.options) if (o.value.startsWith('tiles')) o.textContent += ` ${s.grid.cols}×${s.grid.rows}`;
  exeSource = s.source;
  updateVideo();
})();
