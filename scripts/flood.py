"""The Vistula's level as a slider (viewer: water level), from record drought to the great floods.

Input: data/ground.npz (voxelize.py: ground height and top colour), data/prep.npz (the DTM over the river, its real
water surface on the LiDAR day).
Output: web/public/data/flood.bin = gzip of two [D, W] uint8 grids,
  spill: the lowest water level (m above the model base) at which the river reaches the cell -- the highest ground on
         the cell's best path from the river (a dyke keeps the land behind it dry until the water tops it); 255 never
  depth: the river bed under the LiDAR-day surface, in decimetres, estimated (LiDAR doesn't see through water): shallow
         shelves off the natural shores and sandbanks, a steep drop off the embanked left bank (the boulevards)
and web/public/data/flood.json: the LiDAR-day surface and its fall along the map.
"""
import gzip
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

OUT = Path("web/public/data")
z = np.load("data/ground.npz")
g = z["g"].astype(np.int16)
D, W = g.shape
meta = json.load(open(OUT / "meta.json"))
base = meta["base"]
water_rgb = np.array([104, 100, 80])  # voxelize.py C["water"], as quantised in the palette
water = (z["rgb"] == water_rgb).all(-1)
lab, n = ndimage.label(water)
river = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1
print("river cells", river.sum(), "of", water.sum(), "water cells")

# the real surface on the LiDAR day (the voxels flatten it to one level): it falls ~0.45 m from south to north
dtm = np.load("data/prep.npz", mmap_mode="r")["dtm"]
rows = np.nonzero(river)[0]
v = dtm[river]
ok = np.isfinite(v) & (v < np.nanpercentile(v, 90))  # not the bank cells caught in the river outline
fall = np.polyfit(rows[ok], v[ok], 1)  # m per grid row (row 0 = north edge)
print(f"LiDAR-day surface {np.polyval(fall, 0):.2f} (row 0) .. {np.polyval(fall, D):.2f} (row {D}) m a.s.l.")

# spill height: grow the river level by level (the ground is in whole metres)
spill = np.full((D, W), 255, np.uint8)
wet = river.copy()
spill[river] = g[river].max()
for k in range(int(g[river].max()), int(g.max()) + 1):
    lab, _ = ndimage.label(g <= k)
    ids = np.unique(lab[river])
    now = np.isin(lab, ids[ids > 0]) & ~wet
    spill[now] = k
    wet |= now
print("spill levels", {k: int((spill == k).sum()) for k in range(4, 14)})

# river bed, estimated: distance to a natural shore (sandbanks, the Praga beaches) shelves gently; the left bank is
# walled (Bulwary, Wybrzeże Kościuszkowskie / Gdańskie), so it drops fast there
shore = ~river
d_any = ndimage.distance_transform_edt(~shore)
cols = np.arange(W)[None, :]
west = np.where(river, cols, W).min(axis=1)  # each row's westernmost river cell: the left (walled) bank
d_west = np.where(river, cols - west[:, None], 9999)
rng = np.random.default_rng(7)
bars = ndimage.gaussian_filter(rng.standard_normal((D // 8 + 1, W // 8 + 1)), 3)
bars = np.kron(bars / bars.std(), np.ones((8, 8)))[:D, :W]
depth = np.minimum(0.45 + 0.03 * d_any + 0.45 * bars, 1.2 + 0.1 * d_west)
depth = np.clip(np.where(river, depth, 0), 0, 25.5)
dd = np.round(depth * 10).astype(np.uint8)
print("bed depth percentiles (m)", np.percentile(depth[river], [5, 25, 50, 75, 95]).round(2))

with gzip.GzipFile(OUT / "flood.bin", "wb", compresslevel=9, mtime=0) as fh:
    fh.write(spill.tobytes())
    fh.write(dd.tobytes())
# the gauge Warszawa-Bulwary (IMGW 152210170, by Most Śląsko-Dąbrowski): zero 75.168 m EVRF2007 since 1 Nov 2025 (1 m
# lower than before: readings from before then +100 cm); the DTM is in PL-KRON86-NH, ~0.18 m below EVRF2007 here
from pyproj import Transformer
from aoi import to_grid
gx, gy = to_grid(*Transformer.from_crs(4326, 2180, always_xy=True).transform(21.0208, 52.2472))
zero = 75.168 - 0.18
lidar_cm = round((np.polyval(fall, gy) - zero) * 100)
print(f"gauge at grid ({gx:.0f}, {gy:.0f}); the LiDAR-day river there reads {lidar_cm} cm (current scale)")
json.dump({"gauge_row": round(float(gy), 1), "gauge_zero": round(zero, 3), "lidar_cm": lidar_cm, "base": base, "surface0": round(float(np.polyval(fall, 0)), 3), "fall": round(float(fall[0]), 7),
           "voxel_top": int(g[river].max())}, open(OUT / "flood.json", "w"))
print("flood.bin", (OUT / "flood.bin").stat().st_size // 1024, "KB")
