"""Night photos of Warsaw from Wikimedia Commons with the time they were taken, to measure how many windows are lit,
by building type, hour, weekday and season.

Walks Category:Night in Warsaw (and its subcategories), keeps photos whose EXIF time puts the sun below -4°, downloads
1600 px copies to data/raw/window_photos/ and lists them in scripts/window_photos.json.
"""
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from aoi import RAW
from notable import UA, get

ROOT = "Category:Night in Warsaw"
DIR = Path(RAW) / "window_photos"
OUT = Path(__file__).with_name("window_photos.json")
API = "https://commons.wikimedia.org/w/api.php"
WAW = ZoneInfo("Europe/Warsaw")


def sun_elevation(t):
    """NOAA approximation for central Warsaw; t is timezone-aware."""
    import math
    u = t.astimezone(ZoneInfo("UTC"))
    doy = u.timetuple().tm_yday
    g = 2 * math.pi / 365 * (doy - 1 + (u.hour - 12) / 24)
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) \
        + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g)
                    - 0.040849 * math.sin(2 * g))
    tst = u.hour * 60 + u.minute + eqt + 4 * 21.01
    ha = math.radians(tst / 4 - 180)
    lat = math.radians(52.23)
    return math.degrees(math.asin(math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)))


def members(cat, kind):
    out, cont = [], {}
    while True:
        q = dict(action="query", list="categorymembers", cmtitle=cat, cmtype=kind, cmlimit=500, format="json", **cont)
        res = get(f"{API}?{urllib.parse.urlencode(q)}")
        out += [m["title"] for m in res["query"]["categorymembers"]]
        if "continue" not in res:
            return out
        cont = res["continue"]


def walk(root, depth=3):
    files, seen, todo = set(), set(), [(root, 0)]
    while todo:
        cat, d = todo.pop()
        if cat in seen:
            continue
        seen.add(cat)
        files.update(members(cat, "file"))
        if d < depth:
            todo += [(c, d + 1) for c in members(cat, "subcat")]
    return sorted(files), sorted(seen)


def info(titles):
    out = {}
    for k in range(0, len(titles), 50):
        q = dict(action="query", prop="imageinfo", titles="|".join(titles[k:k + 50]), iiprop="url|commonmetadata|extmetadata",
                 iiurlwidth=1600, format="json")
        res = get(f"{API}?{urllib.parse.urlencode(q)}")
        for p in res["query"]["pages"].values():
            ii = (p.get("imageinfo") or [{}])[0]
            meta = {m["name"]: m["value"] for m in ii.get("commonmetadata", [])}
            ext = ii.get("extmetadata", {})
            out[p["title"]] = dict(thumb=ii.get("thumburl"), page=ii.get("descriptionurl"),
                                   exif=meta.get("DateTimeOriginal"), desc=(ext.get("ImageDescription") or {}).get("value", "")[:300],
                                   cats=(ext.get("Categories") or {}).get("value", ""),
                                   artist=(ext.get("Artist") or {}).get("value", "")[:120],
                                   license=(ext.get("LicenseShortName") or {}).get("value", ""))
        time.sleep(0.3)
    return out


def taken(exif):
    try:
        return datetime.strptime(str(exif)[:19], "%Y:%m:%d %H:%M:%S").replace(tzinfo=WAW)
    except ValueError:
        return None


def main():
    files, cats = walk(ROOT)
    print(len(files), "files in", len(cats), "categories")
    meta = info([f for f in files if f.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"))])
    DIR.mkdir(parents=True, exist_ok=True)
    keep = []
    for title, m in meta.items():
        t = taken(m["exif"])
        if not t or not m["thumb"] or t.year < 2005:
            continue
        el = sun_elevation(t)
        if el > -4:
            continue
        path = DIR / f"{len(keep):04d}.jpg"
        if not path.exists():
            req = urllib.request.Request(m["thumb"], headers=UA)
            path.write_bytes(urllib.request.urlopen(req, timeout=60).read())
            time.sleep(0.2)
        keep.append(dict(file=path.name, title=title, taken=t.isoformat(), weekday=t.strftime("%a"), sun=round(el, 1), **m))
    OUT.write_text(json.dumps(keep, ensure_ascii=False, indent=1))
    print(len(keep), "night photos with a time")


if __name__ == "__main__":
    main()
