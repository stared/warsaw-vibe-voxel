"""Wikidata for the OSM features that link to it: Polish and English names and the number of Wikipedia language
editions (sitelinks), a measure of how well known a place is.

Cached in data/raw/wikidata.json; run directly to fetch what is missing.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from aoi import RAW

CACHE = Path(RAW) / "wikidata.json"
API = "https://www.wikidata.org/w/api.php"


def claim(e, p):
    for c in e.get("claims", {}).get(p, []):
        if c.get("rank") != "deprecated" and (v := c["mainsnak"].get("datavalue", {}).get("value")):
            return v
    return None


def get(req):
    for wait in (5, 20, 60, 120):
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as err:
            if err.code != 429:
                raise
            time.sleep(int(err.headers.get("Retry-After") or wait))
    raise RuntimeError("Wikidata keeps rate-limiting")


def fetch(ids):
    known = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = sorted({i for i in ids if "site" not in known.get(i, {}) and i.startswith("Q")})
    for k in range(0, len(todo), 50):
        q = urllib.parse.urlencode(dict(action="wbgetentities", ids="|".join(todo[k:k + 50]), format="json",
                                        props="labels|sitelinks|descriptions|claims", languages="pl|en"))
        req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "warsaw-vibe-voxel/1.0 (https://github.com/stared/warsaw-vibe-voxel)"})
        for qid, e in get(req)["entities"].items():
            lab, desc = e.get("labels", {}), e.get("descriptions", {})
            known[qid] = dict(pl=lab.get("pl", {}).get("value"), en=lab.get("en", {}).get("value"),
                              en_desc=desc.get("en", {}).get("value"),
                              wikis=sum(s.endswith("wiki") and s not in ("commonswiki", "specieswiki") for s in e.get("sitelinks", {})),
                              instance=[c["mainsnak"].get("datavalue", {}).get("value", {}).get("id")
                                        for c in e.get("claims", {}).get("P31", [])],
                              at=next(([v["longitude"], v["latitude"]] for c in e.get("claims", {}).get("P625", [])
                                       if (v := c["mainsnak"].get("datavalue", {}).get("value"))), None),
                              site=claim(e, "P856"), facebook=claim(e, "P2013"), instagram=claim(e, "P2003"))
        CACHE.write_text(json.dumps(known, ensure_ascii=False))
        time.sleep(1)
    return known


if __name__ == "__main__":
    from osm import OSM
    osm = OSM()
    ids = [t["wikidata"] for src in (osm.areas, osm.nodes, osm.lines) for *_, t, _ in src if "wikidata" in t]
    wd = fetch(ids)
    print(len(wd), "entities")
