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
TIERS = [(100_000, 9000), (40_000, 5000), (12_000, 1800), (4_000, 900), (0, 400)]
TALL = 150
IN_WARSAW = re.compile(r",?\s+(in|w)\s+(Warsaw|Warszawie)\b.*$|,\s*Warsaw$|\s*\((Śródmieście|Powiśle|Wola|Nowy Świat)\)$", re.I)

# chosen by hand from the ~420 most read items on the map (not events, organisations, streets, lost buildings or
# things inside a labelled building); without far, it comes from page views
P = dict
PICKS = {
    "Q144488": P(kind="university"),
    "Q1540926": P(kind="monument", far=1800),
    "Q608932": P(kind="presidential palace", site="https://www.prezydent.pl"),
    "Q1440735": P(name="Kościół Świętego Krzyża", kind="church", alt="bazylika Chopin heart serce Chopina"),
    "Q153306": P(kind="museum"),
    "Q821342": P(kind="hotel", far=1800),
    "Q3044701": P(name="Torwar", kind="arena"),
    "Q1872860": P(kind="palace"),
    "Q2691064": P(kind="theatre", far=1800),
    "Q2374346": P(name="Palma", kind="artwork", far=1800),
    "Q1630844": P(kind="hotel", far=1800),
    "Q821379": P(name="PAST-a", en="PAST building", kind="telephone exchange, 1910"),
    "Q929269": P(name="Plac Piłsudskiego", kind="square", far=1800),
    "Q806604": P(name="Dom Partii", en="former Communist Party HQ", kind="office building", far=1800),
    "Q1324986": P(kind="hotel"),
    "Q11698038": P(kind="concert hall"),
    "Q1340262": P(kind="music university", far=1800),
    "Q1627287": P(kind="square", far=1800),
    "Q47501099": P(name="Syrenka", en="Warsaw Mermaid", kind="monument", far=1800),
    "Q1683191": P(kind="monument", far=900),
    "Q2320937": P(kind="railway station", far=1800),
    "Q1756534": P(kind="castle, contemporary art centre", alt="CSW Centrum Sztuki Współczesnej", site="https://u-jazdowski.pl"),
    "Q7134098": P(kind="square"),
    "Q1149220": P(kind="palace, Academy of Fine Arts", alt="ASP Akademia Sztuk Pięknych"),
    "Q33545722": P(name="Hale Mirowskie", kind="market halls"),
    "Q247799": P(kind="skyscraper"),
    "Q156555": P(kind="palace, Academy of Sciences", alt="PAN Polska Akademia Nauk"),
    "Q9347384": P(kind="theatre"),
    "Q1351448": P(kind="church"),
    "Q3354467": P(kind="church"),
    "Q2915221": P(name="Synagoga Nożyków", kind="synagogue", far=1800),
    "Q3671990": P(kind="monument", far=900),
    "Q1095476": P(kind="palace, university rectorate", far=400),
    "Q9356010": P(name="Teatr Ateneum", kind="theatre"),
    "Q3527543": P(name="Teatr Polski", kind="theatre"),
    "Q11819218": P(kind="square"),
    "Q23817368": P(name="Kładka pieszo-rowerowa", en="Vistula footbridge", kind="footbridge, 2024", far=1800),
    "Q444092": P(kind="museum, former Gestapo prison", far=900),
    "Q8123476": P(name="Mur getta", kind="ghetto wall", far=400),
    "Q4569133": P(name="Kościół Karmelitów", kind="church"),
    "Q9356099": P(name="Teatr Roma", kind="musical theatre"),
    "Q882672": P(kind="palace"),
    "Q376942": P(name="Kościół Świętej Trójcy", kind="Lutheran church", far=1800),
    "Q3692546": P(kind="museum", alt="Zamek Ostrogskich Ostrogski Palace"),
    "Q638910": P(kind="metro station", far=900),
    "Q638914": P(kind="metro station", far=900),
    "Q9183918": P(kind="metro station", far=900),
    "Q639024": P(kind="metro station", far=900),
    "Q7365568": P(kind="metro station", far=900),
    "Q9183919": P(kind="metro station", far=900),
    "Q7596321": P(kind="metro station", far=900),
    "Q638861": P(kind="metro station", far=900),
    "Q5117878": P(kind="church", far=1800),
    "Q387041": P(kind="1960s shopping frontage", far=900),
    "Q1236560": P(name="Smyk", kind="department store, 1951", alt="CDT Centralny Dom Towarowy", site=""),
    "Q7970920": P(kind="square"),
    "Q1933198": P(kind="skyscraper"),
    "Q1326654": P(kind="hotel"),
    "Q21020336": P(kind="theatre", far=400),
    "Q111650304": P(kind="hotel"),
    "Q2892963": P(kind="theatre"),
    "Q6110328": P(kind="department store, 1914"),
    "Q9356053": P(kind="theatre", far=400),
    "Q62050970": P(kind="skyscraper"),
    "Q11745958": P(kind="church", far=1800),
    "Q1629484": P(kind="palace, Ministry of Culture"),
    "Q2296393": P(kind="palace", far=400),
    "Q11785957": P(kind="bridge", far=1800),
    "Q11819052": P(kind="square"),
    "Q145920": P(kind="palace", far=400),
    "Q55337700": P(kind="museum", building=True),
    "Q51727465": P(kind="monument", far=400),
    "Q16610004": P(kind="theatre", far=400),
    "Q9377639": P(kind="department store"),
    "Q1567828": P(kind="former river port, new quarter"),
    "Q2114578": P(kind="palace", far=400),
    "Q3390703": P(kind="square"),
    "Q652788": P(kind="square"),
    "Q348386": P(kind="monument", far=400),
    "Q9209422": P(name="Riviera", kind="student dormitory", far=400),
    "Q762533": P(kind="skyscraper"),
    "Q3134741": P(kind="park", far=1800, site="https://eko.um.warszawa.pl/-/park-ujazdowski"),
    "Q30905825": P(kind="hotel", far=400),
    "Q2463480": P(kind="palace", far=400),
    "Q2755236": P(kind="railway station", far=400),
    "Q60222434": P(name="Pawilon Cepelii", kind="modernist pavilion", far=400),
    "Q131914521": P(kind="office tower"),
    "Q28674017": P(kind="square", far=900),
    "Q9356150": P(kind="theatre", far=400),
    "Q11823305": P(kind="monument", far=400),
    "Q9252875": P(kind="18th-century grotto", far=400),
    "Q9261973": P(kind="museum", far=400),
    "Q11746537": P(kind="church"),
    "Q116355": P(kind="hotel", far=400),
    "Q9374715": P(kind="villa, museum", far=400),
    "Q961766": P(kind="museum"),
    "Q11790623": P(kind="museum", far=400),
    "Q11785962": P(kind="railway bridge", far=1800),
    "Q1729038": P(kind="palace", far=400),
    "Q11811404": P(name="Park Rydza-Śmigłego", kind="park"),
    "Q6941029": P(kind="museum", far=400),
    "Q6436189": P(kind="library", far=400),
    "Q11778109": P(kind="office building"),
    "Q9161880": P(name="Auditorium Maximum", kind="university hall", far=400),
    "Q6940852": P(kind="museum", far=400),
    "Q11823282": P(kind="monument", far=400),
    "Q11819117": P(kind="square", far=400),
    "Q1497347": P(kind="historic bank building", far=400),
    "Q2579655": P(kind="railway station"),
    "Q56328837": P(name="Pomnik Lecha Kaczyńskiego", kind="monument", far=400),
    "Q3276715": P(kind="railway station"),
    "Q2502215": P(kind="palace", far=400),
    "Q9356126": P(kind="theatre", far=400),
    "Q2044934": P(kind="office tower"),
    "Q5104833": P(kind="museum", far=400),
    "Q11823163": P(kind="monument", far=400),
    "Q1630955": P(kind="hotel", far=400),
    "Q11819068": P(name="Plac Dąbrowskiego", kind="square", far=400),
    "Q4816262": P(name="Kino Atlantic", kind="cinema", far=400),
    "Q11746975": P(name="Kościół św. Karola Boromeusza", kind="church", far=400),
    "Q1451309": P(kind="palace", far=400),
    "Q61989411": P(kind="office towers"),
    "Q11823410": P(name="Pomnik Armii Krajowej", kind="monument", far=400),
    "Q1820898": P(kind="palace", far=400),
    "Q11739380": P(kind="cinema", far=400),
    "Q9209364": P(kind="historic office building", far=400),
    "Q11823261": P(kind="monument", far=400),
    "Q2331260": P(name="Wiadukt Markiewicza", kind="viaduct", far=900),
    "Q11823485": P(kind="monument", far=400),
    "Q66763567": P(kind="puppet theatre", far=400),
    "Q3893223": P(kind="museum", far=400),
    "Q11734224": P(kind="tenement house", far=400),
    "Q1954543": P(kind="museum", far=400),
    "Q1542586": P(kind="hotel", far=400),
    "Q9389950": P(kind="office tower"),
    "Q9178743": P(name="Brama Uniwersytecka", kind="gate", far=400),
    "Q20032546": P(kind="cinema", far=400),
    "Q11745622": P(name="Kościół Res Sacra Miser", kind="church", far=400),
    "Q29158537": P(name="Centrum Pieniądza NBP", en="NBP Money Centre", kind="museum", far=400),
    "Q2278233": P(kind="hotel", far=400),
    "Q11746364": P(name="Kościół Świętej Trójcy na Solcu", kind="church", far=400),
    "Q5464222": P(kind="gallery", far=400),
    "Q111671660": P(name="Ambasada USA", en="US Embassy", kind="embassy", far=900),
    "Q24945654": P(en="Planetarium", kind="planetarium", far=400),
    "Q110927707": P(name="Kościół św. Barbary", kind="church", far=900),
    "Q33545766": P(name="Hala Gwardii", en="", kind="market hall", far=900),
    "Q60862214": P(kind="stadium", far=400),
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


def far_of(views):
    return next(f for v, f in TIERS if views >= v)


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


def notable(osm, curated_qids, top_at):
    wd = json.loads(NOTABLE.read_text())
    polys, tree = buildings(osm)
    out = []
    for qid, pick in PICKS.items():
        e = wd[qid]
        pt = Point(to_grid(*e["at"]))
        if qid in curated_qids or not (0 <= pt.x < W and 0 <= pt.y < D):
            continue
        poly, tags = anchor(pt, polys, tree)
        p = poly.representative_point() if poly is not None and not poly.contains(pt) else pt
        r, c = int(p.y), int(p.x)
        name = pick.get("name") or IN_WARSAW.sub("", e["pl"])
        name = name[0].upper() + name[1:]
        en = pick["en"] if "en" in pick else IN_WARSAW.sub("", e["en"] or "")
        en = en if en and not en.lower().startswith(name.lower()) else None
        out.append(dict(name=name, en=en, kind=pick["kind"],
                        far=pick.get("far") or far_of(e["views"]), views=e["views"], building=pick.get("building"),
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
    for l in labels:
        if not l.get("auto") and "site" not in l:
            l["site"] = curated_sites.get(l["name"])
        l["site"] = l.get("site") or SITES.get(l["name"])
        v = curated_views.get(l["name"], 0)
        l.setdefault("far", max(far_of(v), 5000 if (l.get("height") or 0) >= TALL else 0))
        l.setdefault("views", v)
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
