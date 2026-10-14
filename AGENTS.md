# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

1. Static site on GitHub Pages under `/weather/`. No build step, no backend, no secrets in the client. Keep every path relative. Layout, local serving, and tests: see README.md.
2. Data honesty is the product: model, station (SNOTEL), and official (CAIC) values stay labeled separately; missing is `null` and renders as a dash, never zero; model spread is never called a probability. Accumulation goes through `integrate()` in `core.js`, which refuses incomplete windows.
3. Open-Meteo model ids in `MODELS` (app.js) were verified against Colorado coordinates. Some "seamless" ids (MET Norway, KNMI, DMI) silently fall back to ECMWF outside Europe, and GraphCast, BOM, and KMA return no snowfall here; re-probe before adding ids.
4. MapLibre is pinned to the 5.x UMD build with SRI in `map.js`. 6.x is ESM-only and loads its worker from the CDN origin, which breaks cross-origin; do not bump to 6 without self-hosting.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
