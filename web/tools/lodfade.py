"""Score tools/lodfade.mjs runs: % of the centre (60 % box) that changes between consecutive screenshots (after a
1 px blur, luminance step > 12/255), for the swap to coarser tiles (down) and back (up). A flip is one big step;
a dissolve spreads the same total over many small ones. `still` is the noise floor (water, sky).
usage: uv run --with pillow --with numpy --with scipy python tools/lodfade.py <outdir> [<outdir2> ...]
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

TH = 12


def lum(p):
    a = np.asarray(Image.open(p).convert("RGB"), np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    a = ndimage.gaussian_filter(a, 1.0)
    h, w = a.shape
    return a[int(h * .2):int(h * .8), int(w * .2):int(w * .8)]


def changed(a, b):
    return (np.abs(a - b) > TH).mean() * 100


for d in sys.argv[1:]:
    print(f"\n{os.path.basename(d)}")
    names = sorted({os.path.basename(f).split("_")[0] for f in glob.glob(f"{d}/*_still_00.png")})
    for name in names:
        row = []
        st = [lum(f) for f in sorted(glob.glob(f"{d}/{name}_still_*.png"))]
        floor = max(changed(a, b) for a, b in zip(st, st[1:]))
        for phase in ("down", "up"):
            fr = [lum(f) for f in sorted(glob.glob(f"{d}/{name}_{phase}_*.png"))]
            # the first frame of a phase is compared to the last of the previous one (the swap may already be in it)
            prev = st[-1] if phase == "down" else lum(sorted(glob.glob(f"{d}/{name}_down_*.png"))[-1])
            steps = [changed(a, b) for a, b in zip([prev] + fr, fr)]
            total = changed(prev, fr[-1])
            busy = sum(s > max(0.3, 2 * floor) for s in steps)
            row.append(f"{phase}: total {total:5.2f}  worst step {max(steps):5.2f}  steps>floor {busy:2d}")
        print(f"  {name:7s} floor {floor:4.2f} | " + " | ".join(row))
