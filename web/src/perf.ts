import type { Rect } from './hud';
import { $, el } from './util';

const LOW = 0.2e6;

// top right: frames per second, and the one knob under it, how much of the city is drawn in detail (city.ts); it
// follows the automatic setting until the visitor moves it
export class Perf {
  rects: Rect[] = [];
  manual = false;
  private readonly box = el('div', '', '<div class="fps"></div><label class="row"><span>Render size</span><input type="range" min="0" max="1" step="0.001" disabled></label>');
  private readonly fps = $('.fps', this.box);
  private readonly input = $<HTMLInputElement>('input', this.box);
  private max = LOW;
  private n = 0;
  private t0 = 0;

  constructor(onInput: (budget: number) => void) {
    this.box.id = 'perf';
    this.input.addEventListener('input', () => { this.manual = true; onInput(this.budgetAt(+this.input.value)); });
    const measure = () => { const r = this.box.getBoundingClientRect(); this.rects = [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }]; };
    new ResizeObserver(measure).observe(this.box);
    addEventListener('resize', measure);
  }

  // the slider's right end: the whole city, or less where the device cannot hold it (phones); a log scale from LOW
  range(max: number) {
    this.max = max;
    this.input.disabled = false;
  }

  private budgetAt(p: number) { return LOW * (this.max / LOW) ** p; }

  show(budget: number) {
    if (this.manual || this.input.disabled) return;
    this.input.value = String(budget >= this.max ? 1 : Math.max(0, Math.log(budget / LOW) / Math.log(this.max / LOW)));
  }

  // triangles: everything drawn in the last frame, shadow maps included
  frame(now: number, hidden: boolean, triangles: number) {
    if (hidden) { this.n = 0; this.t0 = now; return; }
    this.n++;
    if (now - this.t0 < 500) return;
    if (this.t0) {
      this.fps.innerHTML = `${Math.round((this.n * 1000) / (now - this.t0))} fps<span class="mark">${(triangles / 1e6).toFixed(1)} M triangles</span>`;
    }
    this.n = 0;
    this.t0 = now;
  }
}
