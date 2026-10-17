// PROTOTYPE (proto-ghost): while the city fills in, a caption says what kind of thing just arrived ("Paving roads…"),
// judged from what really lies in the 128 m square that turned real (landmarks, OSM places). Categories only, never
// particular places. One line at a time, held long enough to read; a thin bar shows how much of the city is in.
const CAT = { landmark: 'Raising landmark buildings', river: 'Filling the river', foliage: 'Growing foliage', tram: 'Laying tram tracks',
  road: 'Paving roads', building: 'Raising buildings', detail: 'Placing street lamps' };
// when each kind of thing is being built after a square arrives (s), matching voxelMaterial.js BUILD_VERTEX
const STAGE = { road: 0, river: 0, tram: 0, building: 0.35, landmark: 0.35, foliage: 0.9, detail: 1.4 };
const KIND = { street: 'road', square: 'road', bridge: 'river', park: 'foliage', stop: 'tram', station: 'tram' };
const GREEN = new Set(['Park Świętokrzyski', 'Ogród Saski', 'Zielona Złota']), WATER = new Set(['Wisła', 'Bulwary Wiślane', 'Most Świętokrzyski', 'Most Poniatowskiego']);

export async function makeCaption({ meta }) {
  const { places } = await fetch('data/places.json').then((r) => r.json()).catch(() => ({ places: [] }));
  const el = document.createElement('div');
  el.className = 'caption off';
  el.innerHTML = '<span class="txt"></span><span class="bar"><i></i></span>';
  document.body.appendChild(el);
  const txt = el.querySelector('.txt'), fill = el.querySelector('i');
  txt.textContent = 'Building Warsaw…';
  const labels = meta.labels || [];
  let shownAt = 0, finished = false;
  // what a square [x0, z0, x1, z1] holds; every square has roads, buildings and trees
  const catsFor = (x0, z0, x1, z1) => {
    const inside = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1, c = new Set();
    for (const l of labels) if (inside(l.x, l.y)) c.add(WATER.has(l.name) ? 'river' : GREEN.has(l.name) ? 'foliage' : 'landmark');
    for (const [, kind, x, z] of places) if (KIND[kind] && inside(x, z)) c.add(KIND[kind]);
    c.add('road'); c.add('building'); c.add('foliage'); c.add('detail'); // street trees and lamps are everywhere
    return c;
  };
  const seen = new Set(), shown = {}; // categories arrived since last shown; when each was last on screen
  let n = 0;
  setInterval(() => {
    if (finished || el.classList.contains('off')) return;
    const now = performance.now();
    if (now - shownAt < 1300 || !seen.size) return;
    // the category that has waited longest takes its turn, so every kind of thing gets named
    const next = [...seen].sort((a, b) => (shown[a] || 0) - (shown[b] || 0) || Object.keys(CAT).indexOf(a) - Object.keys(CAT).indexOf(b))[0];
    seen.delete(next); shown[next] = ++n;
    txt.textContent = CAT[next] + '…';
    shownAt = now;
  }, 200);
  return {
    // before any square is real: show the caption with a line of its own
    start(t) { el.classList.remove('off'); txt.textContent = t + '…'; shownAt = performance.now(); },
    // a square just turned real (bounds in scene metres)
    arrived(x0, z0, x1, z1) { for (const k of catsFor(x0, z0, x1, z1)) setTimeout(() => seen.add(k), STAGE[k] * 1000); },
    progress(done, total) {
      fill.style.width = `${(100 * done / total).toFixed(1)}%`;
      if (done < total) { el.classList.remove('off'); return; }
      if (finished) return;
      finished = true; txt.textContent = 'Warsaw is ready';
      setTimeout(() => el.classList.add('off'), 1800);
    },
  };
}
