// panel.js — コントロールパネル
const $ = (sel) => document.querySelector(sel);
const urlInput = $('#url');
const msg = $('#msg');
const listEl = $('#list');
const previewBtn = $('#preview-toggle');
const previewWrap = $('#preview-wrap');
const img = $('#preview-img');

let currentUrl = '';
let previewOn = true;

// ---- 現在の URL ----
function setCurrentUrl(url) {
  currentUrl = url;
  if (document.activeElement !== urlInput) urlInput.value = url; // 入力中は上書きしない
  for (const b of listEl.querySelectorAll('button')) {
    b.classList.toggle('current', sameUrl(b.dataset.url, url));
  }
}
const sameUrl = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');

async function navigate(url) {
  const err = await window.api.navigate(url);
  msg.textContent = err ?? '';
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
function renderList({ file, items, error }) {
  $('#list-path').textContent = file;
  $('#list-path').title = file;
  $('#list-error').textContent = error ?? (items.length ? '' : 'URL が登録されていません');
  listEl.replaceChildren(...items.map(({ name, url }) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.url = url;
    b.innerHTML = '<span class="name"></span><span class="u"></span>';
    b.querySelector('.name').textContent = name;
    b.querySelector('.u').textContent = url;
    b.addEventListener('click', () => navigate(url));
    li.append(b);
    return li;
  }));
  setCurrentUrl(currentUrl);
}
$('#list-reload').addEventListener('click', async () => renderList(await window.api.reloadList()));

// ---- プレビュー ----
// 表示領域を 16:9 ごとに区切った位置（0〜1）を返す。48:9 なら [1/3, 2/3]
function splitPoints({ width, height }) {
  const seg = (height * 16) / 9;
  const pts = [];
  for (let x = seg; x < width - 0.5; x += seg) pts.push(x / width);
  return pts;
}

let requested = null; // 起動時に指定した位置とサイズ
let displaySize = { width: 1, height: 1 }; // 表示領域の実サイズ（操作の座標変換用）

function setupPreview(bounds) {
  displaySize = { width: bounds.width, height: bounds.height };
  if (typeof bounds.virtual === 'boolean') setModeState(bounds.virtual);
  const pts = splitPoints(bounds);
  const n = pts.length + 1;
  $('#frame').style.aspectRatio = `${bounds.width} / ${bounds.height}`;
  const screens = (bounds.width / ((bounds.height * 16) / 9)).toFixed(2).replace(/\.00$/, '');
  const differs = requested && (requested.width !== bounds.width || requested.height !== bounds.height);
  $('#preview-info').textContent =
    `表示領域 ${bounds.width}×${bounds.height}（位置 ${bounds.x}, ${bounds.y}） — 16:9 × ${screens} 画面分` +
    (bounds.virtual ? '　※ 疑似表示（モニターには表示していません）' : '') +
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
}
previewBtn.addEventListener('click', async () => setPreviewState(await window.api.setPreview(!previewOn)));

// ---- 表示モード（疑似表示 ⇔ 実表示） ----
const modeBtn = $('#mode-toggle');
let virtualMode = false;
function setModeState(v) {
  virtualMode = v;
  modeBtn.textContent = v ? '疑似表示' : '実表示';
  modeBtn.classList.toggle('on', !v);
}
modeBtn.addEventListener('click', async () => {
  modeBtn.disabled = true;
  try {
    setModeState(await window.api.setVirtual(!virtualMode));
  } finally {
    modeBtn.disabled = false;
  }
});

let lastObjectUrl = null;
function showFrame(jpeg) {
  const objUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  img.onload = () => {
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = objUrl;
  };
  img.src = objUrl;
}
window.api.onFrame(showFrame);

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
  renderList(s.list);
  setCurrentUrl(s.url);
  setupPreview(s.bounds);
  setPreviewState(s.previewOn);
  setModeState(s.virtual);
  if (s.frame && !img.src) showFrame(s.frame);
})();
