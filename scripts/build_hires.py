"""Builds high-resolution map frames for Colorado into OUT_DIR/hires/.

Sources, all free NOAA data:
  snow    NBM (National Blend of Models) snowfall, 2.5 km: hourly to 48 h, then 6-hourly to day 11.
  radar   HRRR simulated composite reflectivity, 3 km, hourly to 48 h.
  past    NOHRSC National Snowfall Analysis (observed), 0.04 deg, one 24 h map per day.

Each frame is a small palette PNG on a Web Mercator grid over Colorado, plus manifest.json.
Run by .github/workflows/data.yml. By hand: python scripts/build_hires.py OUT_DIR
"""
import datetime as dt
import io
import json
import logging
import math
import pathlib
import sys
import time
import urllib.request

import eccodes
import h5py
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

log = logging.getLogger("hires")

WEST, EAST, SOUTH, NORTH = -109.3, -101.8, 36.8, 41.2  # Colorado plus a margin
DEG_PER_PX = 0.02                                       # sampling grid, about 2 km, finer than every source
SMOOTH = 2                                              # PNGs are drawn at 1 km by smoothing values, so color edges blend
NBM = "https://noaa-nbm-grib2-pds.s3.amazonaws.com"
HRRR = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
NOHRSC = "https://www.nohrsc.noaa.gov/snowfall_v2/data"
PAST_DAYS = 10
NBM_LAST_HOUR = 264

# Snowfall color steps in inches (same breaks as the common NWS/OpenSnow snowfall scale).
SNOW_STEPS = [(0.1, "#c0d8e6"), (1, "#66abd3"), (3, "#00278f"), (6, "#eeef92"), (8, "#fcc80f"), (10, "#ff8300"),
              (12, "#db1c00"), (18, "#9e0101"), (24, "#750000"), (30, "#c9c8fb"), (36, "#9c8bd6"), (48, "#805daa"),
              (60, "#56226f"), (72, "#340439"), (100, "#3fe1ff")]
# Radar reflectivity color steps in dBZ (NWS standard). Below 10 dBZ is left clear to hide noise.
RADAR_STEPS = [(10, "#019ff4"), (15, "#0300f4"), (20, "#02fd02"), (25, "#01c501"), (30, "#008e00"), (35, "#fdf802"),
               (40, "#e5bc00"), (45, "#fd9500"), (50, "#fd0000"), (55, "#d40000"), (60, "#bc0000"), (65, "#f800fd"), (70, "#9854c6")]


def get(url, byte_range=None, tries=5):
    """HTTP GET with retries for both HTTP errors and dropped connections."""
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "alecs-snow-page"})
            if byte_range:
                req.add_header("Range", f"bytes={byte_range[0]}-{'' if byte_range[1] is None else byte_range[1]}")
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001  (network, HTTP and timeout errors are all retried)
            if getattr(e, "code", None) == 404:
                raise
            log.warning("attempt %d failed for %s: %s", attempt, url[-80:], e)
            time.sleep(attempt * 20)
    raise RuntimeError(f"giving up on {url}")


def exists(url):
    try:
        get(url, byte_range=(0, 0), tries=2)
        return True
    except Exception:  # noqa: BLE001
        return False


def idx_ranges(idx_text, want):
    """Byte ranges of GRIB records whose idx line ends with `want` (for example 'ASNOW:surface:0-1 hour acc fcst:')."""
    lines = [ln for ln in idx_text.splitlines() if ln.strip()]
    out = []
    for i, ln in enumerate(lines):
        if ln.endswith(want) or ln.endswith(want.rstrip(":")):
            start = int(ln.split(":")[1])
            end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else None
            out.append((start, end))
    return out


class Target:
    """Web Mercator pixel grid over Colorado, so MapLibre can drape it without distortion."""

    def __init__(self):
        merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))  # noqa: E731
        self.w = round((EAST - WEST) / DEG_PER_PX)
        self.h = round(self.w * (merc(NORTH) - merc(SOUTH)) / math.radians(EAST - WEST))
        ys = merc(NORTH) - (np.arange(self.h) + 0.5) * (merc(NORTH) - merc(SOUTH)) / self.h
        self.lat = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
        self.lon = WEST + (np.arange(self.w) + 0.5) * (EAST - WEST) / self.w
        self.lon2d, self.lat2d = np.meshgrid(self.lon, self.lat)


class Regridder:
    """Nearest-neighbour lookup from a curvilinear source grid (lat/lon arrays) to the target."""

    def __init__(self, lats, lons, target):
        lons = np.where(lons > 180, lons - 360, lons)
        keep = (lats > SOUTH - 0.5) & (lats < NORTH + 0.5) & (lons > WEST - 0.5) & (lons < EAST + 0.5)
        self.src_index = np.flatnonzero(keep)
        k = math.cos(math.radians((SOUTH + NORTH) / 2))
        tree = cKDTree(np.column_stack([lons[keep] * k, lats[keep]]))
        _, nearest = tree.query(np.column_stack([target.lon2d.ravel() * k, target.lat2d.ravel()]))
        self.lookup = self.src_index[nearest]
        self.shape = (target.h, target.w)

    def __call__(self, values):
        return values[self.lookup].reshape(self.shape)


def decode(grib_bytes):
    gid = eccodes.codes_new_from_message(grib_bytes)
    try:
        vals = eccodes.codes_get_values(gid)
        missing = eccodes.codes_get(gid, "missingValue")
        vals = np.where(vals == missing, np.nan, vals)
        if eccodes.codes_get(gid, "alternativeRowScanning") == 1:
            # NBM stores every other row right to left; put rows back in the order the coordinates use.
            ni, nj = eccodes.codes_get(gid, "Ni"), eccodes.codes_get(gid, "Nj")
            grid = vals.reshape(nj, ni)
            grid[1::2] = grid[1::2, ::-1]
            vals = grid.ravel()
        return vals, gid
    except Exception:
        eccodes.codes_release(gid)
        raise


def colorize(values, steps):
    """Palette indexes: 0 is transparent (missing or below the first step), i is steps[i-1]."""
    breaks = np.array([b for b, _ in steps])
    return np.searchsorted(breaks, np.nan_to_num(values, nan=-1), side="right").astype(np.uint8)


def save_png(path, values, steps):
    """Palette PNG of `values`, upsampled bilinearly first (values, not colors) so bins get smooth
    edges instead of 2 km squares. grid_mode keeps pixel centers aligned with the map bounds."""
    values = ndimage.zoom(np.nan_to_num(values, nan=-1.0), SMOOTH, order=1, grid_mode=True, mode="nearest")
    img = Image.fromarray(colorize(values, steps), mode="P")
    palette = [0, 0, 0] + [int(c[i:i + 2], 16) for _, c in steps for i in (1, 3, 5)]
    img.putpalette(palette + [0] * (768 - len(palette)))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True, transparency=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())


def latest_cycle(base, fmt_dir, fmt_file, last_hour, now):
    """Most recent 00/06/12/18 UTC run whose final forecast hour is published."""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= dt.timedelta(hours=t.hour % 6)
    for _ in range(6):
        if exists(f"{base}/{fmt_dir(t)}/{fmt_file(t, last_hour)}.idx"):
            return t
        t -= dt.timedelta(hours=6)
    raise RuntimeError(f"no complete run found at {base}")


def build_snow(out, target, now):
    nbm_dir = lambda t: f"blend.{t:%Y%m%d}/{t:%H}/core"  # noqa: E731
    nbm_file = lambda t, f: f"blend.t{t:%H}z.core.f{f:03d}.co.grib2"  # noqa: E731
    run = latest_cycle(NBM, nbm_dir, nbm_file, NBM_LAST_HOUR, now)
    steps = [(f - 1, f) for f in range(1, 49)] + [(f - 6, f) for f in range(54, NBM_LAST_HOUR + 1, 6)]
    total, regrid, frames = None, None, []
    for a, b in steps:
        url = f"{NBM}/{nbm_dir(run)}/{nbm_file(run, b)}"
        ranges = idx_ranges(get(url + ".idx").decode(), f"ASNOW:surface:{a}-{b} hour acc fcst:")
        if not ranges:
            log.warning("NBM f%03d has no %d-%d h snowfall; stopping there", b, a, b)
            break
        vals, gid = decode(get(url, ranges[0]))
        if regrid is None:
            regrid = Regridder(eccodes.codes_get_array(gid, "latitudes"), eccodes.codes_get_array(gid, "longitudes"), target)
        eccodes.codes_release(gid)
        inches = regrid(vals) / 0.0254  # GRIB ASNOW is metres
        total = inches if total is None else total + np.nan_to_num(inches)
        name = f"snow/f{b:03d}.png"
        save_png(out / name, total, SNOW_STEPS)
        frames.append({"t": (run + dt.timedelta(hours=b)).isoformat() + "Z", "file": name})
    return {"source": "NBM snowfall (ASNOW), 2.5 km", "run": run.isoformat() + "Z", "accumulatedFrom": run.isoformat() + "Z", "frames": frames}


def build_radar(out, target, now):
    hrrr_dir = lambda t: f"hrrr.{t:%Y%m%d}/conus"  # noqa: E731
    hrrr_file = lambda t, f: f"hrrr.t{t:%H}z.wrfsfcf{f:02d}.grib2"  # noqa: E731
    run = latest_cycle(HRRR, hrrr_dir, hrrr_file, 48, now)
    regrid, frames = None, []
    for f in range(1, 49):
        url = f"{HRRR}/{hrrr_dir(run)}/{hrrr_file(run, f)}"
        ranges = idx_ranges(get(url + ".idx").decode(), f"REFC:entire atmosphere:{f} hour fcst:")
        if not ranges:
            break
        vals, gid = decode(get(url, ranges[0]))
        if regrid is None:
            regrid = Regridder(eccodes.codes_get_array(gid, "latitudes"), eccodes.codes_get_array(gid, "longitudes"), target)
        eccodes.codes_release(gid)
        name = f"radar/f{f:02d}.png"
        save_png(out / name, regrid(vals), RADAR_STEPS)
        frames.append({"t": (run + dt.timedelta(hours=f)).isoformat() + "Z", "file": name})
    return {"source": "HRRR simulated composite reflectivity, 3 km", "run": run.isoformat() + "Z", "frames": frames}


def build_past(out, target, now):
    """Observed 24 h snowfall, newest first; frame k is the total of the last k days."""
    end = now.replace(hour=12, minute=0, second=0, microsecond=0)
    if end > now:
        end -= dt.timedelta(days=1)
    total, frames = None, []
    for k in range(PAST_DAYS):
        stop = end - dt.timedelta(days=k)
        url = f"{NOHRSC}/{stop:%Y%m}/sfav2_CONUS_24h_{stop:%Y%m%d%H}.nc"
        try:
            raw = get(url, tries=3)
        except Exception as e:  # noqa: BLE001
            log.warning("NOHRSC %s unavailable (%s); past frames stop here", stop.date(), e)
            break
        with h5py.File(io.BytesIO(raw), "r") as f:
            data = f["Data"]
            units = data.attrs["units"][0]
            units = units.decode() if isinstance(units, bytes) else str(units)
            if units != "m":
                raise RuntimeError(f"unexpected NOHRSC units {units!r}")
            vals = data[:].astype("float64")
            vals[vals < -9000] = np.nan
            lat, lon = f["lat"][:], f["lon"][:]
        # Regular lat/lon grid: sample bilinearly in index space (works whichever way the axes run).
        rows = (target.lat2d - lat[0]) / (lat[1] - lat[0])
        cols = (target.lon2d - lon[0]) / (lon[1] - lon[0])
        inches = ndimage.map_coordinates(np.nan_to_num(vals, nan=0.0), [rows, cols], order=1, mode="nearest") / 0.0254
        total = inches if total is None else total + np.nan_to_num(inches)
        name = f"past/d{k + 1:02d}.png"
        save_png(out / name, total, SNOW_STEPS)
        frames.append({"from": (end - dt.timedelta(days=k + 1)).isoformat() + "Z", "to": end.isoformat() + "Z", "file": name})
    return {"source": "NOHRSC National Snowfall Analysis v2 (observed), 0.04 deg", "frames": frames}


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out") / "hires"
    target, now = Target(), dt.datetime.now(dt.UTC).replace(tzinfo=None)
    manifest = {"generatedAt": now.isoformat() + "Z", "bounds": [WEST, SOUTH, EAST, NORTH], "size": [target.w * SMOOTH, target.h * SMOOTH], "projection": "web-mercator",
                "snowSteps": SNOW_STEPS, "radarSteps": RADAR_STEPS}
    for key, build in (("past", build_past), ("snow", build_snow), ("radar", build_radar)):
        try:
            manifest[key] = build(out, target, now)
            log.info("%s: %d frames", key, len(manifest[key]["frames"]))
        except Exception as e:  # noqa: BLE001  (one failed source must not sink the others)
            log.error("%s failed: %s", key, e)
            manifest[key] = {"error": str(e), "frames": []}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    if not any(manifest[k]["frames"] for k in ("past", "snow", "radar")):
        sys.exit("every high-resolution source failed")


if __name__ == "__main__":
    main()
