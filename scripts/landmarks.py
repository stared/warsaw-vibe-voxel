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
           "bronze_grid": 15, "sign": 16, "sign_band": 18}
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
    o = override_for(f)
    return _style(pal, o["wall"]) if o and "wall" in o else None


def apply_stripes(vol, g, bmask, pal, osm, cells_of, note):
    """overrides.json areas with "stripes": vertical bands of colour by angle around the area's centre on every
    building column inside it, from 3 m up to (not including) the roof voxel -- e.g. PGE Narodowy's red and silver
    facade. Whole columns, because the LiDAR bowl rises above the OSM part heights."""
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
            # open above the pitch up to 40 m: the spire hub hangs on its cables (the LiDAR column stood on the grass)
            for r_, c_ in zip(hr, hc):
                vol[g[r_, c_]:g[r_, c_] + 40, r_, c_] = 0
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
            note("infield:", o.get("name", oid)[:30], len(hr), "cells")
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
            k = int((math.atan2(r + 0.5 - cy, c + 0.5 - cx) + math.pi) * R / st.get("width", 3)) % len(cols)
            col = vol[z0:z1, r, c]
            vol[z0:z1, r, c] = np.where(col != 0, cols[k], 0)
            n += 1
        note("stripes:", o.get("name", oid)[:40], n, "columns")


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


def pkin_clock(vol, g, feats, pal, note, z_rel=165, R=3.2):
    """Millennium Clock (2000): four faces, 6 m across, ~165 m up the PKiN tower (research.md)."""
    pk = next(f for f in feats if f["tags"].get("name") == "Pałac Kultury i Nauki")
    minx, miny, maxx, maxy = (int(v) for v in pk["geom"].bounds)
    g0 = int(np.median(g[pk["rr"], pk["cc"]]))
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
    rim = pal((60, 56, 50), M_PKIN)
    hand = pal((35, 33, 30), M_PKIN)
    for axis, sign in ((0, -1), (0, 1), (1, -1), (1, 1)):
        # fixed face plane: outermost wall at the clock centre, plus one voxel proud of it
        if axis == 0:
            line = vol[z, r0 - 2:r1 + 3, int(round(cc))]
            idx = np.nonzero(line)[0]
            plane = (r0 - 2 + idx[0] - 1) if sign < 0 else (r0 - 2 + idx[-1] + 1)
        else:
            line = vol[z, int(round(rc)), c0 - 2:c1 + 3]
            idx = np.nonzero(line)[0]
            plane = (c0 - 2 + idx[0] - 1) if sign < 0 else (c0 - 2 + idx[-1] + 1)
        for dz in range(-4, 5):
            for du in range(-4, 5):
                d = (dz ** 2 + du ** 2) ** 0.5
                if d > R + 0.6:
                    continue
                v = rim if d > R - 0.5 else face
                if d < R - 0.6 and ((du == 0 and dz == 0) or (dz > 0 and abs(du) == dz and d < 2.3)):
                    v = hand
                if axis == 0:
                    vol[z + dz, plane, int(round(cc + du))] = v
                else:
                    vol[z + dz, int(round(rc + du)), plane] = v
    pkin_crown(vol, pal, pk, z, minx, miny, maxx, maxy, note)
    note(f"PKiN clock at z={z} (rel {z - g0} m), tower {r1 - r0 + 1}x{c1 - c0 + 1} m")


def pkin_crown(vol, pal, pk, z_clock, minx, miny, maxx, maxy, note):
    """Above the clock storey (photo 23.09.2026, visual_ref.md): a short verdigris pyramidal cap, a small open
    stage, a dark bronze sphere and a long, thin gilded spire. The LiDAR blob there is replaced by clean geometry."""
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
    # pyramidal cap: from the full tower width down to ~2 m over ~11 m
    cap_h = 11
    for k in range(cap_h):
        hw = half * (1 - k / cap_h) + 1.0 * (k / cap_h)
        r0, r1 = int(np.floor(rc - hw + 0.5)), int(np.ceil(rc + hw - 0.5))
        c0, c1 = int(np.floor(cc - hw + 0.5)), int(np.ceil(cc + hw - 0.5))
        box[z_roof + k, r0:r1 + 1, c0:c1 + 1] = verd
    ri, ci = int(round(rc)), int(round(cc))
    z = z_roof + cap_h
    box[z:z + 3, ri, ci] = gold  # open stage / mast foot
    zs = z + 4  # bronze sphere, ~3 m
    for dz in range(-1, 2):
        for dr in range(-1, 2):
            for dc in range(-1, 2):
                if abs(dz) + abs(dr) + abs(dc) <= 2:
                    box[zs + dz, ri + dr, ci + dc] = bronze
    box[zs + 2:top + 1, ri, ci] = gold  # needle up to the measured 237 m
    note(f"PKiN crown: cap {z_roof}-{z_roof + cap_h}, sphere {zs}, gilded spire to {top}")
