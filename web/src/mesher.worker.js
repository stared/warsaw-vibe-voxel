// Fetch + unzip + greedy-mesh one quadtree node (scripts/tiles.py) with baked ambient occlusion.
// Data coords: x = column (east), y = row (south), z = up. Output positions in three.js coords (x, z, y), metres.
// A node holds N x N cells of s metres plus a 1-cell apron. Side faces on the node border are always emitted
// (the neighbour may be drawn at another level of detail, so culling against our own apron could leave cracks).

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'node') return;
  try {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`${res.status} ${m.url}`);
    const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const n2 = (m.N + 2) * (m.N + 2);
    const counts = new Uint16Array(buf, 0, n2);
    const ground = new Uint8Array(buf, n2 * 2, n2);
    const runs = new Uint16Array(buf.slice(n2 * 3)); // (N+2)^2 is even, so the runs start 2-byte aligned
    const out = meshNode(m.N, m.s, m.x0, m.y0, counts, ground, runs);
    const transfer = [out.pos.buffer, out.attr.buffer, out.pal.buffer, out.idx.buffer];
    let data = null;
    if (m.keep) { // the column data stays with the viewer for collisions / ray casts
      data = { counts: counts.slice(), ground: ground.slice(), runs };
      transfer.push(data.counts.buffer, data.ground.buffer, runs.buffer);
    }
    self.postMessage({ type: 'node', key: m.key, ...out, data }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', key: m.key, error: String(err) });
  }
};

function meshNode(N, s, x0, y0, counts, ground, runs) {
  const S = N + 2;
  const offsets = new Uint32Array(S * S + 1);
  for (let i = 0; i < S * S; i++) offsets[i + 1] = offsets[i] + counts[i];
  let zmax = 0;
  for (let c = 0; c < S * S; c++) {
    const n = counts[c];
    if (n) { const r = (offsets[c] + n - 1) * 3, top = runs[r] + runs[r + 1]; if (top > zmax) zmax = top; }
  }
  const sx = S, sy = S, sz = zmax + 2;
  const vol = new Uint16Array(sx * sy * sz);
  const SOLID_BELOW = 65535;
  for (let c = 0; c < S * S; c++) {
    vol[c] = SOLID_BELOW; // z = -1 counts as solid so the slab bottom is never meshed
    for (let k = offsets[c], e = offsets[c] + counts[c]; k < e; k++) {
      const z0 = runs[k * 3], len = runs[k * 3 + 1], v = runs[k * 3 + 2];
      for (let z = z0; z < z0 + len; z++) vol[c + sx * sy * (z + 1)] = v;
    }
  }
  const at = (x, y, z) => vol[x + sx * (y + sy * z)];
  // growable typed output (plain JS arrays cost 8 bytes per number and churn the worker's heap)
  let cap = 1 << 14, pos = new Int16Array(cap * 3), attr = new Uint8Array(cap * 4), pal = new Uint16Array(cap), idx = new Uint32Array(cap * 1.5);
  let np = 0, ni = 0;
  const grow = () => {
    cap *= 2;
    const p2 = new Int16Array(cap * 3); p2.set(pos); pos = p2;
    const a2 = new Uint8Array(cap * 4); a2.set(attr); attr = a2;
    const l2 = new Uint16Array(cap); l2.set(pal); pal = l2;
    const i2 = new Uint32Array(cap * 1.5); i2.set(idx); idx = i2;
  };
  let vcount = 0;
  const dims = [N, N, zmax];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const q = [0, 0, 0];
    q[d] = 1;
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let sl = 0; sl < dims[d]; sl++) {
        let any = false;
        const p = [0, 0, 0];
        // faces looking out of the node through its border: emit regardless of the apron
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            p[d] = sl; p[u] = i; p[v] = j;
            const a = at(p[0] + 1, p[1] + 1, p[2] + 1);
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW) {
              const nx = p[0] + 1 + q[0] * dir, ny = p[1] + 1 + q[1] * dir, nz = p[2] + 1 + q[2] * dir;
              const nb = at(nx, ny, nz);
              if (nb === 0 || (border && nb !== SOLID_BELOW)) {
                const U = [0, 0, 0], V = [0, 0, 0];
                U[u] = 1; V[v] = 1;
                const solid = (du, dv) => {
                  const xx = nx + U[0] * du + V[0] * dv, yy = ny + U[1] * du + V[1] * dv, zz = nz + U[2] * du + V[2] * dv;
                  if (xx < 0 || yy < 0 || zz < 0 || xx >= sx || yy >= sy || zz >= sz) return 0;
                  return at(xx, yy, zz) !== 0 ? 1 : 0;
                };
                const s10 = solid(-1, 0), s12 = solid(1, 0), s01 = solid(0, -1), s21 = solid(0, 1);
                const ao = (a1, a2, c) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
                const aob = nb === 0 ? (ao(s10, s01, solid(-1, -1)) | (ao(s12, s01, solid(1, -1)) << 2) | (ao(s12, s21, solid(1, 1)) << 4) | (ao(s10, s21, solid(-1, 1)) << 6)) : 255;
                // ground level of this column (metres) rides along as a vertex attribute for the facade shader;
                // faces only merge over the same ground, so it is exact on every quad
                const gm = ground[(p[0] + 1) + S * (p[1] + 1)];
                key = ((a * 256 + aob) * 256 + gm) + 1;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (!any) continue;
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
            const k1 = key - 1;
            const gm = k1 % 256, aoBits0 = Math.floor(k1 / 256) % 256, palIdx = Math.floor(k1 / 65536);
            const aoBits = aoBits0 === 255 ? 255 : aoBits0; // 255 = border skirt face: no AO darkening
            const aos = aoBits === 255 ? [3, 3, 3, 3] : [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
            const base = [0, 0, 0];
            base[d] = sl + (dir > 0 ? 1 : 0); base[u] = i; base[v] = j;
            const du = [0, 0, 0], dv = [0, 0, 0];
            du[u] = w; dv[v] = h;
            const corners = [
              base,
              [base[0] + du[0], base[1] + du[1], base[2] + du[2]],
              [base[0] + du[0] + dv[0], base[1] + du[1] + dv[1], base[2] + du[2] + dv[2]],
              [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]],
            ];
            if (vcount + 4 > cap) grow();
            for (let c = 0; c < 4; c++) {
              const cc = corners[c], v3 = (vcount + c) * 3, v4 = (vcount + c) * 4;
              pos[v3] = cc[0] * s + x0; pos[v3 + 1] = cc[2] * s; pos[v3 + 2] = cc[1] * s + y0; // metres, three.js axes
              attr[v4] = normalIdx; attr[v4 + 1] = aos[c]; attr[v4 + 2] = gm; attr[v4 + 3] = s;
              pal[vcount + c] = palIdx;
            }
            const b = vcount;
            const flip = aos[0] + aos[2] < aos[1] + aos[3];
            const ccw = dir > 0;
            const tri = !flip ? (ccw ? [0, 3, 1, 1, 3, 2] : [0, 1, 3, 1, 2, 3]) : (ccw ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
            for (let t = 0; t < 6; t++) idx[ni + t] = b + tri[t];
            ni += 6;
            vcount += 4;
            i += w;
          }
        }
      }
    }
  }
  const P = pos.slice(0, vcount * 3), A = attr.slice(0, vcount * 4), L = pal.slice(0, vcount);
  const I = vcount > 65535 ? idx.slice(0, ni) : Uint16Array.from(idx.subarray(0, ni));
  return { pos: P, attr: A, pal: L, idx: I, zmax: zmax * s };
}
