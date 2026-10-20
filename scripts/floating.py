"""Everything in the air: solid voxels not connected to the ground.

The ground fills z < g everywhere (a 3 m slab under the lowest point), so the ground is one component touching z = 0;
a voxel is supported if a chain of face-sharing (6-connected) solid voxels leads from it down to that slab -- which is
what walking and falling in the viewer need (a crown on a corner-touching trunk is not standing). Components are
labelled per block of rows and joined across block edges with a union-find, so no component is cut by a block.

usage: uv run python scripts/floating.py [vol.npy g.npy] [--conn 6|26]
-> data/debug/floating_all.json: every unsupported component (size, bbox, height above the ground, materials)
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy import ndimage


class UF:
    def __init__(self):
        self.p = {}

    def find(self, a):
        p = self.p
        p.setdefault(a, a)
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


def components(vol, conn=6, B=192, lut=None):
    """yields per block: (r0, labels, n) after a first pass that unions labels across blocks; returns the union-find
    and the set of global roots touching z = 0"""
    H, Dd, Ww = vol.shape
    st = ndimage.generate_binary_structure(3, 1 if conn == 6 else 3)
    uf = UF()
    grounded = set()
    prev_last = None  # (labels of the previous block's last row, its offset)
    offs = []
    off = 0
    for r0 in range(0, Dd, B):
        r1 = min(Dd, r0 + B)
        occ = np.asarray(vol[:, r0:r1, :])
        occ = lut[occ] if lut is not None else occ != 0  # lut: which palette ids count as solid
        lab, n = ndimage.label(occ, st)
        lab = lab.astype(np.int64)
        lab[lab > 0] += off
        for v in np.unique(lab[0][lab[0] > 0]):
            grounded.add(int(v))
        first = lab[:, 0, :]
        if prev_last is not None:
            if conn == 6:
                m = (first > 0) & (prev_last > 0)
                pairs = set(zip(first[m].tolist(), prev_last[m].tolist()))
            else:  # 26: neighbours in z and x too
                pairs = set()
                for dz in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        a = np.roll(np.roll(prev_last, dz, 0), dx, 1)
                        m = (first > 0) & (a > 0)
                        pairs |= set(zip(first[m].tolist(), a[m].tolist()))
            for a, b in pairs:
                uf.union(int(a), int(b))
        prev_last = lab[:, -1, :].copy()
        offs.append((r0, off, n))
        off += n
        print(f"  block rows {r0}-{r1}: {n} components", flush=True)
    groots = {uf.find(v) for v in grounded}
    return uf, groots, offs, st


def scan(vol, g, pal, conn=6, B=192, lut=None):
    uf, groots, offs, st = components(vol, conn, B, lut)
    H, Dd, Ww = vol.shape
    comp = defaultdict(lambda: dict(n=0, r0=1 << 30, r1=-1, c0=1 << 30, c1=-1, z0=1 << 30, z1=-1, hmin=1 << 30, mats=Counter()))
    for r0, off, n in offs:
        r1 = min(Dd, r0 + B)
        sub = np.asarray(vol[:, r0:r1, :])
        lab, n2 = ndimage.label(lut[sub] if lut is not None else sub != 0, st)
        assert n2 == n
        lab = lab.astype(np.int64)
        lab[lab > 0] += off
        ids = np.unique(lab[lab > 0])
        roots = np.array([uf.find(int(v)) for v in ids])
        float_ids = ids[~np.isin(roots, list(groots))]
        if not len(float_ids):
            continue
        sel = np.isin(lab, float_ids)
        zz, rr, cc = np.nonzero(sel)
        L = lab[zz, rr, cc]
        R = np.array([uf.find(int(v)) for v in np.unique(L)])
        rootof = dict(zip(np.unique(L).tolist(), R.tolist()))
        Lr = np.vectorize(rootof.get)(L)
        hz = zz - g[rr + r0, cc]
        v = sub[zz, rr, cc]
        order = np.argsort(Lr)
        Lr, zz, rr, cc, hz, v = Lr[order], zz[order], rr[order], cc[order], hz[order], v[order]
        cuts = np.nonzero(np.diff(Lr))[0] + 1
        for a, b in zip(np.r_[0, cuts], np.r_[cuts, len(Lr)]):
            c = comp[int(Lr[a])]
            c["n"] += int(b - a)
            c["r0"] = min(c["r0"], int(rr[a:b].min() + r0)); c["r1"] = max(c["r1"], int(rr[a:b].max() + r0))
            c["c0"] = min(c["c0"], int(cc[a:b].min())); c["c1"] = max(c["c1"], int(cc[a:b].max()))
            c["z0"] = min(c["z0"], int(zz[a:b].min())); c["z1"] = max(c["z1"], int(zz[a:b].max()))
            c["hmin"] = min(c["hmin"], int(hz[a:b].min()))
            for k, m in Counter(v[a:b].tolist()).items():
                c["mats"][k] += m
    out = []
    for k, c in comp.items():
        mats = c.pop("mats")
        c["id"] = k
        c["mat"] = Counter()
        for pid, m in mats.items():
            c["mat"][int(pal[pid][3])] += m
        c["top_ids"] = [[int(p), int(m)] for p, m in mats.most_common(4)]
        c["mat"] = {int(a): int(b) for a, b in c["mat"].items()}
        out.append(c)
    return sorted(out, key=lambda c: -c["n"])


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    conn = 26 if "--conn" in sys.argv and sys.argv[sys.argv.index("--conn") + 1] == "26" else 6
    vp, gp = (args + ["data/cache/final_vol.npy", "data/cache/final_g.npy"])[:2] if len(args) >= 2 else ("data/cache/final_vol.npy", "data/cache/final_g.npy")
    vol = np.load(vp, mmap_mode="r")
    g = np.load(gp)
    meta = json.load(open("web/public/data/meta.json"))
    pal = meta["palette"]
    lut = None
    tag = ""
    if "--noleaf" in sys.argv:  # leaves do not hold anything up: buildings and posts must stand on their own
        lut = np.array([e[3] != 3 for e in pal] + [False] * 64)
        lut[0] = False
        tag = "_noleaf"
    res = scan(vol, g, pal, conn, lut=lut)
    Path("data/debug").mkdir(parents=True, exist_ok=True)
    json.dump(res, open(f"data/debug/floating_all_{conn}{tag}.json", "w"))
    MN = {0: "solid", 1: "wall", 2: "glass", 3: "leaf", 4: "water", 5: "lamp", 6: "metal", 7: "pkin", 8: "grass", 9: "mark",
          10: "soil", 11: "car", 12: "roof", 13: "concrete", 14: "clock", 15: "bronze", 16: "sign"}
    tot = Counter()
    for c in res:
        for m, k in c["mat"].items():
            tot[MN.get(m, m)] += k
    print(len(res), "floating components,", sum(c["n"] for c in res), "voxels; by material:", dict(tot.most_common()))
    for c in res[:40]:
        print(c["n"], "rows", c["r0"], c["r1"], "cols", c["c0"], c["c1"], "z", c["z0"], c["z1"], "h>=", c["hmin"],
              {MN.get(m, m): k for m, k in c["mat"].items()})
