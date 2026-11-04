"""Gardens on roofs: OSM gardens, parks and lawns that lie on a building (BUW's upper garden and its beds, the
university roof courts on Dobra, the terrace over Arkady Kubickiego, the green podium of PGE Narodowy), drawn cell by
cell from the 2025 ortho over the garden's own floor: lawn, flower beds, shrubs and small trees as leaf voxels (they
leaf out, turn and go bare with the city's trees), paving where it is neither; glass and anything standing that is
not green (a pavilion, a skylight, a pergola's frame) stay as built. The floor is the lowest top within 2 m, so a
garden that steps between terraces keeps its steps, and the LiDAR's bumps of planting become the planting.
"""
import numpy as np
from scipy import ndimage
from shapely.strtree import STRtree

M_LEAF, M_GLASS, M_GRASS = 3, 2, 8
PLANTS = ["#76a24a", "#618f43", "#4f7c3c", "#689655", "#56834c"]  # the street trees' own greens (voxelize LEAVES)


def gardens(osm):
    """(osm id, polygon) of every garden, park or lawn mostly on a building outline"""
    blds = [g for _, _, t, g in osm.areas if "building" in t and t.get("building") not in ("roof", "ruins")
            and t.get("location") != "underground" and not t.get("layer", "").startswith("-")]
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


def build(vol, g, bmask, pal, osm, cells_of, ortho, garden_id, note):
    D, W = g.shape
    mats = np.array([e[3] for e in pal.entries] + [0] * 4096)
    paving = pal("#bdb8ae", 0)
    plants = [pal(h, M_LEAF) for h in PLANTS]
    n = dict(lawn=0, beds=0, plants=0, paving=0, kept=0)
    for oid, geom in gardens(osm):
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
            if bloom and dz < 2:
                vol[f, r, c] = garden_id
                vol[f + 1, r, c] = pal((int(R), int(G), int(B)), M_LEAF, q=12)
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
