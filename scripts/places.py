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
from wikidata import CACHE


OUT = Path(__file__).resolve().parent.parent / "web/public/data/places.json"
osm = OSM()
wd = json.loads(CACHE.read_text()) if CACHE.exists() else {}
PL_KIND = {"place of worship": "kościół church", "station": "dworzec stacja", "stop": "przystanek", "theatre": "teatr",
           "museum": "muzeum", "gallery": "galeria", "library": "biblioteka", "university": "uczelnia uniwersytet",
           "park": "ogród", "square": "plac", "street": "ulica", "cinema": "kino", "hotel": "hotel", "memorial": "pomnik",
           "artwork": "rzeźba", "restaurant": "restauracja", "cafe": "kawiarnia", "school": "szkoła", "hospital": "szpital"}


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
    for k in ("tourism", "amenity", "shop", "historic", "office", "leisure", "club"):
        if k in t:
            return t[k].replace("_", " ") if k != "shop" else "shop"
    if "building" in t:
        return "building"
    return None


RANK = {"square": 0, "Osiedle Jazdów": 1, "park": 1, "station": 2, "street": 3, "building": 4, "domek fiński": 4, "museum": 4, "theatre": 4, "attraction": 4, "hotel": 5}
best = {}


def english(t):
    e = wd.get(t.get("wikidata"), {})
    return " ".join(dict.fromkeys(filter(None, [t.get("name:en"), e.get("en"), e.get("pl")])))


def add(name, kind, geom, alt=""):
    if not kind:
        return
    alt = " ".join(filter(None, [alt, PL_KIND.get(kind)]))
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
        add(t["name"], kind_of(t), poly, english(t))
for _, t, pt in osm.nodes:
    if t.get("name"):
        add(t["name"], kind_of(t), pt, english(t))

# the Finnish houses of Osiedle Jazdów (1945, ~27 left; Otwarty Jazdów: NGOs, culture and grassroots groups): every
# one found by its address ("Jazdów 3/5") and by "domki fińskie", named after its OSM name or the groups inside it
import re
jazdow = unary_union(streets.get("Jazdów", [])).buffer(120) if streets.get("Jazdów") else None
domki = []
for _, _, t, poly in osm.areas:
    nr = t.get("addr:housenumber", "")
    if jazdow is None or t.get("building") not in ("detached", "house", "ruins", "yes") or not re.fullmatch(r"\d+A?/\d+", nr) \
            or not jazdow.contains(poly.representative_point()):
        continue
    inside_ = [t2["name"] for _, t2, pt in osm.nodes if t2.get("name") and poly.buffer(1.5).contains(pt)]
    name = t.get("name") or (inside_[0] if len(inside_) == 1 else f"Jazdów {nr}")
    alt = " ".join([f"Jazdów {nr}", "domek fiński Finnish house", *[n for n in inside_ if n != name]])
    c = poly.representative_point()
    for k in [k for k, r in best.items() if k[0] == name and (r[2] - c.x) ** 2 + (r[3] - c.y) ** 2 < 30 ** 2]:
        del best[k]  # the same house under its amenity/office kind
    add(name, "domek fiński", poly, alt)
    domki.append(poly)
if domki:
    add("Domki fińskie", "Osiedle Jazdów", unary_union(domki).convex_hull, "Finnish houses Otwarty Jazdów Jazdow")
    print(len(domki), "Finnish houses on Jazdów")

places = sorted(best.values(), key=lambda r: (RANK.get(r[1], 6), -r[4]))
OUT.write_text(json.dumps({"places": places}, ensure_ascii=False, separators=(",", ":")))
kinds = defaultdict(int)
for r in places:
    kinds[r[1]] += 1
print(len(places), "places", dict(sorted(kinds.items(), key=lambda kv: -kv[1])[:15]), OUT.stat().st_size, "bytes")
