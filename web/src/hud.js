// The only thing over the map besides the labels: a quiet legend in the bottom-left corner -- the keys as outlines
// (lit while held) and the two or three mouse gestures that matter in the current mode.
const touch = matchMedia('(pointer: coarse)').matches;
const KEYS = [['KeyQ', 'Q', '⌃'], ['KeyW', 'W', '↑'], ['KeyE', 'E', '⌄'], ['KeyA', 'A', '↶'], ['KeyS', 'S', '↓'], ['KeyD', 'D', '↷']];
const ALIAS = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
const LINES = {
  orbit: touch ? [['drag', 'move'], ['two fingers', 'zoom, turn'], ['tap a person', 'follow']]
    : [['drag', 'move'], ['right-drag', 'turn'], ['scroll', 'zoom'], ['click a person', 'follow']],
  walk: touch ? [['drag', 'look'], ['tap', 'walk there'], ['tap a person', 'follow']]
    : [['drag', 'look'], ['click', 'walk there'], ['click a person', 'follow'], ['Esc', 'fly up']],
  ride: touch ? [['drag', 'look'], ['tap the street', 'walk']] : [['W A S D', 'walk on your own'], ['Esc', 'fly up']],
};
const WHO = { person: 'Following a pedestrian', car: 'Following a car', bus: 'Following a bus', tram: 'Following a tram' };

export class Hud {
  constructor({ nav }) {
    this.nav = nav;
    const el = this.el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `${touch ? '' : `<div class="keys">${KEYS.map(([c, k, g]) => `<span data-k="${c}">${k}<i>${g}</i></span>`).join('')}</div>`}
      <div class="lines"></div>`;
    document.body.appendChild(el);
    const lit = (e, on) => el.querySelector(`[data-k="${ALIAS[e.code] || e.code}"]`)?.classList.toggle('on', on);
    addEventListener('keydown', (e) => { if (!e.target.closest?.('input, textarea')) lit(e, true); });
    addEventListener('keyup', (e) => lit(e, false));
    addEventListener('blur', () => el.querySelectorAll('.on').forEach((k) => k.classList.remove('on')));
    // its screen rect, so map labels keep clear of it
    this.rects = [];
    const measure = () => { const r = el.getBoundingClientRect(); this.rects = [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }]; };
    new ResizeObserver(measure).observe(el);
    addEventListener('resize', measure);
    this.set(nav.mode);
  }

  set(mode, ride) {
    const who = mode === 'ride' && ride ? `<b>${WHO[ride.label] || (/^tram \w/.test(ride.label) ? `Following ${ride.label}` : WHO[ride.kind])}</b>` : '';
    this.el.querySelector('.lines').innerHTML = who + (LINES[mode] || []).map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('');
  }
}
