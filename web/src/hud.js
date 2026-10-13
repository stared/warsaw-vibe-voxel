// On-screen controls for casual visitors: a one-line hint + the few buttons that matter in each mode,
// a compass (click: north up) with zoom buttons, a walker you can click or drag onto the map, and a hover tooltip.
const touch = matchMedia('(pointer: coarse)').matches;
const HINTS = {
  orbit: touch
    ? 'Drag to move · pinch to zoom · two fingers to rotate · tap a tram, car or person to ride along'
    : 'Drag to move · right-drag or Shift-drag to rotate · scroll to zoom · click a tram, car or person to ride along',
  walk: touch
    ? 'Drag to look around · tap the street to walk there · tap a person or tram to join them'
    : 'Drag to look around · click the street to walk there · click a person or tram to join them',
  ride: 'Drag to look around',
};
const ICON = { tram: '🚋', car: '🚗', bus: '🚌', person: '🚶' };

export class Hud {
  constructor({ nav, dom, onZoom, onNorth, onHome, onSearch }) {
    this.nav = nav;
    const el = this.el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div class="bar">
        <span class="who"></span>
        <span class="hint"></span>
        <span class="btns"></span>
      </div>
      <div class="side">
        <button class="find" title="Search places">🔍</button>
        <button class="compass" title="Compass — click to face north"><svg viewBox="-20 -20 40 40"><g class="rose"><path d="M0-15 5 0H-5Z" fill="#e8554e"/><path d="M0 15 5 0H-5Z" fill="#ddd"/></g></svg></button>
        <button class="zin" title="Zoom in">+</button>
        <button class="zout" title="Zoom out">−</button>
        <button class="home" title="Whole district">⌂</button>
        <button class="walker" title="Street view — click, or drag me onto a street">🚶</button>
      </div>
      <div class="tip"></div>
      <button class="offer"></button>
      <div class="ghost">🚶</div>`;
    document.body.appendChild(el);
    this.q = (s) => el.querySelector(s);
    this.q('.zin').onclick = () => onZoom(0.55);
    this.q('.zout').onclick = () => onZoom(1.8);
    this.q('.compass').onclick = () => onNorth();
    this.q('.home').onclick = () => onHome();
    this.q('.find').onclick = () => onSearch();
    // button tooltips that show at once (native titles are slow and invisible on touch)
    for (const b of el.querySelectorAll('.side button')) {
      const t = b.title; b.removeAttribute('title'); b.dataset.tip = t;
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'touch') return; const r = b.getBoundingClientRect(); this.showTip(b.dataset.tip, r.left - 8, r.top + r.height / 2, true); });
      b.addEventListener('pointerleave', () => { this.tip.style.opacity = 0; });
    }
    // street level: a tap near a moving person/vehicle offers the ride (they move under your finger; nothing is forced)
    const offer = this.offerEl = this.q('.offer');
    nav.onOffer = (ag, x, y) => {
      offer.textContent = `${ICON[ag.label] || ICON[ag.kind]} ${ag.kind === 'person' ? 'Walk with this person' : `Ride this ${ag.label}`}`;
      offer.style.transform = `translate(${Math.min(x + 10, innerWidth - 200)}px, ${Math.max(10, y - 44)}px)`;
      offer.classList.add('on');
      offer.onclick = () => { offer.classList.remove('on'); nav.startRide(ag); };
    };
    dom.addEventListener('pointerdown', () => offer.classList.remove('on'));
    this.rose = this.q('.rose');
    // screen rects of the bar and the buttons, so map labels keep clear of them (kept current without per-frame layout reads)
    this.rects = [];
    const measure = () => { this.rects = [this.q('.bar'), this.q('.side')].map((n) => n.getBoundingClientRect()).filter((r) => r.width)
      .map((r) => ({ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 })); };
    const ro = new ResizeObserver(measure); ro.observe(this.q('.bar')); ro.observe(this.q('.side'));
    addEventListener('resize', measure);
    this.tip = this.q('.tip');

    // the walker: click = street view where you look; drag = street view where you drop it (like Pegman)
    const w = this.q('.walker'), ghost = this.q('.ghost');
    let drag = null;
    w.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; w.setPointerCapture(e.pointerId); e.preventDefault(); });
    w.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
      if (drag.moved) { ghost.style.display = 'block'; ghost.style.transform = `translate(${e.clientX - 14}px, ${e.clientY - 34}px)`; }
    });
    w.addEventListener('pointerup', (e) => {
      ghost.style.display = 'none';
      if (!drag) return;
      const d = drag; drag = null;
      if (nav.mode !== 'orbit') { nav.flyUp(); return; }
      if (!d.moved) { nav.setMode('walk'); return; }
      const hit = nav.world && nav.hitAt(e.clientX, e.clientY);
      if (hit) nav.setMode('walk', { at: hit, facing: nav.camera.getWorldDirection(hit.clone()).setY(0).normalize(), deckOK: hit.axis === 1 && Math.abs(hit.y - (nav.world.deckAt(hit.x, hit.z) ?? -99)) < 1.5 });
    });

    nav.onHover = (ag, x, y) => {
      if (!ag) { this.tip.style.opacity = 0; return; }
      const verb = ag.kind === 'person' ? 'walk with this person' : `ride this ${ag.label}`;
      this.showTip(`${ICON[ag.label] || ICON[ag.kind]} Click to ${verb}`, x + 14, y + 12);
    };
    nav.onRideEnd = (R, next) => this.toast(next ? `The ${R.kind === 'person' ? 'person' : R.label} left the map — you’re with the next one now`
      : `The ${R.kind === 'person' ? 'person' : R.label} left the map — you’re on foot now`);
    nav.onNotice = (msg) => this.toast(msg);
    this.set(nav.mode);
  }

  showTip(text, x, y, leftOf) {
    this.tip.textContent = text;
    this.tip.style.transform = leftOf ? `translate(calc(${x}px - 100%), calc(${y}px - 50%))` : `translate(${x}px, ${y}px)`;
    this.tip.style.opacity = 1;
  }
  button(label, title, fn) {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.onclick = fn;
    this.q('.btns').appendChild(b);
  }
  set(mode, ride) {
    this.el.dataset.mode = mode;
    this.q('.hint').textContent = HINTS[mode] || '';
    this.q('.btns').innerHTML = '';
    this.q('.who').textContent = '';
    this.tip.style.opacity = 0;
    const nav = this.nav;
    this.q('.walker').textContent = mode === 'orbit' ? '🚶' : '⬆';
    this.q('.walker').dataset.tip = mode === 'orbit' ? 'Street view — click, or drag me onto a street' : 'Back to the bird’s-eye view';
    this.offerEl?.classList.remove('on');
    if (mode === 'walk') this.button('⬆ Fly up', 'Back to the bird’s-eye view (Esc)', () => nav.flyUp());
    if (mode === 'ride' && ride) {
      const what = ride.kind === 'person' ? 'Walking with a pedestrian' : ride.kind === 'tram' ? `Riding ${ride.label}` : `Riding in a ${ride.label}`;
      this.q('.who').textContent = `${ICON[ride.label] || ICON[ride.kind]} ${what}`;
      this.button(ride.view === 'eyes' ? '🎥 View from behind' : '👀 Through their eyes', 'Switch view (V)', () => nav.toggleView());
      this.button('⏭ Next', `Another ${ride.kind} nearby (N)`, () => nav.nextRide());
      this.button('Hop off', 'Continue on foot here (Esc)', () => nav.hopOff());
      this.button('⬆ Fly up', 'Back to the bird’s-eye view', () => nav.flyUp());
    }
  }
  update() { this.rose.setAttribute('transform', `rotate(${(-this.nav.heading() * 180 / Math.PI).toFixed(1)})`); }
  toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    this.el.appendChild(t);
    setTimeout(() => t.classList.add('off'), 2600);
    setTimeout(() => t.remove(), 3200);
  }
}
