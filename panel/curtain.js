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

// 幕を閉める（true）・開ける（false）。動き終わったら解決する（main.js が executeJavaScript で呼ぶ）
window.curtain = async (close) => {
  await ready;
  // ウィンドウを出した直後でも動きが見えるよう、2 フレーム待ってから動かす
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (c.classList.contains('closed') === close) return;
  c.classList.toggle('closed', close);
  await new Promise((r) => {
    const t = setTimeout(r, 5000); // transitionend が来なくても先に進む
    c.addEventListener('transitionend', () => { clearTimeout(t); r(); }, { once: true });
  });
};
