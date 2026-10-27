import { $, el } from './util';

export interface SearchItem {
  name: string;
  kind: string;
  alt?: string;
  featured?: boolean;
  go: () => void;
}

interface Indexed extends SearchItem { key: string; order: number }

// diacritics optional: "zlota" finds "Złota"
const fold = (s: string) => s.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');

// type-ahead over views, landmarks and named OSM places; ↑/↓ move, Enter goes, Esc clears
export class PlaceSearch {
  readonly input: HTMLInputElement;
  private readonly list: HTMLOListElement;
  private items: Indexed[] = [];
  private hits: Indexed[] = [];
  private sel = 0;

  constructor(host: HTMLElement, placeholder: string, private readonly max = 9) {
    const box = el('div', 'search', `<input type="text" spellcheck="false" autocomplete="off" placeholder="${placeholder}"><button class="x" title="Clear">✕</button><ol></ol>`, host);
    this.input = $<HTMLInputElement>('input', box);
    this.list = $<HTMLOListElement>('ol', box);
    this.input.addEventListener('input', () => { this.sel = 0; this.render(); });
    this.input.addEventListener('focus', () => this.render());
    this.input.addEventListener('blur', () => setTimeout(() => { this.list.innerHTML = ''; }, 150));
    $('.x', box).addEventListener('click', () => { this.input.value = ''; this.sel = 0; this.input.focus(); this.render(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { this.move(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); }
      else if (e.key === 'Enter' && this.hits[this.sel]) this.pick(this.hits[this.sel]);
      else if (e.key === 'Escape') { this.input.value = ''; this.input.blur(); }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  // one entry per name: the first (a view or landmark) wins and takes the others' alternative names
  setItems(items: SearchItem[]) {
    const first = new Map<string, SearchItem & { alts: string[] }>();
    for (const it of items) {
      const k = fold(it.name), f = first.get(k);
      if (f) f.alts.push(it.alt ?? '', it.kind);
      else first.set(k, { ...it, alts: [it.alt ?? '', it.kind] });
    }
    this.items = [...first.values()].map((it, i) => ({ ...it, key: fold(`${it.name} ${it.alts.join(' ')}`), order: i }));
  }

  private move(d: number) {
    this.sel = Math.min(Math.max(this.sel + d, 0), this.hits.length - 1);
    this.render();
  }

  // every word must appear, in any order; whole-name and word-start matches first
  private find(q: string) {
    q = fold(q.trim());
    if (!q) return this.items.filter((it) => it.featured).slice(0, this.max);
    const words = q.split(/\s+/), out: [number, Indexed][] = [];
    for (const it of this.items) {
      if (!words.every((w) => it.key.includes(w))) continue;
      const i = it.key.indexOf(q), j = it.key.indexOf(words[0]);
      const rank = i === 0 ? 0 : i > 0 && it.key[i - 1] === ' ' ? 1 : j === 0 ? 2 : 3;
      out.push([rank * 1e5 + it.order, it]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, this.max).map((r) => r[1]);
  }

  private render() {
    this.hits = this.find(this.input.value);
    if (!this.hits.length && this.input.value.trim()) { this.list.innerHTML = '<li class="none">no places match — try a street or building name</li>'; return; }
    this.list.innerHTML = this.hits.map((it, i) =>
      `<li class="${i === this.sel ? 'sel' : ''}" data-i="${i}"><span>${it.name}</span><em>${it.kind === 'yes' ? '' : it.kind}</em></li>`).join('');
    this.list.querySelectorAll<HTMLElement>('li').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(this.hits[+li.dataset.i!]); }));
  }

  private pick(it: SearchItem) {
    this.list.innerHTML = '';
    this.input.value = '';
    this.input.blur();
    it.go();
  }
}
