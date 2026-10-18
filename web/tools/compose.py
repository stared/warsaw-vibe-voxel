# photo | render, one image per shot (same height), label on top
import sys, json, os
from PIL import Image, ImageDraw
SP = os.environ["OUT"]; out = f"{SP}/cmp"; os.makedirs(out, exist_ok=True)
info = {x["id"]: x for x in json.load(open(f"{SP}/info.json"))}
for sid in (sys.argv[1:] or info):
    p = f"{SP}/render/{sid}.png"
    if not os.path.exists(p): continue
    r = Image.open(p).convert("RGB"); ph = Image.open(f"{SP}/refs/{sid}.jpg").convert("RGB").resize(r.size)
    im = Image.new("RGB", (r.width * 2 + 8, r.height + 22), "white"); im.paste(ph, (0, 22)); im.paste(r, (r.width + 8, 22))
    i = info[sid]; ImageDraw.Draw(im).text((4, 4), f"{sid}  {i['title'][5:70]}  {i['date']}  {i['dist']} m  f{i['f35']}", fill="black")
    im.save(f"{out}/{sid}.jpg", quality=85)
