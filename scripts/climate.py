"""What Warsaw's weather is like on each day of the year, so the viewer shows a typical day and offers only what can
happen then (no snow in June).

Open-Meteo's historical archive (ERA5 reanalysis, 1995-2024) for central Warsaw, over a window of ±10 days around each
day of the year:
  clear / cloudy / rain / snow: the share of days of each kind (snow: >= 1 cm fresh; rain: >= 2 mm; cloudy: mean
         cloud >= 75%; clear: the rest), summing to 1
  cover: the share of days with >= 2 cm of snow lying
  snowy: whether any snow fell (> 0.2 cm) in the window in 30 years, to offer snow at all

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

API = "https://archive-api.open-meteo.com/v1/archive?latitude=52.23&longitude=21.01&start_date=1995-01-01&end_date=2024-12-31&timezone=Europe%2FWarsaw"
DAILY = Path(RAW) / "climate" / "warsaw_daily2.json"
OUT = Path(__file__).parent.parent / "web/public/data/climate.json"
WINDOW = 10


def fetch(path, query):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(f"{API}&{query}", path)
    return json.load(open(path))


def per_day(times, x):
    doy = np.minimum([dt.date.fromisoformat(t[:10]).timetuple().tm_yday for t in times], 365) - 1
    k = np.ones(2 * WINDOW + 1)
    wrap = lambda a: np.convolve(np.r_[a[-WINDOW:], a, a[:WINDOW]], k, "valid")
    return wrap(np.bincount(doy, x, minlength=365)) / wrap(np.bincount(doy, minlength=365))


def main():
    d = fetch(DAILY, "daily=weather_code,snowfall_sum,rain_sum,cloud_cover_mean,snow_depth_mean")["daily"]
    a = lambda k: np.array([v if v is not None else 0 for v in d[k]], float)
    sf, rain, cloud, depth = a("snowfall_sum"), a("rain_sum"), a("cloud_cover_mean"), a("snow_depth_mean")
    snow = sf >= 1
    wet = ~snow & (rain >= 2)
    grey = ~snow & ~wet & (cloud >= 75)
    kinds = {k: per_day(d["time"], v.astype(float)) for k, v in
             dict(clear=~(snow | wet | grey), cloudy=grey, rain=wet, snow=snow).items()}

    snowy = per_day(d["time"], (sf > 0.2).astype(float)) > 0
    r = lambda p: [round(float(x), 3) for x in p]
    json.dump(dict(source="Open-Meteo historical weather API (ERA5), central Warsaw, 1995-2024",
                   **{k: r(v) for k, v in kinds.items()}, cover=r(per_day(d["time"], (depth >= 0.02).astype(float))),
                   snowy=[bool(x) for x in snowy]), open(OUT, "w"))
    none = np.nonzero(~snowy)[0] + 1
    print(f"no snow at all on days {none[0]}-{none[-1]}")


if __name__ == "__main__":
    main()
