// All a visitor gets, top left: find a place, set the time of day, set the Vistula's level. No folders and no
// settings; presets are marks on the sliders, not menus.
import { PlaceSearch } from './search.js';

const hhmm = (h) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// a slider with named marks; near a mark (within `snap`) it sticks to it and shows its name
function slider(host, { min, max, step, marks, snap, show, onInput }) {
  const el = document.createElement('label');
  el.className = 'row';
  el.innerHTML = `<span class="val"></span><span class="track"><input type="range" min="${min}" max="${max}" step="${step}">${
    Object.entries(marks).map(([name, v]) => `<i style="left:${((v - min) / (max - min)) * 100}%" title="${name}"></i>`).join('')}</span>`;
  host.appendChild(el);
  const input = el.querySelector('input'), val = el.querySelector('.val');
  const name = (v) => Object.keys(marks).find((k) => marks[k] === v);
  const set = (v) => { input.value = v; val.textContent = show(v, name(v)); };
  input.addEventListener('input', () => {
    let v = +input.value;
    const near = Object.values(marks).find((m) => Math.abs(m - v) <= snap);
    if (near !== undefined) v = near;
    set(v); onInput(v);
  });
  input.addEventListener('keydown', (e) => e.stopPropagation()); // arrows nudge the slider, not the camera
  el.querySelectorAll('i').forEach((m) => m.addEventListener('click', (e) => { e.preventDefault(); const v = marks[m.title]; set(v); onInput(v, true); }));
  return { el, input, set };
}

export class Bar {
  constructor({ times, river, onHour, onRiver }) {
    const el = this.el = document.createElement('div');
    el.id = 'bar';
    document.body.appendChild(el);
    this.search = new PlaceSearch(el, { placeholder: 'Search Warsaw…' });
    this.time = slider(el, { min: 4.5, max: 23.5, step: 1 / 60, marks: times, snap: 0, show: (h, n) => (n ? `${hhmm(h)} · ${n}` : hhmm(h)), onInput: onHour });
    this.river = slider(el, { min: 90, max: 1150, step: 1, marks: river, snap: 12, show: (cm, n) => `Vistula ${cm} cm${n ? ` · ${n}` : ''}`, onInput: onRiver });
    this.river.input.disabled = true;
  }
  setHour(h) { if (document.activeElement !== this.time.input) this.time.set(h); }
  setRiver(cm) { this.river.set(cm); }
  get rect() { return this.el.getBoundingClientRect(); }
}
