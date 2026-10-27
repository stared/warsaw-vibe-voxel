"""Every Wikidata item located on the map, with how much people read about it: Polish and English Wikipedia page
views from October 2025 to September 2026. Independent of whether OSM links to it.

Output data/raw/notable.json: {qid: {pl, en, desc, types, at: [lon, lat], plwiki, enwiki, wikis, views, site, facebook}}.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from pyproj import Transformer

from aoi import RAW, W, D, to_world

OUT = Path(RAW) / "notable.json"
UA = {"User-Agent": "warsaw-vibe-voxel/1.0 (https://github.com/stared/warsaw-vibe-voxel)"}
SPAN = "20251001/20260930"
SPARQL = """
SELECT ?item ?at ?pl ?en ?desc ?plwiki ?enwiki ?wikis ?site ?fb (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?at. bd:serviceParam wikibase:cornerSouthWest "Point(%f %f)"^^geo:wktLiteral;
                                                  wikibase:cornerNorthEast "Point(%f %f)"^^geo:wktLiteral. }
  ?item wikibase:sitelinks ?wikis.
  OPTIONAL { ?item rdfs:label ?pl FILTER(LANG(?pl) = "pl") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?plw schema:about ?item; schema:isPartOf <https://pl.wikipedia.org/>; schema:name ?plwiki }
  OPTIONAL { ?enw schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki }
  OPTIONAL { ?item wdt:P856 ?site }
  OPTIONAL { ?item wdt:P2013 ?fb }
  OPTIONAL { ?item wdt:P31 ?type. ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel) = "en") }
} GROUP BY ?item ?at ?pl ?en ?desc ?plwiki ?enwiki ?wikis ?site ?fb
"""


def get(url, data=None):
    for wait in (5, 20, 60, 120, 240):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            return json.load(urllib.request.urlopen(req, timeout=120))
        except urllib.error.HTTPError as err:
            if err.code not in (429, 503):
                raise
            time.sleep(int(err.headers.get("Retry-After") or wait))
    raise RuntimeError(f"rate-limited: {url[:80]}")


def bbox():
    xs, ys = to_world(np.array([0, W, W, 0]), np.array([0, 0, D, D]))
    lon, lat = Transformer.from_crs(2180, 4326, always_xy=True).transform(xs, ys)
    return lon.min(), lat.min(), lon.max(), lat.max()


def items():
    q = SPARQL % bbox()
    res = get("https://query.wikidata.org/sparql?format=json", urllib.parse.urlencode(dict(query=q)).encode())
    out = {}
    for b in res["results"]["bindings"]:
        v = {k: x["value"] for k, x in b.items()}
        qid = v["item"].rsplit("/", 1)[1]
        lon, lat = map(float, v["at"].removeprefix("Point(").rstrip(")").split())
        e = out.setdefault(qid, dict(pl=v.get("pl"), en=v.get("en"), desc=v.get("desc"), types=v.get("types", ""),
                                     at=[lon, lat], plwiki=v.get("plwiki"), enwiki=v.get("enwiki"), wikis=int(v["wikis"]),
                                     site=v.get("site"), facebook=v.get("fb")))
        e["site"] = e["site"] or v.get("site")
    return out


def views(lang, title):
    t = urllib.parse.quote(title.replace(" ", "_"), safe="")
    try:
        res = get(f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{lang}.wikipedia/all-access/user/{t}/monthly/{SPAN}")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return 0
        raise
    return sum(i["views"] for i in res["items"])


def pageviews(lang, titles):
    titles = sorted(set(titles))
    with ThreadPoolExecutor(4) as pool:
        return dict(zip(titles, pool.map(lambda t: views(lang, t), titles)))


def main():
    wd = items()
    print(len(wd), "items on the map")
    for lang in ("pl", "en"):
        pv = pageviews(lang, [e[f"{lang}wiki"] for e in wd.values() if e[f"{lang}wiki"]])
        for e in wd.values():
            e[f"views_{lang}"] = pv.get(e[f"{lang}wiki"], 0) if e[f"{lang}wiki"] else 0
    for e in wd.values():
        e["views"] = e["views_pl"] + e["views_en"]
    OUT.write_text(json.dumps(wd, ensure_ascii=False))
    for qid, e in sorted(wd.items(), key=lambda kv: -kv[1]["views"])[:40]:
        print(e["views"], e["pl"], "|", e["types"])


if __name__ == "__main__":
    main()
