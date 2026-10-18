"""PROTOTYPE (proto-ghost): which building and which city block every 1 m column belongs to, so the viewer can show
whole buildings / whole blocks for real (never cut through) and the rest as clay.

Blocks: the ground cut along streets, railways and water; a street's columns go to the nearest block, so two blocks
meet on its centreline. A building belongs whole to the block holding most of its footprint. Very large blocks
(railway land, the river banks) are split on a 256 m grid.

Output (web/public/data/): zones.bin = uint16 block[D, W] + uint16 building[D, W] (0: none), zones.json.
"""
import gzip
import json
import math
from pathlib import Path

import numpy as np
import rasterio.features
from affine import Affine
from scipy import ndimage

from aoi import D, W
from osm import OSM

OUT = Path("web/public/data")
osm = OSM()


def tunnelish(t):
    return t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("layer", "0").lstrip("-").isdigit() and int(t.get("layer", "0")) < 0 \
        or t.get("covered") == "yes" or t.get("location") == "underground"


def burn(shapes, dtype=np.uint16, all_touched=False):
    shapes = [(s, int(v)) for s, v in shapes if s is not None and not s.is_empty]
    return rasterio.features.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=0,
                                       all_touched=all_touched, dtype=dtype)


# buildings (whole buildings, not parts)
blds = [(g, t) for oid, typ, t, g in osm.areas
        if t.get("building") not in (None, "no") and "building:part" not in t and t.get("location") != "underground"]
blds.sort(key=lambda b: -b[0].area)  # small ones burnt last stay visible inside big ones
bld = burn([(g, i + 1) for i, (g, t) in enumerate(blds)])
print("buildings", len(blds), "columns", int((bld > 0).sum()))

# separators: streets (not footways/service), railways, water
ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "pedestrian"}
lines = [l.buffer(1.5) for oid, t, l in osm.lines if (t.get("highway") in ROADS or t.get("railway") in ("rail", "tram", "light_rail"))
         and not tunnelish(t) and t.get("bridge") is None]
water = [g for oid, typ, t, g in osm.areas if t.get("natural") == "water" or t.get("waterway") == "riverbank"]
sep = burn([(g, 1) for g in lines + water], np.uint8, all_touched=True) > 0
sep &= bld == 0  # buildings are never separators (passages under them)
lab, n = ndimage.label(~sep)
print("raw blocks", n)
# streets (and other separator columns) go to the nearest block: blocks meet on the centreline
_, (ir, ic) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
blk = lab[ir, ic].astype(np.int64)
# tiny blocks (traffic islands) join a neighbour; huge ones are split on a 256 m grid
area = np.bincount(blk.ravel(), minlength=n + 1)
rr, cc = np.mgrid[0:D, 0:W]
big = area[blk] > 120_000
blk = np.where(big, (n + 1) + (rr // 256) * (W // 256 + 1) + (cc // 256) + blk * 10_000, blk)
_, blk = np.unique(blk, return_inverse=True)
blk = blk.reshape(D, W) + 1
area = np.bincount(blk.ravel())
small = area[blk] < 400
if small.any():
    _, (ir, ic) = ndimage.distance_transform_edt(small, return_indices=True)
    blk = blk[ir, ic]
# a building lies whole in one block: the one under most of its footprint
idx = np.flatnonzero(bld.ravel())
b, k = bld.ravel()[idx], blk.ravel()[idx]
pairs = np.unique(np.stack([b, k], 1), axis=0, return_counts=True)
best = {}
for (bi, ki), cnt in zip(*pairs):
    if cnt > best.get(bi, (0, 0))[1]:
        best[bi] = (ki, cnt)
lut = np.zeros(len(blds) + 1, np.int64)
for bi, (ki, _) in best.items():
    lut[bi] = ki
blk = np.where(bld > 0, lut[bld], blk)
_, blk = np.unique(blk, return_inverse=True)
blk = (blk.reshape(D, W) + 1).astype(np.uint16)
nb = int(blk.max())
print("blocks", nb)

# per block / building: centroid and bounding box (metres)
def stats(lab, n):
    idx = np.arange(1, n + 1)
    cnt = ndimage.sum_labels(np.ones_like(lab, np.float32), lab, idx)
    cy = ndimage.sum_labels(rr.astype(np.float32), lab, idx) / np.maximum(cnt, 1)
    cx = ndimage.sum_labels(cc.astype(np.float32), lab, idx) / np.maximum(cnt, 1)
    sl = ndimage.find_objects(lab, n)
    out = []
    for i in range(n):
        s = sl[i]
        out.append([round(float(cx[i]), 1), round(float(cy[i]), 1), int(cnt[i]),
                    *( [s[1].start, s[0].start, s[1].stop, s[0].stop] if s else [0, 0, 0, 0])])
    return out

meta = {"blocks": stats(blk, nb), "buildings": stats(bld.astype(np.int32), len(blds))}
# triangles per block at 1 m (prototype estimate): each 128 m tile's triangles (tools/cost1m.mjs) shared by columns
cost = Path("/private/tmp/claude-501/cost1m.json")
if cost.exists():
    tt = np.zeros((math.ceil(D / 128), math.ceil(W / 128)))
    for r in json.load(open(cost))["rows"]:
        tt[r["ty"], r["tx"]] = r["tris"]
    per_col = (tt / 16384)[rr // 128, cc // 128]
    tris = ndimage.sum_labels(per_col, blk, np.arange(1, nb + 1))
    for b, t in zip(meta["blocks"], tris):
        b.append(int(t))
with gzip.GzipFile(OUT / "zones.bin", "wb", compresslevel=9, mtime=0) as fh:
    fh.write(blk.tobytes() + bld.astype(np.uint16).tobytes())
json.dump(meta, open(OUT / "zones.json", "w"))
# a picture of the blocks, for checking
rng = np.random.default_rng(1)
col = rng.integers(60, 230, (nb + 1, 3), dtype=np.uint8)
img = col[blk]
img[bld > 0] = (img[bld > 0] * 0.6).astype(np.uint8)
from PIL import Image
Image.fromarray(img).save("data/debug/zones.png")
print("wrote zones.bin", (OUT / "zones.bin").stat().st_size // 1024, "KB")
