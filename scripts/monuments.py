"""Monuments as voxel art. The GUGiK LiDAR surface model holds only buildings and vegetation, so a statue, a column or
a pylon is not in it at all; each monument here is drawn from Commons photos (20 per monument, Nov 2026), its
footprint and facing from the 0.2 m orthophoto, and its heights from Polish Wikipedia.

A monument is a list of boxes in its own frame: a across (to its right), b forward (the way it faces), z up from the
highest ground under it, in metres. A box can turn (rot), lean (its top shifted by lean) and taper (top, the top's
size as a share of the bottom's). A box from z = 0 reaches down to the ground in every column, so nothing floats on a
slope.
"""
import math

import numpy as np

from osm import to_grid

STONE, METAL = 0, 6
BRONZE, PATINA = ("#6a5c48", METAL), ("#678072", METAL)
GRANITE, DARK, BLACK = ("#9c9890", STONE), ("#6a6661", STONE), ("#34353a", STONE)
LIGHT, SAND, MARBLE = ("#cfcac0", STONE), ("#d6c39c", STONE), ("#eeece6", STONE)
CONCRETE, BASALT, STEEL = ("#bdbab2", STONE), ("#807a71", STONE), ("#b3b1aa", STONE)
RELIEF, SAPPER, SILVER = ("#55635b", METAL), ("#4f5a53", METAL), ("#c4c6c4", METAL)


def B(a, b, w, d, z0, z1, col, rot=0.0, lean=(0.0, 0.0), top=1.0):
    return dict(a=a, b=b, w=w, d=d, z0=z0, z1=z1, col=col, rot=rot, lean=lean, top=top)


def standing(a, b, z, h, col, arm=None):
    """a figure h m tall: two voxels across to the shoulders, the head one; arm 'up' raises a sabre or a hand on
    its right"""
    out = [B(a, b, 2, 1, z, z + h - 1, col), B(a - 0.5, b, 1, 1, z + h - 1, z + h, col)]
    if arm == "up":
        out += [B(a + 1.5, b, 1, 1, z + h - 2, z + h + 1, col)]
    return out


def rider(a, b, z, col, rot=0.0):
    """a horse with its rider, 4.5 m, three voxels long, facing +b"""
    r = math.radians(rot)
    at = lambda k: (a + k * math.sin(r), b + k * math.cos(r))
    return [B(*at(-1), 1, 1, z, z + 1, col, rot), B(*at(1), 1, 1, z, z + 1, col, rot),   # legs
            B(*at(0), 1, 3, z + 1, z + 2, col, rot),                                    # body
            B(*at(1.6), 1, 1, z + 2, z + 3, col, rot),                                   # neck and head
            B(*at(-0.2), 1, 1, z + 2, z + 4, col, rot)]                                  # the rider


def sappers():
    """Pomnik Chwała Saperom (1975, Stanisław Kulon), Commons 2006-2026, along its axis (2026): two groups of three
    welded steel pylons (the river shipyard's plates, painted light grey) flaring out like a mine's blast, a broad
    front one to 17 m, an outer one behind it leaning further, a slim near-vertical one inside; bronze reliefs wrap
    the groups' feet; between them, on a round plinth, the kneeling sapper in his helmet, the rifle on his back, over
    the wreaths. Its axis runs to its other half on the river pier; the sapper faces away from it, to the city"""
    # its axis is 31 degrees off the grid: every box turned back square to the voxels and leaning straight along
    # them (north or south), so a pylon steps cleanly instead of fraying
    G, n = -31, (math.cos(math.radians(31)), math.sin(math.radians(31)))
    out = [B(0, 0.5, 4, 4, 0, 0.5, GRANITE, G),
           B(0, 0.5, 2, 2, 0.5, 1.5, SAPPER, G), B(0, 0, 2, 1, 1.5, 2.5, SAPPER, G),
           B(0.5, 0.5, 1, 1, 2.5, 3.5, SAPPER, G), B(-0.5, -0.5, 1, 1, 2.5, 4, SAPPER, G)]
    for k in (-1, 1):
        lean = lambda m: (m * k * n[0], m * k * n[1])
        out += [B(5.5 * k, 1, 2.5, 2, 0, 1.5, LIGHT, G),
                B(5.5 * k, 1, 2, 1.5, 1.5, 17, STEEL, G),
                B(8 * k, -1.5, 2, 1.5, 0, 14, STEEL, G, lean(3)),
                B(3.5 * k, -4.5, 1.5, 1.5, 0, 12, STEEL, G),
                B(6.5 * k, 0, 5, 3, 1.5, 4, RELIEF, G)]
    return out


MONUMENTS = {
    "Pomnik Chwała Saperom": dict(at=(21.041212, 52.228660), phi=301, parts=sappers()),
    "Saperzy nad Wisłą": dict(at=(21.044794, 52.228289), phi=301,  # its other half, off the Czerniakowski bridgehead
                              # (Commons 2022): a dark steel post in the water by the steps, pale figures on it
                              parts=[B(0, 0, 1, 1, 0, 4, BLACK), B(0, 0, 2, 2, 4, 4.5, LIGHT)]
                              + standing(0, 0, 4.5, 3, SILVER)),
    "Pomnik Mikołaja Kopernika": dict(  # Thorvaldsen 1830: the seated astronomer with the armillary sphere
        at=(21.017972, 52.238155), phi=0,
        parts=[B(0, 0, 7, 7, 0, 1, GRANITE), B(0, 0, 5, 5, 1, 2, GRANITE), B(0, 0, 2, 3, 2, 6, DARK),
               B(0, 0.5, 2, 2, 6, 7, BRONZE), B(0, 0, 2, 1, 7, 8, BRONZE), B(-0.5, 0, 1, 1, 8, 9, BRONZE),
               B(1.5, 0, 1, 1, 7, 8, BRONZE)]),
    "Pomnik Bohaterów Getta": dict(  # 1948, Rapoport and Suzin: an 11 m basalt block on a stepped granite platform,
        at=(20.994216, 52.249741), phi=270,  # the fighters' bronze relief to the west, the march to death behind
        parts=[B(0, 0, 30, 20, 0, 1, DARK), B(0, 0, 10, 4, 1, 12, BASALT, top=0.85),
               B(0, 1.5, 3, 1, 3, 8, BRONZE), B(0, -1.5, 8, 1, 2, 4, BRONZE),
               B(-6, 4, 1, 1, 1, 3, BRONZE), B(6, 4, 1, 1, 1, 3, BRONZE)]),
    "Pomnik Nike": dict(  # Pomnik Bohaterów Warszawy (1964, Marian Konieczny): a 14 m sandstone-clad pedestal,
        at=(21.009183, 52.245897), phi=112,  # the 7 m bronze Nike lunging with a 6 m sword
        parts=[B(0, 0, 4.5, 7, 0, 14, SAND, top=0.75),
               B(0, -1, 2, 5, 14, 15, BRONZE), B(0, -0.5, 2, 3, 15, 16, BRONZE), B(0, 0, 2, 2, 16, 18, BRONZE),
               B(-0.5, 0, 1, 1, 18, 19, BRONZE), B(0.5, 0, 1, 1, 18, 21, BRONZE), B(0.5, 2.5, 1, 4, 19, 20, BRONZE)]),
    "Pomnik Józefa Poniatowskiego": dict(  # Thorvaldsen 1832: the prince on horseback, 4.5 m, on a two-step pedestal
        at=(21.015480, 52.242803), phi=180,
        parts=[B(0, 0, 5, 8, 0, 1, GRANITE), B(0, 0, 3, 6, 1, 6, DARK)] + rider(0, 0, 6, BRONZE)),
    "Pomnik Adama Mickiewicza": dict(  # Cyprian Godebski 1898: the 4.5 m poet on a granite column over a terrace
        at=(21.014857, 52.243726), phi=90,
        parts=[B(0, 0, 13, 13, 0, 1, DARK), B(0, 0, 11, 11, 1, 2, GRANITE),
               B(0, 0, 4, 4, 2, 4, LIGHT), B(0, 0, 3, 3, 4, 7, LIGHT), B(0, 0, 2, 2, 7, 10, LIGHT)]
              + standing(0, 0, 10, 5, BRONZE)
              + [B(x, y, 1, 1, 2, 6, BRONZE) for x in (-5, 5) for y in (-5, 5)]),
    "Pomnik Józefa Piłsudskiego": dict(  # 1995, Tadeusz Łodziana: the marshal in his greatcoat on a granite block
        at=(21.014130, 52.241393), phi=270,
        parts=[B(0, 0, 3, 3, 0, 1, GRANITE), B(0, 0, 2, 2, 1, 5, DARK)] + standing(0, 0, 5, 4, BRONZE)),
    "Pomnik Lecha Kaczyńskiego": dict(  # 2021: a 3.5 m figure on a 3.5 m light granite block wrapped in bronze
        at=(21.014063, 52.240900), phi=270,
        parts=[B(0, 0, 4, 4, 0, 1, LIGHT), B(0, 0, 2, 2, 1, 4, LIGHT), B(0, 1, 2, 1, 1, 4, BRONZE)]
              + standing(0, 0, 4, 4, BRONZE)),
    "Pomnik Ofiar Tragedii Smoleńskiej": dict(  # 2018: black granite steps rising 6 m over a glass-covered pit
        at=(21.012757, 52.240658), phi=0,
        parts=[B(0, 0, 7, 14, 0, 1, ("#3c4a50", STONE))]
              + [B(0, -4 + k, 3, 1 + 8 - k, 1, 1 + 0.7 * (k + 1), BLACK) for k in range(8)]),
    "Pomnik Kościuszkowców": dict(  # 1985, Bronisław Koniuszy: a 12 m bronze soldier in a cape, arm flung out
        at=(21.030788, 52.248040), phi=270,
        parts=[B(0, 0, 8, 6, 0, 1, DARK), B(0, 0, 6, 4, 1, 5, PATINA, top=0.8), B(0, 0, 5, 3, 5, 9, PATINA, top=0.7),
               B(0, 0, 2, 2, 9, 12, PATINA), B(1.5, 0, 1, 1, 8, 10, PATINA), B(2.5, 0, 1, 1, 9, 11, PATINA),
               B(3.5, 0, 1, 1, 10, 12, PATINA), B(4.5, 0, 1, 1, 11, 13, PATINA)]),
    "Pomnik Armii Krajowej": dict(  # 1999: a 32 m light granite blade whose foot sweeps out along the ground
        at=(21.026323, 52.225180), phi=90,
        parts=[B(0, 0, 3, 2, 0, 32, ("#d6d3cc", STONE), top=0.6)]
              + [B(0, 1 + k / 2, 3, 1 + k, 0, 8 - k, ("#d6d3cc", STONE)) for k in range(8)]),
    "Pomnik Jazdy Polskiej": dict(  # 1994, Mieczysław Welter: two riders on a slim column, the battles on its foot
        at=(21.014494, 52.216535), phi=0,
        parts=[B(0, 0, 2, 2, 0, 6, BLACK), B(0, 0, 1, 1, 6, 20, ("#a6b0a3", STONE)), B(0, 0, 3, 3, 20, 21, LIGHT)]
              + rider(-0.5, 0, 21, BRONZE) + rider(0.5, 0.5, 21, BRONZE)),
    "Pomnik Tadeusza Kościuszki": dict(  # 2010, a copy of Antoni Popiel's Washington monument: the general over a
        at=(21.002461, 52.239602), phi=90,  # granite pedestal, the eagle on a globe and the soldier groups below
        parts=[B(0, 0, 13, 13, 0, 1, GRANITE), B(0, 0, 8, 8, 1, 2, GRANITE), B(0, 0, 3, 3, 2, 7, LIGHT)]
              + standing(0, 0, 7, 3, BRONZE)
              + [B(x, y, 1, 1, 2, 4, BRONZE) for x, y in ((2.5, 0), (-2.5, 0), (0, 2.5), (0, -2.5))]),
    "Pomnik Poległym i Pomordowanym na Wschodzie": dict(  # 1995, Maksymilian Biskupski: a flatcar of crosses on rails
        at=(20.998874, 52.253780), phi=106,                # whose sleepers name the places of Soviet murder
        parts=[B(0, 0, 4, 8, 0, 1, DARK), B(0, 0, 4, 8, 1, 2, BRONZE)]
              + [B(x, y, 1, 1, 2, h, BRONZE) for x, y, h in ((-1.5, -3, 6), (0, -2.5, 7), (1.5, -3.5, 5), (-1, -1, 7),
                                                            (1, -0.5, 6), (0, 0.5, 8), (-1.5, 1.5, 6), (1.5, 1.5, 7),
                                                            (0, 3, 6), (-1, 3.5, 5), (1, 3.5, 6))]
              + [B(0, -6 - 2 * k, 3, 1, 0, 1, PATINA) for k in range(8)]),
    "Pomnik Jana Kilińskiego": dict(  # Stanisław Jackowski 1936: the cobbler leading the charge, sabre high,
        at=(21.010865, 52.248222), phi=180,  # 4 m of bronze on a 3 m granite block
        parts=[B(0, 0, 5, 5, 0, 1, GRANITE), B(0, 0, 2, 2, 1, 4, DARK)] + standing(0, 0, 4, 4, BRONZE, arm="up")),
    "Pomnik Żołnierzy 1 Armii WP": dict(  # 1945–1963, Bazyli Wojtowicz: an 8 m soldier hewn in grey granite
        at=(20.998243, 52.248198), phi=180,
        parts=[B(0, 0, 9, 6, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 3, GRANITE), B(0, 0, 2, 2, 3, 9, ("#a8a49c", STONE)),
               B(0, 0, 1, 1, 9, 11, ("#a8a49c", STONE))]),
    "Pomnik Monte Cassino": dict(  # 1999, Gustaw Zemła: a white marble column torn open, the wings of Nike over it,
        at=(21.000386, 52.247154), phi=210,  # on a 2 m base with the Monte Cassino cross
        parts=[B(0, 0, 8, 5, 0, 2, MARBLE), B(-1, -1, 2, 2, 2, 13, MARBLE, top=0.7),
               B(-2, -1, 1, 1, 12, 14, MARBLE), B(-3, -1, 1, 1, 13, 15, MARBLE),
               B(0, -1, 1, 1, 12, 14, MARBLE), B(1, -1, 1, 1, 13, 15, MARBLE)]),
    "Pomnik Kobietom Powstania Warszawskiego": dict(  # 2022, Monika Osiecka: three women in bronze on a granite slab
        at=(21.004628, 52.248968), phi=180,
        parts=[B(0, 0, 3, 3, 0, 1, DARK)] + [B(x, 0, 1, 1, 1, 3, BRONZE) for x in (-1, 0, 1)]),
    "Mały Powstaniec": dict(at=(21.009620, 52.249274), phi=90,  # Jerzy Jarnuszkiewicz 1983: the boy in a big helmet
                            parts=[B(0, 0, 1, 1, 0, 1, ("#7a4a3a", STONE)), B(0, 0, 1, 1, 1, 2, BRONZE)]),
    "Miła 18": dict(at=(20.992342, 52.251514), phi=0,  # the stone on the mound over the ŻOB bunker
                    parts=[B(0, 0, 1, 1, 0, 3, ("#9a978f", STONE))]),
    "Syrenka": dict(at=(21.032085, 52.240239), phi=270,  # Ludwika Nitschowa 1939: the 2.75 m mermaid with sword and
                    parts=[B(0, 0, 4, 4, 0, 1, SAND), B(0, 0, 2, 2, 1, 3, SAND)]  # shield over a sandstone pedestal
                    + standing(0, 0, 3, 3, PATINA, arm="up")),
}


def build(vol, g, pal, note, keep=()):
    """every monument into the volume; returns each cell's new top (absolute z, 0 where none) for the labels"""
    D, W = g.shape
    mon_top = np.zeros((D, W), np.int16)
    keep = np.asarray(sorted(keep), dtype=vol.dtype)
    for name, m in MONUMENTS.items():
        c0, r0 = (int(v) + 0.5 for v in to_grid(*m["at"]))
        ph = math.radians(m["phi"])
        rt, fw = (math.cos(ph), math.sin(ph)), (math.sin(ph), -math.cos(ph))
        R = int(max(math.hypot(p["a"], p["b"]) + math.hypot(p["w"], p["d"]) + math.hypot(*p["lean"]) for p in m["parts"])) + 2
        rr, cc = np.mgrid[int(r0) - R:int(r0) + R + 1, int(c0) - R:int(c0) + R + 1]
        ok = (rr >= 0) & (rr < D) & (cc >= 0) & (cc < W)
        rr, cc = rr[ok], cc[ok]
        dc, dr = cc + 0.5 - c0, rr + 0.5 - r0
        A, Bf = dc * rt[0] + dr * rt[1], dc * fw[0] + dr * fw[1]
        cells = []
        for p in m["parts"]:
            t = math.radians(p["rot"])
            for z in range(int(p["z0"]), int(math.ceil(p["z1"]))):
                f = (z + 0.5 - p["z0"]) / max(p["z1"] - p["z0"], 1e-6)
                s = 1 + (p["top"] - 1) * f
                pa, pb = A - p["a"] - p["lean"][0] * f, Bf - p["b"] - p["lean"][1] * f
                x, y = pa * math.cos(t) - pb * math.sin(t), pa * math.sin(t) + pb * math.cos(t)
                hw, hd = p["w"] * s / 2, p["d"] * s / 2  # half-open, so an even width is that many cells
                hit = (x >= -hw - 1e-6) & (x < hw - 1e-6) & (y >= -hd - 1e-6) & (y < hd - 1e-6)
                if hit.any():
                    cells.append((z, rr[hit], cc[hit], p))
        if not cells:
            continue
        foot = np.unique(np.concatenate([np.stack([r, c], 1) for z, r, c, p in cells if p["z0"] == 0]), axis=0)
        z0 = int(g[foot[:, 0], foot[:, 1]].max())
        allrc = np.unique(np.concatenate([np.stack([r, c], 1) for z, r, c, p in cells]), axis=0)
        zmax = z0 + max(int(math.ceil(p["z1"])) for p in m["parts"])
        for r, c in allrc:  # what the LiDAR or an OSM outline left on the spot (not the trees around it)
            col = vol[g[r, c]:zmax + 2, r, c]
            col[~np.isin(col, keep)] = 0
        for z, r, c, p in cells:
            v = pal(p["col"][0], p["col"][1])
            if p["z0"] == 0 and z == 0:
                for ri, ci in zip(r, c):
                    vol[g[ri, ci]:z0 + 1, ri, ci] = v
            else:
                vol[z0 + z, r, c] = v
            mon_top[r, c] = np.maximum(mon_top[r, c], z0 + z + 1)
        note(f"monument {name} at ({int(r0)}, {int(c0)}), {zmax - z0} m")
    return mon_top
