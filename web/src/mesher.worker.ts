// Fetches, unzips and greedy-meshes one tile (scripts/tiles.py), with baked ambient occlusion.
// Data coordinates: x east, y south, z up. Positions go out in three.js axes (x, z, y), metres.
// A tile is N x N cells of s metres plus a 1-cell apron.

export interface RawColumns { counts: Uint16Array; runs: Uint16Array }
export interface Columns extends RawColumns { ground: Uint8Array }

export interface MeshRequest {
  key: string;
  url: string;
  under?: RawColumns | string;
  N: number;
  s: number;
  x0: number;
  y0: number;
  keep: boolean;
  dataOnly: boolean;
  bld: Uint16Array | null;
}

export type MeshReply =
  | { type: 'node'; key: string; dataOnly: boolean; data: Columns | null; pos: Int16Array; attr: Uint8Array; pal: Uint16Array; bld: Uint16Array | null; quads: number }
  | { type: 'error'; key: string; dataOnly: boolean; error: string };

const post = (msg: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(msg, transfer);

async function fetchGzip(url: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function decode(buf: ArrayBuffer, N: number) {
  const n2 = (N + 2) * (N + 2);
  const counts = new Uint16Array(buf, 0, n2), ground = new Uint8Array(buf, n2 * 2, n2);
  let nr = 0;
  for (let i = 0; i < n2; i++) nr += counts[i];
  const runs = new Uint16Array(buf.slice(n2 * 3, n2 * 3 + nr * 6));
  const detail = new Uint16Array(buf.slice(n2 * 3 + nr * 6)); // coarse levels: thin structures as 1 m voxels (x, y, z, palette)
  return { counts, ground, runs, detail };
}

const copyColumns = (c: Columns): Columns => ({ counts: c.counts.slice(), ground: c.ground.slice(), runs: c.runs });
const columnBuffers = (c: Columns) => [c.counts.buffer, c.ground.buffer, c.runs.buffer];

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const m = e.data;
  try {
    const { counts, ground, runs, detail } = decode(await fetchGzip(m.url), m.N);
    const keep = m.keep || m.dataOnly ? copyColumns({ counts, ground, runs }) : null;
    if (m.dataOnly) {
      post({ type: 'node', key: m.key, dataOnly: true, data: keep, pos: new Int16Array(), attr: new Uint8Array(), pal: new Uint16Array(), bld: null, quads: 0 }, columnBuffers(keep!));
      return;
    }
    const under = typeof m.under === 'string' ? decode(await fetchGzip(m.under), m.N) : m.under ?? null;
    const out = meshTile(m.N, m.s, m.x0, m.y0, { counts, ground, runs }, detail, m.bld, under);
    const transfer: Transferable[] = [out.pos.buffer, out.attr.buffer, out.pal.buffer];
    if (out.bld) transfer.push(out.bld.buffer);
    if (keep) transfer.push(...columnBuffers(keep));
    post({ type: 'node', key: m.key, dataOnly: false, data: keep, ...out }, transfer);
  } catch (err) {
    post({ type: 'error', key: m.key, dataOnly: m.dataOnly, error: String(err) });
  }
};

// corner order per quad so that the one shared index pattern (0 1 2, 0 2 3) gives its winding and AO diagonal,
// by [AO diagonal flipped][facing +]
const QUAD_ORDER = [[1, 2, 3, 0], [1, 0, 3, 2], [0, 1, 2, 3], [0, 3, 2, 1]];
const SOLID_BELOW = 65535;
const OCC = 65534; // the base tile under a foliage tile: solid for culling and AO, never meshed

class QuadBuffer {
  private cap = 1 << 14;
  pos = new Int16Array(this.cap * 3);
  attr = new Uint8Array(this.cap * 4);
  pal = new Uint16Array(this.cap);
  bld = new Uint16Array(this.cap);
  count = 0;

  reserve(n: number) {
    if (this.count + n <= this.cap) return;
    this.cap *= 2;
    const grow = <T extends Int16Array | Uint8Array | Uint16Array>(a: T, k: number) => { const b = new (a.constructor as new (n: number) => T)(this.cap * k); b.set(a); return b; };
    this.pos = grow(this.pos, 3); this.attr = grow(this.attr, 4); this.pal = grow(this.pal, 1); this.bld = grow(this.bld, 1);
  }

  vertex(x: number, y: number, z: number, normal: number, ao: number, ground: number, scale: number, palette: number, building: number) {
    const v = this.count++;
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.attr[v * 4] = normal; this.attr[v * 4 + 1] = ao; this.attr[v * 4 + 2] = ground; this.attr[v * 4 + 3] = scale;
    this.pal[v] = palette; this.bld[v] = building;
  }
}

function offsetsOf(counts: Uint16Array, n: number) {
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + counts[i];
  return off;
}

function topOf(c: RawColumns, off: Uint32Array, n: number) {
  let zmax = 0;
  for (let i = 0; i < n; i++) {
    const k = c.counts[i];
    if (k) { const r = (off[i] + k - 1) * 3; zmax = Math.max(zmax, c.runs[r] + c.runs[r + 1]); }
  }
  return zmax;
}

// bldIds (1 m tiles): the building of each column (scripts/zones.py, 0: none); faces never merge across buildings
function meshTile(N: number, s: number, x0: number, y0: number, cols: Columns, detail: Uint16Array, bldIds: Uint16Array | null, under: RawColumns | null) {
  const S = N + 2, SS = S * S, { ground } = cols;
  const off = offsetsOf(cols.counts, SS), uoff = under && offsetsOf(under.counts, SS);
  const zmax = Math.max(topOf(cols, off, SS), under && uoff ? topOf(under, uoff, SS) : 0);
  const sz = zmax + 2, vol = new Uint16Array(SS * sz);
  const fill = (c: RawColumns, o: Uint32Array, value: (v: number) => number) => {
    for (let i = 0; i < SS; i++) for (let k = o[i], e = o[i] + c.counts[i]; k < e; k++) {
      const z0 = c.runs[k * 3], len = c.runs[k * 3 + 1], v = value(c.runs[k * 3 + 2]);
      for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
    }
  };
  if (under && uoff) fill(under, uoff, () => OCC);
  for (let i = 0; i < SS; i++) vol[i] = SOLID_BELOW; // z = -1 is solid, so the slab's bottom is never meshed
  fill(cols, off, (v) => v);
  const bidAt = (x: number, y: number) => (bldIds ? bldIds[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))] : 0);
  const out = new QuadBuffer();
  meshFaces(N, s, x0, y0, vol, sz, ground, bidAt, out);
  if (detail.length) meshDetail(N, s, x0, y0, detail, ground, bidAt, out);
  const n = out.count;
  return { pos: out.pos.slice(0, n * 3), attr: out.attr.slice(0, n * 4), pal: out.pal.slice(0, n), quads: n / 4, bld: bldIds ? out.bld.slice(0, n) : null };
}

function meshFaces(N: number, s: number, x0: number, y0: number, vol: Uint16Array, sz: number, ground: Uint8Array,
  bidAt: (x: number, y: number) => number, out: QuadBuffer) {
  const S = N + 2, sx = S, sy = S;
  const dims = [N, N, sz - 2];
  // the tallest column in each row and each column of the slab: slices are scanned only up to it
  const ST = [1, sx, sx * sy], colTop = new Uint16Array(S * S);
  for (let c = 0; c < S * S; c++) { let z = sz - 1; while (z > 0 && vol[c + sx * sy * z] === 0) z--; colTop[c] = z; }
  const topX = new Uint16Array(S), topY = new Uint16Array(S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const t = colTop[x + S * y]; if (t > topX[x]) topX[x] = t; if (t > topY[y]) topY[y] = t; }
  const cell = (X: number, Y: number, z: number) => vol[(X + 1) + sx * ((Y + 1) + sy * (z + 1))];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3, nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const sd = ST[d], su = ST[u], sv = ST[v];
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let sl = 0; sl < dims[d]; sl++) {
        let any = false;
        // faces out through the tile's border are always emitted: the neighbour may not be loaded yet
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        const zt = d === 0 ? Math.max(topX[sl + 1], topX[sl + 1 + dir]) : d === 1 ? Math.max(topY[sl + 1], topY[sl + 1 + dir]) : nv;
        const jn = v === 2 ? Math.min(nv, zt) : nv, in_ = u === 2 ? Math.min(nu, zt) : nu;
        if (d === 2) mask.fill(0);
        else for (let j = 0; j < nv; j++) for (let i = j < jn ? in_ : 0; i < nu; i++) mask[i + j * nu] = 0;
        for (let j = 0; j < jn; j++) {
          if (d === 2 && topY[j + 1] <= sl) continue;
          for (let i = 0; i < in_; i++) {
            const idx = (sl + 1) * sd + (i + 1) * su + (j + 1) * sv, a = vol[idx];
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW && a !== OCC) {
              const ni = idx + dir * sd, nb = vol[ni];
              if (nb === 0 || (border && nb !== SOLID_BELOW && nb !== OCC)) {
                const px = d === 0 ? sl : u === 0 ? i : j, py = d === 1 ? sl : u === 1 ? i : j;
                const gm = ground[(px + 1) + S * (py + 1)];
                const ang = d < 2 && nb === 0 ? wallAngle(N, px, py, d === 0 ? j : i, d, dir, cell) : 0;
                const aob = nb === 0 ? faceAO(vol, ni, su, sv, ang ? d : -1) : 255;
                // < 2^53: ang < 25, palette < 4096, ids < 16384
                key = (((ang * 4096 + a) * 256 + aob) * 256 + gm) * 16384 + bidAt(px, py) + 1;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (any) emitMerged(mask, nu, nv, d, u, v, dir, normalIdx, sl, s, x0, y0, out);
      }
    }
  }
}

// A wall at an angle to the grid is a staircase of x- and y-facing faces; it is lit as the plane it stands for. Its
// direction in plan comes from the occupied cells around it (24 steps of 15°; 0 = the face's own).
function wallAngle(N: number, px: number, py: number, cz: number, d: number, dir: number, cell: (x: number, y: number, z: number) => number) {
  let gx = 0, gy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const Y = py + dy;
    if (Y < -1 || Y > N) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const X = px + dx;
      if (X < -1 || X > N || (dx === 0 && dy === 0)) continue;
      const o = cell(X, Y, cz);
      if (o !== 0 && o !== OCC) { gx -= dx; gy -= dy; }
    }
  }
  const ax = d === 0 ? dir : 0, ay = d === 1 ? dir : 0;
  // a step of a staircase is short both ways along the wall; beside the corner of a straight wall there is a long run
  for (const sgn of [-1, 1]) {
    let k = 1;
    for (; k <= 4; k++) {
      const X = px + (d === 1 ? sgn * k : 0), Y = py + (d === 0 ? sgn * k : 0);
      if (X < -1 || X > N || Y < -1 || Y > N) break;
      const o = cell(X, Y, cz);
      if (o === 0 || o === OCC || cell(X + ax, Y + ay, cz) !== 0) break;
    }
    if (k > 4) return 0;
  }
  const gl = Math.hypot(gx, gy);
  return gl >= 3 && (gx * ax + gy * ay) / gl > 0.05 ? 1 + (Math.round(Math.atan2(gy, gx) / (Math.PI / 12)) + 24) % 24 : 0;
}

// per-corner occlusion, 2 bits each; on a staircase wall (stairAxis >= 0) only what is above or below darkens it
function faceAO(vol: Uint16Array, ni: number, su: number, sv: number, stairAxis: number) {
  const o = (k: number) => (vol[k] !== 0 ? 1 : 0);
  let s10 = o(ni - su), s12 = o(ni + su), s01 = o(ni - sv), s21 = o(ni + sv);
  let c00 = o(ni - su - sv), c20 = o(ni + su - sv), c22 = o(ni + su + sv), c02 = o(ni - su + sv);
  if (stairAxis === 0) { s10 = s12 = 0; c00 = c20 = c22 = c02 = 0; }
  else if (stairAxis === 1) { s01 = s21 = 0; c00 = c20 = c22 = c02 = 0; }
  const ao = (a1: number, a2: number, c: number) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
  return ao(s10, s01, c00) | (ao(s12, s01, c20) << 2) | (ao(s12, s21, c22) << 4) | (ao(s10, s21, c02) << 6);
}

function emitMerged(mask: Float64Array, nu: number, nv: number, d: number, u: number, v: number, dir: number, normalIdx: number,
  sl: number, s: number, x0: number, y0: number, out: QuadBuffer) {
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu;) {
      const key = mask[i + j * nu];
      if (!key) { i++; continue; }
      let w = 1;
      while (i + w < nu && mask[i + w + j * nu] === key) w++;
      let h = 1;
      outer: while (j + h < nv) {
        for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * nu] !== key) break outer;
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * nu] = 0;
      const k0 = key - 1, bid = k0 % 16384, k1 = Math.floor(k0 / 16384);
      const gm = k1 % 256, aoBits = Math.floor(k1 / 256) % 256, palIdx = Math.floor(k1 / 65536) % 4096, ang = Math.floor(k1 / (65536 * 4096));
      const aos = aoBits === 255 ? [3, 3, 3, 3] : [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
      const base = [0, 0, 0];
      base[d] = sl + (dir > 0 ? 1 : 0); base[u] = i; base[v] = j;
      const corners = [base, [...base], [...base], [...base]];
      corners[1][u] += w; corners[2][u] += w; corners[2][v] += h; corners[3][v] += h;
      out.reserve(4);
      const ord = QUAD_ORDER[(aos[0] + aos[2] < aos[1] + aos[3] ? 2 : 0) + (dir > 0 ? 1 : 0)];
      for (const c of ord) {
        const p = corners[c];
        out.vertex(p[0] * s + x0, p[2] * s, p[1] * s + y0, normalIdx + 8 * ang, aos[c], gm, s, palIdx, bid);
      }
      i += w;
    }
  }
}

// thin structures at true size: vertical runs of one colour become boxes; faces against another detail voxel are culled
function meshDetail(N: number, s: number, x0: number, y0: number, detail: Uint16Array, ground: Uint8Array,
  bidAt: (x: number, y: number) => number, out: QuadBuffer) {
  const S = N + 2;
  const key = (x: number, y: number, z: number) => (z * 2048 + y) * 2048 + x;
  const have = new Set<number>(), order: number[] = [];
  for (let k = 0; k < detail.length; k += 4) { have.add(key(detail[k], detail[k + 1], detail[k + 2])); order.push(k); }
  order.sort((a, b) => detail[a] - detail[b] || detail[a + 1] - detail[b + 1] || detail[a + 2] - detail[b + 2]);
  const quad = (d: number, dir: number, base: number[], w: number, h: number, palIdx: number, gm: number, bid: number) => {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const corners = [[...base], [...base], [...base], [...base]];
    corners[1][u] += w; corners[2][u] += w; corners[2][v] += h; corners[3][v] += h;
    out.reserve(4);
    for (const c of QUAD_ORDER[dir > 0 ? 1 : 0]) {
      const p = corners[c];
      out.vertex(p[0] + x0, p[2], p[1] + y0, d * 2 + (dir > 0 ? 1 : 0), 3, gm, 1, palIdx, bid);
    }
  };
  for (let i = 0; i < order.length;) {
    const k = order[i], x = detail[k], y = detail[k + 1], z0 = detail[k + 2], p = detail[k + 3];
    let j = i + 1;
    while (j < order.length && detail[order[j]] === x && detail[order[j] + 1] === y && detail[order[j] + 2] === z0 + (j - i) && detail[order[j] + 3] === p) j++;
    const h = j - i;
    i = j;
    const gm = ground[(Math.floor(x / s) + 1) + S * (Math.floor(y / s) + 1)], bid = s === 1 ? bidAt(x, y) : 0;
    for (const [dx, dy, d, dir] of [[-1, 0, 0, -1], [1, 0, 0, 1], [0, -1, 1, -1], [0, 1, 1, 1]]) {
      let covered = true;
      for (let z = z0; z < z0 + h && covered; z++) covered = have.has(key(x + dx, y + dy, z));
      if (covered) continue;
      const base = [x + (dir > 0 && d === 0 ? 1 : 0), y + (dir > 0 && d === 1 ? 1 : 0), z0];
      if (d === 0) quad(0, dir, base, 1, h, p, gm, bid);
      else quad(1, dir, base, h, 1, p, gm, bid);
    }
    if (!have.has(key(x, y, z0 - 1))) quad(2, -1, [x, y, z0], 1, 1, p, gm, bid);
    if (!have.has(key(x, y, z0 + h))) quad(2, 1, [x, y, z0 + h], 1, 1, p, gm, bid);
  }
}
