// transition.js — 切り替え効果（表示領域の一番手前に重ねる透明なウィンドウに、切り替え前の画面の静止画を出し、
// 裏で新しい表示に切り替えてから、静止画を消していく）
const root = document.getElementById('t');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => {
  const step = () => (n-- > 0 ? requestAnimationFrame(step) : r());
  step();
});

let gen = 0; // 最後に受けた指示の番号。新しい指示が来たら、前の指示の続きはやめる
let tiles = [];
let gridCols = 1, gridRows = 1;

const loadImage = (src) => new Promise((resolve, reject) => {
  const i = new Image();
  i.onload = () => resolve(i);
  i.onerror = () => reject(new Error('切り替え前の画面の画像を読めません'));
  i.src = src;
});

// 切り替え前の画面を出す。main.js が executeJavaScript で呼ぶ
//   shots: [{ src, x, y, w, h }] 画像（data: URL）と、表示領域に対する位置・大きさ（0〜1）。
//     Web ページは 1 枚、exe はモニターごとの画面のキャプチャ
//   cols × rows: タイルの数（モニターの並びに合わせる）
//   → 描画し終えたら true
window.cover = async (shots, cols, rows) => {
  const me = ++gen;
  const imgs = await Promise.all(shots.map((s) => loadImage(s.src)));
  if (me !== gen) return false;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  const edge = (n, i, size) => Math.round((size * i) / n);
  tiles = [];
  gridCols = cols;
  gridRows = rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = edge(cols, c, W), x1 = edge(cols, c + 1, W);
      const y0 = edge(rows, r, H), y1 = edge(rows, r + 1, H);
      const cv = document.createElement('canvas');
      cv.width = x1 - x0;
      cv.height = y1 - y0;
      Object.assign(cv.style, {
        left: `${x0 / dpr}px`, top: `${y0 / dpr}px`, width: `${(x1 - x0) / dpr}px`, height: `${(y1 - y0) / dpr}px`,
      });
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      shots.forEach((s, k) => g.drawImage(imgs[k], s.x * W - x0, s.y * H - y0, s.w * W, s.h * H));
      tiles.push(cv);
    }
  }
  root.style.transition = 'none';
  root.style.opacity = '1';
  root.replaceChildren(...tiles);
  // 実際に画面に出るまで待つ（出る前に裏を切り替えると、一瞬新しい表示が見える）。フレームが来なくても先に進む
  await Promise.race([frames(2), sleep(500)]);
  await sleep(50);
  return me === gen;
};

// 並びをランダムにする
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// 静止画を消していく。ms: 全体の時間、order: タイルの順番（random: ランダム / rows: 左上から右へ、行ごとに上から /
//   cols: 左上から下へ、列ごとに左から）
//   fade:       全体をフェードアウト
//   tiles:      タイルをランダムな順に 1 枚ずつ消す（パッと）
//   tiles-fade: 同じ順で 1 枚ずつフェードアウト
//   tiles-flip: 同じ順で 1 枚ずつ回転して消える
//   → 消し終えたら true。途中で次の指示が来たら false
window.reveal = async (effect, ms, order = 'random') => {
  const me = gen;
  const until = (anims) => Promise.race([Promise.allSettled(anims.map((a) => a.finished)), sleep(ms + 3000)]);
  if (effect === 'fade') {
    await until([root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' })]);
  } else {
    // tiles は左上から右へ、行ごとに並んでいる
    const seq = order === 'rows' ? [...tiles]
      : order === 'cols' ? Array.from({ length: tiles.length }, (_, k) => tiles[(k % gridRows) * gridCols + Math.floor(k / gridRows)])
      : shuffle([...tiles]);
    const n = seq.length;
    // 1 枚が消える時間（パッと消すときは 0）。最後の 1 枚が ms ちょうどで消え終わるように始める時刻をずらす
    const d = effect === 'tiles' ? 0 : Math.min(800, ms / 3);
    const gap = n > 1 ? (ms - d) / (n - 1) : 0;
    const anims = seq.map((t, k) => {
      const opt = { duration: Math.max(d, 1), delay: k * gap, easing: 'ease-in', fill: 'forwards' };
      let a;
      if (effect === 'tiles-flip') {
        // タイルごとに、自分の正面から見た遠近にする（表示領域全体の中央から見ると、端のタイルは 90° 回っても
        // 真横にならず、斜めの板のまま残って見える）。奥行きはタイルの幅の 2 倍
        const p = `perspective(${Math.round(t.offsetWidth * 2)}px)`;
        a = t.animate([{ transform: `${p} rotateY(0deg)` }, { transform: `${p} rotateY(90deg)` }], opt);
      } else {
        a = t.animate([{ opacity: 1 }, { opacity: 0 }], opt);
      }
      // 消え終わったタイルは隠す（回転の最後のわずかな線・半透明が残らないように）
      a.addEventListener('finish', () => { t.style.visibility = 'hidden'; });
      return a;
    });
    await until(anims);
  }
  if (me !== gen) return false;
  clear();
  return true;
};

// すぐに消す（透明に戻す）
function clear() {
  gen++;
  root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  root.replaceChildren();
  tiles = [];
}
window.clear = clear;
