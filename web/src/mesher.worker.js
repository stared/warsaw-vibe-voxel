// Greedy mesher with baked ambient occlusion for column-run voxel data.
// Data coords: x = column (east), y = row (south), z = up. Output positions in three.js coords (x, z, y).

let W, D, counts, runs, offsets;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ({ W, D } = m);
    counts = m.counts;
    runs = m.runs;
    offsets = new Uint32Array(W * D + 1);
    for (let i = 0; i < W * D; i++) offsets[i + 1] = offsets[i] + counts[i];
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'chunk') {
    const out = meshChunk(m.x0, m.y0, m.cs);
    self.postMessage({ type: 'chunk', id: m.id, ...out }, out.transfer);
  }
};

function meshChunk(x0, y0, cs) {
  const sx = cs + 2, sy = cs + 2;
  // height of chunk incl. padding
  let zmax = 0;
  for (let y = y0 - 1; y <= y0 + cs; y++) {
    if (y < 0 || y >= D) continue;
    for (let x = x0 - 1; x <= x0 + cs; x++) {
      if (x < 0 || x >= W) continue;
      const c = y * W + x;
      const n = counts[c];
      if (n) {
        const r = (offsets[c] + n - 1) * 3;
        const top = runs[r] + runs[r + 1];
        if (top > zmax) zmax = top;
      }
    }
  }
  const sz = zmax + 2;
  const vol = new Uint16Array(sx * sy * sz);
  const SOLID_BELOW = 65535;
  for (let ly = 0; ly < sy; ly++) {
    const y = y0 - 1 + ly;
    if (y < 0 || y >= D) continue;
    for (let lx = 0; lx < sx; lx++) {
      const x = x0 - 1 + lx;
      if (x < 0 || x >= W) continue;
      const c = y * W + x;
      // z = -1 (index 0) counts as solid so the slab bottom is never meshed
      vol[lx + sx * ly] = SOLID_BELOW;
      for (let k = offsets[c], e = offsets[c] + counts[c]; k < e; k++) {
        const z0 = runs[k * 3], len = runs[k * 3 + 1], v = runs[k * 3 + 2];
        for (let z = z0; z < z0 + len; z++) vol[lx + sx * (ly + sy * (z + 1))] = v;
      }
    }
  }
  const at = (x, y, z) => vol[x + sx * (y + sy * z)];

  const pos = [], attr = [], pal = [], idx = [];
  let vcount = 0;
  const dims = [cs, cs, zmax];
  // local coord mapping: data (x,y,z) -> vol (x+1, y+1, z+1)
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const q = [0, 0, 0];
    q[d] = 1;
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let s = 0; s < dims[d]; s++) {
        // build mask
        let any = false;
        const p = [0, 0, 0];
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            p[d] = s; p[u] = i; p[v] = j;
            const a = at(p[0] + 1, p[1] + 1, p[2] + 1);
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW) {
              const nx = p[0] + 1 + q[0] * dir, ny = p[1] + 1 + q[1] * dir, nz = p[2] + 1 + q[2] * dir;
              if (at(nx, ny, nz) === 0) {
                // AO for 4 corners of the face
                const U = [0, 0, 0], V = [0, 0, 0];
                U[u] = 1; V[v] = 1;
                const solid = (du, dv) => {
                  const xx = nx + U[0] * du + V[0] * dv, yy = ny + U[1] * du + V[1] * dv, zz = nz + U[2] * du + V[2] * dv;
                  if (xx < 0 || yy < 0 || zz < 0 || xx >= sx || yy >= sy || zz >= sz) return 0;
                  const w = at(xx, yy, zz);
                  return w !== 0 ? 1 : 0;
                };
                const s10 = solid(-1, 0), s12 = solid(1, 0), s01 = solid(0, -1), s21 = solid(0, 1);
                const ao = (a1, a2, c) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
                const a00 = ao(s10, s01, solid(-1, -1));
                const a10 = ao(s12, s01, solid(1, -1));
                const a11 = ao(s12, s21, solid(1, 1));
                const a01 = ao(s10, s21, solid(-1, 1));
                key = a * 256 + (a00 | (a10 << 2) | (a11 << 4) | (a01 << 6)) + 1;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (!any) continue;
        // greedy merge
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
            // emit quad
            const k1 = key - 1;
            const palIdx = Math.floor(k1 / 256), aoBits = k1 % 256;
            const aos = [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
            const base = [0, 0, 0];
            base[d] = s + (dir > 0 ? 1 : 0); base[u] = i; base[v] = j;
            const du = [0, 0, 0], dv = [0, 0, 0];
            du[u] = w; dv[v] = h;
            const corners = [
              base,
              [base[0] + du[0], base[1] + du[1], base[2] + du[2]],
              [base[0] + du[0] + dv[0], base[1] + du[1] + dv[1], base[2] + du[2] + dv[2]],
              [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]],
            ];
            for (let c = 0; c < 4; c++) {
              const cc = corners[c];
              // to three.js coords: (x, z, y)
              pos.push(cc[0] + x0, cc[2], cc[1] + y0);
              attr.push(normalIdx, aos[c], 0, 0);
              pal.push(palIdx);
            }
            const b = vcount;
            // winding: depends on axis & direction; flip diagonal for AO anisotropy
            const flip = aos[0] + aos[2] < aos[1] + aos[3];
            // in data space (u,v,d) right-handed; three-space swaps y/z (mirror) so invert winding
            const ccw = dir > 0;
            if (!flip) {
              if (ccw) idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 2);
              else idx.push(b, b + 1, b + 3, b + 1, b + 2, b + 3);
            } else {
              if (ccw) idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
              else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
            }
            vcount += 4;
            i += w;
          }
        }
      }
    }
  }
  const P = new Int16Array(pos), A = new Uint8Array(attr), L = new Uint16Array(pal);
  const I = vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return { pos: P, attr: A, pal: L, idx: I, zmax, transfer: [P.buffer, A.buffer, L.buffer, I.buffer] };
}
