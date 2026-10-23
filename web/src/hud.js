// The only thing over the map besides the labels: a quiet legend in the bottom-left corner -- the keys and the mouse
// gestures as outlines, lit while in use, one word under each mouse gesture.
const touch = matchMedia('(pointer: coarse)').matches;
const KEYS = [['KeyQ', 'Q', '⌃'], ['KeyW', 'W', '↑'], ['KeyE', 'E', '⌄'], ['KeyA', 'A', '↶'], ['KeyS', 'S', '↓'], ['KeyD', 'D', '↷']];
const ALIAS = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
// a mouse, outlined, with the part in use filled: l(eft) / r(ight) button, w(heel); drag: arrows either side
const mouse = (part, drag) => `<svg viewBox="-13 -2 26 30" class="m-${part}">
  ${drag ? '<path class="arr" d="M-12 13l2.5-2.5M-12 13l2.5 2.5M-12 13h4M12 13l-2.5-2.5M12 13l-2.5 2.5M12 13h-4"/>' : ''}
  <path class="btn" d="${part === 'l' ? 'M0 1h-1a5 5 0 0 0-5 5v5h6z' : part === 'r' ? 'M0 1h1a5 5 0 0 1 5 5v5h-6z' : 'M-1.4 4h2.8v6h-2.8z'}"/>
  <rect x="-6" y="1" width="12" height="24" rx="6"/><path d="M-6 11h12M0 1v10"/></svg>`;
const person = '<svg viewBox="-13 -2 26 30"><circle cx="0" cy="4" r="3"/><path d="M0 7v10M0 17l-4 9M0 17l4 9M-5 11l5-2 5 2"/></svg>';
const esc = '<span class="cap">Esc</span>';
const MOUSE = {
  orbit: [['l', mouse('l', true), 'move'], ['r', mouse('r', true), 'turn'], ['w', mouse('w'), 'zoom'], ['', person, 'follow']],
  walk: [['l', mouse('l', true), 'look'], ['', mouse('l'), 'walk'], ['', person, 'follow'], ['Escape', esc, 'fly up']],
  ride: [['l', mouse('l', true), 'look'], ['Escape', esc, 'fly up']],
};
const TOUCH = { orbit: 'drag: move · two fingers: zoom, turn · tap a person: follow', walk: 'drag: look · tap: walk · tap a person: follow', ride: 'drag: look · tap the street: walk' };
const WHO = { you: 'You are this pedestrian', person: 'Following a pedestrian', car: 'Following a car', bus: 'Following a bus', tram: 'Following a tram' };

export class Hud {
  constructor({ nav, dom }) {
    this.nav = nav;
    const el = this.el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `<div class="who"></div><div class="row">${touch ? '<div class="touch"></div>'
      : `<div class="keys">${KEYS.map(([c, k, g]) => `<span class="cap" data-k="${c}">${k}<i>${g}</i></span>`).join('')}</div><div class="mouse"></div>`}</div>`;
    document.body.appendChild(el);
    const lit = (k, on) => el.querySelectorAll(`[data-k="${k}"]`).forEach((n) => n.classList.toggle('on', on));
    addEventListener('keydown', (e) => { if (!e.target.closest?.('input, textarea')) lit(ALIAS[e.code] || e.code, true); });
    addEventListener('keyup', (e) => lit(ALIAS[e.code] || e.code, false));
    addEventListener('blur', () => el.querySelectorAll('.on').forEach((n) => n.classList.remove('on')));
    dom.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') lit(e.button === 2 || e.shiftKey ? 'r' : 'l', true); });
    addEventListener('pointerup', () => { lit('l', false); lit('r', false); });
    let wt = 0;
    dom.addEventListener('wheel', () => { lit('w', true); clearTimeout(wt); wt = setTimeout(() => lit('w', false), 250); }, { passive: true });
    // its screen rect, so map labels keep clear of it
    this.rects = [];
    const measure = () => { const r = el.getBoundingClientRect(); this.rects = [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }]; };
    new ResizeObserver(measure).observe(el);
    addEventListener('resize', measure);
    this.set(nav.mode);
  }

  set(mode, ride) {
    const q = (s) => this.el.querySelector(s);
    q('.who').textContent = mode === 'ride' && ride ? WHO[ride.label] || (/^tram \w/.test(ride.label) ? `Following ${ride.label}` : WHO[ride.kind]) : '';
    if (touch) { q('.touch').textContent = TOUCH[mode] || ''; return; }
    q('.mouse').innerHTML = (MOUSE[mode] || []).map(([k, icon, word]) => `<figure data-k="${k}">${icon}<figcaption>${word}</figcaption></figure>`).join('');
  }
}
