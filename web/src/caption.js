// PROTOTYPE (proto-ghost): while the city fills in, a caption says what just arrived ("Paving Marszałkowska…"),
// named from what really lies in the 128 m square that turned real: a landmark first, else a named place, else a
// generic line. One line at a time, held long enough to read; a thin bar shows how much of the city is in.
const SAY = {
  street: (n) => `Paving ${n}`, square: (n) => `Laying the cobbles of ${n}`, park: (n) => `Planting trees in ${n}`,
  stop: (n) => `Laying tram tracks at ${n}`, station: (n) => `Writing the timetable for ${n}`,
  cafe: (n) => `Brewing coffee at ${n}`, restaurant: (n) => `Lighting the ovens at ${n}`, 'fast food': (n) => `Frying chips at ${n}`,
  bar: (n) => `Pouring the first beer at ${n}`, pub: (n) => `Pouring the first beer at ${n}`, 'ice cream': (n) => `Scooping ice cream at ${n}`,
  hotel: (n) => `Making the beds at ${n}`, museum: (n) => `Hanging the paintings in ${n}`, gallery: (n) => `Hanging the paintings in ${n}`,
  theatre: (n) => `Raising the curtain at ${n}`, cinema: (n) => `Threading the film at ${n}`, library: (n) => `Shelving the books in ${n}`,
  'place of worship': (n) => `Ringing the bells of ${n}`, school: (n) => `Ringing the school bell at ${n}`, university: (n) => `Opening the lecture halls of ${n}`,
  bridge: (n) => `Spanning ${n}`, fountain: (n) => `Turning on ${n}`, stadium: (n) => `Mowing the pitch at ${n}`, building: (n) => `Raising ${n}`,
};
// landmarks that are not buildings get their own line
const LANDMARK = { 'Wisła': 'Filling the Vistula', 'Bulwary Wiślane': 'Paving the Vistula boulevards', 'Park Świętokrzyski': 'Planting Park Świętokrzyski',
  'Ogród Saski': 'Planting the Saxon Garden', 'Plac Centralny': 'Laying out Plac Centralny', 'Plac Konstytucji': 'Laying out Plac Konstytucji',
  'Zielona Złota': 'Greening Złota street', 'Most Świętokrzyski': 'Spanning Most Świętokrzyski', 'Most Poniatowskiego': 'Spanning Most Poniatowskiego',
  'PGE Narodowy': 'Mowing the pitch at PGE Narodowy', 'Pałac Saski': 'Rebuilding Pałac Saski', 'Ilmet': 'Raising Ilmet (while it lasts)' };
const GENERIC = ['Paving roads', 'Growing foliage', 'Placing street lamps', 'Painting zebra crossings', 'Laying tram tracks',
  'Stacking voxels', 'Glazing windows', 'Planting trees', 'Raising rooftops', 'Sweeping the pavements'];

export async function makeCaption({ meta }) {
  const { places } = await fetch('data/places.json').then((r) => r.json()).catch(() => ({ places: [] }));
  const el = document.createElement('div');
  el.className = 'caption off';
  el.innerHTML = '<span class="txt"></span><span class="bar"><i></i></span>';
  document.body.appendChild(el);
  const txt = el.querySelector('.txt'), fill = el.querySelector('i');
  txt.textContent = 'Building Warsaw…';
  const labels = meta.labels || [];
  const used = new Set();
  let queue = [], shownAt = 0, gen = 0, lastW = 0, finished = false;
  // what a square [x0, z0, x1, z1] holds: a landmark beats everything, then the place types we have a line for
  const lineFor = (x0, z0, x1, z1) => {
    const inside = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
    for (const l of labels) if (inside(l.x, l.y) && !used.has(l.name)) { used.add(l.name); return { t: LANDMARK[l.name] || `Raising ${l.name}`, w: 3 }; }
    let best = null;
    for (const [name, kind, x, z, size] of places) if (SAY[kind] && inside(x, z) && !used.has(name) && (!best || size > best[4])) best = [name, kind, x, z, size];
    if (best) { used.add(best[0]); return { t: SAY[best[1]](best[0]), w: 1 + Math.random() }; } // streets, cafés, stops… in no fixed order
    return null;
  };
  setInterval(() => {
    if (finished || el.classList.contains('off')) return;
    const now = performance.now();
    if (now - shownAt < 1100) return;
    queue.sort((a, b) => b.w - a.w || b.t0 - a.t0);
    // a landmark at most every other line, so the city between them gets its turn
    const i = lastW === 3 ? queue.findIndex((q) => q.w < 3) : 0;
    const next = (i >= 0 && queue.splice(i, 1)[0]) || { t: GENERIC[gen++ % GENERIC.length], w: 0 };
    lastW = next.w;
    queue = queue.slice(0, 12); // stale news is dropped: what arrived seconds ago is no longer interesting
    txt.textContent = next.t + '…';
    shownAt = now;
  }, 200);
  return {
    // a square just turned real (bounds in scene metres)
    arrived(x0, z0, x1, z1) { const l = lineFor(x0, z0, x1, z1); if (l) queue.push({ ...l, t0: performance.now() }); },
    progress(done, total) {
      fill.style.width = `${(100 * done / total).toFixed(1)}%`;
      if (done < total) { el.classList.remove('off'); return; }
      if (finished) return;
      finished = true; txt.textContent = 'Warsaw is ready';
      setTimeout(() => el.classList.add('off'), 1800);
    },
  };
}
