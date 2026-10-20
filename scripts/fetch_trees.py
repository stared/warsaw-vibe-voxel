"""Warsaw's tree databases over the AOI -> data/raw/trees/

1. City green-areas database (Baza Obiektów Zieleni, mapa.um.warszawa.pl "Zieleń" map; Zarząd Zieleni and district
   inventories): one point per tree with its inventory number (NUMER_INW, e.g. D598322), Polish and Latin species,
   trunk circumference, managing unit and data date. Served by the city's Oracle MapViewer data server as GeoJSON, one
   theme per species group (BOS_ZIELEN_DRZEWA_<k>_*).
2. Mapa Koron Drzew (remote-sensing tree crown map, 2020+): one polygon per crown with its species, per district
   (BOS_KORONY_<DISTRICT>).
3. The open-data API inventory (api.um.warszawa.pl, resource ed6217dd-...): 139 k street trees surveyed 2010-2013
   with height, crown diameter and condition (fetched separately into um_drzewa.json).

usage: uv run python scripts/fetch_trees.py      (polite: one request at a time, cached per tile)
"""
import json
import math
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from aoi import D, W, to_world  # noqa: E402

URL = "https://mapa.um.warszawa.pl/mapviewer/dataserver/DANE_WAWA"
OUT = Path("data/raw/trees")
TREES = [f"BOS_ZIELEN_DRZEWA_{k}_MOD_BOS" for k in range(1, 21) if k not in (11, 12)] + \
        ["BOS_ZIELEN_DRZEWA_11_WA", "BOS_ZIELEN_DRZEWA_12_WA"]
CROWNS = ["BOS_KORONY_SRODMIESCIE", "BOS_KORONY_WOLA", "BOS_KORONY_PRAGA_POLNOC", "BOS_KORONY_PRAGA_POLUDNIE",
          "BOS_KORONY_MOKOTOW", "BOS_KORONY_OCHOTA", "BOS_KORONY_ZOLIBORZ"]
OTHER = ["BOS_ZIELEN_POMNIKI_SM_NEW", "BOS_ZIELEN_GRUPY_DRZEW_NEW"]
UA = {"User-Agent": "warsaw-voxel-research/0.1 (piotr.migdal@quesma.com)"}


def aoi_bbox(pad=20):
    xs, ys = zip(*[to_world(i, j) for i in (-pad, W + pad) for j in (-pad, D + pad)])
    return min(xs), min(ys), max(xs), max(ys)


def fetch(theme, bb):
    for attempt in range(5):
        try:
            r = requests.get(URL, params=dict(t=theme, bbox=",".join(f"{v:.1f}" for v in bb), bbox_srid=2180,
                                              to_srid=2180, include_label_box="false"), headers=UA, timeout=180)
            d = r.json()
            if "mds_error" in d:
                raise RuntimeError(d["mds_error"]["message"])
            return d
        except Exception as e:  # noqa: BLE001
            print("  retry", theme, e)
            time.sleep(5 * (attempt + 1))
    return None


def label_fields(lab):
    out = {}
    for line in (lab or "").split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def main():
    x0, y0, x1, y1 = aoi_bbox()
    S = 1000.0
    tiles = [(x0 + i * S, y0 + j * S, min(x0 + (i + 1) * S, x1), min(y0 + (j + 1) * S, y1))
             for i in range(math.ceil((x1 - x0) / S)) for j in range(math.ceil((y1 - y0) / S))]
    (OUT / "bos").mkdir(parents=True, exist_ok=True)
    for theme in TREES + OTHER + CROWNS:
        for k, bb in enumerate(tiles):
            f = OUT / "bos" / f"{theme}_{k}.json"
            if f.exists():
                continue
            d = fetch(theme, bb)
            if d is None:
                print("FAILED", theme, k)
                continue
            f.write_text(json.dumps(d, ensure_ascii=False))
            print(theme, k, len(d.get("features", [])), flush=True)
            time.sleep(0.3)
    # merge: trees (one record per inventory number) and crowns
    trees, crowns = {}, {}
    for f in sorted((OUT / "bos").glob("*.json")):
        theme = re.sub(r"_\d+$", "", f.stem)
        d = json.loads(f.read_text())
        for ft in d.get("features", []):
            p = ft["properties"]
            if theme in CROWNS:
                crowns[(theme, ft["_id"])] = dict(id=f"{theme}:{ft['_id']}", species_pl=p.get("NAZWA_SERWIS"),
                                                  type=p.get("TYP"), label=p.get("_label_"), geometry=ft["geometry"])
            else:
                lf = label_fields(p.get("_label_"))
                key = p.get("NAZWA_SERWIS") or ft["_id"]
                x, y = ft["geometry"]["coordinates"][:2] if ft["geometry"]["type"] == "Point" else (None, None)
                trees[(theme, key)] = dict(id=key, theme=theme, x2180=x, y2180=y, species_pl=lf.get("Nazwa polska"),
                                           species_lat=lf.get("Nazwa łacińska"), trunk_cm=lf.get("Obwód pnia w cm"),
                                           manager=lf.get("Jednostka zarządzająca"),
                                           date=lf.get("Aktualność danych na dzień"), label=p.get("_label_"),
                                           geometry=None if x is not None else ft["geometry"])
    json.dump(list(trees.values()), open(OUT / "bos_trees.json", "w"), ensure_ascii=False)
    json.dump(list(crowns.values()), open(OUT / "bos_crowns.json", "w"), ensure_ascii=False)
    print(len(trees), "tree records,", len(crowns), "crowns")


if __name__ == "__main__":
    main()
