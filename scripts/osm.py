"""OSM (Overpass `out geom`) parsing into shapely geometries in grid coordinates.

Grid coordinates: gx = easting - X0 (column), gy = (Y0 + D) - northing (row, growing south).
"""
import json

from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

from aoi import D, X0, Y0, RAW

_T = Transformer.from_crs(4326, 2180, always_xy=True)


def to_grid(lon, lat):
    x, y = _T.transform(lon, lat)
    return x - X0, (Y0 + D) - y


def _coords(geom):
    return [to_grid(p["lon"], p["lat"]) for p in geom if p]


AREA_KEYS = ("building", "building:part", "landuse", "leisure", "natural", "amenity", "area:highway",
             "man_made", "place", "construction:leisure", "construction:landuse", "parking", "water")


class OSM:
    def __init__(self, path=f"{RAW}/osm.json"):
        data = json.load(open(path))
        self.timestamp = data["osm3s"]["timestamp_osm_base"]
        self.nodes = []  # (id, tags, Point)
        self.lines = []  # (id, tags, LineString)
        self.areas = []  # (id, type, tags, Polygon|MultiPolygon)
        for e in data["elements"]:
            tags = e.get("tags", {})
            if not tags:
                continue
            if e["type"] == "node":
                self.nodes.append((e["id"], tags, Point(to_grid(e["lon"], e["lat"]))))
            elif e["type"] == "way":
                c = _coords(e.get("geometry", []))
                if len(c) < 2:
                    continue
                closed = len(c) >= 4 and e["geometry"][0] and e["geometry"][-1] and \
                    e["geometry"][0] == e["geometry"][-1]
                is_area = closed and (tags.get("area") == "yes" or any(k in tags for k in AREA_KEYS)) \
                    and tags.get("area") != "no" and not ("highway" in tags and tags.get("area") != "yes"
                                                           and "area:highway" not in tags)
                if is_area:
                    p = Polygon(c)
                    if not p.is_valid:
                        p = p.buffer(0)
                    if p.area > 0:
                        self.areas.append((e["id"], "way", tags, p))
                else:
                    self.lines.append((e["id"], tags, LineString(c)))
            elif e["type"] == "relation" and tags.get("type") in ("multipolygon", "building"):
                outer, inner = [], []
                for m in e.get("members", []):
                    if m["type"] != "way" or not m.get("geometry"):
                        continue
                    c = _coords(m["geometry"])
                    if len(c) < 2:
                        continue
                    (inner if m.get("role") == "inner" else outer).append(LineString(c))
                if not outer:
                    continue
                o = unary_union(list(polygonize(unary_union(outer))))
                if inner:
                    i = unary_union(list(polygonize(unary_union(inner))))
                    o = o.difference(i)
                if o.is_empty or o.area == 0:
                    continue
                if not isinstance(o, (Polygon, MultiPolygon)):
                    o = o.buffer(0)
                self.areas.append((e["id"], "relation", tags, o))

    def areas_with(self, key, values=None):
        return [a for a in self.areas if key in a[2] and (values is None or a[2][key] in values)]

    def lines_with(self, key, values=None):
        return [a for a in self.lines if key in a[1] and (values is None or a[1][key] in values)]

    def nodes_with(self, key, values=None):
        return [a for a in self.nodes if key in a[1] and (values is None or a[1][key] in values)]
