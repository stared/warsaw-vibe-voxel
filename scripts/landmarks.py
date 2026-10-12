"""Curated, research-backed details (see research.md) layered on top of the data-driven voxels."""
import math

import numpy as np

M_WALL, M_GLASS, M_PKIN, M_CONCRETE, M_CLOCK = 1, 2, 7, 13, 14

# OSM name -> (label, note, anchor). Order = label priority (decluttering keeps earlier ones).
# anchor "top": highest voxel in the footprint (towers, spires); "center": top voxel at the centroid.
LABELS = {
    "Pałac Kultury i Nauki": ("Palace of Culture and Science", "237 m incl. spire, 1955", "top"),
    "Varso Tower": ("Varso Tower", "310 m incl. spire, 2022", "top"),
    "Złota 44": ("Złota 44", "192 m, Daniel Libeskind, 2017", "top"),
    "Warszawa Centralna": ("Warszawa Centralna", "main station, 1975", "center"),
    "Złote Tarasy": ("Złote Tarasy", "glass canopy, 2007", "center"),
    "Muzeum Sztuki Nowoczesnej": ("Museum of Modern Art", "opened Oct 2024", "center"),
    "Plac Centralny": ("Plac Centralny", "opened Jun 2025", "center"),
    "TR Warszawa": ("TR Warszawa site", "theatre under construction", "center"),
    "Rotunda PKO": ("Rotunda", "rebuilt 2019", "center"),
    "Park Świętokrzyski": ("Park Świętokrzyski", "", "center"),
    "Rondo 1": ("Rondo 1", "192 m, 2006", "top"),
    "Q22": ("Q22", "195 m, 2016", "top"),
    "InterContinental": ("InterContinental", "164 m, 2004", "top"),
    "Centrum LIM": ("Marriott", "170 m incl. antenna, 1989", "top"),
    "Novotel Warszawa Centrum": ("Novotel", "111 m, 1974", "top"),
    "Cosmopolitan": ("Cosmopolitan", "160 m, Helmut Jahn, 2013", "top"),
    "Spektrum Tower": ("Spektrum Tower", "128 m, 2003", "top"),
    "Central Point": ("Central Point", "2022", "top"),
    "Ilmet": ("Ilmet", "1997, being stripped for Warsaw One", "top"),
    "The Westin Warsaw": ("The Westin", "2003", "top"),
}
# places without a single OSM polygon (EPSG:2180 x, y)
EXTRA_LABELS = [("Zielona Złota", "street greening, opened Aug 2026", 637420, 487015)]


def adjust_heights(top, feats, note):
    """Hook for per-building height corrections (none needed unless the cross-check flags one)."""


def wall_override(f, pal):
    n = f["tags"].get("name") or (f.get("parent") or {}).get("tags", {}).get("name")
    if _name(f) == "Złote Tarasy" and f["tags"].get("building:colour", "").lower() == "#336699":
        return pal((198, 212, 216), M_GLASS)
    if n == "Centrum LIM" and (f["maxh"] or 0) > 20:
        return pal((70, 74, 80), M_GLASS)  # Marriott tower: dark smoked glass
    if n in ("Muzeum Sztuki Nowoczesnej", "Kinomuzeum"):
        return pal((236, 234, 228), M_CONCRETE)  # white architectural concrete (research.md)
    return None


def _name(f):
    return f["tags"].get("name") or (f.get("parent") or {}).get("tags", {}).get("name")


def roof_override(f, pal):
    # Złote Tarasy: the undulating canopy is clear glass on a white steel lattice (OSM tags it #336699)
    if _name(f) == "Złote Tarasy" and f["tags"].get("building:colour", "").lower() == "#336699":
        return pal((206, 218, 220), M_GLASS)
    return None


def small_tree(vol, g, r, c, h, leaves, trunk, height=None):
    """A young voxel tree (e.g. the 2025-26 plantings on Plac Centralny / Złota)."""
    H = int(height or 6 + h % 3)
    z0 = int(g[r, c])
    tr = max(2, H // 2 - 1)
    vol[z0:z0 + tr, r, c] = trunk
    rad = 1.6 + (h >> 4) % 2 * 0.6
    cz = z0 + tr + (H - tr) / 2
    leaf = leaves[(h >> 8) % 5]
    for dz in range(-3, 4):
        for dr in range(-3, 4):
            for dc in range(-3, 4):
                rz = (H - tr) / 2 + 0.3
                if (dr / rad) ** 2 + (dc / rad) ** 2 + ((dz + 0.5) / rz) ** 2 <= 1:
                    zz, rr, cc = int(cz + dz), r + dr, c + dc
                    if 0 <= rr < vol.shape[1] and 0 <= cc < vol.shape[2] and 0 <= zz < vol.shape[0] and vol[zz, rr, cc] == 0:
                        vol[zz, rr, cc] = leaf


def details(vol, g, top, topi, bmask, feats, pal, C, osm, cells_of, note):
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
    labels = [found[n] for n in LABELS if n in found]
    from aoi import to_grid
    for label, sub, wx, wy in EXTRA_LABELS:
        c, r = (int(v) for v in to_grid(wx, wy))
        labels.append(dict(name=label, note=sub, x=c, y=r, z=top_at(r, c)))
    note("labels:", [l["name"] for l in labels])
    return labels, make_views(found, osm, g, top_at, note)


def make_views(found, osm, g, top_at, note):
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
        views["zlota"] = dict(label="Złota street", target=[*(p0 + d * L * 0.55)[:1], gz + 3, (p0 + d * L * 0.55)[1]],
                              pos=[float(p0[0] - d[0] * 20), gz + 10, float(p0[1] - d[1] * 20)])
        views["zlota"]["target"] = [float(v) for v in views["zlota"]["target"]]
        note("Złota street view along", round(L), "m of street east of Marszałkowska")
    st = at("Warszawa Centralna", 15)
    views["station"] = dict(label="Centralna", target=st, pos=add(st, (300, 120, 40)))
    views["skyline"] = dict(label="Skyline", target=[pk[0], 130, pk[2]], pos=add([pk[0], 130, pk[2]], (1150, -10, 520)))
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
    note(f"PKiN clock at z={z} (rel {z - g0} m), tower {r1 - r0 + 1}x{c1 - c0 + 1} m")
