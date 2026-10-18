# Landmark audit, step 1 (run from the repo root, OUT=<work dir>): uv run python web/tools/audit.py [names...]
# For every labelled landmark (or the named ones): the 2025 ortho crop, plus camera poses for a top-down render at the
# same scale and four obliques from the diagonals -> $OUT/audit.json, $OUT/ortho/<id>.png.
# Then: node web/tools/photoshot.mjs $OUT/audit.json $OUT/render; uv run python web/tools/audit.py --sheet
# -> $OUT/sheet/<id>.jpg: ortho | top render on the first row, the four obliques below.
import sys, json, os, re, math
import numpy as np
from PIL import Image
SP = os.environ["OUT"]
meta = json.load(open("web/public/data/meta.json"))
AREAS = {"Plac Centralny", "Park Świętokrzyski", "Ogród Saski", "Plac Konstytucji", "Wisła", "Bulwary Wiślane"}
HALF = {"PGE Narodowy": 190, "Pałac Kultury i Nauki": 140, "Most Świętokrzyski": 260, "Most Poniatowskiego": 300,
        "Warszawa Centralna": 120, "Złote Tarasy": 120, "Sejm": 130, "Politechnika Warszawska": 120, "BUW": 110,
        "Centrum Nauki Kopernik": 110, "Teatr Wielki": 110, "Pałac Saski": 90, "Elektrownia Powiśle": 110}
sid = lambda n: re.sub(r"[^a-z0-9]", "", n.lower())[:14]
labs = [l for l in meta["labels"] if l["name"] not in AREAS and (len(sys.argv) < 2 or sys.argv[1] == "--sheet" or l["name"] in sys.argv[1:])]

if len(sys.argv) > 1 and sys.argv[1] == "--sheet":
    os.makedirs(f"{SP}/sheet", exist_ok=True)
    for l in labs:
        i = sid(l["name"]); p = lambda k: f"{SP}/render/{i}_{k}.png"
        if not os.path.exists(p("top")):
            continue
        o = Image.open(f"{SP}/ortho/{i}.png").convert("RGB").resize((700, 700)); t = Image.open(p("top")).convert("RGB").resize((700, 700))
        ob = [Image.open(p(k)).convert("RGB").resize((700, 525)) for k in ("ne", "se", "sw", "nw")]
        im = Image.new("RGB", (1408, 700 + 2 * 533), "white")
        im.paste(o, (0, 0)); im.paste(t, (708, 0))
        for k, b in enumerate(ob):
            im.paste(b, ((k % 2) * 708, 708 + (k // 2) * 533))
        im.save(f"{SP}/sheet/{i}.jpg", quality=86)
    sys.exit()

os.makedirs(f"{SP}/ortho", exist_ok=True)
orto = np.load("data/prep.npz", mmap_mode="r")["orto"]
shots = []
for l in labs:
    i, x, y, g, z = sid(l["name"]), l["x"], l["y"], l["g"], l["z"]
    H = HALF.get(l["name"], 70)
    a = np.asarray(orto[max(0, (y - H) * 5):(y + H) * 5, max(0, (x - H) * 5):(x + H) * 5])
    Image.fromarray(a).resize((700, 700)).save(f"{SP}/ortho/{i}.png")
    vf = 6.0; h = H / math.tan(math.radians(vf / 2))
    shots.append(dict(id=f"{i}_top", pos=[x, g + h, y + 0.01], yaw=0, pitch=-89.9, vfov=vf, w=700, h=700, hour=12))
    zt = z - g
    d = max(2.2 * H, 1.6 * zt)
    for k, yaw in (("ne", 225), ("se", 315), ("sw", 45), ("nw", 135)):  # camera on that diagonal, looking at the centre
        b = math.radians(yaw)
        cx, cz = x - math.sin(b) * d, y + math.cos(b) * d
        el = 30
        shots.append(dict(id=f"{i}_{k}", pos=[cx, g + zt * 0.45 + d * math.tan(math.radians(el)), cz], yaw=yaw, pitch=-el,
                          vfov=2 * math.degrees(math.atan(1.25 * max(H, zt * 0.6) / d)), w=800, h=600, hour=10 if k in ("se", "sw") else 15))
json.dump(shots, open(f"{SP}/audit.json", "w"))
print(len(labs), "landmarks", len(shots), "shots")
