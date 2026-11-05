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
DARK_BRONZE, DARK_GRANITE, RED_GRANITE = ("#4a453e", METAL), ("#4b4b4e", STONE), ("#8f6f66", STONE)
PALE_GRANITE, FROND = ("#c9c6bf", STONE), ("#4f7a3a", STONE)
PINK_GRANITE, GREY_BRONZE, WORN_BRONZE = ("#b4a598", STONE), ("#59605a", METAL), ("#4f5a50", METAL)
MID_GRANITE, COPPER, MERMAID = ("#8f8d88", STONE), ("#7a5236", METAL), ("#4d6b5e", METAL)


def B(a, b, w, d, z0, z1, col, rot=0.0, lean=(0.0, 0.0), top=1.0):
    return dict(a=a, b=b, w=w, d=d, z0=z0, z1=z1, col=col, rot=rot, lean=lean, top=top)


def standing(a, b, z, h, col, arm=None):
    """a figure h m tall: two voxels across to the shoulders, the head one; arm 'up' raises a sabre or a hand on
    its right"""
    out = [B(a, b, 2, 1, z, z + h - 1, col), B(a - 0.5, b, 1, 1, z + h - 1, z + h, col)]
    if arm == "up":
        out += [B(a + 1.5, b, 1, 1, z + h - 2, z + h + 1, col)]
    return out


def rider(a, b, z, col, rot=0.0, arm=False):
    """a horse with its rider, 5 m, facing +b: front and hind legs, a 4 m body, the neck and head raised, the tail,
    the rider over the saddle, arm out ahead with a sabre if arm"""
    r = math.radians(rot)
    at = lambda k: (a + k * math.sin(r), b + k * math.cos(r))
    out = [B(*at(-1.5), 1, 1, z, z + 2, col, rot), B(*at(1.5), 1, 1, z, z + 2, col, rot),
           B(*at(0), 1, 4, z + 2, z + 3, col, rot), B(*at(2.5), 1, 1, z + 3, z + 5, col, rot),
           B(*at(-2.5), 1, 1, z + 1, z + 3, col, rot), B(*at(-0.5), 1, 1, z + 3, z + 5, col, rot)]
    if arm:
        out.append(B(*at(0.5), 1, 1, z + 4, z + 5, col, rot))
    return out


def crosses(w, d, z):
    """a thicket of crosses over w x d cells from z: each cell a post of its own height (4 to 7 m), some with the
    crossbar out to a side"""
    out = []
    for i in range(w):
        for k in range(d):
            hh = (i * 7 + k * 13 + i * k * 5) % 5
            if hh == 4:
                continue
            a, b, top = i - (w - 1) / 2, k - (d - 1) / 2, z + 3 + hh
            out.append(B(a, b, 1, 1, z, top, DARK_BRONZE))
            if (i + k * 3) % 3 == 0:
                out.append(B(a + (-1 if i < w / 2 else 1), b, 1, 1, top - 2, top - 1, DARK_BRONZE))
    return out


def uprising():
    """Pomnik Powstania Warszawskiego (1989, Wincenty Kućma; Commons and the 2025 ortho): a long slab of pale granite
    tipped up from the west to 10 m over its sheer east end, a falling building, the insurgents' dark bronze group
    bursting out from under it towards the square; behind it to the north-west a smaller tipped slab over the group
    going down into the sewer; grid frame (a east, b north) from the large slab's middle"""
    out = []
    for k in range(15):  # the large slab: 2 m thick, its underside rising half a metre a metre
        lo = 0.5 * k
        out.append(B(-6.5 + k, -2, 1, 4, lo, lo + 2, PALE_GRANITE))
    out += [B(8.5, -2, 1, 4, 0, 9, PALE_GRANITE)]  # its sheer end down to the ground
    for k in range(9):  # the small slab, rising to the north-east
        lo = 0.5 * k
        out.append(B(-11.5 + k, 3.5, 1, 6, lo, lo + 2, PALE_GRANITE))
    out += [B(-3, 3.5, 1, 6, 0, 6, PALE_GRANITE)]
    for a, h in ((-4, 2), (-2, 3), (0, 3), (2, 4), (4, 3), (6, 4)):  # the fighters, under the slab and out of it
        out += [B(a, -4.5, 1, 1, 0, h, DARK_BRONZE), B(a + 0.5, -3.5, 1, 1, 0, max(h - 1, 1), DARK_BRONZE)]
    out += [B(-9, 1, 1, 1, 0, 2, DARK_BRONZE), B(-7, 1, 1, 1, 0, 2, DARK_BRONZE)]  # down into the sewer
    out += [B(7.5, -0.5 + k, 1, 1, 0, 6 + 2 * (k % 2), DARK_BRONZE) for k in range(3)]  # the torn wall's piers
    return out



def plane(L, S, col):
    """an aircraft on display, nose along +b: the fuselage 2 m round on its gear, swept wings of span S a little behind
    the middle, the tailplane and the fin at the back"""
    c = (col, METAL)
    out = [B(0, L * 0.3, 1.6, 1.6, 0, 1, c), B(-1.5, -L * 0.05, 1.6, 1.6, 0, 1, c), B(1.5, -L * 0.05, 1.6, 1.6, 0, 1, c),
           B(0, 0, 2, L, 1, 3, c), B(0, L / 2 + 0.5, 1.6, 1.6, 1.5, 2.5, c),
           B(0, -L * 0.05, S, max(2, L * 0.15), 1, 2, c),
           B(0, -L * 0.42, S * 0.4, 2, 2, 3, c), B(0, -L * 0.42, 1.2, 2.5, 3, 5, c)]
    return out


def uw_gate():
    """the University of Warsaw's main gate on Krakowskie Przedmieście (1910, Stefan Szyller; Commons 2019-2023): two
    white pavilions with a statue in a niche facing the street, a pediment and a lamp on a tall post over each, the
    wrought-iron arch with the crowned eagle between them over the 5 m opening, an iron side gate and a post with an
    urn beyond each; the street to the west (-a)"""
    white, iron, gold, statue = ("#ece6d8", STONE), ("#2b2d2e", METAL), ("#b8943f", METAL), ("#a8a59c", STONE)
    out = []
    for s_ in (-1, 1):
        b = 4.5 * s_
        out += [B(0, b, 3, 4, 0, 6, white), B(0, b, 3, 3, 6, 7.5, white), B(0, b, 1, 1, 7.5, 9, white),
                B(0, b, 1, 1, 9, 12.5, iron), B(-1, b, 1, 1, 1, 4, statue),
                B(0, 7.4 * s_, 1, 2, 3.5, 4.5, iron), B(0, 7.4 * s_, 1, 1, 0, 3.5, iron),
                B(0, 9.2 * s_, 2, 2, 0, 5.5, white), B(0, 9.2 * s_, 1, 1, 5.5, 6.5, white)]
    out += [B(0, 0, 1, 5, 6, 7, iron), B(0, 0, 1, 1, 7, 8, gold)]
    return out


def candelabrum(H=18):
    """one of Plac Konstytucji's three candelabra (1952; Commons 2018-2026): a stone base, a fluted dark shaft to
    about 18 m, a ring of dark lantern arms with white globes round its top and a spire over them"""
    stone, dark, glow = ("#bfb5a1", STONE), ("#3e4442", METAL), ("#f2eedc", STONE)
    out = [B(0, 0, 3, 3, 0, 2, stone), B(0, 0, 2, 2, 2, 4, stone), B(0, 0, 1, 1, 4, H - 3, dark),
           B(0, 0, 3, 3, H - 6, H - 5, dark), B(0, 0, 1, 1, H - 3, H, dark)]
    for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        out += [B(2 * a, 2 * b, 1, 1, H - 6, H - 4, glow), B(a, b, 1, 1, H - 4, H - 3, glow)]
    return out

def palm():
    """Palma (2002, Joanna Rajkowska; Commons 2010-2023): an artificial date palm on the roundabout's lawn, a slim
    grey-brown trunk to 15 m and a star of drooping green fronds, the same in every season"""
    out = [B(0, 0, 5, 5, 0, 1, ("#6f8f4a", 8)), B(0, 0, 1, 1, 1, 14, ("#7d6e5c", STONE)), B(0, 0, 1, 1, 14, 15, FROND)]
    for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
        out += [B(a, b, 1, 1, 13, 15, FROND), B(2 * a, 2 * b, 1, 1, 13, 14, FROND)]
        if a and b:
            out.append(B(a, 2 * b, 1, 1, 13, 14, FROND))  # keeps the diagonal frond touching by a face
            out.append(B(2 * a, b, 1, 1, 13, 14, FROND))
    out += [B(3 * a, 0, 1, 1, 12, 13, FROND) for a in (-1, 1)] + [B(0, 3 * b, 1, 1, 12, 13, FROND) for b in (-1, 1)]
    out += [B(2 * a, 0, 1, 1, 12, 13, FROND) for a in (-1, 1)] + [B(0, 2 * b, 1, 1, 12, 13, FROND) for b in (-1, 1)]
    return out


def arcade():
    """Grób Nieznanego Żołnierza (the three arches left of the Saxon Palace's colonnade; Commons 1925-2024 and the
    ortho): 14 m along the square's west side, 8 m deep, piers of pale stone with the arches between them open to
    the square and through, the entablature and a balustrade on top to 8 m; the tomb and the eternal flame under the
    middle arch. Frame: a along the arcade (north), b towards the square (east)"""
    st = ("#d9d3c6", STONE)
    out = [B(0, 0, 14, 8, 0, 0.5, ("#bdb8ae", STONE))]
    for a in (-6.5, -2.2, 2.2, 6.5):  # four piers across the three openings, each 2 m by the full depth
        out.append(B(a, 0, 1.5 if abs(a) > 6 else 2, 8, 0, 5, st))
    out += [B(0, 0, 14, 8, 5, 6.5, st), B(0, 0, 14, 8, 6.5, 7, ("#cdc7ba", STONE))]
    out += [B(a, b, 1, 1, 7, 8, st) for a in range(-6, 7, 2) for b in (-3.5, 3.5)]  # the balustrade's posts
    out += [B(0, 0, 2, 1, 0.5, 1, ("#4b4b4e", STONE)), B(0, 1.5, 1, 1, 0.5, 1.5, ("#3b3b3b", METAL))]
    return out


def sappers():
    """Pomnik Chwała Saperom (1975, Stanisław Kulon), the 2025 ortho with Commons 2006-2026: six welded steel blades in
    a ring round the kneeling sapper, each leaning out from the centre, a mine's blast; a blade stands edge-on to the
    centre, 1.5 m by 1 m, on a pale block 8-9.5 m out wrapped in a bronze relief; a ring of paving round the sapper"""
    out = [B(0, 0, 3, 3, 0, 1, GRANITE),
           B(0, 0, 2, 2, 1, 2, SAPPER), B(0, 0, 2, 1, 2, 3, SAPPER), B(0, 0, 1, 1, 3, 4, SAPPER)]
    # bearing (clockwise from north) and distance of each blade's pale base block, read off the ortho (the shadows
    # start at them); heights from the shadows and the photos; each leans 2.5 m further out by its top
    for th, r0, h in ((16, 7.3, 15), (84, 9.0, 17), (148, 9.4, 16), (198, 9.5, 17), (256, 8.2, 14), (294, 9.0, 16)):
        u = (math.sin(math.radians(th)), math.cos(math.radians(th)))
        for z in range(h):
            r = r0 + 2.5 * max(z - 3, 0) / (h - 4)
            col = LIGHT if z < 2 else RELIEF if z < 4 else STEEL
            cells = radial(r, 1.4 if z < 4 else 0.8, u)
            if z < 4:  # the block is thicker than the blade
                cells += [(a + round(u[1]), b - round(u[0])) for a, b in cells]
            out += [B(a, b, 1, 1, z, z + 1, col) for a, b in dict.fromkeys(cells)]
    return out


def radial(r, half, u):
    """the whole cells of a radial run from r - half to r + half along u (a, b), each touching the last by a face"""
    cells = []
    for t in np.arange(r - half, r + half + 1e-6, 0.2):
        c = (round(t * u[0]), round(t * u[1]))
        if cells and c != cells[-1] and c[0] != cells[-1][0] and c[1] != cells[-1][1]:
            cells.append((c[0], cells[-1][1]))  # a diagonal step gets the cell between
        if not cells or c != cells[-1]:
            cells.append(c)
    return list(dict.fromkeys(cells))


MONUMENTS = {
    "Pomnik Chwała Saperom": dict(at=(21.041212, 52.228660), phi=0, parts=sappers()),
    "Pomnik Powstania Warszawskiego": dict(at=(21.005937, 52.249364), phi=18, parts=uprising()),
    # Konstanty Hegel 1855, a copy since 2008 (Commons 1960s-2019): in the middle of the Rynek's round basin a pale
    # grey stone pedestal 2 m over the water, the dark bronze mermaid on it, her tail coiled, the sword raised in her
    # right hand and the round shield on her left arm
    "Syrenka Staromiejska": dict(
        at=(21.012172, 52.249788), phi=0,
        parts=[B(0, 0, 2, 2, 0, 2, ("#b5b2aa", STONE)), B(0, 0, 2, 2, 2, 3, DARK_BRONZE), B(0, 0, 1, 1, 3, 4, DARK_BRONZE),
               B(1, 0, 1, 1, 3, 6, DARK_BRONZE), B(-1, 0, 1, 1, 3, 4, DARK_BRONZE)]),
    "Grób Nieznanego Żołnierza": dict(at=(21.011302, 52.240952), phi=90, parts=arcade(), clear=9),
    # Juliusz Słowacki, 2001, Ludmiła Stefanowicz (Commons 2009-2016): the poet, 4 m of dark bronze, cloak drawn round
    # him, on a tall polished black granite block over a low stepped base, before the Bank's palace, facing the theatre
    "Pomnik Juliusza Słowackiego": dict(
        at=(21.002319, 52.24285), phi=135, clear=4,
        parts=[B(0, 0, 6, 6, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 6, BLACK), B(0, 0, 2, 2, 6, 9, DARK_BRONZE),
               B(0.5, 0, 1, 1, 9, 10, DARK_BRONZE)]),
    # Charles de Gaulle, 2005, Jean Cardot (Commons): striding west to east in his greatcoat, 3.5 m of dark bronze on a
    # 4.5 m block of dark granite, in a round lawn ringed with steps
    "Pomnik Charles'a de Gaulle'a": dict(
        at=(21.021548, 52.23151), phi=90, clear=4,
        parts=[B(0, 0, 8, 8, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 5, DARK_GRANITE),
               B(0, -0.5, 1, 1, 5, 7, DARK_BRONZE), B(0, 0.5, 1, 1, 5, 7, DARK_BRONZE), B(0, 0, 1, 2, 7, 8, DARK_BRONZE),
               B(0, 0, 1, 1, 8, 9, DARK_BRONZE)]),
    # Napoleon, 2011 (Commons 2011-2023): his bust in bicorne, the eagles under it, dark bronze on a tall pale granite
    # stele with the N, on a two-step base in the middle of Plac Zawiszy's footway, facing north
    "Pomnik Napoleona": dict(
        at=(21.013782, 52.23422), phi=0, clear=3,
        parts=[B(0, 0, 4, 4, 0, 1, GRANITE), B(0, 0, 2, 2, 1, 4, PALE_GRANITE), B(0, 0, 2, 1, 4, 5, DARK_BRONZE),
               B(0, 0, 1, 1, 5, 6, DARK_BRONZE)]),
    # Matka Boska Passawska, 1683 (Commons 1930s-2023): the crowned Madonna and child in pale sandstone on a tall
    # stepped pedestal behind a railing with two lamps, under the trees by the church, facing the street (west)
    "Matka Boska Passawska": dict(
        at=(21.014199, 52.245052), phi=270, clear=3,
        parts=[B(0, 0, 4, 4, 0, 1, SAND), B(0, 0, 2, 2, 1, 5, SAND), B(0, 0, 2, 2, 5, 6, SAND),
               B(0, 0, 1, 1, 6, 8, ("#e3d8c2", STONE)), B(0, 0, 1, 1, 8, 9, ("#c9a24a", METAL))]
              + [B(x, -2.5, 1, 1, 0, 4, BLACK) for x in (-2, 2)]),
    # Bartolomeo Colleoni, 1931, a cast of Verrocchio's (Commons 2010-2020): the condottiere in armour on his horse in
    # green-grey bronze over a 2 m stone block, in the Academy of Fine Arts' garden, riding north
    "Pomnik Colleoniego": dict(
        at=(21.015545, 52.239365), phi=0, clear=4,
        parts=[B(0, 0, 3, 6, 0, 2, ("#8d8a83", STONE)), B(0, 0, 2, 5, 2, 2.5, ("#8d8a83", STONE))]
              + rider(0, 0, 2, PATINA, arm=True)),
    # Bolesław Prus, 1977, Anna Kamieńska-Łapińska (Commons): the writer, a gaunt 4.5 m figure in a long coat, rough
    # dark bronze, on a low granite slab among the shrubs by Krakowskie Przedmieście
    "Pomnik Bolesława Prusa": dict(
        at=(21.016377, 52.24173), phi=270, clear=4,
        parts=[B(0, 0, 3, 2, 0, 1, GRANITE), B(0, 0, 2, 1, 1, 5, WORN_BRONZE), B(0, 0, 1, 1, 5, 6, WORN_BRONZE)]),
    # Praska Kapela Podwórkowa, 2006, Andrzej Renes (Commons): five street musicians in brown bronze, life size, in a
    # loose ring on the pavement of Ząbkowska and Brzeska: fiddle, banjo, accordion, guitar, the drummer seated
    "Pomnik Praskiej Kapeli Podwórkowej": dict(
        at=(21.034164, 52.251668), phi=180, clear=4,
        parts=[B(x, y, 1, 1, 0, 2, ("#6b5845", METAL)) for x, y in ((-2, 0), (-1, 1.5), (0.5, 2), (2, 1), (1.5, -0.5))]),
    # Ronald Reagan, 2011, Wiesław Zawadzki (Commons 2011-2020): a dark bronze figure from the waist up behind a red
    # granite stele with the presidential seal, the bronze flag falling down its side, on a pale stone platform
    "Pomnik Ronalda Reagana": dict(
        # facing the US embassy across Aleje Ujazdowskie (west; Commons 2011: seen from behind with the embassy ahead)
        at=(21.024177, 52.224646), phi=270, clear=5,
        parts=[B(0, 0, 4, 4, 0, 0.5, PALE_GRANITE), B(0, 0.5, 2, 1, 0.5, 3, ("#8c3b2e", STONE)),
               B(0, -0.5, 2, 1, 0.5, 3.5, DARK_BRONZE), B(0, -0.5, 1, 1, 3.5, 4.5, DARK_BRONZE),
               B(1.2, 0.2, 1, 1, 0.5, 3.5, GREY_BRONZE)]),
    # Roman Dmowski, 2006, Kazimierz Gustaw Zemła (Commons): a 5 m figure in a long coat, hat in hand, in dark rough
    # bronze, on a low dark plinth on Plac Na Rozdrożu; at the back of the paved square the 2025 ortho shows (OSM's point
    # is in the trees beside it), facing the avenue north-west, the trees behind him as in every photo
    "Pomnik Romana Dmowskiego": dict(
        at=(21.025081, 52.218569), phi=315, clear=4,
        parts=[B(0, 0, 4, 4, 0, 0.5, GRANITE), B(0, 0, 2, 2, 0.5, 5, DARK_BRONZE), B(0, 0, 1, 1, 5, 6, DARK_BRONZE)]),
    # Kamień milowy, the zero mile of Polish roads (Commons): a 3 m dark granite pier, bronze tablets with the distances
    # to the cities on its faces, at the corner of Emilii Plater and Aleje Jerozolimskie
    "Kamień Milowy": dict(
        at=(21.010979, 52.230021), phi=0, clear=2,
        parts=[B(0, 0, 1, 1, 0, 3, ("#4f504d", STONE)), B(0, 0, 1, 1, 3, 4, ("#b08a4a", METAL))]),
    # the Polish Army Museum's open-air display by Aleje Jerozolimskie (2025 ortho: each aircraft's place, heading,
    # length and span; OSM maps none): jets, a transport and a camouflaged bomber on the grass
    "Samolot MWP A": dict(at=(21.026237, 52.232404), phi=143, parts=plane(15, 9, "#c9ccc8")),
    "Samolot MWP B": dict(at=(21.026267, 52.232301), phi=155, parts=plane(16, 10, "#c4c8c4")),
    "Samolot MWP C": dict(at=(21.026481, 52.232057), phi=135, parts=plane(17, 18, "#e2e2dd")),
    "Samolot MWP D": dict(at=(21.026607, 52.231817), phi=41, parts=plane(26, 22, "#7f8b6c")),
    "Samolot MWP E": dict(at=(21.026641, 52.2316), phi=117, parts=plane(15, 8, "#a6aaa6")),
    "Samolot MWP F": dict(at=(21.025838, 52.231589), phi=120, parts=plane(12, 7, "#9fa59c")),
    "Samolot MWP H": dict(at=(21.026043, 52.231453), phi=150, parts=plane(14, 9, "#9aa19a")),
    "Samolot MWP I": dict(at=(21.026236, 52.231495), phi=30, parts=plane(12, 8, "#a3a8a2")),
    "Brama Uniwersytecka": dict(at=(21.017197, 52.239798), phi=0, parts=uw_gate(), clear=6),
    # Plac Konstytucji's three candelabra (1952; Commons 2018-2026, the raw LiDAR's 18-22 m posts at these cells)
    "Kandelabr Plac Konstytucji zachodni": dict(at=(21.01606, 52.221722), phi=0, parts=candelabrum(22), clear=3),
    "Kandelabr Plac Konstytucji środkowy": dict(at=(21.016492, 52.221808), phi=0, parts=candelabrum(18), clear=3),
    "Kandelabr Plac Konstytucji wschodni": dict(at=(21.016931, 52.221935), phi=0, parts=candelabrum(18), clear=3),
    "Palma": dict(at=(21.020867, 52.231846), phi=0, parts=palm(), clear=5),
    "Saperzy nad Wisłą": dict(at=(21.044794, 52.228289), phi=301,  # its other half, off the Czerniakowski bridgehead
                              # (Commons 2022): a dark steel post in the water by the steps, pale figures on it
                              parts=[B(0, 0, 1, 1, 0, 4, BLACK), B(0, 0, 2, 2, 4, 4.5, LIGHT)]
                              + standing(0, 0, 4.5, 3, SILVER)),
    "Pomnik Mikołaja Kopernika": dict(  # Thorvaldsen 1830 (Commons 2004-2020): the astronomer seated on a stone
        at=(21.017972, 52.238155), phi=0,  # block, the armillary sphere held out in his left hand, in dark bronze
        parts=[B(0, 0, 7, 8, 0, 1, RED_GRANITE), B(0, 0, 4, 5, 1, 2, DARK_GRANITE),  # on a dark granite pedestal
               B(0, 0, 3, 4, 2, 5, DARK_GRANITE), B(0, 0, 4, 5, 5, 6, DARK_GRANITE),  # over a red granite step,
               B(0, -1, 2, 2, 6, 7, DARK_BRONZE), B(0, 0.5, 2, 2, 6, 7, DARK_BRONZE),  # facing the street, his
               B(0, -0.5, 2, 1, 7, 9, DARK_BRONZE), B(0.5, -0.5, 1, 1, 9, 10, DARK_BRONZE),  # back to the palace
               B(-0.5, 1, 1, 1, 7, 9, DARK_BRONZE)]),
    # 1948, Rapoport and Suzin (Commons 1948-2024): an 11 m block of grey granite slabs, a little narrower at the top,
    # on a dark platform; the fighters' tall relief in its west face, the march to death wide and low in the east, the
    # two menorahs either side of the steps
    "Pomnik Bohaterów Getta": dict(
        at=(20.994216, 52.249741), phi=270,
        parts=[B(0, 0, 22, 12, 0, 1, DARK_GRANITE), B(0, 0, 10, 4, 1, 12, ("#68655f", STONE), top=0.85),
               B(0, 1.5, 3, 1, 2, 9, DARK_BRONZE), B(0, -1.5, 7, 1, 3, 5, DARK_BRONZE),
               B(-6, 4, 1, 1, 1, 3, DARK_BRONZE), B(6, 4, 1, 1, 1, 3, DARK_BRONZE)]),
    # Pomnik Bohaterów Warszawy (1964, Marian Konieczny; Commons 1974-2020): a slender sandstone shaft of 14 m,
    # narrowing upwards, and on it the dark bronze Nike lunging low along its top, the sword held level over her head
    # and reaching far past the shaft
    "Pomnik Nike": dict(
        at=(21.009183, 52.245897), phi=112,
        parts=[B(0, 0, 3, 4, 0, 14, SAND, top=0.75),
               B(0, -1.5, 2, 3, 14, 15, DARK_BRONZE), B(0, 0, 2, 2, 15, 16, DARK_BRONZE),
               B(0, 1, 2, 1, 16, 17, DARK_BRONZE), B(0.5, 1.5, 1, 1, 17, 18, DARK_BRONZE),
               B(-0.5, 0.5, 1, 1, 17, 19, DARK_BRONZE), B(-0.5, -0.5, 1, 6, 19, 20, DARK_BRONZE)]),
    # Thorvaldsen 1832 (Commons 1920s-2023): the prince on horseback over a dark granite pedestal on a pale step, in
    # the Presidential Palace's courtyard, riding out to Krakowskie Przedmieście (west)
    "Pomnik Józefa Poniatowskiego": dict(
        at=(21.015480, 52.242803), phi=270,
        parts=[B(0, 0, 5, 8, 0, 1, GRANITE), B(0, 0, 3, 6, 1, 5, DARK_GRANITE)] + rider(0, 0, 5, DARK_BRONZE, arm=True)),
    # Cyprian Godebski 1898 (Commons): the 4.5 m poet in dark bronze over a pinkish granite pedestal, its lower block
    # hung with bronze garlands, a slender shaft and capital, on a balustraded terrace with steps and four lamps;
    # he faces Krakowskie Przedmieście (west), the Carmelite church to his left
    "Pomnik Adama Mickiewicza": dict(
        at=(21.014857, 52.243726), phi=270,
        parts=[B(0, 0, 13, 13, 0, 1, GRANITE), B(0, 0, 11, 11, 1, 2, PINK_GRANITE),
               B(0, 0, 4, 4, 2, 4, PINK_GRANITE), B(0, 0, 4, 4, 4, 5, DARK_BRONZE), B(0, 0, 2, 2, 5, 9, PINK_GRANITE),
               B(0, 0, 3, 3, 9, 10, PINK_GRANITE)]
              + standing(0, 0, 10, 5, DARK_BRONZE)
              + [B(x, y, 1, 1, 2, 6, DARK_BRONZE) for x in (-5, 5) for y in (-5, 5)]),
    # 1995, Tadeusz Łodziana (Commons): the marshal in his greatcoat, 4 m of dark grey-green bronze, on a near-black
    # granite pedestal over a round grey base, by the Europejski, looking west over the square
    "Pomnik Józefa Piłsudskiego": dict(
        at=(21.014130, 52.241393), phi=270,
        parts=[B(0, 0, 5, 5, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 5, DARK_GRANITE), B(0, 0, 2, 2, 5, 7, GREY_BRONZE)]
              + standing(0, 0, 7, 2, GREY_BRONZE)),
    # 2021 (Commons 2021-2024): the president, 3.5 m of dark bronze, hand on his chest, on a light grey granite block
    # whose front a dark bronze sheet wraps, over a low stepped platform; he faces the square (north-north-west, here
    # north), the cream garrison building behind him
    "Pomnik Lecha Kaczyńskiego": dict(
        at=(21.014063, 52.240900), phi=0,
        parts=[B(0, 0, 8, 8, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 4, ("#c4c1ba", STONE)), B(0, 1.5, 3, 1, 1, 4, DARK_BRONZE),
               B(0, 0, 2, 2, 4, 6, DARK_BRONZE)]
              + standing(0, 0, 6, 2, DARK_BRONZE)),
    # 2018 (Commons 2018-2022): a 2 m thick slab of black granite whose top is a long stair rising to 6.5 m at the
    # end with the eagle and the wreaths; the glass over the pit around it lies flush with the paving
    "Pomnik Ofiar Tragedii Smoleńskiej": dict(
        at=(21.012757, 52.240658), phi=0,
        parts=[B(0, 0, 6, 13, 0, 0.5, ("#5f8f94", 2))] + [B(0, -4 + k, 2, 1, 0, 0.75 * (k + 1), BLACK) for k in range(9)]),
    # 1985, Bronisław Koniuszy (Commons 2008-2023): a 10 m soldier in a hooded rain cape that flares to its foot,
    # weathered dark bronze, his left arm flung up and out, on a low dark plinth; the ortho's shadow has the arm
    # reaching west, so he faces north
    "Pomnik Kościuszkowców": dict(
        at=(21.030788, 52.248040), phi=0,
        parts=[B(0, 0, 9, 6, 0, 1, DARK_GRANITE), B(0, 0, 7, 4, 1, 6, WORN_BRONZE, top=0.75),
               B(0, 0, 5, 3, 6, 9, WORN_BRONZE, top=0.6), B(0, 0, 2, 2, 9, 11, WORN_BRONZE)]
              + [B(-1.5 - k, 0, 1, 1, 8 + k, 10 + k, WORN_BRONZE) for k in range(5)]),
    # 1999 (Commons 2010-2024): a light grey granite blade, narrowing as it rises to 32 m, the dark bronze anchor of
    # Polska Walcząca low on its face, its foot curving out into a long low wall: TOBIE OJCZYZNO - ARMIA KRAJOWA
    "Pomnik Armii Krajowej": dict(
        at=(21.026323, 52.225180), phi=90,
        parts=[B(0, 0, 4, 2, 0, 32, ("#d6d3cc", STONE), top=0.5), B(0, 1, 2, 1, 3, 6, DARK_BRONZE)]
              + [B(2.5 + k, 0, 1, 2, 0, h, ("#d6d3cc", STONE)) for k, h in enumerate([6, 4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2])]),
    # 1994, Mieczysław Welter (Commons 2008-2012): on a mound with steps, a black block naming the cavalry's battles,
    # a slender pale green column to 20 m, and over its small capital two dark bronze riders galloping side by side,
    # a modern lancer with his sabre out and a winged hussar
    "Pomnik Jazdy Polskiej": dict(
        at=(21.014494, 52.216535), phi=0,
        parts=[B(0, 0, 2, 2, 0, 6, BLACK), B(0, 0, 1, 1, 6, 20, ("#a6b0a3", STONE)), B(0, 0, 2, 4, 20, 21, DARK_BRONZE)]
              + rider(-0.5, 0, 21, DARK_BRONZE, arm=True) + rider(0.5, 0, 21, DARK_BRONZE)
              + [B(0.5, -1.5, 1, 1, 26, 27, DARK_BRONZE), B(0.5, -2.5, 1, 1, 26, 28, DARK_BRONZE)]),  # the hussar's wing
    # 2010, a copy of Antoni Popiel's Washington monument (Commons): the general in copper-brown bronze on a grey
    # granite pedestal over a stepped platform; at its foot the eagle spreading its wings on a half globe (front) and
    # the soldier groups at the sides and back; the Lubomirski Palace behind him, he faces east over the square
    "Pomnik Tadeusza Kościuszki": dict(
        at=(21.002461, 52.239602), phi=90,
        parts=[B(0, 0, 13, 13, 0, 1, GRANITE), B(0, 0, 9, 9, 1, 2, GRANITE), B(0, 0, 3, 3, 2, 7, MID_GRANITE),
               B(0, 2.5, 2, 2, 2, 3, COPPER), B(0, 2.5, 4, 1, 3, 4, COPPER),
               B(2.5, 0, 1, 1, 2, 4, COPPER), B(-2.5, 0, 1, 1, 2, 4, COPPER), B(0, -2.5, 1, 1, 2, 4, COPPER)]
              + standing(0, 0, 7, 3, COPPER)),
    # 1995, Maksymilian Biskupski (Commons): a railway flatcar packed with a thicket of dark bronze crosses to 7 m, the
    # eagle among them, on a track whose sleepers each name a place of Soviet murder
    "Pomnik Poległym i Pomordowanym na Wschodzie": dict(
        at=(20.998874, 52.253780), phi=106,
        parts=[B(0, 0, 4, 8, 0, 1, BLACK), B(0, 0, 4, 8, 1, 2, DARK_BRONZE)] + crosses(4, 8, 2)
              + [B(0, -10, 3, 12, 0, 1, DARK_BRONZE)]),
    # Stanisław Jackowski 1936 (Commons 1936-2023): the cobbler in his long coat, 4 m of dark bronze, the sabre high in
    # his right hand, the left arm out, on a slim dark granite pedestal as tall; he faces south, the walls behind him
    "Pomnik Jana Kilińskiego": dict(
        at=(21.010865, 52.248222), phi=180,
        parts=[B(0, 0, 7, 7, 0, 1, GRANITE), B(0, 0, 2, 2, 1, 5, DARK_GRANITE),
               B(0, 0, 2, 2, 5, 7, DARK_BRONZE), B(0, 0, 2, 1, 7, 8, DARK_BRONZE), B(0.5, 0, 1, 1, 8, 9, DARK_BRONZE),
               B(1.5, 0, 1, 1, 7, 11, DARK_BRONZE), B(-1.5, 0, 1, 1, 7, 8, DARK_BRONZE)]),
    # 1945-1963, Bazyli Wojtowicz (Commons): a 6 m soldier hewn in grey granite, helmeted, his gun across his chest,
    # his coat to the boots, on a squat tapering pedestal over a stepped platform
    "Pomnik Żołnierzy 1 Armii WP": dict(
        at=(20.998243, 52.248198), phi=180,
        parts=[B(0, 0, 9, 7, 0, 1, GRANITE), B(0, 0, 3, 3, 1, 4, GRANITE, top=0.9),
               B(0, 0, 3, 2, 4, 9, ("#a8a49c", STONE)), B(0, 0, 1, 1, 9, 10, ("#a8a49c", STONE))]),
    # 1999, Gustaw Zemła (Commons): a broad, broken column of white marble, Nike's wings opening from its top into a
    # V to 15 m, on a long marble base with rough slanted ends and the Monte Cassino cross
    "Pomnik Monte Cassino": dict(
        at=(21.000386, 52.247154), phi=210,
        parts=[B(0, 0, 6, 4, 0, 2, MARBLE), B(-3.5, 0, 1, 3, 0, 1, MARBLE), B(3.5, 0, 1, 3, 0, 1, MARBLE),
               B(0, -0.5, 3, 2, 2, 11, MARBLE, top=0.85)]
              + [B(k * (1 + j), -0.5, 1, 1, 11 + j, 13 + j, MARBLE) for k in (-1, 1) for j in range(3)]),
    # 2022, Monika Osiecka (Commons 2022-2024): three women in brown bronze, life and a half size, close in a shallow
    # arc on a round bronze plate over a light grey granite plinth
    "Pomnik Kobietom Powstania Warszawskiego": dict(
        at=(21.004628, 52.248968), phi=180,
        parts=[B(0, 0, 4, 4, 0, 1, GRANITE)] + [B(x, y, 1, 1, 1, 3, ("#6b5845", METAL)) for x, y in ((-1, -0.5), (0, 0.5), (1, -0.5))]),
    # Jerzy Jarnuszkiewicz 1983 (Commons): the boy in a big helmet, 1.3 m of dark bronze, on a dark brown post, his
    # back to the city walls and the raised half-round brick terrace before them (east); he faces west
    "Mały Powstaniec": dict(
        at=(21.009620, 52.249274), phi=270,
        parts=[B(0, -2.5, 6, 3, 0, 1, ("#a0523d", STONE)), B(0, 0, 1, 1, 0, 2, ("#4a3428", STONE)),
               B(0, 0, 1, 1, 2, 3, DARK_BRONZE)]),
    "Miła 18": dict(at=(20.992342, 52.251514), phi=0,  # the stone on the mound over the ŻOB bunker
                    parts=[B(0, 0, 1, 1, 0, 3, ("#9a978f", STONE))]),
    # Ludwika Nitschowa 1939 (Commons 2019-2024): the 2.75 m mermaid in dark green bronze, seated on her tail, the
    # sword high in her right hand, the round shield on her left, on a stepped sandstone pedestal; she faces west,
    # the stadium behind her
    "Syrenka": dict(
        at=(21.032085, 52.240239), phi=270,
        parts=[B(0, 0, 5, 5, 0, 1, SAND), B(0, 0, 3, 3, 1, 3, SAND),
               B(0, 0, 2, 2, 3, 4, MERMAID), B(0, 0, 2, 1, 4, 5, MERMAID), B(0.5, 0, 1, 1, 5, 6, MERMAID),
               B(1.5, 0, 1, 1, 5, 7, MERMAID), B(-1.5, 0, 1, 1, 4, 5, MERMAID)]),
}


def attach(vol, g, rc, zmax):
    """a thin piece turned off the grid (a sword, an arm, a crossbar) can come to touch the rest only by an edge once
    its cells are whole: each piece of the monument's box not held by the ground gets a straight run of its own
    voxels, axis by axis, to the nearest voxel that is"""
    from scipy import ndimage
    r0, c0 = rc.min(0) - 1
    r1, c1 = rc.max(0) + 2
    zlo = int(g[r0:r1, c0:c1].min()) - 1
    box = vol[zlo:zmax + 3, r0:r1, c0:c1]
    for _ in range(8):
        lab, n = ndimage.label(box != 0)
        held = set(np.unique(lab[0]).tolist()) - {0}
        loose = [i for i in range(1, n + 1) if i not in held]
        if not loose:
            return
        for i in loose:
            pts = np.argwhere(lab == i)
            fix = np.argwhere((lab != 0) & (lab != i))
            d = ((pts[:, None, :] - fix[None, :, :]) ** 2).sum(-1)
            a, b = np.unravel_index(np.argmin(d), d.shape)
            p, q = pts[a].copy(), fix[b]
            v = box[tuple(p)]
            for ax in (1, 2, 0):  # across first, then down, so a sword joins the arm that holds it
                while p[ax] != q[ax]:
                    p[ax] += 1 if q[ax] > p[ax] else -1
                    if box[tuple(p)] == 0:
                        box[tuple(p)] = v


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
        if m.get("clear"):  # what stood there in the LiDAR, crowns and trunks too (the Palm read as a leafy tree)
            near = np.hypot(dc, dr) <= m["clear"]
            for r, c in zip(rr[near], cc[near]):
                vol[g[r, c]:, r, c] = 0
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
        attach(vol, g, allrc, zmax)
        note(f"monument {name} at ({int(r0)}, {int(c0)}), {zmax - z0} m")
    return mon_top
