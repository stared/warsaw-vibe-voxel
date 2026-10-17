import * as THREE from 'three';

// Loads and meshes voxel tiles (scripts/tiles.py: N x N cells of s metres) with a worker pool, and answers voxel
// queries over what is loaded (StreamWorld). What to load and show is decided by the engine on top: all1m.js (the
// whole city at 1 m, the default) or zones.js (the real-area prototype), each replacing update().
// (The level-of-detail engine that picked coarser levels by distance and swapped them is gone.)

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
    this.inflight = 0;
    this.tris = 0;
    this.version = 0;  // bumps when column data changes (for caches)
    // workers exist while there is work: up to 4 while streaming (a 1 m tile meshes in ~80 ms), retired after 4 s idle
    // down to one, so a settled view doesn't keep several worker heaps alive (each ~35 MB)
    this.maxW = Math.min(Math.max(2, ((navigator.hardwareConcurrency || 4) >> 1) - 1), 4);
    this.workers = [];
    this.spawn();
    this.world = new StreamWorld(this);
  }
  key(s, tx, ty) { return `${s}/${tx}_${ty}`; }
  bounds(s, tx, ty) { const L = this.N * s; return [tx * L, ty * L, Math.min((tx + 1) * L, this.meta.W), Math.min((ty + 1) * L, this.meta.D)]; }

  request(s, tx, ty, prio, keep = false) {
    const k = this.key(s, tx, ty);
    let n = this.nodes.get(k);
    // needed with its column data now: fetch just the data, the mesh stays on screen meanwhile (freeing the node
    // let a coarse ancestor stand in, which hid every finer tile under it: zooming in flipped areas to 8 m blocks)
    if (n && keep && n.state === 'ready' && !n.data && !n.empty) {
      if (!n.dataJob) {
        n.keep = true;
        n.dataJob = { node: n, key: k, state: 'queued', dataOnly: true };
        n.dataJob.ready = new Promise((r) => { n.dataJob.resolve = r; });
        this.queue.push(n.dataJob);
      }
      n.dataJob.prio = prio;
      return n.dataJob.ready;
    }
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
  spawn() {
    const w = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
    w.busy = 0; w.idle = performance.now();
    w.onmessage = (e) => this.onNode(e.data, w);
    this.workers.push(w);
    return w;
  }
  retire() {
    const now = performance.now();
    for (const w of [...this.workers]) if (this.workers.length > 1 && w.busy === 0 && now - w.idle > 4000) { w.terminate(); this.workers.splice(this.workers.indexOf(w), 1); }
  }
  pump() {
    this.queue.sort((a, b) => b.prio - a.prio);
    while (this.queue.length > this.workers.length * 2 && this.workers.length < this.maxW) this.spawn();
    while (this.queue.length && this.inflight < this.workers.length * 2) {
      const job = this.queue.shift();
      if (job.state !== 'queued') continue;
      const w = this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b));
      w.busy++; this.inflight++;
      job.state = 'loading';
      const n = job.node || job;
      const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
      // column data (collisions, ray casts) is kept for coarse nodes (small) and for full-detail ones near you
      // building ids of the tile's columns (all1m.js sets bldMap), so the mesher keeps buildings apart
      let bld = null;
      if (this.bldMap && n.s === 1 && !job.dataOnly) {
        const { data, W } = this.bldMap, N = this.N; bld = new Uint16Array(N * N);
        for (let r = 0; r < N && y0 + r < this.meta.D; r++) bld.set(data.subarray((y0 + r) * W + x0, (y0 + r) * W + Math.min(x0 + N, W)), r * N);
      }
      w.postMessage({ type: 'node', key: n.key, url: new URL(`${this.base}/${n.key}.bin`, location.href).href, N: this.N, s: n.s, x0, y0, keep: n.keep || n.s > 1, dataOnly: !!job.dataOnly, bld }, bld ? [bld.buffer] : []);
    }
  }
  onNode(m, w) {
    w.busy--; this.inflight--; w.idle = performance.now();
    const n = this.nodes.get(m.key);
    if (!n) { this.pump(); return; }
    if (m.dataOnly) { // column data for a node already on screen
      const job = n.dataJob; n.dataJob = null;
      if (m.type === 'error') console.warn(m.error); else if (m.data && !n.data) this.setData(n, m.data);
      job?.resolve(); this.pump(); return;
    }
    if (m.type === 'error') { console.warn(m.error); n.state = 'ready'; n.empty = true; n.resolve(); this.pump(); return; }
    if (m.idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      geo.setAttribute('vattr', new THREE.BufferAttribute(m.attr, 4));
      geo.setAttribute('vpal', new THREE.BufferAttribute(m.pal, 1));
      if (m.bld) geo.setAttribute('vbld', new THREE.BufferAttribute(m.bld, 1));
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
      n.bytes = m.pos.byteLength + m.attr.byteLength + m.pal.byteLength + m.idx.byteLength + (m.bld ? m.bld.byteLength : 0); // GPU-side
    }
    if (m.data) this.setData(n, m.data);
    n.state = 'ready';
    if (m.ms) (this.timing ||= []).push([n.s, ...m.ms]);
    n.resolve();
    this.dirty = true;
    this.pump();
  }

  setData(n, { counts, ground, runs }) {
    const S = this.N + 2, off = new Uint32Array(S * S + 1);
    for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + counts[i];
    const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
    n.data = { s: n.s, x0, y0, S, counts, ground, runs, off };
    n.bytes = (n.bytes || 0) + counts.byteLength + ground.byteLength + runs.byteLength + off.byteLength;
    this.version++;
  }

  update() {} // replaced by the engine

  free(n) { n.dataJob?.resolve(); n.dataJob = null; if (n.mesh) { n.mesh.geometry.dispose(); this.group.remove(n.mesh); } this.nodes.delete(n.key); if (n.data) this.version++; }

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
