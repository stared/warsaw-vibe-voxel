"""Floating debris: small clumps of voxels hanging in the air (voxelize.py, patch.py)."""
import json
from pathlib import Path

import numpy as np
from scipy import ndimage


def drop_debris(vol, g, keep_ids, note, max_size=100, B=256, M=24, box=None):  # the stadium hub (135) stays
    """Delete small clumps of voxels that touch neither the ground nor anything that does (LiDAR returns off cranes,
    wires and canopy frames, leftovers of part cuts): 3D components (26-connected), per block with a margin; a clump is
    debris if it is smaller than max_size voxels, its lowest voxel is 2 m or more above the ground there, and it does
    not reach the block's margin."""
    Hh, Dd, Ww = vol.shape
    n = nv = 0
    big = []
    st = ndimage.generate_binary_structure(3, 3)  # 26-connected: diagonal cables and wires are chains of corner-touching voxels
    R0, R1, C0, C1 = box or (0, Dd, 0, Ww)  # box: only the blocks over these rows / columns (patch.py)
    for r0 in range(R0 - R0 % B, R1, B):
        for c0 in range(C0 - C0 % B, C1, B):
            ra, rb, ca, cb = max(0, r0 - M), min(Dd, r0 + B + M), max(0, c0 - M), min(Ww, c0 + B + M)
            sub = vol[:, ra:rb, ca:cb]
            occ = sub != 0
            gg = g[ra:rb, ca:cb]
            zz = np.arange(Hh)[:, None, None]
            occ &= zz >= gg[None] - 1  # the ground itself is one big component; leave it out
            occ &= ~np.isin(sub, keep_ids)  # trees: crowns hang on trunks drawn apart, small crowns are real
            lab, k = ndimage.label(occ, st)
            if k == 0:
                continue
            sizes = ndimage.sum(occ, lab, range(1, k + 1))
            small = np.nonzero(sizes < 4000)[0] + 1
            if not len(small):
                continue
            objs = ndimage.find_objects(lab)
            for lid in small:
                sl = objs[lid - 1]
                zs, rs, cs = sl
                if rs.start < (r0 - ra) or rs.stop > (r0 - ra) + B or cs.start < (c0 - ca) or cs.stop > (c0 - ca) + B:
                    continue  # touches the margin: judged by the block that owns it
                m = lab[sl] == lid
                zi, ri, ci = np.nonzero(m)
                zi, ri, ci = zi + zs.start, ri + rs.start, ci + cs.start
                if (zi - gg[ri, ci]).min() < 2:
                    continue  # stands on the ground (bollards, benches, lamps)
                if len(zi) >= max_size:  # bigger floating clumps: listed for review (data/debug/floating.json)
                    big.append(dict(x=int(ci.mean() + ca), y=int(ri.mean() + ra), z=int((zi - gg[ri, ci]).min()),
                                    n=int(len(zi)), h=int(zi.max() - zi.min() + 1)))
                    continue
                sub[zi, ri, ci] = 0
                n += 1; nv += len(zi)
    note(f"floating debris removed: {n} clumps, {nv} voxels; {len(big)} bigger floating clumps listed")
    if box is None:
        Path("data/debug").mkdir(parents=True, exist_ok=True)
        json.dump(sorted(big, key=lambda b: -b["n"]), open("data/debug/floating.json", "w"))


def support_floating(vol, g, pal, bkind, note, trunk_id, post_id, trunk_ok=None, B=192, _noleaf=True):
    """Everything still hanging in the air at the end of the build (scripts/floating.py's whole-city scan, 6-connected:
    walking and falling need face contact) gets put on the ground or removed:
    - a piece under 12 voxels: removed (a LiDAR return off a wire, a lone sign voxel); a spike (<= 4 cells across,
      not leaves): removed
    - a crown fragment (leaves): under 60 voxels removed (an overhanging twig the LiDAR caught), bigger ones get a
      trunk from their lowest leaf straight down to the ground
    - a building piece: under its footprint, inside an OSM building outline (bkind 1), the walls carry on down to the
      ground in the colour of its lowest voxel; under a roof-only structure (bkind 2: building=roof, carport, canopy) or
      outside any outline, posts every 6 m and at its four extreme cells
    - anything else (cable stays, cranes, the stadium's suspended hub): left, listed in data/debug/floating_left.json
    bkind: (D, W) uint8, 1 = inside a building outline, 2 = under a roof-only structure."""
    import floating
    H, Dd, Ww = vol.shape
    mat = np.array([e[3] for e in pal.entries] + [0] * 64)
    solid = None
    if _noleaf:
        # first round: leaves hold nothing up -- a roof, a footbridge or a deck end that only touches a tree crown gets
        # its own walls or posts; only building pieces 2 m or more up are handled here, the rest in the second round
        # (a lamp on a hedge voxel or a trunk on scrub ground floats in this view but stands)
        solid = np.array([e[3] != 3 for e in pal.entries] + [False] * 64)
        solid[0] = False
    uf, groots, offs, st = floating.components(vol, 6, B, solid)
    groots = np.array(sorted(groots))
    stats = {}
    # pass 1: per floating component: size, material classes, the lowest voxel above the ground
    blocks = []
    for r0, off, n in offs:
        r1 = min(Dd, r0 + B)
        sub = vol[:, r0:r1, :]
        lab, n2 = ndimage.label(solid[sub] if solid is not None else sub != 0, st)
        ids = np.arange(1, n2 + 1) + off
        roots = np.array([uf.find(int(v)) for v in ids])
        fl = ~np.isin(roots, groots)
        if not fl.any():
            blocks.append(None)
            continue
        lut = np.zeros(n2 + 1, np.int32)
        lut[1:] = np.where(fl, roots, 0)
        L = lut[lab]
        zz, rr, cc = np.nonzero(L)
        R = L[zz, rr, cc]
        v = sub[zz, rr, cc]
        hz = zz - g[rr + r0, cc]
        blocks.append((r0, zz, rr, cc, R, v))
        order = np.argsort(R, kind="stable")
        Rs = R[order]
        cuts = np.r_[0, np.nonzero(np.diff(Rs))[0] + 1, len(Rs)]
        for a, b in zip(cuts[:-1], cuts[1:]):
            k = int(Rs[a])
            idx = order[a:b]
            m = mat[v[idx]]
            s = stats.setdefault(k, dict(n=0, leaf=0, bld=0, low=(1 << 30, 0, 0), cells=set(), hmin=1 << 30))
            s["n"] += len(idx)
            s["hmin"] = min(s["hmin"], int(hz[idx].min()))
            if len(s["cells"]) <= 8:
                s["cells"] |= set(((rr[idx] + r0) * Ww + cc[idx]).tolist()[:64])
            s["leaf"] += int(np.isin(m, (3,)).sum() + (v[idx] == trunk_id).sum())
            # building stuff only: walls, glass, roofs, concrete, PKiN stone, cladding, signs -- not plain solids or
            # metal (cable stays, trunks, fences, masts), which must never be propped up on posts
            s["bld"] += int(np.isin(m, (1, 2, 7, 12, 13, 15, 16, 18, 19, 20, 21)).sum())
            # the trunk goes under the lowest leaf over soft ground (not into a road or a path), if there is any
            okv = trunk_ok[rr[idx] + r0, cc[idx]] if trunk_ok is not None else np.ones(len(idx), bool)
            pen = hz[idx] + np.where(okv, 0, 1000)
            j = idx[np.argmin(pen)]
            hj = int(pen.min())
            if hj < s["low"][0]:
                s["low"] = (hj, int(rr[j] + r0), int(cc[j]))
    cls = {}
    for k, s in stats.items():
        if _noleaf:
            hmin = min(s["low"][0] % 1000, s["hmin"])
            cls[k] = "build" if (s["bld"] >= 0.5 * s["n"] and s["n"] >= 12 and hmin >= 2) else "skip"
            continue
        if s["n"] < 12:
            cls[k] = "drop"
        elif len(s["cells"]) <= 4 and s["leaf"] < 0.5 * s["n"]:
            cls[k] = "drop"  # a spike: a column or two of LiDAR wall-edge returns standing over a lower roof"
        elif s["leaf"] >= 0.5 * s["n"]:
            cls[k] = "drop" if s["n"] < 60 or (s["low"][0] >= 1000 and s["n"] < 400) else "trunk"
        elif s["bld"] >= 0.5 * s["n"]:
            cls[k] = "build"
        else:
            cls[k] = "left"
    # pass 2: apply
    n_drop = n_fill = n_post = 0
    for blk in blocks:
        if blk is None:
            continue
        r0, zz, rr, cc, R, v = blk
        c_ = np.array([cls[int(k)] for k in R]) if len(R) else np.array([])
        d = c_ == "drop"
        vol[zz[d], rr[d] + r0, cc[d]] = 0
        n_drop += int(d.sum())
        b = c_ == "build"
        if b.any():
            zb, rb, cb, Rb, vb = zz[b], rr[b] + r0, cc[b], R[b], v[b]
            # lowest voxel of each component in each column
            key = (Rb * Dd + rb) * Ww + cb
            o = np.lexsort((zb, key))
            first = np.r_[True, np.diff(key[o]) != 0]
            sel = o[first]
            for k in np.unique(Rb[sel]):
                m = sel[Rb[sel] == k]
                rows, cols, zs, vs = rb[m], cb[m], zb[m], vb[m]
                kind = bkind[rows, cols]
                inside = kind == 1
                for r_, c_2, z_, v_ in zip(rows[inside], cols[inside], zs[inside], vs[inside]):
                    gz = int(g[r_, c_2])
                    col = vol[gz:z_, r_, c_2]
                    col[col == 0] = v_
                    n_fill += 1
                out = ~inside
                if out.any():
                    ro, co, zo = rows[out], cols[out], zs[out]
                    pick = ((ro % 6) == 0) & ((co % 6) == 0)
                    for e in (np.argmin(ro), np.argmax(ro), np.argmin(co), np.argmax(co)):
                        pick[e] = True
                    for r_, c_2, z_ in zip(ro[pick], co[pick], zo[pick]):
                        gz = int(g[r_, c_2])
                        col = vol[gz:z_, r_, c_2]
                        col[col == 0] = post_id
                        n_post += 1
    n_trunk = 0
    for k, c in cls.items():
        if c == "trunk":
            h, r_, c_2 = stats[k]["low"]
            h %= 1000
            gz = int(g[r_, c_2])
            col = vol[gz:gz + h, r_, c_2]
            col[col == 0] = trunk_id
            n_trunk += 1
    left = [dict(id=int(k), n=stats[k]["n"], leaf=stats[k]["leaf"], bld=stats[k]["bld"], low=stats[k]["low"]) for k, c in cls.items() if c == "left"]
    if _noleaf:
        note(f"floating, leaves not holding: {sum(c == 'build' for c in cls.values())} building pieces resting only on "
             f"crowns: {n_fill} columns filled down, {n_post} posts")
        return support_floating(vol, g, pal, bkind, note, trunk_id, post_id, trunk_ok, B, _noleaf=False)
    note(f"floating: {len(stats)} components; removed {n_drop} voxels; {n_trunk} crowns given a trunk; building pieces: "
         f"{n_fill} columns filled down inside outlines, {n_post} posts; {len(left)} left (listed)")
    Path("data/debug").mkdir(parents=True, exist_ok=True)
    json.dump(sorted(left, key=lambda x: -x["n"]), open("data/debug/floating_left.json", "w"))
