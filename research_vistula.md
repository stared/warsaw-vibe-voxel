# Vistula levels at Warsaw (for the water-level slider)

Gauge **Warszawa-Bulwary** (IMGW 152210170, km 421.68, by Most Śląsko-Dąbrowski, 52.2472 N 21.0208 E).
Zero **75.168 m EVRF2007 since 1 Nov 2025**: 1 m lower than before (riverbed erosion), so **older readings + 100 cm**.
Height = 75.168 + H/100 m (EVRF2007). The GUGiK DTM is PL-KRON86-NH, ~0.18 m lower here (inferred: the 2023 city
plan puts 600 cm (old) at 81.99 m, i.e. an old zero of 75.99 Kronsztadt vs 76.17 EVRF2007).
Sources: [IMGW API](https://danepubliczne.imgw.pl/api/data/hydro/id/152210170), [Wody Polskie notice](https://www.gov.pl/attachment/383b8d46-8b50-420d-beb0-6621480db58b),
[campaign](https://www.gov.pl/web/wody-polskie-warszawa/rozpoczynamy-wraz-z-imgw-pib-kampanie-informacyjna-dot-zmiany-na-wodowskazie-warszawa-bulwary),
[city flood plan](https://dbforembertow.bip.warszawa.pl/documents/d/stoleczne-centrum-bezpieczenstwa/2-powodzie).

| stage | cm (current scale) | old scale | source |
|---|---|---|---|
| record low (2–5 Sep 2025) | 104 | 4 | IMGW; [bankier](https://www.bankier.pl/wiadomosc/Rekordowo-niski-stan-Wisly-Ledwie-7-cm-na-stacji-Warszawa-Bulwary-8999119.html) (7 cm old, 27 Aug 2025) |
| drought 2024 (Sep) / 2015 | 125 / 126 | 25 / 26 | [interia](https://wydarzenia.interia.pl/mazowieckie/news-w-warszawie-padl-niechlubny-rekord-tak-zle-nie-bylo-nigdy-wc,nId,7776703), [polsat](https://www.polsatnews.pl/wiadomosc/2025-08-25/na-wisle-padl-kolejny-rekord-najnizszy-pomiar-w-historii/) |
| **the model's river (LiDAR day)** | **185** | 85 | DTM over the river, scripts/flood.py |
| long-term mean | ~330 | ~230 | [muratordom](https://muratordom.pl/prawo/porady-prawne/niski-stan-wody-w-wisle-w-warszawie-znow-padnie-niechlubny-rekord-aa-LXbW-rAtY-m3vx.html) |
| warning / alarm | 700 / 750 | 600 / 650 | IMGW |
| 1960 (31 Jul), IMGW station max | 873 | 773 | IMGW |
| 2010 (22 May) | 879 | 779 | [gazetaprawna](https://www.gazetaprawna.pl/wiadomosci/artykuly/426774,wielka-fala-powodziowa-znowu-wraca-alarm-w-warszawie.html) (Port Praski gauge then; not exactly the same scale) |
| 1844, historical max | ~963 | 863 | [urbnews](https://urbnews.pl/powodzie-warszawie-historia-tereny-zagrozone/) (old gauge, approximate) |

In the model (DTM in whole metres; area newly reached, km², at the gauge-row level — the river falls ~0.6 m across the
map, so ±30 cm by place): 300 cm 0.02 · 400 0.12 · 500 0.19 · 600 0.18 · 700 0.10 · 800 0.13 · 900 0.23 ·
1000 0.54 · **1100 2.49 (the dykes topped: Powiśle, Praga)**. The city plan: the 1% flood stays inside the dykes.
The river bed is an estimate (LiDAR doesn't see through water): shelves off natural shores, deeper by the left bank.

## Photos
- Record low, Copernicus Sep 2023 vs 8 Sep 2024 (CC BY 4.0): https://commons.wikimedia.org/wiki/File:Vistula_River_in_Poland_at_record-breaking_low_levels_(P-064379-00-26).jpg
- Low water 9 Aug 2015, Gdański–Grota bridges (CC BY-SA 4.0): https://commons.wikimedia.org/wiki/File:Wis%C5%82a_w_Warszawie_-_niski_stan_wody.jpg
- 2015: pre-war Most Poniatowskiego remains exposed (PAP): https://dzieje.pl/node/115248 ; Swedish loot from the riverbed: https://www.se.pl/warszawa/bezcenne-zabytki-wisly-5-ton-eksponatow-wydobyto-tego-lata-audio-zdjecia-aa-7sTR-ycWG-EDmn.html
- 2024 record, PAP gallery: https://www.pap.pl/aktualnosci/imgw-rekordowo-niski-stan-wisly-nasze-zdjecia
- Flood 21 May 2010 from Most Śląsko-Dąbrowski: https://commons.wikimedia.org/wiki/File:Flood_in_Warsaw.jpg , https://commons.wikimedia.org/wiki/File:Wis%C5%82a_%C5%9Al%C4%85sko-D%C4%85browski_2010.jpg , https://commons.wikimedia.org/wiki/File:May_2010_Vistula_Warsaw_01.JPG (_02–_04), https://commons.wikimedia.org/wiki/File:Warsaw_Vistula_river_20100521.jpg
- Rising, 11 May 2010 panorama: https://commons.wikimedia.org/wiki/File:May_2010_Vistula_Warsaw_panorama.JPG
- Normal: https://commons.wikimedia.org/wiki/File:Vistula_Boulevards_beneath_the_%C5%9Awi%C4%99tokrzyski_Bridge,_2026,_Warsaw,_Poland.jpg , groynes: https://commons.wikimedia.org/wiki/File:Ostrogi_Wis%C5%82a_Warszawa_002.jpg
