# Photo comparison, step 1 (run from the repo root, OUT=<work dir>): uv run python web/tools/poses.py <{label: Commons category} json> [per]
# then node web/tools/photoshot.mjs $OUT/shots.json $OUT/render, then OUT=... uv run python web/tools/compose.py
# For landmarks: Commons photos with camera position, compass and focal length, taken toward the landmark -> shots.json
import sys, json, math, re, os, hashlib, requests
sys.path.insert(0, "scripts"); sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from pyproj import Transformer
from aoi import to_grid, EU, EV, W, D
from commons import files, subcats, UA
SP = os.environ["OUT"]  # work dir: refs/ (photos), shots.json, info.json
T = Transformer.from_crs(4326, 2180, always_xy=True)
meta = json.load(open("web/public/data/meta.json")); LAB = {l["name"]: l for l in meta["labels"]}
_gz = np.load("data/ground.npz"); g = _gz["g"]; B = _gz["b"] if "b" in _gz.files else np.zeros_like(g)
CATS = json.loads(sys.argv[1]); AIM = os.environ.get("AIM", "landmark"); NODIR = os.environ.get("NODIR"); PER = int(sys.argv[2]) if len(sys.argv) > 2 else 4
def num(v):
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    m = re.match(r"(-?\d+)/(\d+)", str(v)); return float(m[1]) / float(m[2]) if m else float(v)
shots, info = [], []
for name, cat in CATS.items():
    L = LAB[name]; cand = files(cat, 300)
    for s in subcats(cat)[:10]: cand += files(s, 100)
    seen, picked = set(), []
    for c in cand:
        if c["t"] in seen or not (c["lat"] and (c["dir"] or NODIR) and c["url"]) or re.search(r"[Vv]iews? from|[Ii]nterior|[Ww]nętrz|korytarz|[Ss]ala |[Hh]all|panorama|night|[Nn]acht|noc|posiedzen|[Ss]ession|[Cc]onference|[Kk]onferenc|[Ee]xpos|[Ss]culpt|[Rr]zeźb|[Pp]omnik|detal|[Dd]etail|tablica|plaque", c["t"]): continue
        seen.add(c["t"])
        i, j = (float(v) for v in to_grid(*T.transform(c["lon"], c["lat"])))
        if not (5 < i < W - 5 and 5 < j < D - 5): continue
        dx, dz = L["x"] - i, L["y"] - j; dist = math.hypot(dx, dz); toward = math.degrees(math.atan2(dx, -dz))
        if c["dir"]:
            b = math.radians(num(c["dir"])); v = np.array([math.sin(b), math.cos(b)])
            di, dj = v @ EU, v @ EV; yaw = math.degrees(math.atan2(di, -dj))
        else: yaw = toward  # NODIR=1: GPS only, assume it faces the landmark (check by eye)
        off = (yaw - toward + 540) % 360 - 180
        if not (25 < dist < 900 and abs(off) < 30): continue
        f = num(c["f35"]) or 28; f = f if f > 10 else 28
        picked.append((abs(off) + dist / 50, c, i, j, yaw, dist, f, off))
    picked.sort(key=lambda p: p[0])
    for k, (_, c, i, j, yaw, dist, f, off) in enumerate(picked[:PER]):
        ar = c["w"] / c["h"]; h = 720; w = int(round(h * ar / 2) * 2)
        if w > 1100: w = 1100; h = int(w / ar)
        hf = 2 * math.atan(36 / (2 * f)) if ar >= 1 else 2 * math.atan(24 / (2 * f))  # long side 36 mm
        vf = math.degrees(2 * math.atan(math.tan(hf / 2) / ar)) if ar >= 1 else math.degrees(2 * math.atan(36 / (2 * f)))
        # GPS error put many cameras inside a wall: step back, away from the landmark, to the first open cell
        if not (abs(i - 750) < 36 and abs(j - 1230) < 36):
            ux, uz = (i - L["x"]) / max(dist, 1), (j - L["y"]) / max(dist, 1)
            for step in range(0, 60):
                ci, cj = int(i + ux * step), int(j + uz * step)
                if 0 <= cj < D and 0 <= ci < W and B[max(0, cj - 5):cj + 6, max(0, ci - 5):ci + 6].max() < 2:  # 5 m clear
                    i, j = i + ux * step, j + uz * step
                    break
        y0 = float(g[min(D - 1, int(j)), min(W - 1, int(i))]) + 1.6
        if abs(i - 750) < 36 and abs(j - 1230) < 36:  # GPS inside PKiN's tower: the 30th-floor terrace, 114 m
            y0 += 114
            i, j = i + (i - 750) * 0.4, j + (j - 1230) * 0.4  # at the terrace parapet, not inside the shaft
        pitch = max(-30.0 if y0 > 100 else 0.0, min(28.0, math.degrees(math.atan((L["g"] + (L["z"] - L["g"]) * 0.5 - y0) / dist))))
        hr = 17.0
        if c["date"]:
            m = re.search(r" (\d\d):(\d\d)", c["date"]); hr = int(m[1]) + int(m[2]) / 60 if m else 17
            hr = min(20.5, max(7, hr))
        sid = f"{re.sub(r'[^a-z0-9]', '', name.lower())[:10]}_{k}"
        fn = f"{SP}/refs/{sid}.jpg"
        if not os.path.exists(fn):
            open(fn, "wb").write(requests.get(c["url"], headers=UA).content)
        shots.append(dict(id=sid, pos=[i, y0, j], yaw=yaw if AIM == "compass" else yaw - off, pitch=pitch, vfov=vf, w=w, h=h, hour=hr))
        info.append(dict(id=sid, name=name, title=c["t"], date=c["date"], dist=round(dist), f35=f))
json.dump(shots, open(f"{SP}/shots.json", "w"), indent=0); json.dump(info, open(f"{SP}/info.json", "w"), indent=0)
for x in info: print(x)
