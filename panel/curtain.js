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

// 最後に受けた指示の番号。動いている間に次の指示が来たら、前の指示はそこで終える（次の指示が今の位置から動かす）
let latest = 0;

// 幕を閉める（true）・開ける（false）。main.js が executeJavaScript で呼ぶ
//   instant: 動きを見せずに、すぐその状態にする（幕のウィンドウを作り直したとき）
//   → 動き終わったら true。動いている間に次の指示が来たら false
//   どの待ちにも上限を置く（終わらないと、main.js 側が幕のウィンドウを作り直す）
window.curtain = async (close, instant = false) => {
  const me = ++latest;
  // 画像の読み込みが遅ければ、待たずに CSS の幕で動かす（読み込めたら画像に替わる）
  await Promise.race([ready, sleep(3000)]);
  if (me !== latest) return false;
  if (instant) {
    c.style.transition = 'none';
    c.classList.toggle('closed', close);
    c.getBoundingClientRect(); // ここで反映させる（transition を戻したときに動き出さないように）
    c.style.transition = '';
    return true;
  }
  // ウィンドウを出した直後でも動きが見えるよう、2 フレーム待ってから動かす。
  // 描画が止まっていてフレームが来なくても、先に進んで状態だけは合わせる
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    sleep(1000),
  ]);
  if (me !== latest) return false;
  // 動いている途中なら、その位置から向きを変える（戻る分だけの時間で動く）
  c.classList.toggle('closed', close);
  // 動き終わるのを待つ（向きを変えられたときも、ここで待つのをやめる）。描画が止まっていて終わらなくても先に進む
  await Promise.race([Promise.allSettled(c.getAnimations().map((a) => a.finished)), sleep(4000)]);
  return me === latest;
};
