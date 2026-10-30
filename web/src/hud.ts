import type { Mode, Ride } from './nav/nav';
import { $, coarsePointer, el } from './util';

export interface Rect { x0: number; x1: number; y0: number; y1: number }

const TILT = (d: 1 | -1) => `<svg viewBox="-4 -4 8 8"><path d="M-3 ${d}l3 ${-2 * d} 3 ${2 * d}"/></svg>`;
const KEYS = [['KeyQ', 'Q', TILT(1)], ['KeyW', 'W', ''], ['KeyE', 'E', TILT(-1)], ['KeyA', 'A', ''], ['KeyS', 'S', ''], ['KeyD', 'D', '']];
const ALIAS: Record<string, string> = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };

// an outlined mouse with the part in use filled (l/r button, w wheel), drag arrows either side
const mouse = (part: 'l' | 'r' | 'w', drag = false) => `<svg viewBox="-13 -2 26 30">
  ${drag ? '<path d="M-12 13l2.5-2.5M-12 13l2.5 2.5M-12 13h4M12 13l-2.5-2.5M12 13l-2.5 2.5M12 13h-4"/>' : ''}
  <path class="btn" d="${part === 'l' ? 'M0 1h-1a5 5 0 0 0-5 5v5h6z' : part === 'r' ? 'M0 1h1a5 5 0 0 1 5 5v5h-6z' : 'M-1.4 4h2.8v6h-2.8z'}"/>
  <rect x="-6" y="1" width="12" height="24" rx="6"/><path d="M-6 11h12M0 1v10"/></svg>`;
const PERSON = '<svg viewBox="-13 -2 26 30"><circle cx="0" cy="4" r="3"/><path d="M0 7v10M0 17l-4 9M0 17l4 9M-5 11l5-2 5 2"/></svg>';
const ESC = '<span class="cap">Esc</span>', SPACE = '<span class="cap">Space</span>';

const MOUSE: Record<Mode, [string, string, string][]> = {
  orbit: [['l', mouse('l', true), 'move'], ['r', mouse('r', true), 'turn'], ['w', mouse('w'), 'zoom'], ['', PERSON, 'follow']],
  walk: [['l', mouse('l', true), 'look'], ['', mouse('l'), 'walk'], ['', PERSON, 'follow'], ['Escape', ESC, 'fly up']],
  ride: [['l', mouse('l', true), 'look'], ['Escape', ESC, 'fly up']],
};
const WHO: Record<string, string> = { person: 'Following a pedestrian', car: 'Following a car', bus: 'Following a bus', tram: 'Following a tram' };

// the key legend, bottom left: keys and mouse gestures as outlines, lit while in use
export class Hud {
  rects: Rect[] = [];
  private readonly box = el('div', '');
  private readonly touch = coarsePointer();

  constructor(dom: HTMLElement, mode: Mode) {
    const box = this.box;
    box.id = 'hud';
    box.innerHTML = `<div class="who"></div>${this.touch ? ''
      : `<div class="row"><div class="keys">${KEYS.map(([c, k, g]) => `<span class="cap" data-k="${c}">${k}${g && `<i>${g}</i>`}</span>`).join('')}</div><div class="mouse"></div></div>`}`;
    const lit = (k: string, on: boolean) => box.querySelectorAll(`[data-k="${k}"]`).forEach((n) => n.classList.toggle('on', on));
    addEventListener('keydown', (e) => { if (!(e.target as Element).closest?.('input:not([type=range])')) lit(ALIAS[e.code] ?? e.code, true); });
    addEventListener('keyup', (e) => lit(ALIAS[e.code] ?? e.code, false));
    addEventListener('blur', () => box.querySelectorAll('.on').forEach((n) => n.classList.remove('on')));
    dom.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') lit(e.button === 2 || e.shiftKey ? 'r' : 'l', true); });
    addEventListener('pointerup', () => { lit('l', false); lit('r', false); });
    let wheelT = 0;
    dom.addEventListener('wheel', () => { lit('w', true); clearTimeout(wheelT); wheelT = setTimeout(() => lit('w', false), 250); }, { passive: true });
    const measure = () => { const r = box.getBoundingClientRect(); this.rects = [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }]; };
    new ResizeObserver(measure).observe(box);
    addEventListener('resize', measure);
    this.set(mode, null);
  }

  set(mode: Mode, ride: Ride | null) {
    $('.who', this.box).textContent = mode === 'ride' && ride && ride.label !== 'you' ? WHO[ride.label] ?? (/^tram \w/.test(ride.label) ? `Following ${ride.label}` : WHO[ride.kind]) : '';
    if (this.touch) return;
    const items = [...MOUSE[mode]];
    if (mode === 'walk' || ride?.kind === 'person') items.splice(items.length - 1, 0, ['Space', SPACE, 'jump']);
    $('.mouse', this.box).innerHTML = items.map(([k, icon, word]) => `<figure data-k="${k}">${icon}<figcaption>${word}</figcaption></figure>`).join('');
  }
}
