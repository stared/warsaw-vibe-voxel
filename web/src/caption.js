// While the city loads: which stage is on screen and how many of the city's tiles are in ("Landmarks · 52 / 775 tiles"),
// one measure throughout, and a bar for that same count; a tick marks where the landmarks' tiles end. Fixed width,
// tabular digits: nothing jumps. Nothing is timed or decorative: all1m.js calls show() with what has arrived.
export function makeCaption() {
  const el = document.createElement('div');
  el.className = 'caption';
  el.innerHTML = '<span class="txt"></span><span class="bar"><i></i></span>';
  document.body.appendChild(el);
  const txt = el.querySelector('.txt'), fill = el.querySelector('i');
  let finished = false;
  return {
    split(at, total) { const t = document.createElement('b'); t.style.left = `${(100 * at / total).toFixed(1)}%`; el.querySelector('.bar').appendChild(t); },
    show(text, done, total) {
      if (finished) return;
      txt.textContent = text;
      fill.style.width = `${(100 * Math.min(1, done / Math.max(1, total))).toFixed(1)}%`;
    },
    finish(text) {
      if (finished) return;
      finished = true; txt.textContent = text; fill.style.width = '100%';
      setTimeout(() => el.classList.add('off'), 1500);
    },
  };
}
