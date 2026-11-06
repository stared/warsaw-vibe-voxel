"""Streamable voxel tiles for the viewer (web/src/stream.ts).

Level 1 is the city at 1 m; level 8 (cells of 8 x 8 x 8 m) is the clay standing in where the viewer's budget leaves
the city out (web/src/city.ts). Every node holds N x N cells (N = 128, so a node spans 128 * s metres) plus a 1-cell
apron on each side for face culling and AO at the node edge.

Node file  tiles/{s}/{nx}_{ny}.bin, gzip of:
  counts  uint16[(N+2)^2]   runs per column (apron included, row-major, row = south)
  ground  uint8 [(N+2)^2]   ground level in metres (z of the first free voxel at level 1), for the facade shader
  runs    uint16[3 * sum]   (z0, len, palette) per run, z in cells of the level, bottom -> top

Foliage at level 1 is its own file, loaded after every building (web/src/city.ts): tiles/1f/{nx}_{ny}.bin, the same
format, holding only trees, trunks and grass (`fol_ids`, `grass_ids`); in tiles/1/ trees and trunks are left out and
grass is bare earth (`bare_id`), the surface the grass is then drawn on.

Level 8: a cell is solid when at least a quarter of its block is; its colour is the topmost voxel in the block, so
roofs stay roofs and the street stays paving when seen from above. Clock faces colour their whole block.
"""
import gzip

import numpy as np

N = 128
LEVELS = (1, 8)


def downsample(vol, s, face_ids=()):
    H, D, W = vol.shape
    Hs, Ds, Ws = -(-H // s), -(-D // s), -(-W // s)
    out = np.zeros((Hs, Ds, Ws), np.uint16)
    need = s ** 3 // 4
    band = max(1, 256 // s)  # block rows per pass: bounded memory on the 4 x 3 km volume
    for rb in range(0, Ds, band):
        r0, r1 = rb * s, min((rb + band) * s, D)
        sub = vol[:, r0:r1, :]
        pad = ((0, Hs * s - H), (0, (-(r1 - r0)) % s), (0, Ws * s - W))
        sub = np.pad(sub, pad)
        hb, db, wb = sub.shape[0] // s, sub.shape[1] // s, sub.shape[2] // s
        blk = sub.reshape(hb, s, db, s, wb, s)
        occ = (blk != 0).sum((1, 3, 5), dtype=np.int32)
        # colour: the topmost non-empty voxel in the block (scan the s layers from the top)
        col = np.zeros((hb, db, wb), np.uint16)
        for dz in range(s - 1, -1, -1):
            layer = blk[:, dz]  # (hb, db, s, wb, s)
            for dy in range(s):
                for dx in range(s):
                    v = layer[:, :, dy, :, dx]
                    col = np.where((col == 0) & (v != 0), v, col)
        res = np.where(occ >= need, col, 0)
        # a thin surface (ground or roof in the block's bottom layer) is too sparse to keep its own block, which
        # left the block below showing what lies under it (brown soil along the plazas): that block wears it instead
        up = np.zeros_like(col)
        up[:-1] = np.where(res[1:] == 0, col[1:], 0)
        res = np.where((res != 0) & (up != 0), up, res)
        if len(face_ids):  # markings on a wall (the PKiN clock faces) colour the whole block, not just its top voxel
            fv = blk.max((1, 3, 5), where=np.isin(blk, face_ids), initial=0)
            res = np.where((res != 0) & (fv > 0), fv, res)
        out[:, rb:rb + db, :] = res
    return out


def column_runs(vol_win):
    """vol_win (H, R, C) -> counts (R*C,), runs (n, 3) bottom -> top, row-major columns."""
    H = vol_win.shape[0]
    cols = vol_win.reshape(H, -1).T
    n = cols.shape[0]
    b = np.zeros((n, H + 1), bool)
    b[:, 0] = True
    b[:, 1:H] = cols[:, 1:] != cols[:, :-1]
    b[:, H] = True
    fi = np.flatnonzero(b)
    ci, zi = fi // (H + 1), fi % (H + 1)
    same = ci[:-1] == ci[1:]
    s_ci, s_z0, s_z1 = ci[:-1][same], zi[:-1][same], zi[1:][same]
    val = cols[s_ci, s_z0]
    k = val != 0
    s_ci, s_z0, s_z1, val = s_ci[k], s_z0[k], s_z1[k], val[k]
    counts = np.bincount(s_ci, minlength=n)
    return counts.astype(np.uint16), np.stack([s_z0, s_z1 - s_z0, val], 1).astype(np.uint16)


def export(vol, g, out, note, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0):
    """vol (H, D, W) level-1 voxels, g (D, W) ground level -> node files; returns the manifest for meta.json."""
    D, W = g.shape
    info = dict(N=N, levels=[], bytes=0)
    for s in LEVELS:
        vs = vol if s == 1 else downsample(vol, s, np.array(sorted(face_ids), np.uint16))
        gs = g if s == 1 else g[::s, ::s]  # ground metres at the block's corner column (shader only)
        Hs, Ds, Ws = vs.shape
        nx, ny = -(-Ws // N), -(-Ds // N)
        (out / str(s)).mkdir(parents=True, exist_ok=True)
        split = s == 1 and len(fol_ids)
        if split:
            (out / "1f").mkdir(parents=True, exist_ok=True)
            is_fol = np.zeros(65536, bool); is_fol[list(fol_ids)] = True; is_fol[list(grass_ids)] = True
            is_grass = np.zeros(65536, bool); is_grass[list(grass_ids)] = True
        tot, nruns, ftot = 0, 0, 0
        for ty in range(ny):
            for tx in range(nx):
                r0, c0 = ty * N - 1, tx * N - 1
                win = np.zeros((Hs, N + 2, N + 2), np.uint16)
                gw = np.zeros((N + 2, N + 2), np.uint8)
                rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + N + 2, Ds), max(c0, 0), min(c0 + N + 2, Ws)
                if rr0 < rr1 and cc0 < cc1:
                    win[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = vs[:, rr0:rr1, cc0:cc1]
                    gw[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = np.clip(gs[rr0:rr1, cc0:cc1], 0, 255)
                top = int(np.nonzero(win.reshape(Hs, -1).any(1))[0].max()) + 1 if win.any() else 1
                win = win[:top]
                if split:
                    f = is_fol[win]
                    fol = np.where(f, win, 0).astype(np.uint16)
                    win = np.where(f, np.where(is_grass[win], bare_id, 0), win).astype(np.uint16)
                    fc, fr = column_runs(fol)
                    with gzip.GzipFile(out / "1f" / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                        fh.write(fc.tobytes() + gw.tobytes() + fr.tobytes())
                    ftot += (out / "1f" / f"{tx}_{ty}.bin").stat().st_size
                counts, runs = column_runs(win)
                blob = counts.tobytes() + gw.tobytes() + runs.tobytes()
                with gzip.GzipFile(out / str(s) / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:  # mtime 0: rebuilds of unchanged nodes stay byte-identical
                    fh.write(blob)
                tot += (out / str(s) / f"{tx}_{ty}.bin").stat().st_size
                nruns += len(runs)
        info["levels"].append(dict(s=s, nx=nx, ny=ny))
        info["bytes"] += tot
        note(f"tiles level {s}: {nx}x{ny} nodes, {nruns} runs, {tot / 2 ** 20:.1f} MB gz"
             + (f", foliage {ftot / 2 ** 20:.1f} MB gz" if split else ""))
        del vs
    return info


def export_region(vol, g, out, box, note, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0):
    """Rewrite only the nodes (every level) over box = (r0, r1, c0, c1) of the 1 m grid, from the same volume the
    full export would see (scripts/patch.py); each node is built from its own 1 m window, so the result matches
    export()."""
    H, D, W = vol.shape
    R0, R1, C0, C1 = box
    face = np.array(sorted(face_ids), np.uint16)
    fol = np.zeros(65536, bool); fol[list(fol_ids)] = True; fol[list(grass_ids)] = True
    grass = np.zeros(65536, bool); grass[list(grass_ids)] = True
    n = 0
    for s in LEVELS:
        span = N * s
        for ty in range(max(R0 - s, 0) // span, min(R1 + s, D - 1) // span + 1):
            for tx in range(max(C0 - s, 0) // span, min(C1 + s, W - 1) // span + 1):
                a, c = ty * span - s, tx * span - s  # 1 m window: the node and its one-cell apron, aligned to s
                w1 = np.zeros((H, span + 2 * s, span + 2 * s), np.uint16)
                g1 = np.zeros((span + 2 * s, span + 2 * s), g.dtype)
                ra, rb, ca, cb = max(a, 0), min(a + span + 2 * s, D), max(c, 0), min(c + span + 2 * s, W)
                w1[:, ra - a:rb - a, ca - c:cb - c] = vol[:, ra:rb, ca:cb]
                g1[ra - a:rb - a, ca - c:cb - c] = g[ra:rb, ca:cb]
                win = w1 if s == 1 else downsample(w1, s, face)
                gw = np.clip(g1[::s, ::s], 0, 255).astype(np.uint8)
                Hs = win.shape[0]
                top = int(np.nonzero(win.reshape(Hs, -1).any(1))[0].max()) + 1 if win.any() else 1
                win = win[:top]
                if s == 1 and len(fol_ids):
                    f = fol[win]
                    fv = np.where(f, win, 0).astype(np.uint16)
                    win = np.where(f, np.where(grass[win], bare_id, 0), win).astype(np.uint16)
                    fc, fr = column_runs(fv)
                    with gzip.GzipFile(out / "1f" / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                        fh.write(fc.tobytes() + gw.tobytes() + fr.tobytes())
                counts, runs = column_runs(win)
                blob = counts.tobytes() + gw.tobytes() + runs.tobytes()
                with gzip.GzipFile(out / str(s) / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                    fh.write(blob)
                n += 1
    note(f"tiles: {n} nodes rewritten over rows {R0}-{R1}, cols {C0}-{C1}")
