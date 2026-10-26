import { PlaceSearch } from './search';
import { dateOf } from './sun';
import { $, el } from './util';

const hhmm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const dayMonth = (d: number) => dateOf(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

interface SliderSpec {
  min: number;
  max: number;
  step: number;
  marks: Record<string, number>;
  near: number;
  log: boolean;
  show: (v: number) => string;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
}

class Slider {
  readonly input: HTMLInputElement;
  private readonly val: HTMLElement;
  private readonly toPos: (v: number) => number;
  private readonly fromPos: (x: number) => number;

  constructor(host: HTMLElement, private readonly spec: SliderSpec) {
    const { min, max, step, log } = spec;
    this.toPos = log ? Math.log : (v) => v;
    this.fromPos = log ? (x) => Math.round(Math.exp(x) / step) * step : (x) => x;
    const range = log ? `min="${Math.log(min)}" max="${Math.log(max)}" step="0.001"` : `min="${min}" max="${max}" step="${step}"`;
    const row = el('label', 'row', `<span class="val"></span><span class="track"><input type="range" ${range}></span>`, host);
    this.input = $<HTMLInputElement>('input', row);
    this.val = $('.val', row);
    this.input.addEventListener('input', () => {
      const v = this.fromPos(+this.input.value);
      this.show(v);
      spec.onInput(v);
    });
    this.input.addEventListener('change', () => spec.onChange?.(this.fromPos(+this.input.value)));
    this.input.addEventListener('keydown', (e) => e.stopPropagation());
  }

  set(v: number) {
    this.input.value = String(this.toPos(v));
    this.show(v);
  }

  private show(v: number) {
    const { marks, near } = this.spec;
    const mark = Object.keys(marks).filter((k) => Math.abs(marks[k] - v) <= near).sort((a, b) => Math.abs(marks[a] - v) - Math.abs(marks[b] - v))[0];
    this.val.innerHTML = `${this.spec.show(v)}${mark ? ` <span class="mark">${mark}</span>` : ''}`;
  }

  setMarks(marks: Record<string, number>) { this.spec.marks = marks; }
  get value() { return this.fromPos(+this.input.value); }
}

const choices = (cls: string, label: string, names: string[], host: HTMLElement) =>
  el('div', `row ${cls}`, `<span class="val">${label}</span><span class="choices">${names.map((n) => `<button data-v="${n}">${n}</button>`).join('')}</span>`, host);

export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;
  readonly river: Slider;
  private readonly time: Slider;
  private readonly date: Slider;
  private readonly sky: HTMLElement;

  constructor({ days, weathers, river, onDay, onDayEnd, onHour, onWeather, onRiver }: {
    days: Record<string, number>;
    weathers: string[];
    river: Record<string, number>;
    onDay: (d: number) => void;
    onDayEnd: (d: number) => void;
    onHour: (h: number) => void;
    onWeather: (w: string) => void;
    onRiver: (cm: number) => void;
  }) {
    this.el.id = 'bar';
    this.search = new PlaceSearch(this.el, 'Search Warsaw…');
    this.date = new Slider(this.el, { min: 1, max: 365, step: 1, marks: days, near: 3, log: false, show: dayMonth, onInput: onDay, onChange: onDayEnd });
    this.time = new Slider(this.el, { min: 4, max: 23.5, step: 1 / 60, marks: {}, near: 1 / 3, log: false, show: hhmm, onInput: onHour });
    this.sky = choices('sky', 'Weather', weathers, this.el);
    this.sky.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) onWeather(b.dataset.v!); });
    this.river = new Slider(this.el, { min: 90, max: 1150, step: 1, marks: river, near: 20, log: true, show: (cm) => `Vistula ${cm} cm`, onInput: onRiver });
    this.river.input.disabled = true;
  }

  setDay(d: number, times: Record<string, number>) { this.date.set(d); this.time.setMarks(times); }
  setDays(days: Record<string, number>) { this.date.setMarks(days); this.date.set(this.date.value); }
  setHour(h: number) { if (document.activeElement !== this.time.input) this.time.set(h); }
  setWeather(w: string, mark: string) {
    this.sky.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === w));
    $('.val', this.sky).innerHTML = `Weather${mark ? ` <span class="mark">${mark}</span>` : ''}`;
  }
  offer(w: string, possible: boolean) { $<HTMLButtonElement>(`button[data-v="${w}"]`, this.sky).disabled = !possible; }
  setRiver(cm: number) { this.river.set(cm); }
  showRiver(on: boolean) { this.river.input.closest('.row')!.classList.toggle('off', !on); }
  get rect() { return this.el.getBoundingClientRect(); }
}
