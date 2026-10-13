import * as THREE from 'three';

// Streams the quadtree of voxel nodes (scripts/tiles.py): each node is N x N cells of s metres, s in {8, 4, 2, 1}.
// Every refresh picks, for each part of the city, the coarsest level whose cells stay under ~ERR_PX pixels from
// the camera (plus full detail around "focus" points: where you walk, who you ride with). Nodes are fetched and
// meshed by a worker pool; a parent stays on screen until all its children are ready (and vice versa), so there
// are no holes while streaming. Nodes off the wanted set for a while are disposed (geometry and column data).
const ERR_PX = +(new URLSearchParams(location.search).get('err') || 3); // px a coarser cell may span (3: 0.4% of pixels differ from full detail, tools/cmpshots.mjs)
const FOCUS_R = 260;     // full 1 m detail within this radius of focus points (street level, rides, landing)
const KEEP_MS = 8000;    // unused nodes are freed after this long
const CAP_MB = 150;      // and hidden ones are evicted (least recently used) beyond this much geometry + column data

function releaseArray() { this.array = null; }

export class TileStreamer {
  constructor({ meta, material, scene, base = 'data/tiles' }) {
    this.meta = meta; this.material = material; this.base = base;
    const T = meta.tiles;
    this.N = T.N;
    this.levels = T.levels.map((l) => l.s).sort((a, b) => b - a); // coarse -> fine
    this.dims = Object.fromEntries(T.levels.map((l) => [l.s, l]));
    this.nodes = new Map();   // key -> { s, tx, ty, state: 'loading'|'ready', mesh, data, used }
    this.group = new THREE.Group();
    scene.add(this.group);
    this.queue = [];
    this.focus = [];
    this.inflight = 0;
    this.tris = 0;
    this.version = 0;  // bumps when column data changes (for caches)
    const nW = Math.min(Math.max(2, (navigator.hardwareConcurrency || 4) >> 2), 3); // a few: each worker keeps its own heap
    this.workers = Array.from({ length: nW }, () => {
      const w = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
      w.busy = 0;
      w.onmessage = (e) => this.onNode(e.data, w);
      return w;
    });
    this.world = new StreamWorld(this);
  }
  key(s, tx, ty) { return `${s}/${tx}_${ty}`; }
  bounds(s, tx, ty) { const L = this.N * s; return [tx * L, ty * L, Math.min((tx + 1) * L, this.meta.W), Math.min((ty + 1) * L, this.meta.D)]; }

  // coarse levels are tiny: load all of the coarsest so every part of the map always has something to show
  async preload() {
    const s = this.levels[0], d = this.dims[s];
    const ps = [];
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) ps.push(this.request(s, tx, ty, 1e9));
    this.pump();
    await Promise.all(ps);
  }

  request(s, tx, ty, prio, keep = false) {
    const k = this.key(s, tx, ty);
    let n = this.nodes.get(k);
    if (n && keep && n.state === 'ready' && !n.data) { this.free(n); n = null; } // needed with its column data now
    if (!n) {
      n = { s, tx, ty, key: k, state: 'queued', used: performance.now(), keep };
      n.ready = new Promise((r) => { n.resolve = r; });
      this.nodes.set(k, n);
      this.queue.push(n);
    }
    n.prio = prio;
    if (prio >= 1e8) n.pinned = performance.now() + 15000; // asked for explicitly (preload / ensure): don't drop it
    return n.ready;
  }
  pump() {
    this.queue.sort((a, b) => b.prio - a.prio);
    while (this.queue.length && this.inflight < this.workers.length * 2) {
      const n = this.queue.shift();
      if (n.state !== 'queued') continue;
      const w = this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b));
      w.busy++; this.inflight++;
      n.state = 'loading';
      const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
      // column data (collisions, ray casts) is kept for coarse nodes (small) and for full-detail ones near you
      w.postMessage({ type: 'node', key: n.key, url: new URL(`${this.base}/${n.key}.bin`, location.href).href, N: this.N, s: n.s, x0, y0, keep: n.keep || n.s > 1 });
    }
  }
  onNode(m, w) {
    w.busy--; this.inflight--;
    const n = this.nodes.get(m.key);
    if (!n) { this.pump(); return; }
    if (m.type === 'error') { console.warn(m.error); n.state = 'ready'; n.empty = true; n.resolve(); this.pump(); return; }
    if (m.idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      geo.setAttribute('vattr', new THREE.BufferAttribute(m.attr, 4));
      geo.setAttribute('vpal', new THREE.BufferAttribute(m.pal, 1));
      geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      // once on the GPU the CPU copy is not needed (culling uses the bounding sphere): don't hold every mesh twice
      for (const a of [...Object.values(geo.attributes), geo.index]) a.onUpload(releaseArray);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      n.mesh = mesh; n.tris = m.idx.length / 3;
      mesh.userData.bytes = m.pos.byteLength + m.attr.byteLength + m.pal.byteLength + m.idx.byteLength;
      n.bytes = m.pos.byteLength + m.attr.byteLength + m.pal.byteLength + m.idx.byteLength; // GPU-side
    }
    if (m.data) {
      const { counts, ground, runs } = m.data, S = this.N + 2;
      const off = new Uint32Array(S * S + 1);
      for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + counts[i];
      const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
      n.data = { s: n.s, x0, y0, S, counts, ground, runs, off };
      n.bytes = (n.bytes || 0) + counts.byteLength + ground.byteLength + runs.byteLength + off.byteLength;
      this.version++;
    }
    n.state = 'ready';
    n.resolve();
    this.dirty = true;
    this.pump();
  }

  nearFocus(s, tx, ty) {
    const [x0, y0, x1, y1] = this.bounds(s, tx, ty);
    return this.focus.some((f) => Math.max(x0 - f.x, 0, f.x - x1) ** 2 + Math.max(y0 - f.z, 0, f.z - y1) ** 2 < FOCUS_R * FOCUS_R);
  }

  // distance from the camera to a node's box, and the level it should be drawn at
  pick(camera) {
    const want = new Set(), cp = camera.position;
    const fov = camera.fov * Math.PI / 180, K = innerHeight / (2 * Math.tan(fov / 2)) / ERR_PX;
    // only what is (nearly) in view gets refined: a frustum ~1.35x wider than the camera's, so turning a little
    // never shows coarse tiles; behind you the coarsest level is enough (and still casts the shadows)
    const wide = camera.clone(); wide.fov = Math.min(150, camera.fov * 1.35); wide.aspect = camera.aspect; wide.far = 20000;
    wide.updateProjectionMatrix(); wide.updateMatrixWorld();
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(wide.projectionMatrix, wide.matrixWorldInverse));
    const box = new THREE.Box3();
    const fine = this.levels[this.levels.length - 1];
    const walk = (s, tx, ty) => {
      const [x0, y0, x1, y1] = this.bounds(s, tx, ty);
      const dx = Math.max(x0 - cp.x, 0, cp.x - x1), dz = Math.max(y0 - cp.z, 0, cp.z - y1), dy = Math.max(0, cp.y - 150, -cp.y); // node boxes: ground ~20-60 m + buildings
      const dist = Math.hypot(dx, dy, dz);
      let near = false;
      for (const f of this.focus) if (Math.max(x0 - f.x, 0, f.x - x1) ** 2 + Math.max(y0 - f.z, 0, f.z - y1) ** 2 < FOCUS_R * FOCUS_R) near = true;
      const child = s / 2;
      box.min.set(x0, 0, y0); box.max.set(x1, 330, y1);
      const seen = dist < 30 || fr.intersectsBox(box);
      // refine while a cell of this level would look bigger than ERR_PX (i.e. the finer level is visibly better)
      // out of view: 4 m cells within 600 m (turning shows 4 m blocks for a moment, not 8 m ones; finer or farther would
      // hold the whole circle around the camera in memory)
      if (s > fine && (near || (seen ? dist < s * K : s > 4 && dist < 600))) {
        const d = this.dims[child];
        for (let cy = ty * 2; cy < Math.min(ty * 2 + 2, d.ny); cy++) for (let cx = tx * 2; cx < Math.min(tx * 2 + 2, d.nx); cx++) walk(child, cx, cy);
      } else want.add(this.key(s, tx, ty) + '|' + dist.toFixed(0));
    };
    const top = this.levels[0], d = this.dims[top];
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) walk(top, tx, ty);
    return want;
  }

  update(camera) {
    const now = performance.now();
    if (!this.dirty && now - (this._t || 0) < 150) return;
    this._t = now; this.dirty = false;
    const want = this.pick(camera);
    const wanted = new Map();
    for (const w of want) { const [k, d] = w.split('|'); wanted.set(k, +d); }
    for (const [k, d] of wanted) { const [s, rest] = k.split('/'); const [tx, ty] = rest.split('_').map(Number); this.request(+s, tx, ty, -d, d < 450 || this.nearFocus(+s, tx, ty)); }
    this.pump();
    // what to show: each wanted node if ready, else the nearest ready ancestor (or all-ready descendants)
    const show = new Set();
    const ready = (k) => { const n = this.nodes.get(k); return n && n.state === 'ready'; };
    const parentOf = (s, tx, ty) => this.key(s * 2, tx >> 1, ty >> 1);
    const childrenOf = (s, tx, ty) => { const c = s / 2, d = this.dims[c], out = []; if (!d) return out;
      for (let cy = ty * 2; cy < Math.min(ty * 2 + 2, d.ny); cy++) for (let cx = tx * 2; cx < Math.min(tx * 2 + 2, d.nx); cx++) out.push([c, cx, cy]); return out; };
    const coveredBy = (s, tx, ty, acc) => { // all-ready descendants that tile this node
      const k = this.key(s, tx, ty);
      if (ready(k)) { acc.push(k); return true; }
      const ch = childrenOf(s, tx, ty);
      if (!ch.length) return false;
      const sub = [];
      for (const [c, cx, cy] of ch) if (!coveredBy(c, cx, cy, sub)) return false;
      acc.push(...sub); return true;
    };
    for (const k of wanted.keys()) {
      const n = this.nodes.get(k);
      if (ready(k)) { show.add(k); continue; }
      const acc = [];
      if (coveredBy(n.s, n.tx, n.ty, acc)) { acc.forEach((a) => show.add(a)); continue; }
      let s = n.s, tx = n.tx, ty = n.ty;
      while (this.dims[s * 2]) { const pk = parentOf(s, tx, ty); s *= 2; tx >>= 1; ty >>= 1; if (ready(pk)) { show.add(pk); break; } }
    }
    // a shown ancestor hides its shown descendants (they would overlap)
    for (const k of [...show]) {
      const n = this.nodes.get(k);
      let s = n.s, tx = n.tx, ty = n.ty;
      while (this.dims[s * 2]) { s *= 2; tx >>= 1; ty >>= 1; if (show.has(this.key(s, tx, ty))) { show.delete(k); break; } }
    }
    let tris = 0;
    for (const n of this.nodes.values()) {
      const vis = show.has(n.key);
      if (n.mesh) n.mesh.visible = vis;
      if (vis || wanted.has(n.key)) n.used = now;
      if (vis && n.tris) tris += n.tris;
    }
    this.tris = tris;
    // free what has not been needed for a while, and the least recently used hidden nodes above the memory cap
    // (never the coarsest level: it is the fallback everywhere)
    const free = (n) => this.free(n);
    const evictable = (n) => n.s !== this.levels[0] && n.state === 'ready' && !show.has(n.key) && !wanted.has(n.key) && !((n.pinned || 0) > now);
    let bytes = 0;
    for (const n of this.nodes.values()) bytes += n.bytes || 0;
    for (const n of [...this.nodes.values()].filter(evictable).sort((a, b) => a.used - b.used)) {
      if (now - n.used < KEEP_MS && bytes < CAP_MB * 2 ** 20) break;
      bytes -= n.bytes || 0; free(n);
    }
    // drop queued requests nobody wants any more (the camera moved on before they were fetched)
    const keep = (n) => wanted.has(n.key) || n.s === this.levels[0] || (n.pinned || 0) > now;
    this.queue = this.queue.filter((n) => this.nodes.get(n.key) === n && keep(n));
    const inQueue = new Set(this.queue);
    for (const n of [...this.nodes.values()]) if (n.state === 'queued' && !inQueue.has(n)) this.nodes.delete(n.key);
  }

  free(n) { if (n.mesh) { n.mesh.geometry.dispose(); this.group.remove(n.mesh); } this.nodes.delete(n.key); if (n.data) this.version++; }

  // request what a camera at pos looking at target will need (called when a flight starts)
  prefetch(pos, target, like) {
    const c = like.clone(); c.position.copy(pos); c.lookAt(target); c.updateMatrixWorld(); c.updateProjectionMatrix();
    for (const w of this.pick(c)) { const [k, d] = w.split('|'); const [s, rest] = k.split('/'); const [tx, ty] = rest.split('_').map(Number); this.request(+s, tx, ty, -d - 50); }
    this.pump();
  }

  // make sure full detail is loaded around (x, z) (metres) before e.g. landing there; resolves when ready
  ensure(x, z, r = 120) {
    const fine = this.levels[this.levels.length - 1], L = this.N * fine, d = this.dims[fine], ps = [];
    for (let ty = Math.max(0, Math.floor((z - r) / L)); ty <= Math.min(d.ny - 1, Math.floor((z + r) / L)); ty++)
      for (let tx = Math.max(0, Math.floor((x - r) / L)); tx <= Math.min(d.nx - 1, Math.floor((x + r) / L)); tx++)
        ps.push(this.request(fine, tx, ty, 1e8, true));
    this.pump();
    return Promise.all(ps);
  }
  stats() {
    let geo = 0, data = 0, n = 0;
    for (const v of this.nodes.values()) {
      if (v.mesh) { n++; geo += v.bytes - (v.data ? v.data.counts.byteLength + v.data.ground.byteLength + v.data.runs.byteLength + v.data.off.byteLength : 0); }
      if (v.data) data += v.data.counts.byteLength + v.data.ground.byteLength + v.data.runs.byteLength + v.data.off.byteLength;
    }
    return { nodes: this.nodes.size, meshes: n, geoMB: +(geo / 2 ** 20).toFixed(1), dataMB: +(data / 2 ** 20).toFixed(1), tris: this.tris };
  }
}

// Voxel queries over whatever is loaded: each cell is answered by the finest loaded node covering it.
// Data coords: x east, row south, z up (metres). three.js: (x, z, row).
export class StreamWorld {
  constructor(streamer) {
    this.st = streamer;
    this.W = streamer.meta.W; this.D = streamer.meta.D;
    this._c = null; this._ck = -1; // last node hit (cache)
    this.leaf = new Uint8Array(4096); // palette ids of foliage (material 3), so a tree is never taken for a landmark
    streamer.meta.palette.forEach((e, i) => { if (e[3] === 3) this.leaf[i] = 1; });
  }
  inside(x, r) { return x >= 0 && r >= 0 && x < this.W && r < this.D; }
  // finest loaded node data for cell (x, r)
  node(x, r) {
    const st = this.st;
    const c = this._c;
    if (c && this._cv === st.version && x >= c.x0 && r >= c.y0 && x < c.x0 + st.N * c.s && r < c.y0 + st.N * c.s && c.s === this._cs) return c;
    for (let i = st.levels.length - 1; i >= 0; i--) {
      const s = st.levels[i], L = st.N * s, n = st.nodes.get(`${s}/${Math.floor(x / L)}_${Math.floor(r / L)}`);
      if (n && n.data) { this._c = n.data; this._cv = st.version; this._cs = s; return n.data; }
    }
    return null;
  }
  col(n, x, r) { return (Math.floor((x - n.x0) / n.s) + 1) + n.S * (Math.floor((r - n.y0) / n.s) + 1); }
  groundAt(x, r) {
    if (!this.inside(x, r)) return 0;
    const n = this.node(x, r);
    return n ? n.ground[this.col(n, x, r)] : 0;
  }
  solid(x, r, z) {
    if (!this.inside(x, r)) return z < 0;
    const n = this.node(x, r);
    if (!n) return z < 0;
    const c = this.col(n, x, r), zc = Math.floor(z / n.s), R = n.runs;
    if (zc < 0) return true;
    for (let k = n.off[c], e = n.off[c + 1]; k < e; k++) {
      const z0 = R[k * 3];
      if (zc < z0) return false;
      if (zc < z0 + R[k * 3 + 1]) return true;
    }
    return false;
  }
  top(x, r) {
    if (!this.inside(x, r)) return 0;
    const n = this.node(x, r);
    if (!n) return 0;
    const c = this.col(n, x, r), k = n.off[c + 1] - 1;
    if (k < n.off[c]) return n.ground[c];
    return (n.runs[k * 3] + n.runs[k * 3 + 1]) * n.s;
  }
  // top of the column ignoring foliage (a building's or a structure's height; ground under a tree)
  topSolid(x, r) {
    if (!this.inside(x, r)) return 0;
    const n = this.node(x, r);
    if (!n) return 0;
    const c = this.col(n, x, r), R = n.runs;
    for (let k = n.off[c + 1] - 1; k >= n.off[c]; k--) if (!this.leaf[R[k * 3 + 2]]) return (R[k * 3] + R[k * 3 + 1]) * n.s;
    return n.ground[c];
  }
  extent(x0, r0, minTop, cap = 40000) {
    x0 = Math.floor(x0); r0 = Math.floor(r0);
    const seen = new Set([r0 * this.W + x0]), q = [[x0, r0]];
    let R = 0;
    while (q.length && seen.size < cap) {
      const [x, r] = q.pop();
      R = Math.max(R, Math.hypot(x - x0, r - r0));
      for (const [dx, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nr = r + dr, k = nr * this.W + nx;
        if (!seen.has(k) && this.inside(nx, nr) && this.top(nx, nr) >= minTop) { seen.add(k); q.push([nx, nr]); }
      }
    }
    return R;
  }
  support(x, r, top) {
    if (!this.inside(x, r)) return 0;
    const n = this.node(x, r);
    if (!n) return 0;
    const c = this.col(n, x, r), R = n.runs;
    let s = n.ground[c];
    for (let k = n.off[c], e = n.off[c + 1]; k < e; k++) {
      const t = (R[k * 3] + R[k * 3 + 1]) * n.s;
      if (t <= top && t > s) s = t;
    }
    return s;
  }
  // a walkable surface with air beneath (a bridge deck, a footbridge), else null; roofs rise from the ground so
  // they don't count. Metres.
  deckAt(x, r, probe = true) {
    if (!this.inside(x, r)) return null;
    if (probe) { // a deck is something to stand on: low (bridges are < 35 m up) and wide (the same surface 3 m around)
      const d = this.deckAt(x, r, false);
      if (d == null || d - this.groundAt(x, r) > 35) return null;
      for (const [dx, dr] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) { const e = this.deckAt(x + dx, r + dr, false); if (e == null || Math.abs(e - d) > 1.5) return null; }
      return d;
    }
    const n = this.node(x, r);
    if (!n) return null;
    const c = this.col(n, x, r), R = n.runs, gz = n.ground[c] / n.s, e = n.off[c + 1];
    // the lowest floating surface with headroom; 1-voxel runs above (cable stays, lamp heads) are not a ceiling
    for (let k = n.off[c]; k < e; k++) {
      const z0 = R[k * 3], top = z0 + R[k * 3 + 1];
      if (z0 <= gz + 2 / n.s) continue;
      let ceil = 1e9;
      for (let j = k + 1; j < e; j++) if (R[j * 3 + 1] > 1) { ceil = R[j * 3]; break; }
      if (ceil - top >= 2.5 / n.s) return top * n.s;
    }
    return null;
  }
  blocked(x, r, z0, z1) {
    for (let z = Math.floor(z0); z < z1; z++) if (this.solid(x, r, z)) return true;
    return false;
  }
  raycast(o, d, maxDist = 4000) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = sx ? Math.abs(1 / d.x) : Infinity, tdy = sy ? Math.abs(1 / d.y) : Infinity, tdz = sz ? Math.abs(1 / d.z) : Infinity;
    let tx = sx ? ((sx > 0 ? x + 1 - o.x : o.x - x) * tdx) : Infinity;
    let ty = sy ? ((sy > 0 ? y + 1 - o.y : o.y - y) * tdy) : Infinity;
    let tz = sz ? ((sz > 0 ? z + 1 - o.z : o.z - z) * tdz) : Infinity;
    let t = 0;
    for (let i = 0; i < 20000 && t < maxDist; i++) {
      if (y < 0) { this.hitAxis = 1; return t; }
      if (y < 420 && this.solid(x, z, y)) return t;
      if (y > 420 && sy >= 0) return Infinity;
      if (tx < ty && tx < tz) { t = tx; x += sx; tx += tdx; this.hitAxis = 0; }
      else if (ty < tz) { t = ty; y += sy; ty += tdy; this.hitAxis = 1; }
      else { t = tz; z += sz; tz += tdz; this.hitAxis = 2; }
    }
    return Infinity;
  }
}
