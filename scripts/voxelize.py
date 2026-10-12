"""Fuse GUGiK 2025 LiDAR (DSM/DTM) + orthophoto + current OSM into a 1 m voxel volume.

Output (web/public/data/): voxels.vxl (column runs), meta.json (palette, lamps, labels), ground.bin.
Volume axes: vol[z, row, col]; row grows south, col grows east, z up.
"""
import colorsys
import gzip
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import rasterio.features
import webcolors
from affine import Affine
from scipy import ndimage
from shapely.geometry import LineString, Point
from shapely.ops import substring
from shapely.strtree import STRtree

from aoi import CX, CY, D, THETA, W
from osm import OSM
import landmarks

OUT = Path("web/public/data")
DBG = Path("data/debug")
OUT.mkdir(parents=True, exist_ok=True)
DBG.mkdir(parents=True, exist_ok=True)
report = {"notes": []}


def note(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    report["notes"].append(s)


# ---------------------------------------------------------------- materials / palette
M_SOLID, M_WALL, M_GLASS, M_LEAF, M_WATER, M_LAMP, M_METAL, M_PKIN, M_GRASS, M_MARK, M_SOIL, M_CAR, M_ROOF, M_CONCRETE, M_CLOCK, M_BRONZE, M_SIGN = range(17)


class Palette:
    def __init__(self):
        self.entries = [(0, 0, 0, 0)]
        self.index = {}

    def __call__(self, rgb, mat=M_SOLID, q=4):
        if isinstance(rgb, str):
            rgb = hex_rgb(rgb)
        r, g, b = (min(255, int(round(v / q)) * q) for v in rgb)
        key = (r, g, b, mat)
        if key not in self.index:
            self.index[key] = len(self.entries)
            self.entries.append(key)
        return self.index[key]


def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


COLOUR_ALIASES = {"grey": "gray", "lightgrey": "lightgray", "darkgrey": "darkgray", "cream": "#f1e9d2",
                  "sand": "#d8c79f", "beige": "#ddd2b8", "brick": "#a5553f", "terracotta": "#c0623f",
                  "glass": "#9fb5c2", "concrete": "#b8b5ae", "gold": "#cfae5c", "bronze": "#8c6c47",
                  "copper": "#5f9c87", "ochre": "#cc9a4a", "salmon": "#e19a85", "pink": "#e6b3b3",
                  "white": "#efede6", "black": "#3a3a3d", "red": "#b5513f", "brown": "#7e5a43",
                  "yellow": "#e3c86a", "green": "#6e9a5e", "blue": "#6c8cad", "orange": "#d98b4e",
                  "silver": "#c3c6c9", "gray": "#9a9a9a", "darkgray": "#6e6f72", "lightgray": "#cfcfcc"}


def parse_colour(s):
    if not s:
        return None
    s = s.split(";")[0].strip().lower().replace(" ", "")
    s = COLOUR_ALIASES.get(s, s)
    s = COLOUR_ALIASES.get(s, s)
    if re.fullmatch(r"#?[0-9a-f]{6}|#?[0-9a-f]{3}", s):
        return hex_rgb(s)
    try:
        return hex_rgb(webcolors.name_to_hex(s))
    except ValueError:
        return None


def parse_len(s):
    if s is None:
        return None
    m = re.match(r"\s*(-?[0-9]+(?:[.,][0-9]+)?)", str(s))
    return float(m.group(1).replace(",", ".")) if m else None


def soften(rgb, amt=0.12):
    """MagicaVoxel-ish grading: pull slightly toward warm light grey, keep hue."""
    return tuple(v * (1 - amt) + w * amt for v, w in zip(rgb, (226, 220, 208)))


def stable_hash(*a):
    return int(hashlib.md5("/".join(map(str, a)).encode()).hexdigest()[:8], 16)


pal = Palette()
C = {  # ground & misc palette (MagicaVoxel-like pastel)
    "paving": pal("#c6c2b8"), "paving2": pal("#b5b4af"), "asphalt": pal("#5f636b"), "asphalt_l": pal("#6e7178"),
    "sett": pal("#8f8981"), "concrete": pal("#bdbab2"), "cycle": pal("#a8453e"), "gravel": pal("#d8ccb5"),
    "grass": pal("#86b45a", M_GRASS), "grass2": pal("#79a852", M_GRASS), "garden": pal("#73a34e", M_GRASS),
    "scrub": pal("#5f8f45", M_LEAF), "flower": pal("#d98fb3", M_GRASS), "flower2": pal("#e8c25e", M_GRASS),
    "dirt": pal("#a58a66"), "dirt2": pal("#8e7455"), "fresh": pal("#93865a", M_GRASS),
    "ballast": pal("#8a8178"), "rail": pal("#55575d", M_METAL), "trambed": pal("#a9a59c"),
    "platform": pal("#b7b1a6"), "water": pal("#5fa8c9", M_WATER), "mark": pal("#f1efe8", M_MARK),
    "soil": pal("#7a5c45", M_SOIL), "trunk": pal("#6b4f3a"), "lamp": pal("#ffe2a8", M_LAMP),
    "pole": pal("#3a3e42", M_METAL), "steps": pal("#a8a296"), "hatch": pal("#d9c860", M_MARK),
    "fence": pal("#dfe3e6", M_METAL), "crane": pal("#e7b23c", M_METAL), "crane_d": pal("#3d4249", M_METAL),
    "shelter": pal("#a9c3cf", M_GLASS), "deck": pal("#a7a49d", M_CONCRETE), "parking": pal("#6a6d73"),
    "track": pal("#b8875a"), "kerb": pal("#cfc7b8"), "granite_d": pal("#55595c"), "jet": pal("#dff1f7", 17),
    "benchkerb": pal("#dcd9d1", M_CONCRETE),
}
PERENNIALS = [pal(c, M_LEAF) for c in ["#8e6fae", "#a690c4", "#6f9a4f", "#8aa27a", "#5f8a49", "#7c9c5a", "#c98fb0"]]
LEAVES = [pal(c, M_LEAF) for c in ["#a3c65c", "#8db552", "#76a24a", "#618f43", "#4f7c3c",
                                    "#93bb6a", "#7da95f", "#689655", "#56834c", "#456f43"]]
WALL_DEFAULTS = ["#d8cfc0", "#cbbfa8", "#e2d6bf", "#c4bbad", "#d9c7a7", "#cdc6ba", "#e6ddcc", "#bdb09b",
                 "#d3c3b0", "#c9c9c2"]

# ---------------------------------------------------------------- rasters
z = np.load("data/prep.npz")
dsm, dtm, orto = z["dsm"], z["dtm"], z["orto"]
d4 = dsm.reshape(D, 2, W, 2)
dsm_max = d4.max((1, 3))
dsm_mean = d4.mean((1, 3))
dtm_s = ndimage.uniform_filter(dtm, 3)
SLAB = 3
BASE = math.floor(dtm.min()) - SLAB
g = np.round(dtm_s - BASE).astype(np.int32)  # ground occupies z in [0, g)
nd_max = dsm_max - dtm
nd_mean = dsm_mean - dtm
cellcol = np.median(orto.reshape(D, 5, W, 5, 3), axis=(1, 3)).astype(np.float32)
rgbsum = cellcol.sum(-1) + 1
exg = (2 * cellcol[..., 1] - cellcol[..., 0] - cellcol[..., 2]) / rgbsum
lum = cellcol @ np.array([0.299, 0.587, 0.114], np.float32)
note(f"ground: BASE={BASE} m a.s.l., g range {g.min()}..{g.max()}")

osm = OSM()
note("OSM timestamp", osm.timestamp, "areas", len(osm.areas), "lines", len(osm.lines), "nodes", len(osm.nodes))


def cells_of(geom, all_touched=False):
    minx, miny, maxx, maxy = geom.bounds
    c0, r0 = max(int(math.floor(minx)), 0), max(int(math.floor(miny)), 0)
    c1, r1 = min(int(math.ceil(maxx)), W), min(int(math.ceil(maxy)), D)
    if c0 >= c1 or r0 >= r1:
        return np.zeros(0, int), np.zeros(0, int)
    m = rasterio.features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0),
                                    transform=Affine.translation(c0, r0), all_touched=all_touched, dtype=np.uint8)
    rr, cc = np.nonzero(m)
    if len(rr) == 0 and not all_touched:
        return cells_of(geom, True)
    return rr + r0, cc + c0


def burn(target, shapes, all_touched=False):
    shapes = [(s, int(v)) for s, v in shapes if s is not None and not s.is_empty]
    if not shapes:
        return
    m = rasterio.features.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=0,
                                    all_touched=all_touched, dtype=np.uint16)
    target[m > 0] = m[m > 0]


# ---------------------------------------------------------------- ground classes
gcol = np.full((D, W), C["paving"], np.uint16)
is_road = np.zeros((D, W), bool)
LANDUSE = {"grass": "grass", "meadow": "grass", "village_green": "grass", "flowerbed": "flower", "construction": "dirt",
           "railway": "ballast", "brownfield": "dirt", "greenfield": "grass"}
LEISURE = {"park": "grass2", "garden": "garden", "pitch": "grass", "playground": "gravel", "dog_park": "gravel"}
SURF = {"asphalt": "asphalt", "paving_stones": "paving", "sett": "sett", "cobblestone": "sett", "concrete": "concrete",
        "concrete:plates": "concrete", "gravel": "gravel", "fine_gravel": "gravel", "compacted": "gravel",
        "grass": "grass", "ground": "dirt", "dirt": "dirt", "unhewn_cobblestone": "sett", "paved": "paving",
        "wood": "track", "metal": "rail", "rubber": "cycle", "tartan": "cycle", "artificial_turf": "grass"}


def tunnelish(t):
    return t.get("tunnel") in ("yes", "building_passage", "culvert") or parse_len(t.get("layer", 0)) < 0 \
        or t.get("covered") == "yes" or t.get("indoor") == "yes" or t.get("location") == "underground" \
        or parse_len(t.get("level", "0").split(";")[0] or 0) and parse_len(t.get("level", "0").split(";")[0]) < 0


containers, soft, hard = [], [], []
for oid, typ, t, geom in osm.areas:
    if tunnelish(t) or "building" in t or "building:part" in t:
        continue
    if t.get("place") == "square" or t.get("highway") == "pedestrian" or t.get("landuse") in ("commercial", "retail", "residential"):
        containers.append((geom, C[SURF.get(t.get("surface"), "paving")]))
    if t.get("landuse") in LANDUSE:
        soft.append((geom, C[LANDUSE[t["landuse"]]]))
    if t.get("leisure") in LEISURE:
        soft.append((geom, C[SURF.get(t.get("surface"), LEISURE[t["leisure"]])]))
    if t.get("natural") in ("scrub", "heath", "grassland"):
        soft.append((geom, C["scrub" if t["natural"] == "scrub" else "grass"]))
    if t.get("natural") in ("wood",):
        soft.append((geom, C["garden"]))
    if "construction:leisure" in t or "construction:landuse" in t:
        soft.append((geom, C["fresh"]))
    if t.get("amenity") == "parking" and t.get("parking") not in ("underground", "multi-storey", "rooftop"):
        hard.append((geom, C[SURF.get(t.get("surface"), "parking")]))
containers.sort(key=lambda s: -s[0].area)
soft.sort(key=lambda s: -s[0].area)
burn(gcol, containers)
burn(gcol, soft)
burn(gcol, hard)
parking_mask = np.zeros((D, W), np.uint16)
burn(parking_mask, [(geom, 1) for geom, _ in hard])

# ortho says grass where OSM is silent (cross-check, only on default paving cells, low & green)
ortho_grass = (gcol == C["paving"]) & (exg > 0.09) & (nd_mean < 0.8)
ortho_grass = ndimage.binary_opening(ortho_grass, iterations=1)
gcol[ortho_grass] = C["grass"]
note("ortho-detected grass cells (OSM silent):", int(ortho_grass.sum()))

HW = {"motorway": 20, "trunk": 14, "primary": 12, "secondary": 10, "tertiary": 8, "unclassified": 6,
      "residential": 6, "living_street": 5, "service": 4, "pedestrian": 5, "footway": 2.5, "path": 2,
      "cycleway": 2, "steps": 2.5, "platform": 3, "bridleway": 2, "track": 3, "corridor": 0}
ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"}

foot_shapes, road_shapes = [], []
for oid, t, line in osm.lines:
    hw = t.get("highway")
    if hw == "construction":
        hw = t.get("construction")
    if not hw or tunnelish(t) or hw in ("corridor", "elevator", "proposed"):
        continue
    base = hw.replace("_link", "")
    w = parse_len(t.get("width")) or (parse_len(t.get("lanes")) * 3.1 if t.get("lanes") and base in HW and base in ROADS else None) or HW.get(base, 0)
    if t.get("footway") == "sidewalk":
        w = max(w, 3)
    if base == "service" and t.get("service") in ("parking_aisle", "driveway", "alley"):
        w = 3.5
    if w <= 0:
        continue
    poly = line.buffer(w / 2, cap_style="flat" if base in ROADS else "round")
    if hw in ROADS or base in ROADS:
        road_shapes.append((poly, C[SURF.get(t.get("surface"), "asphalt")]))
    elif hw == "cycleway":
        foot_shapes.append((poly, C[SURF.get(t.get("surface"), "cycle")] if t.get("surface") not in ("asphalt", None) else C["cycle"]))
    elif hw == "steps":
        foot_shapes.append((poly, C["steps"]))
    elif hw in ("footway", "path", "pedestrian", "platform", "track", "bridleway"):
        foot_shapes.append((poly, C[SURF.get(t.get("surface"), "paving")]))
burn(gcol, foot_shapes)
road_mask = np.zeros((D, W), np.uint16)
burn(road_mask, [(s, 1) for s, _ in road_shapes])
burn(gcol, road_shapes)

AH = {"footway": "paving", "pedestrian": "paving", "cycleway": "cycle", "traffic_island": "kerb", "steps": "steps",
      "emergency": "asphalt_l", "yes": "paving", "platform": "platform", "busway": "asphalt", "parking": "parking"}
area_hw = []
for oid, typ, t, geom in osm.areas_with("area:highway"):
    if tunnelish(t):
        continue
    v = t["area:highway"]
    key = SURF.get(t.get("surface")) if v in ("footway", "pedestrian", "yes") else None
    key = key or AH.get(v) or ("asphalt" if v in HW or v.replace("_link", "") in ROADS else "paving")
    area_hw.append((geom, C[key]))
    if key in ("asphalt", "asphalt_l"):
        burn(road_mask, [(geom, 1)])
area_hw.sort(key=lambda s: -s[0].area)
burn(gcol, area_hw)
is_road = road_mask > 0

# rails & trams (only open-air)
rail_beds, rails = [], []
for oid, t, line in osm.lines_with("railway"):
    if tunnelish(t) or t["railway"] not in ("rail", "tram", "light_rail", "subway"):
        continue
    if t["railway"] == "subway":
        continue
    tram = t["railway"] == "tram"
    rail_beds.append((line.buffer(1.4 if tram else 1.9, cap_style="flat"), C["trambed" if tram else "ballast"]))
    for off in (-0.72, 0.72):
        try:
            rails.append((line.offset_curve(off), C["rail"]))
        except Exception:
            pass
for oid, typ, t, geom in osm.areas_with("railway", ("platform",)):
    if not tunnelish(t):
        rail_beds.append((geom, C["platform"]))
burn(gcol, rail_beds)
burn(gcol, rails, all_touched=True)

# water
water = [(geom, C["granite_d"] if t.get("fountain") == "splash_pad" else C["water"]) for oid, typ, t, geom in osm.areas
         if (t.get("amenity") == "fountain" or t.get("natural") == "water" or t.get("water")) and not tunnelish(t)]
burn(gcol, water)
from shapely.ops import unary_union as _uu
_zl = [l for oid, t, l in osm.lines if t.get("name") == "Złota" and t.get("highway") in ("living_street", "pedestrian")]
zlota_line = _uu(_zl) if _zl else None
splash_pads = [geom for oid, typ, t, geom in osm.areas if t.get("fountain") == "splash_pad" and not tunnelish(t)]

# zebra crossings + lane markings on asphalt
asph = np.isin(gcol, [C["asphalt"], C["asphalt_l"], C["parking"]])
n_cross = 0
for oid, t, line in osm.lines:
    if not (t.get("footway") == "crossing" or t.get("cycleway") == "crossing" or
            (t.get("highway") in ("footway", "cycleway", "path") and "crossing" in t)):
        continue
    if t.get("crossing") in ("unmarked", "no") or tunnelish(t):
        continue
    cyc = t.get("highway") == "cycleway" or t.get("cycleway") == "crossing"
    rr, cc = cells_of(line.buffer(1.5 if cyc else 2.2, cap_style="flat"))
    if len(rr) == 0:
        continue
    n_cross += 1
    for r, c in zip(rr, cc):
        if not asph[r, c] and gcol[r, c] not in (C["asphalt"], C["trambed"]):
            continue
        tpos = line.project(Point(c + 0.5, r + 0.5))
        if cyc:
            gcol[r, c] = C["cycle"]
        elif int(tpos) % 2 == 0:
            gcol[r, c] = C["mark"]
note("zebra crossings:", n_cross)

lane_lines = []
for oid, t, line in osm.lines:
    hw = t.get("highway")
    if hw not in ("primary", "secondary", "trunk", "primary_link", "secondary_link") or tunnelish(t):
        continue
    lanes = int(parse_len(t.get("lanes")) or (2 if hw in ("primary", "secondary", "tertiary") else 1))
    if lanes < 2:
        continue
    width = parse_len(t.get("width")) or lanes * 3.1
    lw = width / lanes
    oneway = t.get("oneway") in ("yes", "-1")
    for k in range(1, lanes):
        off = -width / 2 + k * lw
        try:
            ln = line.offset_curve(off) if abs(off) > 0.2 else line
        except Exception:
            continue
        if ln.is_empty or ln.length < 4:
            continue
        solid = (not oneway) and abs(off) < 0.6
        if solid:
            lane_lines.append(ln)
        else:
            L = ln.length
            for s in np.arange(1.0, L - 1, 9.0):
                lane_lines.append(substring(ln, s, min(s + 3, L)))
lm = np.zeros((D, W), np.uint16)
burn(lm, [(l, 1) for l in lane_lines], all_touched=False)
lm_mask = (lm > 0) & np.isin(gcol, [C["asphalt"]])
gcol[lm_mask] = C["mark"]
note("lane marking cells:", int(lm_mask.sum()))

# ---------------------------------------------------------------- buildings
feats = []
for oid, typ, t, geom in osm.areas:
    part = t.get("building:part") not in (None, "no")
    bld = t.get("building") not in (None, "no") and not part
    if not (part or bld) or t.get("building") == "construction" or t.get("location") == "underground":
        continue
    if parse_len(t.get("layer", 0)) < 0 and not part:
        continue
    h = parse_len(t.get("height"))
    lv = parse_len(t.get("building:levels"))
    if h is None and lv is not None:
        h = lv * 3.2 + (parse_len(t.get("roof:height")) or (parse_len(t.get("roof:levels")) or 0) * 2.8)
    mh = parse_len(t.get("min_height"))
    if mh is None and t.get("building:min_level"):
        mh = parse_len(t["building:min_level"]) * 3.2
    if t.get("building") in ("roof", "carport") and mh is None:
        mh = 2.5
    rr, cc = cells_of(geom)
    if len(rr) == 0:
        continue
    feats.append(dict(id=oid, typ=typ, tags=t, geom=geom, part=part, rr=rr, cc=cc, maxh=h, minh=mh or 0.0,
                      area=geom.area))
note("building features:", len(feats), "parts:", sum(f["part"] for f in feats))

outlines = [f for f in feats if not f["part"]]
parts = [f for f in feats if f["part"]]
otree = STRtree([f["geom"] for f in outlines])
for p in parts:  # parts inherit colours/material/name from their outline
    rp = p["geom"].representative_point()
    for i in otree.query(rp, predicate="within"):
        o = outlines[i]
        o["has_parts"] = True
        p.setdefault("parent", o)
for p in parts:
    if "parent" not in p:
        cands = [outlines[i] for i in otree.query(p["geom"], predicate="intersects")]
        if cands:
            p["parent"] = max(cands, key=lambda o: o["geom"].intersection(p["geom"]).area)
            p["parent"]["has_parts"] = True
for o in outlines:
    # outline with parts not rendered (OSM simple-3D convention) if parts cover most of it
    if o.get("has_parts"):
        covered = sum(p["geom"].intersection(o["geom"]).area for p in parts if p.get("parent") is o)
        o["render"] = covered < 0.6 * o["area"]
    else:
        o["render"] = True
for p in parts:
    p["render"] = True
render = [f for f in feats if f["render"]]

pkin = next(f for f in feats if f["tags"].get("name") == "Pałac Kultury i Nauki")


def tag(f, k):
    v = f["tags"].get(k)
    if v is None and f.get("parent") is not None:
        v = f["parent"]["tags"].get(k)
    return v


bmask = np.zeros((D, W), bool)
for f in render:
    bmask[f["rr"], f["cc"]] = True

# feature-level source decision (LiDAR 2025 vs OSM 2026)
top = np.where(bmask, nd_max, 0.0).astype(np.float32)
src_osm = []
for f in render:
    if f["maxh"] is None:
        continue
    v = nd_max[f["rr"], f["cc"]]
    med, p90 = float(np.median(v)), float(np.percentile(v, 90))
    f["dsm_med"] = med
    if f["maxh"] - p90 > 8:
        small = f["area"] < 80 and p90 > 0.7 * f["maxh"]  # needle on top of a tall building
        if small or p90 < 0.35 * f["maxh"]:  # else: nothing tall there in 2025 -> built after the flight
            # spire/needle under-sampled by LiDAR, or built after the 2025 flight
            top[f["rr"], f["cc"]] = np.maximum(top[f["rr"], f["cc"]], f["maxh"])
            src_osm.append((f["id"], tag(f, "name"), round(p90, 1), f["maxh"], "spire" if small else "new"))
for s in src_osm:
    note("OSM height used (LiDAR lower):", s)
# OSM buildings absent in LiDAR without height info
for f in render:
    if f["maxh"] is None and np.median(nd_max[f["rr"], f["cc"]]) < 1.5:
        top[f["rr"], f["cc"]] = 3.2 * (parse_len(tag(f, "building:levels")) or 1)
        note("no LiDAR + no height -> levels:", f["id"], tag(f, "name"))

# tree canopy over low roofs: clip to OSM height
cell_maxh = np.full((D, W), np.nan, np.float32)
for f in sorted(render, key=lambda f: f["maxh"] or 0):
    if f["maxh"] is not None:
        cell_maxh[f["rr"], f["cc"]] = np.fmax(cell_maxh[f["rr"], f["cc"]], f["maxh"])
over = bmask & (exg > 0.06) & np.isfinite(cell_maxh) & (top > cell_maxh + 3)
top[over] = cell_maxh[over]
note("roof cells under tree canopy clipped:", int(over.sum()))

# bottoms (overhangs: roofs/carports/stacked parts with no part below)
bot_rel = np.full((D, W), 1e9, np.float32)
for f in render:
    bot_rel[f["rr"], f["cc"]] = np.minimum(bot_rel[f["rr"], f["cc"]], f["minh"])
bot_rel[~bmask] = 0
bot_rel[bot_rel < 2.5] = 0

landmarks.adjust_heights(top, feats, note)  # curated fixes from research.md

# de-noise low roofs (LiDAR clutter) in building interiors; keep towers/spires untouched
interior = ndimage.binary_erosion(bmask, iterations=1)
top_med = ndimage.median_filter(top, size=3)
smooth_roof = interior & (top < 45) & (np.abs(top_med - top) < 4)
top = np.where(smooth_roof, top_med, top)
topi = np.where(bmask, np.round(top), 0).astype(np.int32)
boti = np.round(bot_rel).astype(np.int32)
bmask &= topi >= 2


# colours/materials per feature
def wall_style(f):
    t = f["tags"]
    mat_tag = (tag(f, "building:material") or "").lower()
    col = parse_colour(t.get("building:colour") or t.get("colour")) or \
        (parse_colour(f["parent"]["tags"].get("building:colour")) if f.get("parent") else None)
    btype = tag(f, "building") or ""
    h = f["maxh"] or float(np.median(top[f["rr"], f["cc"]]))
    inside_pkin = pkin["geom"].contains(f["geom"].representative_point())
    if inside_pkin:
        return pal(soften(col or hex_rgb("#d9c9a6"), 0.05), M_PKIN)
    glass = "glass" in mat_tag or (not mat_tag and h > 45 and btype in ("office", "commercial", "hotel", "yes", "retail")
                                   and "building:colour" not in t)
    if glass:
        return pal(soften(col or hex_rgb("#8aa4b4"), 0.08), M_GLASS)
    if mat_tag in ("concrete",) and col is None:
        col = hex_rgb("#c9c6bd")
    if mat_tag in ("brick",) and col is None:
        col = hex_rgb("#a95f45")
    if col is None:
        col = hex_rgb(WALL_DEFAULTS[stable_hash(f["id"]) % len(WALL_DEFAULTS)])
    return pal(soften(col), M_WALL)


def roof_style(f):
    col = parse_colour(tag(f, "roof:colour"))
    h = float(np.median(top[f["rr"], f["cc"]]))
    if col is None and h < 40:
        cc = cellcol[f["rr"], f["cc"]]
        L = lum[f["rr"], f["cc"]]
        if len(L) >= 3:
            sel = cc[(L >= np.percentile(L, 25)) & (L <= np.percentile(L, 85))]
            col = tuple(np.median(sel, axis=0))
    if col is None:
        col = hex_rgb("#7d7f84")
    col = np.array(col, float) * 1.05  # ortho is slightly dark
    col = tuple(np.clip(col.mean() + (col - col.mean()) * 0.6, 0, 255))  # and carries blue sky reflections
    return pal(soften(col, 0.1), M_ROOF, q=12)


for f in render:
    f["wall"] = landmarks.wall_override(f, pal) or wall_style(f)
    f["roof"] = landmarks.roof_override(f, pal) or roof_style(f)
    wc, rc = parse_colour(tag(f, "building:colour")), parse_colour(tag(f, "roof:colour"))
    if pal.entries[f["wall"]][3] == M_GLASS and wc is not None and wc == rc:
        f["roof"] = f["wall"]

H = int(max(topi.max() + g.max(), g.max()) + 12)
note("volume height", H)
vol = np.zeros((H, D, W), np.uint16)

# ground column
for zz in range(H):
    m = zz < g - 1
    if not m.any():
        break
    vol[zz][m] = C["soil"]
rr, cc = np.nonzero(np.ones((D, W), bool))
vol[g[rr, cc] - 1, rr, cc] = gcol[rr, cc]

# buildings: base fill with the tallest covering feature's wall, then parts paint their own [minh, maxh)
basewall = np.zeros((D, W), np.uint16)
roofcol_fix = np.zeros((D, W), np.uint16)
for f in sorted(render, key=lambda f: f["maxh"] or float(np.median(top[f["rr"], f["cc"]]))):
    basewall[f["rr"], f["cc"]] = f["wall"]
# LiDAR tower taller than the OSM part covering the cell (footprints misregistered, e.g. Marriott):
# take the facade from the nearest OSM part that is tall enough to explain the height
tall_id = np.zeros((D, W), np.int32)
tall_feats = sorted([f for f in render if (f["maxh"] or 0) >= 30], key=lambda f: f["maxh"])
for i, f in enumerate(tall_feats, 1):
    tall_id[f["rr"], f["cc"]] = i
need = bmask & np.isfinite(cell_maxh) & (topi > np.nan_to_num(cell_maxh) + 10) & (topi >= 30)
if need.any() and tall_feats:
    dist, (ir, ic) = ndimage.distance_transform_edt(tall_id == 0, return_indices=True)
    rr_, cc_ = np.nonzero(need)
    fid = tall_id[ir[rr_, cc_], ic[rr_, cc_]]
    ok = (dist[rr_, cc_] < 15) & (fid > 0)
    n_fix = 0
    for r_, c_, k_ in zip(rr_[ok], cc_[ok], fid[ok]):
        f = tall_feats[k_ - 1]
        if f["maxh"] >= topi[r_, c_] - 12:
            basewall[r_, c_] = f["wall"]
            roofcol_fix[r_, c_] = f["roof"]
            n_fix += 1
    note("tower cells recoloured from nearest tall OSM part:", n_fix)
zb = g + boti
zt = g + topi
for zz in range(int(g.min()), H):
    m = bmask & (zz >= zb) & (zz < zt)
    if not m.any():
        continue
    vol[zz][m] = basewall[m]
for f in sorted([f for f in render if f["part"] and f["maxh"]], key=lambda f: -f["maxh"]):
    rr_, cc_ = f["rr"], f["cc"]
    k = bmask[rr_, cc_]
    rr_, cc_ = rr_[k], cc_[k]
    lo = g[rr_, cc_] + int(round(f["minh"]))
    hi = np.minimum(g[rr_, cc_] + int(round(f["maxh"])), zt[rr_, cc_])
    for zz in range(int(lo.min()) if len(lo) else 0, int(hi.max()) if len(hi) else 0):
        m = (zz >= lo) & (zz < hi)
        vol[zz, rr_[m], cc_[m]] = f["wall"]
# roofs: topmost voxel of every building column (+ terraces: voxels with empty above)
roofcol = np.zeros((D, W), np.uint16)
for f in sorted(render, key=lambda f: f["maxh"] or 0):
    roofcol[f["rr"], f["cc"]] = f["roof"]
roofcol = np.where(roofcol_fix > 0, roofcol_fix, roofcol)
green_roof = bmask & (exg > 0.08) & (topi < 40) & ~over
rr, cc = np.nonzero(bmask)
vol[zt[rr, cc] - 1, rr, cc] = np.where(green_roof[rr, cc], C["garden"], roofcol[rr, cc])
note("green roof cells:", int(green_roof.sum()))

# ---------------------------------------------------------------- vegetation (LiDAR canopy + OSM trees)
trees = [(oid, t, p) for oid, t, p in osm.nodes if t.get("natural") == "tree"]
tree_rc = np.array([(int(p.y), int(p.x)) for _, _, p in trees if 0 <= p.x < W and 0 <= p.y < D])
near_tree = np.zeros((D, W), bool)
if len(tree_rc):
    near_tree[tree_rc[:, 0], tree_rc[:, 1]] = True
    near_tree = ndimage.binary_dilation(near_tree, iterations=3)
veg = (~bmask) & (nd_mean > 2.2) & ((exg > 0.025) | (near_tree & (exg > -0.03)))
# LiDAR wall edges outside OSM footprints look like tall "trees": reject cells next to a building
# whose height is close to that building's roof
btop_near = ndimage.maximum_filter(np.where(bmask, topi, 0), size=7)
wall_edge = (btop_near > 0) & (nd_mean > 0.6 * btop_near) & (nd_mean > 6)
veg &= ~wall_edge | (near_tree & (nd_mean < 25))
step = ndimage.maximum_filter(nd_mean, 3) - ndimage.minimum_filter(nd_mean, 3)
veg &= ~((btop_near > 0) & (step > 7) & (nd_mean > 0.5 * btop_near))
veg &= nd_mean < 32  # no trees taller than ~30 m in central Warsaw
veg = ndimage.binary_opening(veg, iterations=1)
note("wall-edge cells rejected as vegetation:", int(wall_edge.sum()))
lab, n = ndimage.label(veg)
sizes = ndimage.sum(veg, lab, range(1, n + 1))
veg &= np.isin(lab, np.nonzero(sizes >= 4)[0] + 1)
hs = ndimage.gaussian_filter(np.where(veg, nd_mean, 0), 2) / np.maximum(ndimage.gaussian_filter(veg.astype(float), 2), 1e-3)
crown_top = np.round(np.minimum(nd_mean, 40)).astype(np.int32)
crown_bot = np.clip(np.round(hs * 0.38), 2, None).astype(np.int32)
crown_bot = np.minimum(crown_bot, crown_top - 1)
# leaf colour from ortho: luminance x hue bins
hue = np.zeros((D, W), np.float32)
r_, g_, b_ = cellcol[..., 0], cellcol[..., 1], cellcol[..., 2]
yellowish = (r_ - b_) / rgbsum > 0.05
lbin = np.clip(((lum - 40) / 110 * 5).astype(int), 0, 4)
leafidx = np.array(LEAVES, np.uint16)[(4 - lbin) + 5 * (~yellowish)]
rr, cc = np.nonzero(veg)
for zz in range(int(g.min()) + 1, int((g + crown_top).max()) + 1):
    m = (zz >= g[rr, cc] + crown_bot[rr, cc]) & (zz < g[rr, cc] + crown_top[rr, cc])
    sel = (rr[m], cc[m])
    cur = vol[zz][sel]
    vol[zz][sel] = np.where(cur == 0, leafidx[sel], cur)
note("canopy cells:", int(veg.sum()))

# trunks at OSM trees (inside canopy) + procedural trees where LiDAR has no crown (planted after 2025 flight)
n_new = 0
from shapely.ops import unary_union
zlota = unary_union([l for oid, t, l in osm.lines if t.get("name") == "Złota"])
canopy_near = ndimage.binary_dilation(veg, iterations=2)
for oid, t, p in trees:
    c, r = int(p.x), int(p.y)
    if not (2 <= c < W - 2 and 2 <= r < D - 2) or bmask[r, c]:
        continue
    if canopy_near[r, c]:
        hb = int(crown_bot[r, c]) if veg[r, c] else 3
        vol[g[r, c]:g[r, c] + hb, r, c] = C["trunk"]
    else:
        n_new += 1
        # Zielona Złota (opened Aug 2026): elms planted at ~9 m (research.md)
        hgt = parse_len(t.get("height")) or (9 if p.x > 1000 and p.distance(zlota) < 12 else None)
        landmarks.small_tree(vol, g, r, c, stable_hash(oid), LEAVES, C["trunk"], height=hgt)
note("OSM trees without 2025 LiDAR crown -> procedural:", n_new)

# ---------------------------------------------------------------- fountains (visual_ref.md, Commons photos Aug 2026)
# Flat walk-on fountain on the filled-in Marszałkowska tunnel ramp: dark speckled granite cut into irregular
# polygons, darker shard inlays, flush with the paving, slot drain round the edge, jets from steel rings ~2 m apart.
GRAN = [pal("#6a6e71"), pal("#62666a"), pal("#72767a")]
SHARD, DRAIN, RING = pal("#4a4d50"), pal("#3a3c3f", M_METAL), pal("#b9bdc0", M_METAL)
n_jets = 0
jets = []
for geom in splash_pads:
    rr, cc = cells_of(geom)
    if len(rr) == 0:
        continue
    m = np.zeros((D, W), bool)
    m[rr, cc] = True
    edge = m & ~ndimage.binary_erosion(m)
    # polygon slabs: Voronoi cells around a few random seeds
    rng = np.random.default_rng(stable_hash(int(rr.mean()), int(cc.mean())))
    seeds = np.stack([rng.uniform(rr.min(), rr.max() + 1, 14), rng.uniform(cc.min(), cc.max() + 1, 14)], 1)
    for r, c in zip(rr, cc):
        z0 = g[r, c] - 1
        d2 = ((seeds - (r + 0.5, c + 0.5)) ** 2).sum(1)
        o2 = np.sort(d2)
        k = int(np.argmin(d2))
        if edge[r, c]:
            v = DRAIN
        elif o2[1] - o2[0] < 1.6:  # seam between slabs
            v = SHARD
        elif r % 2 == 0 and c % 2 == 0:
            v = RING
            jets.append([c + 0.5, int(z0 + 1), r + 0.5])  # rendered as animated water columns in the viewer
            n_jets += 1
        else:
            v = SHARD if stable_hash(r, c, 7) % 23 == 0 else GRAN[k % 3]
        vol[z0, r, c] = v
note("splash-pad fountain jets:", n_jets)

# "Mountain" mist fountain mid-block on Złota: an oval lawn with ~22 cream sandstone boulders and stepping stones
BOULDER, STEP = pal("#d6cfc0"), pal("#c9c3b6")
n_b = 0
for oid, typ, t, geom in osm.areas:
    if t.get("amenity") != "fountain" or t.get("fountain") == "splash_pad" or geom.area > 80 or tunnelish(t):
        continue
    near_zlota = geom.centroid.distance(zlota_line) < 15 if zlota_line is not None else False
    if not near_zlota:
        continue
    cy, cx = geom.centroid.y, geom.centroid.x
    rng = np.random.default_rng(oid % (2 ** 32))
    for r in range(int(cy) - 5, int(cy) + 6):
        for c in range(int(cx) - 7, int(cx) + 8):
            e = ((r + 0.5 - cy) / 4.5) ** 2 + ((c + 0.5 - cx) / 6.5) ** 2
            if e > 1 or bmask[r, c]:
                continue
            z0 = g[r, c] - 1
            vol[z0, r, c] = C["grass"] if e > 0.18 else pal("#5a5e61")
            if e > 0.18 and stable_hash(r, c, 3) % 9 == 0:
                vol[z0, r, c] = STEP
    for _ in range(22):
        a, rad = rng.uniform(0, 2 * np.pi), rng.uniform(0.45, 0.95)
        r, c = int(cy + 4.5 * rad * np.sin(a)), int(cx + 6.5 * rad * np.cos(a))
        if not bmask[r, c]:
            vol[g[r, c], r, c] = BOULDER
            if rng.random() < 0.35 and not bmask[r, c + 1]:
                vol[g[r, c + 1], r, c + 1] = BOULDER
            n_b += 1
note("boulder fountain boulders:", n_b)

# ---------------------------------------------------------------- planted beds (Zielona Złota, Plac Centralny)
# small leisure=garden / flowerbed islands are raised perennial beds edged with concrete bench-kerbs (photos 2026)
n_beds = 0
for oid, typ, t, geom in osm.areas:
    if not (t.get("leisure") == "garden" or t.get("landuse") == "flowerbed") or tunnelish(t) or not (4 <= geom.area <= 400):
        continue
    rr, cc = cells_of(geom)
    k = ~bmask[rr, cc]
    rr, cc = rr[k], cc[k]
    if len(rr) == 0:
        continue
    m = np.zeros((D, W), bool)
    m[rr, cc] = True
    edge = m & ~ndimage.binary_erosion(m)
    for r, c in zip(rr, cc):
        z0 = g[r, c]
        if vol[z0, r, c] != 0:
            continue
        if edge[r, c] and geom.area > 12:
            vol[z0, r, c] = C["benchkerb"]
        elif stable_hash(oid, r, c) % 5:
            vol[z0, r, c] = PERENNIALS[stable_hash(r, c, oid) % len(PERENNIALS)]
    n_beds += 1
note("raised planting beds:", n_beds)

# ---------------------------------------------------------------- street furniture
lamps = []
for oid, t, p in osm.nodes_with("highway", ("street_lamp",)):
    c, r = int(p.x), int(p.y)
    if not (0 <= c < W and 0 <= r < D) or bmask[r, c]:
        continue
    hgt = int(parse_len(t.get("height")) or (10 if is_road[max(r - 6, 0):r + 7, max(c - 6, 0):c + 7].any() else 6))
    z0 = g[r, c]
    vol[z0:z0 + hgt - 1, r, c] = np.where(vol[z0:z0 + hgt - 1, r, c] == 0, C["pole"], vol[z0:z0 + hgt - 1, r, c])
    vol[z0 + hgt - 1, r, c] = C["lamp"]
    lamps.append((c, r, int(z0 + hgt - 1)))
note("street lamps:", len(lamps))
# Złota after the 2026 redesign: photos show slim lantern poles every ~15-20 m along the street, OSM maps only a
# few. Infer lamps along the new Złota ways where OSM has none within 9 m.
n_inf = 0
lamp_xy = np.array([(c, r) for c, r, _ in lamps], float) if lamps else np.zeros((0, 2))
for oid, t, line in osm.lines:
    if t.get("name") != "Złota" or t.get("highway") not in ("living_street", "pedestrian") or line.length < 20:
        continue
    for k_, dist in enumerate(np.arange(8, line.length - 4, 18.0)):
        p = line.interpolate(dist)
        q_ = line.interpolate(min(dist + 1, line.length))
        tx, ty = q_.x - p.x, q_.y - p.y
        tl = max(np.hypot(tx, ty), 1e-6)
        side = 5.5 if k_ % 2 else -5.5  # alternate kerbs, clear of the central walkway
        c, r = int(p.x - ty / tl * side), int(p.y + tx / tl * side)
        if not (0 <= c < W and 0 <= r < D) or bmask[r, c]:
            continue
        if len(lamp_xy) and np.min(np.hypot(lamp_xy[:, 0] - c, lamp_xy[:, 1] - r)) < 9:
            continue
        z0 = g[r, c]
        vol[z0:z0 + 6, r, c] = np.where(vol[z0:z0 + 6, r, c] == 0, C["pole"], vol[z0:z0 + 6, r, c])
        vol[z0 + 6, r, c] = C["lamp"]
        lamps.append((c, r, int(z0 + 6)))
        lamp_xy = np.vstack([lamp_xy, [c, r]])
        n_inf += 1
note("inferred lamps on renovated Złota (photos, OSM incomplete):", n_inf)

for oid, typ, t, geom in osm.areas_with("amenity", ("shelter",)):
    if t.get("shelter_type") not in (None, "public_transport", "basic_hut") or bmask[cells_of(geom)].any():
        continue
    rr, cc = cells_of(geom)
    zz = g[rr, cc] + 2
    vol[zz, rr, cc] = C["shelter"]
    vol[g[rr, cc], rr, cc] = np.where((rr + cc) % 3 == 0, C["pole"], 0)

for oid, t, p in osm.nodes_with("man_made", ("flagpole",)):
    c, r = int(p.x), int(p.y)
    if 0 <= c < W and 0 <= r < D and not bmask[r, c]:
        hgt = int(parse_len(t.get("height")) or 9)
        vol[g[r, c]:g[r, c] + hgt, r, c] = C["fence"]

# bridges / decks over the rail cut (DTM drops below them)
for oid, typ, t, geom in osm.areas_with("man_made", ("bridge",)):
    rr, cc = cells_of(geom)
    k = ~bmask[rr, cc] & (nd_mean[rr, cc] > 2)
    rr, cc = rr[k], cc[k]
    if len(rr) == 0:
        continue
    zt_ = g[rr, cc] + np.round(nd_mean[rr, cc]).astype(int)
    for dz in (1, 2):
        vol[zt_ - dz, rr, cc] = C["deck"]
    vol[zt_ - 1, rr, cc] = gcol[rr, cc]
    note("bridge deck", oid, t.get("name"), len(rr), "cells")

# ---------------------------------------------------------------- vehicles frozen from the 2025 LiDAR + ortho
# only parked cars stay frozen; cars caught mid-carriageway by the 2025 flight are replaced by the live simulation
veh = (~bmask) & (~veg) & (parking_mask > 0) & (nd_mean > 1.1) & (nd_mean < 4.2)
lab, n = ndimage.label(veh)
objs = ndimage.find_objects(lab)
n_cars = n_bus = 0
for i, sl in enumerate(objs, 1):
    m = lab[sl] == i
    area = int(m.sum())
    if area < 4 or area > 70:
        continue
    rr, cc = np.nonzero(m)
    rr, cc = rr + sl[0].start, cc + sl[1].start
    hmean = float(nd_mean[rr, cc].mean())
    col = np.median(cellcol[rr, cc], axis=0)
    hsv = list(colorsys.rgb_to_hsv(*(col / 255)))
    hsv[1] = min(1, hsv[1] * 1.4)
    hsv[2] = min(1, hsv[2] * 1.1)
    col = tuple(int(v * 255) for v in colorsys.hsv_to_rgb(*hsv))
    idx = pal(col, M_CAR, q=16)
    big = area > 22 and hmean > 2.4
    z0 = g[rr, cc]
    vol[z0, rr, cc] = idx
    if big:
        vol[z0 + 1, rr, cc] = idx
        vol[z0 + 2, rr, cc] = pal((235, 235, 235), M_CAR)
        n_bus += 1
    else:
        # cabin: inner cells only
        er = ndimage.binary_erosion(m)
        r2, c2 = np.nonzero(er)
        if len(r2):
            vol[g[r2 + sl[0].start, c2 + sl[1].start] + 1, r2 + sl[0].start, c2 + sl[1].start] = pal((60, 72, 86), M_GLASS)
        n_cars += 1
note("vehicles from LiDAR:", n_cars, "cars,", n_bus, "buses/trams/trucks")

# ---------------------------------------------------------------- curated landmark details
landmarks.apply_zones(vol, g, feats, pal, bmask, note)
leaf_ids = {i for i, e in enumerate(pal.entries) if e[3] in (M_LEAF,)}
labels, views = landmarks.details(vol, g, top, topi, bmask, feats, pal, C, osm, cells_of, note, leaf_ids)

# ---------------------------------------------------------------- export
Hm = int(np.nonzero(vol.reshape(H, -1).any(axis=1))[0].max()) + 1
vol = vol[:Hm]
note("final height", Hm, "palette", len(pal.entries))
cols = vol.reshape(Hm, -1).T  # (N, H) - each column bottom->top (row-major: row*W + col)
N = cols.shape[0]
b = np.zeros((N, Hm + 1), bool)
b[:, 0] = True
b[:, 1:Hm] = cols[:, 1:] != cols[:, :-1]
b[:, Hm] = True
fi = np.flatnonzero(b)
ci, zi = fi // (Hm + 1), fi % (Hm + 1)
same = ci[:-1] == ci[1:]
s_ci, s_z0, s_z1 = ci[:-1][same], zi[:-1][same], zi[1:][same]
val = cols[s_ci, s_z0]
k = val != 0
s_ci, s_z0, s_z1, val = s_ci[k], s_z0[k], s_z1[k], val[k]
counts = np.bincount(s_ci, minlength=N)
assert counts.max() < 65536
runs = np.stack([s_z0, s_z1 - s_z0, val], 1).astype(np.uint16)
blob = counts.astype(np.uint16).tobytes() + runs.tobytes()
with gzip.open(OUT / "voxels.vxl", "wb", compresslevel=9) as fh:
    fh.write(blob)
note("runs", len(runs), "max per column", int(counts.max()), "bytes", len(blob))
g.astype(np.uint16).tofile(OUT / "ground.bin")
# tram routes for the animated trams: merged open-air tram tracks, sampled every metre with ground z
from shapely.ops import linemerge
tram_lines = linemerge([l for oid, t, l in osm.lines_with("railway", ("tram",)) if not tunnelish(t)])
tram_lines = list(getattr(tram_lines, "geoms", [tram_lines]))
trams = []
for ln in sorted(tram_lines, key=lambda l: -l.length):
    if ln.length < 180:
        continue
    pts = [ln.interpolate(d) for d in np.arange(0, ln.length, 2.0)]
    path = []
    for p in pts:
        c, r = min(max(int(p.x), 0), W - 1), min(max(int(p.y), 0), D - 1)
        path.append([round(p.x, 1), round(p.y, 1), int(g[r, c])])
    trams.append(path)
note("tram paths:", len(trams), "total km", round(sum(len(p) for p in trams) * 2 / 1000, 2))
meta = dict(W=W, D=D, H=Hm, base=BASE, center=[CX, CY], theta_deg=math.degrees(THETA), crs="EPSG:2180", trams=trams, jets=jets,
            palette=[list(e) for e in pal.entries], lamps=lamps, labels=labels, views=views,
            sources=dict(osm=osm.timestamp, lidar="GUGiK NMPT/NMT 2025 (GK-FOTO.6201.5.2025)",
                         ortho="GUGiK ortofotomapa 2025, 5 cm"))
json.dump(meta, open(OUT / "meta.json", "w"))
import traffic
# QA aid: drivable-surface mask (1 = carriageway/road area, 2 = tram bed) for web/tools/qa.mjs
qa = np.zeros((D, W), np.uint8)
qa[is_road] = 1
qa[np.isin(gcol, [C["trambed"], C["rail"]])] = 2
qa.tofile(OUT / "qa_roadmask.bin")
json.dump(traffic.build(g, nd_mean, note, qa), open(OUT / "traffic.json", "w"), separators=(",", ":"))
json.dump(report, open(DBG / "report.json", "w"), indent=1, ensure_ascii=False)

# debug: top-down colour of highest voxel
topz = Hm - 1 - np.argmax(vol[::-1] != 0, axis=0)
topv = np.take_along_axis(vol, topz[None], 0)[0]
palarr = np.array([e[:3] for e in pal.entries], np.uint8)
from PIL import Image
shade = np.clip(0.55 + topz / 120, 0, 1.2)[..., None]
Image.fromarray(np.clip(palarr[topv] * shade, 0, 255).astype(np.uint8)).save(DBG / "topdown.png")
Image.fromarray(palarr[gcol]).save(DBG / "ground.png")
print("done")
