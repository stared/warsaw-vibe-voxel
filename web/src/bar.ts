import { PlaceSearch } from './search';
import { $, el } from './util';

const hhmm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

interface SliderSpec {
  min: number;
  max: number;
  step: number;
  marks: Record<string, number>;
  snap: number;
  show: (v: number, mark?: string) => string;
  onInput: (v: number, jump: boolean) => void;
}

// a slider with named marks: click a mark to go there; dragging within `snap` of one sticks to it
class Slider {
  readonly input: HTMLInputElement;
  private readonly val: HTMLElement;

  constructor(host: HTMLElement, private readonly spec: SliderSpec) {
    const { min, max, step, marks } = spec;
    const ticks = Object.entries(marks).map(([name, v]) => `<i style="left:${((v - min) / (max - min)) * 100}%" title="${name}"></i>`).join('');
    const row = el('label', 'row', `<span class="val"></span><span class="track"><input type="range" min="${min}" max="${max}" step="${step}">${ticks}</span>`, host);
    this.input = $<HTMLInputElement>('input', row);
    this.val = $('.val', row);
    this.input.addEventListener('input', () => {
      const v = +this.input.value, near = Object.values(marks).find((m) => Math.abs(m - v) <= spec.snap);
      this.commit(near ?? v, false);
    });
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
    row.querySelectorAll<HTMLElement>('i').forEach((m) => m.addEventListener('click', (e) => { e.preventDefault(); this.commit(marks[m.title], true); }));
  }

  set(v: number) {
    this.input.value = String(v);
    this.val.textContent = this.spec.show(v, Object.keys(this.spec.marks).find((k) => this.spec.marks[k] === v));
  }

  private commit(v: number, jump: boolean) {
    this.set(v);
    this.spec.onInput(v, jump);
  }
}

// all a visitor gets, top left: find a place, set the time of day, set the Vistula's level
export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;
  readonly river: Slider;
  private readonly time: Slider;

  constructor({ times, river, onHour, onRiver }: {
    times: Record<string, number>;
    river: Record<string, number>;
    onHour: (h: number, jump: boolean) => void;
    onRiver: (cm: number) => void;
  }) {
    this.el.id = 'bar';
    this.search = new PlaceSearch(this.el, 'Search Warsaw…');
    this.time = new Slider(this.el, { min: 4.5, max: 23.5, step: 1 / 60, marks: times, snap: 0, show: (h, n) => (n ? `${hhmm(h)} · ${n}` : hhmm(h)), onInput: onHour });
    this.river = new Slider(this.el, { min: 90, max: 1150, step: 1, marks: river, snap: 12, show: (cm, n) => `Vistula ${cm} cm${n ? ` · ${n}` : ''}`, onInput: onRiver });
    this.river.input.disabled = true;
  }

  setHour(h: number) { if (document.activeElement !== this.time.input) this.time.set(h); }
  setRiver(cm: number) { this.river.set(cm); }
  get rect() { return this.el.getBoundingClientRect(); }
}
