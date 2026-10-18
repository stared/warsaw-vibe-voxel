"""Curated, research-backed details (see research.md) layered on top of the data-driven voxels."""
import json
import math
from pathlib import Path

import numpy as np
from shapely.geometry import Point
from scipy import ndimage

M_WALL, M_GLASS, M_PKIN, M_CONCRETE, M_CLOCK = 1, 2, 7, 13, 14

# OSM name -> (label, note, anchor). Order = label priority (decluttering keeps earlier ones).
# anchor "top": highest voxel in the footprint (towers, spires); "center": top voxel at the centroid.
LABELS = {
    "Pałac Kultury i Nauki": ("Pałac Kultury i Nauki", "Palace of Culture and Science · 237 m · 1955", "top"),
    "Varso Tower": ("Varso Tower", "310 m with spire · Foster + Partners · 2022", "top"),
    "Złota 44": ("Złota 44", "192 m · Daniel Libeskind · 2017", "top"),
    "Warszawa Centralna": ("Warszawa Centralna", "main railway station · 1975", "center"),
    "Złote Tarasy": ("Złote Tarasy", "shopping centre, glass canopy · 2007", "center"),
    "Muzeum Sztuki Nowoczesnej": ("Muzeum Sztuki Nowoczesnej", "Museum of Modern Art · opened Oct 2024", "center"),
    "Plac Centralny": ("Plac Centralny", "new square · opened Jun 2025", "center"),
    "TR Warszawa": ("TR Warszawa", "theatre · under construction", "center"),
    "Rotunda PKO": ("Rotunda PKO", "rebuilt 2019", "center"),
    "Park Świętokrzyski": ("Park Świętokrzyski", "", "center"),
    "Rondo 1": ("Rondo 1", "192 m · 2006", "top"),
    "Q22": ("Q22", "195 m · 2016", "top"),
    "InterContinental": ("InterContinental", "164 m · 2004", "top"),
    "Centrum LIM": ("Marriott", "170 m with antenna · 1989", "top"),
    "Novotel Warszawa Centrum": ("Novotel", "111 m · 1974", "top"),
    "Cosmopolitan": ("Cosmopolitan", "160 m · Helmut Jahn · 2013", "top"),
    "Spektrum Tower": ("Spektrum Tower", "128 m · 2003", "top"),
    "Central Point": ("Central Point", "2022", "top"),
    "Ilmet": ("Ilmet", "1997 · to be rebuilt as Warsaw One", "top"),
    "The Westin Warsaw": ("The Westin", "2003", "top"),
    # the 3.9 x 3.1 km map: Powiśle, the Vistula, Praga, Ogród Saski, Śródmieście Południowe
    "PGE Narodowy": ("PGE Narodowy", "National Stadium · 2011", "top"),
    "Centrum Nauki Kopernik": ("Centrum Nauki Kopernik", "Copernicus Science Centre · 2010", "center"),
    "Most Świętokrzyski": ("Most Świętokrzyski", "cable-stayed bridge · 2000", "top"),
    "Most Księcia Józefa Poniatowskiego": ("Most Poniatowskiego", "1914 · rebuilt 1946", "center"),
    "Ogród Saski": ("Ogród Saski", "Saxon Garden · 1727", "center"),
    "Odbudowa Pałacu Saskiego": ("Pałac Saski", "reconstruction site", "center"),
    "Teatr Wielki": ("Teatr Wielki", "Grand Theatre · National Opera", "center"),
    "Zachęta": ("Zachęta", "National Gallery of Art · 1900", "center"),
    "Gmach Główny PW": ("Politechnika Warszawska", "Main Building · 1901", "center"),
    "Sejm RP": ("Sejm", "Polish Parliament", "center"),
    "Hala Koszyki": ("Hala Koszyki", "market hall · 1909", "center"),
    "Biblioteka Uniwersytecka": ("BUW", "University Library · roof garden · 1999", "center"),
    "Elektrownia Powiśle": ("Elektrownia Powiśle", "power station, now shops · 2020", "center"),
    "Stadion Miejski Legii Warszawa": ("Stadion Legii", "Legia Warsaw · 2011", "center"),
    "Plac Konstytucji": ("Plac Konstytucji", "MDM · 1952", "center"),
}
# places without a single OSM polygon (EPSG:2180 x, y)
EXTRA_LABELS = [("Zielona Złota", "street greening · opened Aug 2026", 637420, 487015),
                ("Wisła", "Vistula", 639034, 487782), ("Bulwary Wiślane", "Vistula boulevards", 638714, 487996)]  # mid-river by Most Świętokrzyski; the boulevard by Kopernik
# other names people search for (English, the official / colloquial Polish): added to the search keys only
ALIASES = {"PGE Narodowy": "Stadion Narodowy National Stadium football", "Centrum Nauki Kopernik": "Copernicus Science Centre CNK",
           "Pałac Kultury i Nauki": "PKiN Palace of Culture and Science", "Most Świętokrzyski": "bridge", "Most Poniatowskiego": "bridge Poniatowski",
           "Ogród Saski": "Saxon Garden park", "Pałac Saski": "Saxon Palace", "Teatr Wielki": "Grand Theatre Opera", "Sejm": "Parliament",
           "Warszawa Centralna": "Central Station railway train", "Złote Tarasy": "Golden Terraces mall", "BUW": "Biblioteka Uniwersytecka library",
           "Wisła": "Vistula river", "Politechnika Warszawska": "Gmach Główny PW Warsaw University of Technology", "Bulwary Wiślane": "boulevards Vistula", "Politechnika Warszawska": "Warsaw University of Technology"}


def adjust_heights(top, feats, note):
    """Hook for per-building height corrections (none needed unless the cross-check flags one)."""


MAT_IDS = {"solid": 0, "wall": 1, "glass": 2, "metal": 6, "pkin": 7, "grass": 8, "roof": 12, "concrete": 13,
           "bronze_grid": 15, "sign": 16, "sign_band": 18, "ribbon": 19, "classic": 20, "window": 21}
VARSO = Point(244, 1414)  # Varso Tower spire, grid
OVERRIDES = json.load(open(Path(__file__).with_name("overrides.json")))["buildings"]


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def override_for(f):
    """overrides.json entry for a feature: by its own id, its parent outline's id, or its (parent's) name."""
    keys = [str(f["id"])]
    if f.get("parent"):
        keys.append(str(f["parent"]["id"]))
    keys.append(_name(f) or "")
    for k in keys:
        o = OVERRIDES.get(k)
        if o and (f["maxh"] or 0) >= o.get("min_part_height", -1):
            return o
    return None


def _style(pal, spec):
    return pal(_hex(spec["colour"]), MAT_IDS[spec.get("material", "wall")])


def wall_override(f, pal):
    if _name(f) == "Złote Tarasy" and f["tags"].get("building:colour", "").lower() == "#336699":
        return pal((198, 212, 216), M_GLASS)  # canopy glass, see roof_override
    # Varso Tower's own glass is tagged the same dark #334E6B as the Varso 1/2 blocks beside it; in photos the tower
    # reads light blue-grey (visual_ref.md #8DA0B2, photo comparison Sep 2024): the parts within 50 m of its spire
    if f["tags"].get("building:colour", "").lower() == "#334e6b" and f["geom"].distance(VARSO) < 50:
        return pal((141, 160, 178), M_GLASS)
    o = override_for(f)
    return _style(pal, o["wall"]) if o and "wall" in o else None


def apply_stripes(vol, g, bmask, pal, osm, cells_of, note):
    """overrides.json areas with "stripes": vertical bands of colour by angle around the area's centre on every
    building column inside it, from 3 m up to (not including) the roof voxel -- e.g. PGE Narodowy's red and silver
    facade. Whole columns, because the LiDAR bowl rises above the OSM part heights.
    Returns the floodlit infields as [x, y, r] (cells) for the night lighting."""
    floods = []
    for oid, o in OVERRIDES.items():
        st = o.get("stripes")
        if not st or not oid.isdigit():
            continue
        geom = next((gm for i, typ, t, gm in osm.areas if str(i) == oid), None)
        if geom is None:
            continue
        cx, cy = geom.centroid.x, geom.centroid.y
        R = math.sqrt(geom.area / math.pi)
        cols = [pal(_hex(c), MAT_IDS[st.get("material", "wall")]) for c in st["colours"]]
        # "bands": horizontal bands by height above ground instead of vertical stripes, [{to (m), colour | checker, material}],
        # the last without "to" running to the top
        bands, chk = [], None
        for b in st.get("bands", []):
            if "checker" in b:
                chk = [pal(_hex(c), MAT_IDS[b.get("material", "wall")]) for c in b["checker"]]
                bands.append((b.get("to", 10 ** 4), "checker"))
            else:
                bands.append((b.get("to", 10 ** 4), pal(_hex(b["colour"]), MAT_IDS[b.get("material", "wall")])))
        rr, cc = cells_of(geom)
        # recolour by palette colour within the area (e.g. OSM's #3399cc "glass" inner roof edge)
        for src, dst in o.get("recolour", {}).items():
            sr = _hex(src)
            # palette entries are the OSM colour after voxelize's grading (soften by 8 % for glass, 12 % otherwise)
            soft = [tuple(v * (1 - a) + w * a for v, w in zip(sr, (226, 220, 208))) for a in (0.08, 0.12)]
            ids = [i for i, e in enumerate(pal.entries) if any(max(abs(e[k] - t[k]) for k in range(3)) < 8 for t in soft)]
            if ids:
                colv = vol[:, rr, cc]
                for i_ in ids:
                    mat = pal.entries[i_][3]
                    colv[colv == i_] = pal(_hex(dst), mat)
                vol[:, rr, cc] = colv
        # the infield: the open middle of the building mass (the pitch), at ground level
        inf = o.get("infield")
        if inf:
            r0_, c0_ = rr.min(), cc.min()
            mm = np.zeros((rr.max() - r0_ + 3, cc.max() - c0_ + 3), bool)
            kk = bmask[rr, cc]
            mm[rr[kk] - r0_ + 1, cc[kk] - c0_ + 1] = True
            mm = ndimage.binary_closing(mm, iterations=3)
            hole = ndimage.binary_fill_holes(mm) & ~mm
            hr, hc = np.nonzero(hole)
            hr, hc = hr + r0_ - 1, hc + c0_ - 1
            gi = pal(_hex(inf["colour"]), MAT_IDS[inf.get("material", "grass")])
            vol[g[hr, hc] - 1, hr, hc] = gi
            # open above the pitch: the LiDAR column there (the hub and its cables) left a fat cylinder; keep only a
            # slim hub, 3 m across, hanging from 45 m up
            hcr, hcc = hr.mean(), hc.mean()
            for r_, c_ in zip(hr, hc):
                hub = abs(r_ - hcr) <= 1.5 and abs(c_ - hcc) <= 1.5
                vol[g[r_, c_]:g[r_, c_] + 45 if hub else vol.shape[0], r_, c_] = 0
            # the inner face of the bowl: seating tiers (red seat rows, grey walkways), not office windows
            seat, walk = pal(_hex("#b3343b"), 0), pal(_hex("#8f8f8c"), 0)
            depth_in = ndimage.distance_transform_edt(~hole)
            ir, ic = np.nonzero(mm & (depth_in <= 10))
            for r_, c_ in zip(ir + r0_ - 1, ic + c0_ - 1):
                nz = np.nonzero(vol[:, r_, c_])[0]
                if not len(nz):
                    continue
                for z_ in range(int(g[r_, c_]), int(nz[-1])):
                    if vol[z_, r_, c_]:
                        vol[z_, r_, c_] = walk if (z_ - g[r_, c_]) % 4 == 0 else seat
            floods.append([round(float(hc.mean()) + 0.5, 1), round(float(hr.mean()) + 0.5, 1), round(math.sqrt(len(hr) / math.pi), 1)])
            note("infield:", o.get("name", oid)[:30], len(hr), "cells")
        masts = _smooth_bowl(vol, g, bmask, pal, rr, cc, cx, cy, o["smooth"], note) if o.get("smooth") else []
        k_ = bmask[rr, cc]
        ring = st.get("ring", 1e9)  # only the facade: cells within this many metres of the building mass's outer edge
        r0, c0 = rr.min(), cc.min()
        m = np.zeros((rr.max() - r0 + 3, cc.max() - c0 + 3), bool)
        m[rr[k_] - r0 + 1, cc[k_] - c0 + 1] = True
        depth = ndimage.distance_transform_edt(ndimage.binary_fill_holes(ndimage.binary_closing(m, iterations=3)))
        n = 0
        for r, c in zip(rr[k_], cc[k_]):
            if depth[r - r0 + 1, c - c0 + 1] > ring:
                continue
            nz = np.nonzero(vol[:, r, c])[0]
            if not len(nz):
                continue
            z0, z1 = int(g[r, c]) + 3, int(nz[-1])
            if z1 <= z0:
                continue
            arc = (math.atan2(r + 0.5 - cy, c + 0.5 - cx) + math.pi) * R  # metres along the perimeter
            col = vol[z0:z1, r, c]
            if bands:
                hz = np.arange(z0, z1) - int(g[r, c])  # height above ground
                out = np.zeros_like(col)
                lo = 0
                for b, (to, kind) in zip(st["bands"], bands):
                    sel = (hz >= lo) & (hz < to)
                    if kind == "checker":  # panels of cell[0] m along x cell[1] m up, more of the second colour higher up
                        cw, ch = b["cell"]
                        rows = (hz[sel] - lo) // ch
                        t = rows / max(1, (to - lo) // ch - 1)
                        hsh = (np.int64(arc // cw) * 73856093 ^ rows.astype(np.int64) * 19349663) % 1000 / 1000
                        out[sel] = np.where(hsh < b.get("p", 0.25) + b.get("dp", 0.4) * t, chk[1], chk[0])
                    else:
                        out[sel] = kind
                    lo = to
                vol[z0:z1, r, c] = np.where(col != 0, out, 0)
            else:
                k = int(arc / st.get("width", 3)) % len(cols)
                vol[z0:z1, r, c] = np.where(col != 0, cols[k], 0)
            n += 1
        lean = o.get("smooth", {}).get("lean", 8)  # the masts lean outward (photos: spikes round the rim from above)
        for r, c, z0, z1, col, a in masts:
            for zz in range(z0, z1):
                t = lean * (zz - z0) / max(1, z1 - z0)
                vol[zz, int(round(r + t * math.sin(a))), int(round(c + t * math.cos(a)))] = col
        note("stripes:", o.get("name", oid)[:40], n, "columns")
    return floods


def _smooth_bowl(vol, g, bmask, pal, rr, cc, cx, cy, sm, note):
    """A stadium's roof as one smooth surface: its height is the median LiDAR height at each distance from the outer
    edge (1 m steps), so the masts and cable points no longer stand as radial fins round the facade; then
    sm["masts"] thin masts evenly round the rim, sm["mast_h"] m above the roof edge."""
    k = bmask[rr, cc]
    r0, c0 = rr.min() - 8, cc.min() - 8
    m = np.zeros((rr.max() - r0 + 9, cc.max() - c0 + 9), bool)
    m[rr[k] - r0, cc[k] - c0] = True
    # the bowl's outline smoothed: the masts' and stair cores' LiDAR footprints made a comb of fins round it
    sm_it = sm.get("outline", 6)
    mc = ndimage.binary_closing(m, iterations=sm_it)
    m = ndimage.binary_opening(ndimage.binary_fill_holes(mc), iterations=sm_it)
    lab, nl = ndimage.label(mc)  # the bowl is the largest piece; islands in the pitch (the hub's LiDAR) are not
    ring_ = lab == 1 + int(np.argmax(ndimage.sum(mc, lab, range(1, nl + 1))))
    hole = ndimage.binary_fill_holes(ring_) & ~ring_  # the pitch stays open
    yy, xx = np.mgrid[-6:7, -6:7]
    hole = ndimage.binary_closing(np.pad(hole, 8), xx ** 2 + yy ** 2 <= 36)[8:-8, 8:-8]  # no roof spikes into it
    # the opening is a rounded rectangle (ortho), a little smaller than the gap between the OSM stands
    hy, hx = np.nonzero(hole)
    a, b = (hx.max() - hx.min()) / 2 - sm.get("hole_shrink", 3), (hy.max() - hy.min()) / 2 - sm.get("hole_shrink", 3)
    gy, gx = np.mgrid[0:hole.shape[0], 0:hole.shape[1]]
    hole = (np.abs((gx - (hx.max() + hx.min()) / 2) / a) ** 4 + np.abs((gy - (hy.max() + hy.min()) / 2) / b) ** 4) <= 1
    inside = (m & ~hole)[rr - r0, cc - c0]
    in_hole = hole[rr - r0, cc - c0] & k
    hr_, hc_ = rr[hole[rr - r0, cc - c0]], cc[hole[rr - r0, cc - c0]]
    hubc = pal(_hex("#eceae4"), MAT_IDS["solid"])
    for r, c in zip(rr[in_hole], cc[in_hole]):  # open to the sky but for a slim white hub hanging 45-60 m up
        hub = abs(r - hr_.mean()) <= 1.5 and abs(c - hc_.mean()) <= 1.5
        vol[int(g[r, c]):, r, c] = 0
        if hub:
            vol[int(g[r, c]) + 45:int(g[r, c]) + 60, r, c] = hubc
        bmask[r, c] = False
    concrete = pal(_hex(sm.get("podium_colour", "#a3a29d")), MAT_IDS["concrete"])
    for r, c in zip(rr[k & ~inside & ~hole[rr - r0, cc - c0]], cc[k & ~inside & ~hole[rr - r0, cc - c0]]):
        zp = int(g[r, c]) + sm.get("podium", 8)  # outside the bowl: no more than the podium, in concrete
        vol[zp:, r, c] = 0
        nz = np.nonzero(vol[:zp, r, c])[0]
        if len(nz):
            vol[nz[-1], r, c] = concrete
    fill = pal(_hex(sm.get("mast_colour", "#ecedee")), MAT_IDS["solid"])
    for r, c in zip(rr[~k & inside], cc[~k & inside]):  # gaps in the outline: part of the bowl
        vol[int(g[r, c]):int(g[r, c]) + 1, r, c] = fill
        bmask[r, c] = True
    r_, c_ = rr[inside], cc[inside]
    orig = k[inside]  # measured columns (the gap cells just filled carry no height)
    depth = np.round(ndimage.distance_transform_edt(m)[r_ - r0, c_ - c0]).astype(int)
    tops = np.array([(np.nonzero(vol[:, r, c])[0][-1] + 1 if vol[:, r, c].any() else int(g[r, c])) for r, c in zip(r_, c_)]) - g[r_, c_]
    prof = np.zeros(depth.max() + 1)
    for d in range(len(prof)):
        v = tops[(depth == d) & orig]
        prof[d] = np.median(v) if len(v) else prof[d - 1]
    prof = np.maximum.accumulate(ndimage.median_filter(prof, 5))  # the membrane only rises inward
    n = sm.get("masts", 72)
    # the membrane sags between the radial cables, one per mast (ortho: radial panels, not rings), grey along each
    # cable; a translucent grey-blue ring round the opening
    frac = ((np.arctan2(r_ + 0.5 - cy, c_ + 0.5 - cx) + math.pi) / (2 * math.pi) * n) % 1.0
    sag = sm.get("sag", 1.5) * np.sin(math.pi * (frac - 0.5)) ** 2
    rad = np.hypot(r_ + 0.5 - cy, c_ + 0.5 - cx)
    on_cable = np.abs(frac - 0.5) * 2 * math.pi * rad / n < 0.6
    in_d = ndimage.distance_transform_edt(~hole)[r_ - r0, c_ - c0]
    memb, cable = pal(_hex("#eceae4"), MAT_IDS["solid"]), pal(_hex("#c3c6c8"), MAT_IDS["metal"])
    seat, walk = pal(_hex("#b3343b"), 0), pal(_hex("#8f8f8c"), 0)
    glass = pal(_hex(sm.get("ring_colour", "#8e9ca6")), MAT_IDS["glass"])
    for i_, (r, c, d) in enumerate(zip(r_, c_, depth)):
        z0, zt = int(g[r, c]), int(g[r, c] + round(prof[d] - sag[i_]))
        col = vol[:, r, c]
        nz = np.nonzero(col)[0]
        if not len(nz):
            continue
        top = nz[-1] + 1
        if top > zt:
            col[zt:] = 0
        elif top < zt:
            col[top:zt] = col[top - 1]
        col[z0 + 1:zt][col[z0 + 1:zt] == 0] = col[zt - 1]  # no hollows under the roof
        col[zt - 1] = glass if in_d[i_] <= sm.get("ring", 8) else cable if on_cable[i_] else memb
        # the stands: seating rakes up from the pitch under a thin roof (not a 50 m cliff round the opening)
        if in_d[i_] <= sm.get("stands", 45):
            zs = min(z0 + 2 + int(0.75 * in_d[i_]), zt - 5)
            col[zt - 1 - 2:zt - 1] = col[zt - 1] if in_d[i_] <= sm.get("ring", 8) else memb
            col[zs:zt - 3] = 0
            for zz in range(z0 + 1, zs):
                col[zz] = walk if (zz - z0) % 4 == 0 else seat
    white = pal(_hex(sm.get("mast_colour", "#ecedee")), MAT_IDS["metal"])
    rim = (depth == 1)
    ang = np.arctan2(r_[rim] + 0.5 - cy, c_[rim] + 0.5 - cx)
    masts = []
    for kk in range(n):  # just outside the facade, from the ground to mast_h above the roof edge (photos)
        a = -math.pi + (kk + 0.5) * 2 * math.pi / n
        i = int(np.argmin(np.abs((ang - a + math.pi) % (2 * math.pi) - math.pi)))
        r, c = int(round(r_[rim][i] + 2 * math.sin(a))), int(round(c_[rim][i] + 2 * math.cos(a)))
        masts.append((r, c, int(g[r, c]), int(g[r, c] + round(prof[1])) + sm.get("mast_h", 18), white, a))
    note(f"smooth bowl: roof {prof[1]:.0f}-{prof.max():.0f} m over {len(prof)} m depth, {n} masts")
    return masts


def apply_zones(vol, g, feats, pal, bmask, note):
    """Facade zones and crown bands from overrides.json, painted onto the voxels of the building's footprint."""
    by_outline = {}
    for f in feats:
        o = override_for(f)
        if o and ("zones" in o or "crown" in o):
            root = f.get("parent") or f
            by_outline.setdefault(root["id"], (o, []))[1].append(f)
    for oid, (o, fs) in by_outline.items():
        rr = np.concatenate([f["rr"] for f in fs])
        cc = np.concatenate([f["cc"] for f in fs])
        keep = bmask[rr, cc]
        rr, cc = rr[keep], cc[keep]
        if len(rr) == 0:
            continue
        # long axis of the footprint; "west" end = smaller grid column
        pts = np.stack([cc, rr], 1).astype(float)
        mu = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - mu, full_matrices=False)
        ax = vt[0] if vt[0][0] >= 0 else -vt[0]
        t = (pts - mu) @ ax
        t = (t - t.min()) / max(np.ptp(t), 1e-6)
        zone_of = np.full(len(rr), -1)
        for k, z in enumerate(o.get("zones", [])):
            tt = t if z.get("origin", "west") in ("west", "north") else 1 - t
            m = (tt >= z["from"]) & (tt <= z["to"]) & (zone_of < 0)
            zone_of[m] = k
            idx = _style(pal, z["wall"])
            for r, c in zip(rr[m], cc[m]):
                col = vol[:, r, c]
                nz = np.nonzero(col)[0]
                nz = nz[nz >= g[r, c]]
                if len(nz) > 1:
                    col[nz[:-1]] = idx  # keep the roof voxel
        cr = o.get("crown")
        if cr:
            m = t <= cr.get("tip", 1.0)
            fp = np.zeros(vol.shape[1:], bool)
            fp[rr, cc] = True
            edge_fp = fp & ~ndimage.binary_erosion(fp)  # facade cells only
            band, sign = _style(pal, cr), pal(_hex(cr.get("sign_colour", cr["colour"])), MAT_IDS["sign"])
            for r, c in set(zip(rr[m], cc[m])):
                if not edge_fp[r, c]:
                    continue
                nz = np.nonzero(vol[:, r, c])[0]
                top = nz.max()
                for k in range(0, cr["height"]):
                    vol[top - k, r, c] = sign if (k == 0 and (r + c) % 2 == 0) else band
        if "roof" in o:
            ridx = _style(pal, o["roof"])
            for r, c in zip(rr, cc):
                vol[np.nonzero(vol[:, r, c])[0].max(), r, c] = ridx
        note(f"override zones: {o.get('name', oid)}: {len(rr)} cells, zones "
             f"{[int((zone_of == k).sum()) for k in range(len(o.get('zones', [])))]}")


def override_labels(feats, g, top_at):
    out = []
    for f in feats:
        o = OVERRIDES.get(str(f["id"]))
        if o and "label" in o and not f["part"] and len(f["rr"]):
            k = len(f["rr"]) // 2
            r, c = int(np.median(f["rr"])), int(np.median(f["cc"]))
            out.append(dict(name=o["label"], note=o.get("note", ""), x=c, y=r, z=top_at(r, c), highlight=True))
    return out


def _name(f):
    return f["tags"].get("name") or (f.get("parent") or {}).get("tags", {}).get("name")


def roof_override(f, pal):
    # Złote Tarasy: the undulating canopy is clear glass on a white steel lattice (OSM tags it #336699)
    if _name(f) == "Złote Tarasy" and f["tags"].get("building:colour", "").lower() == "#336699":
        return pal((206, 218, 220), M_GLASS)
    o = override_for(f)
    return _style(pal, o["roof"]) if o and "roof" in o else None


def small_tree(vol, g, r, c, h, leaves, trunk, height=None):
    """A young street tree as planted 2025-26 (Plac Centralny, Złota): photos show a clear trunk to ~4 m and a
    narrow, airy crown on top (visual_ref.md, Złota 2026 photos)."""
    H = int(height or 7 + h % 3)
    z0 = int(g[r, c])
    tr = max(3, int(H * 0.42))
    vol[z0:z0 + tr, r, c] = trunk
    leaf = leaves[1 + (h >> 8) % 4]
    leaf2 = leaves[(1 + (h >> 8) % 4 + 2) % len(leaves)]
    ch = H - tr  # crown height
    for k in range(ch):
        f = (k + 0.5) / ch
        rad = 0.6 + 1.3 * math.sin(math.pi * min(1.0, f * 1.1))  # spindle, widest just below the middle
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                d = (dr * dr + dc * dc) ** 0.5
                if d > rad:
                    continue
                if d > 0.5 and ((h >> ((k * 5 + dr * 3 + dc + 20) % 28)) & 7) == 0:
                    continue  # airy gaps
                zz, rr, cc = z0 + tr + k, r + dr, c + dc
                if 0 <= rr < vol.shape[1] and 0 <= cc < vol.shape[2] and zz < vol.shape[0] and vol[zz, rr, cc] == 0:
                    vol[zz, rr, cc] = leaf if (dr + dc + k) % 3 else leaf2
    vol[z0 + tr:z0 + H - 1, r, c] = trunk  # leader through the crown

def details(vol, g, top, topi, bmask, feats, pal, C, osm, cells_of, note, leaf_ids=()):
    pkin_clock(vol, g, feats, pal, note)
    regularize_walls(vol, g, feats, note)
    apply_loggias(vol, g, pal, note)
    H = vol.shape[0]

    def top_at(r, c):
        col = np.nonzero(vol[:, r, c])[0]
        return int(col[-1]) + 1 if len(col) else int(g[r, c])

    found = {}
    for oid, typ, t, geom in osm.areas:
        n = t.get("name")
        if n not in LABELS or n in found:
            continue
        label, sub, mode = LABELS[n]
        if n.startswith("Most "):  # a bridge: on the middle of its carriageway, not on the area's highest cell
            from shapely.ops import linemerge as _lm
            ln = _lm([l for oid_, t_, l in osm.lines if t_.get("name") in (n, label) and t_.get("highway")])
            ln = max(getattr(ln, "geoms", [ln]), key=lambda q: q.length) if not ln.is_empty else None
            if ln is not None:
                p = ln.interpolate(0.5, normalized=True)
                r, c = int(p.y), int(p.x)
                if 0 <= r < vol.shape[1] and 0 <= c < vol.shape[2]:
                    found[n] = dict(name=label, note=sub, x=c, y=r, z=top_at(r, c))
                    continue
        if mode == "top":
            rr, cc = cells_of(geom)
            if len(rr) == 0:
                continue
            k = np.argmax(topi[rr, cc] + g[rr, cc])
            r, c = int(rr[k]), int(cc[k])
        else:
            p = geom.representative_point() if not geom.contains(geom.centroid) else geom.centroid
            r, c = int(p.y), int(p.x)
        if not (0 <= r < vol.shape[1] and 0 <= c < vol.shape[2]):
            continue
        found[n] = dict(name=label, note=sub, x=c, y=r, z=top_at(r, c))
    labels = override_labels(feats, g, top_at) + [found[n] for n in LABELS if n in found]
    from aoi import to_grid
    for label, sub, wx, wy in EXTRA_LABELS:
        c, r = (int(v) for v in to_grid(wx, wy))
        labels.append(dict(name=label, note=sub, x=c, y=r, z=top_at(r, c)))
    for l in labels:
        if l["name"] in ALIASES:
            l["alt"] = ALIASES[l["name"]]
    note("labels:", [l["name"] for l in labels])
    extra = {"astoria": l for l in labels if l.get("highlight")}
    return labels, make_views(found, osm, g, top_at, note, bmask, extra, vol, leaf_ids)


def make_views(found, osm, g, top_at, note, bmask, found_extra=None, vol=None, leaf_ids=()):
    found_extra = found_extra or {}
    """Camera presets in three.js coords (x = col, y = up, z = row), derived from landmark positions."""
    def at(name, dz=0.0):
        l = found[name]
        return [l["x"] + 0.5, dz, l["y"] + 0.5]

    def add(t, off):
        return [t[0] + off[0], t[1] + off[1], t[2] + off[2]]

    views = {}
    pk = at("Pałac Kultury i Nauki")
    views["overview"] = dict(label="Overview", target=[pk[0], 20, pk[2]], pos=add([pk[0], 20, pk[2]], (-420, 860, 1180)))
    views["pkin"] = dict(label="Palace", target=[pk[0], 110, pk[2]], pos=add([pk[0], 110, pk[2]], (420, 160, 300)))
    z44 = at("Złota 44", 90)
    views["zlota44"] = dict(label="Złota 44", target=z44, pos=add(z44, (260, 140, 240)))
    # Złota at street level: the renovated stretch east of Marszałkowska, looking east along the street
    pts = np.array([c for oid, t, l in osm.lines if t.get("name") == "Złota" and "highway" in t
                    for c in l.coords if c[0] > found["Pałac Kultury i Nauki"]["x"] + 330])
    if len(pts) > 4:
        mu = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - mu)
        d = vt[0] if vt[0][0] > 0 else -vt[0]  # principal direction, pointing east
        proj = (pts - mu) @ d
        p0, p1 = mu + d * proj.min(), mu + d * proj.max()
        L = float(proj.max() - proj.min())
        gz = int(g[int(p0[1]), int(p0[0])])
        # stand on the street itself (a Złota vertex ~75% of the way east, clear of buildings), at eye height,
        # looking west along the street toward PKiN like the 2026 photos
        cand = [q for q in pts if not bmask[int(q[1]), int(q[0])]]
        cand.sort(key=lambda q: abs((q - mu) @ d - (proj.min() + 0.75 * L)))
        pe = cand[0]
        ge = int(g[int(pe[1]), int(pe[0])])
        pkl = found["Pałac Kultury i Nauki"]
        views["zlota"] = dict(label="Złota street", target=[float(pkl["x"]), ge + 1.5, float(pkl["y"])],
                              pos=[float(pe[0]), ge + 2.5, float(pe[1])])
        note("Złota street view along", round(L), "m of street east of Marszałkowska")
    # buildings with an overrides.json label get a preset looking at the end the zones start from (Astoria's round tip)
    for oid, o in OVERRIDES.items():
        if "label" not in o or not oid.isdigit():
            continue
        geom = next((gm for i, typ, t, gm in osm.areas if str(i) == oid), None)
        if geom is None:
            continue
        pts = np.array(geom.exterior.coords)
        mu = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - mu)
        ax = vt[0] if vt[0][0] >= 0 else -vt[0]
        tip = pts[np.argmin((pts - mu) @ ax)]
        gt = int(g[int(tip[1]), int(tip[0])])
        target = np.array([tip[0], gt + 22.0, tip[1]])
        best = None
        for rad in (110, 90, 140, 70, 55):
            for deg in range(0, 181, 15):  # sweep the half-plane facing away from the building
                for sgn in (1, -1):
                    a = math.radians(deg) * sgn
                    d2 = np.array([-ax[0] * math.cos(a) - ax[1] * math.sin(a), ax[0] * math.sin(a) - ax[1] * math.cos(a)])
                    c2 = tip + d2 * rad
                    ci, ri = int(c2[0]), int(c2[1])
                    if not (0 <= ri < vol.shape[1] and 0 <= ci < vol.shape[2]) or bmask[ri, ci]:
                        continue
                    cam = np.array([c2[0], g[ri, ci] + 14.0, c2[1]])
                    # line of sight: sample the segment, stop 6 m short of the facade
                    n = int(rad)
                    ok = True
                    for k in range(1, n - 6):
                        p_ = cam + (target - cam) * k / n
                        zi, ri2, ci2 = int(p_[1]), int(p_[2]), int(p_[0])
                        if vol[zi, ri2, ci2] != 0 and vol[zi, ri2, ci2] not in leaf_ids:
                            ok = False
                            break
                    if ok:
                        best = cam
                        break
                if best is not None:
                    break
            if best is not None:
                break
        if best is None:
            note("no clear viewpoint for", oid)
            continue
        views[f"b{oid}"] = dict(label=o["label"].split(" ·")[0], target=[float(v) for v in target],
                                pos=[float(v) for v in best])
        note("viewpoint for", o["label"], "at", [round(float(v)) for v in best])
    st = at("Warszawa Centralna", 15)
    views["station"] = dict(label="Centralna", target=st, pos=add(st, (300, 120, 40)))
    views["skyline"] = dict(label="Skyline", target=[pk[0], 130, pk[2]], pos=add([pk[0], 130, pk[2]], (1150, -10, 520)))
    if "Centrum Nauki Kopernik" in found and "Most Świętokrzyski" in found:
        k, b = at("Centrum Nauki Kopernik"), at("Most Świętokrzyski")
        mid = [(k[0] + b[0]) / 2, g[int(k[2]), int(k[0])] + 6.0, (k[2] + b[2]) / 2]
        views["vistula"] = dict(label="Vistula", target=mid, pos=add(mid, (-180, 260, 520)))
    if "PGE Narodowy" in found:
        st = at("PGE Narodowy")
        tgt = [st[0], g[int(st[2]), int(st[0])] + 20.0, st[2]]
        views["stadium"] = dict(label="PGE Narodowy", target=tgt, pos=add(tgt, (-420, 190, 260)))
    # the whole map, steep from the south: PKiN and the towers on the left, the river, Kopernik and PGE Narodowy right
    H_, W_ = g.shape
    mid = [W_ * 0.56, float(np.median(g)) + 10, H_ * 0.4]
    views["city"] = dict(label="Whole map", target=mid, pos=add(mid, (0, 3500, 2100)))
    return views


# porches found in the LiDAR (a 19 m roof a few metres deep in front of a taller block), grid rows/cols inclusive
PKIN_PORTICOS = [dict(rows=(1216, 1240), cols=(796, 802), face="E", h=14),  # main entrance, Plac Defilad side
                 dict(rows=(1157, 1161), cols=(740, 757), face="N", h=14),  # north porch, Świętokrzyska side
                 dict(rows=(1296, 1300), cols=(740, 757), face="S", h=14),  # south porch, Aleje Jerozolimskie side
                 # the four wings' porches, 13-14 m roofs ~7 m deep: Teatr Dramatyczny (NE), Pałac Młodzieży (SW)...
                 dict(rows=(1095, 1101), cols=(803, 827), face="N", h=11),
                 dict(rows=(1095, 1102), cols=(668, 693), face="N", h=11),
                 dict(rows=(1355, 1362), cols=(804, 828), face="S", h=11),
                 dict(rows=(1356, 1363), cols=(670, 694), face="S", h=11)]


# Loggias and colonnades on facades at any angle (grid x, y = column, row): the front line p0 -> p1, carved `depth` m
# inward (the side where the building is) from z0 to z1 m above ground, leaving `col` m wide columns every `step` m
# along the front, in the wall's own colour without windows. From the photos and the ortho (grid overlay).
LOGGIAS = [
    # Teatr Wielki, Plac Teatralny front: the two-storey colonnade over the ground-floor arcade
    dict(name="Teatr Wielki colonnade", p0=(1440, 48.5), p1=(1480, 41.5), depth=4, z0=7, z1=21, step=4, col=1),
    dict(name="Teatr Wielki arcade", p0=(1440, 48.5), p1=(1480, 41.5), depth=3, z0=1, z1=6, step=4, col=2),
]


# landmark buildings whose walls get the gentle cleanup (1 m slots filled, 1 m ribs dropped; PKiN has its own)
REGULAR_WALLS = ["Teatr Wielki", "Zachęta", "Gmach Główny PW", "Sejm RP", "Hala Koszyki", "Biblioteka Uniwersytecka",
                 "Elektrownia Powiśle", "Warszawa Centralna", "Muzeum Sztuki Nowoczesnej", "TR Warszawa", "Rotunda PKO",
                 "Centrum Nauki Kopernik", "Astoria", "Złote Tarasy"]


def regularize_walls(vol, g, feats, note, L=3, Lo=2, min_area=30):
    """Per landmark (its OSM outlines and parts, by name), layer by layer: fill notches up to L-2 m wide along a wall,
    drop bumps narrower than Lo m across. A clean diagonal staircase stays (its cells lie in runs of 2+ both ways)."""
    v, h, vo, ho = np.ones((L, 1), bool), np.ones((1, L), bool), np.ones((Lo, 1), bool), np.ones((1, Lo), bool)
    for name in REGULAR_WALLS:
        fs = [f for f in feats if _name(f) == name]
        if not fs:
            note("regularize: no outline for", name); continue
        rr = np.concatenate([f["rr"] for f in fs]); cc = np.concatenate([f["cc"] for f in fs])
        r0, r1, c0, c1 = rr.min() - 3, rr.max() + 4, cc.min() - 3, cc.max() + 4
        foot = np.zeros((r1 - r0, c1 - c0), bool); foot[rr - r0, cc - c0] = True
        foot = ndimage.binary_dilation(foot, iterations=1)
        box = vol[:, r0:r1, c0:c1]
        g0 = int(np.median(g[rr, cc]))
        added = removed = 0
        solid = np.ones(box.shape[1:], bool)  # filled from the ground up to this layer: a wall, not a canopy or roof
        for z in range(g0 + 2, box.shape[0]):
            lay = box[z]
            solid &= lay != 0
            M = (lay != 0) & foot
            if M.sum() < min_area:
                break
            P = np.pad(M, L)
            Mc = ndimage.binary_closing(P, v) | ndimage.binary_closing(P, h)
            Mo = (ndimage.binary_opening(Mc, vo) & ndimage.binary_opening(Mc, ho))[L:-L, L:-L] & foot
            rem, add = M & ~Mo & solid, Mo & ~M
            if add.any():
                _, (ir, ic) = ndimage.distance_transform_edt(~M, return_indices=True)
                lay[add] = lay[ir[add], ic[add]]
            lay[rem] = 0
            solid &= lay != 0
            added += int(add.sum()); removed += int(rem.sum())
        note(f"walls regularized: {name} +{added} -{removed}")


def apply_loggias(vol, g, pal, note):
    mats = np.array([e[3] for e in pal.entries])
    for lg in LOGGIAS:
        (x0, y0), (x1, y1) = lg["p0"], lg["p1"]
        L = math.hypot(x1 - x0, y1 - y0)
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        nx, ny = -uy, ux  # one normal; flip it toward the building
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        probe = lambda sx, sy: int(vol[int(g[int(my + sy * 3), int(mx + sx * 3)]) + lg["z0"] + 2, int(my + sy * 3), int(mx + sx * 3)] != 0)
        if probe(-nx, -ny) > probe(nx, ny):
            nx, ny = -nx, -ny
        done = {}
        for t in np.arange(0, L, 0.5):
            # the true outer face here: the outermost wall cell within 8 m outside the drawn line, at mid height
            o0 = -0.5
            for o in np.arange(-8, 1, 0.5):
                r, c = int(y0 + uy * t + ny * o), int(x0 + ux * t + nx * o)
                if vol[int(g[r, c]) + (lg["z0"] + lg["z1"]) // 2, r, c]:
                    o0 = o; break
            for o in np.arange(o0, o0 + lg["depth"], 0.5):
                r, c = int(y0 + uy * t + ny * o), int(x0 + ux * t + nx * o)
                is_col = o < o0 + 1.0 and (t % lg["step"]) < lg["col"]
                done[(r, c)] = done.get((r, c), False) or is_col  # any column sample keeps the cell a column
        n_col = 0
        for (r, c), is_col in done.items():
            gz = int(g[r, c])
            seg = vol[gz + lg["z0"]:gz + lg["z1"], r, c]
            if is_col:
                k = seg != 0
                if k.any():
                    rgb = pal.entries[int(seg[k][0])][:3]
                    seg[k] = pal(tuple(rgb), 0)
                    n_col += 1
            else:
                seg[:] = 0
        note(f"loggia {lg['name']}: {len(done)} cells, {n_col} columns")


def pkin_regularize(vol, g, pk, minx, miny, maxx, maxy, g0, pal, note, L=7, Lo=3, min_area=150):
    """PKiN's walls are flat: the LiDAR outline wobbles by a metre from row to row, so each face carried full-height
    1 m slots and ribs, and ornament points stood as rubble on the tiers. Layer by layer (up to where the tower
    narrows below min_area cells), fill notches shorter than L m along a wall and drop anything narrower than
    Lo m across (a cell stays only if it lies in an Lo-run both along rows and along columns; 3 m keeps the 4 m
    deep porches). Round walls
    (Sala Kongresowa) keep their shape: every cell of a staircase circle is in long runs both ways."""
    box = vol[:, miny:maxy, minx:maxx]
    foot = np.zeros(box.shape[1:], bool)
    k = (pk["rr"] >= miny) & (pk["rr"] < maxy) & (pk["cc"] >= minx) & (pk["cc"] < maxx)
    foot[pk["rr"][k] - miny, pk["cc"][k] - minx] = True
    foot = ndimage.binary_dilation(foot, iterations=2)
    # tier tops: LiDAR heights wobble 1-3 m from column to column (a rubble skyline); snap each column to the median
    # of its 5x5 neighbourhood when within 3 m of it (real setbacks are bigger and stay)
    occ = box != 0
    H = occ.shape[0]
    T = np.where(occ.any(0), H - 1 - np.argmax(occ[::-1], axis=0), 0)
    Tm = ndimage.median_filter(T, 5)
    fix = foot & (T > g0 + 5) & (Tm > g0 + 5) & (T != Tm) & (np.abs(T - Tm) <= 3)
    for r, c in zip(*np.nonzero(fix)):
        t, tm = T[r, c], Tm[r, c]
        if t > tm:
            box[tm + 1:t + 1, r, c] = 0
        else:
            box[t + 1:tm + 1, r, c] = box[t, r, c]
    note(f"PKiN tier tops snapped: {int(fix.sum())} columns")
    v, h = np.ones((L, 1), bool), np.ones((1, L), bool)
    vo, ho = np.ones((Lo, 1), bool), np.ones((1, Lo), bool)
    added = removed = 0
    for z in range(g0 + 2, box.shape[0]):
        lay = box[z]
        M = (lay != 0) & foot
        if M.sum() < min_area:
            break
        P = np.pad(M, L)
        Mc = ndimage.binary_closing(P, v) | ndimage.binary_closing(P, h)
        Mo = (ndimage.binary_opening(Mc, vo) & ndimage.binary_opening(Mc, ho))[L:-L, L:-L] & foot
        rem, add = M & ~Mo, Mo & ~M
        if add.any():  # new cells take the nearest existing voxel's colour in this layer
            _, (ir, ic) = ndimage.distance_transform_edt(~M, return_indices=True)
            lay[add] = lay[ir[add], ic[add]]
        lay[rem] = 0
        added += int(add.sum()); removed += int(rem.sum())
    note(f"PKiN walls regularized up to z={z}: +{added} -{removed} voxels")
    # roof voxels left inside walls by the fills (dark specks on the faces): stone
    mats = np.array([e[3] for e in pal.entries])
    pk_ids, cnt = np.unique(box[(box != 0) & (mats[box] == M_PKIN)], return_counts=True)
    stone = pk_ids[np.argmax(cnt)]
    occ = box != 0
    below_occ = np.zeros_like(occ)
    below_occ[:-1] = occ[1:]  # something directly above
    inner_roof = occ & below_occ & (mats[box] == 12) & foot[None]
    box[inner_roof] = stone
    # porticos: the LiDAR sees a porch's roof and the column below it fills solid; open each porch up to `h` m,
    # leaving 1 m columns every 3 m along its front (photos: the main entrance's colonnade, east; the north porch)
    plain = pal(tuple(pal.entries[stone][:3]), 0)  # columns and entablature: dressed stone, no windows
    for pr in PKIN_PORTICOS:
        (r0, r1), (c0, c1), face, hh = pr["rows"], pr["cols"], pr["face"], pr["h"]
        blk = vol[:, r0:r1 + 1, c0:c1 + 1]
        gz = int(g[r0:r1 + 1, c0:c1 + 1].min())
        seg = blk[gz:gz + hh + 6]
        seg[(seg != 0) & (mats[seg] == M_PKIN)] = plain
        # the porch's real front, from the voxels at entablature height (the OSM footprint and the LiDAR can differ
        # by a couple of metres)
        ent = blk[gz + hh + 1] != 0
        er, ec = np.nonzero(ent)
        if not len(er):
            note(f"PKiN portico {face}: nothing at {hh + 1} m"); continue
        fr0, fr1, fc0, fc1 = r0 + er.min(), r0 + er.max(), c0 + ec.min(), c0 + ec.max()
        note(f"PKiN portico {face}: rows {fr0}-{fr1}, cols {fc0}-{fc1}")
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                along = r - r0 if face in "EW" else c - c0
                front = (c >= fc1 - 1) if face == "E" else (c <= fc0 + 1) if face == "W" else \
                    (r <= fr0 + 1) if face == "N" else (r >= fr1 - 1)
                if front and along % 3 == 1:
                    continue
                vol[int(g[r, c]):int(g[r, c]) + hh, r, c] = 0
    note(f"PKiN porticos: {len(PKIN_PORTICOS)}")
    # Sala Kongresowa's curved colonnade (west): the 13-14 m ring 3-4 m wide round the drum, open to 10 m with
    # 1 m columns every 3 m along the arc
    kr0, kr1, kc0, kc1 = 1185, 1276, 608, 662
    sub = vol[:, kr0:kr1, kc0:kc1]
    occ2 = (sub != 0)
    T2 = np.where(occ2.any(0), occ2.shape[0] - 1 - np.argmax(occ2[::-1], axis=0), 0) - g[kr0:kr1, kc0:kc1]
    built = T2 > 3
    dist = ndimage.distance_transform_edt(np.pad(built, 1))[1:-1, 1:-1]
    ring = built & (T2 >= 11) & (T2 <= 16) & (dist <= 4)
    rr_, cc_ = np.nonzero(ring)
    kcy, kcx = 1230 - kr0, 662 - kc0  # the drum's centre lies east of the window
    n_col = 0
    for r, c in zip(rr_, cc_):
        gz_ = int(g[kr0 + r, kc0 + c])
        arc = math.atan2(r - kcy, c - kcx) * math.hypot(r - kcy, c - kcx)
        if dist[r, c] <= 1 and (arc % 3.0) < 1.0:
            sub[gz_:gz_ + 10, r, c] = plain
            n_col += 1
            continue
        sub[gz_:gz_ + 10, r, c] = 0
    note(f"Sala Kongresowa colonnade: {len(rr_)} cells, {n_col} column cells")
    occ = box != 0  # debug: the final PKiN height map above ground (data/debug/pkin_top.npz)
    Path("data/debug").mkdir(parents=True, exist_ok=True)
    np.savez_compressed("data/debug/pkin_top.npz", top=np.where(occ.any(0), occ.shape[0] - 1 - np.argmax(occ[::-1], axis=0), 0)
                        - g[miny:maxy, minx:maxx], miny=miny, minx=minx)


def pkin_clock(vol, g, feats, pal, note, z_rel=165, R=3.2):
    """Millennium Clock (2000): four faces, 6 m across, ~165 m up the PKiN tower (research.md)."""
    pk = next(f for f in feats if f["tags"].get("name") == "Pałac Kultury i Nauki")
    minx, miny, maxx, maxy = (int(v) for v in pk["geom"].bounds)
    g0 = int(np.median(g[pk["rr"], pk["cc"]]))
    pkin_regularize(vol, g, pk, minx, miny, maxx, maxy, g0, pal, note)
    # the published ~165 m lands on a setback in the LiDAR massing: centre the clock on the first
    # plain stretch of shaft (constant cross-section for >= 9 m) at or above it
    def area(zz):
        return int((vol[zz, miny:maxy, minx:maxx] != 0).sum())
    z = g0 + z_rel
    for z_try in range(g0 + z_rel - 4, g0 + z_rel + 30):
        a0 = area(z_try)
        if a0 and all(abs(area(z_try + k) - a0) <= 0.08 * a0 for k in range(1, 10)):
            z = z_try + 5
            break
    sl = vol[z, miny:maxy, minx:maxx] != 0
    rows, cols = np.nonzero(sl)
    if len(rows) == 0:
        note("PKiN clock: no tower at z", z)
        return
    # keep the central tower blob only
    from scipy import ndimage
    lab, n = ndimage.label(sl)
    big = np.argmax(ndimage.sum(sl, lab, range(1, n + 1))) + 1
    rows, cols = np.nonzero(lab == big)
    r0, r1, c0, c1 = rows.min() + miny, rows.max() + miny, cols.min() + minx, cols.max() + minx
    rc, cc = (r0 + r1) / 2, (c0 + c1) / 2
    face = pal((246, 242, 228), M_CLOCK)
    hand = pal((35, 33, 30), M_PKIN)
    for axis, sign in ((0, -1), (0, 1), (1, -1), (1, 1)):
        # fixed face plane: the outermost wall at the clock centre (flush: a proud face showed its dark hands
        # sticking out of the tower's silhouette from the sides)
        if axis == 0:
            line = vol[z, r0 - 2:r1 + 3, int(math.floor(cc + 0.5))]
            idx = np.nonzero(line)[0]
            plane = (r0 - 2 + idx[0]) if sign < 0 else (r0 - 2 + idx[-1])
        else:
            line = vol[z, int(math.floor(rc + 0.5)), c0 - 2:c1 + 3]
            idx = np.nonzero(line)[0]
            plane = (c0 - 2 + idx[0]) if sign < 0 else (c0 - 2 + idx[-1])
        for dz in range(-4, 5):
            for du in range(-4, 5):
                d = (dz ** 2 + du ** 2) ** 0.5
                if d > R + 0.1:
                    continue
                # a plain white disc with two hands (minute up, hour right): at 1 m voxels a stone rim plus V-shaped
                # hands read as a small window
                v = hand if (du == 0 and 0 <= dz <= 2) or (dz == 0 and 0 <= du * sign <= 1) else face
                # the face is the outermost voxel: clear any wall standing proud of the plane in front of it
                if axis == 0:
                    cx_ = int(math.floor(cc + du + 0.5))  # not round(): halves go to even, skipping every other column
                    if sign < 0:
                        vol[z + dz, plane - 3:plane, cx_] = 0
                    else:
                        vol[z + dz, plane + 1:plane + 4, cx_] = 0
                    vol[z + dz, plane, cx_] = v
                else:
                    ry_ = int(math.floor(rc + du + 0.5))
                    if sign < 0:
                        vol[z + dz, ry_, plane - 3:plane] = 0
                    else:
                        vol[z + dz, ry_, plane + 1:plane + 4] = 0
                    vol[z + dz, ry_, plane] = v
    pkin_crown(vol, pal, pk, z, minx, miny, maxx, maxy, note)
    pkin_windows(vol, pal, g0, note)
    note(f"PKiN clock at z={z} (rel {z - g0} m), tower {r1 - r0 + 1}x{c1 - c0 + 1} m")


def pkin_crown(vol, pal, pk, z_clock, minx, miny, maxx, maxy, note):
    """Above the clock storey (photo 23.09.2026, visual_ref.md): a short verdigris pyramidal cap, a small open
    stage, a dark bronze sphere and a long gilded spire, a lattice tapering to a needle. The LiDAR blob there is replaced by clean geometry."""
    verd, bronze, gold = pal((78, 127, 106), M_PKIN), pal((70, 56, 42), 6), pal((190, 160, 62), 6)
    box = vol[:, miny:maxy, minx:maxx]
    occ = (box != 0).reshape(box.shape[0], -1).sum(1)
    top = int(np.nonzero(occ)[0].max())
    base = occ[z_clock]
    z_roof = next(zz for zz in range(z_clock + 3, top) if occ[zz] < 0.6 * base)  # top of the clock storey
    rows, cols = np.nonzero(box[z_clock] != 0)
    rc, cc = (rows.min() + rows.max()) / 2, (cols.min() + cols.max()) / 2
    half = (min(rows.max() - rows.min(), cols.max() - cols.min()) + 1) / 2
    box[z_roof:top + 1] = 0
    # pyramidal cap: low, from the tower's width down to ~3 m over ~5 m (photo comparison, Aug 2019: it is a quarter
    # the height of the clock storey, not a dome; 11 m read as a green helmet)
    cap_h = 5
    for k in range(cap_h):
        hw = half * (1 - k / cap_h) + 1.5 * (k / cap_h)
        r0, r1 = int(np.floor(rc - hw + 0.5)), int(np.ceil(rc + hw - 0.5))
        c0, c1 = int(np.floor(cc - hw + 0.5)), int(np.ceil(cc + hw - 0.5))
        box[z_roof + k, r0:r1 + 1, c0:c1 + 1] = verd
    ri, ci = int(round(rc)), int(round(cc))
    z = z_roof + cap_h
    for dr in (-1, 1):  # open bronze lantern, ~6 m: four posts round the mast foot
        for dc in (-1, 1):
            box[z:z + 6, ri + dr, ci + dc] = bronze
    box[z:z + 7, ri, ci] = gold
    zs = z + 8  # bronze sphere, ~3 m
    for dz in range(-1, 2):
        for dr in range(-1, 2):
            for dc in range(-1, 2):
                if abs(dz) + abs(dr) + abs(dc) <= 2:
                    box[zs + dz, ri + dr, ci + dc] = bronze
    # gilded spire up to the measured 237 m: a lattice that tapers (photos; LiDAR 6 m wide to ~215 m, 4 m to ~228 m):
    # 3 m square, its corners solid and its faces ringed every other metre, then a cross, then a needle
    z0 = zs + 2
    for zz in range(z0, top + 1):
        t = (zz - z0) / max(1, top - z0)
        box[zz, ri, ci] = gold
        if t < 0.45:
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if (dr and dc) or (zz - z0) % 2 == 0:
                        box[zz, ri + dr, ci + dc] = gold
        elif t < 0.7 and (zz - z0) % 2 == 0:
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                box[zz, ri + dr, ci + dc] = gold
    note(f"PKiN crown: cap {z_roof}-{z_roof + cap_h}, sphere {zs}, gilded spire to {top}")
    pkin_pinnacles(vol, pk, z_roof, minx, miny, maxx, maxy, note)


def paint_windows(vol, win, faces, centres, rows, w=2, h=2, depth=1, plane_tol=3):
    """Windows painted from a measured elevation instead of a shader rhythm. faces: (axis, plane, normal, u_centre)
    with axis 0 = the face is a row plane (normal along rows), 1 = a column plane; centres: window centres along the
    face in metres from u_centre; rows: (z, height) of each window row (absolute voxel z). For each window the wall
    surface is found within plane_tol of the plane (one depth for the whole window, from its middle cell); if anything
    stands further out (a lower block, a porch) the window is skipped. The surface voxels are cleared to `depth` and
    the glass set behind them. Returns the number of windows cut."""
    n = 0
    for axis, plane, nrm, uc in faces:
        get = (lambda zz, q, u: vol[zz, q, u]) if axis == 0 else (lambda zz, q, u: vol[zz, u, q])
        def put(zz, q, u, v):
            if axis == 0: vol[zz, q, u] = v
            else: vol[zz, u, q] = v
        for c in centres:
            u0 = int(math.floor(uc + c - w / 2 + 0.5))
            for z0, hh in rows:
                um, zm = u0 + w // 2, z0 + hh // 2
                surf = None
                for t in range(plane_tol + 4, -plane_tol - 1, -1):  # from outside in
                    if get(zm, plane + t * nrm, um):
                        surf = t if t <= plane_tol else None
                        break
                if surf is None:
                    continue
                pl = plane + surf * nrm
                for u in range(u0, u0 + w):
                    for zz in range(z0, z0 + hh):
                        if not get(zz, pl, u) or get(zz, pl + nrm, u):
                            continue  # not flush with the window's surface here
                        for d in range(depth):
                            put(zz, pl - d * nrm, u, 0)
                        if win is not None:
                            put(zz, pl - depth * nrm, u, win)
                n += 1
    return n


def _faces(r0, r1, c0, c1):
    """The four faces of an axis-aligned block (inclusive grid bounds): N, S (row planes), W, E (column planes)."""
    return [(0, r0, -1, (c0 + c1 + 1) / 2), (0, r1, 1, (c0 + c1 + 1) / 2),
            (1, c0, -1, (r0 + r1 + 1) / 2), (1, c1, 1, (r0 + r1 + 1) / 2)]


def pkin_windows(vol, pal, g0, note):
    """PKiN's windows from its elevation (Commons photos of the east and north faces, 2015-2019, counted bay by bay):
    the shaft: 11.5 m corner piers with ONE window column each, the 22 m middle with FIVE columns 4.8 m apart;
    storeys 3.8 m below the 30th-floor terrace (114 m); at the top a band of small windows and the terrace loggia:
    five tall openings in the middle, an arched one in each pier. Above: a stage with five small windows, a stage with
    five arches. The four corner towers: three columns on each face, storeys 4 m, a band of small squares and a loggia
    of three tall openings under the cornice. Grid bounds from the voxel massing (LiDAR)."""
    win = pal((58, 70, 68), MAT_IDS["window"])
    z = lambda hgt: g0 + int(round(hgt))
    n = 0
    shaft = _faces(1207, 1250, 727, 770)
    cols = [-10.2, -5.1, 0, 5.1, 10.2, -17.1, 17.1]  # measured: 5.1 m apart; the pier column 4.9 m in from the edge
    # the 23 m middle stands 1 m back from the piers
    paint_windows(vol, None, shaft, [0], [(z(20), z(108) - z(20))], w=23, depth=1)
    body = [(z(114 - k * 3.8 + 1), 2) for k in range(2, 30)]
    n += paint_windows(vol, win, shaft, cols, body)
    n += paint_windows(vol, win, shaft, cols, [(z(111), 1)], w=1)
    n += paint_windows(vol, win, shaft, cols[:5], [(z(115), 7), (z(123), 1)], depth=2)
    n += paint_windows(vol, win, shaft, cols[5:], [(z(115), 6), (z(123), 1)], depth=2)
    n += paint_windows(vol, win, shaft, cols[5:], [(z(121), 1)], w=1, depth=2)  # the arch's crown
    n += paint_windows(vol, win, _faces(1218, 1239, 738, 759), [-8, -4, 0, 4, 8], [(z(146), 2)], w=1)
    n += paint_windows(vol, win, _faces(1219, 1238, 739, 758), [-7.2, -3.6, 0, 3.6, 7.2], [(z(157), 5)], depth=2)
    towers = [(1194, 1212, 716, 736), (1194, 1212, 761, 782), (1244, 1264, 716, 736), (1244, 1264, 761, 782)]
    trows = [(z(hh), 2) for hh in range(21, 52, 4)]
    for r0, r1, c0, c1 in towers:
        f = _faces(r0, r1, c0, c1)
        n += paint_windows(vol, win, f, [-4.8, 0, 4.8], trows)
        n += paint_windows(vol, win, f, [-4.8, 0, 4.8], [(z(54), 1)], w=1)
        n += paint_windows(vol, win, f, [-4.8, 0, 4.8], [(z(57), 5)], depth=2)
    # the north and south front blocks (30 m): one window column on each side of the porch, three windows over it
    for flank, front, nrm in ((1166, 1162, -1), (1291, 1295, 1)):
        n += paint_windows(vol, win, [(0, flank, nrm, 749.0)], [-15, 15],
                           [(z(hh), 2) for hh in (4, 8.5, 13, 17.5, 22, 26)], plane_tol=4)
        n += paint_windows(vol, win, [(0, front, nrm, 749.0)], [-4.5, 0, 4.5], [(z(23), 2)], plane_tol=2)
    n += pkin_low_windows(vol, win, g0, note)
    note(f"PKiN windows from the elevation: {n} windows")


def pkin_low_windows(vol, win, g0, note, bay=6.3, lo=26):
    """The low blocks (pavilions, wings, the courtyard sides; roofs under `lo` m): photos of the north front
    (Pałac Młodzieży, 2018; 18 m wings measured at 27 px/m) show bays 6.3 m apart, each a tall frame holding two
    windows (4.4-7.8 m and 8.6-11 m) and a single window on the top storey (12.8-14.6 m). Every straight wall run on the outline of the low blocks
    gets as many bays as fit, centred, at least 3 m from its ends. The tower, the front blocks, Sala Kongresowa
    (round: its colonnade) and the porches are left alone."""
    box = vol[:, 1080:1380, 600:900]
    occ = box != 0
    H = occ.shape[0]
    top = np.where(occ.any(0), H - 1 - np.argmax(occ[::-1], axis=0), 0) - g0
    low = (top > 12) & (top < lo)
    low[:, :105] = False  # Sala Kongresowa and its drum (cols < 705)
    low[1162 - 1080:1296 - 1080, 727 - 600:771 - 600] = False  # tower axis: front blocks, shaft
    n = 0
    zc = g0 + 9  # probe height
    for axis in (0, 1):
        for nrm in (-1, 1):
            m = low & occ[zc]
            out = np.roll(occ[zc], -nrm, axis=axis)  # the neighbour on the outside
            face = m & ~out
            lines = face if axis == 0 else face.T
            for q in range(lines.shape[0]):  # q: the plane index
                row = lines[q]
                u = 0
                while u < len(row):
                    if not row[u]:
                        u += 1; continue
                    u1 = u
                    while u1 < len(row) and row[u1]:
                        u1 += 1
                    L = u1 - u
                    if L >= 8:
                        k = max(1, int((L - 6) // bay) + 1)
                        span = (k - 1) * bay
                        cs = [-span / 2 + i * bay for i in range(k)]
                        if axis == 0:
                            fc = [(0, q + 1080, nrm, u + 600 + L / 2)]
                        else:
                            fc = [(1, q + 600, nrm, u + 1080 + L / 2)]
                        ht = int(np.median(top[q, u:u1] if axis == 0 else top[u:u1, q]))
                        rows = [(g0 + 4, 4), (g0 + 9, 2), (g0 + 13, 2)]
                        if ht >= 21:
                            rows.append((g0 + ht - 5, 2))
                        n += paint_windows(vol, win, fc, cs, rows, depth=1, plane_tol=1)
                    u = u1
    note(f"PKiN low blocks: {n} windows")
    return n


def pkin_pinnacles(vol, pk, z_top, minx, miny, maxx, maxy, note):
    """Stone pinnacles along the parapets of every setback (photos: a crown of spikes at each tier's edge): a 1 m spike
    ~3 m tall on every fourth cell of a roof edge that drops 4 m or more, in the wall's colour (the stone below the
    roof voxel, not the grey roof)."""
    box = vol[:, miny:maxy, minx:maxx]
    occ = box != 0
    H = occ.shape[0]
    top = np.where(occ.any(0), H - 1 - np.argmax(occ[::-1], axis=0), 0)
    nb = np.minimum.reduce([np.pad(top, 1, mode="edge")[1 + dr:1 + dr + top.shape[0], 1 + dc:1 + dc + top.shape[1]]
                            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1))])
    g0 = int(top[top > 0].min())
    # only the tower's tiers (corner towers, shaft, stages: above 55 m); the low blocks have plain cornices with
    # balustrades (photos), and spikes on every parapet read as battlements
    edge = (top - nb >= 4) & (top > g0 + 55) & (top < z_top - 2)
    rr, cc = np.nonzero(edge & (((np.arange(top.shape[0])[:, None] + np.arange(top.shape[1])[None, :]) % 4) == 0))
    for r, c in zip(rr, cc):
        z = top[r, c]
        box[z + 1:z + 4, r, c] = box[z - 1, r, c] or box[z, r, c]
    note(f"PKiN pinnacles: {len(rr)}")
