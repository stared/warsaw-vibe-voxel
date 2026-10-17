"""Bare terrain for the first moment of loading: the ground as the voxel tiles will show it (voxelize.py's ground
height every 4 m, its top colour every 2 m, grass as bare earth like the building tiles), so the viewer can show the land
before any voxel tile arrives.

Input: data/ground.npz (voxelize.py). Output: web/public/data/terrain.bin = gzip of [rows, cols] uint16 heights in
decimetres above the model base, cols = ceil(W / 4), rows = ceil(D / 4); then [D // 2, W // 2, 3] uint8 sRGB colours,
each the 1 m cell at the centre of its 2 m square (crisp, as the voxels: no averaging).
"""
import gzip
from pathlib import Path

import numpy as np
from scipy import ndimage

STEP = 4
z = np.load("data/ground.npz")
g = z["g"].astype(np.float32)
# each vertex: the mean over the 4 m around it, so roads and squares stay, the 1 m terraces don't
h = np.round(ndimage.uniform_filter(g, STEP)[::STEP, ::STEP] * 10).astype(np.uint16)
c = np.ascontiguousarray(z["rgb"][1::2, 1::2])
out = Path("web/public/data/terrain.bin")
with gzip.GzipFile(out, "wb", compresslevel=9, mtime=0) as fh:
    fh.write(h.tobytes())
    fh.write(c.tobytes())
print("terrain", h.shape, out.stat().st_size // 1024, "KB")
