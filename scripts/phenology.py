"""When each kind of tree leafs out, colours and drops its leaves, from two open sources:

- the German Weather Service's phenological network (DWD, annual reporters, wild plants), stations east of 12.5° E
  (Brandenburg, Berlin, Saxony: the closest climate to Warsaw's in the network), 1995-2024. Phases: 4 leaf unfolding
  begins, 31 autumn colouring (half the leaves coloured), 32 leaf fall (half fallen); 61, 63, 64 the same for the larch.
  Per species the median day and the spread between trees in one year (station dates around that year's mean).
- iNaturalist's "Leaves" annotations (breaking buds, green, coloured) on research-grade-able observations in Poland,
  Germany, Czechia, Slovakia and Lithuania, per week of the year: for what the DWD does not record (Norway maple, lindens
  and poplars have no leaf or autumn series there, ash and robinia no autumn one). Colouring: the day coloured
  observations outnumber green ones; leaf-out: the mean day of breaking buds. Both shifted by their median offset from
  the DWD dates for the species both sources have. Leaf fall: colouring plus the DWD's median gap between the two.
A phase neither source gives takes the median over the classes.

Autumn colours: measured on Wikimedia Commons photos of each taxon's canopy, autumn and summer (scripts/foliage_photos.json:
the method, the photos, both medians). The sunlit half of the leaf pixels; the renderer keeps its own summer greens, so
all autumn colours are scaled by how much brighter those greens are than the photos' summer canopies (one factor, so
the taxa keep their brightness relative to each other).

Lawns through the year: dated Commons photos of Warsaw lawns (scripts/grass_photos.json), the median colour per month,
smoothed with its neighbours, at the renderer's brightness in summer; per month the factor on the palette's grass green.
Summer leaves: the photos' median summer canopy, as one factor on the renderer's greens, at the lawns' exposure (so
crowns keep their brightness relative to the grass under them).

Output: web/public/data/phenology.json (per class: dates, spread, source) and, with the trees' positions
(web/public/data/trees.json), web/public/data/foliage.bin: per 2 m cell the class of the tree whose crown it is in
(nearest trunk within 9 m), then a byte of that tree's index (so one tree turns as one), gzip.
"""
import gzip
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from aoi import D, RAW, W  # noqa: E402

DWD = "https://opendata.dwd.de/climate_environment/CDC"
WILD = f"{DWD}/observations_germany/phenology/annual_reporters/wild/historical"
INAT = ("https://api.inaturalist.org/v1/observations/histogram?place_id=7800,7207,8264,8267,8266&term_id=36&term_value_id={v}"
        "&taxon_id={t}&date_field=observed&interval=week_of_year&verifiable=true")
CACHE = Path(RAW) / "dwd"
YEARS = (1995, 2024)
OUT = Path(__file__).parent.parent / "web/public/data"
PHASES = ("leaf", "colour", "fall")
PHOTOS = Path(__file__).parent / "foliage_photos.json"
LAWNS = Path(__file__).parent / "grass_photos.json"
GRASS = "#86b45a"
# the crowns' summer greens (LEAVES in voxelize.py)
GREENS = ["#a3c65c", "#8db552", "#76a24a", "#618f43", "#4f7c3c", "#93bb6a", "#7da95f", "#689655", "#56834c", "#456f43"]

# class: (DWD species file, iNaturalist taxon id, genera it stands for). 0 = no tree here.
# PHOTO_CLASS: the class in foliage_photos.json measured for it
PHOTO_CLASS = {1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "7", 7: "8", 8: "9", 9: "10", 10: "11", 11: "12", 12: "13", 15: "6"}
CLASSES = {
    1: ("Spitz-Ahorn", 54763, ["Acer"]),
    2: ("Sommer-Linde", 54856, ["Tilia"]),
    3: ("Esche", 125440, ["Fraxinus"]),
    4: ("Robinie", 56088, ["Robinia", "Gleditsia"]),
    5: ("Stiel-Eiche", 1520309, ["Quercus"]),
    6: ("Rosskastanie", 84298, ["Aesculus"]),
    7: ("Rotbuche", 55801, ["Fagus", "Carpinus"]),
    8: ("Haenge-Birke", 83992, ["Betula"]),
    9: ("Eberesche", 56063, ["Sorbus"]),
    10: ("Europaeische-Laerche", 59747, ["Larix"]),
    11: ("Sal-Weide", 53453, ["Salix"]),
    12: ("Schwarz-Erle", 966205, ["Alnus"]),
    15: (None, 47566, ["Populus"]),
}
OTHER, EVERGREEN = 13, 14  # deciduous trees with no series of their own (Prunus, Malus, Ulmus, Platanus, ...); conifers
PHASE = {4: "leaf", 61: "leaf", 31: "colour", 63: "colour", 32: "fall", 64: "fall"}
CONIFERS = {"Picea", "Pinus", "Thuja", "Taxus", "Pseudotsuga", "Abies", "Juniperus", "Chamaecyparis", "Tsuga", "Cupressocyparis"}
# Mapa Koron Drzew species groups (Polish) for crowns with no inventory tree
CROWN_SP = {"lipa": 2, "klon": 1, "jesion": 3, "robinia": 4, "dąb": 5, "kasztanowiec": 6, "grab": 7, "buk": 7, "brzoza": 8,
            "jarząb": 9, "modrzew": 10, "wierzba": 11, "olsza": 12, "topola": 15, "świerk": EVERGREEN, "sosna": EVERGREEN,
            "żywotnik": EVERGREEN}


def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print("download", url)
        urllib.request.urlretrieve(url, path)
    return path


def species_file(name):
    index = urllib.request.urlopen(f"{WILD}/").read().decode()
    first, last = sorted(re.findall(rf"PH_Jahresmelder_Wildwachsende_Pflanze_{name}_(\d+)_(\d+)_hist\.txt", index), key=lambda m: m[1])[-1]
    return f"PH_Jahresmelder_Wildwachsende_Pflanze_{name}_{first}_{last}_hist.txt"


def stations_east():
    p = fetch(f"{DWD}/help/PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt", CACHE / "stations.txt")
    keep = set()
    for line in p.read_text(encoding="latin1").splitlines()[1:]:
        f = [x.strip() for x in line.split(";")]
        if len(f) > 3 and f[2] and float(f[3]) > 12.5:
            keep.add(int(f[0]))
    return keep


def dwd(name, east):
    p = CACHE / f"{name}.txt"
    if not p.exists():
        fetch(f"{WILD}/{species_file(name)}", p)
    rows = []
    for line in p.read_text(encoding="latin1").splitlines()[1:]:
        f = line.split(";")
        if len(f) < 8:
            continue
        st, yr, ph, doy = int(f[0]), int(f[1]), PHASE.get(int(f[4])), int(f[7])
        if st in east and YEARS[0] <= yr <= YEARS[1] and ph:
            rows.append((ph, yr, doy))
    out = {}
    for ph in PHASES:
        a = np.array([(y, d) for p_, y, d in rows if p_ == ph])
        if len(a) < 30:
            continue
        resid = np.concatenate([a[a[:, 0] == y, 1] - a[a[:, 0] == y, 1].mean() for y in np.unique(a[:, 0]) if (a[:, 0] == y).sum() >= 3])
        out[ph] = dict(day=float(np.median(a[:, 1])), sd=float(resid.std()), n=int(len(a)), source="DWD")
    return out


def inat(taxon):
    p = CACHE / f"inat_{taxon}.json"
    if not p.exists():
        h = {}
        for v, key in ((37, "bud"), (38, "green"), (39, "coloured")):
            req = urllib.request.Request(INAT.format(t=taxon, v=v), headers={"User-Agent": "warsaw-voxel phenology"})
            d = json.load(urllib.request.urlopen(req))["results"]["week_of_year"]
            h[key] = [d.get(str(w), 0) for w in range(1, 54)]
            time.sleep(1.1)
        p.write_text(json.dumps(h))
    h = {k: np.array(v, float) for k, v in json.loads(p.read_text()).items()}
    doy, k3 = np.arange(53) * 7 + 4.0, np.ones(3) / 3
    g, c = np.convolve(h["green"], k3, "same"), np.convolve(h["coloured"], k3, "same")
    share, out = c / np.maximum(g + c, 1e-9), {}
    for i in range(29, 52):
        if share[i] < 0.5 <= share[i + 1] and h["coloured"].sum() >= 20:
            out["colour"] = dict(day=float(doy[i] + (0.5 - share[i]) / (share[i + 1] - share[i]) * 7), n=int(h["coloured"].sum()))
            break
    if h["bud"].sum() >= 10:
        out["leaf"] = dict(day=float((h["bud"] * doy).sum() / h["bud"].sum()), n=int(h["bud"].sum()))
    return out


def phenology():
    east = stations_east()
    table = {k: dict(species=name or "", genera=genera, **{**{ph: None for ph in PHASES}, **(dwd(name, east) if name else {})})
             for k, (name, _, genera) in CLASSES.items()}
    nat = {k: inat(t) for k, (_, t, _) in CLASSES.items()}
    sd = {ph: float(np.median([v[ph]["sd"] for v in table.values() if v[ph]])) for ph in PHASES}
    gap = float(np.median([v["fall"]["day"] - v["colour"]["day"] for v in table.values() if v["fall"] and v["colour"]]))
    for ph in ("leaf", "colour"):
        both = [nat[k][ph]["day"] - v[ph]["day"] for k, v in table.items() if v[ph] and ph in nat[k]]
        bias = float(np.median(both))
        print(f"iNaturalist {ph} minus DWD: median {bias:+.1f} d over {len(both)} species ({', '.join(f'{b:+.0f}' for b in both)})")
        for k, v in table.items():
            if not v[ph] and ph in nat[k]:
                v[ph] = dict(day=nat[k][ph]["day"] - bias, sd=sd[ph], n=nat[k][ph]["n"], source=f"iNaturalist, {bias:+.0f} d to the DWD scale")
    for v in table.values():
        if not v["fall"] and v["colour"]:
            v["fall"] = dict(day=v["colour"]["day"] + gap, sd=sd["fall"], n=0, source=f"colouring + {gap:.0f} d (the DWD's median gap)")
    med = {ph: dict(day=float(np.median([v[ph]["day"] for v in table.values() if v[ph]])), sd=sd[ph], n=0, source="median of the classes") for ph in PHASES}
    for v in table.values():
        v.update({ph: v[ph] or med[ph] for ph in PHASES})
    table[OTHER] = dict(species="median of the classes", genera=[], **med)
    table[EVERGREEN] = dict(species="conifers", genera=sorted(CONIFERS), leaf=None, colour=None, fall=None)
    for k, c in autumn_colours().items():
        table[k]["autumn"] = c
    for k in sorted(table):
        v = table[k]
        print(k, v["species"] or v["genera"], v.get("autumn"), {ph: (round(v[ph]["day"]), v[ph]["source"][:11]) for ph in PHASES if v[ph]})
    return table


def linear(hex_):
    c = np.array([int(hex_[i:i + 2], 16) for i in (1, 3, 5)]) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    c = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return "#" + "".join(f"{round(v * 255):02x}" for v in c)


def leaf_tint():
    photos = json.load(open(PHOTOS))
    summer = np.median([linear(photos[p]["summer_lit_hex"]) for p in PHOTO_CLASS.values()], axis=0)
    greens = np.mean([linear(h) for h in GREENS], axis=0)
    return [round(float(v), 3) for v in summer * lawns()[1] / greens]


def autumn_colours():
    photos = json.load(open(PHOTOS))
    lum = lambda c: float(c @ [0.2126, 0.7152, 0.0722])
    k_ = np.mean([lum(linear(h)) for h in GREENS]) / np.median([lum(linear(photos[p]["summer_lit_hex"])) for p in PHOTO_CLASS.values()])
    out = {k: srgb(linear(photos[p]["autumn_lit_hex"]) * k_) for k, p in PHOTO_CLASS.items()}
    out[OTHER] = srgb(np.median([linear(c) for c in out.values()], axis=0))
    return out


def lum(c):
    return float(c @ [0.2126, 0.7152, 0.0722])


def lab_to_linear(L, a, b):
    fy = (L + 16) / 116
    f = np.array([fy + a / 500, fy, fy - b / 200])
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * [0.95047, 1.0, 1.08883]
    return np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]) @ xyz


def lawns():
    photos = json.load(open(LAWNS))["photos"]
    lab = np.array([np.median([p["lit_lab"] for p in photos if p["month"] == m], axis=0) for m in range(1, 13)])
    lab = 0.25 * np.roll(lab, 1, 0) + 0.5 * lab + 0.25 * np.roll(lab, -1, 0)
    lin = np.array([lab_to_linear(*v) for v in lab])
    k = lum(linear(GRASS)) / np.mean([lum(lin[m]) for m in (5, 6, 7)])
    return lin, k


def grass_tints():
    lin, k = lawns()
    return [[round(float(v), 3) for v in lin[m] * k / linear(GRASS)] for m in range(12)]


def classify(t):
    genus = (t.get("sp") or "").split(" ")[0]
    if genus in CONIFERS:
        return EVERGREEN
    for k, (_, _, genera) in CLASSES.items():
        if genus in genera:
            return k
    if not genus and t.get("crown_sp"):
        for word, k in CROWN_SP.items():
            if t["crown_sp"].startswith(word):
                return k
    return OTHER


def city_median(table, cls, ph):
    # the day by which half of the city's deciduous trees have reached a phase
    days = [(table[k][ph]["day"], int((cls == k).sum())) for k in table if table[k][ph]]
    d, w = np.array(days).T
    o = np.argsort(d)
    return round(float(d[o][np.searchsorted(np.cumsum(w[o]), w.sum() / 2)]))


def main():
    table = phenology()
    trees = json.load(open(OUT / "trees.json"))["trees"]
    cls = np.array([classify(t) for t in trees], np.uint8)
    city = {ph: city_median(table, cls, ph) for ph in PHASES}
    print("city medians:", city)
    json.dump(dict(city=city, sources=["DWD Climate Data Center: phenological observations, annual reporters, wild plants (historical), stations east of 12.5° E, 1995-2024",
                            "iNaturalist: Leaves annotations, Poland, Germany, Czechia, Slovakia, Lithuania",
                            "autumn colours: Wikimedia Commons photos, scripts/foliage_photos.json",
                            "lawns by month: Wikimedia Commons photos, scripts/grass_photos.json"],
                   classes=table, grass=grass_tints(), leaf=leaf_tint()), open(OUT / "phenology.json", "w"), indent=1, ensure_ascii=False)

    xy = np.array([(t["x"], t["y"]) for t in trees])
    print("trees per class:", {int(k): int((cls == k).sum()) for k in np.unique(cls)})
    gx, gy = np.meshgrid(np.arange(W // 2) * 2 + 1, np.arange(D // 2) * 2 + 1)
    dist, idx = cKDTree(xy).query(np.c_[gx.ravel(), gy.ravel()], distance_upper_bound=9)
    ok = np.isfinite(dist)
    idx = np.minimum(idx, len(cls) - 1)
    grid = np.where(ok, cls[idx], 0).astype(np.uint8).reshape(gy.shape)
    tree = np.where(ok, (idx * 2654435761 >> 13) & 255, 0).astype(np.uint8).reshape(gy.shape)
    (OUT / "foliage.bin").write_bytes(gzip.compress(grid.tobytes() + tree.tobytes(), 9, mtime=0))
    print("foliage grid", grid.shape, "cells with a class:", int((grid > 0).sum()))


if __name__ == "__main__":
    main()
