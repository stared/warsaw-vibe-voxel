// Place search for the panel: type-ahead over curated views, labelled landmarks and every named OSM place.
// Diacritics are optional ("zlota" finds "Złota"); ↑/↓ move, Enter goes, Esc clears.
const fold = (s) => s.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');

export class PlaceSearch {
  constructor(host, { placeholder = 'search places…', max = 9 } = {}) {
    this.items = [];
    this.max = max;
    this.el = document.createElement('div');
    this.el.className = 'search';
    this.el.innerHTML = `<input type="text" spellcheck="false" autocomplete="off" placeholder="${placeholder}"><ol></ol>`;
    host.appendChild(this.el);
    this.input = this.el.querySelector('input');
    this.list = this.el.querySelector('ol');
    this.sel = 0;
    this.input.addEventListener('input', () => { this.sel = 0; this.render(); });
    this.input.addEventListener('focus', () => this.render());
    this.input.addEventListener('blur', () => setTimeout(() => { this.list.innerHTML = ''; }, 150));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not move the camera
      if (e.key === 'ArrowDown') { this.sel = Math.min(this.sel + 1, this.hits.length - 1); this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.sel = Math.max(this.sel - 1, 0); this.render(); e.preventDefault(); }
      else if (e.key === 'Enter' && this.hits[this.sel]) this.pick(this.hits[this.sel]);
      else if (e.key === 'Escape') { this.input.value = ''; this.input.blur(); }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  setItems(items) {
    const seen = new Set(); // one entry per name: the curated view or landmark wins over the raw OSM feature
    this.items = items.filter((it) => { const k = fold(it.name); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((it, i) => ({ ...it, key: fold(it.name + ' ' + (it.alt || '')), order: i }));
  }

  find(q) {
    q = fold(q.trim());
    if (!q) return this.items.filter((it) => it.featured).slice(0, this.max);
    const out = [];
    for (const it of this.items) {
      const i = it.key.indexOf(q);
      if (i < 0) continue;
      const word = i === 0 || it.key[i - 1] === ' ';
      out.push([(i === 0 ? 0 : word ? 1 : 2) * 1e5 + it.order, it]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, this.max).map((r) => r[1]);
  }

  render() {
    this.hits = this.find(this.input.value);
    this.list.innerHTML = this.hits.map((it, i) =>
      `<li class="${i === this.sel ? 'sel' : ''}" data-i="${i}"><span>${it.name}</span><em>${it.kind}</em></li>`).join('');
    this.list.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(this.hits[+li.dataset.i]); }));
  }

  pick(it) {
    this.input.value = it.name;
    this.list.innerHTML = '';
    this.input.blur();
    it.go();
  }
}
