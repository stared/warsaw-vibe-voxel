# list Commons files of a category (and a level of subcategories) with camera coords / heading / focal length
import sys, json, requests
UA = {"User-Agent": "warsaw-voxel-research/0.1 (piotr.migdal@quesma.com)"}
API = "https://commons.wikimedia.org/w/api.php"
def files(cat, limit=400):
    out, cont = [], {}
    while len(out) < limit:
        r = requests.get(API, headers=UA, params=dict(action="query", format="json", generator="categorymembers", gcmtitle="Category:" + cat,
            gcmtype="file", gcmlimit=50, prop="coordinates|imageinfo", coprop="type", iiprop="url|metadata|size", iiurlwidth=1280, **cont)).json()
        for p in r.get("query", {}).get("pages", {}).values():
            if "imageinfo" not in p: continue
            ii = p["imageinfo"][0]; md = {m["name"]: m["value"] for m in (ii.get("metadata") or []) if isinstance(m, dict)}
            co = (p.get("coordinates") or [{}])[0]
            out.append(dict(t=p["title"], lat=co.get("lat"), lon=co.get("lon"), dir=md.get("GPSImgDirection"), f35=md.get("FocalLengthIn35mmFilm"), date=md.get("DateTimeOriginal"), url=ii.get("thumburl"), w=ii["width"], h=ii["height"]))
        if "continue" not in r: break
        cont = {k: v for k, v in r["continue"].items()}
    return out
def subcats(cat):
    r = requests.get(API, headers=UA, params=dict(action="query", format="json", list="categorymembers", cmtitle="Category:" + cat, cmtype="subcat", cmlimit=100)).json()
    return [m["title"][9:] for m in r["query"]["categorymembers"]]
if __name__ == "__main__":
    cat = sys.argv[1]; res = files(cat)
    for s in subcats(cat)[:15]: res += files(s, 100)
    print(json.dumps(res))
