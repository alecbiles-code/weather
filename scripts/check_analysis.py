"""Checks the NOAA analysis (NOHRSC National Snowfall Analysis v2, the site's "NOAA analysis" column) against the
same four observer snow boards that scripts/check-station-estimate.mjs uses for the SNOTEL station estimate.

Each board report dated D covers about 7 AM D-1 to 7 AM D; the sfav2 24 h file stamped D 12Z covers 5 AM to 5 AM
(6 AM in daylight time) over the same night, so the two are paired directly. The analysis is read at the nearest
0.04 deg cell to the board, with read_sfav2 and sample_points from build_hires.py, as the data job does.
The analysis assimilates COOP and CoCoRaHS reports, these boards included, so agreement here is an upper bound on
its skill away from observers (in high terrain, for example), not an independent test.

Run each autumn next to check-station-estimate.mjs (needs the workflow's Python packages):
  pip install numpy pillow scipy h5py eccodes
  python scripts/check_analysis.py CACHE_DIR [first water year] [last water year]
CACHE_DIR keeps the downloaded files (about 0.3 MB a day, 240 MB for six winters) so reruns are fast.
Prints the share of board snowfall (Dec 1 to Mar 31), the daily mean absolute error and the correlation, with the
same acceptance test as the station estimate: pooled share 85% to 105%, no station-season above 130%.
"""
import concurrent.futures
import datetime as dt
import json
import logging
import pathlib
import sys
import urllib.parse

import numpy as np

from build_hires import NOHRSC, get, read_sfav2, sample_points

log = logging.getLogger("check_analysis")

BOARDS = ["USC00051660", "US1COGN0066", "USC00058184", "US1COGR0073"]  # as PAIRS in check-station-estimate.mjs
ACIS = "https://data.rcc-acis.org"
MIN_DAYS = 30  # a station-season with fewer paired days is skipped


def board_value(v):
    """Board snowfall in inches: T is 0; missing, accumulated (A) and other flags are None."""
    s = str(v).strip()
    if s == "T":
        return 0.0
    return float(s) if s.replace(".", "", 1).isdigit() else None


def season_dates(wy):
    """Board report dates Dec 2 to Apr 1 of water year wy: the nights of Dec 1 to Mar 31, as in the station check."""
    d, end = dt.date(wy - 1, 12, 2), dt.date(wy, 4, 1)
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def analysis_file(cache, day):
    """Cached sfav2 24 h file ending 12Z on `day`, or None when NOHRSC has none."""
    path = cache / f"sfav2_CONUS_24h_{day:%Y%m%d}12.nc"
    if not path.exists():
        try:
            path.write_bytes(get(f"{NOHRSC}/{day:%Y%m}/{path.name}", tries=3))
        except Exception as e:  # noqa: BLE001  (a missing day is skipped, never counted as zero)
            log.warning("no analysis for %s (%s)", day, e)
            return None
    return path


def stats(pairs):
    """Share of board snow, daily MAE and correlation of [(analysis, board), ...]."""
    a, b = np.array(pairs).T
    return a.sum() / b.sum(), np.abs(a - b).mean(), np.corrcoef(a, b)[0, 1]


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    cache = pathlib.Path(sys.argv[1])
    first, last = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (2021, 2026)
    cache.mkdir(parents=True, exist_ok=True)
    points, boards = {}, {}
    for sid in BOARDS:
        q = urllib.parse.urlencode({"sid": sid, "sdate": f"{first - 1}-12-01", "edate": f"{last}-04-01", "elems": "snow", "meta": "name,ll"})
        j = json.loads(get(f"{ACIS}/StnData?{q}"))
        points[j["meta"]["name"]] = (j["meta"]["ll"][1], j["meta"]["ll"][0])
        boards[j["meta"]["name"]] = {dt.date.fromisoformat(d): board_value(v) for d, v in j["data"]}
    days = [d for wy in range(first, last + 1) for d in season_dates(wy)]
    with concurrent.futures.ThreadPoolExecutor(4) as pool:  # NOHRSC is a small public server: 4 at a time
        files = dict(zip(days, pool.map(lambda d: analysis_file(cache, d), days)))
    analysis = {}
    for d, path in files.items():
        if path:
            vals, lat, lon = read_sfav2(path.read_bytes())
            analysis[d] = {k: v for k, (v, _, _) in sample_points(vals, lat, lon, points).items()}
    pooled, worst = [], 0.0
    for name in points:
        for wy in range(first, last + 1):
            pairs = [(analysis[d][name], boards[name][d]) for d in season_dates(wy)
                     if boards[name].get(d) is not None and analysis.get(d, {}).get(name) is not None]
            if len(pairs) < MIN_DAYS:
                print(f"WY{wy} {name}: {len(pairs)} paired days, skipped")
                continue
            share, mae, _ = stats(pairs)
            worst = max(worst, share)
            pooled += pairs
            print(f"WY{wy} {name}: {len(pairs)} days, board {sum(b for _, b in pairs):.1f} in, analysis {100 * share:.0f}%, daily MAE {mae:.2f} in")
    share, mae, r = stats(pooled)
    ok = 0.85 <= share <= 1.05 and worst <= 1.3
    print(f"\nPooled, board total {sum(b for _, b in pooled):.0f} in over {len(pooled)} days: analysis {100 * share:.0f}% of board snow, "
          f"daily MAE {mae:.2f} in, r {r:.2f}, worst season {100 * worst:.0f}%, acceptance {'PASS' if ok else 'FAIL'}")


if __name__ == "__main__":
    main()
