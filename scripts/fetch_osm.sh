#!/bin/sh
# OSM for the rotated AOI (see scripts/aoi.py) + 100 m margin, as Overpass-style JSON with geometry clipped to the bbox.
# Default: the daily Geofabrik extract for Mazowieckie, cut locally by scripts/osm_pbf.py (same output as
# Overpass `nwr(bbox); out body geom(bbox);`, checked element by element on the old 1.5 km AOI). The 4 x 3 km AOI is
# too heavy for the public Overpass servers at busy times; OVERPASS=1 uses them anyway.
set -e
cd "$(dirname "$0")/.."
BB=$(PYTHONPATH=scripts uv run python -c "
from pyproj import Transformer
from aoi import world_bounds
t = Transformer.from_crs(2180, 4326, always_xy=True)
x0, y0, x1, y1 = world_bounds(100)
p = [t.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
print('%.4f,%.4f,%.4f,%.4f' % (min(q[1] for q in p), min(q[0] for q in p), max(q[1] for q in p), max(q[0] for q in p)))")
echo "bbox $BB"
if [ -z "$OVERPASS" ]; then
  P=data/raw/geofabrik/mazowieckie-latest.osm.pbf
  mkdir -p data/raw/geofabrik
  if [ ! -s $P ] || [ -n "$(find $P -mtime +1)" ]; then
    curl -sS -L -o $P.part https://download.geofabrik.de/europe/poland/mazowieckie-latest.osm.pbf && mv $P.part $P
  fi
  uv run --with osmium python scripts/osm_pbf.py $P $BB data/raw/osm.json
  exit 0
fi
Q="[out:json][timeout:600][maxsize:536870912];nwr($BB);out body geom($BB);"
for round in 1 2 3 4 5 6; do for u in https://overpass-api.de/api/interpreter https://overpass.private.coffee/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  curl -s -m 900 -A "warsaw-voxel/0.1" --data-urlencode "data=$Q" "$u" -o data/raw/osm.json.part
  if head -c 20 data/raw/osm.json.part | grep -q '{'; then mv data/raw/osm.json.part data/raw/osm.json; echo "OK $u"; exit 0; fi
  echo "fail $u (round $round)"; sleep $((round * 10))
done; done
exit 1
