"""Mosaic + crop GUGiK 2025 DSM (0.5 m), DTM (1 m) and orthophoto (resampled to 0.2 m) to the AOI."""
import glob
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.merge import merge
from aoi import X0, Y0, W, D, RAW

BOUNDS = (X0, Y0, X0 + W, Y0 + D)


def mosaic(pattern, res, resampling=Resampling.nearest, nodata=None):
    srcs = [rasterio.open(p) for p in sorted(glob.glob(f"{RAW}/{pattern}"))]
    arr, _ = merge(srcs, bounds=BOUNDS, res=res, resampling=resampling, nodata=nodata,
                   target_aligned_pixels=False)
    return arr


dsm = mosaic("dsm_*.asc", 0.5, nodata=-9999)[0]
dtm = mosaic("dtm_*.asc", 1.0, nodata=-9999)[0]
print("dsm", dsm.shape, np.nanmin(np.where(dsm < -1000, np.nan, dsm)), dsm.max(), (dsm < -1000).sum())
print("dtm", dtm.shape, np.nanmin(np.where(dtm < -1000, np.nan, dtm)), dtm.max(), (dtm < -1000).sum())
def mosaic_rgb(pattern, res):
    # sheets carry slightly different WKT for EPSG:2180, so paste windows manually
    from rasterio.windows import from_bounds
    out = np.zeros((round(D / res), round(W / res), 3), np.uint8)
    for p in sorted(glob.glob(f"{RAW}/{pattern}")):
        with rasterio.open(p) as r:
            b = r.bounds
            l, bo, rt, t = max(b.left, X0), max(b.bottom, Y0), min(b.right, X0 + W), min(b.top, Y0 + D)
            if l >= rt or bo >= t:
                continue
            # snap to output grid
            c0, c1 = round((l - X0) / res), round((rt - X0) / res)
            r0, r1 = round((Y0 + D - t) / res), round((Y0 + D - bo) / res)
            win = from_bounds(X0 + c0 * res, Y0 + D - r1 * res, X0 + c1 * res, Y0 + D - r0 * res, r.transform)
            a = r.read(window=win, out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.average, boundless=True, fill_value=0)
            a = np.moveaxis(a, 0, -1)
            m = a.sum(-1) > 0
            out[r0:r1, c0:c1][m] = a[m]
    return out


orto = mosaic_rgb("orto_*.tif", 0.2)
print("orto", orto.shape, orto.mean(axis=(0, 1)), (orto.sum(-1) == 0).sum())
np.savez_compressed("data/prep.npz", dsm=dsm.astype(np.float32), dtm=dtm.astype(np.float32), orto=orto)
from PIL import Image
Image.fromarray(orto[::4, ::4]).save("data/orto_preview.jpg", quality=85)
