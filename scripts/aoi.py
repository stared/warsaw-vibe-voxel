"""Area of interest shared by all pipeline steps.

The voxel grid is anchored on the PKiN spire and rotated to the Palace's own axes, so its walls (and the
Śródmieście street grid, which shares the orientation within ~1°) fall on voxel faces instead of staircases.
THETA was measured from 443 OSM wall edges of the PKiN complex (weighted mean 21.5°, mod 90).

World coords: EPSG:2180 (PL-1992), x = easting, y = northing.
Grid coords: (i, j) continuous, i = column (along PKiN's E-W facade), j = row (along its N-S facade,
growing roughly south); cell (c, r) spans [c, c+1) x [r, r+1).
"""
import math

import numpy as np

CX, CY = 636965.62, 486975.12  # PKiN spire (OSM way 240119160), EPSG:2180
THETA = math.radians(21.5)
# 3950 x 4430 m: from the Rondo ONZ towers east across the Vistula to PGE Narodowy, north past the Old Town and the
# New Town (Plac Zamkowy, the Rynek, the Barbican, Rynek Nowego Miasta and a street or two beyond), south past Trasa
# Łazienkowska (Al. Armii Ludowej down to Politechnika, Most Łazienkowski). The Old Town strip added 1280 rows on the
# north: the earlier map is j in [1280, 4430), the same cells.
W, D = 3950, 4430
I0, J0 = 750, 2510  # grid position of the PKiN spire
RAW = "data/raw"

EU = np.array([math.cos(THETA), math.sin(THETA)])   # grid +i in world
EV = np.array([math.sin(THETA), -math.cos(THETA)])  # grid +j in world


def to_grid(x, y):
    dx, dy = np.asarray(x) - CX, np.asarray(y) - CY
    return I0 + dx * EU[0] + dy * EU[1], J0 + dx * EV[0] + dy * EV[1]


def to_world(i, j):
    u, v = np.asarray(i) - I0, np.asarray(j) - J0
    return CX + u * EU[0] + v * EV[0], CY + u * EU[1] + v * EV[1]


def world_bounds(margin=0):
    xs, ys = to_world(np.array([0, W, W, 0]), np.array([0, 0, D, D]))
    return xs.min() - margin, ys.min() - margin, xs.max() + margin, ys.max() + margin
