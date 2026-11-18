// exe.js — 指定の exe を起動し、そのウィンドウを枠なしで指定の位置・サイズに置く（Windows のみ）
//   他のプロセスのウィンドウを操作するので Win32 API を使う（koffi 経由。初回使用時に読み込む）
const { spawn } = require('node:child_process');
const path = require('node:path');

// 「"C:\path\app.exe" 引数...」または「C:\path\app.exe 引数...」→ { file, args, text }。exe でなければ null
//   パスは「\」かドライブ名を含むこと（example.com/setup.exe 等、スキームを省略した URL と区別するため）。
//   相対パスは baseDir 基準。引数は空白区切りで、"..." で囲めば空白を含められる（/dir="C:\a b" も可）。
//   %LOCALAPPDATA% 等の環境変数は展開する（ユーザー名を含むパスを PC ごとに書き換えずに済むよう）。未定義ならそのまま
function parseExe(raw, baseDir, env = process.env) {
  let s = String(raw ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // https://.../setup.exe 等の URL
  s = s.replace(/%([^%\s]+)%/g, (v, name) => env[name] ?? v);
  const m = /^(?:"([^"]+\.exe)"|(.+?\.exe))(?=\s|$)(.*)$/i.exec(s);
  if (!m || !/^[a-z]:|\\/i.test(m[1] ?? m[2])) return null;
  const file = path.win32.resolve(baseDir, m[1] ?? m[2]);
  const args = [...m[3].matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((a) => a[0].replace(/"/g, ''));
  const quote = (a) => (!a || /\s/.test(a) ? `"${a}"` : a);
  return { file, args, text: [file, ...args].map(quote).join(' ') };
}

// ---- Win32 API ----
const SIGS = {
  user32: [
    'HWND __stdcall FindWindowExW(HWND parent, HWND after, str16 cls, str16 title)',
    'uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)',
    'BOOL __stdcall IsWindow(HWND hwnd)',
    'BOOL __stdcall IsWindowVisible(HWND hwnd)',
    'BOOL __stdcall IsIconic(HWND hwnd)',
    'BOOL __stdcall IsZoomed(HWND hwnd)',
    'HWND __stdcall GetWindow(HWND hwnd, uint32_t cmd)',
    'intptr_t __stdcall GetWindowLongPtrW(HWND hwnd, int index)',
    'intptr_t __stdcall SetWindowLongPtrW(HWND hwnd, int index, intptr_t value)',
    'uintptr_t __stdcall GetClassLongPtrW(HWND hwnd, int index)',
    'BOOL __stdcall SetWindowPos(HWND hwnd, HWND after, int x, int y, int cx, int cy, uint32_t flags)',
    'BOOL __stdcall ShowWindowAsync(HWND hwnd, int cmd)',
    'BOOL __stdcall RedrawWindow(HWND hwnd, void *rect, void *rgn, uint32_t flags)',
    'BOOL __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)',
    'BOOL __stdcall SetForegroundWindow(HWND hwnd)',
    'HWND __stdcall GetForegroundWindow()',
    'HWND __stdcall GetAncestor(HWND hwnd, uint32_t flags)',
    'BOOL __stdcall PostMessageW(HWND hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)',
    'intptr_t __stdcall SendMessageTimeoutW(HWND hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam, uint32_t flags, uint32_t timeout, void *result)',
    'HWND __stdcall ChildWindowFromPointEx(HWND hwnd, POINT pt, uint32_t flags)',
    'BOOL __stdcall ScreenToClient(HWND hwnd, _Inout_ POINT *pt)',
    'BOOL __stdcall ClientToScreen(HWND hwnd, _Inout_ POINT *pt)',
  ],
  kernel32: [
    'HANDLE __stdcall OpenProcess(uint32_t access, BOOL inherit, uint32_t pid)',
    'BOOL __stdcall CloseHandle(HANDLE h)',
    'BOOL __stdcall GetProcessTimes(HANDLE h, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)',
    'BOOL __stdcall QueryFullProcessImageNameW(HANDLE h, uint32_t flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)',
  ],
  dwmapi: [
    'int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t attr, void *value, uint32_t size)',
  ],
};

function defineTypes(koffi) {
  koffi.alias('HWND', 'intptr_t');   // 比較や ID 作成がしやすいよう Number で扱う
  koffi.alias('HANDLE', 'intptr_t');
  koffi.alias('BOOL', 'int');        // Win32 の BOOL は 4 バイト（C の bool ではない）
  koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
  koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
}

let w = null;
let loadError = null;
function win32() {
  if (loadError) throw loadError; // 読み込みは 1 回だけ（koffi の型は二重に定義できない）。失敗したら毎回その原因を出す
  if (w) return w;
  try {
    const koffi = require('koffi');
    defineTypes(koffi);
    const api = {};
    for (const [dll, sigs] of Object.entries(SIGS)) {
      const lib = koffi.load(`${dll}.dll`);
      for (const sig of sigs) api[/(\w+)\s*\(/.exec(sig)[1]] = lib.func(sig);
    }
    w = api;
  } catch (e) {
    loadError = e;
    throw e;
  }
  return w;
}

const GWL_STYLE = -16, GWL_EXSTYLE = -20, GCL_STYLE = -26, GW_OWNER = 4, GA_ROOTOWNER = 3;
const WS_CAPTION = 0x00C00000, FRAME_STYLE = WS_CAPTION | 0x00040000; // | WS_THICKFRAME
const FRAME_EXSTYLE = 0x1 | 0x100 | 0x200 | 0x20000;         // WS_EX_DLGMODALFRAME | WINDOWEDGE | CLIENTEDGE | STATICEDGE
const WS_EX_TOOLWINDOW = 0x80, CS_DBLCLKS = 0x8, DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_ASYNCWINDOWPOS = 0x4000;
const HWND_TOPMOST = -1;
const SW_SHOWNOACTIVATE = 4, SW_SHOWMINNOACTIVE = 7, WM_NULL = 0, SMTO_ABORTIFHUNG = 0x2, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const RDW_INVALIDATE = 0x1, RDW_ERASE = 0x4, RDW_ALLCHILDREN = 0x80, RDW_FRAME = 0x400;
const CWP_SKIPINVISIBLE = 0x1, CWP_SKIPTRANSPARENT = 0x4;
const WM_CLOSE = 0x10, WM_MOUSEMOVE = 0x200, WM_MOUSEWHEEL = 0x20A, WM_MOUSEHWHEEL = 0x20E;
const BUTTONS = { // [down, up, dblclk]
  left: [0x201, 0x202, 0x203], right: [0x204, 0x205, 0x206], middle: [0x207, 0x208, 0x209],
};
const MK = { leftButtonDown: 0x1, rightButtonDown: 0x2, shift: 0x4, control: 0x8, middleButtonDown: 0x10 };

const SEARCH_MS = 30000;   // 起動からウィンドウが現れるまで待つ時間
const RESEARCH_MS = 10000; // ウィンドウが閉じた後、次のウィンドウ（スプラッシュ → 本体 等）を待つ時間
const FALLBACK_MS = 3000;  // 起動したプロセスのウィンドウが無いとき、他のプロセスの新しいウィンドウも探し始めるまで
const KEEP_MS = 5000;      // 配置後、アプリ側で位置・サイズを戻されたら合わせ直す期間（枠はずっと外し直す）

const topWindows = () => {
  const list = [];
  for (let h = 0; (h = w.FindWindowExW(0, h, null, null));) list.push(h);
  return list;
};
const pidOf = (h) => { const p = [0]; w.GetWindowThreadProcessId(h, p); return p[0]; };
const rectOf = (h) => {
  const r = {};
  if (!w.GetWindowRect(h, r)) return null;
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
};
// タスクバーに出るような通常のウィンドウか（ツールチップ・所有されたダイアログ・非表示の UWP 等を除く）
const isAppWindow = (h) => {
  if (!w.IsWindowVisible(h) || w.GetWindow(h, GW_OWNER)) return false;
  if (w.GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return false;
  const cloaked = Buffer.alloc(4);
  return !(w.DwmGetWindowAttribute(h, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked.readUInt32LE(0));
};
// 見えている範囲（Windows 10 以降の、枠の外側にある見えないリサイズ用の縁を除く）
const visibleRectOf = (h) => {
  const b = Buffer.alloc(16);
  if (w.DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, b, 16) !== 0) return rectOf(h);
  const [left, top, right, bottom] = [0, 4, 8, 12].map((i) => b.readInt32LE(i));
  return { x: left, y: top, width: right - left, height: bottom - top };
};
// タイトルバーをアプリ自身が描いているか（Windows 11 のメモ帳・ペイント、Chrome、Office 等）。
// 標準の枠のスタイルがあるのに、上端までアプリの描画範囲になっている（上の縁が左右の縁より厚くない）。
// こういうアプリは枠を外すとアクティブになったときに表示が崩れ、外してもタイトルバーは消えないので、枠は外さない
const drawsOwnTitleBar = (h) => {
  if ((w.GetWindowLongPtrW(h, GWL_STYLE) & WS_CAPTION) !== WS_CAPTION) return false;
  const win = rectOf(h);
  const client = { x: 0, y: 0 };
  if (!win || !w.ClientToScreen(h, client)) return false;
  return client.y - win.y <= client.x - win.x;
};
const lparam = (x, y) => (y & 0xFFFF) * 0x10000 + (x & 0xFFFF);

// 管理中のウィンドウ（複数の exe が同じウィンドウを取り合わないよう、他の exe の検索対象から外す）
const owned = new Set();

// プロセスの開始時刻（Date.now() と同じミリ秒）と exe のファイル名（小文字）。取得できなければ null
function processInfo(pid) {
  const h = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!h) return null;
  try {
    const created = [0], unused = [0];
    const name = Buffer.alloc(2048);
    const len = [name.length / 2]; // 文字数（UTF-16）
    if (!w.GetProcessTimes(h, created, unused, unused, unused)) return null;
    if (!w.QueryFullProcessImageNameW(h, 0, name, len)) return null;
    return {
      started: Number(BigInt(created[0]) / 10000n) - 11644473600000, // FILETIME（1601 年からの 100ns 単位）→ ミリ秒
      name: path.win32.basename(name.toString('utf16le', 0, len[0] * 2)).toLowerCase(),
    };
  } finally {
    w.CloseHandle(h);
  }
}

// 常に手前（最前面）のウィンドウにして、after のすぐ下に置く（after が無ければ最前面の一番上）。
//   拡張モニターのタスクバーより手前に出すため。after は幕・画面消去の黒いウィンドウ（それより手前には出さない）
function placeTopmost(hwnd, after = 0, flags = 0) {
  win32();
  return w.SetWindowPos(hwnd, after || HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | flags);
}

// exe を起動してウィンドウを探し、getRect() の位置（物理ピクセル）に枠なしで置く。hide() で最小化して背面に回す
//   onChange(message?): ウィンドウが見つかった・閉じた・位置が変わった・終了した（ended が true）ときに呼ばれる。
//   message は状態表示用
//   getInsertAfter(): 置くときに、このウィンドウ（HWND）のすぐ下の最前面に置く（0 なら最前面の一番上）
function launchExe({ file, args, text }, getRect, onChange, getInsertAfter = () => 0) {
  win32();
  const exeName = path.win32.basename(file).toLowerCase();
  const launchedAt = Date.now();
  const before = new Set(topWindows());
  let hwnd = 0;
  let closed = false;   // 管理を終えた（終了した・見つからなかった等）
  let closing = false;  // 閉じるよう指示した
  let hidden = false;   // 背面に回している（最小化）
  let exited = false;
  let searchSince = Date.now();
  let found = false;   // 一度でもウィンドウが見つかったか
  let placedAt = 0;
  let keepFrame = false; // 枠を外さない（タイトルバーをアプリ自身が描いている）
  let captured = 0;    // ボタンを押している間の送り先（マウスキャプチャの代わり）
  let wantFocus = false; // 次に配置したらフォーカスを移す（ウィンドウがまだ無ければ、見つかったときに）
  let lastRect = '';

  const child = spawn(file, args, { cwd: path.dirname(file), stdio: 'ignore' });
  child.on('error', (e) => finish(`起動できません: ${e.message}`));
  child.on('exit', () => { exited = true; });

  const find = () => {
    const wins = topWindows().filter((h) => !owned.has(h) && isAppWindow(h));
    const own = wins.find((h) => pidOf(h) === child.pid);
    if (own) return own;
    // 起動した exe が別のプロセスを起動して終わる（ランチャー型）・子プロセスがウィンドウを持つ・
    // 起動済みのアプリに処理を渡して終わる（PowerPoint・Windows 11 のメモ帳等）場合は、起動後に現れた
    // 新しいウィンドウのうち、起動後に始まったプロセスか同じ名前の exe のものを使う
    // （起動前から動いている別のアプリ（メール等）のウィンドウを拾わないため）。
    // lazy-dev: 同時に別のアプリを起動すると（mywebview から続けて起動した場合も）、そのウィンドウを拾うことがある。
    //   問題になったらプロセスツリーで絞る
    if (!exited && Date.now() - searchSince < FALLBACK_MS) return 0;
    return wins.find((h) => {
      if (before.has(h)) return false;
      const pid = pidOf(h);
      // mywebview 自身が後から作ったウィンドウ（表示用ウィンドウ・画面を消す黒いウィンドウ）は使わない。
      // 起動時に exe を指定すると mywebview も「起動後に始まったプロセス」に当てはまり、
      // 拾うと表示用ウィンドウを exe として最小化・配置してしまう
      if (pid === process.pid) return false;
      const p = processInfo(pid);
      return p && (p.started >= launchedAt - 1000 || p.name === exeName);
    }) ?? 0;
  };

  // 他のプロセスのウィンドウのスタイル変更は相手のスレッドで処理されるので、相手が応答しないと
  // mywebview（UI 含む）まで止まる。応答を確かめてから変え、応答しなければ次の周期でやり直す
  const responsive = () => w.SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 50, null) !== 0;

  // 幕・画面消去のウィンドウのすぐ下（最前面）に置き直す（アクティブにすると一番上に上がるため）。
  // 相手が応答しなくても待たないよう非同期
  const underOverlays = () => w.SetWindowPos(hwnd, getInsertAfter() || HWND_TOPMOST, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  // アクティブにする（以降のキー入力を exe に向ける）。幕・画面消去より上には出さない
  const activate = () => {
    w.SetForegroundWindow(hwnd);
    underOverlays();
  };

  const place = () => {
    if (!responsive()) return false;
    const r = getRect();
    const restoring = w.IsIconic(hwnd) || w.IsZoomed(hwnd);
    if (restoring) w.ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
    let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS;
    // 見えている範囲が指定の位置・サイズになるよう、枠の外側の見えない縁の分だけ広げる
    // （枠を外すと縁も無くなる。最小化・最大化中は測れないので、元に戻った後の周期で合わせ直す）
    let e = { l: 0, t: 0, r: 0, b: 0 };
    if (keepFrame) {
      if (!restoring) {
        const a = rectOf(hwnd), v = visibleRectOf(hwnd);
        if (a && v) {
          e = { l: v.x - a.x, t: v.y - a.y, r: a.x + a.width - v.x - v.width, b: a.y + a.height - v.y - v.height };
        }
      }
    } else {
      const style = w.GetWindowLongPtrW(hwnd, GWL_STYLE);
      if (style & FRAME_STYLE) w.SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~FRAME_STYLE) >>> 0);
      const ex = w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      if (ex & FRAME_EXSTYLE) w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & ~FRAME_EXSTYLE) >>> 0);
      flags |= SWP_FRAMECHANGED;
    }
    // 最前面（拡張モニターのタスクバーより手前）にして、幕・画面消去のウィンドウのすぐ下に置く
    w.SetWindowPos(hwnd, getInsertAfter() || HWND_TOPMOST,
      r.x - e.l, r.y - e.t, r.width + e.l + e.r, r.height + e.t + e.b, flags);
    // 付け直された枠が描かれたまま残らないよう、全体を描き直させる
    if (!keepFrame) w.RedrawWindow(hwnd, null, null, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
    return true;
  };
  // アプリ側で枠を付け直すことがある（枠を外したアプリのみ対象）
  const hasFrame = () => !keepFrame && w.GetWindowLongPtrW(hwnd, GWL_STYLE) & FRAME_STYLE;
  const samePlace = () => {
    const a = visibleRectOf(hwnd), b = getRect();
    return a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  };

  function tick() {
    if (hwnd && !w.IsWindow(hwnd)) {
      owned.delete(hwnd);
      hwnd = 0;
      // 閉じるよう指示した後や起動直後（スプラッシュ画面 → 本体）でなければ、終了とみなす
      if (closing) return finish('アプリを終了しました');
      if (Date.now() - launchedAt > SEARCH_MS) return finish('exe が終了しました');
      searchSince = Date.now();
      onChange('ウィンドウが閉じられました。次のウィンドウを待っています…');
    }
    if (!hwnd) {
      hwnd = find();
      if (!hwnd) {
        if (Date.now() - searchSince > (found ? RESEARCH_MS : SEARCH_MS)) {
          finish(found ? 'exe が終了しました' : 'exe のウィンドウが見つかりません');
        }
        return;
      }
      owned.add(hwnd);
      found = true;
      placedAt = 0;
      keepFrame = drawsOwnTitleBar(hwnd); // 枠を外す前に判定する
      onChange(keepFrame ? 'タイトルバーをアプリ自身が描いているため、枠は外さずに配置しました' : '');
    }
    if (hidden) {
      // 背面に回したアプリが自分で元に戻ったら最小化し直す。
      // 閉じるよう指示した後は、保存の確認などを隠さないよう何もしない
      if (!closing && !w.IsIconic(hwnd)) w.ShowWindowAsync(hwnd, SW_SHOWMINNOACTIVE);
      return;
    }
    // 見つけたら配置する。その後も枠が付け直されたら外し、最大化されたら（タイトルバーのダブルクリック等）戻す。
    // 位置・サイズは配置直後だけ合わせ直す（アプリ側で戻すことがあるため）
    // lazy-dev: 外すたびにアプリがすぐ付け直すと 300ms ごとにちらつく。そうなったら回数制限を入れる
    if (!placedAt || hasFrame() || w.IsZoomed(hwnd) || (Date.now() - placedAt < KEEP_MS && !samePlace())) {
      if (place() && !placedAt) placedAt = Date.now();
    }
    if (wantFocus && placedAt) {
      wantFocus = false;
      activate();
    } else if (getInsertAfter()) {
      // 幕・画面消去が出ている間は、アプリ側でアクティブになって（クリック・ダイアログ等）上に出ても下に戻す
      underOverlays();
    }
    const r = JSON.stringify(visibleRectOf(hwnd));
    if (r !== lastRect) {
      lastRect = r;
      onChange(); // プレビューの縦横比・操作の座標変換を合わせる
    }
  }
  const safeTick = () => {
    if (closed) return;
    // 例外を外に出すと、300ms ごとにエラーダイアログが出続ける
    try {
      tick();
    } catch (e) {
      finish(`exe の操作中にエラーが発生しました: ${e.message}`);
    }
  };
  const timer = setInterval(safeTick, 300);

  const stop = () => {
    if (closed) return false;
    closed = true;
    clearInterval(timer);
    owned.delete(hwnd);
    hwnd = 0;
    return true;
  };
  function finish(message) {
    if (stop()) onChange(message);
  }

  return {
    text,
    name: path.win32.basename(file),
    get hwnd() { return hwnd; },
    get ended() { return closed; },
    rect: () => (hwnd ? visibleRectOf(hwnd) : null),
    // 重なり順を整える（幕・画面消去のすぐ下、無ければ最前面の一番上に置き直す。アクティブにはしない）
    raise() {
      if (hwnd && !hidden && !closed) underOverlays();
    },
    // フォーカスを移す（アクティブにする）
    focus() {
      if (hwnd && !hidden) activate();
    },
    // アクティブ（キー入力を受け取る）か。このウィンドウが出したダイアログ（保存の確認等）がアクティブな場合も含む
    focused() {
      if (!hwnd) return false;
      const fg = w.GetForegroundWindow();
      return Boolean(fg) && (fg === hwnd || w.GetAncestor(fg, GA_ROOTOWNER) === hwnd);
    },

    // プレビュー上のマウス操作を送る（fx, fy: ウィンドウ内の位置 0〜1）
    //   カーソルを動かさないよう PostMessage で送るので、アプリによっては効かない（DirectX・Raw Input 等）。
    //   キー入力はクリック時にウィンドウをアクティブにして、exe が直接受け取る
    mouse(ev, fx, fy) {
      if (!hwnd || hidden || !ev.type.startsWith('mouse')) return;
      const r = visibleRectOf(hwnd); // プレビューに映っている範囲
      if (!r) return;
      const sx = r.x + Math.round(fx * r.width);
      const sy = r.y + Math.round(fy * r.height);
      const keys = (ev.modifiers ?? []).reduce((k, m) => k | (MK[m] ?? 0), 0);
      // 送り先: その位置の一番内側の子ウィンドウ（ボタンを押している間は押したときのウィンドウ）。
      // ホイールも同じ（子 → 親へは伝わるが、親 → 子へは伝わらないため）
      let target = captured && w.IsWindow(captured) ? captured : hwnd;
      let pt;
      for (;;) {
        pt = { x: sx, y: sy };
        w.ScreenToClient(target, pt);
        if (target === captured) break;
        const c = w.ChildWindowFromPointEx(target, pt, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
        if (!c || c === target) break;
        target = c;
      }
      if (ev.type === 'mouseWheel') {
        // 1 ノッチ = Chromium の 100px = Win32 の 120。座標はスクリーン座標
        const delta = (d) => (Math.max(-32767, Math.min(32767, Math.round(d * 1.2))) & 0xFFFF) * 0x10000 + keys;
        if (ev.deltaY) w.PostMessageW(target, WM_MOUSEWHEEL, delta(ev.deltaY), lparam(sx, sy));
        if (ev.deltaX) w.PostMessageW(target, WM_MOUSEHWHEEL, delta(-ev.deltaX), lparam(sx, sy));
        return;
      }
      const lp = lparam(pt.x, pt.y);
      const [down, up, dbl] = BUTTONS[ev.button] ?? BUTTONS.left;
      if (ev.type === 'mouseMove') {
        w.PostMessageW(target, WM_MOUSEMOVE, keys, lp);
      } else if (ev.type === 'mouseDown') {
        activate(); // 以降のキー入力を exe に向ける
        captured = target;
        const dblclk = ev.clickCount >= 2 && (w.GetClassLongPtrW(target, GCL_STYLE) & CS_DBLCLKS);
        w.PostMessageW(target, dblclk ? dbl : down, keys, lp);
      } else if (ev.type === 'mouseUp') {
        captured = 0;
        w.PostMessageW(target, up, keys, lp);
      }
    },

    // 背面に回す（最小化）
    hide() {
      hidden = true;
      wantFocus = false;
      captured = 0;
      if (hwnd) w.ShowWindowAsync(hwnd, SW_SHOWMINNOACTIVE);
    },
    // 前に出す（元に戻して配置し直す）。focus: フォーカスも移す
    show({ focus = false } = {}) {
      hidden = false;
      wantFocus = focus;
      placedAt = 0;
      safeTick(); // 次の周期を待たずに配置する
    },

    // 閉じる。強制終了ではなく WM_CLOSE を送るので、保存の確認などはアプリ側で出る。
    // ウィンドウが消えたら終了とみなす（キャンセルされたら起動したまま。もう一度呼ぶと WM_CLOSE を送り直す）
    close() {
      if (closed) return;
      closing = true;
      if (hwnd && w.IsWindow(hwnd)) {
        w.PostMessageW(hwnd, WM_CLOSE, 0, 0);
        return;
      }
      if (!found && !exited) child.kill(); // 起動中（ウィンドウがまだ無い）なら、後から出てこないよう止める
      finish('アプリを終了しました');
    },
  };
}

module.exports = { parseExe, launchExe, placeTopmost, SIGS, defineTypes };
