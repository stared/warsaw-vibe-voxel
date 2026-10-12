# Central Warsaw voxel model: fact sheet (researched 2026-10-12)

AOI: about 1×1 km centred on PKiN (52.2318 N, 21.0060 E).
- WGS84 bbox: lat 52.2273–52.2363, lon 20.9987–21.0133.
- EPSG:2180 (PL-1992; x = easting): PKiN ≈ (636952, 486979); SW ≈ (636468, 486465); NE ≈ (637437, 487493). Computed with pyproj.
- Rondo ONZ (~20.998 E) sits right on the west edge. Warsaw Spire, Skyliner/Skyliner II, Mennica, Forest and Generation Park are **outside** the box (1–2 km west/north).

Confidence tags: [V] = verified from a source or curl; [S] = single secondary source; [U] = uncertain or from memory; check against the 2025 NMPT.

---
## 0. TL;DR for the build

1. **Best geometry source: GUGiK NMPT 2025** (LiDAR DSM, 0.5 m, EVRF2007 heights) and **NMT 2025** (1 m DTM). Both cover the whole AOI in 4 sheets [V]. Voxel height = NMPT − NMT.
2. **Best imagery: GUGiK orthophoto 2025, RGB, 5 cm pixel** (same job, GK-FOTO.6201.5.2025) [V]. The index gives only the year, not the flight month.
3. **The 2025 data predates several things, so patch them by hand:**
   - Upper One: topped out at 131.5 m in 2026.
   - TR Warszawa: currently an excavation or underground works site.
   - Złota street greening: opened Aug 2026.
   - Possibly Plac Centralny planting, if the flight was before about May 2025.
   - Ilmet is **still standing** as of Aug 2026 (only being stripped inside).
4. **LoD1 buildings 2024** (CityGML, flat roofs, median-LiDAR height) are available for Warsaw [V]. **I found no GUGiK LoD2 for Warsaw**: the WMS returned no LoD2 hit at PKiN, and LoD2 covered only 10 voivodeships.

---
## 1. Changes 2019–2026 inside / near the AOI

### Plac Defilad → "Nowe Centrum Warszawy" programme

**Museum of Modern Art (MSN)** [V]
- Address: Marszałkowska 103, north part of the former Plac Defilad, along Marszałkowska between Świętokrzyska and PKiN.
- Opened 25 Oct 2024.
- Architect: Thomas Phifer and Partners with APA Wojciechowski; contractor Warbud.
- **White architectural concrete** (cast-in-place, coloured through the mix), with a smooth, almost blank box facade and a fully glazed ground-floor foyer.
- Dimensions:
  - Length about 100 m; the east facade is described as "100-m-long".
  - Height about 25–26 m; Warbud said the structure was "heading towards the height of 26 metres".
  - Footprint 4,210 m², which implies a width of about 40–42 m. The north facade segment is 40 m wide.
- Total area 19,788 m², with 4 above-ground storeys (per Warbud) and 2 basement levels.
- Sources: https://pl.wikipedia.org/wiki/Muzeum_Sztuki_Nowoczesnej_w_Warszawie , https://warbud.pl/en/news/warbud-news/what-is-happening-now-on-the-construction-site-of-museum-of-modern-art , https://www.detail.de/de_en/museum-fur-moderne-kunst-in-warschau , https://e-architect.com/poland/museum-of-modern-art-warsaw-poland-building

**TR Warszawa theatre: NOT built**
- Location: immediately south of / next to MSN, between MSN and PKiN, designed by Phifer as a pair with it.
- Timeline [S]:
  - Autumn 2024: concrete platform demolished and a preliminary excavation dug.
  - Stage I covers part of the underground plus the MSN loading docks. Warbud signed on 13 Jun 2025; works started 7 Aug 2025.
- **7 Oct 2026** [S]: the mayor dropped the original **black** facade design for a **light, metal-lattice ("ażurowy")** one.
  - A tender for the rest of the building is to be announced in November.
  - The contractor is expected by mid-2028, with completion targeted for mid-2029 (sources differ).
- **For the model: a construction site or excavation at grade, with no building.**
- Sources: https://www.se.pl/warszawa/mial-byc-czarny-bedzie-jasny-wielka-zmiana-sasiada-msn-w-centrum-warszawy-aa-GJ3X-mMDb-b3vx.html , https://geekweek.interia.pl/sztuka/news-czarny-tr-warszawa-rosnie-obok-bialego-msn-budowa-ruszyla,nId,22173638 , https://eurobuildcee.com/news/60438-tr-czeka-na-oferty

**Plac Centralny im. Tadeusza Mazowieckiego** [V]
- Location: between PKiN's east front and MSN / Marszałkowska. It continues the green corridor to Park Świętokrzyski at Marszałkowska/Świętokrzyska.
- Opened **4 Jun 2025**, after almost 2 years of works; cost over PLN 61 m.
- Planting:
  - 102 new trees
  - 550 shrubs
  - more than 81,000 perennials and bulbs
  - 3,600 m² of lawn
- Paving uses **5 stone types tracing the pre-war street and tenement layout**, with benches.
- I found no total area.
- Sources: https://warszawa19115.pl/en/-/opening-of-the-central-square-1 , https://www.polskieradio.pl/395/7789/artykul/3533795,warsaw-unveils-its-own-version-of-central-park , https://inzynierbudownictwa.pl/nowe-centrum-warszawy-jak-zmieni-sie-stolica/

**The rest of PKiN's surroundings** (about 24,000 m² between PKiN, Świętokrzyska and Al. Jerozolimskie)
- Only a design tender exists: concrete is to be replaced by greenery, with no construction dates.
- **The west, south and north sides of PKiN are still largely the old paved/parking layout** [S].
- Source: https://inzynierbudownictwa.pl/nowe-centrum-warszawy-jak-zmieni-sie-stolica/

**Marszałkowska tunnel/underpass at Złota (the bus ramp under Marszałkowska to PKiN)**
- Ramp closed 28–29 Jun 2024 and partly filled with concrete [V].
- Part of it is now an underground rainwater reservoir.
- A fountain stands where the 1970 tunnel entrance was.
- Source: https://www.eska.pl/motoryzacja/tunel-pod-marszalkowska-w-warszawie-zamkniety-zostanie-zasypany-25-07-aa-za2X-iPyN-FBBt.html

### The "Złota renovation / park" = "Zielona Złota"
- What it is: the Złota–Zgoda–Sienkiewicza–Jasna quarter, about 2.5 ha of streets and squares **east of Marszałkowska**, i.e. Złota running from Marszałkowska toward Zgoda / Plac Pięciu Rogów.
- Contractor: Skanska (about PLN 49 m bid, 2024).
- **Złota opened about 3–4 Aug 2026** [S]:
  - central pedestrian alley with a mineral surface
  - **81 elms** (planted at about 9 m tall), shrubs and perennials
  - cobblestone carriageway, access traffic only
  - fountain on the old tunnel entrance
- The whole quarter is planned to reach about 200 trees and about 3,000 m² of greenery.
- New at-grade Marszałkowska crossing at Sienkiewicza/Fangora.
- Still to do: the Filharmonia car park, which is to become Skwer Emila Młynarskiego / Ogród Muzyki.
- Sources: https://www.se.pl/warszawa/warszawa-odwraca-sie-od-samochodow-zielona-zlota-i-nowe-przejscie-na-marszalkowskiej-juz-otwarte-aa-B3R8-zQjX-uQ4Q.html , https://eurobuildcee.com/news/58342-zlota-i-zgody-do-przebudowy
- Note: ul. Złota **west** of Marszałkowska (past Złote Tarasy and Złota 44) is a different stretch. I found no greening project there.

### Other street works
- **Marszałkowska** (Ogród Saski → Rotunda): tram tracks replaced and about 150 trees planted in 2025; a bike path from Świętokrzyska to Złota is being finished (2026). Park Świętokrzyski replanting starts mid-2027.
- **Chmielna** (Pasaż Wiecha → Nowy Świat): done; granite paving, 88 trees and 7,500 shrubs.
- **Plac Pięciu Rogów**: done.
- **Al. Jerozolimskie**: only planned, tied to the future cross-city rail tunnel ("tunel średnicowy").
- Source for all of the above: https://inzynierbudownictwa.pl/nowe-centrum-warszawy-jak-zmieni-sie-stolica/ (30 Jul 2026)

### Warszawa Centralna station
- **No major rebuild has started** as of Dec 2025 / 2026; the full modernisation is postponed until the cross-city tunnel rebuild.
- Recent changes are only small: a cosmetic refresh in 2010–12, an interior mezzanine in 2015–16, and minor updates in 2025–26.
- Listed as a heritage monument in 2019, which protects its form.
- Sources: https://www.polskieradio.pl/395/7786/Artykul/3617267,full-revamp-ahead-for-warsaws-centralna-train-station-as-it-turns-50 , https://en.wikipedia.org/wiki/Warszawa_Centralna_railway_station

### Towers: new, under construction, planned

Heights are architectural / roof. List-page numbers come from https://pl.wikipedia.org/wiki/Lista_najwy%C5%BCszych_budynk%C3%B3w_w_Warszawie [S]; that page carries a "needs verification" tag.

| Building | Address / position | Height | Floors | Status Oct 2026 | Appearance |
|---|---|---|---|---|---|
| **Varso Tower** | Chmielna 73, corner of al. Jana Pawła II, by the rail cut west of Centralna | **310 m with spire; roof 230 m**, spire about 80 m | 53 above ground | Done 2022; observation deck opened Sept 2025 | Foster+Partners; slim glass tower with a stepped, chamfered crown and a needle spire; blue-grey glass [V] |
| Varso 1 / Varso 2 | Same complex (Chmielna / Jana Pawła II) | 81 m / 90 m | 21 / 23 | Done (Varso 1 is a hotel) | HRA; glass and light stone [S] |
| **The Bridge** (Ghelamco) | Grzybowska 67/69 at Rondo ONZ (corner of Jana Pawła II); about 600 m NW, edge of AOI | **174 m** | 40–41 | Done 2025 | Glass with a diagonal "bridge" bracing motif; facade complete Mar 2025 [V] |
| **Upper One** (Strabag RE) | al. Jana Pawła II 23 / Grzybowska; former Atrium International site; NW edge | **131.5 m** | 34 | **Topped out mid-2026; facade being fitted; completion 2027.** Next to it, the Cloud One hotel (55 m, 17 floors, 362 rooms) [V] | Glass curtain wall; 5 panoramic lifts on the south face |
| **Central Point** (Immobel) | Marszałkowska / Świętokrzyska, above Metro Świętokrzyska, on the former Sezam site (wiki gives Zielna 37) | **86 m** at topping out (wiki says 93) | 21–22 | Done 2021–22 | Glass, with retail at the base [S] |
| **Lilium Tower** | Al. Jerozolimskie 79, next to Centrum LIM/Marriott and Centralna | about 193 m (633 ft), 43–47 floors (new APA Wojciechowski design; the Zaha Hadid 240–260 m design is dead) | – | **Permit 2024; no construction start found → empty lot** | – |
| Ilmet | al. Jana Pawła II 15 at Rondo ONZ | about 83 m | 22 | **Still standing**; interior strip-out since Mar 2026, structure not yet demolished as of 25 Aug 2026. Replacement Warsaw One (Skanska), 188 m, permit Oct 2025 | Glass |
| Roma Tower | Nowogrodzka / Emilii Plater, south edge of AOI | 170–180 m | 48 | Permitted; contractor selection Aug 2026; **not started** | – |
| Skyreach | Grzybowska 59 (just outside AOI) | 174 m | 46–47 | Start announced Mar 2024; status unclear | – |
| Skyliner II | Prosta / Towarowa, Rondo Daszyńskiego (**outside**) | 130 m | 28–33 | Topped out 2026; done Q4 2026 | – |

Sources for the table:
- Varso: https://en.wikipedia.org/wiki/Varso , https://inzynierbudownictwa.pl/varso-tower-najwyzszy-budynek-w-polsce/
- The Bridge: https://en.wikipedia.org/wiki/The_Bridge_(Warsaw) , https://ghelamco.com/news-press/the-bridge-is-almost-ready-construction-of-ghelamcos-flagship-development-in-warsaw-is-nearing-completion/
- Upper One: https://www.whitemad.pl/en/upper-one-is-rising-it-is-set-to-reach-a-height-of-131-5-metres/ , https://www.strabag-real-estate.com/en/news-article/upper-one-topping-out/ , https://eurobuildcee.com/news/63175-wiecha-na-upper-one
- Central Point: https://eurobuildcee.com/en/news/31150-central-point-reaches-highest-point
- Lilium: https://kb.pl/aktualnosci/architektura-i-budownictwo/lilium-tower-w-warszawie/ , https://skyscraperpage.com/b169633
- Ilmet: https://www.officefinder.pl/news-30-year-old-office-building-vanishes-from-capitals-center-twice-as-tall-tower-to-replace-it.html
- Roma: https://kb.pl/aktualnosci/architektura-i-budownictwo/poczatek-budowy-roma-tower-w-warszawie/
- Skyliner II: https://eurobuildcee.com/en/news/36629-skyliner-ii-topped

Checked but not relevant:
- "Sienna 39": I found no such tower project. The address is an existing building near PKiN.
- "Forest" (Burakowska) and "Mennica Legacy Tower" (Prosta 18/Pereca 21, 141 m) are outside the AOI.

### Demolitions (relevant to 2019+ imagery and older datasets)
- **Dom Meblowy Emilia** (Emilii Plater / Świętokrzyska): demolished around 2016–17. The site was used for interim parking and events [U].
- **Kupieckie Domy Towarowe (KDT)**: the halls on Plac Defilad were cleared in 2009. MSN and Plac Centralny now occupy the area [U].
- **Sezam** (Marszałkowska / Świętokrzyska): demolished around 2017; Central Point now stands there [S].
- **Atrium International** (Jana Pawła II 23): demolished; Upper One now stands there [V].
- **Old Rotunda PKO**: rebuilt 2017–2019 (reopened Nov 2019, not 2018) [V].
- The **concrete platform/parking on Plac Defilad** was removed 2023–2025 [V].
- The **Marszałkowska bus tunnel** was closed and filled in 2024 [V].

---
## 2. Landmarks: dimensions and appearance

### PKiN (pl. Defilad 1)
- **Heights:**
  - Total **237 m**, including the antenna mount on the spire. It was 230.68 m before the 1994 change.
  - Roof **187.68 m**; one technical section says 187.80 m.
  - Main tower body about **120 m**, plus a 40 m turret and a 77 m spire (en.wikipedia).
- **Observation terrace:** 30th floor at **114 m**.
- **Floors:** 42 (46 levels including 2 basements).
- **Size:** volume about 817,000 m³; floor area 123,084 m²; 3,288 rooms.
- **Millennium Clock:** 4 faces, **6 m** in diameter (en.wiki says 6.3 m), on about the 40th floor at about **165 m** [S].
- **Congress Hall:** about 3,000 seats.
- **Facade:** ceramic cladding in **sandstone/beige** tone, now soiled; attics have stone ornaments and pinnacles. [V for colour/material, U for details]
- **Massing** [U]:
  - Symmetric about an E–W axis, with the tower centred.
  - Stepped tiers with corner pinnacles ("baszty") at several setbacks.
  - Lower wings ring the tower: the Congress Hall (Sala Kongresowa) on the east side toward Marszałkowska, and Teatr Studio, Teatr Dramatyczny, the Youth Palace with its pool, and the Museum of Evolution in the N/S wings.
  - Wing heights are typically about 20–35 m.
  - The overall complex footprint is roughly 200+ m N–S × ~150 m+ E–W. **I found no published footprint**; take it from BDOT10k / LoD1 / NMPT.
- **Statues:** Mickiewicz and Kopernik at the main entrance.
- Sources: https://pl.wikipedia.org/wiki/Pa%C5%82ac_Kultury_i_Nauki , https://en.wikipedia.org/wiki/Palace_of_Culture_and_Science , https://www.national-geographic.pl/traveler/artykul/wszystko-co-trzeba-wiedziec-o-palacu-kultury-i-nauki , https://pik.warszawa.pl/miejsca/palac-kultury-i-nauki/

### Other landmarks

Heights and floors come from the wiki list (https://pl.wikipedia.org/wiki/Lista_najwy%C5%BCszych_budynk%C3%B3w_w_Warszawie) unless noted. Appearance notes are [U] unless noted.

**Złota 44** (Złota 44, west of Marszałkowska, by Złote Tarasy)
- 192 m (sources call it 52–55 floors; the list says 55).
- Done around 2013–2017.
- Libeskind design: a "sail/wing" glass facade curving to the top, with a steel crown/exoskeleton at the summit.
- Sources: https://libeskind.com/work/zlota44/ , https://designingbuildings.co.uk/wiki/Zlota_44,_Warsaw

**Złote Tarasy** (Złota 59)
- Undulating glass/steel roof over the central atrium (Jerde; Arup engineering); irregular dome **about 110 × 100 m, max about 33 m high** [S].
- Office part: a 23-storey tower of about 100 m (the list gives 105 m, 26 floors) and two curved 8-storey blocks of about 55 m.
- Source: https://nbi.com.pl/content/uploads/assets/NBI-pdf/2007/3_12_2007/pdf/10_skanska_zlote_tarasy.pdf

**Warszawa Centralna** (Al. Jerozolimskie 54)
- 1972–75, by Romanowicz and Szymaniak. Main hall above ground; 4 underground island platforms, 400 m long.
- **I could not confirm a hyperbolic-paraboloid roof or the hall dimensions.** Hypar roofs belong to Ochota and Powiśle by the same architects. Centralny's hall is (from memory) a large glazed box with a flat, dark steel roof and low glazed entrance pavilions.
- **Get the geometry from NMPT/LoD1.**
- Construction quantities: 12,500 t steel, 80,000 m² glass.
- Sources: https://en.wikipedia.org/wiki/Warszawa_Centralna_railway_station , https://archiwa.gov.pl/wp-content/uploads/2025/12/IP_50lat_DworcaCentralnego_w_Archiwach-Panstwowych.pdf

**Rotunda PKO** (NE corner of Marszałkowska × Jerozolimskie)
- Rebuilt 2017–19 and reopened Nov 2019: a single-storey, glass-walled round pavilion with 48 steel columns about **13 m** high, plus a basement [V].
- Diameter not found; about 38 m [U].
- Sources: https://www.ndi.pl/en/projects/the-pko-bp-rotunda-in-warsaw , https://notesfrompoland.com/2019/11/30/iconic-warsaw-building-reopens/

**Ściana Wschodnia** (east side of Marszałkowska, Jerozolimskie → Świętokrzyska)
- Built 1960/62–69 (Karpiński, Klewin).
- **Domy Towarowe Centrum** (Wars, Sawa, Junior): a 350 m long row of low department stores, about 4 storeys, glass curtain walls.
- 3 residential point towers of about 24–26 floors (heights not found [U]).
- Pasaż Wiecha lies behind.
- DTC is being sold to Atrium; closing Q4 2026; no redevelopment yet.
- Sources: https://faf.org.pl/galleries/maria-chrzaszczowa/creativity/warsaw-1961-1972/eastern-wall/?lang=en , https://www.forbes.pl/handel/slynne-warszawskie-domy-towarowe-zmienia-wlasciciela-transakcja-za-13-mld-zl/gv464c4

**Hotel Marriott / Centrum LIM** (Al. Jerozolimskie 65/79)
- 170 m with antenna, roof 140 m; 43 floors; 1989.
- Dark glass with a white/grey band pattern [U].

**Novotel Centrum** (ex-Forum; Marszałkowska 94/98, SE corner by Rondo Dmowskiego)
- 111 / 106 m; 33 floors; 1974.
- Brown/bronze grid facade [U].

**Oxford Tower** (Chałubińskiego 8)
- 150 / 140 m; 46 floors; 1979.
- Dark glass after its 2010s refit [U].

**InterContinental** (Emilii Plater 49)
- 164 / 154 m; 45 floors; 2004.
- Slender slab with an open "window" at the base; light glass [U].

**Warsaw Financial Center** (Emilii Plater 53)
- 165 m with spire, roof 144 m; 32 floors; 1998.
- Granite and green glass, with a stepped top [U].

**Cosmopolitan** (Twarda 2/4; north edge of AOI)
- 160 m; 44 floors; 2013 (Helmut Jahn).
- Glass with a "crown" open frame at the top [U].

**Rondo 1** (Rondo ONZ 1)
- 192 m with spire, roof 159 m; 40 floors; 2006 (SOM).
- Dark glass with a grey stone base [U].

**Q22** (al. Jana Pawła II 22)
- 195 m, roof 159 m; 42 floors; 2016.
- Faceted glass, light grey [U].

**Spektrum Tower** (Twarda 18)
- 128 / 122 m; 35 floors; 2003.

**Warsaw Spire** (pl. Europejski)
- 220 / 180 m; about 1.3 km west, **outside** the AOI.

---
## 3. Open data endpoints (curl-tested 2026-10-12)

### GUGiK elevation (best: 2025 LiDAR)
- **NMPT (DSM) per-sheet download, 2025, 0.5 m, EVRF2007, PL-1992, ARC/INFO ASCII GRID** [V, HTTP 200]:
  - Sheets covering the AOI: N-34-138-B-d-2-2, N-34-138-B-d-2-4, N-34-139-A-c-1-1, N-34-139-A-c-1-3.
  - Job GK-FOTO.6201.5.2025; source "Skaning laserowy"; mean height error 0.05 m.
  - Example URL: https://opendata.geoportal.gov.pl/NumDaneWys/NMPT/83232/83232_1744511_N-34-139-A-c-1-1.asc (140 MB; header ncols 4394, nrows 4751, xllcenter 636487.5, yllcenter 486675.0, cellsize 0.5, nodata −9999).
  - The other three sheets: …/83232/83232_1744473_N-34-138-B-d-2-2.asc , …/83232_1744475_N-34-138-B-d-2-4.asc , …/83232_1744513_N-34-139-A-c-1-3.asc
- **Older NMPT** [V]:
  - 2023, 0.5 m: https://opendata.geoportal.gov.pl/NumDaneWys/NMPT/78046/78046_1404380_N-34-139-A-c-1-1.asc (and _1404382 for c-1-3)
  - 2022 sheets (PL-2000 zone 7, 1:1000 module): …/NMPT/77943/…
- **NMT (DTM) 2025, 1.0 m** [V, HTTP 200]: https://opendata.geoportal.gov.pl/NumDaneWys/NMT/83233/83233_1744695_N-34-139-A-c-1-1.asc (and _1744657 for B-d-2-2, _1744659 for B-d-2-4, _1744697 for c-1-3). A 2024 NMT (5 m) also exists: …/NMT/81441/…
- **Sheet-index WFS** (gives download URLs; layers per year up to 2026; the 2026 layer is empty for the AOI) [V]:
  - NMPT: `https://mapy.geoportal.gov.pl/wss/service/PZGIK/NumerycznyModelPokryciaTerenuEVRF2007/WFS/Skorowidze?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=gugik:SkorowidzNMPT2025&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX=52.2273,20.9987,52.2363,21.0133,urn:ogc:def:crs:EPSG::4326`
  - NMT: same pattern with `NumerycznyModelTerenuEVRF2007` and `gugik:SkorowidzNMT2025`.
- **WCS** [V; GetCapabilities returns 200 **without** a VERSION param, while `VERSION=2.0.1` timed out]:
  - DSM: `https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMPT/GRID1/WCS/DigitalSurfaceModel`. Coverages DSM_PL-KRON86-NH and DSM_PL-EVRF2007-NH. Limit about 7 km² per request.
  - DTM GeoTIFF: `https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF`. Coverage DTM_PL-KRON86-NH_TIFF.
  - DTM ASCII: …/NMT/GRID1/WCS/DigitalTerrainModel
  - Source: https://www.geoportal.gov.pl/pl/usluga/uslugi-pobierania-wcs/
  - Note: the WCS mosaic may not be the newest sheet; **prefer the 2025 per-sheet files.**
- The LiDAR point cloud WFS (DanePomiaroweLIDAR_EVRF2007) returned 401 at my guessed URL. Get it via the "Pobierz dane" viewer: https://mapy.geoportal.gov.pl/imapnext/imap/index.html?moduleId=modulPD

### Orthophoto
- **2025 RGB, 5 cm pixel, GeoTIFF, PL-1992**, same job GK-FOTO.6201.5.2025 [V, HTTP 200; about 1 GB per sheet]:
  - https://opendata.geoportal.gov.pl/ortofotomapa/83235/83235_1485417_N-34-139-A-c-1-1.tif
  - Other sheets: …/83235_1485374_N-34-138-B-d-2-2.tif , …_1485376_…B-d-2-4.tif , …_1485419_…c-1-3.tif
- **2024 25 cm, RGB and CIR**: …/ortofotomapa/81434/… and …/81435/…
- Ortho index WFS (layers 2019–2026): `https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WFS/Skorowidze`, typename `gugik:SkorowidzOrtofomapy2025` [V].
- WMS [V, 200]:
  - `https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution`
  - `…/ORTO/WMS/StandardResolution`
  - WMTS: `…/ORTO/WMTS/HighResolution`
  - These are mosaics; the year shown at the AOI is unverified.
- **True ortho WCS** (coverage True_Orthoimagery) [V, 200]: `https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WCS/TrueOrto`
- Flight month for 2025 is unknown; the index has only `akt_rok`. If it was before June 2025, Plac Centralny is shown mid-construction.

### 3D buildings (GUGiK)
- WMS with GetFeatureInfo download links [V, 200]: `https://mapy.geoportal.gov.pl/wss/service/PZGIK/FOTO/WMS/ModeleBudynkow3D`. Layers: LoD1_2024, _2022, _2021, _2019, LoD2_2017.
- **Warsaw (TERYT 1465) LoD1 2024 CityGML** [V, 200, 58 MB]: https://opendata.geoportal.gov.pl/InneDane/Budynki3D/LOD1/2024/14/1465.zip
  - Also: …/LOD1/2022/14/1465.zip , …/2021/14/1465.zip , …/2019/14/1465_gml.zip
- How LoD1 is built: base = lowest DTM point of the BDOT10k footprint; height = **median** of LiDAR building points, so towers with spires are under-represented; flat roofs.
- LoD2 (2017 state) returned nothing at PKiN; the URLs I guessed gave 404. **Treat LoD2 as unavailable for Warsaw.**
- Source: https://www.geoportal.gov.pl/pl/dane/inne-dane/modele-3d-budynkow/
- Also available: **GUGiK 3D tree models (LoD1, 2023) for Warsaw** via the WMS "Modele 3D drzew". Useful for vegetation voxels.
  - Source: https://www.geoportal.gov.pl/aktualnosci/modele-3d-drzew-dla-m-st-warszawy/

### Warsaw city
- `https://mapa.um.warszawa.pl/` responds 200 (an Angular app; it has 3D views), but I found **no documented open CityGML/3D download**.
- `https://dane.um.warszawa.pl/` responds 200, but its CKAN-style API path returned 404.
- Status: unverified; it may need manual browsing.
- OSM building:height / building:levels is a fallback for recent changes.

---
## 4. Model-specific gotchas
- **Spires:** Varso (80 m needle), PKiN (spire with antenna mount), Rondo 1, Q22, WFC and the Marriott antenna are thin. At 1 m voxels they come out 1–3 voxels wide; the DSM may under-sample them.
- **The 2025 LiDAR misses later changes:**
  - Upper One: it may show partial height; set 131.5 m.
  - Cloud One hotel: 55 m.
  - Złota street trees.
  - TR site: now an excavation.
  - The Marszałkowska tunnel mouth, now a fountain (filled in 2024, so probably already captured).
- **Don't add:** Lilium Tower, Roma Tower, Warsaw One or TR Warszawa. None of them exist yet.
- **Ilmet:** keep it.
