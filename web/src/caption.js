// While the city loads: which stage is on screen and how many of the city's tiles are in ("Landmarks · 52 / 775 tiles"),
// one measure throughout, and a bar for that same count; ticks mark where the landmarks' tiles and the tiles in view end. Fixed width,
// tabular digits: nothing jumps. Nothing is timed or decorative: all1m.js calls show() with what has arrived.
export function makeCaption() {
  const el = document.createElement('div');
  el.className = 'caption';
  el.innerHTML = '<span class="txt"><span class="st"></span><span class="n"></span></span><span class="bar"><i></i></span>';
  document.body.appendChild(el);
  const st = el.querySelector('.st'), num = el.querySelector('.n'), fill = el.querySelector('i');
  let finished = false;
  return {
    // where each part of the loading ends, in the same tile count as the bar
    ticks(at, total) { const bar = el.querySelector('.bar');
      at.forEach((a, k) => { const t = bar.querySelectorAll('b')[k] || bar.appendChild(document.createElement('b')); t.style.left = `${(100 * a / total).toFixed(1)}%`; }); },
    // stage on the left, count on the right (right-aligned, tabular digits): neither moves as the numbers change
    show(stage, done, total) {
      if (finished) return;
      st.textContent = stage; num.textContent = `${done} / ${total} tiles`;
      fill.style.width = `${(100 * Math.min(1, done / Math.max(1, total))).toFixed(1)}%`;
    },
    finish(stage, total) {
      if (finished) return;
      finished = true; st.textContent = stage; num.textContent = `${total} / ${total} tiles`; fill.style.width = '100%';
      setTimeout(() => el.classList.add('off'), 1500);
    },
  };
}
