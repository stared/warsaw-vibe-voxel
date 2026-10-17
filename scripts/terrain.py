"""Bare terrain for the first moment of loading: the ground height (as voxelize.py makes it, in scene metres above
the model base) every 4 m, so the viewer can show the land before any voxel tile arrives.

Output: web/public/data/terrain.bin = gzip of uint16 decimetres [rows, cols], cols = ceil(W / 4), rows = ceil(D / 4).
"""
import gzip
import math
from pathlib import Path

import numpy as np
from scipy import ndimage

STEP = 4
z = np.load("data/prep.npz")
dtm = z["dtm"]
BASE = math.floor(dtm.min()) - 3  # as voxelize.py (SLAB = 3); meta.json base
g = ndimage.uniform_filter(dtm, 3) - BASE
t = np.round(g[::STEP, ::STEP] * 10).astype(np.uint16)
out = Path("web/public/data/terrain.bin")
with gzip.GzipFile(out, "wb", compresslevel=9, mtime=0) as fh:
    fh.write(t.tobytes())
print("terrain", t.shape, "base", BASE, out.stat().st_size // 1024, "KB")
