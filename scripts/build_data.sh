#!/bin/sh
# Full data pipeline: download (cached) -> mosaic -> voxelize -> web/public/data
set -e
cd "$(dirname "$0")/.."
[ -s data/raw/osm.json ] || sh scripts/fetch_osm.sh
sh scripts/fetch_gugik.sh
PYTHONPATH=scripts uv run python scripts/prep.py
PYTHONPATH=scripts uv run python scripts/voxelize.py
