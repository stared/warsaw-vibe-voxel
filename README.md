# Warszawa Śródmieście in voxels

A 1300 × 1300 m diorama of central Warsaw at 1 m voxels, centred on the PKiN spire and rotated 21.5° to the Palace axes (so walls and the street grid are not staircased), in the style of MagicaVoxel renders (ephtracy). It covers:
- the Palace of Culture and Science (PKiN)
- Złota 44, Złote Tarasy and the newly greened Złota
- Warszawa Centralna station and the Rondo ONZ towers

Golden hour, midday and night are presets on a time-of-day slider.

```sh
cd web && pnpm install && pnpm dev     # http://localhost:5173  (?view=pkin&hour=22.6&tilt=0&ui=0)
```

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
sh scripts/build_data.sh      # ~5 GB of GUGiK downloads on first run (cached in data/raw), then ~15 s
```

## Known limits
- Windows are procedural, generated in the shader from floor height and material. They are not real window positions.
- OSM maps 44 of the 81 elms reported on Złota, and only those 44 are drawn.
- The 51 parked cars are frozen from the moment of the 2025 LiDAR flight. The trams are animated on the real OSM track geometry; their positions are not real.
