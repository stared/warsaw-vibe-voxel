#!/bin/sh
# 2025 LiDAR DSM (0.5 m) + DTM (1 m) and 2025 orthophoto (5 cm) sheets covering the AOI
set -e
cd "$(dirname "$0")/../data/raw"
O=https://opendata.geoportal.gov.pl
get() { [ -s "$2" ] || { for i in 1 2 3 4 5; do curl -sS -m 3600 -C - -o "$2.part" "$1" && mv "$2.part" "$2" && break; sleep 15; done; }; ls -la "$2"; }
for s in 1744473_N-34-138-B-d-2-2 1744475_N-34-138-B-d-2-4 1744511_N-34-139-A-c-1-1 1744513_N-34-139-A-c-1-3; do get $O/NumDaneWys/NMPT/83232/83232_$s.asc dsm_${s#*_}.asc; done
for s in 1744657_N-34-138-B-d-2-2 1744659_N-34-138-B-d-2-4 1744695_N-34-139-A-c-1-1 1744697_N-34-139-A-c-1-3; do get $O/NumDaneWys/NMT/83233/83233_$s.asc dtm_${s#*_}.asc; done
get $O/InneDane/Budynki3D/LOD1/2024/14/1465.zip lod1_2024.zip
for s in 1485374_N-34-138-B-d-2-2 1485376_N-34-138-B-d-2-4 1485417_N-34-139-A-c-1-1 1485419_N-34-139-A-c-1-3; do get $O/ortofotomapa/83235/83235_$s.tif orto_${s#*_}.tif; done
