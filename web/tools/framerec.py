"""Find picture swaps in a tools/framerec.mjs recording: per frame, the share of the picture (left of the settings
panel, 1 px blur, luminance step > 12) that changed since the previous frame. Camera motion between 17 ms frames
changes a smooth few %; a swap is a spike above the running median. Prints the spikes with the tiles that
appeared / disappeared in that frame, plots the series, and saves the before/after pairs of the worst spikes.
usage: uv run --with pillow --with numpy --with scipy --with matplotlib python tools/framerec.py <dir> <spot> [top]
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

d, spot = sys.argv[1], sys.argv[2]
top = int(sys.argv[3]) if len(sys.argv) > 3 else 8
meta = json.load(open(f"{d}/{spot}.json"))
raw = np.fromfile(f"{d}/{spot}.lum", np.uint8).reshape(len(meta), 300, 480)
L = ndimage.gaussian_filter(raw[:, :, :360].astype(np.float32), (0, 1, 1))  # left 3/4: the settings panel is static
ch = np.r_[0, [(np.abs(L[i] - L[i - 1]) > 12).mean() * 100 for i in range(1, len(L))]]
base = ndimage.median_filter(ch, 9)
# the wheel moves the camera in one frame per notch (no easing): frames where the camera did not move show only
# what the streamer changed
still = np.r_[False, [meta[i]["d"] == meta[i - 1]["d"] for i in range(1, len(meta))]]
spike = np.where(still, ch, 0)
ev = [len(m["shown"]) + len(m["hidden"]) for m in meta]
idx = np.argsort(-spike)[:top]
print(f"{spot}: {len(meta)} frames, {(~still).sum()} with camera motion; frames with tile swaps {sum(e > 0 for e in ev)}; "
      f"camera still but picture changed >0.5 %: {((ch > 0.5) & still).sum()} frames, >3 %: {((ch > 3) & still).sum()}")
for i in sorted(idx):
    m = meta[i]
    lv = lambda ks: ",".join(sorted({k.split('/')[0] for k in ks}))
    print(f"  frame {i:4d} t {m['t'] - meta[0]['t']:6d} ms  d {m['d']:5d} m  change {ch[i]:5.1f} % (run {base[i]:4.1f})  "
          f"shown {len(m['shown'])} [{lv(m['shown'])}] hidden {len(m['hidden'])} [{lv(m['hidden'])}]")
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(14, 3.5))
t = [(m["t"] - meta[0]["t"]) / 1000 for m in meta]
ax.plot(t, ch, lw=0.8, label="% changed since previous frame")
ax.plot(t, np.where(still, ch, np.nan), "k.", ms=3, label="camera still: a swap")
for i, e in enumerate(ev):
    if e: ax.axvline(t[i], color="r", alpha=0.25, lw=0.6)
ax.set_xlabel("s"); ax.legend(loc="upper right"); ax.set_title(f"{spot}: red = tiles swapped in that frame")
fig.tight_layout(); fig.savefig(f"{d}/{spot}_series.png", dpi=110)
rows = [np.hstack([raw[i - 1], np.full((300, 6), 255, np.uint8), raw[i]]) for i in sorted(idx[:6])]
Image.fromarray(np.vstack(rows)).save(f"{d}/{spot}_spikes.png")
