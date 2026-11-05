"""Gardens on roofs: OSM gardens, parks and lawns that lie on a building (BUW's upper garden and its beds, the
university roof courts on Dobra, the terrace over Arkady Kubickiego, the green podium of PGE Narodowy), drawn cell by
cell from the 2025 ortho over the garden's own floor: lawn, flower beds, shrubs and small trees as leaf voxels (they
leaf out, turn and go bare with the city's trees), paving where it is neither; glass and anything standing that is
not green (a pavilion, a skylight, a pergola's frame) stay as built. The floor is the lowest top within 2 m, so a
garden that steps between terraces keeps its steps, and the LiDAR's bumps of planting become the planting. A roof
that is a garden whole is drawn whole: one mostly covered by mapped lawns at one level (the Kubicki Arcades), or one
in WHOLE that OSM maps no garden on (Kopernik), its beds, skylights and paths read off the ortho.
"""
import json

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage, sparse
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import LineString
from shapely.strtree import STRtree

M_LEAF, M_GLASS, M_GRASS = 3, 2, 8
# the viewer tints every leaf voxel by the city's leaf colour: a bed in the ortho's colour is stored without it
LEAF_TINT = np.array(json.load(open("web/public/data/phenology.json"))["leaf"])
PLANTS = ["#76a24a", "#618f43", "#4f7c3c", "#689655", "#56834c"]  # the street trees' own greens (voxelize LEAVES)
# roofs that are a garden whole though OSM maps none on them, and their paths: junctions read off the 2025 ortho (grid
# x, y) or the OSM nodes where a ramp reaches the roof, each link routed along the ortho's paving between its ends.
# Kopernik (kopernik.org.pl 2020, Commons 2012-17, ortho 2025): beds edged in white concrete, gravel paths winding
# between the skylight cones, the ramps up the north facade from Hoover Square and the south one from the metro
WHOLE = {
    "Centrum Nauki Kopernik": dict(
        at=dict(nw=(2536, 1958), w2=(2553, 1961), mid=(2575, 1957), e2=(2600, 1957), e3=(2622, 1950), ne=(2622, 1925),
                n2=(2595, 1920), n1=(2560, 1938), s0=(2576, 1984), s1=(2562, 2021), s2=(2582, 2013), s3=(2596, 2005),
                s4=(2588, 2036), s5=(2607, 2041), s6=(2577, 2046), north=8078458521, south=8078458533),
        links=["nw-w2", "w2-mid", "mid-e2", "e2-e3", "e3-ne", "ne-n2", "n2-n1", "n1-w2", "mid-s0", "s0-s3", "s0-s1",
               "s1-s2", "s2-s3", "s2-s4", "s4-s5", "s4-s6", "s3-s5", "s1-s6", "ne-north", "s6-south"]),
}
PATHS = []  # (end, end, [(x, y), ...]) for traffic.py: an end is a junction's name or an OSM node id


def _buildings(osm):
    return [(oid, t, g) for oid, _, t, g in osm.areas if "building" in t and t.get("building") not in ("roof", "ruins")
            and t.get("location") != "underground" and not t.get("layer", "").startswith("-")]


def gardens(osm):
    """(osm id, polygon) of every garden, park or lawn mostly on a building outline"""
    blds = [g for *_, g in _buildings(osm)]
    tree = STRtree(blds)
    out = []
    for oid, typ, t, g in osm.areas:
        green = t.get("leisure") in ("garden", "park") or t.get("landuse") in ("grass", "flowerbed") \
            or t.get("garden:type") == "roof_garden" or t.get("natural") == "scrub"
        if not green or g.area < 30 or "building" in t or "building:part" in t:
            continue
        on = sum(blds[i].intersection(g).area for i in tree.query(g) if blds[i].intersects(g))
        if on > 0.6 * g.area:
            out.append((oid, g))
    return out


def hosts(osm):
    """{osm id: (outline, share of it the gardens cover, WHOLE's name or None)} of the buildings a roof garden lies on"""
    blds = _buildings(osm)
    tree = STRtree([g for *_, g in blds])
    cover = {}
    for _, gm in gardens(osm):
        for i in tree.query(gm):
            a = blds[i][2].intersection(gm).area
            if a > 20:
                cover[i] = cover.get(i, 0) + a
    out = {blds[i][0]: (blds[i][2], a / blds[i][2].area, None) for i, a in cover.items()}
    out.update({oid: (g, 1.0, t["name"]) for oid, t, g in blds if t.get("name") in WHOLE})
    return out


def route(ortho, outline, at, links):
    """each link along the ortho's paving (light and grey: concrete, gravel) between its ends, at its 0.2 m"""
    f = 5
    c0, r0, c1, r1 = (int(v) for v in outline.bounds)
    A = np.asarray(ortho[r0 * f:(r1 + 1) * f, c0 * f:(c1 + 1) * f]).astype(float)
    inside = rasterize([(outline.buffer(-3), 1)], out_shape=A.shape[:2],  # off the parapet and a ramp along it
                       transform=Affine.translation(c0, r0) * Affine.scale(1 / f)).astype(bool)
    pale = ndimage.binary_opening((A.min(-1) > 150) & (np.ptp(A, -1) < 40), iterations=2) & inside
    cost = np.where(pale, 1.0, 30.0) + np.where(inside, 0.0, 1e4)
    h, w = pale.shape
    idx = np.arange(h * w).reshape(h, w)
    ii, jj, ww = [], [], []
    for a, b, d in ((idx[:, :-1], idx[:, 1:], 1.0), (idx[:-1], idx[1:], 1.0), (idx[:-1, :-1], idx[1:, 1:], 1.414),
                    (idx[:-1, 1:], idx[1:, :-1], 1.414)):
        ii.append(a.ravel())
        jj.append(b.ravel())
        ww.append((cost.ravel()[a.ravel()] + cost.ravel()[b.ravel()]) / 2 * d)
    G = sparse.csr_matrix((np.concatenate(ww), (np.concatenate(ii), np.concatenate(jj))), shape=(h * w, h * w))
    ys, xs = np.nonzero(pale)
    names = [k for k, p in at.items() if isinstance(p, tuple)]
    src = [idx[ys[k], xs[k]] for k in (np.argmin((ys - (at[n][1] - r0) * f) ** 2 + (xs - (at[n][0] - c0) * f) ** 2)
                                       for n in names)]
    _, pred = dijkstra(G, directed=False, indices=src, return_predecessors=True)
    out = []
    for link in links:
        a, b = link.split("-")
        if not isinstance(at[b], tuple):  # to an OSM node: straight on, traffic.py knows where it is
            out.append((a, at[b], [at[a]]))
            continue
        i, q = names.index(a), src[names.index(b)]
        chain = [q]
        while chain[-1] != src[i]:
            chain.append(pred[i, chain[-1]])
        pts = [at[a]] + [(c0 + (q % w + 0.5) / f, r0 + (q // w + 0.5) / f) for q in chain[::-1]] + [at[b]]
        out.append((a, b, [(round(x, 1), round(y, 1)) for x, y in LineString(pts).simplify(0.4).coords]))
    return out


def skylights(vol, rr, cc, top, ortho, pal):
    """the LiDAR reads through a skylight's glass: a hole down from the roof where the ortho is dark is a glass cone
    standing 2 m over it (Kopernik's, photos: dark glass on pale concrete sides)"""
    m = int(np.median(top))
    glass = pal("#3b4650", M_GLASS)
    for r, c, t in zip(rr, cc, top):
        if t < m - 2 and np.asarray(ortho[r * 5:r * 5 + 5, c * 5:c * 5 + 5]).mean() < 90:
            vol[t + 1:m + 2, r, c] = pal("#c9c4b9", 0)
            vol[m + 2, r, c] = glass


def build(vol, g, bmask, pal, osm, cells_of, ortho, garden_id, note):
    D, W = g.shape
    mats = np.array([e[3] for e in pal.entries] + [0] * 4096)
    paving = pal("#bdb8ae", 0)
    plants = [pal(h, M_LEAF) for h in PLANTS]
    n = dict(lawn=0, beds=0, plants=0, paving=0, kept=0)
    whole, planted = [], []  # a roof at one level that is mostly garden is a garden whole, its paths and beds between
    PATHS.clear()  # the mapped lawns (the Kubicki Arcades; not Dobra, its courts between taller wings)
    for b, share, name in hosts(osm).values():
        rr, cc = cells_of(b)
        t = np.array([np.nonzero(vol[:, r, c])[0].max(initial=0) for r, c in zip(rr, cc)])
        if name:
            skylights(vol, rr, cc, t, ortho, pal)
            planted.append(b)
            PATHS.extend(route(ortho, b, WHOLE[name]["at"], WHOLE[name]["links"]))
        elif share > 0.4 and len(t) and np.percentile(t, 90) - np.percentile(t, 10) <= 3:
            whole.append(b)
    todo = [gm for _, gm in gardens(osm) if not any(b.contains(gm.representative_point()) for b in whole + planted)]
    for geom in todo + whole + planted:
        beds = any(geom is b for b in planted)
        rr, cc = cells_of(geom)
        k = bmask[rr, cc]
        rr, cc = rr[k], cc[k]
        if len(rr) < 8:
            continue
        top = np.zeros(len(rr), int)
        for i, (r, c) in enumerate(zip(rr, cc)):
            nz = np.nonzero(vol[:, r, c])[0]
            top[i] = nz[-1] if len(nz) else g[r, c]
        if np.median(top - g[rr, cc]) < 2.5:  # a lawn at street level on an outline drawn too wide
            continue
        r0, c0 = rr.min(), cc.min()
        grid = np.full((rr.max() - r0 + 1, cc.max() - c0 + 1), 10 ** 6)
        grid[rr - r0, cc - c0] = top
        floor = ndimage.minimum_filter(grid, size=5)[rr - r0, cc - c0]
        for r, c, t, f in zip(rr, cc, top, floor):
            if mats[vol[t, r, c]] == M_GLASS or mats[vol[f, r, c]] == M_GLASS:
                n["kept"] += 1
                continue
            R, G, B = np.asarray(ortho[r * 5:r * 5 + 5, c * 5:c * 5 + 5]).reshape(-1, 3).astype(float).mean(0)
            s = R + G + B + 1
            exg = (2 * G - R - B) / s
            dz = t - f
            bloom = (R > 140 and G > 130 and B < 0.7 * min(R, G)) or (R > 120 and B > 100 and G < 0.8 * min(R, B)) \
                or (R > 150 and G < 0.6 * R and B < 0.6 * R)
            pale = min(R, G, B) > 150 and max(R, G, B) - min(R, G, B) < 40
            # a WHOLE roof is planted, not lawn: whatever is not its paths is a bed in the ortho's colour (Kopernik's
            # heather, sedum, grasses and pinks: purple, brown, grey-green)
            if (bloom or (beds and not pale)) and dz < 2:
                vol[f, r, c] = garden_id
                vol[f + 1, r, c] = pal(tuple(int(v) for v in np.minimum(np.array([R, G, B]) / LEAF_TINT, 255)), M_LEAF, q=12)
                vol[f + 2:t + 1, r, c] = 0
                n["beds"] += 1
            elif exg > 0.05:
                vol[f, r, c] = garden_id
                if dz >= 2:
                    leaf = plants[(r * 7 + c * 13) % len(plants)]
                    vol[f + 1:min(t, f + 5) + 1, r, c] = leaf
                    vol[min(t, f + 5) + 1:t + 1, r, c] = 0
                    n["plants"] += 1
                else:
                    vol[f + 1:t + 1, r, c] = 0
                    n["lawn"] += 1
            elif dz >= 2:
                n["kept"] += 1
            else:
                vol[f, r, c] = paving
                vol[f + 1:t + 1, r, c] = 0
                n["paving"] += 1
    note("roof gardens (cells):", n)
