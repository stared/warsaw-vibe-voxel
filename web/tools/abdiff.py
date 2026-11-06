"""Literal pixel diff of two screenshots: |a - b| amplified 8x as an image, and how much differs.

usage: python tools/abdiff.py a.png b.png diff.png
"""
import sys

import numpy as np
from PIL import Image

a, b = (np.asarray(Image.open(p).convert('RGB')).astype(np.int16) for p in sys.argv[1:3])
d = np.abs(a - b).max(axis=2)
Image.fromarray(np.clip(np.abs(a - b) * 8, 0, 255).astype(np.uint8)).save(sys.argv[3])
print(f'{sys.argv[3]}: max {d.max()}, pixels differing >2: {(d > 2).mean():.4%}, >8: {(d > 8).mean():.4%}, >32: {(d > 32).mean():.4%}')
