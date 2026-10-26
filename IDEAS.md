# Ideas

For further development: some may or may not be done.

## Weather and seasons

Goal: the same city under different weather and seasons, chosen from the menu (and from the URL, e.g. `?weather=fog&date=10-17&hour=7.5`).

### References
- **Radiation fog over the river at sunrise**: "Mglisty poranek w Warszawie. A pod mgłą ukrył się PGE Narodowy",
  Miasto Stołeczne Warszawa on Facebook, 17 Oct 2026, photo by [dmalihin](https://www.instagram.com/dmalihin).
  - Shot from high on the Praga side, looking west.
  - A flat, dense fog sea, ~40–60 m deep, that hides Stadion Narodowy: only its mast tips and the central spire show.
  - The towers (PKiN, Varso, Warsaw Spire, Złota 44) stand fully above it, in clear air.
  - The sky runs from orange at the horizon to blue overhead. The fog top is lit warm on the sunward side and grey-beige below.
  - This is the test scene for fog: the same camera, at sunrise in October.

### Built (Oct 2026)
- **Date and time** (`web/src/sun.ts`): the sun over Warsaw for any day (NOAA declination and equation of time, Polish clock time with CEST). The named hours (morning, midday, golden hour, blue hour, night) move with the sun.
- **Weather** (`web/src/weather.ts`), one state of uniforms and lights, no geometry rebuilt: clear, overcast, fog, rain, snow, and **now** (Open-Meteo, no key: cloud, rain, snowfall, snow depth, visibility, fog codes).
  - Fog: a post-process ground fog from the depth buffer, dense below ~60 m over the river, thinning above, swells on its top, lit warm towards a low sun.
  - Overcast: a grey deck in the sky shader, the sun dimmed to almost nothing, light from the whole sky.
  - Rain: wet surfaces (darker, glossy, puddles), streaks round the camera. Snow: white on what faces up, ploughed grey slush on streets, flakes.
- **Foliage** (`scripts/phenology.py`, `web/src/foliage.ts`): every crown follows its tree's species through the year. See the calendar below.

### Still open
- Check each preset against dated photos from the same viewpoint (the fog one: the PGE Narodowy photo above).
- Rain: fewer pedestrians, umbrellas; reflections of lamps in wet streets at night.
- Snow: ice along the Vistula banks in a hard frost; lawns in winter without snow.
- A default Vistula level per season; winter extras (Christmas lights on Krakowskie Przedmieście, the rink).
- Grass colour through the year, from data.

Check each preset against real photos, like the landmarks: same viewpoint, side by side.

### Foliage calendar: from data, never random
Built: every crown follows its tree's species (`scripts/phenology.py`, `web/src/foliage.ts`). Species come from the city inventory, the Mapa Koron Drzew crown map and OSM (`scripts/trees.py`); each 2 m cell takes the class of the nearest trunk within 9 m.

**Dates, per class** (day of year; `web/public/data/phenology.json` has the spread and the source of each):
- DWD phenological network (open data, stations east of 12.5° E, 1995–2024): leaf unfolding, autumn colouring (half coloured), leaf fall (half fallen). It has birch, oak, horse chestnut, beech, larch, and part of ash, rowan and alder.
- It has nothing for Norway maple, lindens, poplars, and no autumn phases for ash and robinia. Those come from iNaturalist's "Leaves" annotations (Poland and neighbours, weekly), shifted by their median offset from the DWD on the species both have (colouring +10 d, leaf-out −5 d). Leaf fall = colouring + 17 d, the DWD's median gap.
- Each tree draws its own offset from its class's measured spread, so a street does not turn as one.
- City-wide medians, on the date slider: leaves out ~25 Apr, trees in colour ~16 Oct, leaves down ~2 Nov.

**Assumed, not measured** (to replace with data):
- Leaves take 14 days from first unfolding to a full crown; colouring and fall each ramp over ~3 weeks around their half-way dates.
- Bare crowns keep ~30% of their voxels as grey-brown twigs; which voxels go first is a hash, not the real pattern (outer and upper first? to check in photos).
- The DWD stations are in eastern Germany; Warsaw is a little more continental, and the city centre's heat island keeps leaves days to weeks longer.

**Still open:**
- Validate like the landmarks: renders on given dates next to dated photos from the same spot (Krakowskie Przedmieście lindens, Ogród Saski chestnuts, the Vistula willows).
- PEP725 (free after registering) or IMGW-PIB records for Polish stations; per-crown Sentinel-2 or PlanetScope time series ([Granero-Belinchon et al. 2020](https://hal.archives-ouvertes.fr/hal-03035307), [per crown](https://par.nsf.gov/servlets/purl/10410589)).
- Summer crown colour from the GUGiK orthophoto per crown (today a fixed palette of greens, `LEAVES` in `scripts/voxelize.py`); young spring leaves; chestnuts browned by the leaf-miner from July; blossom (magnolias and cherries in April, chestnut candles in May, lindens in July); scarlet Virginia creeper on walls; fallen leaves on the ground.

## Night that looks like Warsaw at night

The current 22:00 render (screenshots `night-aerial.png` and `night-ground.png`, 23 Oct 2026) is far from photos.

What is off today:
- **Sky.** Ours is purple/magenta.
  - The real night sky over the city is a dull orange-grey skyglow.
  - Clouds are lit from below; the sky is deep blue only at blue hour; there are almost no stars.
- **The streets are dark and the buildings' feet glow.** Every footprint has a bright white rim of ground-floor "windows".
  - Real aerial photos read the other way round: the street network is the brightest thing.
  - It is made of lamp lines and pools of warm light on the asphalt, plus red/white streams of car lights.
  - Blocks and courtyards between the streets are darker.
- **Parks glow neon green.** Real parks are the darkest patches, with only sparse lamps along the paths (Saski, Łazienki, Pole Mokotowskie).
- **At street level:**
  - Ground floors are uniform white boxes, and the pavement is blue and unlit.
  - Real streets have warm cones under each lamp, so facades are lit from below and fade upwards.
  - Shop windows vary: warm, cool, dark, signs.

Ideas:
- **Street lamps as real lights.** Warsaw has mostly replaced sodium lamps with 3000 K LED (the city's LED programme from 2020, ~76k+ of ~122k fittings).
  - So use warm white, not orange; maybe keep a few sodium-orange streets.
  - Pools of light on the ground come from a screen-space lamp texture or decals along OSM `highway=street_lamp` / road centrelines.
- **Traffic as light.** At night, cars render as headlight/taillight streaks; trams as lit boxes.
- **Windows by building type.**
  - Residential: warm, ~30–50% lit at 22:00, fewer after midnight.
  - Offices: cool white, whole floors on or off, cleaning-crew patterns late.
  - Shops: lit until closing.
- **Landmark illumination** (check each against photos):
  - PKiN: coloured floodlight on the tower (programmable since 2010, often changes for events), plus the lit clock.
  - Varso spire, Warsaw Spire top, Złota 44 crown, Cosmopolitan.
  - Stadion Narodowy facade: red-white or event colours.
  - Bridges: Świętokrzyski cable stays, Poniatowskiego towers.
  - Kopernik, the Royal Castle, the Old Town facades.
- **Aviation lights:** blinking red on the tall towers.
- **Neon:** Warsaw's neon tradition (e.g. Berlin, Sam neons); the lights of the Vistula boulevards and their reflections in the water.
- **Reference set to collect:**
  - Aerial: drone shots of Śródmieście at night, and ISS night photos of Warsaw (2015: the stadium, bridges and airport stand out).
  - Ground: Marszałkowska, Nowy Świat, Krakowskie Przedmieście and the boulevards at night.
  - Compare from the same viewpoint, side by side, as for the landmarks.
