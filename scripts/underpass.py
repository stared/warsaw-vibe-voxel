"""Pedestrian underpasses: the passages OSM maps one level under the street (Solec by the Sappers, Rondo Dmowskiego,
Centralna, Świętokrzyska) carved into the ground as corridors 3 m high under a 1 m slab, and the stairs down to them
cut as open stairwells with a parapet round them. The LiDAR saw only part way down a stairwell: its ragged pit is filled
back to the street first. Deeper levels (the metro's concourses) are left solid; their stairs from the street are cut
down to the first level. WALK holds the walking level of every carved cell for traffic.py, IDS the ways walked.
"""
import json

import numpy as np
from pyproj import Transformer
from rasterio.features import rasterize
from affine import Affine
from shapely.geometry import LineString
from shapely.strtree import STRtree

from aoi import RAW, to_grid

WALK = None
IDS = set()
FOOT = ("footway", "path", "pedestrian", "cycleway", "corridor")
_T = Transformer.from_crs(4326, 2180, always_xy=True)


def _levels(t):
    out = []
    for k in ("level", "layer"):
        for v in str(t.get(k, "")).replace(",", ";").split(";"):
            try:
                out.append(float(v))
            except ValueError:
                pass
    return out


def ways(osm):
    """(tunnels, stairs): the passages one level down outside buildings, and the steps from the street to them, each
    (way id, [node ids], LineString in grid metres)"""
    data = json.load(open(f"{RAW}/osm.json"))
    blds = [g for _, _, t, g in osm.areas if "building" in t]
    tree = STRtree(blds)
    inside = lambda ln: any(blds[i].contains(ln.centroid) for i in tree.query(ln.centroid))
    tun, other = [], []
    for e in data["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or t.get("highway") not in FOOT + ("steps",) or not e.get("geometry") or None in e["geometry"]:
            continue
        if t.get("tunnel") == "building_passage" or t.get("indoor") == "yes" or t.get("location") == "indoor":
            continue
        lv = _levels(t)
        down = t.get("tunnel") == "yes" or t.get("location") == "underground" or any(v < 0 for v in lv)
        if any(v < -1 for v in lv) or t.get("bridge") not in (None, "no"):
            continue
        ln = LineString([to_grid(*_T.transform(p["lon"], p["lat"])) for p in e["geometry"]])
        if ln.length < 1 or inside(ln):
            continue
        w = (e["id"], e["nodes"], ln)
        (tun if down and t["highway"] != "steps" and 0 not in lv else other).append(w)
    tnodes = {n for _, ns, _ in tun for n in ns}
    hw = {e["id"]: e["tags"]["highway"] for e in data["elements"] if e["type"] == "way" and "highway" in e.get("tags", {})}
    # the landing at a stairwell's foot: a short plain footway from a passage's end, open to the sky (Solec's)
    land = [w for w in other if hw[w[0]] != "steps" and w[2].length < 15 and tnodes & set(w[1])]
    lnodes = tnodes | {n for _, ns, _ in land for n in ns}
    steps = [w for w in other if hw[w[0]] == "steps" and (w[1][0] in lnodes or w[1][-1] in lnodes)]
    return tun, land, steps


def _cells(geom, D, W):
    c0, r0, c1, r1 = (int(v) for v in geom.bounds)
    c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1 + 1, W), min(r1 + 1, D)
    if c1 <= c0 or r1 <= r0:
        return np.zeros(0, int), np.zeros(0, int)
    m = rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=Affine.translation(c0, r0))
    rr, cc = np.nonzero(m)
    return rr + r0, cc + c0


def build(vol, g, pal, C, osm, note):
    global WALK
    D, W = g.shape
    WALK = np.full((D, W), -1, np.int16)
    IDS.clear()
    tun, land, steps = ways(osm)
    floor, wall, rail = C["paving2"], pal("#a9a59c"), pal("#c9c6be")
    roads = [C[k] for k in ("asphalt", "asphalt_l", "mark", "parking", "trambed", "sett", "cycle", "hatch", "road_paving")]
    # the street over each passage: the highest ground along it; the corridor's walking level 4 m under it
    level = {}
    for wid, ns, ln in tun + land:
        rr, cc = _cells(ln.buffer(0.5), D, W)
        if not len(rr):
            continue
        street = int(np.percentile(g[rr, cc], 90))
        for n in ns:
            level[n] = min(level.get(n, 10 ** 6), street - 4)
    n_t = n_s = 0
    for wid, ns, ln in steps:  # stairwells first: fill the LiDAR's pit to the street, then cut the stair
        top, bot = (ns[-1], ns[0]) if ns[0] in level else (ns[0], ns[-1])
        if bot not in level:
            continue
        a, b = np.array(ln.coords[0]), np.array(ln.coords[-1])
        if top == ns[0]:
            hi, lo = a, b
        else:
            hi, lo = b, a
        rr, cc = _cells(ln.buffer(3.0), D, W)
        ring = g[rr, cc]
        street = int(np.percentile(ring, 80))
        zf = level[bot]
        # (never a carriageway: a road ramping down into a tunnel beside the stairs is no pit -- Plac Krasińskich's)
        road = np.isin(vol[np.maximum(ring - 1, 0), rr, cc], roads)
        low = (ring < street) & (ring >= street - 5) & ~road
        for r, c in zip(rr[low], cc[low]):
            vol[g[r, c] - 1:street, r, c] = C["paving"]
            g[r, c] = street
        L = max(np.linalg.norm(lo - hi), 1e-6)
        sr, sc = _cells(ln.buffer(1.3, cap_style=2), D, W)
        for r, c in zip(sr, sc):
            t = np.clip(np.dot(np.array([c + 0.5, r + 0.5]) - hi, (lo - hi) / L) / L, 0, 1)
            z = int(round(street + (zf - street) * t))
            vol[z:street + 1, r, c] = 0
            vol[z - 1, r, c] = floor
            WALK[r, c] = z
        pr, pc = _cells(ln.buffer(2.3, cap_style=2).difference(ln.buffer(1.3, cap_style=2)), D, W)
        for r, c in zip(pr, pc):  # the parapet round the opening, where the ground stands at the street
            if WALK[r, c] < 0 and g[r, c] >= street:
                vol[street, r, c] = rail
        IDS.add(wid)
        n_s += 1
    for k, (wid, ns, ln) in enumerate(land + tun):
        opened = k < len(land)
        zf = min(level.get(n, 10 ** 6) for n in ns)
        if zf > 10 ** 5:
            continue
        rr, cc = _cells(ln.buffer(1.5, cap_style=2), D, W)
        for r, c in zip(rr, cc):
            if WALK[r, c] >= 0:
                continue
            if g[r, c] >= zf + 4 and not opened:  # under the slab
                vol[zf:zf + 3, r, c] = 0
            else:  # where it opens to a stairwell or a sunken court
                vol[zf:g[r, c] + 1, r, c] = 0
            vol[zf - 1, r, c] = floor
            WALK[r, c] = zf
        wr, wc = _cells(ln.buffer(2.0, cap_style=2).difference(ln.buffer(1.5, cap_style=2)), D, W)
        for r, c in zip(wr, wc):  # the corridor's walls, where the ground's soil would show
            if WALK[r, c] < 0:
                vol[zf:min(zf + 3, g[r, c]), r, c] = np.where(vol[zf:min(zf + 3, g[r, c]), r, c] != 0, wall, 0)
        IDS.add(wid)
        n_t += 1
    note(f"underpasses: {n_t} passages, {n_s} stairwells carved")
