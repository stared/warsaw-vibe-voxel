"""Score tools/lodflip.mjs runs: per view and distance, the share of the frame that differs from full detail
(after a 1 px blur, so single-pixel shimmer doesn't count), in the centre (the 60 % box you look at) and overall.
usage: uv run --with pillow --with numpy --with scipy python tools/lodflip.py <outdir> [<outdir2> ...]
"""
import glob
import os
import sys
from collections import defaultdict

import numpy as np
from PIL import Image
from scipy import ndimage

TH = 12  # luminance step (of 255) a viewer notices on a building


def lum(path):
    a = np.asarray(Image.open(path).convert("RGB"), np.float32)
    return ndimage.gaussian_filter(a @ np.array([0.299, 0.587, 0.114], np.float32), 1.0)


def score(d):
    res = defaultdict(list)
    for t in sorted(glob.glob(f"{d}/*_test.png")):
        name, dist = os.path.basename(t).split("_")[:2]
        diff = np.abs(lum(t) - lum(t.replace("_test", "_ref"))) > TH
        h, w = diff.shape
        c = diff[int(h * .2):int(h * .8), int(w * .2):int(w * .8)]
        res[name].append((int(dist), diff.mean() * 100, c.mean() * 100))
    return res


runs = [score(d) for d in sys.argv[1:]]
for name in runs[0]:
    print(f"\n{name}: % of pixels off full detail (centre / whole), " + " | ".join(os.path.basename(d) for d in sys.argv[1:]))
    for i, (dist, *_) in enumerate(runs[0][name]):
        print(f"  {dist:5d} m  " + "   ".join(f"{r[name][i][2]:5.2f} / {r[name][i][1]:5.2f}" for r in runs if name in r))
    for d, r in zip(sys.argv[1:], runs):
        if name in r:
            print(f"  {os.path.basename(d)}: centre max {max(x[2] for x in r[name]):.2f}  mean {np.mean([x[2] for x in r[name]]):.2f}")
