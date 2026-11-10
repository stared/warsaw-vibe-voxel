"""Road + pedestrian graphs with real signal positions for the live simulation (web/src/sim/life.ts).

Output traffic.json, coordinates in grid metres (x = col, y = row) with z = walking/driving surface voxel level.
- roads: directed edges between junctions (OSM ways split at shared nodes), lanes per direction, speed,
  optional stop line {s, ctrl, axis} for traffic signals (OSM highway=traffic_signals + traffic_signals:direction)
- ctrls: signal controllers = signal nodes clustered per junction (<= 45 m); each runs a two-axis cycle
- peds: undirected footpath edges; signalled crossings carry {ctrl, axis}
Axis 0/1 = travel roughly along grid x / grid y (the grid is aligned to the Śródmieście street grid).
"""
import json
from collections import Counter
import math
from collections import defaultdict

import numpy as np
from pyproj import Transformer
from scipy.ndimage import grey_closing, maximum_filter1d
from shapely.geometry import LineString

from aoi import D, RAW, W, to_grid

DRIVE = {"motorway": 22, "trunk": 16, "primary": 14, "secondary": 13.9, "tertiary": 12.5, "unclassified": 11,
         "residential": 9, "motorway_link": 14, "trunk_link": 12, "primary_link": 11, "secondary_link": 11,
         "tertiary_link": 10}
CLASS = {"primary": 3, "trunk": 3, "secondary": 3, "tertiary": 2, "unclassified": 1, "residential": 1}
WALK = {"footway", "pedestrian", "path", "steps", "living_street", "platform", "cycleway"}

_T = Transformer.from_crs(4326, 2180, always_xy=True)


def _num(v, default=None):
    try:
        return float(str(v).split(";")[0].split()[0].replace(",", "."))
    except (ValueError, IndexError, AttributeError):
        return default


OPEN_CUT = set()  # layer -1 ways that are open cuts, not tunnels (voxelize.py)


def underground(t):
    return (t.get("tunnel") in ("yes", "building_passage") or _num(t.get("layer"), 0) < 0 or t.get("indoor") == "yes"
            or t.get("location") == "underground" or (_num(t.get("level"), 0) or 0) < 0 or t.get("covered") == "yes")


def fit(p, offs, vol, solid, W, D, step=0.5, decks=False):
    """a path's heights onto the voxels as drawn: every 0.5 m, across the offsets the bodies use, the free level over
    the drawn surface nearest the path's own height (a deck, not the street under it); the highest across, then over
    1 m along, so a body rises before a step instead of cutting into it. Returns the points (the path's corners and
    where the height changes), metres lifted, and the longest run in metres where some offset has no free level (in a wall)."""
    P = np.array(p, float)
    seg = np.hypot(*np.diff(P[:, :2], axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] < step:
        return p, 0, 0
    s = np.unique(np.concatenate([np.arange(0, cum[-1], step), cum]))
    x, y, z0 = (np.interp(s, cum, P[:, k]) for k in range(3))
    k = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(P) - 2)
    t = (P[k + 1, :2] - P[k, :2]) / np.maximum(seg[k], 1e-6)[:, None]
    H = vol.shape[0]
    zi = np.floor(z0 + 0.5).astype(int)
    # an end whose height is no drawn surface (a bridge's last node reading the higher deck of the ramp beside it):
    # the path ramped 8 m through the air to it. It takes the height of the first point within 8 m that stands on one
    cx, cy = np.clip(x.astype(int), 0, W - 1), np.clip(y.astype(int), 0, D - 1)
    on = np.zeros(len(s), bool)
    for dz in (0, 1, -1):
        zz = np.clip(zi + dz, 1, H - 2)
        on |= solid[vol[zz - 1, cy, cx]] & ~solid[vol[zz, cy, cx]]
    for end in (np.arange(len(s)), np.arange(len(s))[::-1]):
        k = next((j for j in end[:int(8 / step) + 1] if on[j]), None)
        if k is not None and k != end[0] and abs(zi[k] - zi[end[0]]) >= 2:
            sel = end[:list(end).index(k)]
            z0[sel], zi[sel] = z0[k], zi[k]
    best = np.full(len(s), -99)
    blocked = np.zeros(len(s), bool)
    for o in offs:
        c = np.clip((x - t[:, 1] * o).astype(int), 0, W - 1)
        r = np.clip((y + t[:, 0] * o).astype(int), 0, D - 1)
        cand = np.full(len(s), -99)
        for dz in (0, 1, -1):  # the surface steps a metre at a time; the decks are in the path's height already
            zz = np.clip(zi + dz, 1, H - 2)
            free = solid[vol[zz - 1, r, c]] & ~solid[vol[zz, r, c]] & ~solid[vol[zz + 1, r, c]]
            cand = np.where((cand == -99) & free, zz, cand)
        blocked |= cand == -99
        best = np.maximum(best, cand)
    best = np.where(best == -99, zi, best)
    # a way not tagged as a bridge leaving a deck (Poniatowski's east end, past the gate towers) has its nodes at the
    # street under the deck: the path dipped under the deck and climbed back to the embankment. Where the path runs
    # lower than on both sides within 20 m, and the drawn surface at that higher level is free, it takes it (vehicles
    # only: a walkers' underpass is meant to dip under the street)
    hi = grey_closing(best, size=41) if decks else best
    c0 = np.clip(x.astype(int), 0, W - 1); r0 = np.clip(y.astype(int), 0, D - 1)
    zh = np.clip(hi, 1, H - 2)
    deck = (hi > best) & (hi - best <= 9) & solid[vol[zh - 1, r0, c0]] & ~solid[vol[zh, r0, c0]] & ~solid[vol[zh + 1, r0, c0]]
    best = np.where(deck, hi, best)
    zf = maximum_filter1d(best, 5)
    run = longest = 0
    for b in blocked:
        run = run + 1 if b else 0
        longest = max(longest, run)
    corner = np.isin(s, cum)
    change = np.r_[True, zf[1:] != zf[:-1]] | np.r_[zf[:-1] != zf[1:], True]
    out = [[round(float(a), 1), round(float(b), 1), int(h)] for a, b, h, m in zip(x, y, zf, corner | change) if m]
    return out, int((zf > z0 + 0.5).sum() * step), longest * step


# Riders per hour on a bike way, relative: ZDM's counts (2023 video counts at 53 points, 25 counters; 2025: 66 and 31)
# put Świętokrzyski and Łazienkowski bridges at ~7000 a day, the other Vistula bridges at 1200-4200, Bulwar Pattona
# by Świętokrzyski the busiest point of all, the main corridors (Al. Ujazdowskie, Towarowa, Czerniakowska) at
# 800-1200 an hour at the peak; a bike way elsewhere carries a few hundred a day
BIKE_BRIDGES = {"Most Świętokrzyski": 6, "Most Łazienkowski": 6, "Most Gdański": 4, "Most Siekierkowski": 3,
                "Most Śląsko-Dąbrowski": 2.5, "Most Poniatowskiego": 2, "Most Grota-Roweckiego": 2.5}


def bike_weight(t):
    """how much a way is ridden, relative to an ordinary bike way (1); 0 where bikes are not ridden"""
    hw = t.get("highway")
    bike = hw == "cycleway" or t.get("bicycle") == "designated" or (hw == "path" and t.get("bicycle") != "no")
    if not bike or t.get("bicycle") in ("no", "dismount"):
        return 0
    name = t.get("name", "") + " " + t.get("bridge:name", "")
    for b, wt in BIKE_BRIDGES.items():
        if b in name:
            return wt
    if "Bulwar" in name or "Wybrzeże" in name:
        return 4
    return 1 if hw == "cycleway" or t.get("bicycle") == "designated" else 0.3


def bike_open(t):
    """a footway or crossing riders may take between bike ways (bicycle=yes, a crossing of a cycle path)"""
    return t.get("bicycle") in ("yes", "permissive") or t.get("cycleway") == "crossing" or "bicycle" in t.get("crossing", "")


def join_bike_ways(peds, pn, note, nodes_xy=None, fit_ok=None):
    """The bike ways as OSM has them break off: at a crossing mapped as a footway, where a path stops a few metres short
    of the next, where a stretch through a wall was dropped. From every dead end of the bike network the shortest way
    to another part of it is opened to riders: first over ways open to bikes (bicycle=yes, the crossings), then over
    any footway, up to 120 m; a dead end with no such way to a bike way within 12 m gets a straight link to it"""
    import heapq
    adj = defaultdict(list)
    for i, e in enumerate(peds):
        adj[e["a"]].append((i, e["b"])); adj[e["b"]].append((i, e["a"]))
    par = {}

    def root(n):
        while par.setdefault(n, n) != n:
            par[n] = par[par[n]]
            n = par[n]
        return n
    for e in peds:
        if e.get("bk"):
            par[root(e["a"])] = root(e["b"])
    deg = defaultdict(int)
    for e in peds:
        if e.get("bk"):
            deg[e["a"]] += 1; deg[e["b"]] += 1
    opened = 0
    for n0 in [n for n, k in deg.items() if k == 1]:
        r0 = root(n0)
        best = {n0: (0.0, None)}
        q = [(0.0, n0)]
        while q:
            d, n = heapq.heappop(q)
            if d > best[n][0]:
                continue
            if n != n0 and deg.get(n) and root(n) != r0:
                k = n  # reached another part: open the way back
                while best[k][1] is not None:
                    i, prev = best[k][1]
                    if not peds[i].get("bk"):
                        peds[i]["bk"] = 0.3
                        opened += 1
                    k = prev
                par[r0] = root(n)
                break
            for i, m in adj[n]:
                e = peds[i]
                cost = e["L"] * (1 if e.get("bk") or e.get("bko") else 1.5)
                nd = d + cost
                if nd <= 120 and nd < best.get(m, (1e9,))[0]:
                    best[m] = (nd, (i, n))
                    heapq.heappush(q, (nd, m))
    linked = 0
    if nodes_xy is not None:  # gaps: OSM's ways stopping short of each other, stretches dropped as through a wall
        from scipy.spatial import cKDTree
        z_of = {}
        for e in peds:
            if e.get("bk"):
                z_of[e["a"]] = e["p"][0][2]; z_of[e["b"]] = e["p"][-1][2]
        deg2 = defaultdict(int)
        for e in peds:
            if e.get("bk"):
                deg2[e["a"]] += 1; deg2[e["b"]] += 1
        bn = list(deg2)
        tree = cKDTree([nodes_xy[n] for n in bn])
        for n0 in [n for n, k in deg2.items() if k == 1]:
            x0, y0 = nodes_xy[n0]
            cand = sorted((math.dist((x0, y0), nodes_xy[bn[i]]), bn[i]) for i in tree.query_ball_point((x0, y0), 12) if bn[i] != n0)
            for dd, m in cand:
                if dd < 1 or any(e["a"] in (n0, m) and e["b"] in (n0, m) for e in peds[-50:]):
                    continue
                x1, y1 = nodes_xy[m]
                k = max(2, int(dd))
                p = [[round(x0 + (x1 - x0) * i / k, 1), round(y0 + (y1 - y0) * i / k, 1),
                      int(round(z_of[n0] + (z_of[m] - z_of[n0]) * i / k))] for i in range(k + 1)]
                if fit_ok is not None and not fit_ok(p):
                    continue
                peds.append(dict(a=n0, b=m, p=p, L=round(dd, 1), w=0.3, bk=0.5))
                par[root(n0)] = root(m)
                linked += 1
                break
    for e in peds:
        e.pop("bko", None)
    size = defaultdict(float)  # a scrap of bike way left on its own (under 300 m) is drawn, not ridden
    for e in peds:
        if e.get("bk"):
            size[root(e["a"])] += e["L"]
    for e in peds:
        if e.get("bk") and size[root(e["a"])] < 300:
            del e["bk"]
    comps = len({root(n) for n in deg if size[root(n)] >= 300})
    note(f"traffic: bike network joined across {opened} footway links and {linked} short gaps, {comps} parts left")



def trim_portal(p, reach=8.0):
    """a route piece cut at a tunnel starts on its portal node, in the retaining wall's top cell: the fitted path
    ramped down the wall (a tram diving 11 m at the W-Z tunnel). Points standing 2 m or more over the lowest point
    within `reach` m on from them are dropped, at both ends"""
    def head(q):
        k = 0
        while k < len(q) - 2:
            s0, lo = 0.0, q[k][2]
            for j in range(k + 1, len(q)):
                s0 += math.hypot(q[j][0] - q[j - 1][0], q[j][1] - q[j - 1][1])
                if s0 > reach:
                    break
                lo = min(lo, q[j][2])
            if q[k][2] - lo < 2:
                break
            k += 1
        return q[k:]
    return head(head(p)[::-1])[::-1]

def build(g, nd_mean, note, surf=None, water=None, vol=None, solid=None, roofs=None, paths=()):
    """surf: (D, W) uint8, 1 = carriageway, 2 = tram bed; used to validate OSM lane counts against the paving.
    nd_mean: height of the walking/driving surface above the ground where it is a bridge deck (voxelize.py passes the
    deck height: the lowest LiDAR return around, not the cars or cable stays the 2025 flight caught on it).
    vol, solid: the finished volume and which palette ids bear weight; every path is then fitted to it (fit)."""
    data = json.load(open(f"{RAW}/osm.json"))
    # nodes of any bridge way (road, path, tram, rail): drawn on the deck, so agents there move at deck height
    # (ways that carry traffic only: a bridge's outline, man_made=bridge, shares nodes with the street passing under
    # it -- cars on Wybrzeże Kościuszkowskie jumped 9 m up onto Poniatowski's viaduct and back down)
    bridge_nodes = {n for e in data["elements"] if e["type"] == "way" and e.get("tags", {}).get("bridge") not in (None, "no")
                    and ("highway" in e["tags"] or "railway" in e["tags"]) for n in e.get("nodes", [])}
    nodes = {}  # id -> (x, y) grid
    ntags = {}
    ways = []
    for e in data["elements"]:
        if e["type"] == "node" and e.get("tags"):
            ntags[e["id"]] = e["tags"]
        if e["type"] != "way" or "highway" not in e.get("tags", {}):
            continue
        geo = e.get("geometry") or []
        if len(geo) != len(e["nodes"]):
            continue
        for nid, p in zip(e["nodes"], geo):
            if p and nid not in nodes:
                x, y = _T.transform(p["lon"], p["lat"])
                i, j = to_grid(x, y)
                nodes[nid] = (float(i), float(j))
        if all(n in nodes for n in e["nodes"]):
            ways.append(e)
    junction = {}  # paths on a roof garden OSM does not map (roofgardens.WHOLE): footways on the roof, new node ids
    for k, (a, b, pts) in enumerate(paths):
        ids = []
        for end, p in ((a, pts[0]), *((None, q) for q in pts[1:-1]), (b, pts[-1])):
            if isinstance(end, int):
                ids.append(end)
                continue
            n = junction.setdefault(end, -len(nodes) - 1) if end else -len(nodes) - 1
            nodes.setdefault(n, (float(p[0]), float(p[1])))
            ids.append(n)
        if all(n in nodes for n in ids):
            ways.append(dict(id=-k - 1, nodes=ids, tags=dict(highway="footway", level="1")))

    def inside(nid, m=3):
        x, y = nodes[nid]
        return m <= x < W - m and m <= y < D - m

    def z_at(x, y, bridge):
        c, r = min(max(int(x), 0), W - 1), min(max(int(y), 0), D - 1)
        # on a deck: tagged bridge ways, and anything over water that has a deck above it (untagged bridge sidewalks)
        if (bridge or (water is not None and water[r, c])) and nd_mean[r, c] >= 1.5:  # decks stand >= 2 m
            return int(g[r, c] + round(nd_mean[r, c]))
        return int(g[r, c])

    def split(ws):
        """split ways at nodes used by >1 way of the same network (junctions); keep only inside-AOI runs"""
        use = defaultdict(int)
        for w in ws:
            for n in w["nodes"]:
                use[n] += 1
        out = []
        for w in ws:
            ns = w["nodes"]
            cur = [ns[0]]
            for n in ns[1:]:
                cur.append(n)
                if use[n] > 1 or n == ns[-1]:
                    out.append((w, cur))
                    cur = [n]
        res = []
        for w, seg in out:  # clip to AOI: keep maximal inside runs
            run = []
            for n in seg:
                if inside(n):
                    run.append(n)
                else:
                    if len(run) >= 2:
                        res.append((w, run))
                    run = []
            if len(run) >= 2:
                res.append((w, run))
        return res

    def pts_of(seq, bridge):
        """points of a node chain; long segments get a point every 3 m with its own height, so a vehicle follows a
        bridge deck (or a ramp) instead of the straight line between two far-apart OSM nodes"""
        out = []
        for a, b in zip(seq, seq[1:] + [None]):
            xa, ya = nodes[a]
            br = bridge or a in bridge_nodes
            out.append([round(xa, 1), round(ya, 1), z_at(xa, ya, br)])
            if b is None:
                continue
            xb, yb = nodes[b]
            L = math.hypot(xb - xa, yb - ya)
            on = br and (bridge or b in bridge_nodes)  # both ends on the bridge: the whole segment is
            for k in range(1, int(L // 3)):
                f = k * 3 / L
                x, y = xa + (xb - xa) * f, ya + (yb - ya) * f
                out.append([round(x, 1), round(y, 1), z_at(x, y, on)])
        # a lone point standing off both neighbours (a bridge end node reading a lamp base, a gap cell) is noise:
        # a vehicle would hop over it or dip into the deck
        for i in range(1, len(out) - 1):
            za, zb, zc = out[i - 1][2], out[i][2], out[i + 1][2]
            if (zb - za) * (zb - zc) > 0 and abs(zb - (za + zc) / 2) >= 1.5:
                out[i][2] = int(round((za + zc) / 2))
        return out

    def length(p):
        return float(sum(math.dist(a[:2], b[:2]) for a, b in zip(p, p[1:])))

    # ---------------- roads
    rways = [w for w in ways if w["tags"]["highway"] in DRIVE and (not underground(w["tags"]) or w["id"] in OPEN_CUT)
             and w["tags"].get("access") not in ("no", "private") and w["tags"].get("area") != "yes"]
    sig_nodes = {n for n, t in ntags.items() if t.get("highway") == "traffic_signals" and n in nodes}
    # controllers: cluster signal nodes
    ctrl_of, ctrls = {}, []
    for n in sorted(sig_nodes):
        x, y = nodes[n]
        for k, c in enumerate(ctrls):
            if math.dist((x, y), (c["x"], c["y"])) < 45:
                ctrl_of[n] = k
                c["n"] += 1
                c["x"] += (x - c["x"]) / c["n"]
                c["y"] += (y - c["y"]) / c["n"]
                break
        else:
            ctrl_of[n] = len(ctrls)
            ctrls.append(dict(x=x, y=y, n=1))
    roads = []
    nid_index = {}

    def node_idx(n):
        if n not in nid_index:
            nid_index[n] = len(nid_index)
        return nid_index[n]

    for w, seg in split(rways):
        t = w["tags"]
        hw = t["highway"]
        ow = t.get("oneway") in ("yes", "true", "1") or t.get("junction") in ("roundabout", "circular") \
            or hw in ("motorway",)
        rev = t.get("oneway") == "-1"
        lanes = _num(t.get("lanes"))
        lf, lb = _num(t.get("lanes:forward")), _num(t.get("lanes:backward"))
        if ow or rev:
            lf = lanes or 1
        else:
            lf = lf or max(1, (lanes or 2) // 2)
            lb = lb or max(1, (lanes or 2) - lf)
        v = (_num(t.get("maxspeed")) or 50) / 3.6
        v = min(v, DRIVE[hw] + 2)
        bridge = t.get("bridge") not in (None, "no")
        dirs = [(seg, int(lf), "forward")] if not rev else [(seg[::-1], int(lf), "backward")]
        if not ow and not rev:
            dirs.append((seg[::-1], int(lb), "backward"))
        for s, nl, dname in dirs:
            p = pts_of(s, bridge)
            L = length(p)
            if L < 1:
                continue
            e = dict(a=node_idx(s[0]), b=node_idx(s[-1]), w=w["id"], p=p, L=round(L, 1), lanes=max(1, min(nl, 4)),
                     v=round(v, 1), c=CLASS.get(hw.replace("_link", ""), 1), two=not (ow or rev))
            # signal for this direction: a signal node on this edge (not its start) within 45 m of its end
            cum = np.concatenate([[0], np.cumsum([math.dist(a[:2], b[:2]) for a, b in zip(p, p[1:])])])
            best = None
            for k, n in enumerate(s[1:], 1):
                if n not in sig_nodes or L - cum[k] > 45:
                    continue
                sd = ntags[n].get("traffic_signals:direction")
                if sd in ("forward", "backward") and sd != dname:
                    continue
                stop = cum[k] - (5.5 if k == len(s) - 1 else 1.0)
                best = (max(0.5, stop), ctrl_of[n], k)
            if best:
                k = best[2]
                dx, dy = p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]
                e["sig"] = dict(s=round(best[0], 1), ctrl=best[1], axis=0 if abs(dx) >= abs(dy) else 1)
            roads.append(e)
    # validate lanes against the actual paved surface: a lane centre must run mostly on carriageway and not on
    # the tram bed (OSM lanes= often counts space the tracks take, or a wider road than the mapped centreline allows)
    n_drop = 0
    if surf is not None:
        from scipy import ndimage as _nd
        tramzone = _nd.binary_dilation(surf == 2, iterations=1)  # ~1 m clearance so bodies never touch
        surf = np.where(tramzone & (surf != 2), 2, surf).astype(np.uint8)
        for e in roads:
            p = np.array(e["p"], float)
            cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))])
            L = cum[-1]
            ss = np.arange(min(8, L / 3), max(L - min(8, L / 3), 0.1), 3.0)
            if len(ss) == 0:
                ss = np.array([L / 2])
            idx = np.clip(np.searchsorted(cum, ss), 1, len(p) - 1)
            f = (ss - cum[idx - 1]) / np.maximum(cum[idx] - cum[idx - 1], 1e-6)
            xy = p[idx - 1, :2] + (p[idx, :2] - p[idx - 1, :2]) * f[:, None]
            d = (p[idx, :2] - p[idx - 1, :2]) / np.maximum(np.hypot(*(p[idx, :2] - p[idx - 1, :2]).T), 1e-6)[:, None]
            n = e["lanes"]
            offs = [(l + 0.5) * 3.0 if e["two"] else (l + 0.5 - n / 2) * 3.0 for l in range(n)]
            ok = []
            for o in offs:
                q = xy + np.stack([-d[:, 1], d[:, 0]], 1) * o
                c = np.clip(q[:, 0].astype(int), 0, surf.shape[1] - 1)
                r = np.clip(q[:, 1].astype(int), 0, surf.shape[0] - 1)
                v = surf[r, c]
                ok.append((v == 1).mean() >= 0.5 and (v == 2).mean() <= 0.25)
            # longest contiguous run of valid lanes (keep at least the best single lane)
            best, cur, bs = (0, 0), 0, 0
            for l, good in enumerate(ok + [False]):
                if good:
                    cur += 1
                    if cur > best[1]:
                        best = (l - cur + 1, cur)
                else:
                    cur = 0
            if best[1] == 0:
                best = (int(np.argmin(np.abs(offs))), 1)
            if best[1] < n:
                n_drop += n - best[1]
            e["lanes"] = best[1]
            e["o0"] = round(offs[best[0]], 2)
    else:
        for e in roads:
            e["o0"] = 1.5 if e["two"] else round((0.5 - e["lanes"] / 2) * 3.0, 2)
    note(f"traffic: {n_drop} OSM lanes dropped where the lane centre is not on carriageway or runs on the tram bed")

    # approaches into a signalled junction without their own signal node (side streets) obey the same controller
    n_inf = 0
    for e in roads:
        if "sig" in e or not ctrls:
            continue
        x, y = e["p"][-1][:2]
        k = int(np.argmin([math.dist((x, y), (c["x"], c["y"])) for c in ctrls]))
        if math.dist((x, y), (ctrls[k]["x"], ctrls[k]["y"])) > 25 or e["L"] < 8:
            continue
        dx, dy = e["p"][-1][0] - e["p"][-2][0], e["p"][-1][1] - e["p"][-2][1]
        e["sig"] = dict(s=round(max(0.5, e["L"] - 5.5), 1), ctrl=k, axis=0 if abs(dx) >= abs(dy) else 1, inferred=1)
        n_inf += 1
    note(f"traffic: {n_inf} side-street approaches inferred onto nearby signal controllers")
    # OSM turn restrictions (from way, via node, to way)
    restr = []
    for rel in data["elements"]:
        t = rel.get("tags", {})
        if rel["type"] != "relation" or t.get("type") != "restriction" or not t.get("restriction"):
            continue
        fr = [m["ref"] for m in rel.get("members", []) if m.get("role") == "from" and m["type"] == "way"]
        to = [m["ref"] for m in rel.get("members", []) if m.get("role") == "to" and m["type"] == "way"]
        via = [m["ref"] for m in rel.get("members", []) if m.get("role") == "via" and m["type"] == "node"]
        if fr and to and via and via[0] in nid_index:
            restr.append([fr[0], nid_index[via[0]], to[0], t["restriction"]])
    note(f"traffic: {len(restr)} turn restrictions on the road graph")
    rnodes = [None] * len(nid_index)
    for n, i in nid_index.items():
        x, y = nodes[n]
        rnodes[i] = [round(x, 1), round(y, 1)]

    # ---------------- pedestrians
    import underpass
    pways = [w for w in ways if (w["tags"]["highway"] in WALK or w["tags"].get("footway") == "sidewalk")
             and (not underground(w["tags"]) or w["id"] in underpass.IDS) and w["tags"].get("access") not in ("no", "private")]
    ped_sig = {n for n, t in ntags.items() if t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes"}
    peds, pidx = [], {}

    def pnode(n):
        if n not in pidx:
            pidx[n] = len(pidx)
        return pidx[n]

    WEIGHT = {"pedestrian": 6.0, "living_street": 5.0, "footway": 1.0, "path": 0.6, "steps": 0.5,
              "platform": 0.8, "cycleway": 0.15}
    def roof_z(x, y):
        """the surface of a roof under a point: the top of the solid voxels, where all around it stands 2.5 m up"""
        zs = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                c, r = min(max(int(x) + dc, 0), W - 1), min(max(int(y) + dr, 0), D - 1)
                nz = np.nonzero(solid[vol[:, r, c]])[0]
                zs.append(int(nz[-1]) + 1 if len(nz) else int(g[r, c]))
        z = int(np.median(zs))
        return z if min(zs) >= g[min(max(int(y), 0), D - 1), min(max(int(x), 0), W - 1)] + 2.5 else None

    on_roof = {}  # pnode -> the roof's height there, for the steps that lead up
    for w, seg in split(pways):
        t = w["tags"]
        bridge = t.get("bridge") not in (None, "no")
        p = pts_of(seg, bridge)
        L = length(p)
        if L < 0.8:
            continue
        up = max(_num(t.get("level"), 0) or 0, _num(t.get("layer"), 0) or 0) >= 1
        if vol is not None and not bridge and not up and roofs is not None and not underground(t) \
                and LineString([q[:2] for q in p]).intersection(roofs).length > 0.8 * L:
            up = fit(p, (0.0,), vol, solid, W, D)[2] > 2  # on a garden roof, unless it fits under it (an arcade)
        if w["id"] in underpass.IDS:  # down a stairwell or through a passage: its carved walking levels
            zs = [int(underpass.WALK[min(max(int(y), 0), D - 1), min(max(int(x), 0), W - 1)]) for x, y, _ in p]
            p = [[x, y, z if z >= 0 else z0] for (x, y, z0), z in zip(p, zs)]
        elif vol is not None and not bridge and up:
            zs = [roof_z(x, y) for x, y, _ in p]  # a path on a roof garden (BUW, Dobra, the Kubicki Arcades)
            if len(zs) > 2 and all(z is not None for z in zs[1:-1]):  # an end at the roof's edge (a ramp's top)
                zs[0], zs[-1] = zs[0] or zs[1], zs[-1] or zs[-2]
            if all(z is not None for z in zs):
                p = [[x, y, z] for (x, y, _), z in zip(p, zs)]
                on_roof[pnode(seg[0])], on_roof[pnode(seg[-1])] = zs[0], zs[-1]
        e = dict(a=pnode(seg[0]), b=pnode(seg[-1]), p=p, L=round(L, 1),
                 w=WEIGHT.get(t["highway"], 1.0) * (1.5 if t.get("footway") == "sidewalk" else 1.0))
        bk = bike_weight(t)
        if bk:
            e["bk"] = bk
        elif bike_open(t):
            e["bko"] = 1
        is_cross = t.get("footway") == "crossing" or t.get("cycleway") == "crossing" or "crossing" in t
        signalled = t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes" \
            or any(n in ped_sig for n in seg)
        if is_cross and signalled and ctrls:
            mx, my = np.mean([q[0] for q in p]), np.mean([q[1] for q in p])
            k = int(np.argmin([math.dist((mx, my), (c["x"], c["y"])) for c in ctrls]))
            if math.dist((mx, my), (ctrls[k]["x"], ctrls[k]["y"])) < 70:
                dx, dy = p[-1][0] - p[0][0], p[-1][1] - p[0][1]
                e["x"] = dict(ctrl=k, axis=0 if abs(dx) >= abs(dy) else 1)
        peds.append(e)
    for e in peds:  # steps or a ramp from the ground up to a roof path: their heights from one end to the other
        za, zb = on_roof.get(e["a"]), on_roof.get(e["b"])
        if (za is None) == (zb is None) or abs((za or zb) - e["p"][0 if za is None else -1][2]) < 2:
            continue
        z0, z1 = (e["p"][0][2], zb) if za is None else (za, e["p"][-1][2])
        cum = np.concatenate([[0], np.cumsum([math.dist(a[:2], b[:2]) for a, b in zip(e["p"], e["p"][1:])])])
        e["flat"] = e["p"]  # as it was, should the voxels not hold the slope (a ramp OSM maps over another)
        e["p"] = [[x, y, int(round(z0 + (z1 - z0) * k / max(cum[-1], 1e-6)))] for (x, y, _), k in zip(e["p"], cum)]
    # a bike way rides with the road beside it: on a Vistula bridge its count, along a main road twice a side street's
    from shapely.strtree import STRtree
    rl = [(w["tags"], LineString([nodes[n] for n in w["nodes"]])) for w in ways
          if w["tags"]["highway"] in DRIVE and len(w["nodes"]) > 1]
    rtree = STRtree([l for _, l in rl])
    main = {"primary", "trunk", "secondary", "primary_link", "trunk_link"}
    for e in peds:
        if "bk" not in e or e["bk"] != 1:
            continue
        mid = LineString([q[:2] for q in e["p"]]).interpolate(0.5, normalized=True)
        near = [rl[i] for i in rtree.query(mid.buffer(25)) if rl[i][1].distance(mid) < 25]
        for t_, _ in near:
            bw = BIKE_BRIDGES.get(t_.get("name", ""))
            if bw and t_.get("bridge") not in (None, "no"):
                e["bk"] = bw
                break
        else:
            if any(t_["highway"] in main for t_, _ in near):
                e["bk"] = 2
    bks = [e["bk"] for e in peds if "bk" in e]
    note(f"traffic: {len(bks)} bike way edges ({round(sum(e['L'] for e in peds if 'bk' in e) / 1000, 1)} km), "
         f"{sum(b >= 2.5 for b in bks)} on bridges or boulevards, {sum(b == 2 for b in bks)} along main roads")
    pn = [None] * len(pidx)
    for n, i in pidx.items():
        pn[i] = [round(nodes[n][0], 1), round(nodes[n][1], 1)]

    # signal heads: one per signalled approach, at the stop line on the right-hand kerb
    heads = []
    if surf is not None:  # a signal stands off the carriageway and the tracks: the nearest such cell (95 of 708 stood
        from scipy import ndimage as _nd  # in a lane of a wider road, a turn lane or the road across)
        _kd, (_kr, _kc) = _nd.distance_transform_edt(surf > 0, return_indices=True)
    for e in roads:
        sg = e.get("sig")
        if not sg:
            continue
        p = np.array(e["p"], float)
        cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))])
        k = min(max(int(np.searchsorted(cum, sg["s"])), 1), len(p) - 1)
        f = (sg["s"] - cum[k - 1]) / max(cum[k] - cum[k - 1], 1e-6)
        x, y = p[k - 1, :2] + (p[k, :2] - p[k - 1, :2]) * f
        dx, dy = (p[k, :2] - p[k - 1, :2]) / max(np.hypot(*(p[k, :2] - p[k - 1, :2])), 1e-6)
        off = (e["lanes"] + (0 if e["two"] else -e["lanes"] / 2)) * 3.1 + 1.2
        hx, hy = x - dy * off, y + dx * off
        c_, r_ = min(max(int(hx), 0), W - 1), min(max(int(hy), 0), D - 1)
        if surf is not None and 0 < _kd[r_, c_] <= 8:
            c_, r_ = int(_kc[r_, c_]), int(_kr[r_, c_])
            hx, hy = c_ + 0.5, r_ + 0.5
        heads.append([round(hx, 1), round(hy, 1), z_at(hx, hy, True), round(math.atan2(dx, dy), 2), sg["ctrl"], sg["axis"]])

    # ---------------- trams: real route relations (PTv2, one relation per direction), chained and clipped
    way_by_id = {e["id"]: e for e in data["elements"] if e["type"] == "way"}
    def chain(ws):
        """a route's member ways (node lists) as one node chain, None at its gaps: from the first way on, each time
        the unused way that starts where the chain ends, the next one in the relation's order if there are several.
        The first of a run is turned to lead into another. (Each way used to be taken as listed and in its own node
        order: a first way drawn against the direction of travel joined nothing, and so on down the route -- 11 of
        the 15 train tracks were single ways of 160-550 m, trains running off their ends into the air; and a
        relation listed out of order broke where it was)"""
        ends = defaultdict(list)
        for k, ns in enumerate(ws):
            ends[ns[0]].append(k); ends[ns[-1]].append(k)
        used, seq = [False] * len(ws), []
        for k0 in range(len(ws)):
            if used[k0]:
                continue
            ns, k = ws[k0], k0
            if not any(not used[j] and j != k for j in ends[ns[-1]]) and any(not used[j] and j != k for j in ends[ns[0]]):
                ns = ns[::-1]
            if seq:
                seq.append(None)
            seq.extend(ns)
            used[k] = True
            while True:
                nxt = [j for j in ends[seq[-1]] if not used[j]]
                if not nxt:
                    break
                k = min(nxt, key=lambda j: (j < k, j))
                ns = ws[k]
                seq.extend(ns[-2::-1] if seq[-1] == ns[-1] else ns[1:])
                used[k] = True
        return seq

    def runs(seq, stop=()):
        """the pieces of a chain inside the map and off the `stop` nodes; one that leaves the map ends on its edge (it
        ended on its last node inside, up to 60 m short: trams appeared in the middle of a street)"""
        def edge(i, o):
            (xi, yi), (xo, yo) = nodes[i], nodes[o]
            f = min([(b - a) / (c - a) for a, c, b in ((xi, xo, 3), (xi, xo, W - 3.01), (yi, yo, 3), (yi, yo, D - 3.01))
                     if (c - b) * (a - b) < 0] or [0])
            n = -10 ** 9 - len(nodes)
            nodes[n] = (xi + (xo - xi) * f, yi + (yo - yi) * f)
            return n
        piece, prev, out = [], None, []
        for n in list(seq) + [None]:
            if n is not None and n not in stop and inside(n):
                if not piece and prev is not None and prev not in stop and not inside(prev):
                    piece.append(edge(n, prev))
                if not piece or piece[-1] != n:
                    piece.append(n)
            else:
                if piece and n is not None and n not in stop:
                    piece.append(edge(piece[-1], n))
                if len(piece) >= 2:
                    out.append(piece)
                piece = []
            prev = n
        return out

    def members(rel):
        """the ways a route runs on (its members without a stop or platform role), whatever state the way is tagged
        in: a few metres of route 13 at Wolska are railway=disused while the track is relaid"""
        ws = []
        for m in rel.get("members", []):
            w = way_by_id.get(m["ref"]) if m["type"] == "way" and m.get("role") in ("", "forward", "backward") else None
            ns = [n for n in w["nodes"] if n in nodes] if w and w.get("tags", {}).get("railway", "platform") != "platform" else []
            if len(ns) >= 2:
                ws.append(ns)
        return ws

    # under the ground a piece ends: the tram goes into the W-Z tunnel at its portal, the trains into the cross-city
    # tunnel under Śródmieście
    tunnel_nodes = set()
    for e in data["elements"]:
        tg = e.get("tags", {})
        if e["type"] == "way" and "railway" in tg:
            for nid, p_ in zip(e["nodes"], e.get("geometry") or []):
                if p_ and nid not in nodes:
                    x, y = _T.transform(p_["lon"], p_["lat"])
                    i, j = to_grid(x, y)
                    nodes[nid] = (float(i), float(j))
            if tg.get("tunnel") not in (None, "no") or tg.get("covered") == "yes" or _num(tg.get("layer"), 0) < 0:
                tunnel_nodes.update(e["nodes"][1:-1])
    trams = []
    for rel in data["elements"]:
        t = rel.get("tags", {})
        if rel["type"] != "relation" or t.get("route") != "tram":
            continue
        for piece in runs(chain(members(rel)), tunnel_nodes):
            pp = pts_of(piece, False)
            if length(pp) >= 120:
                trams.append(dict(ref=t.get("ref", "?"), p=pp, L=round(length(pp), 1)))
    # identical paths from different refs share track: keep all (each ref runs its own service)
    note(f"traffic: {len(trams)} tram route pieces inside the AOI, lines {sorted({tr['ref'] for tr in trams}, key=lambda r: (len(r), r))}")

    # ---------------- trains: the route=train relations (one per direction), on the open-air track only -- a piece
    # ends where the line goes into a tunnel (the cross-city line under Śródmieście) or leaves the map. Routes on the
    # same track share one path; each keeps the stations it stops at (its stop members on the path)
    by_track = {}
    for rel in data["elements"]:
        t = rel.get("tags", {})
        if rel["type"] != "relation" or t.get("route") != "train":
            continue
        stops = {m["ref"] for m in rel.get("members", []) if m["type"] == "node" and str(m.get("role", "")).startswith("stop")}
        for piece in runs(chain(members(rel)), tunnel_nodes):
            tr = by_track.setdefault(tuple(piece), dict(nodes=piece, svc=[]))
            tr["svc"].append(dict(ref=t.get("ref") or t.get("name", "?"), op=t.get("operator", ""),
                                  stops=[k for k, n_ in enumerate(piece) if n_ in stops]))
    # one path per track: routes that part only at a set of points (the long-distance track's two ways out at the
    # map's east edge) ran on paths of their own over the same rails, and their trains through one another -- a
    # train keeps its distance on its own path. They take the path most routes use
    def span(es):
        return sum(math.dist(nodes[a], nodes[b]) for a, b in es)
    tracks = []
    for tr in sorted(by_track.values(), key=lambda tr: (-len(tr["svc"]), -len(tr["nodes"]))):
        es = set(zip(tr["nodes"], tr["nodes"][1:]))
        for k in tracks:
            if span(es & k["es"]) > 0.5 * min(span(es), span(k["es"])):
                at_ = {n: i for i, n in enumerate(k["nodes"])}
                k["svc"] += [dict(v, stops=[at_[tr["nodes"][i]] for i in v["stops"] if tr["nodes"][i] in at_]) for v in tr["svc"]]
                break
        else:
            tracks.append(dict(tr, es=es))
    trains = []
    for tr in tracks:
        pp = pts_of(tr["nodes"], False)
        if length(pp) < 150:
            continue
        # a stop's arc length along the path (the node's own point: pts_of keeps every node, in order)
        cum, k_of, k = [0.0], {}, 0
        for a, b in zip(pp, pp[1:]):
            cum.append(cum[-1] + math.dist(a[:2], b[:2]))
        for i_, n in enumerate(tr["nodes"]):
            x, y = nodes[n]
            while k < len(pp) and (abs(pp[k][0] - round(x, 1)) > 0.05 or abs(pp[k][1] - round(y, 1)) > 0.05):
                k += 1
            k_of[i_] = min(k, len(pp) - 1)
        svc = [dict(ref=v["ref"], op=v["op"], stops=sorted({round(cum[k_of[i_]], 1) for i_ in v["stops"]})) for v in tr["svc"]]
        trains.append(dict(p=pp, L=round(length(pp), 1), svc=svc))
    note(f"traffic: {len(trains)} train tracks inside the AOI ({sum(len(t['svc']) for t in trains)} route pieces, "
         f"{round(sum(t['L'] for t in trains) / 1000, 1)} km), operators {sorted({v['op'] for t in trains for v in t['svc']})}")

    if vol is not None:
        n_lift = 0
        deg = Counter([e["a"] for e in roads] + [e["b"] for e in roads])
        for e in roads:
            lo, hi = e["o0"] - 0.8, e["o0"] + (e["lanes"] - 1) * 3.0 + 0.8
            e["p"], lift, _ = fit(e["p"], np.linspace(lo, hi, max(2, int(hi - lo) + 1)), vol, solid, W, D, decks=True)
            n_lift += lift
            if deg[e["a"]] == 1 or deg[e["b"]] == 1:  # a dead end at a tunnel's portal (the link into the roundabout
                # under Poniatowski's viaduct): its last node on the deck over the portal, the car climbed the wall
                p_ = trim_portal(e["p"])
                if len(p_) >= 2 and length(p_) > 3:
                    e["p"], e["L"] = p_, round(length(p_), 1)
        for tr in trams:
            tr["p"], lift, _ = fit(tr["p"], (-0.9, 0.0, 0.9), vol, solid, W, D, decks=True)
            n_lift += lift
            tr["p"] = trim_portal(tr["p"])
            tr["L"] = round(length(tr["p"]), 1)
        for tr in trains:
            p_, lift, _ = fit(tr["p"], (-1.2, 0.0, 1.2), vol, solid, W, D, decks=True)
            if len(p_) != len(tr["p"]):  # the stops are arc lengths: they hold as long as the path's corners do
                L_ = length(p_)
                for v in tr["svc"]:
                    v["stops"] = [round(s_ * L_ / tr["L"], 1) for s_ in v["stops"]]
                tr["L"] = round(L_, 1)
            tr["p"] = p_
            n_lift += lift
        keep = []
        for e in peds:  # people keep 0.35-1.35 m to their right (both sides of the line), else all on its free side
            for side, offs, p0 in [(sd, of, p0) for p0 in filter(None, (e["p"], e.pop("flat", None)))
                                   for sd, of in ((None, (-1.35, -0.35, 0.35, 1.35)), (1, (0.35, 1.35)),
                                                  (-1, (-1.35, -0.35)), (0, (0.0,)))]:
                p, lift, blocked = fit(p0, offs, vol, solid, W, D)
                if blocked <= 2:
                    break
            else:  # mapped through a wall: nobody walks there
                continue
            e["p"] = p
            if side is not None:
                e["side"] = side
            n_lift += lift
            keep.append(e)
        note(f"traffic: paths fitted to the voxels ({n_lift} m lifted onto the drawn surface), "
             f"{len(peds) - len(keep)} footpath edges through walls dropped")
        peds = keep
    pxy = {i: nodes[n] for n, i in pidx.items()}
    join_bike_ways(peds, pn, note, pxy, (lambda p: fit(p, (0.0,), vol, solid, W, D)[2] <= 2) if vol is not None else None)

    for c in ctrls:
        c["x"], c["y"] = round(c["x"], 1), round(c["y"], 1)
        del c["n"]
    nsig = sum(1 for e in roads if "sig" in e)
    ncross = sum(1 for e in peds if "x" in e)
    note(f"traffic: {len(roads)} directed road edges ({round(sum(e['L'] * e['lanes'] for e in roads) / 1000, 1)} lane-km), "
         f"{len(ctrls)} signal controllers, {nsig} signalled approaches; {len(peds)} footpath edges "
         f"({round(sum(e['L'] for e in peds) / 1000, 1)} km), {ncross} signalled crossings")
    return dict(roads=roads, rnodes=rnodes, ctrls=ctrls, heads=heads, peds=peds, pnodes=pn, trams=trams, trains=trains, restr=restr)


if __name__ == "__main__":  # traffic.json alone, from the last full build's volume (LMCACHE=1 FINALDUMP=1 voxelize.py)
    import pickle
    tin = pickle.load(open("data/cache/traffic_in.pkl", "rb"))
    import underpass
    OPEN_CUT, underpass.WALK, underpass.IDS = tin.pop("open_cut"), tin.pop("walk"), tin.pop("ids")
    json.dump(build(note=print, vol=np.load("data/cache/final_vol.npy", mmap_mode="r"), **tin),
              open("web/public/data/traffic.json", "w"), separators=(",", ":"))
