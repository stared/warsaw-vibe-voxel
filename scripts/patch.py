"""Fast loop for landmark work: re-run the curated landmark details on the volume cached by a full build
(LMCACHE=1 uv run python scripts/voxelize.py) and rewrite only the tiles over the given landmarks.

usage: uv run python scripts/patch.py pkin [teatr ...]     (names: BOXES below, or r0,r1,c0,c1)
The palette continues from meta.json, so indices in untouched tiles stay valid; new colours are appended.
"""
import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np

import debris
import landmarks
import tiles

BOXES = {  # rows, cols of the 1 m grid around each landmark's curated work
    "pkin": (1080, 1380, 600, 900),
    "zacheta": (525, 675, 1310, 1410),
    "pw": (2400, 2545, 495, 640),
    "buw": (460, 595, 2290, 2460),
    "koszyki": (2280, 2400, 645, 760),
    "rotunda": (1485, 1535, 1070, 1120),
    "kopernik": (620, 790, 2515, 2650),
    "poniatowski": (1570, 1640, 2905, 3420),
    "teatr": (0, 200, 1330, 1600),
    "z44": (1170, 1230, 445, 505),
    "msn": (1095, 1215, 950, 1010),
    "powisle": (735, 860, 2410, 2535),
    "saski": (250, 445, 1370, 1510),
    "sejm": (2340, 2460, 1870, 2010),
    "astoria": (1180, 1320, 1195, 1350),
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


boxes = [BOXES[a] if a in BOXES else tuple(int(v) for v in a.split(",")) for a in sys.argv[1:]]
meta = json.load(open(OUT / "meta.json"))
pal = Palette(meta["palette"])
st = pickle.load(open("data/cache/pre_state.pkl", "rb"))
ids = pickle.load(open("data/cache/export_ids.pkl", "rb"))
vol = np.load("data/cache/pre_vol.npy", mmap_mode="r")
vol = np.array(vol[:meta["H"]])
g = st["g"]
note("loaded", vol.shape)
landmarks.details_geometry(vol, g, st["feats"], pal, note)
keep = np.array(ids.pop("debris_keep"), dtype=vol.dtype)
for b in boxes:
    debris.drop_debris(vol, g, keep, note, box=b)
for b in boxes:
    tiles.export_region(vol, g, OUT / "tiles", b, note, **ids)
meta["palette"] = [list(e) for e in pal.entries]
json.dump(meta, open(OUT / "meta.json", "w"))
np.savez_compressed("data/debug/pkin_box.npz", vol=vol[:, 1080:1380, 600:900], g=g[1080:1380, 600:900],
                    pal=np.array(pal.entries, np.int32))
note("done; palette", len(pal.entries))
