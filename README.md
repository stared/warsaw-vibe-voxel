# Warszawa Śródmieście in voxels

A 3950 × 3150 m diorama of central Warsaw at 1 m voxels, anchored on the PKiN spire and rotated 21.5° to the Palace axes (so walls and the street grid are not staircased), in the style of MagicaVoxel renders (ephtracy). It covers:
- the Palace of Culture and Science (PKiN), Złota 44, Złote Tarasy and the newly greened Złota
- Warszawa Centralna station and the Rondo ONZ towers
- Powiśle and the Vistula: Centrum Nauki Kopernik, Most Świętokrzyski and Most Poniatowskiego, the boulevards
- Praga's bank with PGE Narodowy
- north to Ogród Saski and Teatr Wielki, south past Trasa Łazienkowska (Politechnika, Plac Konstytucji, Sejm, Most Łazienkowski)

Golden hour, midday and night are presets on a time-of-day slider.

```sh
cd web && pnpm install && pnpm dev     # http://localhost:5173  (?view=pkin&hour=22.6&tilt=0&ui=0)
```

## Streaming (web/src/stream.ts)

The city is a quadtree of tiles (`web/public/data/tiles/{1,2,4,8}/x_y.bin`, ~15 MB gzipped in all): 128 × 128 cells
of 1, 2, 4 or 8 m. The viewer loads the whole map at 8 m up front (0.3 MB), then refines what is in view until a
cell of the coarser level would span more than ~3 px (`?err=` to experiment), with full 1 m detail around wherever
you walk or ride. Tiles are meshed in workers; a parent stays on screen until its children are ready, so there are
no holes; hidden tiles are dropped beyond 150 MB. The traffic simulation runs within ~900 m of the camera.

Measured on the old 1.5 km map vs this 4 × 3 km one (`tools/mem.mjs`, `tools/bench.mjs`, `tools/jank.mjs`,
`tools/longtasks.mjs`; headless Chrome on an M-series Mac, same six views):

| | 1.5 km, all in memory | 4 × 3 km, streamed |
|---|---|---|
| total process memory | 1.84–2.28 GB | 1.87–2.07 GB |
| JS heap | ~280 MB | 90–230 MB |
| triangles on screen | 5.0 M | 3.1–6.2 M |
| CPU at 60 fps | 52% of a core | 52% of a core |
| frame time while flying between views, p99 | 16.8 ms | 16.8 ms |
| first view fully loaded | 3.8 s | 2.7 s |

Blind A/B on 16 views of the old area: judges couldn't tell the two apart (7 vs 9, p = 0.8).

## How the data is fused (scripts/)

| Source | Used for |
|---|---|
| **GUGiK NMPT 2025** (LiDAR surface model, 0.5 m) | Building heights and roof shapes, tree crowns, parked vehicles |
| **GUGiK NMT 2025** (terrain model, 1 m) | Ground relief, including the rail cut by Varso |
| **GUGiK orthophoto 2025** (5 cm) | Roof colours, green roofs, foliage tones, vehicle colours, grass OSM doesn't map |
| **OpenStreetMap** (fetched the day of the build) | Footprints and 3D parts, facade and roof colours and materials, road and sidewalk surfaces, bike paths, zebras, lane counts, tram tracks, 3 000+ trees, street lamps, shelters, fountains |
| **research.md** | Facts about what changed after the 2025 flight, with sources |

Cross-checks that run at build time, logged to `data/debug/report.json`:
- **LiDAR vs OSM height, for each building part.**
  - OSM wins only for thin spires the LiDAR under-samples: Varso goes to 310 m, Q22's crown to 195 m.
  - OSM also wins where the LiDAR sees nothing tall, meaning the building went up after the flight.
  - Elsewhere LiDAR wins. It caught a wrong OSM part on Złota 44 and Ilmet's 103 m tag, which counts the antenna (the roof is ~83 m).
- **Misregistered footprints.** Where the LiDAR tower is taller than the OSM part under it, the facade comes from the nearest OSM part tall enough to explain it. This fixed the Marriott.
- **Vegetation.** A cell counts as a tree only if it is LiDAR-high, ortho-green or near an OSM tree, and not a building's wall edge.
- **Trees planted after the flight.** OSM trees with no 2025 LiDAR crown become young voxel trees. This covers Plac Centralny (opened Jun 2025) and the Złota elms (opened Aug 2026).
- **Current state, Oct 2026, from OSM:**
  - The TR Warszawa site is an excavation.
  - MSN (opened Oct 2024) is white concrete.
  - Ilmet is still standing.
  - Roma and Lilium towers are not built, so they are left out.

Curated details are in `scripts/landmarks.py`:
- the PKiN Millennium Clock, on the plain shaft at ~170 m
- the Złote Tarasy glass canopy
- the Marriott's dark glass
- labels

## Rebuild the data

```sh
sh scripts/build_data.sh      # ~11 GB of GUGiK downloads on first run (cached in data/raw), then ~6 min, ~26 GB RAM peak
```

OSM comes from the daily Geofabrik extract for Mazowieckie, cut to the AOI by `scripts/osm_pbf.py` into the same JSON
as Overpass `out geom(bbox)` (the 4 × 3 km query is too heavy for the public Overpass servers; `OVERPASS=1` uses them).
GUGiK sheet ids come from the orthophoto index WFS (`PZGIK/ORTO/WFS/Skorowidze`).

## Known limits
- Windows are procedural, generated in the shader from floor height and material. They are not real window positions.
- OSM maps 44 of the 81 elms reported on Złota, and only those 44 are drawn.
- OSM maps almost no lamps on the Vistula bridges; they get one every 32 m on each kerb (inferred, like Złota's).
- Most Świętokrzyski's mast comes from the LiDAR; its 48 stays are drawn from the published layout (semi-fan, 12 per
  side per plane), not measured.
- The map ends a block east of PGE Narodowy (Targowa, Ząbkowska are outside).
- The 51 parked cars are frozen from the moment of the 2025 LiDAR flight. The trams are animated on the real OSM track geometry; their positions are not real.

## Curating a building (scripts/overrides.json)

Hand-curated detail goes in **one data file, keyed by OSM id**, never as one-off code. Each entry can set:
- facade zones along the footprint's long axis
- wall and roof colour and material
- a crown or sign band
- a label
- **source URLs**

The pipeline applies every entry the same way, and also derives from it:
- a label
- a camera preset, chosen by a line-of-sight search through the voxels

To add or fix a building:
1. Find it in OSM. Prefer fixing `building:colour`, `height` and `building:part` in OSM itself, so everyone benefits.
2. For what OSM can't express (facade rhythm, signage, two-character facades), add an `overrides.json` entry, with photo sources.
3. Run `sh scripts/build_data.sh`. Then compare `pnpm shot` renders against the reference photos.

Example: Astoria (Brokla 2, formerly Przeskok 2; Quesma's office). Details are in `research_astoria.md`.
- The west half is near-black glass with bronze mullions and floor bands.
- The east half is off-white pilasters.
- A gold-lettered crown band runs round the round tip.

## Sources

Data the model is built from:
- **[GUGiK](https://www.geoportal.gov.pl/)** (Główny Urząd Geodezji i Kartografii) via [opendata.geoportal.gov.pl](https://opendata.geoportal.gov.pl/):
  - NMPT 2025, the LiDAR surface model (0.5 m)
  - NMT 2025, the terrain model (1 m)
  - the 2025 orthophoto (5 cm)

  These are open data, free to reuse under Art. 40a of the Polish Geodetic and Cartographic Law.
- **[OpenStreetMap](https://www.openstreetmap.org/)**: © OpenStreetMap contributors, under the [ODbL](https://opendatacommons.org/licenses/odbl/). It is read from the [Geofabrik](https://download.geofabrik.de/europe/poland/mazowieckie.html) daily extract for Mazowieckie.

- **Trees** (`scripts/fetch_trees.py`, `scripts/trees.py`; the register is written to `web/public/data/trees.json`):
  - **Warsaw's green-areas database.** The city's *Baza Obiektów Zieleni*, as shown in the [mapa.um.warszawa.pl](https://mapa.um.warszawa.pl/) "Zieleń" map and served by its MapViewer data server. It gives each tree's inventory number, Polish and Latin species, trunk circumference, managing unit and data date, for 35 k trees in the area. It also includes the *Mapa Koron Drzew*, a remote-sensing map of tree crowns.
  - **The city's open-data tree inventory**, from [api.um.warszawa.pl](https://api.um.warszawa.pl/), surveyed 2010–13. It adds height, crown diameter and condition.
  - **OpenStreetMap** `natural=tree` nodes. They are used where the city database has no tree within 2 m.

References used to check and curate details (these are not redistributed):
- **[Wikimedia Commons](https://commons.wikimedia.org/)** photos of each landmark. They are compared side by side with renders: facades, colours, bridge structure.
- **[Wikipedia](https://pl.wikipedia.org/)** (pl and en) for dimensions: heights, bridge spans and pier counts, opening dates.
- Architecture and construction press, and city announcements, for changes since the 2025 flight. Sources include [eurobuildcee.com](https://eurobuildcee.com/), [inzynierbudownictwa.pl](https://www.inzynierbudownictwa.pl/), [muratorplus.pl](https://architektura.muratorplus.pl/) and [um.warszawa.pl](https://um.warszawa.pl/). Each fact is cited with its link in [research.md](research.md) and [visual_ref.md](visual_ref.md).

Software:
- **Viewer:** [three.js](https://threejs.org/), [postprocessing](https://github.com/pmndrs/postprocessing), [N8AO](https://github.com/N8python/n8ao), [lil-gui](https://lil-gui.georgealways.com/) and [Vite](https://vite.dev/).
- **Data pipeline:** [NumPy](https://numpy.org/), [SciPy](https://scipy.org/), [Shapely](https://shapely.readthedocs.io/), [rasterio](https://rasterio.readthedocs.io/), [pyproj](https://pyproj4.github.io/pyproj/) and [Pillow](https://python-pillow.org/).
- The look follows the MagicaVoxel renders by [ephtracy](https://ephtracy.github.io/).

## License

The code is under the [MIT license](LICENSE), © 2026 Piotr Migdał. The generated data in `web/public/data` derives from OpenStreetMap, so it is under the ODbL (© OpenStreetMap contributors), and from GUGiK open data.
