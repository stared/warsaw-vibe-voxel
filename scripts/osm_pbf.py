"""Fallback for fetch_osm.sh when Overpass is overloaded: cut the AOI bbox out of a Geofabrik .osm.pbf and write
the same JSON as Overpass `nwr(bbox); out body geom(bbox);` (what osm.py and traffic.py read):
- tagged nodes inside the bbox
- ways with a node inside the bbox; `geometry` keeps the coordinates of nodes inside or next to one, else null
- relations with a member way/node kept above; way members carry the same clipped `geometry`
usage: uv run --with osmium python scripts/osm_pbf.py data/raw/geofabrik/mazowieckie-latest.osm.pbf S,W,N,E out.json
"""
import json
import os
import sys

import osmium

pbf, bb, out = sys.argv[1], sys.argv[2], sys.argv[3]
S, W_, N, E = map(float, bb.split(","))


def inside(lat, lon):
    return S <= lat <= N and W_ <= lon <= E


nodes, ways = [], {}


class Pass1(osmium.SimpleHandler):
    def node(self, n):
        if n.tags and n.location.valid() and inside(n.location.lat, n.location.lon):
            nodes.append({"type": "node", "id": n.id, "lat": round(n.location.lat, 7), "lon": round(n.location.lon, 7),
                          "tags": {t.k: t.v for t in n.tags}})

    def way(self, w):
        locs = []
        for nd in w.nodes:
            locs.append((nd.location.lat, nd.location.lon) if nd.location.valid() else None)
        ins = [p is not None and inside(*p) for p in locs]
        if not any(ins):
            return
        geom = []
        for i, p in enumerate(locs):
            keep = ins[i] or (i > 0 and ins[i - 1]) or (i + 1 < len(ins) and ins[i + 1])
            geom.append({"lat": round(p[0], 7), "lon": round(p[1], 7)} if (keep and p is not None) else None)
        ways[w.id] = {"type": "way", "id": w.id, "nodes": [nd.ref for nd in w.nodes], "geometry": geom,
                      "tags": {t.k: t.v for t in w.tags}}


rels = []
node_ids = None


class Pass2(osmium.SimpleHandler):
    def relation(self, r):
        mem, hit = [], False
        for m in r.members:
            if m.type == "w":
                g = ways.get(m.ref)
                if g is not None:
                    hit = True
                    mem.append({"type": "way", "ref": m.ref, "role": m.role, "geometry": g["geometry"]})
                else:
                    mem.append({"type": "way", "ref": m.ref, "role": m.role})
            elif m.type == "n":
                p = node_ids.get(m.ref)
                if p is not None:
                    hit = True
                    mem.append({"type": "node", "ref": m.ref, "role": m.role, "lat": p[0], "lon": p[1]})
                else:
                    mem.append({"type": "node", "ref": m.ref, "role": m.role})
            else:
                mem.append({"type": "relation", "ref": m.ref, "role": m.role})
        if hit:
            rels.append({"type": "relation", "id": r.id, "members": mem, "tags": {t.k: t.v for t in r.tags}})


Pass1().apply_file(pbf, locations=True, idx="flex_mem")
node_ids = {n["id"]: (n["lat"], n["lon"]) for n in nodes}
Pass2().apply_file(pbf)
ts = os.path.basename(pbf)
try:
    ts = osmium.io.Reader(pbf, osmium.osm.osm_entity_bits.NOTHING).header().get("osmosis_replication_timestamp") or ts
except Exception:
    pass
json.dump({"version": 0.6, "osm3s": {"timestamp_osm_base": ts}, "elements": nodes + list(ways.values()) + rels}, open(out, "w"))
print("pbf ->", out, len(nodes), "nodes", len(ways), "ways", len(rels), "relations; timestamp", ts)
