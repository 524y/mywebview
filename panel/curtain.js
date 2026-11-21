// curtain.js — 緞帳（表示領域の一番手前に重ねる透明なウィンドウの中で、幕を上げ下げする）
const c = document.getElementById('c');

// 幕の画像（url_list.txt と同じ場所の curtain.png 等。main.js が file: URL で渡す）。無ければ CSS の幕
const img = new URLSearchParams(location.search).get('img');
const ready = img
  ? new Promise((resolve) => {
    const i = new Image();
    i.onload = () => {
      c.style.backgroundImage = `url("${img}")`;
      c.classList.add('image');
      resolve();
    };
    i.onerror = resolve; // 読めなければ CSS の幕のまま
    i.src = img;
  })
  : Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 幕を閉める（true）・開ける（false）。動き終わったら解決する（main.js が executeJavaScript で呼ぶ）
//   instant: 動きを見せずに、すぐその状態にする（幕のウィンドウを作り直したとき）
//   どの待ちにも上限を置く（終わらないと、main.js 側で後の開け閉めがすべて待たされる）
window.curtain = async (close, instant = false) => {
  // 画像の読み込みが遅ければ、待たずに CSS の幕で動かす（読み込めたら画像に替わる）
  await Promise.race([ready, sleep(3000)]);
  if (instant) {
    c.style.transition = 'none';
    c.classList.toggle('closed', close);
    c.getBoundingClientRect(); // ここで反映させる（transition を戻したときに動き出さないように）
    c.style.transition = '';
    return;
  }
  // ウィンドウを出した直後でも動きが見えるよう、2 フレーム待ってから動かす。
  // 描画が止まっていてフレームが来なくても、先に進んで状態だけは合わせる
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    sleep(1000),
  ]);
  if (c.classList.contains('closed') === close) return;
  c.classList.toggle('closed', close);
  await new Promise((r) => {
    const t = setTimeout(r, 5000); // transitionend が来なくても先に進む
    c.addEventListener('transitionend', () => { clearTimeout(t); r(); }, { once: true });
  });
};
