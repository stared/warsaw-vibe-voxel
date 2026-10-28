"""Where the moving things meet the voxels: every car lane, tram track and footpath of traffic.json walked every metre
at the height the viewer gives it (linear between path points), checked against the finished volume.

  sunk:  a solid voxel (not leaves, lamps, poles, trunks, cars) in the body, 0.3-1.5 m above the path -- the vehicle
         drives into a deck, a wall, a kerb step
  hover: nothing solid in the 2 m below the path -- it drives over a hole, or above a deck that is drawn lower

usage: uv run python scripts/surface_check.py [vol.npy] [--traffic=traffic.json]
-> data/debug/surface_check.json: clusters (10 m) of flagged metres per network, worst first
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

M_LEAF, M_LAMP, M_CAR = 3, 5, 11


def walk(p, offs=(0.0,)):
    """(x, y, z) every metre along a path, z linear between its points, at each offset to the right"""
    for (x0, y0, z0), (x1, y1, z1) in zip(p, p[1:]):
        L = np.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L))
        tx, ty = (x1 - x0) / max(L, 1e-6), (y1 - y0) / max(L, 1e-6)
        for k in range(n):
            f = k / n
            for o in offs:
                yield x0 + (x1 - x0) * f - ty * o, y0 + (y1 - y0) * f + tx * o, z0 + (z1 - z0) * f


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    vol = np.load(args[0] if args else "data/cache/final_vol.npy", mmap_mode="r")
    meta = json.load(open("web/public/data/meta.json"))
    tr = json.load(open(next((a[10:] for a in sys.argv if a.startswith("--traffic=")), "web/public/data/traffic.json")))
    pal = meta["palette"]
    solid = np.array([i != 0 and e[3] not in (M_LEAF, M_LAMP, M_CAR) for i, e in enumerate(pal)] + [True] * 64)
    H, D, W = vol.shape
    lanes = lambda r: [r["o0"] + 3.0 * i for i in range(r["lanes"])]  # the lane centres (web/src/sim/life.ts)
    pts = {"road": [q for r in tr["roads"] for q in walk(r["p"], lanes(r))],
           "tram": [q for t in tr["trams"] for q in walk(t["p"])],
           "ped": [q for p in tr["peds"] for q in walk(p["p"], (-0.85, 0.85) if "side" not in p else (0.85 * p["side"],))]}
    pts = {k: np.array(v, np.float32) for k, v in pts.items()}
    out = {}
    for k, P in pts.items():
        c = np.clip(P[:, 0].astype(int), 0, W - 1)
        r = np.clip(P[:, 1].astype(int), 0, D - 1)
        z = P[:, 2]
        order = np.argsort(r)
        col = np.zeros((len(P), 8), bool)  # solid at floor(z) - 3 ... floor(z) + 4
        zf = np.floor(z + 0.3).astype(int)
        for lo in range(0, len(order), 200000):
            idx = order[lo:lo + 200000]
            rr, cc = r[idx], c[idx]
            r0, r1 = rr.min(), rr.max() + 1
            block = np.asarray(vol[:, r0:r1, :])
            for j, dz in enumerate(range(-3, 5)):
                zz = np.clip(zf[idx] + dz, 0, H - 1)
                col[idx, j] = solid[block[zz, rr - r0, cc]]
        sunk = col[:, 3] | col[:, 4]
        hover = ~col[:, 2] & ~col[:, 1] & ~sunk
        res = {}
        for name, m in (("sunk", sunk), ("hover", hover)):
            cl = defaultdict(list)
            for x, y, zz in P[m]:
                cl[(int(x) // 10, int(y) // 10)].append((x, y, zz))
            res[name] = dict(metres=int(m.sum()), share=round(float(m.mean()), 4),
                             clusters=sorted(([round(float(np.mean([q[0] for q in v])), 1), round(float(np.mean([q[1] for q in v])), 1),
                                               round(float(np.mean([q[2] for q in v])), 1), len(v)] for v in cl.values()), key=lambda a: -a[3]))
        out[k] = dict(metres=len(P), **res)
        print(f"{k}: {len(P)} m walked, sunk {res['sunk']['metres']} m in {len(res['sunk']['clusters'])} spots, "
              f"hover {res['hover']['metres']} m in {len(res['hover']['clusters'])} spots")
        for name in ("sunk", "hover"):
            print("  ", name, "worst:", res[name]["clusters"][:8])
    Path("data/debug").mkdir(parents=True, exist_ok=True)
    json.dump(out, open("data/debug/surface_check.json", "w"))


if __name__ == "__main__":
    main()
