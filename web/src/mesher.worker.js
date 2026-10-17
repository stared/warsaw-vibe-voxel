// Fetch + unzip + greedy-mesh one quadtree node (scripts/tiles.py) with baked ambient occlusion.
// Data coords: x = column (east), y = row (south), z = up. Output positions in three.js coords (x, z, y), metres.
// A node holds N x N cells of s metres plus a 1-cell apron. Side faces on the node border are always emitted
// (the neighbour may be drawn at another level of detail, so culling against our own apron could leave cracks).

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'node') return;
  try {
    const t0 = performance.now();
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`${res.status} ${m.url}`);
    const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const n2 = (m.N + 2) * (m.N + 2);
    const counts = new Uint16Array(buf, 0, n2);
    const ground = new Uint8Array(buf, n2 * 2, n2);
    let nr = 0;
    for (let i = 0; i < n2; i++) nr += counts[i];
    const runs = new Uint16Array(buf.slice(n2 * 3, n2 * 3 + nr * 6)); // (N+2)^2 is even, so the runs start 2-byte aligned
    const detail = new Uint16Array(buf.slice(n2 * 3 + nr * 6)); // coarse levels: thin structures as 1 m voxels (x, y, z, palette)
    if (m.dataOnly) { // the node is already meshed: only its column data was asked for
      const data = { counts: counts.slice(), ground: ground.slice(), runs };
      self.postMessage({ type: 'node', key: m.key, dataOnly: true, data }, [data.counts.buffer, data.ground.buffer, runs.buffer]);
      return;
    }
    // a foliage tile (tiles/1f) is meshed over its base tile: the base only hides faces, it draws nothing here
    let under = null;
    if (m.under) {
      const ub = await new Response((await fetch(m.under)).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const uc = new Uint16Array(ub, 0, n2); let un = 0;
      for (let i = 0; i < n2; i++) un += uc[i];
      under = { counts: uc, runs: new Uint16Array(ub.slice(n2 * 3, n2 * 3 + un * 6)) };
    }
    const t1 = performance.now();
    const out = meshNode(m.N, m.s, m.x0, m.y0, counts, ground, runs, detail, m.bld, under);
    out.ms = [Math.round(t1 - t0), Math.round(performance.now() - t1)]; // fetch+unzip, mesh
    const transfer = [out.pos.buffer, out.attr.buffer, out.pal.buffer, out.idx.buffer];
    if (out.bld) transfer.push(out.bld.buffer);
    let data = null;
    if (m.keep) { // the column data stays with the viewer for collisions / ray casts
      data = { counts: counts.slice(), ground: ground.slice(), runs };
      transfer.push(data.counts.buffer, data.ground.buffer, runs.buffer);
    }
    self.postMessage({ type: 'node', key: m.key, ...out, data }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', key: m.key, dataOnly: m.dataOnly, error: String(err) });
  }
};

// bldIds (optional, N x N, 1 m nodes): which building each column belongs to (scripts/zones.py, 0: none). Faces never
// merge across two buildings, and every vertex carries its face's building, so the viewer can show whole buildings.
function meshNode(N, s, x0, y0, counts, ground, runs, detail, bldIds, under) {
  const S = N + 2;
  const offsets = new Uint32Array(S * S + 1);
  for (let i = 0; i < S * S; i++) offsets[i + 1] = offsets[i] + counts[i];
  let zmax = 0;
  for (let c = 0; c < S * S; c++) {
    const n = counts[c];
    if (n) { const r = (offsets[c] + n - 1) * 3, top = runs[r] + runs[r + 1]; if (top > zmax) zmax = top; }
  }
  let uoff = null;
  if (under) {
    uoff = new Uint32Array(S * S + 1);
    for (let i = 0; i < S * S; i++) uoff[i + 1] = uoff[i] + under.counts[i];
    for (let c = 0; c < S * S; c++) { const n = under.counts[c]; if (n) { const r = (uoff[c] + n - 1) * 3, top = under.runs[r] + under.runs[r + 1]; if (top > zmax) zmax = top; } }
  }
  const sx = S, sy = S, sz = zmax + 2;
  const vol = new Uint16Array(sx * sy * sz);
  const SOLID_BELOW = 65535;
  const OCC = 65534; // the base tile under a foliage tile: solid for culling and AO, never meshed
  if (under) for (let c = 0; c < S * S; c++)
    for (let k = uoff[c], e = uoff[c] + under.counts[c]; k < e; k++) {
      const z0 = under.runs[k * 3], len = under.runs[k * 3 + 1];
      for (let z = z0; z < z0 + len; z++) vol[c + sx * sy * (z + 1)] = OCC;
    }
  for (let c = 0; c < S * S; c++) {
    vol[c] = SOLID_BELOW; // z = -1 counts as solid so the slab bottom is never meshed
    for (let k = offsets[c], e = offsets[c] + counts[c]; k < e; k++) {
      const z0 = runs[k * 3], len = runs[k * 3 + 1], v = runs[k * 3 + 2];
      for (let z = z0; z < z0 + len; z++) vol[c + sx * sy * (z + 1)] = v;
    }
  }
  const at = (x, y, z) => vol[x + sx * (y + sy * z)];
  const bidAt = (x, y) => (bldIds ? bldIds[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))] : 0); // cell coords in the node
  // growable typed output (plain JS arrays cost 8 bytes per number and churn the worker's heap)
  let cap = 1 << 14, pos = new Int16Array(cap * 3), attr = new Uint8Array(cap * 4), pal = new Uint16Array(cap), idx = new Uint32Array(cap * 1.5), bv = new Uint16Array(cap);
  let np = 0, ni = 0;
  const grow = () => {
    cap *= 2;
    const p2 = new Int16Array(cap * 3); p2.set(pos); pos = p2;
    const a2 = new Uint8Array(cap * 4); a2.set(attr); attr = a2;
    const l2 = new Uint16Array(cap); l2.set(pal); pal = l2;
    const i2 = new Uint32Array(cap * 1.5); i2.set(idx); idx = i2;
    const b2 = new Uint16Array(cap); b2.set(bv); bv = b2;
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
            if (a !== 0 && a !== SOLID_BELOW && a !== OCC) {
              const nx = p[0] + 1 + q[0] * dir, ny = p[1] + 1 + q[1] * dir, nz = p[2] + 1 + q[2] * dir;
              const nb = at(nx, ny, nz);
              if (nb === 0 || (border && nb !== SOLID_BELOW && nb !== OCC)) {
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
                key = (((a * 256 + aob) * 256 + gm) * 16384 + bidAt(p[0], p[1])) + 1; // < 2^53: palette < 4096, ids < 16384
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
            const k0 = key - 1, bid = k0 % 16384, k1 = Math.floor(k0 / 16384);
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
              pal[vcount + c] = palIdx; bv[vcount + c] = bid;
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
  // thin structures at true size: vertical runs of one colour become boxes (a spire is 4 tall quads, not 4 per
  // metre); faces against another detail voxel are culled, no AO (they are poles and lines)
  if (detail.length) {
    const key = (x, y, z) => (z * 2048 + y) * 2048 + x;
    const have = new Set(), order = [];
    for (let k = 0; k < detail.length; k += 4) { have.add(key(detail[k], detail[k + 1], detail[k + 2])); order.push(k); }
    order.sort((a, b) => detail[a] - detail[b] || detail[a + 1] - detail[b + 1] || detail[a + 2] - detail[b + 2]);
    const quad = (d, dir, base, w, h, palIdx, gm, bid) => { // w along axis (d+1)%3, h along (d+2)%3
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const corners = [base.slice(), base.slice(), base.slice(), base.slice()];
      corners[1][u] += w; corners[2][u] += w; corners[2][v] += h; corners[3][v] += h;
      if (vcount + 4 > cap) grow();
      for (let c = 0; c < 4; c++) {
        const cc = corners[c], v3 = (vcount + c) * 3, v4 = (vcount + c) * 4;
        pos[v3] = cc[0] + x0; pos[v3 + 1] = cc[2]; pos[v3 + 2] = cc[1] + y0;
        attr[v4] = d * 2 + (dir > 0 ? 1 : 0); attr[v4 + 1] = 3; attr[v4 + 2] = gm; attr[v4 + 3] = 1;
        pal[vcount + c] = palIdx; bv[vcount + c] = bid;
      }
      const tri = dir > 0 ? [0, 3, 1, 1, 3, 2] : [0, 1, 3, 1, 2, 3];
      for (let t = 0; t < 6; t++) idx[ni + t] = vcount + tri[t];
      ni += 6; vcount += 4;
    };
    for (let i = 0; i < order.length;) {
      const k = order[i], x = detail[k], y = detail[k + 1], z0 = detail[k + 2], p = detail[k + 3];
      let j = i + 1;
      while (j < order.length && detail[order[j]] === x && detail[order[j] + 1] === y && detail[order[j] + 2] === z0 + (j - i) && detail[order[j] + 3] === p) j++;
      const h = j - i; i = j;
      const gm = ground[(Math.floor(x / s) + 1) + S * (Math.floor(y / s) + 1)], bid = s === 1 ? bidAt(x, y) : 0;
      // sides: the whole run, unless a neighbouring column holds detail all along it
      for (const [dx, dy, d, dir] of [[-1, 0, 0, -1], [1, 0, 0, 1], [0, -1, 1, -1], [0, 1, 1, 1]]) {
        let covered = true;
        for (let z = z0; z < z0 + h && covered; z++) covered = have.has(key(x + dx, y + dy, z));
        if (covered) continue;
        const base = [x + (dir > 0 && d === 0 ? 1 : 0), y + (dir > 0 && d === 1 ? 1 : 0), z0];
        if (d === 0) quad(0, dir, base, 1, h, p, gm, bid); // x faces: u = y, v = z
        else quad(1, dir, base, h, 1, p, gm, bid);         // y faces: u = z, v = x
      }
      if (!have.has(key(x, y, z0 - 1))) quad(2, -1, [x, y, z0], 1, 1, p, gm, bid);
      if (!have.has(key(x, y, z0 + h))) quad(2, 1, [x, y, z0 + h], 1, 1, p, gm, bid);
    }
  }
  const P = pos.slice(0, vcount * 3), A = attr.slice(0, vcount * 4), L = pal.slice(0, vcount);
  const I = vcount > 65535 ? idx.slice(0, ni) : Uint16Array.from(idx.subarray(0, ni));
  return { pos: P, attr: A, pal: L, idx: I, zmax: zmax * s, bld: bldIds ? bv.slice(0, vcount) : null };
}
