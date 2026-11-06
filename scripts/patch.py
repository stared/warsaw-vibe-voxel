"""Fast loop for landmark work: re-run the curated landmark details on the volume cached by a full build
(LMCACHE=1 uv run python scripts/voxelize.py) and rewrite only the tiles over the given landmarks.

usage: uv run python scripts/patch.py pkin [teatr ...]     (names: BOXES below, or r0,r1,c0,c1)
The palette continues from meta.json, so indices in untouched tiles stay valid; new colours are appended.
"""
import json
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np

import debris
import landmarks
import tiles

BOXES = {  # rows, cols of the 1 m grid around each landmark's curated work
    "pkin": (2360, 2660, 600, 900),
    "zacheta": (1805, 1955, 1310, 1410),
    "pw": (3680, 3825, 495, 640),
    "buw": (1740, 1875, 2290, 2460),
    "koszyki": (3560, 3680, 645, 760),
    "rotunda": (2765, 2815, 1070, 1120),
    "kopernik": (1900, 2070, 2515, 2650),
    "poniatowski": (2850, 2920, 2905, 3420),
    "teatr": (1280, 1480, 1330, 1600),
    "z44": (2450, 2510, 445, 505),
    "sd": (950, 1140, 2160, 2700),
    "msn": (2375, 2495, 950, 1010),
    "powisle": (2015, 2140, 2410, 2535),
    "saski": (1530, 1725, 1370, 1510),
    "sejm": (3620, 3740, 1870, 2010),
    "astoria": (2460, 2600, 1195, 1350),
    "rail": (2360, 2610, 2790, 3350),
    "laz": (4140, 4215, 2930, 3580),
    "swk": (2000, 2200, 2680, 3220),
    "kladka": (1305, 1525, 2355, 2835),
    "prez": (1505, 1615, 1730, 1872),
    "bristol": (1598, 1665, 1742, 1850),
    "europejski": (1604, 1685, 1625, 1721),
    "krzyz": (2005, 2058, 1655, 1732),
    "aleks": (3138, 3190, 1670, 1708),
    "filharmonia": (2316, 2386, 1146, 1204),
    "magdalena": (700, 760, 3330, 3390),
    "ujazdowski": (4318, 4405, 1818, 1906),
    "staszic": (2130, 2225, 1710, 1790),
    "mwp": (2890, 3025, 1990, 2080),
    "karm": (1485, 1532, 1765, 1835),
    "uwgate": (1905, 1947, 1745, 1778),
    "zbaw": (4065, 4128, 992, 1046),
}
OUT = Path("web/public/data")
t0 = time.time()
note = lambda *a: print(f"[{time.time() - t0:5.1f}s]", *a)


class Palette:  # same keys as voxelize.Palette, seeded with the full build's entries
    def __init__(self, entries):
        self.entries = [tuple(e) for e in entries]
        self.index = {e: i for i, e in enumerate(self.entries)}

    def __call__(self, rgb, mat=0, q=4):
        if isinstance(rgb, str):
            h = rgb.lstrip("#"); rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        key = tuple(min(255, int(round(v / q)) * q) for v in rgb) + (mat,)
        if key not in self.index:
            self.index[key] = len(self.entries)
            self.entries.append(key)
        return self.index[key]


boxes = [BOXES[a] if a in BOXES else tuple(int(v) for v in a.split(",")) for a in sys.argv[1:] if a not in ("monuments", "gardens", "polin")]
meta = json.load(open(OUT / "meta.json"))
pal = Palette(meta["palette"])
st = pickle.load(open("data/cache/pre_state.pkl", "rb"))
ids = pickle.load(open("data/cache/export_ids.pkl", "rb"))
vol = np.load("data/cache/pre_vol.npy", mmap_mode="r")
vol = np.array(vol[:meta["H"]])
g = st["g"]
landmarks.DECK = st.get("deck")
landmarks.PIERS = st.get("piers", [])
note("loaded", vol.shape)
landmarks.details_geometry(vol, g, st["feats"], pal, note)
from osm import OSM
_osm = OSM()
if "gardens" in sys.argv[1:]:
    import roofgardens
    roofgardens.build(vol, g, st["bkind"] > 0, pal, _osm, lambda gm: landmarks._cells_geom(gm, *g.shape), landmarks._orto(),
                      pal("#73a34e", 8), note)
    for geom in [gm for _, gm in roofgardens.gardens(_osm)] + [b for b, *_ in roofgardens.hosts(_osm).values()]:
        c0, r0, c1, r1 = (int(v) for v in geom.bounds)
        boxes.append((max(r0 - 2, 0), r1 + 3, max(c0 - 2, 0), c1 + 3))
if "polin" in sys.argv[1:]:
    landmarks.polin(vol, g, st["feats"], pal, note)
    boxes.append((300, 430, 520, 640))
landmarks.sigismund_column(vol, g, st["feats"], _osm, pal, note)
if "monuments" in sys.argv[1:]:
    import monuments
    from osm import to_grid
    landmarks.monuments.build(vol, g, pal, note, keep=set(np.array(ids["debris_keep"]).tolist()))
    for m in monuments.MONUMENTS.values():
        c, r = (int(v) for v in to_grid(*m["at"]))
        boxes.append((max(r - 40, 0), r + 41, max(c - 40, 0), c + 41))
keep = np.array(ids.pop("debris_keep"), dtype=vol.dtype)
for k in ("keep_ids", "skip_ids"):  # caches written before level 8 became the only coarse level
    ids.pop(k, None)
for b in boxes:
    debris.drop_debris(vol, g, keep, note, box=b)
if "bkind" in st:  # the whole-city support pass, as in the full build (its fixes reach into the boxes too)
    debris.support_floating(vol, g, pal, st["bkind"], note, st["trunk"], st["pole"], trunk_ok=st.get("trunk_ok"))
for b in boxes:
    tiles.export_region(vol, g, OUT / "tiles", b, note, **ids)
meta["palette"] = [list(e) for e in pal.entries]
json.dump(meta, open(OUT / "meta.json", "w"))
if os.environ.get("DUMP"):  # DUMP=r0,r1,c0,c1: the patched volume over that box, for inspection
    r0_, r1_, c0_, c1_ = (int(v) for v in os.environ["DUMP"].split(","))
    np.savez_compressed("data/debug/dump_box.npz", vol=vol[:, r0_:r1_, c0_:c1_], g=g[r0_:r1_, c0_:c1_],
                        pal=np.array(pal.entries, np.int32), origin=np.array([r0_, c0_]))
np.savez_compressed("data/debug/pkin_box.npz", vol=vol[:, 2360:2660, 600:900], g=g[2360:2660, 600:900],
                    pal=np.array(pal.entries, np.int32))
note("done; palette", len(pal.entries))
