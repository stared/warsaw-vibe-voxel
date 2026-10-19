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
