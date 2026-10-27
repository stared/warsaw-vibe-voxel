"""What every building is, for its lit windows at night: a 1 m map of kind (residential, office, hotel, retail, public,
religious, other) and a per-building number the viewer turns into that building's own habits.

Kind from the OSM building tag, else from what the footprint or the points inside it are (office=*, tourism=hotel, shop,
amenity), else from the landuse around it.

Output web/public/data/windows.bin: gzip of uint8[D, W], kind in the low 3 bits (0: no building), the building's
number (0-31) in the high 5.
"""
import gzip
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio.features
from affine import Affine
from shapely.strtree import STRtree

from aoi import D, W
from osm import OSM

OUT = Path(__file__).resolve().parent.parent / "web/public/data/windows.bin"
KINDS = ["none", "residential", "office", "hotel", "retail", "public", "religious", "other"]
BY_TAG = {
    "residential": {"apartments", "residential", "house", "detached", "semidetached_house", "terrace", "dormitory"},
    "office": {"office", "commercial"},
    "hotel": {"hotel"},
    "retail": {"retail", "supermarket", "kiosk", "mall"},
    "public": {"government", "public", "civic", "university", "school", "college", "kindergarten", "hospital", "museum",
               "theatre", "palace", "train_station", "transportation", "library"},
    "religious": {"church", "cathedral", "chapel", "religious", "synagogue", "mosque"},
}
TAG = {v: k for k, vs in BY_TAG.items() for v in vs}
PUBLIC_AMENITY = {"university", "school", "college", "hospital", "townhall", "courthouse", "library", "theatre",
                  "arts_centre", "kindergarten", "police", "embassy"}


def kind_of(t, inside, landuse):
    k = TAG.get(t.get("building"))
    if k:
        return k
    for tags in [t, *inside]:
        if tags.get("tourism") in ("hotel", "hostel", "apartment"):
            return "hotel"
        if tags.get("amenity") == "place_of_worship":
            return "religious"
        if tags.get("amenity") in PUBLIC_AMENITY or tags.get("office") in ("government", "diplomatic"):
            return "public"
    if any("office" in tags for tags in [t, *inside]):
        return "office"
    if t.get("shop") or t.get("building") == "yes" and inside and all("shop" in x for x in inside):
        return "retail"
    return {"residential": "residential", "commercial": "office", "retail": "retail"}.get(landuse, "other")


def main():
    osm = OSM()
    blds = [(g, t) for _, _, t, g in osm.areas
            if t.get("building") not in (None, "no") and "building:part" not in t and t.get("location") != "underground"]
    blds.sort(key=lambda b: -b[0].area)
    pts = [(t, p) for _, t, p in osm.nodes if any(k in t for k in ("office", "shop", "amenity", "tourism"))]
    ptree = STRtree([p for _, p in pts])
    uses = [(t["landuse"], g) for _, _, t, g in osm.areas if t.get("landuse")]
    utree = STRtree([g for _, g in uses])
    shapes, count = [], Counter()
    for i, (g, t) in enumerate(blds):
        inside = [pts[j][0] for j in ptree.query(g, predicate="contains")]
        c = g.representative_point()
        lu = next((uses[j][0] for j in utree.query(c, predicate="within")), None)
        k = kind_of(t, inside, lu)
        count[k] += g.area
        habit = (i * 2654435761 >> 7) % 32
        shapes.append((g, KINDS.index(k) | habit << 3))
    grid = rasterio.features.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=0, dtype=np.uint8)
    OUT.write_bytes(gzip.compress(grid.tobytes(), mtime=0))
    total = sum(count.values())
    print({k: f"{v / total:.0%}" for k, v in count.most_common()}, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
