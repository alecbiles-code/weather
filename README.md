# Powcast

Colorado snowfall viewer for 32 resorts and backcountry passes, live at https://alecbiles-code.github.io/weather/.

1. Homepage: a sortable matrix of daily snowfall, past 10 days and next 15, for every location, with a storm timeline row.
2. Location pages: daily and hourly snowfall, a 14-model comparison with spread labels, a day table with a labeled snow-density estimate, the nearest SNOTEL station, and the matching CAIC bulletin.
3. 3D map: MapLibre GL with keyless terrain, snowfall columns, day playback, and optional radar.

Model output, station measurements, and official bulletins stay labeled separately. Missing data is shown as a dash, never zero. See the in-app Methods page for sources and model ids.

## Layout

Static files, no build step, no backend, no API keys.

1. `index.html`: page shell.
2. `styles.css`: all styling, light and dark tokens.
3. `core.js`: pure logic (time zones, accumulation, parsing, model spread, density estimate). No DOM.
4. `app.js`: data loading, routing, homepage, location pages, Methods page.
5. `map.js`: the 3D map, loaded only when the map view opens.

## Run locally

ES modules need HTTP, not `file://`. To mirror the GitHub Pages subpath:

```sh
mkdir -p /tmp/site && ln -sfn "$PWD" /tmp/site/weather
python3 -m http.server 8765 --directory /tmp/site
# open http://localhost:8765/weather/
```

## Test

```sh
node --test test/core.test.mjs
```

## Deploy

GitHub Pages serves the repository root. Pushing to `main` publishes; there is nothing to build.
