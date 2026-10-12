#!/bin/sh
# OSM for AOI (EPSG:2180 x 636240..637540, y 486400..487400) + 100 m margin; geometry clipped to bbox
cd "$(dirname "$0")/../data/raw"
BB="52.2255,20.9938,52.2367,21.0163"
Q="[out:json][timeout:300];nwr($BB);out body geom($BB);"
for u in https://overpass-api.de/api/interpreter https://overpass.private.coffee/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  curl -s -m 600 -A "warsaw-voxel/0.1" --data-urlencode "data=$Q" "$u" -o osm.json.part
  if head -c 20 osm.json.part | grep -q '{'; then mv osm.json.part osm.json; echo "OK $u"; exit 0; fi
  echo "fail $u"; sleep 5
done
exit 1
