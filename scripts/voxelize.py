"""Fuse GUGiK 2025 LiDAR (DSM/DTM) + orthophoto + current OSM into a 1 m voxel volume.

Output (web/public/data/): voxels.vxl (column runs), meta.json (palette, lamps, labels), ground.bin.
Volume axes: vol[z, row, col]; row grows south, col grows east, z up.
"""
import colorsys
import gzip
import hashlib
import json
import math
import os
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
    try:
        rgb = hex_rgb(s) if re.fullmatch(r"#?[0-9a-f]{6}|#?[0-9a-f]{3}", s) else hex_rgb(webcolors.name_to_hex(s))
    except ValueError:
        return None
    # building paint is never neon: a kiosk tagged "red" was #ff0000, a roof "lime" #00ff00 -- cap the saturation at
    # 0.62 (a deep brick red, a strong but real green) and keep hue and lightness
    h_, l_, s_ = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    if s_ > 0.62 and 0.12 < l_ < 0.9:
        rgb = tuple(round(v * 255) for v in colorsys.hls_to_rgb(h_, l_, 0.62))
    return rgb


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
    "platform": pal("#b7b1a6"), "water": pal("#68654f", M_WATER), "mark": pal("#f1efe8", M_MARK),
    "bare": pal("#a8977c", M_SOIL),  # lawns before their grass arrives (tiles.py: grass is its own file)
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


def wall_clean(dsm):
    """The DSM is interpolated across vertical walls: a sample on a tower's edge reads 69, 95, 115 m between a 150 m
    roof and a 21 m podium (Rondo 1). Taken as the cell's max, each became a 1 m column of partial height glued to
    the facade, ending mid-air (dark streaks down the towers). A sample on a step of 10 m or more (7x7), 3 m or more
    from both levels around it and steep goes to the nearer level."""
    # the two levels from 3.5 m around: a wall the DSM ramps across in 3-4 samples (Górnośląska 3: 12, 25, 36, 43 m
    # between a 4 m podium and a 50 m roof) snapped sample by sample to its ramp neighbours stayed a ramp
    lo = ndimage.minimum_filter(dsm, 7)
    hi = ndimage.maximum_filter(dsm, 7)
    mixed = (hi - lo >= 10) & (dsm - lo >= 3) & (hi - dsm >= 3)
    # and steep: 3 m or more to a 4-neighbour (6 m per metre; a pitched roof rises under 2) -- a ramp along a straight
    # wall repeats row after row, so similar neighbours along the wall do not make it a surface
    pad = np.pad(dsm, 1, mode="edge")
    steep = np.zeros(dsm.shape, bool)
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        steep |= np.abs(pad[1 + dr:1 + dr + dsm.shape[0], 1 + dc:1 + dc + dsm.shape[1]] - dsm) >= 3
    mixed &= steep
    # below a broad upper level only: spires, lanterns and stepped crowns (All Saints' towers, Hotel Warszawa's crown)
    # were cut down to flat boxes; a wall edge has a roof beside it
    # (the upper level must survive a 6.5 m opening: a roof does, a spire's tip or a tower's stepped crown does not)
    mixed &= ndimage.maximum_filter(ndimage.grey_opening(dsm, size=(13, 13)), 7) >= hi - 3
    up = mixed & (dsm - lo >= hi - dsm)
    # a cell (2x2 samples) takes its highest: one sample snapped up pushed the wall out a cell, a sawtooth along every
    # wall top (Bagno 5). Up only where at least two of the cell's samples go up
    n_up = up.reshape(dsm.shape[0] // 2, 2, dsm.shape[1] // 2, 2).sum((1, 3))
    up &= np.repeat(np.repeat(n_up >= 2, 2, 0), 2, 1)
    out = np.where(mixed, np.where(up, hi, lo), dsm)
    note("DSM wall-edge samples snapped to roof or street:", int(mixed.sum()))
    return out


nd_max_b = wall_clean(dsm).reshape(D, 2, W, 2).max((1, 3)) - dtm  # building tops
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

def on_bridge(t):
    return t.get("bridge") not in (None, "no") or t.get("man_made") == "bridge"


foot_shapes, road_shapes, bridge_shapes = [], [], []  # bridge ways are painted on the deck, not on the river below
bridge_lines = []  # (line, half width, layer) of every way on a bridge: the deck's height profile is taken along them
bridge_roads = []  # (line, width) of carriageways on bridges, for the inferred deck lamps
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
    if on_bridge(t):
        key = SURF.get(t.get("surface"), "asphalt") if (hw in ROADS or base in ROADS) else ("cycle" if hw == "cycleway" else SURF.get(t.get("surface"), "paving"))
        bridge_shapes.append((poly, C[key], int(parse_len(t.get("layer")) or 1)))
        bridge_lines.append((line, w / 2, int(parse_len(t.get("layer")) or 1), C[key]))
        if (hw in ROADS or base in ROADS) and line.length > 60 and t.get("motor_vehicle") not in ("no", "private"):
            bridge_roads.append((line, w))  # (not the Karowa footbridge, a living_street for service vans only)
        continue
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
    if on_bridge(t):
        bridge_shapes.append((line.buffer(1.4 if tram else 1.9, cap_style="flat"), C["trambed" if tram else "ballast"], int(parse_len(t.get("layer")) or 1)))
        bridge_lines.append((line, 1.4 if tram else 1.9, int(parse_len(t.get("layer")) or 1), C["trambed" if tram else "ballast"]))
        continue
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
# the Vistula (and ponds): one flat surface per water body -- the DTM over water steps in 1 m terraces that show as
# lines across the river; it drops ~0.3 m across the map, so a single level is truthful
wlab, wn = ndimage.label(gcol == C["water"])
wsize = np.bincount(wlab.ravel())
n_flat = 0
for i_, sl in enumerate(ndimage.find_objects(wlab), 1):
    if sl is None or wsize[i_] < 400:
        continue
    m_ = wlab[sl] == i_
    sub = g[sl]
    sub[m_] = int(np.median(sub[m_]))
    n_flat += 1
note("water bodies flattened:", n_flat)
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
top = np.where(bmask, nd_max_b, 0.0).astype(np.float32)
src_osm = []
for f in render:
    if f["maxh"] is None:
        continue
    v = nd_max_b[f["rr"], f["cc"]]
    med, p90 = float(np.median(v)), float(np.percentile(v, 90))
    f["dsm_med"] = med
    if f["maxh"] - p90 > 8:
        small = f["area"] < 80 and p90 > 0.7 * f["maxh"]  # needle on top of a tall building
        rh = parse_len(f["tags"].get("roof:height")) or 0
        pointed = f["tags"].get("roof:shape") in ("pyramidal", "conical", "onion", "spire", "dome") and rh >= 3
        if pointed and len(f["rr"]) >= 9 and p90 > 0.6 * (f["maxh"] - rh):
            # a tower's pointed roof the LiDAR missed (Salvator's two bell towers: 61 m of tower, a 15 m pyramid): it
            # rises from the eaves to its peak by distance from the part's edge -- not the whole footprint at 76 m
            rr_, cc_ = f["rr"], f["cc"]
            m_ = np.zeros((rr_.max() - rr_.min() + 3, cc_.max() - cc_.min() + 3), bool)
            m_[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1] = True
            dep = ndimage.distance_transform_edt(m_)[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1]
            roof_ = (f["maxh"] - rh) + rh * (dep - 1) / max(dep.max() - 1, 1)
            top[rr_, cc_] = np.maximum(top[rr_, cc_], roof_)
            src_osm.append((f["id"], tag(f, "name"), round(p90, 1), f["maxh"], "pointed roof"))
        elif small or p90 < 0.35 * f["maxh"]:  # else: nothing tall there in 2025 -> built after the flight
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
# outlines drawn only through their parts count too: a part starting at 19 m with no part mapped under it (the WFC
# tower, InterContinental, a ministry's top floors) stands on its outline's walls, it does not hover over the street
for f in feats:
    if f["render"] or f.get("has_parts"):
        bot_rel[f["rr"], f["cc"]] = np.minimum(bot_rel[f["rr"], f["cc"]], f["minh"])
bot_rel[~bmask] = 0
bot_rel[bot_rel < 2.5] = 0

landmarks.adjust_heights(top, feats, note)  # curated fixes from research.md

# de-noise low roofs (LiDAR clutter) in building interiors; keep towers/spires untouched
interior = ndimage.binary_erosion(bmask, iterations=1)
top_med = ndimage.median_filter(top, size=3)
smooth_roof = interior & (top < 45) & (np.abs(top_med - top) < 4)
top = np.where(smooth_roof, top_med, top)


def flatten_roofs(top):
    """Flat roofs flat: per building part, if most of the roof lies within 1.5 m of its median, snap every cell within
    2.5 m to it, and snap blobs above or below it smaller than 15 cells (LiDAR speckle on the roof, a 1 m slot down a
    wall where the edge returns came low). Rooftop structures bigger than that, pitched roofs and towers stay."""
    n_f = n_c = 0
    for f in sorted(render, key=lambda f: -len(f["rr"])):  # parents first, their parts after
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 30 or ((f.get("minh") or 0) >= 2.5 and np.median(bot_rel[rr, cc]) >= 2.5):
            continue  # parts on stilts (canopies, cantilevers): snapping their top under their bottom left fragments
            # (a part on its podium -- IBC's curved wing from 8 m -- stands on something: its roof is snapped too)
        v = top[rr, cc]
        med = float(np.median(v))
        if med < 3:
            continue
        if np.mean(np.abs(v - med) <= 1.5) < 0.6:
            # several roof levels (one OSM outline over a whole theatre or palace): snap each column to its 5x5
            # neighbourhood's median within 2.5 m, so every terrace is flat and the real setbacks stay
            if len(rr) >= 200:
                r0, c0 = rr.min(), cc.min()
                box = np.zeros((rr.max() - r0 + 3, cc.max() - c0 + 3), np.float32)
                inside = np.zeros(box.shape, bool)
                box[rr - r0 + 1, cc - c0 + 1] = v
                inside[rr - r0 + 1, cc - c0 + 1] = True
                # outside the outline: the nearest inside height (zeros there pulled the median down at every edge,
                # notching the roofline)
                _, (ir, ic) = ndimage.distance_transform_edt(~inside, return_indices=True)
                lm = ndimage.median_filter(box[ir, ic], 5)[rr - r0 + 1, cc - c0 + 1]
                k = (np.abs(v - lm) <= 2.5) & (lm > 3)
                n_c += int((k & (v != lm)).sum())
                top[rr[k], cc[k]] = lm[k]
                # then the roof's own levels: peaks of its height histogram (1 m bins, 6 % of the roof or 40 cells);
                # cells within 1.5 m of a level go to it -- 1 m terraces of LiDAR noise between them (lumpy
                # podium roofs, LIM, Metropolitan) were drawn as steps
                v2 = top[rr, cc]
                hist = np.bincount(np.clip(np.round(v2).astype(int), 0, 400), minlength=402)
                lev = [h for h in range(1, 401) if hist[h] >= max(40, 0.06 * len(v2)) and hist[h] >= hist[h - 1] and hist[h] >= hist[h + 1]]
                if lev:
                    # levels closer than 2.5 m are one level with noise (two neighbouring 1 m bins): the larger stays
                    lev = sorted(lev, key=lambda h: -hist[h])
                    keep_ = []
                    for h in lev:
                        if all(abs(h - k_) >= 2.5 for k_ in keep_):
                            keep_.append(h)
                    lev = np.array(sorted(keep_), np.float32)
                    j = np.argmin(np.abs(v2[:, None] - lev[None]), axis=1)
                    k2 = np.abs(v2 - lev[j]) <= 1.5
                    n_c += int((k2 & (v2 != lev[j])).sum())
                    top[rr[k2], cc[k2]] = lev[j][k2]
                n_f += 1
            continue
        r0, c0 = rr.min(), cc.min()
        off = np.zeros((rr.max() - r0 + 1, cc.max() - c0 + 1), bool)
        off[rr - r0, cc - c0] = np.abs(v - med) > 2.5
        lab, n = ndimage.label(off)
        if n:
            size = ndimage.sum(off, lab, range(1, n + 1))
            keep = np.concatenate([[False], size >= 15])  # big blobs: real structures
            snap = ~keep[lab[rr - r0, cc - c0]]
        else:
            snap = np.ones(len(rr), bool)
        n_c += int((snap & (v != med)).sum())
        top[rr[snap], cc[snap]] = med
        n_f += 1
    note(f"flat roofs: {n_f} parts, {n_c} cells snapped")


flatten_roofs(top)
topi = np.where(bmask, np.round(top), 0).astype(np.int32)
boti = np.round(bot_rel).astype(np.int32)
bmask &= topi >= 2


# colours/materials per feature
SACRED = {"church", "cathedral", "chapel", "basilica", "synagogue", "mosque", "temple", "shrine"}
M_CLASSIC = 20


def wall_style(f):
    t = f["tags"]
    mat_tag = (tag(f, "building:material") or "").lower()
    col = parse_colour(t.get("building:colour") or t.get("colour")) or \
        (parse_colour(f["parent"]["tags"].get("building:colour")) if f.get("parent") else None)
    btype = tag(f, "building") or ""
    h = f["maxh"] or float(np.median(top[f["rr"], f["cc"]]))
    inside_pkin = pkin["geom"].contains(f["geom"].representative_point())
    if inside_pkin:
        # OSM tags the stone #C6AE7F, a khaki; in photos the weathered sandstone is a mid warm grey-beige (median 114,108,96 overcast)
        if col is None or col == hex_rgb("#c6ae7f"):
            col = hex_rgb("#857a65")  # lighter tones read pale cream in sun beside the photos (render 179,167,139 vs 104,100,87)
        return pal(soften(col, 0.05), M_PKIN)
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
    if btype in SACRED or tag(f, "amenity") == "place_of_worship":
        return pal(soften(col), M_CLASSIC)  # stone or brick, tall windows: not the shader's office grid of storeys
    return pal(soften(col), M_WALL)


ROOF_OVERRULED = []


def roof_style(f):
    col = parse_colour(tag(f, "roof:colour"))
    if col is None and (f["tags"].get("roof:material") or "").lower() == "glass":
        return pal(soften(hex_rgb("#93adbf"), 0.06), M_GLASS)  # glass atrium roofs (Politechnika's hall): blue-grey
    h = float(np.median(top[f["rr"], f["cc"]]))
    if pkin["geom"].contains(f["geom"].representative_point()) and col == hex_rgb("#666666"):
        # OSM's dark grey: the ortho shows light stone-grey roofs (its own colours carry the tower's shadow)
        return pal(soften(hex_rgb("#bab3a5"), 0.05), M_ROOF, q=12)
    if h < 40:
        cc = cellcol[f["rr"], f["cc"]]
        L = lum[f["rr"], f["cc"]]
        if len(L) >= 3:
            sel = cc[(L >= np.percentile(L, 25)) & (L <= np.percentile(L, 85))]
            oc = tuple(np.median(sel, axis=0))
            # an OSM roof colour far from what the ortho sees (a palace's #003300, near black, over a mid-green copper
            # roof) gives way to the ortho
            # (never towards darker: a roof in a tower's shadow reads dark in the ortho)
            lum_ = lambda c_: 0.299 * c_[0] + 0.587 * c_[1] + 0.114 * c_[2]
            # (only dark OSM colours, the near-black tags; a red or green roof tag is usually right)
            if col is None or (np.linalg.norm(np.subtract(col, oc)) > 110 and lum_(col) < 90 and lum_(oc) > lum_(col) - 15):
                if col is not None:
                    ROOF_OVERRULED.append((f["id"], tag(f, "roof:colour")))
                col = oc
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

# parts under 1 m wide along a bigger one (Focus's dark frame round its glass box, trims, fins): at 1 m they are one
# cell per step of a rotated wall, a dotted staircase that striped the whole facade -- they take the bigger part's wall
THIN_LOG = []
_pl = [f for f in render if f["part"] and f["maxh"]]
_thin, _thk = [], []
for f in _pl:
    rr_, cc_ = f["rr"], f["cc"]
    m_ = np.zeros((rr_.max() - rr_.min() + 3, cc_.max() - cc_.min() + 3), bool)
    m_[rr_ - rr_.min() + 1, cc_ - cc_.min() + 1] = True
    _mr = f["geom"].minimum_rotated_rectangle
    _xy = np.array(_mr.exterior.coords)
    _ang = math.degrees(math.atan2(_xy[1, 1] - _xy[0, 1], _xy[1, 0] - _xy[0, 0])) % 90
    rotated = 12 < _ang < 78  # on the grid a 1 m frame or band draws cleanly (Oxford Tower's white frame, Varso's bands)
    (_thin if ndimage.distance_transform_edt(m_).max() <= 1.5 and rotated else _thk).append(f)  # (1.41: 2 across on a diagonal)
_bb = np.array([(f["rr"].min(), f["rr"].max(), f["cc"].min(), f["cc"].max()) for f in _thk]) if _thk else np.zeros((0, 4))
n_thin = 0
for f in _thin:
    rr_, cc_ = f["rr"], f["cc"]
    lo_ = f["minh"] or 0
    # parts overlap (a lobby under a tower): every thick part within 2 m spanning the same storeys, the biggest wins
    k_ = np.nonzero((_bb[:, 0] <= rr_.max() + 2) & (_bb[:, 1] >= rr_.min() - 2) & (_bb[:, 2] <= cc_.max() + 2) & (_bb[:, 3] >= cc_.min() - 2))[0]
    best = None
    for k in k_:
        p_ = _thk[k]
        if abs(p_["maxh"] - f["maxh"]) > 6 or abs((p_["minh"] or 0) - lo_) > 6:
            continue
        r0_, c0_ = rr_.min() - 2, cc_.min() - 2
        m_ = np.zeros((rr_.max() - r0_ + 3, cc_.max() - c0_ + 3), bool)
        m_[rr_ - r0_, cc_ - c0_] = True
        m_ = ndimage.binary_dilation(m_, iterations=2)
        q_ = (p_["rr"] >= r0_) & (p_["rr"] < r0_ + m_.shape[0]) & (p_["cc"] >= c0_) & (p_["cc"] < c0_ + m_.shape[1])
        if q_.any() and m_[p_["rr"][q_] - r0_, p_["cc"][q_] - c0_].any() and (best is None or len(p_["rr"]) > len(best["rr"])):
            best = p_
    if best is not None:
        if best["wall"] != f["wall"]:
            THIN_LOG.append((f["id"], int(rr_.mean()), int(cc_.mean()), pal.entries[f["wall"]][:4], pal.entries[best["wall"]][:4], len(rr_)))
        f["wall"] = best["wall"]
        n_thin += 1
note("thin parts given their neighbour's wall:", n_thin, "of", len(_thin))
json.dump(THIN_LOG, open("data/debug/thin_parts.json", "w"))

note("OSM roof colours overruled by the ortho:", len(ROOF_OVERRULED), ROOF_OVERRULED[:8])
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
# an outline's cell outside all its parts, where the LiDAR stands as tall as a part within 4 m, is that part mapped a
# little small (the Telecom tower's beige concrete came out in the outline's brown glass): the part's wall
_parts = sorted([f for f in render if f["part"] and f["maxh"]], key=lambda f: f["maxh"])
_pid = np.zeros((D, W), np.int32)
for i_, f in enumerate(_parts, 1):
    _pid[f["rr"], f["cc"]] = i_
n_pw = 0
for f in render:
    if f["part"] or not f.get("has_parts"):
        continue
    if f["tags"].get("building:colour"):
        continue  # the outline has its own facade colour (a glass upper storey round a white part): it stays
    rr_, cc_ = f["rr"], f["cc"]
    r0_, c0_ = max(rr_.min() - 5, 0), max(cc_.min() - 5, 0)
    sub_ = _pid[r0_:rr_.max() + 6, c0_:cc_.max() + 6]
    if not (sub_ > 0).any():
        continue
    d_, (ir_, ic_) = ndimage.distance_transform_edt(sub_ == 0, return_indices=True)
    k_ = _pid[rr_, cc_] == 0
    for r_, c_ in zip(rr_[k_], cc_[k_]):
        i_, j_ = r_ - r0_, c_ - c0_
        if d_[i_, j_] > 4:
            continue
        p_ = _parts[sub_[ir_[i_, j_], ic_[i_, j_]] - 1]
        # a rim up to 2 m wide round a part (Focus: one outline cell per step of its rotated walls, striping its
        # glass in the outline's dark grey) as soon as it stands 70 % of the part's height; up to 4 m when as tall
        ok_ = (d_[i_, j_] <= 2 and topi[r_, c_] >= 0.7 * p_["maxh"]) or abs(p_["maxh"] - topi[r_, c_]) <= 6
        if ok_ and p_["wall"] != basewall[r_, c_]:
            basewall[r_, c_] = p_["wall"]
            n_pw += 1
note("outline cells given their adjacent part's wall:", n_pw)
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
# a green roof is an area, not a rim: the ortho's green along parapets (crowns hanging over the edge, copper, moss)
# put lime garden voxels on cornices and ledges all over the city. Opened by 1 cell, patches of 12+ cells, and not
# where the LiDAR stands 2 m above the roof (a crown over it)
green_roof &= nd_max < topi + 2
green_roof = ndimage.binary_opening(green_roof, iterations=1)
_gl, _gn = ndimage.label(green_roof)
if _gn:
    green_roof &= np.r_[False, ndimage.sum(green_roof, _gl, range(1, _gn + 1)) >= 12][_gl]
# a small step in a facade (a 1-3 m setback, a stair of a sloping wing, an edge left lower by the LiDAR) is wall, not
# roof: the building's roof colour (taken from the ortho over its whole top) put cream blobs and checkerboards on glass
# towers (Rondo 1, Złota 44's wing). Patches under 25 cells more than 6 m below the highest top within 3 m.
_ledge = bmask & (topi < ndimage.maximum_filter(np.where(bmask, topi, 0), 7) - 6)
_lab, _n = ndimage.label(_ledge)
if _n:
    _sz = ndimage.sum(_ledge, _lab, range(1, _n + 1))
    _ledge &= np.r_[False, _sz < 25][_lab]
roofcol = np.where(_ledge & ~green_roof, basewall, roofcol)
note("facade steps topped with wall colour:", int(_ledge.sum()))
rr, cc = np.nonzero(bmask)
vol[zt[rr, cc] - 1, rr, cc] = np.where(green_roof[rr, cc], C["garden"], roofcol[rr, cc])
note("green roof cells:", int(green_roof.sum()))
# rooftop plant rooms, lift housings and stair heads (1.5-5 m over a building's main roof, under 80 cells) are roof
# material, not facade: they wore the facade's office windows and read as little houses on every roof (Metropolitan)
n_rb = 0
for f in render:
    rr_, cc_ = f["rr"], f["cc"]
    if len(rr_) < 100 or f["part"]:
        continue
    t_ = topi[rr_, cc_]
    med_ = int(np.median(t_))
    if med_ < 6:
        continue
    up_ = (t_ > med_ + 1.5) & (t_ <= med_ + 5)  # a plant room, lift housing or stair head: one storey
    if not up_.any():
        continue
    m_ = np.zeros((rr_.max() - rr_.min() + 1, cc_.max() - cc_.min() + 1), bool)
    m_[rr_[up_] - rr_.min(), cc_[up_] - cc_.min()] = True
    lab_, nl_ = ndimage.label(m_)
    small_ = np.r_[False, ndimage.sum(m_, lab_, range(1, nl_ + 1)) < 80]
    # set back from the facade (none of it within 2 m of the outline's edge): a top storey flush with the facade
    # (Fabryczna 2's crown) is building, not plant room
    fp_ = np.zeros(m_.shape, bool)
    fp_[rr_ - rr_.min(), cc_ - cc_.min()] = True
    near_edge_ = ndimage.distance_transform_edt(np.pad(fp_, 1))[1:-1, 1:-1] <= 2
    flush_ = np.r_[False, ndimage.maximum(near_edge_ & m_, lab_, range(1, nl_ + 1)) > 0] if nl_ else np.zeros(1, bool)
    small_ &= ~flush_
    k_ = up_ & small_[lab_[rr_ - rr_.min(), cc_ - cc_.min()]]
    for r_, c_ in zip(rr_[k_], cc_[k_]):
        z0_, z1_ = int(g[r_, c_]) + med_, int(zt[r_, c_]) - 1
        col_ = vol[z0_:z1_, r_, c_]
        col_[col_ != 0] = roofcol[r_, c_]
        n_rb += 1
note("rooftop structures in roof material:", n_rb)

# ---------------------------------------------------------------- vegetation (LiDAR canopy + OSM trees)
trees = [(oid, t, p) for oid, t, p in osm.nodes if t.get("natural") == "tree"]
# every known tree: the city's green-areas database (inventory number, species, trunk), OSM, the 2010-13 inventory
import trees as treedb
all_trees, _tc = treedb.load(trees)
note("trees from the databases:", _tc, "total", len(all_trees))
tree_rc = np.array([(int(t["y"]), int(t["x"])) for t in all_trees])
near_tree = np.zeros((D, W), bool)
if len(tree_rc):
    near_tree[tree_rc[:, 0], tree_rc[:, 1]] = True
    near_tree = ndimage.binary_dilation(near_tree, iterations=3)
veg = (~bmask) & (nd_mean > 2.2) & ((exg > 0.025) | (near_tree & (exg > -0.03)))
# nor inside any building's outline: one drawn only through its parts (Salvator church) left the cells between its
# parts out of bmask, and its green copper roof grew 1 800 leaf voxels, pillars up its front
_allb = np.zeros((D, W), bool)
for f in feats:
    if not f["part"] and f["tags"].get("building") not in ("roof", "carport", "canopy"):
        _allb[f["rr"], f["cc"]] = True
note("vegetation cells inside building outlines dropped:", int((veg & _allb).sum()))
veg &= ~_allb
# LiDAR wall edges outside OSM footprints look like tall "trees": reject cells next to a building
# whose height is close to that building's roof
btop_near = ndimage.maximum_filter(np.where(bmask, topi, 0), size=7)
wall_edge = (btop_near > 0) & (nd_mean > 0.6 * btop_near) & (nd_mean > 6)
veg &= ~wall_edge | (near_tree & (nd_mean < 25))
step = ndimage.maximum_filter(nd_mean, 3) - ndimage.minimum_filter(nd_mean, 3)
veg &= ~((btop_near > 0) & (step > 7) & (nd_mean > 0.5 * btop_near))
veg &= nd_mean < 32  # no trees taller than ~30 m in central Warsaw
# no trees growing out of a stadium shell (its fins and roof edge are LiDAR-high and greenish in the ortho)
stad = np.zeros((D, W), np.uint16)
burn(stad, [(geom, 1) for oid, typ, t, geom in osm.areas_with("leisure", ("stadium",))])
veg &= ~((stad > 0) & ~near_tree)
veg = ndimage.binary_opening(veg, iterations=1)
note("wall-edge cells rejected as vegetation:", int(wall_edge.sum()))
lab, n = ndimage.label(veg)
sizes = ndimage.sum(veg, lab, range(1, n + 1))
veg &= np.isin(lab, np.nonzero(sizes >= 4)[0] + 1)
hs = ndimage.gaussian_filter(np.where(veg, nd_mean, 0), 2) / np.maximum(ndimage.gaussian_filter(veg.astype(float), 2), 1e-3)
crown_top = np.round(np.minimum(nd_mean, 40)).astype(np.int32)
# against a wall the DSM is the wall's (Telecom tower, Salvator: 1 m green pillars 20-30 m up the facades): within 2 m
# of a building a crown is no taller than its canopy away from the walls (gaussian mean x 1.25 + 2 m), 12 m with none
_nearb = ndimage.binary_dilation(bmask, iterations=2) & veg
_far = veg & ~ndimage.binary_dilation(bmask, iterations=2)
_wf = ndimage.gaussian_filter(_far.astype(np.float32), 3)
_hf = ndimage.gaussian_filter(np.where(_far, nd_mean, 0).astype(np.float32), 3) / np.maximum(_wf, 1e-3)
_cap = np.where(_wf > 0.05, _hf * 1.25 + 2, 12)
_clip = _nearb & (crown_top > _cap)
crown_top = np.where(_clip, np.round(_cap), crown_top).astype(np.int32)
note("crowns against walls clipped to their canopy:", int(_clip.sum()))
crown_bot = np.clip(np.round(hs * 0.38), 2, None).astype(np.int32)
crown_bot = np.minimum(crown_bot, crown_top - 1)
# leaf colour from ortho: luminance x hue bins
hue = np.zeros((D, W), np.float32)
r_, g_, b_ = cellcol[..., 0], cellcol[..., 1], cellcol[..., 2]
yellowish = (r_ - b_) / rgbsum > 0.05
lbin = np.clip(((lum - 40) / 110 * 5).astype(int), 0, 4)
leafidx = np.array(LEAVES, np.uint16)[(4 - lbin) + 5 * (~yellowish)]

# trunks: every known tree standing under a LiDAR crown gets one, from the ground up into its crown (the crown's leaf
# columns start at crown_bot, so the trunk's top voxel touches them face to face: the crown stands, it does not float);
# a known tree with no crown in the 2025 LiDAR (planted since) is drawn procedurally. Crowns that no database tree
# stands under get trunks at their tops (local maxima of the canopy height, >= 5 m apart).
n_new = n_trunk = 0
from shapely.ops import unary_union
zlota = unary_union([l for oid, t, l in osm.lines if t.get("name") == "Złota"])
canopy_near = ndimage.binary_dilation(veg, iterations=2)
_vd, (_vr, _vc) = ndimage.distance_transform_edt(~veg, return_indices=True)
trunk_at = np.zeros((D, W), bool)
# where a trunk may stand: never on a carriageway, rails, tram bed or in the water; a trunk placed only from the canopy
# (no tree known there) also not on paths and squares -- it would stand in the walkers' way -- but on soft ground
_hard = np.isin(gcol, [C[k] for k in ("water", "asphalt", "asphalt_l", "rail", "trambed", "ballast", "cycle", "parking")]) | is_road
trunk_ok_db = ~_hard
trunk_ok_peak = np.isin(gcol, [C[k] for k in ("grass", "grass2", "garden", "scrub", "dirt", "dirt2", "fresh", "bare", "soil",
                                               "flower", "flower2", "gravel")]) & ~is_road
_okd, (_okr, _okc) = ndimage.distance_transform_edt(~(trunk_ok_peak & veg), return_indices=True)
_dbd, (_dbr, _dbc) = ndimage.distance_transform_edt(~(trunk_ok_db & veg), return_indices=True)


trunks = []  # (row, col, thick): drawn once the crowns are shaped around them


trunk_conifer = []  # per trunk: a conifer by the database's species (or OSM leaf_type)


def put_trunk(r, c, thick=False, conifer=False):
    trunks.append((r, c, thick))
    trunk_conifer.append(conifer)
    trunk_at[r, c] = True


for t in all_trees:
    c, r = int(t["x"]), int(t["y"])
    if not (2 <= c < W - 2 and 2 <= r < D - 2) or bmask[r, c]:
        t["drawn"] = "none"
        continue
    if canopy_near[r, c]:
        if not veg[r, c] and _vd[r, c] <= 2.5:  # the point just off its crown's LiDAR cells: under the nearest one
            r, c = int(_vr[r, c]), int(_vc[r, c])
        if veg[r, c] and not trunk_ok_db[r, c] and _dbd[r, c] <= 3:  # mapped onto the road edge: to the kerb side
            r, c = int(_dbr[r, c]), int(_dbc[r, c])
        if veg[r, c]:
            put_trunk(r, c, thick=(t.get("trunk_cm") or 0) >= 250, conifer=treedb.is_conifer(t))
            t["drawn"] = "lidar"
            t["z"] = int(g[r, c])
            t["h"] = int(crown_top[r, c])
            n_trunk += 1
            continue
        t["drawn"] = "none"  # under another tree's crown edge: its own crown is not resolved
        continue
    n_new += 1
    # Zielona Złota (opened Aug 2026): elms planted at ~9 m (research.md)
    p = Point(t["x"], t["y"])
    hgt = (t.get("height") if t["src"] != "city" else None) or (9 if p.x > 1000 and p.distance(zlota) < 12 else None)
    landmarks.small_tree(vol, g, r, c, stable_hash(t["id"]), LEAVES, C["trunk"], height=hgt)
    t["drawn"] = "procedural"
    t["z"] = int(g[r, c])
note("trunks under LiDAR crowns at known trees:", n_trunk)
note("known trees without a 2025 LiDAR crown -> procedural:", n_new)
# crowns no database tree stands under: a trunk at each canopy top >= 5 m from any trunk
peak = veg & (nd_mean >= ndimage.maximum_filter(np.where(veg, nd_mean, 0), size=7)) & (nd_mean >= 4)
_td = ndimage.distance_transform_edt(~trunk_at)
pr_, pc_ = np.nonzero(peak & (_td >= 5))
order = np.argsort(-nd_mean[pr_, pc_])
taken = np.zeros((D, W), bool)
n_peak = 0
for k in order:
    r, c = int(pr_[k]), int(pc_[k])
    if taken[max(0, r - 4):r + 5, max(0, c - 4):c + 5].any():
        continue
    if not trunk_ok_peak[r, c]:  # the crown's top over a path or a road: the trunk on the nearest soft ground under it,
        if _okd[r, c] <= 4:      # else on the pavement (a street tree), never on the carriageway
            r, c = int(_okr[r, c]), int(_okc[r, c])
        elif not trunk_ok_db[r, c]:
            if _dbd[r, c] > 3:
                continue
            r, c = int(_dbr[r, c]), int(_dbc[r, c])
    put_trunk(r, c)
    taken[r, c] = True
    n_peak += 1
note("trunks at canopy tops with no known tree under them:", n_peak)
# crowns, one per trunk: every canopy cell belongs to its nearest trunk; the crown's underside is a dome -- lowest
# (38 % of the tree's height) over the trunk, rising to the LiDAR top at the crown's rim -- instead of one flat green
# ceiling over the whole park (the LiDAR gives only the top surface; the dome is the usual lime / maple / chestnut form)
if trunks:
    tidx = np.zeros((D, W), np.int32)
    for i_, (r_, c_, _) in enumerate(trunks, 1):
        tidx[r_, c_] = i_
    _dt, (_tr_, _tc_) = ndimage.distance_transform_edt(tidx == 0, return_indices=True)
    own = np.where(veg, tidx[_tr_, _tc_], 0)
    idx_ = np.arange(1, len(trunks) + 1)
    Rt = np.asarray(ndimage.maximum(np.where(veg, _dt, 0), labels=own, index=idx_), np.float32) + 0.7
    Ht = np.asarray(ndimage.maximum(np.where(veg, crown_top, 0), labels=own, index=idx_), np.float32)
    vr_, vc_ = np.nonzero(veg)
    k_ = own[vr_, vc_] - 1
    ok_ = k_ >= 0
    dep = 0.62 * Ht[k_] * np.sqrt(np.clip(1 - (_dt[vr_, vc_] / Rt[k_]) ** 2, 0, 1))
    bot = np.round(crown_top[vr_, vc_] - np.maximum(dep, 1)).astype(np.int32)
    bot = np.clip(bot, 2, crown_top[vr_, vc_] - 1)
    crown_bot[vr_[ok_], vc_[ok_]] = bot[ok_]
    # conifers (thuja, pine, spruce, yew...: the city database's species) in dark blue-green needles, not leaf green
    con = np.array(trunk_conifer, bool)
    cm_ = ok_.copy()
    cm_[ok_] = con[k_[ok_]]
    NEEDLES = np.array([pal(c_, M_LEAF) for c_ in ("#3f5f48", "#456a4f", "#4d7356", "#37553f", "#52785a")], np.uint16)
    leafidx[vr_[cm_], vc_[cm_]] = NEEDLES[(vr_[cm_] * 7 + vc_[cm_] * 3) % len(NEEDLES)]
    note("conifer crowns (database species):", int(con.sum()), "cells", int(cm_.sum()))
rr, cc = np.nonzero(veg)
for zz in range(int(g.min()) + 1, int((g + crown_top).max()) + 1):
    m = (zz >= g[rr, cc] + crown_bot[rr, cc]) & (zz < g[rr, cc] + crown_top[rr, cc])
    sel = (rr[m], cc[m])
    cur = vol[zz][sel]
    vol[zz][sel] = np.where(cur == 0, leafidx[sel], cur)
note("canopy cells:", int(veg.sum()), "crowns:", len(trunks))
for r_, c_, thick in trunks:  # from the ground one voxel into the crown's lowest point, over the trunk
    hb = int(crown_bot[r_, c_]) + 1
    for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)) if thick else ((0, 0),):
        rr_, cc_ = r_ + dr, c_ + dc
        if 0 <= rr_ < D and 0 <= cc_ < W and not bmask[rr_, cc_]:
            vol[g[rr_, cc_]:g[rr_, cc_] + hb, rr_, cc_] = C["trunk"]
# the tree register for the viewer (ids for later mapping: city inventory number / osm node / 2010-13 inventory)
note("trees inside a Mapa Koron Drzew crown:", treedb.attach_crowns(all_trees))
for r, c in zip(*np.nonzero(taken)):  # the trunks placed at canopy tops: no database tree, an id from the cell
    all_trees.append(dict(id=f"lidar:{r}_{c}", src="lidar", x=float(c) + 0.5, y=float(r) + 0.5, drawn="lidar",
                          z=int(g[r, c]), h=int(crown_top[r, c])))
_tr = []
for t in all_trees:
    rec = dict(id=t["id"], x=round(t["x"], 1), y=round(t["y"], 1), src=t["src"], drawn=t.get("drawn"))
    for k_src, k_out in (("z", "z"), ("h", "h"), ("species", "sp"), ("species_pl", "pl"), ("trunk_cm", "cm"),
                         ("osm", "osm"), ("um_id", "um"), ("height", "h_inv"), ("crown_d", "crown_d"),
                         ("condition", "cond"), ("manager", "mgr"), ("date", "date"), ("crown_id", "crown"),
                         ("crown_m2", "crown_m2"), ("crown_sp", "crown_sp")):
        if t.get(k_src) is not None:
            rec[k_out] = t[k_src]
    _tr.append(rec)
Path(OUT).mkdir(parents=True, exist_ok=True)
json.dump(dict(sources={"city": "Baza Obiektów Zieleni, mapa.um.warszawa.pl (Zieleń)", "osm": "OpenStreetMap natural=tree",
                        "um": "api.um.warszawa.pl drzewa (2010-13 inventory)",
                        "lidar": "a crown in the 2025 LiDAR with no known tree under it (trunk at its top)",
                        "crown": "Mapa Koron Drzew (2019) polygon the tree stands in"},
               fields=dict(x="grid column", y="grid row", z="ground voxel", h="LiDAR crown top above ground, m",
                           sp="species (Latin)", pl="species (Polish)", cm="trunk circumference, cm",
                           drawn="lidar | procedural | none"), trees=_tr),
          open(Path(OUT) / "trees.json", "w"), ensure_ascii=False, separators=(",", ":"))

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

# bridges / decks: over the rail cut (DTM drops below them) and the Vistula. The deck follows the bridge ways
# (bridge=yes roads, paths, tracks buffered to their width; man_made=bridge areas only near them). Its top takes the
# colour of the way on it (asphalt, pavement, cycle lane, tram bed).
deck_col = np.zeros((D, W), np.uint16)
deck_lay = np.zeros((D, W), np.uint16)  # the layer of the way that owns the cell
bridge_area = np.zeros((D, W), np.uint16)
burn(bridge_area, [(geom, 1) for oid, typ, t, geom in osm.areas_with("man_made", ("bridge",))])
for layer in sorted({l for _, _, l in bridge_shapes}):  # upper decks win
    burn(deck_col, [(p_, c_) for p_, c_, l in sorted(bridge_shapes, key=lambda x: -x[0].area) if l == layer])
    burn(deck_lay, [(p_, l + 1) for p_, c_, l in bridge_shapes if l == layer])
near_way = ndimage.binary_dilation(deck_col > 0, iterations=3)
deck_col = np.where((deck_col == 0) & (bridge_area > 0) & near_way, C["deck"], deck_col)
deck = (deck_col > 0) & ~bmask & (nd_mean > 2)
deck = ndimage.binary_closing(deck, iterations=2) & ~bmask  # no slits of sky between the carriageways
deck_col = np.where(deck & (deck_col == 0), C["deck"], deck_col)
# the deck's height: a profile along each bridge way -- the DSM (0.5 m) sampled across the way every metre, its 30th
# percentile (the road surface, not the cars, railings or stays), samples dropped where a higher deck hides the way or
# nothing stands above the river, then a 25 m running median and a 15 m mean. Every deck cell takes the height of the
# nearest profile point of its own layer: one smooth level, so cars drive on it. (The cell-by-cell lowest return
# picked up cells half over the water at the deck edges and broke the decks into steps metres apart.)
from scipy.spatial import cKDTree
water_ = gcol == C["water"]
prof = []  # per way: (x, y, h, layer) every metre
for line, hw, layer, _ in bridge_lines:
    n_ = max(2, int(line.length) + 1)
    P_ = np.array([line.interpolate(v_).coords[0] for v_ in np.linspace(0, line.length, n_)])
    T_ = np.gradient(P_, axis=0)
    T_ /= np.maximum(np.linalg.norm(T_, axis=1, keepdims=True), 1e-6)
    a_, b_ = np.meshgrid(np.arange(-1.5, 1.6, 0.5), np.arange(-max(0.7 * hw, 0.5), max(0.7 * hw, 0.5) + 0.01, 0.5))
    a_, b_ = a_.ravel(), b_.ravel()
    X_ = P_[:, :1] + T_[:, :1] * a_ - T_[:, 1:] * b_
    Y_ = P_[:, 1:] + T_[:, 1:] * a_ + T_[:, :1] * b_
    h_ = np.nanpercentile(dsm[np.clip((Y_ * 2).astype(int), 0, 2 * D - 1), np.clip((X_ * 2).astype(int), 0, 2 * W - 1)], 30, axis=1)
    pr_, pc_ = np.clip(P_[:, 1].astype(int), 0, D - 1), np.clip(P_[:, 0].astype(int), 0, W - 1)
    gd_ = dtm[pr_, pc_]
    ok_ = np.isfinite(h_) & (deck_lay[pr_, pc_] <= layer + 1) & ((h_ > gd_ + 1.5) | (~water_[pr_, pc_] & (h_ > gd_ - 1.5)))
    if ok_.sum() >= 2:
        h_ = np.interp(np.arange(n_), np.nonzero(ok_)[0], h_[ok_])
    else:  # hidden all along (a walkway slung under a higher deck): straight between its ends' ground
        h_ = np.linspace(gd_[0], gd_[-1], n_)
    for win in (61, 31, 15):  # the deck is the lowest surface: knock down what stands on it (a pylon's legs, cables)
        hs_ = ndimage.median_filter(h_, min(win, n_), mode="nearest")
        h_ = np.where(h_ > hs_ + 0.6, hs_, h_)
    prof.append(np.column_stack([P_, h_, np.full(n_, layer + 1)]))
deck_abs = np.zeros((D, W), np.float32)
if prof:
    # across the deck the ways agree: no way stands more than 0.5 m above the lower quartile of its layer within 10 m
    allp = np.vstack(prof)
    for L_ in np.unique(allp[:, 3]):
        sel_ = allp[:, 3] == L_
        sub_ = allp[sel_]
        nb_ = cKDTree(sub_[:, :2]).query_ball_point(sub_[:, :2], 10.0)
        q_ = np.array([np.percentile(sub_[i_, 2], 25) for i_ in nb_])
        allp[sel_, 2] = np.minimum(sub_[:, 2], q_ + 0.5)
    k0 = 0
    for i_, pw_ in enumerate(prof):
        h_ = allp[k0:k0 + len(pw_), 2]
        n_ = len(h_)
        pw_[:, 2] = ndimage.uniform_filter1d(ndimage.median_filter(h_, min(25, n_), mode="nearest"), min(15, n_), mode="nearest")
        k0 += n_
    # a bridge way often ends (in OSM) metres before the ground climbs back to the deck: the deck carries on along the
    # way's direction, level, until the ground is within 1.5 m of it (up to 15 m) -- no hole for the cars to drop into
    ext_shapes = []
    for (line, hw, layer, col_), pw_ in zip(bridge_lines, list(prof)):
        if len(pw_) < 3:
            continue
        for e0, e1 in ((0, 2), (-1, -3)):
            P0, h0 = pw_[e0, :2], pw_[e0, 2]
            u_ = P0 - pw_[e1, :2]
            u_ = u_ / max(np.linalg.norm(u_), 1e-6)
            ext = []
            for d_ in range(1, 16):
                q = P0 + u_ * d_
                r_, c_ = int(q[1]), int(q[0])
                if not (0 <= r_ < D and 0 <= c_ < W) or dtm[r_, c_] >= h0 - 1.5 or bmask[r_, c_]:
                    break
                ext.append(q)
            if not ext:
                continue
            ext_shapes.append((LineString([P0, ext[-1]]).buffer(max(hw, 1.5), cap_style="flat"), col_, layer + 1))
            prof.append(np.column_stack([np.array(ext), np.full(len(ext), h0), np.full(len(ext), layer + 1)]))
    for L_ in sorted({l for _, _, l in ext_shapes}):
        m_ = np.zeros((D, W), np.uint16)
        burn(m_, [(p_, c_) for p_, c_, l in ext_shapes if l == L_])
        m_ = np.where((m_ > 0) & ~bmask & (deck_lay <= L_) & ~deck, m_, 0)
        deck_col[m_ > 0] = m_[m_ > 0]
        deck_lay[m_ > 0] = L_
        deck |= m_ > 0
    note("bridge ends carried on to meet the ground:", len(ext_shapes))
    prof = np.vstack(prof)
    rr, cc = np.nonzero(deck)
    for L_ in np.unique(deck_lay[rr, cc]):
        sel = deck_lay[rr, cc] == L_
        pts = prof if L_ == 0 or not (prof[:, 3] == L_).any() else prof[prof[:, 3] == L_]
        _, k_ = cKDTree(pts[:, :2]).query(np.column_stack([cc[sel] + 0.5, rr[sel] + 0.5]))
        deck_abs[rr[sel], cc[sel]] = pts[k_, 2]
zt_ = np.round(deck_abs - BASE).astype(np.int32)
deck &= zt_ >= g + 2
deck_h = np.where(deck, zt_ - g, 0).astype(np.float32)
landmarks.DECK = np.where(deck, zt_, 0).astype(np.int16)  # the deck top, for the curated bridge structures
# under a deck over the river nothing hangs but the bridge's own structure (landmarks.py): LiDAR columns caught at the
# deck edge (catenary masts, railings, green from the ortho) were extruded into dangling bits; and no tree crown grows
# into the underside of a deck anywhere
_leafy = np.zeros(len(pal.entries) + 64, bool)
_leafy[[i for i, e in enumerate(pal.entries) if e[3] == M_LEAF] + [C["trunk"]]] = True
_rw, _cw = np.nonzero(deck)
_wet = water_[_rw, _cw]
for _z in range(int(g.min()), int(zt_.max()) + 6):
    _m = (_z >= g[_rw, _cw]) & (_z < zt_[_rw, _cw] + 6)
    _v = vol[_z, _rw[_m], _cw[_m]]
    _under = _z < zt_[_rw[_m], _cw[_m]] - 2
    vol[_z, _rw[_m], _cw[_m]] = np.where((_under & _wet[_m]) | _leafy[_v], 0, _v)  # (a crown poking through the deck too)
rr, cc = np.nonzero(deck)
if len(rr):
    zt_ = zt_[rr, cc]
    for dz in (1, 2):
        vol[zt_ - dz, rr, cc] = C["deck"]
    vol[zt_ - 1, rr, cc] = deck_col[rr, cc]
note("bridge deck cells:", int(deck.sum()))
# bridge pylons (Most Świętokrzyski's ~90 m mast): compact LiDAR blobs far above the deck inside a bridge
pyl = (bridge_area > 0) & (nd_max > np.where(deck_h > 0, deck_h, nd_mean) + 45) & ~bmask  # the stays fan out low; only the mast stands this high
pyl = ndimage.binary_opening(pyl, iterations=2)  # the cable-stay fan is a thin sheet in the LiDAR; the mast is thick
lab_, n_ = ndimage.label(pyl)
n_pyl = 0
for i_, sl in enumerate(ndimage.find_objects(lab_), 1):
    m_ = lab_[sl] == i_
    if m_.sum() < 6 or max(m_.shape) > 25:  # a mast is compact; a long sheet is the cable fan
        continue
    for r_, c_ in zip(*np.nonzero(m_)):
        r_, c_ = r_ + sl[0].start, c_ + sl[1].start
        z0_, z1_ = int(g[r_, c_]), int(g[r_, c_] + round(float(nd_max[r_, c_])))
        vol[z0_:z1_, r_, c_] = np.where(vol[z0_:z1_, r_, c_] == 0, C["fence"], vol[z0_:z1_, r_, c_])
    n_pyl += 1
note("bridge pylons from LiDAR:", n_pyl)
# Most Świętokrzyski's stays (LiDAR only catches them as a blur): an A-pylon on the Praga bank, 87.5 m above the river,
# 48 cables 51-171 m long in a semi-fan over spans of 180 m (river) + 140 m -> 12 per side per plane, anchored down
# the top 30 m of the pylon, landing on both deck edges (structurae.net/structures/swietokrzyski-bridge, ITB 2001)
from shapely.ops import linemerge as _lm
_sw = _lm([l for oid, t, l in osm.lines if t.get("name") == "Most Świętokrzyski" and t.get("highway") in ROADS])
_sw = max(getattr(_sw, "geoms", [_sw]), key=lambda l: l.length) if not _sw.is_empty else None
n_cab = 0
stay = pal("#c9cdd0")  # matte grey-white: the shiny metal read as glare from afar
if _sw is not None and n_pyl:
    lab_, _ = ndimage.label(pyl)
    blobs = [(i_, sl) for i_, sl in enumerate(ndimage.find_objects(lab_), 1) if sl is not None]
    best = None
    for i_, sl in blobs:
        rr_, cc_ = np.nonzero(lab_[sl] == i_)
        cy_, cx_ = rr_.mean() + sl[0].start, cc_.mean() + sl[1].start
        dd = _sw.distance(Point(cx_, cy_))
        if dd < 25 and (best is None or dd < best[0]):
            hz = float(max(g[r_ + sl[0].start, c_ + sl[1].start] + nd_max[r_ + sl[0].start, c_ + sl[1].start] for r_, c_ in zip(rr_, cc_)))
            best = (dd, cx_, cy_, hz)
    if best:
        _, px, py, ptop = best
        sp = _sw.project(Point(px, py))
        L = _sw.length
        # the pylon as the photos and the LiDAR show it: an A-frame across the deck, two 2.5 m legs piercing the deck
        # between the carriageways and the cycle paths (+-10 m; the 2025 returns at 5-15 m above the deck) leaning in
        # to meet 50 m above it, then a single 3 m mast to the top; the LiDAR blob extruded from the ground read as a
        # solid tower
        q0, q1 = _sw.interpolate(max(sp - 2, 0)), _sw.interpolate(min(sp + 2, L))
        tx_, ty_ = q1.x - q0.x, q1.y - q0.y; tl = max(math.hypot(tx_, ty_), 1e-6); tx_, ty_ = tx_ / tl, ty_ / tl
        nx_, ny_ = -ty_, tx_
        pr, pc = int(py), int(px)
        gz_ = int(g[pr, pc])
        dz_ = gz_ + int(deck_h[pr, pc] if deck_h[pr, pc] > 0 else 12)
        rr0, rr1, cc0, cc1 = pr - 30, pr + 31, pc - 30, pc + 31
        blk = vol[dz_ + 1:, rr0:rr1, cc0:cc1]
        blk[blk == C["fence"]] = 0
        sub = vol[gz_:dz_ - 2, rr0:rr1, cc0:cc1]
        sub[sub == C["fence"]] = 0
        pylc = pal("#d6d8d6", M_CONCRETE)
        zmeet = dz_ + 50
        for zz in range(gz_, int(ptop) + 1):
            w_ = 10.0 if zz <= dz_ else max(0.0, 10.0 * (zmeet - zz) / (zmeet - dz_))
            for lat in ((-1, 1) if w_ > 1.2 else (0,)):
                for a in np.arange(-1.25, 1.3, 0.5):
                    for b in np.arange(-1.25, 1.3, 0.5):
                        if lat == 0 and (abs(a) > 1.5 or abs(b) > 1.0):
                            continue
                        x_ = px + tx_ * a + nx_ * (lat * w_ + b)
                        y_ = py + ty_ * a + ny_ * (lat * w_ + b)
                        vol[zz, int(y_), int(x_)] = pylc
        for side, span in ((-1, 180.0), (1, 140.0)):
            for k in range(12):
                d = 30 + (span - 35) * (k + 1) / 12
                s_ = sp + side * d
                if not (0 <= s_ <= L):
                    continue
                q0, q1 = _sw.interpolate(s_), _sw.interpolate(min(s_ + 1, L))
                tx_, ty_ = q1.x - q0.x, q1.y - q0.y
                tl = max(math.hypot(tx_, ty_), 1e-6)
                za = ptop - 2 - 28 * (k / 11)  # anchors spread down the pylon head: semi-fan
                for lat in (-1, 1):
                    ex, ey = q0.x - ty_ / tl * lat * 9, q0.y + tx_ / tl * lat * 9  # two inclined planes landing +-9 m (LiDAR)
                    er, ec = int(ey), int(ex)
                    if not (0 <= er < D and 0 <= ec < W):
                        continue
                    ez = g[er, ec] + (deck_h[er, ec] if deck_h[er, ec] > 0 else 12) + 1
                    # one voxel per step along the major axis: a thin straight line, not a rope of double voxels; where
                    # a step moves along two or three axes at once, the voxels in between too, so the stay is one
                    # face-connected chain from pylon to deck (corner-touching voxels hold nothing up)
                    n = int(max(abs(ex - px), abs(ey - py), abs(ez - za))) + 1
                    prev = None
                    for j in range(n + 1):
                        f_ = j / n
                        x_, y_, z_ = px + (ex - px) * f_, py + (ey - py) * f_, za + (ez - za) * f_
                        cur = [int(y_), int(x_), int(z_)]
                        pts_ = [cur]
                        if prev is not None:
                            p_ = list(prev)
                            pts_ = []
                            for ax in (2, 0, 1):  # down first, then across
                                if p_[ax] != cur[ax]:
                                    p_[ax] = cur[ax]
                                    pts_.append(tuple(p_))
                        for r_, c_, zz_ in pts_:
                            if 0 <= r_ < D and 0 <= c_ < W and 0 <= zz_ < vol.shape[0] and vol[zz_, r_, c_] == 0:
                                vol[zz_, r_, c_] = stay
                        prev = cur
                    n_cab += 1
note("Most Świętokrzyski stays:", n_cab)
# lamps on the bridges: OSM maps almost none on the Vistula bridges (0 on Świętokrzyski and Poniatowskiego), but they
# are lit -- put one every 32 m on each kerb of the deck, as for Złota, unless OSM has a lamp within 12 m
n_bl = 0
for line, w in bridge_roads:
    for k_, dist in enumerate(np.arange(10, line.length - 6, 32.0)):
        p = line.interpolate(dist)
        q_ = line.interpolate(min(dist + 1, line.length))
        tx, ty = q_.x - p.x, q_.y - p.y
        tl = max(np.hypot(tx, ty), 1e-6)
        for side in (-1, 1):
            off = side * (w / 2 + 0.4)
            c, r = int(p.x - ty / tl * off), int(p.y + tx / tl * off)
            if not (0 <= c < W and 0 <= r < D) or not deck[r, c]:
                continue
            if len(lamp_xy) and np.min(np.hypot(lamp_xy[:, 0] - c, lamp_xy[:, 1] - r)) < 12:
                continue
            z0 = int(g[r, c] + round(float(deck_h[r, c])))
            vol[z0:z0 + 8, r, c] = np.where(vol[z0:z0 + 8, r, c] == 0, C["pole"], vol[z0:z0 + 8, r, c])
            vol[z0 + 8, r, c] = C["lamp"]
            lamps.append((c, r, int(z0 + 8)))
            lamp_xy = np.vstack([lamp_xy, [c, r]])
            n_bl += 1
note("inferred lamps on bridge decks (OSM has almost none):", n_bl)

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
floods = landmarks.apply_stripes(vol, g, bmask, pal, osm, cells_of, note)
leaf_ids = {i for i, e in enumerate(pal.entries) if e[3] in (M_LEAF,)}
# where a hanging building piece may carry its walls down (1: inside a building outline) or needs posts (2: roof-only)
bkind = np.zeros((D, W), np.uint8)
ROOFY = {"roof", "carport", "canopy", "shelter"}
for f in feats:  # walls may come down only inside an outline that itself stands on the ground (not a part on stilts,
    # not a raised passage: a connector 4-9 m over the street got filled solid to the ground)
    if not f["part"] and (f["minh"] or 0) < 2.5 and f["tags"].get("building") not in ROOFY:
        bkind[f["rr"], f["cc"]] = 1
for f in feats:
    if f["tags"].get("building") in ROOFY or f["tags"].get("building:part") == "roof":
        bkind[f["rr"], f["cc"]] = 2
from shapely.geometry import Polygon as _Poly
landmarks.PIERS = [_Poly(l.coords) for oid, t, l in osm.lines if t.get("bridge:support") and l.is_closed and len(l.coords) >= 4]
if os.environ.get("LMCACHE"):  # the volume before the curated landmark details, for scripts/patch.py
    import pickle
    Path("data/cache").mkdir(parents=True, exist_ok=True)
    np.save("data/cache/pre_vol.npy", vol)
    pickle.dump(dict(g=g, feats=feats, deck=landmarks.DECK, bkind=bkind, trunk=C["trunk"], pole=C["pole"],
                     trunk_ok=trunk_ok_db, piers=landmarks.PIERS),
                open("data/cache/pre_state.pkl", "wb"))
labels, views = landmarks.details(vol, g, top, topi, bmask, feats, pal, C, osm, cells_of, note, leaf_ids)
np.savez_compressed("data/debug/pkin_box.npz", vol=vol[:, 1080:1380, 600:900], g=g[1080:1380, 600:900],
                    pal=np.array(pal.entries, np.int32))  # PKiN's block for facade work (r0=1080, c0=600)

# label footprint radius (the viewer hides a label only when something *else* is in the way; a ray hitting the
# labelled building itself doesn't count) -- computed here because the viewer streams and has no whole-city voxels
abs_top = g + np.where(bmask, topi, 0)
for l in labels:
    r, c = int(l["y"]), int(l["x"])
    gg = int(g[min(max(r, 0), D - 1), min(max(c, 0), W - 1)])
    l["g"] = gg
    thr = gg + max(6, (l["z"] - gg) * 0.4)
    r0, r1, c0, c1 = max(r - 220, 0), min(r + 221, D), max(c - 220, 0), min(c + 221, W)
    lab_, _ = ndimage.label(abs_top[r0:r1, c0:c1] >= thr)
    k = lab_[r - r0, c - c0] if (0 <= r - r0 < lab_.shape[0] and 0 <= c - c0 < lab_.shape[1]) else 0
    if k:
        rr_, cc_ = np.nonzero(lab_ == k)
        l["R"] = round(float(np.hypot(rr_ + r0 - r, cc_ + c0 - c).max()), 1)
    else:
        l["R"] = 0.0

# ---------------------------------------------------------------- floating debris
import debris
debris.drop_debris(vol, g, np.array([i for i, e in enumerate(pal.entries) if e[3] == M_LEAF] + [C["trunk"]], dtype=vol.dtype), note)

# ---------------------------------------------------------------- export
Hm = int(np.nonzero(vol.reshape(H, -1).any(axis=1))[0].max()) + 1
vol = vol[:Hm]
note("final height", Hm, "palette", len(pal.entries))
# the ground as the tiles show it before the foliage (grass as bare earth), for terrain.py: the first moment of loading
_ids = vol[g - 1, np.arange(D)[:, None], np.arange(W)[None, :]]
_lut = np.array([e[:3] for e in pal.entries], np.uint8)
_lut[[i for i, e in enumerate(pal.entries) if e[3] == M_GRASS]] = _lut[C["bare"]]
np.savez_compressed("data/ground.npz", g=g.astype(np.int16), rgb=_lut[_ids],
                    b=np.where(bmask, topi, 0).astype(np.int16))  # building height above ground (photo-pose tools)
import tiles
EXPORT_IDS = dict(keep_ids={i for i, e in enumerate(pal.entries) if e[3] == M_LAMP},
                         skip_ids={i for i, e in enumerate(pal.entries) if e[3] == M_LEAF} | {C["trunk"]},
                         face_ids={i for i, e in enumerate(pal.entries) if e[3] == M_CLOCK},
                         fol_ids={i for i, e in enumerate(pal.entries) if e[3] == M_LEAF} | {C["trunk"]},
                         grass_ids={i for i, e in enumerate(pal.entries) if e[3] == M_GRASS}, bare_id=C["bare"])
# nothing hangs in the air: crowns get trunks, building pieces walls or posts, specks go (debris.support_floating)
debris.support_floating(vol, g, pal, bkind, note, C["trunk"], C["pole"], trunk_ok=trunk_ok_db)
if os.environ.get("FINALDUMP"):  # the finished volume, for whole-city checks (scripts/floating.py)
    np.save("data/cache/final_vol.npy", vol)
    np.save("data/cache/final_g.npy", g)
tile_info = tiles.export(vol, g, OUT / "tiles", note, **EXPORT_IDS)
if os.environ.get("LMCACHE"):
    pickle.dump(dict(EXPORT_IDS, debris_keep=[i for i, e in enumerate(pal.entries) if e[3] == M_LEAF] + [C["trunk"]]),
                open("data/cache/export_ids.pkl", "wb"))
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
meta = dict(W=W, D=D, H=Hm, base=BASE, tiles=tile_info, center=[CX, CY], theta_deg=math.degrees(THETA), crs="EPSG:2180", trams=trams, jets=jets,
            palette=[list(e) for e in pal.entries], lamps=lamps, floods=floods, labels=labels, views=views,
            sources=dict(osm=osm.timestamp, lidar="GUGiK NMPT/NMT 2025 (GK-FOTO.6201.5.2025)",
                         ortho="GUGiK ortofotomapa 2025, 5 cm"))
json.dump(meta, open(OUT / "meta.json", "w"))
import traffic
# QA aid: drivable-surface mask (1 = carriageway/road area, 2 = tram bed) for web/tools/qa.mjs
qa = np.zeros((D, W), np.uint8)
qa[is_road] = 1
qa[np.isin(gcol, [C["trambed"], C["rail"]])] = 2
with gzip.GzipFile(OUT / "qa_roadmask.bin.gz", "wb", compresslevel=9, mtime=0) as fh:  # mostly zeros: 12 MB -> ~0.3 MB
    fh.write(qa.tobytes())
# vehicles on a bridge way take the deck under them, or the nearest deck cell within 2 m (a way's centreline can run
# just off the deck)
_dd, (_ir, _ic) = ndimage.distance_transform_edt(~deck, return_indices=True)
deck_near = np.where(_dd <= 2, deck_h[_ir, _ic], 0).astype(np.float32)
# off the deck mask, on a bridge way (a viaduct whose arches are OSM buildings, a deck end): the top of what the
# voxels hold there -- lamps, poles and leaves aside -- within the LiDAR's reach
_skip = np.zeros(len(pal.entries) + 64, bool)
_skip[[i for i, e in enumerate(pal.entries) if e[3] in (M_LEAF, M_LAMP, M_CAR)] + [C["trunk"], C["pole"], C["fence"]]] = True
_rb, _cb = np.nonzero((deck_col > 0) & (_dd > 2))
_lim = g[_rb, _cb] + np.clip(np.round(nd_mean[_rb, _cb]), 0, 40).astype(int) + 3
_top = g[_rb, _cb].copy()
for _z in range(int(g.min()), int(_lim.max()) + 1):
    _m = (_z >= g[_rb, _cb]) & (_z < _lim)
    _v = vol[_z, _rb[_m], _cb[_m]]
    _top[np.nonzero(_m)[0][(_v != 0) & ~_skip[_v]]] = _z + 1
deck_near[_rb, _cb] = _top - g[_rb, _cb]
json.dump(traffic.build(g, deck_near, note, qa, water=(gcol == C["water"]) & (_dd <= 2)), open(OUT / "traffic.json", "w"), separators=(",", ":"))
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
