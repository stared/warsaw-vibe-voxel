"""Search index for the viewer: every named street, square, park, building, station, stop and venue in the AOI.

Output web/public/data/places.json: {"places": [[name, kind, x, y, size, alt], ...]} in grid metres
(x east, y south), size = a rough extent in metres used to frame the camera. Sorted by importance.
"""
import json
from collections import defaultdict
from pathlib import Path

from shapely.ops import unary_union

from aoi import W, D
from osm import OSM

OUT = Path(__file__).resolve().parent.parent / "web/public/data/places.json"
osm = OSM()


def inside(x, y):
    return 0 <= x < W and 0 <= y < D


def kind_of(t):
    if t.get("place") == "square" or t.get("highway") == "pedestrian":
        return "square"
    if t.get("leisure") in ("park", "garden"):
        return "park"
    if t.get("railway") == "station" or t.get("public_transport") == "station":
        return "station"
    if t.get("railway") == "tram_stop" or t.get("public_transport") in ("platform", "stop_position") or t.get("highway") == "bus_stop":
        return "stop"
    if "highway" in t:  # streets come from the merged lines above
        return None
    for k in ("tourism", "amenity", "shop", "historic", "office", "leisure"):
        if k in t:
            return t[k].replace("_", " ") if k != "shop" else "shop"
    if "building" in t:
        return "building"
    return None


RANK = {"square": 0, "park": 1, "station": 2, "street": 3, "building": 4, "museum": 4, "theatre": 4, "attraction": 4, "hotel": 5}
best = {}


def add(name, kind, geom, alt=""):
    if not kind:
        return
    p = geom.representative_point() if geom.geom_type != "Point" else geom
    if not inside(p.x, p.y):
        return
    size = geom.length if geom.geom_type in ("LineString", "MultiLineString") else (geom.area ** 0.5 if geom.area else 0)
    k = (name, kind)
    if k not in best or size > best[k][4]:
        best[k] = [name, kind, round(p.x, 1), round(p.y, 1), round(size), alt]


# streets: merge all segments of one name, place the point on the longest piece's middle
streets = defaultdict(list)
for _, t, line in osm.lines_with("highway"):
    if t.get("name") and t["highway"] not in ("footway", "path", "steps", "cycleway", "service", "platform"):
        streets[t["name"]].append(line)
for name, lines in streets.items():
    u = unary_union(lines)
    longest = max(getattr(u, "geoms", [u]), key=lambda g: g.length)
    mid = longest.interpolate(0.5, normalized=True)
    if inside(mid.x, mid.y):
        best[(name, "street")] = [name, "street", round(mid.x, 1), round(mid.y, 1), round(u.length), ""]

for _, _, t, poly in osm.areas:
    if t.get("name"):
        add(t["name"], kind_of(t), poly, t.get("name:en", ""))
for _, t, pt in osm.nodes:
    if t.get("name"):
        add(t["name"], kind_of(t), pt, t.get("name:en", ""))

places = sorted(best.values(), key=lambda r: (RANK.get(r[1], 6), -r[4]))
OUT.write_text(json.dumps({"places": places}, ensure_ascii=False, separators=(",", ":")))
kinds = defaultdict(int)
for r in places:
    kinds[r[1]] += 1
print(len(places), "places", dict(sorted(kinds.items(), key=lambda kv: -kv[1])[:15]), OUT.stat().st_size, "bytes")
