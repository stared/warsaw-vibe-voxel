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

### How
One `weather` state, made only of shader uniforms and light settings, so switching never rebuilds geometry:
- `date`: the season
- `cloud`, `fog` (depth, density), `rain`, `snow`, `wet`, `wind`

Presets in the menu:
- Clear
- Overcast
- Morning fog
- Rain
- Snow
- **Now**: one click sets today's date, the current Warsaw time and the live weather, from Open-Meteo (no key needed).
  - The live weather covers cloud, fog/visibility, rain and snow.
  - It is a nice easter egg: the city as it is right now.

1. **Height fog first.** Today we have only distance fog (`THREE.Fog`, horizon colour, 2.5–7 km).
   - Real ground fog depends on height. Density falls off as `exp(-(y - top) / scale)` above a top of ~50 m.
   - The fog is integrated along the view ray in the shared fog chunk (`onBeforeCompile`), so towers poke out.
   - The top surface gets slow scrolling noise, so it reads as a "sea", not a flat cut.
   - It is coloured by the sun: warm from above at a low sun, grey beneath.
2. **Date / season slider.**
   - The sun's declination in `sunAt()`, so sunrise, sunset and noon height follow the date.
   - Tree foliage: green → yellow/orange (Oct) → bare (Dec–Mar). Grass colour too.
   - People: count, clothing colours, umbrellas.
   - A default Vistula level per season.
   - Winter extras: Christmas lights (Krakowskie Przedmieście), the rink.
3. **Overcast.**
   - Clouds in the sky shader.
   - Sun dimmed and shadows softened; more ambient light.
   - The haze comes closer.
4. **Rain.**
   - Wet streets: darker, lower roughness, with reflections, plus noise-masked puddles.
   - Streak particles only around the camera.
   - Fewer pedestrians, and umbrellas.
5. **Snow.**
   - White on up-facing voxel faces (a normal.y mask plus noise), on roofs and lawns but not on walls.
   - Flakes near the camera.
   - Ice along the Vistula banks in a hard frost.

Check each preset against real photos, like the landmarks: same viewpoint, side by side.

### Foliage calendar: from data, never random
Every colour and date must come from a source: phenology records, satellite or aerial imagery, dated photos.
The table below is only my **unverified draft from general knowledge**. It says what to look for; nothing is built from it until each row has a source.

We already have the species of each tree, from the city inventory, the Mapa Koron Drzew crown map and OSM (`scripts/trees.py`), so each tree can follow its own species.

| species (PL) | leaves out | autumn colour | colour from → bare by | notes |
|---|---|---|---|---|
| lipa (Tilia) – most common street tree | late Apr | yellow → brown | early Oct → late Oct | street lindens often brown/scorched by Aug (salt, drought) |
| klon pospolity (Acer platanoides) | mid Apr | bright yellow, some orange | mid Oct → early Nov | the main colour of Warsaw autumn |
| kasztanowiec (Aesculus) | mid Apr; white flower "candles" early May | rusty brown | leaves brown from **July–Aug** (leaf-miner moth) → Oct | |
| brzoza (Betula) | early Apr (first) | golden yellow | mid Sep → late Oct | |
| dąb szypułkowy (Quercus robur) | early–mid May (late) | yellow-brown | late Oct → Nov | young oaks keep dry brown leaves in winter |
| dąb czerwony (Q. rubra) | early May | red → russet | Oct → Nov | |
| buk (Fagus) | late Apr | copper-orange | late Oct → Nov | hedges and young beeches keep them all winter |
| grab (Carpinus) | late Apr | yellow → brown | late Oct → Nov | hornbeam hedges keep their leaves in winter |
| jesion (Fraxinus) | mid May (late) | falls almost green / dull yellow | early Oct → mid Oct | |
| robinia | mid–late May (last); flowers late May | dull yellow | Oct → early Nov | |
| topola, wierzba – Vistula banks | Mar (willows first) → Apr | yellow-green | late Oct → late Nov (willows last) | |
| platan | late Apr | brown-ochre | late Oct → Nov | |
| miłorząb (Ginkgo) | late Apr | brilliant yellow | late Oct → drops almost all in a few days, early Nov | |
| modrzew (larch) | Apr | gold | late Oct → Nov | a conifer that goes bare |
| sosna, świerk, cis | evergreen | — | — | |
| dzikie wino (Parthenocissus) on walls | May | **scarlet** | late Sep → Oct | facades turn red; worth adding as a wall layer |

- **Peak colour in Warsaw is ~10–25 Oct.** Most trees are bare by mid-Nov.
  - In the city centre (heat island) and under street lamps, leaves stay a few days to weeks longer.
- **Spring order:** willows and birches (early Apr) → bird cherry, chestnut, maple (mid Apr) → linden, beech (late Apr) → oak, ash (early May) → robinia (mid May).
- **Blossom moments:**
  - Magnolias and cherries: mid–late Apr (Pole Mokotowskie, Ogród Saski).
  - Chestnut candles: early May (exams time).
  - Lilac: May.
  - Linden in flower: late Jun–Jul.
**Data to build it from:**
- **Dates (when) from phenology records.**
  - [PEP725](https://www.pep725.eu/) is the pan-European database: BBCH stages (leaf unfolding, autumn colouring, leaf fall) per species and year. It is free for research after registering.
  - Check which Polish stations and species it has, and use IMGW-PIB's phenological observations for Warsaw if available.
  - These give per-species mean dates and their real spread. The spread replaces the "±7 days" I had made up.
- **Per tree, from space.** We have crown polygons (Mapa Koron Drzew).
  - A Sentinel-2 time series (10 m, every few days, free) over each crown gives green-up and senescence dates, and the actual autumn colour, per tree or per group of trees.
  - Urban crowns are small and shaded, so this needs care ([Granero-Belinchon et al. 2020](https://hal.archives-ouvertes.fr/hal-03035307) did it for street trees).
  - PlanetScope (3 m) [works per crown](https://par.nsf.gov/servlets/purl/10410589). There, species explained 4× more of the variation in timing than location did, so species is the main key.
- **Colours from dated photos.**
  - Sample the canopy colour per species and per week from:
    - geotagged, dated street-level photos (Mapillary, Wikimedia Commons, Street View history), matched to inventory trees at that spot;
    - any aerial orthophoto that was flown in autumn or early spring. GUGiK flies cities every 2 years ([2025 Warsaw at 5 cm](https://www.geoportal.gov.pl/aktualnosci/nowe-dane-fotogrametryczne-w-pzgik-66/)); check the flight dates in the metadata.
  - Today the crowns use a fixed palette of greens (`LEAVES` in `scripts/voxelize.py`), not data. The GUGiK 2025 orthophoto we already use could give each crown its real summer colour; its flight date tells the season.
- **Validate** like the landmarks: our render on a given date, next to a dated photo from the same spot, e.g. Krakowskie Przedmieście lindens, Ogród Saski chestnuts, the Vistula willows.

**How to render it:**
- Each species gets measured numbers: leaf-out, colour start, peak and bare dates (with their measured spread), plus the colour sampled for each phase. Where a tree has satellite data, its own dates override the species dates.
- Leaf loss removes crown voxels and shows the branches. Which voxels go first should follow the real pattern (outer and upper first? to check in photos), not a random hash.
- Fallen leaves tint the ground under the crown, if photos show it lasting.

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
