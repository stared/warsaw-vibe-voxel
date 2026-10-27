"""Lit windows at night, from counts on dated Commons photos (scripts/window_photos.py; each facade counted by eye:
windows visible, windows lit, type, pattern, colour of the light), into what the viewer draws.

Per building type:
  med[daytype][bin]: median share of lit windows for weekdays and weekends, in five clock-time bins (16-17, 18-19, 20-21,
    22-23, 0-6). Bins with few facades are pulled toward the type's overall median (n / (n + 5) weight on the bin).
  shape: quantiles (0, 1/8, ... 1) of a facade's share divided by its group's median; a building's own habit picks a
    point on it, so some buildings stay dark and some fully lit, as in the photos.
  floors: share of facades lit in whole floors; colour: mean share of warm, neutral, cool light.

Input scripts/window_counts.json, output web/public/data/windows.json.
"""
import json
import statistics as st
from pathlib import Path

COUNTS = Path(__file__).with_name("window_counts.json")
OUT = Path(__file__).resolve().parent.parent / "web/public/data/windows.json"
TYPES = {"residential": ["residential", "mixed"], "office": ["office"], "hotel": ["hotel"], "public": ["public"],
         "religious": ["religious", "public"]}
BINS = [(15, 17), (18, 19), (20, 21), (22, 23), (0, 6)]
PRIOR = 5


def bin_of(h):
    return next(i for i, (a, b) in enumerate(BINS) if a <= h <= b)


def quantiles(v, n=8):
    v = sorted(v)
    return [round(v[min(int(k / n * (len(v) - 1) + 0.5), len(v) - 1)], 3) for k in range(n + 1)]


def main():
    rows = [r for r in json.loads(COUNTS.read_text()) if r["hour"] <= 6 or r["hour"] >= 15]
    out = {"bins": BINS, "types": {}, "n": len(rows)}
    for name, src in TYPES.items():
        rs = [r for r in rows if r["type"] in src]
        overall = st.median(r["lit"] / r["windows"] for r in rs)
        med, groups = {}, {}
        for day in ("weekday", "weekend"):
            med[day] = []
            for i in range(len(BINS)):
                g = [r["lit"] / r["windows"] for r in rs if bin_of(r["hour"]) == i and r["weekend"] == (day == "weekend")]
                m = st.median(g) if g else overall
                med[day].append(round((len(g) * m + PRIOR * overall) / (len(g) + PRIOR), 3))
                groups[(day, i)] = (g, max(m, 0.02))
        ratios = [x / m for g, m in groups.values() for x in g]
        cols = [r["colour"] for r in rs if r.get("colour")]
        colour = [round(st.mean(c.get(k, 0) for c in cols), 2) for k in ("warm", "neutral", "cool")]
        s = sum(colour) or 1
        out["types"][name] = dict(n=len(rs), med=med, shape=quantiles(ratios),
                                  floors=round(sum(r["pattern"] == "whole_floors" for r in rs) / len(rs), 2),
                                  colour=[round(c / s, 2) for c in colour])
        print(name, len(rs), med, out["types"][name]["shape"], out["types"][name]["floors"], out["types"][name]["colour"])
    OUT.write_text(json.dumps(out))


if __name__ == "__main__":
    main()
