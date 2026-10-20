"""One list of the AOI's trees from Warsaw's databases and OSM (scripts/fetch_trees.py downloads the city's):

- city green-areas database (Baza Obiektów Zieleni, mapa.um.warszawa.pl): inventory number, species, trunk
  circumference, managing unit, data date -- the backbone (35 k trees in the AOI)
- OSM natural=tree: kept where no city tree stands within 2 m (private courtyards, new plantings), with its tags
- the open-data API inventory (2010-13): height, crown diameter and condition, joined to the nearest city tree within
  1.5 m, else kept on its own

Every tree gets a stable id: the city inventory number ("D598322"), else "osm:<node id>", else "um:<numer_inw>".
"""
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from aoi import D, RAW, W, to_grid  # noqa: E402

T4326 = Transformer.from_crs(4326, 2180, always_xy=True)


def _num(v):
    try:
        return float(str(v).replace(",", ".").split()[0])
    except (ValueError, IndexError, TypeError):
        return None


def load(osm_trees):
    """osm_trees: [(oid, tags, Point(col, row))] from voxelize's OSM reader. Returns a list of dicts with grid x, y."""
    out = []
    bos_f = Path(RAW) / "trees" / "bos_trees.json"
    if bos_f.exists():
        for t in json.load(open(bos_f)):
            if t["x2180"] is None:
                continue
            c, r = to_grid(t["x2180"], t["y2180"])
            if not (0 <= c < W and 0 <= r < D):
                continue
            sp = t["species_lat"] if t["species_lat"] not in (None, "brak danych") else None
            out.append(dict(id=t["id"], src="city", x=float(c), y=float(r), species=sp,
                            species_pl=t["species_pl"] if t["species_pl"] not in (None, "brak danych") else None,
                            trunk_cm=_num(t["trunk_cm"]), manager=t["manager"], date=t["date"]))
    n_city = len(out)
    tree = cKDTree([(t["x"], t["y"]) for t in out]) if out else None
    n_osm = 0
    for oid, tg, p in osm_trees:
        if not (0 <= p.x < W and 0 <= p.y < D):
            continue
        if tree is not None:
            d, k = tree.query((p.x, p.y))
            if d < 2.0:
                out[k].setdefault("osm", oid)
                continue
        out.append(dict(id=f"osm:{oid}", src="osm", x=float(p.x), y=float(p.y), species=tg.get("species") or tg.get("genus"),
                        species_pl=tg.get("species:pl"), trunk_cm=_num(tg.get("circumference")) and _num(tg.get("circumference")) * 100,
                        height=_num(tg.get("height")), leaf_type=tg.get("leaf_type"), osm=oid))
        n_osm += 1
    um_f = Path(RAW) / "trees" / "um_drzewa.json"
    n_um = 0
    if um_f.exists():
        d = json.load(open(um_f))
        xs = np.array([float(r["x_wgs84"] or 0) for r in d])
        ys = np.array([float(r["y_wgs84"] or 0) for r in d])
        X, Y = T4326.transform(xs, ys)
        cc, rr = to_grid(X, Y)
        ins = np.nonzero((cc >= 0) & (cc < W) & (rr >= 0) & (rr < D))[0]
        tree = cKDTree([(t["x"], t["y"]) for t in out]) if out else None
        for i in ins:
            u = d[i]
            extra = dict(height=_num(u["wysokosc"]), crown_d=_num(u["srednica_k"]), condition=u["stan_zdrowia"],
                         um_id=u["numer_inw"], um_survey=str(u["data_wyk_pom"]))
            if tree is not None:
                dd, k = tree.query((cc[i], rr[i]))
                if dd < 1.5:
                    for kk, vv in extra.items():
                        if vv is not None and out[k].get(kk) is None:
                            out[k][kk] = vv
                    continue
            out.append(dict(id=f"um:{u['numer_inw']}", src="um", x=float(cc[i]), y=float(rr[i]), species=u["gatunek_1"],
                            species_pl=u["gatunek"], trunk_cm=_num(u["pnie_obwod"]), **extra))
            n_um += 1
    return out, dict(city=n_city, osm_only=n_osm, um_only=n_um)


CONIFER = ("Pinus", "Picea", "Abies", "Taxus", "Thuja", "Larix", "Pseudotsuga", "Juniperus", "Chamaecyparis", "Metasequoia")


def is_conifer(t):
    sp = t.get("species") or ""
    return sp.startswith(CONIFER) or t.get("leaf_type") == "needleleaved"


def _rings(flat_rings):
    return [list(zip(r[0::2], r[1::2])) for r in flat_rings]


def attach_crowns(trees):
    """the Mapa Koron Drzew crown (2019, remote sensing) each tree stands in: id, area m2, species group"""
    from shapely.geometry import Point, Polygon
    from shapely.strtree import STRtree
    from aoi import to_world
    f = Path(RAW) / "trees" / "bos_crowns.json"
    if not f.exists():
        return 0
    polys, meta = [], []
    for c in json.load(open(f)):
        gm = c["geometry"]
        parts = [gm["coordinates"]] if gm["type"] == "Polygon" else gm["coordinates"]
        for pr in parts:
            rings = _rings(pr)
            if len(rings[0]) < 3:
                continue
            try:
                pg = Polygon(rings[0], rings[1:])
            except Exception:  # noqa: BLE001
                continue
            if pg.is_valid and pg.area > 0:
                polys.append(pg)
                lab = c.get("label") or ""
                lat = lab.split("Gatunek ŁC:")[-1].split("\n")[0].strip() if "Gatunek ŁC:" in lab else None
                meta.append((c["id"], c.get("species_pl"), lat))
    tree = STRtree(polys)
    n = 0
    for t in trees:
        x, y = to_world(t["x"], t["y"])
        p = Point(float(x), float(y))
        for i in tree.query(p, predicate="within"):
            cid, sp, lat = meta[i]
            t["crown_id"], t["crown_m2"], t["crown_sp"] = cid, round(polys[i].area, 1), sp
            n += 1
            break
    return n
