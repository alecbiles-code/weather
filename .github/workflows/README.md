# ALEC'S SNOW PAGE

Colorado snow viewer for 32 resorts and backcountry passes, live at https://alecbiles-code.github.io/weather/. Windows 95 look, real data underneath.

1. Homepage: a sortable table of daily snowfall. The past 10 days come from one of three labeled sources (the SNOTEL station estimate by default, the NOAA snowfall analysis, or the model), and the next 15 come from the Open-Meteo forecast, with 5, 10 and 15 day totals. Also on the page: snow quality, Skier of the Day, Alec's Fun Fact, Storm Watch, the Season Snowfall Leaders, the Snowpack Power Rankings (snowpack percentile per resort, as in the NRCS state products), and an optional guestbook.
2. Location pages: daily and hourly snowfall, a scoreboard of which model to trust (scored against last winter's measurements), a 14-model comparison, a day table with the station estimate, the NOAA analysis and snow quality, the SNOTEL snowpack, the CAIC bulletin, the nearest observer snow board, and a webcam link.
3. 3D map: MapLibre GL with terrain, snowfall columns, and a 15-day snow field with a time slider. Also: a radar timeline, ski trails, avalanche zones, SNOTEL pins, freezing-level shading, falling snow, and a storm tour.

## Layout

Static files, no build step, no backend, no API keys.

1. `index.html`, `styles.css`: the page shell and all styling.
2. `core.js`: pure logic (time zones, accumulation, the SNOTEL station estimate, quality, bulletin times, routes, CSV, daily picks) and the network policy (timeout and bounded retry for every request). No DOM.
3. `locations.js`: the 32 locations, webcam links, the on-mountain points where the NOAA analysis is read, and the model list. Shared by the site and the scripts.
4. `app.js`: data loading (each source on its own, with a saved last-good copy in the browser), routing, the homepage, location pages, map controls, and the Methods page.
5. `retro.js`: Start menu, ticker, sparkles, Skier of the Day, Fun Fact, and the guestbook.
6. `map.js`: the 3D map, loaded only when the map opens.
7. `data/`: lists you can edit (`skiers.csv`, `facts.csv`, `guestbook.json`) and generated data (`grid.json`, `model-ranking.json`, `snowpack-history.json`, `boards.json`, `hires/`).
8. `scripts/` and `.github/workflows/data.yml`: the scheduled job. Every 6 hours it rebuilds `grid.json`, `snowpack-history.json`, `boards.json` (nearest observer snow boards, RCC-ACIS) and `hires/` (map frames, plus the NOAA analysis at each location in `hires/manifest.json` under `past.points`); weekly, `model-ranking.json`. Each step can fail on its own without blocking the others.

## Editing the fun stuff

1. Skiers: add a row to `data/skiers.csv` (`first_name,last_name,nickname,home`).
2. Fun facts: add a row to `data/facts.csv`. Wrap a fact in double quotes if it contains a comma.
3. Guestbook: see `GUESTBOOK-SETUP.txt` in the hand-off folder, then fill in `data/guestbook.json`. Leave it blank to hide the guestbook.

## Run locally

ES modules need HTTP, not `file://`. To mirror the GitHub Pages subpath:

```sh
mkdir -p /tmp/site && ln -sfn "$PWD" /tmp/site/weather
python3 -m http.server 8765 --directory /tmp/site
# open http://localhost:8765/weather/
```

## Test and data

```sh
node --test test/core.test.mjs
node scripts/build-grid.mjs      # about 5 minutes; Open-Meteo free-tier friendly
node scripts/rank-models.mjs     # about 2 minutes
node scripts/build-snowpack.mjs  # about 1 minute; SNOTEL history for the percentile rankings
node scripts/build-boards.mjs    # about 10 seconds; nearest observer snow boards
node scripts/check-station-estimate.mjs  # each autumn: the SNOTEL station estimate against 4 observer boards
```

## Deploy

GitHub Pages serves the repository root. The scheduled job needs Settings > Actions > General > Workflow permissions set to "Read and write".
