"""How likely Warsaw weather is on each day of the year, so the viewer offers only what can happen then (no snow in June).

Open-Meteo's historical archive (ERA5 reanalysis, daily, 1995-2024) for central Warsaw: the share of days with at least
1 cm of fresh snow, over a window of ±10 days around each day of the year.

Output: web/public/data/climate.json.
"""
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from aoi import RAW  # noqa: E402

URL = ("https://archive-api.open-meteo.com/v1/archive?latitude=52.23&longitude=21.01&start_date=1995-01-01"
       "&end_date=2024-12-31&daily=snowfall_sum,rain_sum,temperature_2m_mean,cloud_cover_mean&timezone=Europe%2FWarsaw")
CACHE = Path(RAW) / "climate" / "warsaw_daily.json"
OUT = Path(__file__).parent.parent / "web/public/data/climate.json"
WINDOW = 10


def main():
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(URL, CACHE)
    d = json.load(open(CACHE))["daily"]
    doy = np.minimum([dt.date.fromisoformat(t).timetuple().tm_yday for t in d["time"]], 365) - 1
    snow = np.array([s or 0 for s in d["snowfall_sum"]]) >= 1
    days, hits = np.bincount(doy, minlength=365), np.bincount(doy, snow, minlength=365)
    k = np.ones(2 * WINDOW + 1)
    wrap = lambda a: np.convolve(np.r_[a[-WINDOW:], a, a[:WINDOW]], k, "valid")
    p = wrap(hits) / wrap(days)
    json.dump(dict(source="Open-Meteo historical weather API (ERA5), central Warsaw, 1995-2024",
                   snow=[round(float(x), 3) for x in p]), open(OUT, "w"))
    none = [i + 1 for i in range(365) if p[i] < 0.01]
    print(f"snow chance under 1% on {len(none)} days, days {none[0]}-{none[-1]}")


if __name__ == "__main__":
    main()
