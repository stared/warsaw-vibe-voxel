"""Mosaic GUGiK 2025 DSM (0.5 m), DTM (1 m) and orthophoto, then resample onto the rotated AOI grid.

Outputs (row 0 = grid row 0): dsm at 0.5 m, dtm at 1 m, orto at 0.2 m.
"""
import glob

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.windows import from_bounds
from scipy import ndimage

from aoi import D, RAW, W, to_world, world_bounds

MINX, MINY, MAXX, MAXY = (round(v) for v in world_bounds(margin=10))
BOUNDS = (MINX, MINY, MAXX, MAXY)


def mosaic(pattern, res, nodata=-9999):
    srcs = [rasterio.open(p) for p in sorted(glob.glob(f"{RAW}/{pattern}"))]
    arr, _ = merge(srcs, bounds=BOUNDS, res=res, resampling=Resampling.nearest, nodata=nodata,
                   target_aligned_pixels=False)
    return arr


def mosaic_rgb(pattern, res):
    # sheets carry slightly different WKT for EPSG:2180, so paste windows manually
    out = np.zeros((round((MAXY - MINY) / res), round((MAXX - MINX) / res), 3), np.uint8)
    for p in sorted(glob.glob(f"{RAW}/{pattern}")):
        with rasterio.open(p) as r:
            b = r.bounds
            l, bo, rt, t = max(b.left, MINX), max(b.bottom, MINY), min(b.right, MAXX), min(b.top, MAXY)
            if l >= rt or bo >= t:
                continue
            c0, c1 = round((l - MINX) / res), round((rt - MINX) / res)
            r0, r1 = round((MAXY - t) / res), round((MAXY - bo) / res)
            win = from_bounds(MINX + c0 * res, MAXY - r1 * res, MINX + c1 * res, MAXY - r0 * res, r.transform)
            a = r.read(window=win, out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.average, boundless=True, fill_value=0)
            a = np.moveaxis(a, 0, -1)
            m = a.sum(-1) > 0
            out[r0:r1, c0:c1][m] = a[m]
    return out


def resample(src, src_res, out_res, order):
    """Sample an axis-aligned (north-up, origin MINX/MAXY) raster on the rotated grid."""
    nj, ni = round(D / out_res), round(W / out_res)
    jj, ii = np.mgrid[0:nj, 0:ni].astype(np.float64)
    x, y = to_world((ii + 0.5) * out_res, (jj + 0.5) * out_res)
    col = (x - MINX) / src_res - 0.5
    row = (MAXY - y) / src_res - 0.5
    if src.ndim == 2:
        return ndimage.map_coordinates(src, [row, col], order=order, mode="nearest").astype(src.dtype)
    return np.stack([ndimage.map_coordinates(src[..., k], [row, col], order=order, mode="nearest")
                     for k in range(src.shape[-1])], -1).astype(src.dtype)


dsm = resample(mosaic("dsm_*.asc", 0.5)[0].astype(np.float32), 0.5, 0.5, order=0)  # nearest keeps spires
dtm = resample(mosaic("dtm_*.asc", 1.0)[0].astype(np.float32), 1.0, 1.0, order=1)
for n, a in (("dsm", dsm), ("dtm", dtm)):
    print(n, a.shape, float(a[a > -1000].min()), float(a.max()), int((a < -1000).sum()), "nodata")
orto = resample(mosaic_rgb("orto_*.tif", 0.2), 0.2, 0.2, order=1)
print("orto", orto.shape, orto.reshape(-1, 3).mean(0), int((orto.sum(-1) == 0).sum()), "empty px")
np.savez_compressed("data/prep.npz", dsm=dsm, dtm=dtm, orto=orto)
from PIL import Image
Image.fromarray(orto[::4, ::4]).save("data/orto_preview.jpg", quality=85)
