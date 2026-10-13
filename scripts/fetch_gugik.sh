#!/bin/sh
# 2025 LiDAR DSM (0.5 m) + DTM (1 m) and 2025 orthophoto (5 cm) sheets covering the AOI (scripts/aoi.py).
# Sheet ids from the GUGiK orthophoto index WFS (PZGIK/ORTO/WFS/Skorowidze, layer SkorowidzOrtofomapy2025);
# DSM/DTM ids follow the same per-sheet order within their 2025 datasets (verified by download).
set -e
cd "$(dirname "$0")/../data/raw"
O=https://opendata.geoportal.gov.pl
get() { [ -s "$2" ] || { for i in 1 2 3 4 5; do curl -sS -m 3600 -C - -o "$2.part" "$1" && mv "$2.part" "$2" && break; sleep 15; done; }; ls -la "$2"; }
#     sheet              DSM id  DTM id  ortho id
SHEETS="N-34-138-B-d-2-2 1744473 1744657 1485374
N-34-138-B-d-2-4 1744475 1744659 1485376
N-34-139-A-c-1-1 1744511 1744695 1485417
N-34-139-A-c-1-3 1744513 1744697 1485419
N-34-139-A-c-1-2 1744512 1744696 1485418
N-34-139-A-c-1-4 1744514 1744698 1485420
N-34-139-A-a-3-3 1744499 1744683 1485405
N-34-139-A-a-3-4 1744500 1744684 1485406
N-34-138-B-b-4-4 1744454 1744638 1485355"
echo "$SHEETS" | while read s dsm dtm orto; do
  get $O/NumDaneWys/NMPT/83232/83232_${dsm}_$s.asc dsm_$s.asc
  get $O/NumDaneWys/NMT/83233/83233_${dtm}_$s.asc dtm_$s.asc
  get $O/ortofotomapa/83235/83235_${orto}_$s.tif orto_$s.tif
done
get $O/InneDane/Budynki3D/LOD1/2024/14/1465.zip lod1_2024.zip
