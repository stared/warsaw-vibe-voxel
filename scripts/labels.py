"""Every label on the map and how far away it shows.

The curated landmarks (landmarks.LABELS, EXTRA_LABELS, the Jazdów houses) plus the places people read about: Wikidata
items located on the map (scripts/notable.py), ranked by Polish + English Wikipedia page views over a year. `far` is
the camera distance (m) up to which a label shows; the viewer adds its English name or kind closer in, then its
facts and website.

usage: uv run python scripts/labels.py    rewrites the labels in web/public/data/meta.json from the cached build
"""
import json
import re
from pathlib import Path

import numpy as np
from scipy import ndimage
from shapely.geometry import Point
from shapely.strtree import STRtree

import landmarks
from aoi import RAW, W, D
from osm import to_grid

NOTABLE = Path(RAW) / "notable.json"
META = Path(__file__).resolve().parent.parent / "web/public/data/meta.json"
IN_WARSAW = re.compile(r",?\s+(in|w)\s+(Warsaw|Warszawie)\b.*$|,\s*Warsaw$|\s*\((Śródmieście|Powiśle|Wola|Nowy Świat)\)$", re.I)

# how far away (m) each label shows, judged place by place: the whole map for what defines the city, a few hundred
# metres for a small monument; the Jazdów houses (~220 m) come with their own
FAR_TIERS = {
    9000: "Pałac Kultury i Nauki, Varso Tower, PGE Narodowy, Wisła, Pałac Prezydencki, Uniwersytet Warszawski, Sejm, "
          "Warszawa Centralna, Teatr Wielki",
    5000: "Kościół św. Krzyża, Muzeum Narodowe, Grób Nieznanego Żołnierza, Plac Piłsudskiego, Ogród Saski, Pałac Saski, "
          "Złota 44, Złote Tarasy, Centrum Nauki Kopernik, Politechnika Warszawska, Most Poniatowskiego, "
          "Most Świętokrzyski, Zachęta, Muzeum Sztuki Nowoczesnej, Hotel Bristol, Hotel Europejski, Plac Trzech Krzyży, "
          "Zamek Ujazdowski, BUW, Bulwary Wiślane, Muzeum Fryderyka Chopina, Filharmonia Narodowa, Synagoga Nożyków, "
          "Hala Koszyki, Elektrownia Powiśle, Plac Zbawiciela, Plac Konstytucji",
    1800: "Q22, Rondo 1, InterContinental, Marriott, Cosmopolitan, Warszawskie Centrum Finansowe, Oxford Tower, "
          "Spektrum Tower, Skysawa, Hotel Warszawa, Novotel, Torwar, Teatr Narodowy, Palma, PAST-a, Rotunda PKO, "
          "Uniwersytet Muzyczny Fryderyka Chopina, Pałac Lubomirskich, Syrenka, Warszawa Śródmieście, Plac Defilad, "
          "Plac Centralny, Pałac Czapskich, Hale Mirowskie, Pomnik Mikołaja Kopernika, Kościół Wizytek, Kościół św. Aleksandra, "
          "Kościół Świętej Trójcy, Kościół Najświętszego Zbawiciela, Kościół Wszystkich Świętych, Kościół Karmelitów, "
          "Teatr Polski, Teatr Ateneum, Teatr Roma, Studio Buffo, TR Warszawa, Kładka pieszo-rowerowa, Most Łazienkowski, "
          "Most Średnicowy, Park Ujazdowski, Mauzoleum Walki i Męczeństwa, Muzeum Getta Warszawskiego, Ambasada USA, "
          "Plac Grzybowski, Plac Powstańców Warszawy, Dom Partii, Smyk, Ściana Wschodnia, Port Praski, Pałac Błękitny, "
          "Pałac Potockich, Teatr Żydowski, Muzeum Etnograficzne",
    900: "Centrum (metro), Świętokrzyska (metro), Nowy Świat-Uniwersytet (metro), Politechnika (metro), "
         "Rondo ONZ (metro), Centrum Nauki Kopernik (metro), Stadion Narodowy (metro), Plac Konstytucji (metro), "
         "Warszawa Powiśle, "
         "Warszawa Stadion, Plac Teatralny, Plac Żelaznej Bramy, Plac Pięciu Rogów, Ilmet, Central Tower, Central Point, "
         "Upper One, Metropolitan, PZU Tower, Hotel Polonia, Hotel Victoria, The Westin, Dom Towarowy Braci Jabłkowskich, "
         "Vitkac, Zielona Złota, Domki Fińskie, Kościół św. Barbary, Kościół św. Antoniego, Hala Gwardii, "
         "Park Rydza-Śmigłego, Park Świętokrzyski, Wiadukt Markiewicza, Pałac Kazimierzowski, Mur getta, "
         "Pomnik Adama Mickiewicza, Pomnik Józefa Piłsudskiego, Pomnik Józefa Poniatowskiego, Pałac Staszica, Neon Muzeum, "
         " Teatr Kwadrat, Teatr Capitol, Teatr Polonia, "
         "Teatr Sabat, Teatr IMKA, Kino Atlantic, Fotoplastikon, Biblioteka Krasińskich, Pałac Zamoyskich, "
         "Pałac Tyszkiewiczów, Brama Uniwersytecka, Stadion Agrykola, Hotel MDM, Dom Chłopa, Widok Towers",
    400: "Pałac Sobańskich, Pałac Przezdzieckich, Pomnik Ofiar Tragedii Smoleńskiej, Riviera, Warszawa Śródmieście WKD, "
         "Pawilon Cepelii, Pomnik Kościuszkowców, Elizeum, Hotel Nobu, Willa Pniewskiego, Muzeum Techniki, "
         "Auditorium Maximum, Muzeum Ewolucji, Plac Na Rozdrożu, Gmach Giełdy i Banku Polskiego, Pomnik Lecha Kaczyńskiego, "
         "Pomnik Chwała Saperom, Plac Dąbrowskiego, Kościół św. Karola Boromeusza, Biały Pałacyk na Frascati, "
         "Pomnik Armii Krajowej, Pałacyk Rembielińskiego, Kino Palladium, Dom pod Orłami, Pomnik Jazdy Polskiej, "
         "Pomnik Tadeusza Kościuszki, Teatr Lalka, Muzeum Azji i Pacyfiku, Kamienica pod Gigantami, Hotel Grand, "
         "Zebra Tower, Kinoteka, Kościół Res Sacra Miser, Centrum Pieniądza NBP, Galeria Foksal, Hotel Sheraton, "
         "Kościół Świętej Trójcy na Solcu, Planetarium Niebo Kopernika, Pałac Karasia, Pałac Uruskich, Salonik Chopinów, "
         "Muzeum Ziemi, Astoria, Kolektyw3",
}
FAR = {n.strip(): far for far, names in FAR_TIERS.items() for n in names.split(",")}

# chosen by hand from the ~420 most read items on the map (not events, organisations, streets, lost buildings or
# things inside a labelled building); without far, it comes from page views
P = dict
PICKS = {
    "Q144488": P(kind="university"),
    "Q1540926": P(kind="monument"),
    "Q608932": P(kind="presidential palace", site="https://www.prezydent.pl"),
    "Q1440735": P(name="Kościół Świętego Krzyża", kind="church", alt="bazylika Chopin heart serce Chopina"),
    "Q153306": P(kind="museum"),
    "Q821342": P(kind="hotel"),
    "Q3044701": P(name="Torwar", kind="arena"),
    "Q1872860": P(kind="palace"),
    "Q2691064": P(kind="theatre"),
    "Q2374346": P(name="Palma", kind="artwork"),
    "Q1630844": P(kind="hotel"),
    "Q821379": P(name="PAST-a", en="PAST building", kind="telephone exchange, 1910"),
    "Q929269": P(name="Plac Piłsudskiego", kind="square"),
    "Q806604": P(name="Dom Partii", en="former Communist Party HQ", kind="office building"),
    "Q1324986": P(kind="hotel"),
    "Q11698038": P(kind="concert hall"),
    "Q1340262": P(kind="music university"),
    "Q1627287": P(kind="square"),
    "Q47501099": P(name="Syrenka", en="Warsaw Mermaid", kind="monument"),
    "Q1683191": P(kind="monument"),
    "Q2320937": P(kind="railway station"),
    "Q1756534": P(kind="castle, contemporary art centre", alt="CSW Centrum Sztuki Współczesnej", site="https://u-jazdowski.pl"),
    "Q7134098": P(kind="square"),
    "Q1149220": P(kind="palace, Academy of Fine Arts", alt="ASP Akademia Sztuk Pięknych"),
    "Q33545722": P(name="Hale Mirowskie", kind="market halls"),
    "Q247799": P(kind="skyscraper"),
    "Q156555": P(kind="palace, Academy of Sciences", alt="PAN Polska Akademia Nauk"),
    "Q9347384": P(kind="theatre"),
    "Q1351448": P(kind="church"),
    "Q3354467": P(kind="church"),
    "Q2915221": P(name="Synagoga Nożyków", kind="synagogue"),
    "Q3671990": P(kind="monument"),
    "Q1095476": P(kind="palace, university rectorate"),
    "Q9356010": P(name="Teatr Ateneum", kind="theatre"),
    "Q3527543": P(name="Teatr Polski", kind="theatre"),
    "Q11819218": P(kind="square"),
    "Q23817368": P(name="Kładka pieszo-rowerowa", en="Vistula footbridge", kind="footbridge, 2024"),
    "Q444092": P(kind="museum, former Gestapo prison"),
    "Q8123476": P(name="Mur getta", kind="ghetto wall"),
    "Q4569133": P(name="Kościół Karmelitów", kind="church"),
    "Q9356099": P(name="Teatr Roma", kind="musical theatre"),
    "Q882672": P(kind="palace"),
    "Q376942": P(name="Kościół Świętej Trójcy", kind="Lutheran church"),
    "Q3692546": P(kind="museum", alt="Zamek Ostrogskich Ostrogski Palace"),
    "Q638910": P(kind="metro station"),
    "Q638914": P(kind="metro station"),
    "Q9183918": P(kind="metro station"),
    "Q639024": P(kind="metro station"),
    "Q7365568": P(kind="metro station"),
    "Q9183919": P(kind="metro station"),
    "Q7596321": P(kind="metro station"),
    "Q638861": P(kind="metro station"),
    "Q5117878": P(kind="church"),
    "Q387041": P(kind="1960s shopping frontage"),
    "Q1236560": P(name="Smyk", kind="department store, 1951", alt="CDT Centralny Dom Towarowy", site=""),
    "Q7970920": P(kind="square"),
    "Q1933198": P(kind="skyscraper"),
    "Q1326654": P(kind="hotel"),
    "Q21020336": P(kind="theatre"),
    "Q111650304": P(kind="hotel"),
    "Q2892963": P(kind="theatre"),
    "Q6110328": P(kind="department store, 1914"),
    "Q9356053": P(kind="theatre"),
    "Q62050970": P(kind="skyscraper"),
    "Q11745958": P(kind="church"),
    "Q1629484": P(kind="palace, Ministry of Culture"),
    "Q2296393": P(kind="palace"),
    "Q11785957": P(kind="bridge"),
    "Q11819052": P(kind="square"),
    "Q145920": P(kind="palace"),
    "Q55337700": P(kind="museum", building=True),
    "Q51727465": P(kind="monument"),
    "Q16610004": P(kind="theatre"),
    "Q9377639": P(kind="department store"),
    "Q1567828": P(kind="former river port, new quarter"),
    "Q2114578": P(kind="palace"),
    "Q3390703": P(kind="square"),
    "Q652788": P(kind="square"),
    "Q348386": P(kind="monument"),
    "Q9209422": P(name="Riviera", kind="student dormitory"),
    "Q762533": P(kind="skyscraper"),
    "Q3134741": P(kind="park", site="https://eko.um.warszawa.pl/-/park-ujazdowski"),
    "Q30905825": P(kind="hotel"),
    "Q2463480": P(kind="palace"),
    "Q2755236": P(kind="railway station"),
    "Q60222434": P(name="Pawilon Cepelii", kind="modernist pavilion"),
    "Q131914521": P(kind="office tower"),
    "Q28674017": P(kind="square"),
    "Q9356150": P(kind="theatre"),
    "Q11823305": P(kind="monument"),
    "Q9252875": P(kind="18th-century grotto"),
    "Q9261973": P(kind="museum"),
    "Q11746537": P(kind="church"),
    "Q116355": P(kind="hotel"),
    "Q9374715": P(kind="villa, museum"),
    "Q961766": P(kind="museum"),
    "Q11790623": P(kind="museum"),
    "Q11785962": P(kind="railway bridge"),
    "Q1729038": P(kind="palace"),
    "Q11811404": P(name="Park Rydza-Śmigłego", kind="park"),
    "Q6941029": P(kind="museum"),
    "Q6436189": P(kind="library"),
    "Q11778109": P(kind="office building"),
    "Q9161880": P(name="Auditorium Maximum", kind="university hall"),
    "Q6940852": P(kind="museum"),
    "Q11823282": P(kind="monument"),
    "Q11819117": P(kind="square"),
    "Q1497347": P(kind="historic bank building"),
    "Q2579655": P(kind="railway station"),
    "Q56328837": P(name="Pomnik Lecha Kaczyńskiego", kind="monument"),
    "Q3276715": P(kind="railway station"),
    "Q2502215": P(kind="palace"),
    "Q9356126": P(kind="theatre"),
    "Q2044934": P(kind="office tower"),
    "Q5104833": P(kind="museum"),
    "Q11823163": P(kind="monument"),
    "Q1630955": P(kind="hotel"),
    "Q11819068": P(name="Plac Dąbrowskiego", kind="square"),
    "Q4816262": P(name="Kino Atlantic", kind="cinema"),
    "Q11746975": P(name="Kościół św. Karola Boromeusza", kind="church"),
    "Q1451309": P(kind="palace"),
    "Q61989411": P(kind="office towers"),
    "Q11823410": P(name="Pomnik Armii Krajowej", kind="monument"),
    "Q1820898": P(kind="palace"),
    "Q11739380": P(kind="cinema"),
    "Q9209364": P(kind="historic office building"),
    "Q11823261": P(kind="monument"),
    "Q2331260": P(name="Wiadukt Markiewicza", kind="viaduct"),
    "Q11823485": P(kind="monument"),
    "Q66763567": P(kind="puppet theatre"),
    "Q3893223": P(kind="museum"),
    "Q11734224": P(kind="tenement house"),
    "Q1954543": P(kind="museum"),
    "Q1542586": P(kind="hotel"),
    "Q9389950": P(kind="office tower"),
    "Q9178743": P(name="Brama Uniwersytecka", kind="gate"),
    "Q20032546": P(kind="cinema"),
    "Q11745622": P(name="Kościół Res Sacra Miser", kind="church"),
    "Q29158537": P(name="Centrum Pieniądza NBP", en="NBP Money Centre", kind="museum"),
    "Q2278233": P(kind="hotel"),
    "Q11746364": P(name="Kościół Świętej Trójcy na Solcu", kind="church"),
    "Q5464222": P(kind="gallery"),
    "Q111671660": P(name="Ambasada USA", en="US Embassy", kind="embassy"),
    "Q24945654": P(en="Planetarium", kind="planetarium"),
    "Q110927707": P(name="Kościół św. Barbary", kind="church"),
    "Q33545766": P(name="Hala Gwardii", en="", kind="market hall"),
    "Q60862214": P(kind="stadium"),
}

# official sites for labels Wikidata has none for, found and checked by hand (Oct 2026)
SITES = {
    "Marriott": "https://www.marriott.com/en-us/hotels/wawpl-warsaw-marriott-hotel/overview/",
    "InterContinental": "https://warszawa.intercontinental.com/",
    "Torwar": "https://torwar.cos.pl/",
    "Sejm": "https://www.sejm.gov.pl/",
    "Rotunda PKO": "https://bankomania.pkobp.pl/rotunda-spotkan/",
    "Ogród Saski": "https://eko.um.warszawa.pl/-/ogrod-saski",
    "Pałac Czapskich": "https://asp.waw.pl/palac-czapskich/",
    "Pałac Staszica": "https://pan.pl/",
    "Studio Buffo": "https://www.studiobuffo.com.pl/",
    "Kościół Wizytek": "https://wizytki.waw.pl/",
    "Teatr Ateneum": "https://teatrateneum.pl/",
    "Park Ujazdowski": "https://eko.um.warszawa.pl/-/park-ujazdowski",
    "Centrum Nauki Kopernik": "https://www.kopernik.org.pl/",
    "Pałac Saski": "https://palacsaski.pl/",
    "Kościół Karmelitów": "https://wmsd.waw.pl/historia-kosciola/",
    "Teatr Roma": "https://www.teatrroma.pl/",
    "Elektrownia Powiśle": "https://elektrowniapowisle.com/",
    "Sofitel Warszawa Victoria": "https://sofitel.accor.com/en/hotels/3378.html",
    "Spektrum Tower": "https://www.globalworth.com/buildings/office/spektrum-tower/",
    "Pałac Potockich": "https://www.gov.pl/web/kultura",
    "Politechnika Warszawska": "https://www.pw.edu.pl/",
    "Park Rydza-Śmigłego": "https://eko.um.warszawa.pl/-/park-im-marszalka-edwarda-rydza-smiglego",
    "Park Świętokrzyski": "https://eko.um.warszawa.pl/-/park-swietokrzyski",
    "Ambasada USA": "https://pl.usembassy.gov/",
    "Pałac Kazimierzowski": "https://www.uw.edu.pl/",
    "Teatr IMKA": "https://www.facebook.com/IMKAteatr/",
    "Pałac Sobańskich": "https://palacsobanskich.pl/",
    "Pałac Zamoyskich": "https://sarp.warszawa.pl/",
    "Dom Chłopa": "https://www.gromada.pl/hotel-warszawa-centrum",
    "Pałac Tyszkiewiczów": "https://muzeum.uw.edu.pl/",
    "Teatr Sabat": "https://www.teatr-sabat.pl/",
    "Willa Pniewskiego": "https://mz.pan.pl/",
    "Teatr Polonia": "https://www.teatrpolonia.pl/",
    "Hotel MDM": "https://www.hotelmdm.com.pl/",
    "Widok Towers": "https://www.widoktowers.com/en",
    "Kościół Świętej Trójcy na Solcu": "https://solec.karmelicibosi.pl/",
    "Stadion Agrykola": "https://agrykola.eduwarszawa.pl/warszawskie-centrum-sportu-mlodziezowego-agrykola",
    "Planetarium Niebo Kopernika": "https://www.kopernik.org.pl/planetarium",
}

# how each label reads: the Polish name as Varsovians say it, its English name (None for brands that read the same in
# both, which show their kind instead) and a plain kind
NAMES = {
    "Pałac Kultury i Nauki": ("Pałac Kultury i Nauki", "Palace of Culture and Science", "tower"),
    "Varso Tower": ("Varso Tower", None, "office tower"),
    "PGE Narodowy": ("PGE Narodowy", "National Stadium", "stadium"),
    "Wisła": ("Wisła", "Vistula", "river"),
    "Uniwersytet Warszawski": ("Uniwersytet Warszawski", "University of Warsaw", "university"),
    "Pałac Prezydencki": ("Pałac Prezydencki", "Presidential Palace", "palace"),
    "Warszawa Centralna": ("Warszawa Centralna", "Warsaw Central Station", "railway station"),
    "Teatr Wielki": ("Teatr Wielki", "Grand Theatre", "opera house"),
    "Kościół Świętego Krzyża": ("Kościół św. Krzyża", "Holy Cross Church", "church"),
    "Muzeum Narodowe": ("Muzeum Narodowe", "National Museum", "museum"),
    "Złota 44": ("Złota 44", None, "residential tower"),
    "Marriott": ("Marriott", None, "hotel"),
    "Rondo 1": ("Rondo 1", None, "office tower"),
    "InterContinental": ("InterContinental", None, "hotel"),
    "Q22": ("Q22", None, "office tower"),
    "Cosmopolitan": ("Cosmopolitan", None, "residential tower"),
    "Grób Nieznanego Żołnierza": ("Grób Nieznanego Żołnierza", "Tomb of the Unknown Soldier", "monument"),
    "Hotel Warszawa": ("Hotel Warszawa", None, "hotel"),
    "Torwar": ("Torwar", None, "arena"),
    "Teatr Narodowy": ("Teatr Narodowy", "National Theatre", "theatre"),
    "Palma": ("Palma", "Palm Tree", "artwork"),
    "Sejm": ("Sejm", "Parliament", "parliament"),
    "Most Poniatowskiego": ("Most Poniatowskiego", "Poniatowski Bridge", "bridge"),
    "Złote Tarasy": ("Złote Tarasy", "Golden Terraces", "shopping centre"),
    "Hotel Bristol": ("Hotel Bristol", None, "hotel"),
    "PAST-a": ("PAST-a", "PAST Building", "telephone exchange"),
    "Plac Piłsudskiego": ("Plac Piłsudskiego", "Piłsudski Square", "square"),
    "Rotunda PKO": ("Rotunda PKO", "PKO Rotunda", "bank"),
    "Hotel Europejski": ("Hotel Europejski", None, "hotel"),
    "Filharmonia Narodowa": ("Filharmonia Narodowa", "National Philharmonic", "concert hall"),
    "Uniwersytet Muzyczny Fryderyka Chopina": ("Uniwersytet Muzyczny Fryderyka Chopina", "Chopin University of Music", "university"),
    "Pałac Lubomirskich": ("Pałac Lubomirskich", "Lubomirski Palace", "palace"),
    "Muzeum Sztuki Nowoczesnej": ("Muzeum Sztuki Nowoczesnej", "Museum of Modern Art", "museum"),
    "Plac Trzech Krzyży": ("Plac Trzech Krzyży", "Three Crosses Square", "square"),
    "Syrenka": ("Syrenka", "Warsaw Mermaid", "monument"),
    "Ogród Saski": ("Ogród Saski", "Saxon Garden", "park"),
    "Warszawa Śródmieście": ("Warszawa Śródmieście", None, "railway station"),
    "Zamek Ujazdowski": ("Zamek Ujazdowski", "Ujazdów Castle", "art centre"),
    "Plac Defilad": ("Plac Defilad", "Parade Square", "square"),
    "Zachęta": ("Zachęta", "Zachęta National Gallery", "gallery"),
    "Pałac Czapskich": ("Pałac Czapskich", "Czapski Palace", "palace"),
    "Hale Mirowskie": ("Hale Mirowskie", "Mirów Market Halls", "market hall"),
    "Oxford Tower": ("Oxford Tower", None, "office tower"),
    "Pałac Staszica": ("Pałac Staszica", "Staszic Palace", "palace"),
    "Novotel": ("Novotel", None, "hotel"),
    "Studio Buffo": ("Studio Buffo", None, "theatre"),
    "Kościół Wizytek": ("Kościół Wizytek", "Visitationist Church", "church"),
    "Kościół św. Aleksandra": ("Kościół św. Aleksandra", "St Alexander's Church", "church"),
    "Synagoga Nożyków": ("Synagoga Nożyków", "Nożyk Synagogue", "synagogue"),
    "Dom Partii": ("Dom Partii", "Party House", "former Communist Party HQ"),
    "BUW": ("BUW", "University Library", "library"),
    "Teatr Ateneum": ("Teatr Ateneum", "Ateneum Theatre", "theatre"),
    "Teatr Polski": ("Teatr Polski", "Polish Theatre", "theatre"),
    "Kładka pieszo-rowerowa": ("Kładka pieszo-rowerowa", "Vistula Footbridge", "footbridge"),
    "Most Świętokrzyski": ("Most Świętokrzyski", "Świętokrzyski Bridge", "bridge"),
    "Kościół Świętej Trójcy": ("Kościół Świętej Trójcy", "Holy Trinity Lutheran Church", "church"),
    "Kościół Najświętszego Zbawiciela": ("Kościół Najświętszego Zbawiciela", "Church of the Holy Saviour", "church"),
    "Kościół Wszystkich Świętych": ("Kościół Wszystkich Świętych", "All Saints Church", "church"),
    "Most Łazienkowski": ("Most Łazienkowski", "Łazienkowski Bridge", "bridge"),
    "Park Ujazdowski": ("Park Ujazdowski", "Ujazdów Park", "park"),
    "Centrum Nauki Kopernik": ("Centrum Nauki Kopernik", "Copernicus Science Centre", "museum"),
    "Most średnicowy": ("Most Średnicowy", "Cross-City Railway Bridge", "railway bridge"),
    "Plac Centralny": ("Plac Centralny", "Central Square", "square"),
    "Pałac Saski": ("Pałac Saski", "Saxon Palace", "palace"),
    "Bulwary Wiślane": ("Bulwary Wiślane", "Vistula Boulevards", "promenade"),
    "Plac Zbawiciela": ("Plac Zbawiciela", "Saviour Square", "square"),
    "Mauzoleum Walki i Męczeństwa": ("Mauzoleum Walki i Męczeństwa", "Mausoleum of Struggle and Martyrdom", "museum"),
    "Kościół Karmelitów": ("Kościół Karmelitów", "Carmelite Church", "church"),
    "Teatr Roma": ("Teatr Roma", "Roma Theatre", "theatre"),
    "TR Warszawa": ("TR Warszawa", "TR Warsaw Theatre", "theatre"),
    "Pałac Błękitny": ("Pałac Błękitny", "Blue Palace", "palace"),
    "Muzeum Fryderyka Chopina": ("Muzeum Fryderyka Chopina", "Chopin Museum", "museum"),
    "Świętokrzyska (metro)": ("Świętokrzyska", None, "metro station"),
    "Ilmet": ("Ilmet", None, "office tower"),
    "Ściana Wschodnia": ("Ściana Wschodnia", "Eastern Wall", "shopping street"),
    "Smyk": ("Smyk", None, "department store"),
    "Plac Powstańców Warszawy": ("Plac Powstańców Warszawy", "Warsaw Uprising Square", "square"),
    "Warsaw Financial Center": ("Warszawskie Centrum Finansowe", "Warsaw Financial Center", "office tower"),
    "Hotel Polonia": ("Hotel Polonia", None, "hotel"),
    "Elektrownia Powiśle": ("Elektrownia Powiśle", "Powiśle Power Station", "shopping centre"),
    "Plac Konstytucji": ("Plac Konstytucji", "Constitution Square", "square"),
    "Sofitel Warszawa Victoria": ("Hotel Victoria", None, "hotel"),
    "Teatr Żydowski": ("Teatr Żydowski", "Jewish Theatre", "theatre"),
    "Dom Towarowy Braci Jabłkowskich": ("Dom Towarowy Braci Jabłkowskich", "Jabłkowski Brothers Department Store", "department store"),
    "Skysawa": ("Skysawa", None, "office tower"),
    "Spektrum Tower": ("Spektrum Tower", None, "office tower"),
    "Pałac Potockich": ("Pałac Potockich", "Potocki Palace", "palace"),
    "Stadion Narodowy (metro)": ("Stadion Narodowy", None, "metro station"),
    "Plac Grzybowski": ("Plac Grzybowski", "Grzybowski Square", "square"),
    "Centrum (metro)": ("Centrum", None, "metro station"),
    "Muzeum Getta Warszawskiego": ("Muzeum Getta Warszawskiego", "Warsaw Ghetto Museum", "museum"),
    "Vitkac": ("Vitkac", None, "department store"),
    "Port Praski": ("Port Praski", "Praga Port", "housing"),
    "Hala Koszyki": ("Hala Koszyki", "Koszyki Market Hall", "market hall"),
    "Plac Teatralny": ("Plac Teatralny", "Theatre Square", "square"),
    "Plac Żelaznej Bramy": ("Plac Żelaznej Bramy", "Iron Gate Square", "square"),
    "Central Tower": ("Central Tower", None, "office tower"),
    "Politechnika Warszawska": ("Politechnika Warszawska", "Warsaw University of Technology", "university"),
    "Upper One": ("Upper One", None, "office tower"),
    "Plac Pięciu Rogów": ("Plac Pięciu Rogów", "Five Corners Square", "square"),
    "Kościół św. Antoniego Padewskiego": ("Kościół św. Antoniego", "St Anthony's Church", "church"),
    "Politechnika (metro)": ("Politechnika", None, "metro station"),
    "Państwowe Muzeum Etnograficzne": ("Muzeum Etnograficzne", "Ethnographic Museum", "museum"),
    "Nowy Świat-Uniwersytet (metro)": ("Nowy Świat-Uniwersytet", None, "metro station"),
    "Park Rydza-Śmigłego": ("Park Rydza-Śmigłego", "Rydz-Śmigły Park", "park"),
    "Metropolitan": ("Metropolitan", None, "office building"),
    "Rondo ONZ (metro)": ("Rondo ONZ", None, "metro station"),
    "Park Świętokrzyski": ("Park Świętokrzyski", "Świętokrzyski Park", "park"),
    "Wiadukt Markiewicza": ("Wiadukt Markiewicza", "Markiewicz Viaduct", "viaduct"),
    "Central Point": ("Central Point", None, "office tower"),
    "The Westin": ("The Westin", None, "hotel"),
    "Zielona Złota": ("Zielona Złota", "Green Złota Street", "street greening"),
    "Domki Fińskie": ("Domki Fińskie", "Finnish Houses", "wooden houses"),
    "Ambasada USA": ("Ambasada USA", "US Embassy", "embassy"),
    "Kościół św. Barbary": ("Kościół św. Barbary", "St Barbara's Church", "church"),
    "Hala Gwardii": ("Hala Gwardii", "Gwardia Hall", "market hall"),
    "Pałac Kazimierzowski": ("Pałac Kazimierzowski", "Kazimierz Palace", "palace"),
    "Mur getta": ("Mur getta", "Ghetto Wall", "ruin"),
    "Teatr IMKA": ("Teatr IMKA", "IMKA Theatre", "theatre"),
    "Teatr Kwadrat": ("Teatr Kwadrat", "Kwadrat Theatre", "theatre"),
    "Pałac Sobańskich": ("Pałac Sobańskich", "Sobański Palace", "palace"),
    "Pałac Zamoyskich": ("Pałac Zamoyskich", "Zamoyski Palace", "palace"),
    "Pomnik Ofiar Katastrofy Smoleńskiej": ("Pomnik Ofiar Tragedii Smoleńskiej", "Smolensk Air Crash Memorial", "monument"),
    "Teatr Capitol": ("Teatr Capitol", "Capitol Theatre", "theatre"),
    "Pałac Przezdzieckich": ("Pałac Przezdzieckich", "Przeździecki Palace", "palace"),
    "Pomnik Adama Mickiewicza": ("Pomnik Adama Mickiewicza", "Mickiewicz Monument", "monument"),
    "Riviera": ("Riviera", None, "student dormitory"),
    "Dom Chłopa": ("Dom Chłopa", None, "hotel"),
    "Pałac Tyszkiewiczów": ("Pałac Tyszkiewiczów", "Tyszkiewicz Palace", "palace"),
    "Warszawa Śródmieście WKD": ("Warszawa Śródmieście WKD", None, "railway station"),
    "Pawilon Cepelii": ("Pawilon Cepelii", "Cepelia Pavilion", "shop"),
    "Teatr Sabat": ("Teatr Sabat", "Sabat Theatre", "theatre"),
    "Pomnik Kościuszkowców": ("Pomnik Kościuszkowców", "Kościuszko Division Monument", "monument"),
    "Elizeum": ("Elizeum", "Elysium Grotto", "grotto"),
    "Fotoplastikon Warszawski": ("Fotoplastikon", None, "museum"),
    "Nobu Hotel Warsaw": ("Hotel Nobu", None, "hotel"),
    "Willa Pniewskiego": ("Willa Pniewskiego", "Pniewski Villa", "villa"),
    "Muzeum Techniki": ("Muzeum Techniki", "Museum of Technology", "museum"),
    "Biblioteka Krasińskich": ("Biblioteka Krasińskich", "Krasiński Library", "library"),
    "Auditorium Maximum": ("Auditorium Maximum", None, "lecture hall"),
    "Muzeum Ewolucji PAN": ("Muzeum Ewolucji", "Museum of Evolution", "museum"),
    "Pomnik Józefa Piłsudskiego": ("Pomnik Józefa Piłsudskiego", "Piłsudski Monument", "monument"),
    "Plac Na Rozdrożu": ("Plac Na Rozdrożu", "Crossroads Square", "square"),
    "Gmach Giełdy i Banku Polskiego": ("Gmach Giełdy i Banku Polskiego", "Bank of Poland Building", "office building"),
    "Warszawa Stadion": ("Warszawa Stadion", None, "railway station"),
    "Pomnik Lecha Kaczyńskiego": ("Pomnik Lecha Kaczyńskiego", "Lech Kaczyński Monument", "monument"),
    "Warszawa Powiśle": ("Warszawa Powiśle", None, "railway station"),
    "Teatr Polonia": ("Teatr Polonia", "Polonia Theatre", "theatre"),
    "PZU Tower": ("PZU Tower", None, "office tower"),
    "Pomnik Chwała Saperom": ("Pomnik Chwała Saperom", "Glory to the Sappers Monument", "monument"),
    "Hotel MDM": ("Hotel MDM", None, "hotel"),
    "Plac Dąbrowskiego": ("Plac Dąbrowskiego", "Dąbrowski Square", "square"),
    "Kino Atlantic": ("Kino Atlantic", "Atlantic Cinema", "cinema"),
    "Kościół św. Karola Boromeusza": ("Kościół św. Karola Boromeusza", "St Charles Borromeo Church", "church"),
    "Biały Pałacyk na Frascati": ("Biały Pałacyk na Frascati", "White Palace", "palace"),
    "Widok Towers": ("Widok Towers", None, "office tower"),
    "Pomnik Armii Krajowej": ("Pomnik Armii Krajowej", "Home Army Monument", "monument"),
    "Pałacyk Rembielińskiego": ("Pałacyk Rembielińskiego", "Rembieliński Palace", "palace"),
    "Kino Palladium": ("Kino Palladium", "Palladium Cinema", "cinema"),
    "Dom Pod Orłami": ("Dom pod Orłami", "House under the Eagles", "office building"),
    "Pomnik Jazdy Polskiej": ("Pomnik Jazdy Polskiej", "Polish Cavalry Monument", "monument"),
    "Pomnik Tadeusza Kościuszki": ("Pomnik Tadeusza Kościuszki", "Kościuszko Monument", "monument"),
    "Teatr Lalka": ("Teatr Lalka", "Lalka Puppet Theatre", "theatre"),
    "Muzeum Azji i Pacyfiku": ("Muzeum Azji i Pacyfiku", "Asia and Pacific Museum", "museum"),
    "Kamienica pod Gigantami": ("Kamienica pod Gigantami", "House under the Giants", "tenement house"),
    "Mercure Grand Hotel": ("Hotel Grand", None, "hotel"),
    "Zebra Tower": ("Zebra Tower", None, "office tower"),
    "Brama Uniwersytecka": ("Brama Uniwersytecka", "University Gate", "gate"),
    "Kinoteka": ("Kinoteka", None, "cinema"),
    "Kościół Res Sacra Miser": ("Kościół Res Sacra Miser", "Res Sacra Miser Church", "church"),
    "Centrum Pieniądza NBP": ("Centrum Pieniądza NBP", "NBP Money Centre", "museum"),
    "Galeria Foksal": ("Galeria Foksal", "Foksal Gallery", "gallery"),
    "Sheraton Warszawa": ("Hotel Sheraton", None, "hotel"),
    "Kościół Świętej Trójcy na Solcu": ("Kościół Świętej Trójcy na Solcu", "Holy Trinity Church", "church"),
    "Stadion Agrykola": ("Stadion Agrykola", "Agrykola Stadium", "stadium"),
    "Planetarium Niebo Kopernika": ("Planetarium Niebo Kopernika", "Copernicus Planetarium", "planetarium"),
    "Pomnik księcia Józefa Poniatowskiego": ("Pomnik Józefa Poniatowskiego", "Poniatowski Monument", "monument"),
    "Pomnik Mikołaja Kopernika": ("Pomnik Mikołaja Kopernika", "Copernicus Monument", "monument"),
    "Neon Muzeum": ("Neon Muzeum", "Neon Museum", "museum"),
    "Pałac Karasia": ("Pałac Karasia", "Karaś Palace", "palace"),
    "Pałac Uruskich": ("Pałac Uruskich", "Uruski Palace", "palace"),
    "Salonik Chopinów": ("Salonik Chopinów", "Chopin Family Parlour", "museum"),
    "Muzeum Ziemi PAN": ("Muzeum Ziemi", "Museum of the Earth", "museum"),
}


def site_of(e, tags=None):
    tags = tags or {}
    url = e.get("site") or tags.get("website") or tags.get("contact:website")
    if not url and (e.get("facebook") or tags.get("contact:facebook")):
        fb = e.get("facebook") or tags["contact:facebook"]
        url = fb if fb.startswith("http") else f"https://www.facebook.com/{fb}"
    return url


def buildings(osm):
    polys = [(t, p) for _, _, t, p in osm.areas if "building" in t]
    return polys, STRtree([p for _, p in polys])


def anchor(pt, polys, tree):
    hits = [i for i in tree.query(pt.buffer(25)) if polys[i][1].distance(pt) < 25]
    if not hits:
        return None, {}
    i = min(hits, key=lambda i: (polys[i][1].distance(pt), polys[i][1].area))
    return polys[i][1], polys[i][0]


def standalone(tags):
    """a point that is the thing itself (a statue, a station, a fountain), not a door into a building"""
    return any(k in tags for k in ("historic", "memorial", "artwork_type", "railway", "public_transport", "highway", "place",
                                   "leisure", "natural", "man_made")) or tags.get("tourism") in ("artwork", "viewpoint") \
        or tags.get("amenity") in ("fountain", "clock")


def roof_height(labels, osm, top_at):
    """a curated label anchored at the top stands at the highest point of its whole outline: the LiDAR's highest
    point can be one the model rebuilt lower (PGE Narodowy's spire over the pitch, the roof ring at 78 m)"""
    from rasterio.features import rasterize
    from affine import Affine
    tops = {f.get("name", n): n for n, f in landmarks.LABELS.items() if f.get("anchor") == "top" and not n.startswith("Most ")}
    for l in labels:
        n = tops.get(l["name"])
        geoms = [geom for _, _, t, geom in osm.areas if n and t.get("name") == n]
        if not geoms:
            continue
        gm = max(geoms, key=lambda q: q.area)
        c0, r0, c1, r1 = (int(v) for v in gm.bounds)
        c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1, W - 1), min(r1, D - 1)
        m = rasterize([(gm, 1)], out_shape=(r1 - r0 + 1, c1 - c0 + 1), transform=Affine.translation(c0, r0)).astype(bool)
        l["z"] = max(l["z"], max(top_at(r0 + r, c0 + c) for r, c in zip(*np.nonzero(m))))


def cells(gm):
    from rasterio.features import rasterize
    from affine import Affine
    c0, r0, c1, r1 = (int(v) for v in gm.bounds)
    c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1, W - 1), min(r1, D - 1)
    if c1 < c0 or r1 < r0:
        return np.zeros(0, int), np.zeros(0, int)
    m = rasterize([(gm, 1)], out_shape=(r1 - r0 + 1, c1 - c0 + 1), transform=Affine.translation(c0, r0))
    rr, cc = np.nonzero(m)
    return rr + r0, cc + c0


def settle(p, poly, top_at, own=False):
    """a label on a building: on its own tower if one rises 20 m over the spot within 50 m (PZU Tower's podium), and
    out of an open courtyard (or off the pavement at the door) onto the nearest roof"""
    rr, cc = cells(poly)
    if not len(rr):
        return p
    t = np.array([top_at(r, c) for r, c in zip(rr, cc)])
    t0 = top_at(int(p.y), int(p.x))
    k = int(np.argmax(t))
    if own and t[k] - t0 >= 20 and np.hypot(cc[k] - p.x, rr[k] - p.y) < 50 and (t >= t0 + 15).mean() > 0.15:
        return Point(cc[k] + 0.5, rr[k] + 0.5)
    r0, c0 = int(p.y), int(p.x)
    win = [(r, c) for r in range(max(r0 - 30, 0), min(r0 + 31, D), 3) for c in range(max(c0 - 30, 0), min(c0 + 31, W), 3)]
    if t0 > min(top_at(r, c) for r, c in win) + 5:  # on a roof already, however low
        return p
    near = [(r, c) for r in range(max(r0 - 15, 0), min(r0 + 16, D)) for c in range(max(c0 - 15, 0), min(c0 + 16, W))]
    for rs, cs in ((rr, cc), (np.array([q[0] for q in near]), np.array([q[1] for q in near]))):  # in the outline, else around
        tt = t if rs is rr else np.array([top_at(r, c) for r, c in near])
        roof = tt >= t0 + 6
        if roof.any():
            k = int(np.argmin(np.where(roof, np.hypot(cs - p.x, rs - p.y), np.inf)))
            return Point(cs[k] + 0.5, rs[k] + 0.5)
    return p


def tagged(osm):
    """the OSM objects carrying a Wikidata id: (tags, geometry) by qid"""
    out = {}
    for src in (osm.areas, osm.nodes, osm.lines):
        for item in src:
            t, g = item[-2], item[-1]
            if t.get("wikidata"):
                out.setdefault(t["wikidata"], []).append((t, g))
    return out


def notable(osm, curated_qids, top_at):
    """Where the place is: the OSM object tagged with its Wikidata id (Wikidata's own point is often the whole
    complex's -- every museum and theatre in PKiN on one spot -- or an old address; a statue snapped to the nearest
    building landed on its roof); else Wikidata's point, on the building it falls in or next to."""
    wd = json.loads(NOTABLE.read_text())
    polys, tree = buildings(osm)
    by_q = tagged(osm)
    out = []
    for qid, pick in PICKS.items():
        e = wd[qid]
        pt = Point(to_grid(*e["at"]))
        own = [(t, g) for t, g in by_q.get(qid, []) if 0 <= g.centroid.x < W and 0 <= g.centroid.y < D]
        if qid in curated_qids or not (own or (0 <= pt.x < W and 0 <= pt.y < D)):
            continue
        if own:
            tags, g = min(own, key=lambda tg: tg[1].distance(pt))
            if g.geom_type == "Point" or (g.geom_type == "LineString" and g.length > 0):
                p = g if g.geom_type == "Point" else g.interpolate(0.5, normalized=True)
                if g.geom_type == "Point" and not standalone(tags):  # a hotel's or museum's point is often its door
                    poly, _ = anchor(p, polys, tree)
                    if poly is not None:
                        p = settle(p, poly, top_at)
            else:  # an area (a square, a park, a building): Wikidata's point if it lies in it, more central than any
                p = pt if g.contains(pt) else g.representative_point()
                roof = lambda q: any(polys[i][1].contains(q) for i in tree.query(q))
                if "building" not in tags and roof(p) and not roof(pt) and g.distance(pt) < 300:
                    p = pt  # an open place whose outline takes in the buildings on it (Plac Defilad and PKiN)
                if "building" in tags and not standalone(tags):
                    p = settle(p, g, top_at, own=True)
        else:
            poly, tags = anchor(pt, polys, tree)
            p = poly.representative_point() if poly is not None and not poly.contains(pt) else pt
            if not any(w in pick["kind"] for w in ("monument", "statue", "memorial", "artwork", "square", "park", "fountain", "garden")):
                p = settle(p, poly if poly is not None else pt.buffer(2), top_at)
        r, c = int(p.y), int(p.x)
        name = pick.get("name") or IN_WARSAW.sub("", e["pl"])
        name = name[0].upper() + name[1:]
        en = pick["en"] if "en" in pick else IN_WARSAW.sub("", e["en"] or "")
        en = en if en and not en.lower().startswith(name.lower()) else None
        out.append(dict(name=name, en=en, kind=pick["kind"],
                        views=e["views"], building=pick.get("building"),
                        site=pick["site"] if "site" in pick else site_of(e, tags if tags.get("wikidata") == qid else {}), alt=" ".join(filter(None, [e["pl"], e["en"], pick.get("alt")])),
                        auto=True, x=c, y=r, z=top_at(r, c)))
    return out


def curated_wikidata(osm, wd):
    shown = {n: f.get("name", n) for n, f in {**landmarks.LABELS, **landmarks.EXTRA_LABELS}.items()}
    qids = {shown[t["name"]]: t["wikidata"] for src in (osm.areas, osm.nodes, osm.lines) for *_, t, _ in src
            if t.get("name") in shown and t.get("wikidata") in wd}
    for q, e in wd.items():
        if e["pl"] in shown.values():
            qids.setdefault(e["pl"], q)
    return set(qids.values()), {n: wd[q]["views"] for n, q in qids.items()}, {n: site_of(wd[q]) for n, q in qids.items()}


def finish(labels, curated_views, curated_sites):
    key = lambda l: f'{l["name"]} (metro)' if l["kind"] == "metro station" else l["name"]
    for l in labels:
        if key(l) in NAMES:
            pl, en, kind = NAMES[key(l)]
            l["alt"] = " ".join(filter(None, [l["name"] if pl != l["name"] else "", l.get("en"), l.get("alt")]))
            l.update(name=pl, en=en, kind=kind)
        if not l.get("auto") and "site" not in l:
            l["site"] = curated_sites.get(l["name"])
        l["site"] = l.get("site") or SITES.get(l["name"])
        v = curated_views.get(l["name"], 0)
        l["far"] = FAR.get(key(l)) or l.get("far")
        l.setdefault("views", v)
    missing = [l["name"] for l in labels if not l["far"]]
    assert not missing, f"no distance for {missing}: add them to FAR_TIERS"
    labels.sort(key=lambda l: (-l["far"], -l["views"]))
    kept = []
    for l in labels:
        if not l.get("auto") or all((l["x"] - k["x"]) ** 2 + (l["y"] - k["y"]) ** 2 > 15 ** 2 for k in kept):
            kept.append(l)
    labels[:] = kept
    for l in labels:
        l.pop("views")
        l.pop("auto", None)
        for k in [k for k, v in l.items() if v is None]:
            del l[k]
    return labels


def assemble(curated, osm, top_at):
    curated = list(curated)
    for facts, poly in landmarks.jazdow_houses(osm):
        p = poly.representative_point()
        curated.append(dict(facts, x=int(p.x), y=int(p.y), z=top_at(int(p.y), int(p.x))))
    wd = json.loads(NOTABLE.read_text())
    qids, views, sites = curated_wikidata(osm, wd)
    roof_height(curated, osm, top_at)
    return finish(curated + notable(osm, qids, top_at), views, sites)


def radii(labels, g, abs_top):
    """Footprint radius: the viewer hides a label only when something *else* is in the way."""
    for l in labels:
        r, c = int(l["y"]), int(l["x"])
        gg = int(g[min(max(r, 0), D - 1), min(max(c, 0), W - 1)])
        l["g"] = gg
        thr = gg + max(6, (l["z"] - gg) * 0.4)
        r0, r1, c0, c1 = max(r - 220, 0), min(r + 221, D), max(c - 220, 0), min(c + 221, W)
        lab_, _ = ndimage.label(abs_top[r0:r1, c0:c1] >= thr)
        k = lab_[r - r0, c - c0] if (0 <= r - r0 < lab_.shape[0] and 0 <= c - c0 < lab_.shape[1]) else 0
        if k:
            rr_, cc_ = np.nonzero(lab_ == k)
            l["R"] = round(float(np.hypot(rr_ + r0 - r, cc_ + c0 - c).max()), 1)
        else:
            l["R"] = 0.0


if __name__ == "__main__":
    from osm import OSM
    osm = OSM()
    top = np.load("data/cache/final_top.npy")
    g = np.load("data/cache/final_g.npy")
    top_at = lambda r, c: int(top[r, c])
    meta = json.loads(META.read_text())
    keep = set(landmarks.LABELS) | {f.get("name") for f in landmarks.LABELS.values()} | set(landmarks.EXTRA_LABELS) \
        | {o["label"]["name"] for o in landmarks.OVERRIDES.values() if "label" in o}
    curated = []
    for l in meta["labels"]:
        if l["name"] in keep:
            src = next((f for n, f in {**landmarks.LABELS, **landmarks.EXTRA_LABELS}.items() if l["name"] in (n, f.get("name"))), {})
            curated.append({**{k: v for k, v in l.items() if k not in ("g", "R", "far")}, **{k: src[k] for k in ("site", "far", "kind", "alt", "en") if k in src}})
    labels = assemble(curated, osm, top_at)
    radii(labels, g, top)
    meta["labels"] = labels
    META.write_text(json.dumps(meta))
    print(len(labels), "labels;", {f: sum(l["far"] == f for l in labels) for f in sorted({l["far"] for l in labels})})
