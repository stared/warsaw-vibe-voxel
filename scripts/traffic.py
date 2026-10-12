"""Road + pedestrian graphs with real signal positions for the live simulation (web/src/sim.js).

Output traffic.json, coordinates in grid metres (x = col, y = row) with z = walking/driving surface voxel level.
- roads: directed edges between junctions (OSM ways split at shared nodes), lanes per direction, speed,
  optional stop line {s, ctrl, axis} for traffic signals (OSM highway=traffic_signals + traffic_signals:direction)
- ctrls: signal controllers = signal nodes clustered per junction (<= 45 m); each runs a two-axis cycle
- peds: undirected footpath edges; signalled crossings carry {ctrl, axis}
Axis 0/1 = travel roughly along grid x / grid y (the grid is aligned to the Śródmieście street grid).
"""
import json
import math
from collections import defaultdict

import numpy as np
from pyproj import Transformer

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


def underground(t):
    return (t.get("tunnel") in ("yes", "building_passage") or _num(t.get("layer"), 0) < 0 or t.get("indoor") == "yes"
            or t.get("location") == "underground" or (_num(t.get("level"), 0) or 0) < 0 or t.get("covered") == "yes")


def build(g, nd_mean, note):
    data = json.load(open(f"{RAW}/osm.json"))
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

    def inside(nid, m=3):
        x, y = nodes[nid]
        return m <= x < W - m and m <= y < D - m

    def z_at(x, y, bridge):
        c, r = min(max(int(x), 0), W - 1), min(max(int(y), 0), D - 1)
        if bridge and nd_mean[r, c] > 2:
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
        return [[round(nodes[n][0], 1), round(nodes[n][1], 1), z_at(*nodes[n], bridge)] for n in seq]

    def length(p):
        return float(sum(math.dist(a[:2], b[:2]) for a, b in zip(p, p[1:])))

    # ---------------- roads
    rways = [w for w in ways if w["tags"]["highway"] in DRIVE and not underground(w["tags"])
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
            e = dict(a=node_idx(s[0]), b=node_idx(s[-1]), p=p, L=round(L, 1), lanes=max(1, min(nl, 4)),
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
    rnodes = [None] * len(nid_index)
    for n, i in nid_index.items():
        x, y = nodes[n]
        rnodes[i] = [round(x, 1), round(y, 1)]

    # ---------------- pedestrians
    pways = [w for w in ways if (w["tags"]["highway"] in WALK or w["tags"].get("footway") == "sidewalk")
             and not underground(w["tags"]) and w["tags"].get("access") not in ("no", "private")]
    ped_sig = {n for n, t in ntags.items() if t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes"}
    peds, pidx = [], {}

    def pnode(n):
        if n not in pidx:
            pidx[n] = len(pidx)
        return pidx[n]

    WEIGHT = {"pedestrian": 6.0, "living_street": 5.0, "footway": 1.0, "path": 0.6, "steps": 0.5,
              "platform": 0.8, "cycleway": 0.15}
    for w, seg in split(pways):
        t = w["tags"]
        p = pts_of(seg, t.get("bridge") not in (None, "no"))
        L = length(p)
        if L < 0.8:
            continue
        e = dict(a=pnode(seg[0]), b=pnode(seg[-1]), p=p, L=round(L, 1),
                 w=WEIGHT.get(t["highway"], 1.0) * (1.5 if t.get("footway") == "sidewalk" else 1.0))
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
    pn = [None] * len(pidx)
    for n, i in pidx.items():
        pn[i] = [round(nodes[n][0], 1), round(nodes[n][1], 1)]

    # signal heads: one per signalled approach, at the stop line on the right-hand kerb
    heads = []
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
        heads.append([round(hx, 1), round(hy, 1), int(g[r_, c_]), round(math.atan2(dx, dy), 2), sg["ctrl"], sg["axis"]])

    for c in ctrls:
        c["x"], c["y"] = round(c["x"], 1), round(c["y"], 1)
        del c["n"]
    nsig = sum(1 for e in roads if "sig" in e)
    ncross = sum(1 for e in peds if "x" in e)
    note(f"traffic: {len(roads)} directed road edges ({round(sum(e['L'] * e['lanes'] for e in roads) / 1000, 1)} lane-km), "
         f"{len(ctrls)} signal controllers, {nsig} signalled approaches; {len(peds)} footpath edges "
         f"({round(sum(e['L'] for e in peds) / 1000, 1)} km), {ncross} signalled crossings")
    return dict(roads=roads, rnodes=rnodes, ctrls=ctrls, heads=heads, peds=peds, pnodes=pn)
