// Builds data/grid.json for the map: daily snowfall on a grid over Colorado for the next 15 days,
// hourly precipitation for the next 48 hours, and a statewide freezing level per day.
// Run by .github/workflows/data.yml every 6 hours. By hand: node scripts/build-grid.mjs
import {writeFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Output directory: first argument, or data/ next to the site for local runs.
const OUT = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/?$/, '/')) : new URL('../data/', import.meta.url);
import {HOUR, TZ, localDate, shiftDate, dailyTotal, dayBounds, normalizeForecast, finite} from '../core.js';

const GRID = {west: -109.0, east: -102.0, south: 37.0, north: 41.0, step: 0.2};
const DAYS = 15;            // today + 14; Open-Meteo's 16th local day ends an hour short
const HOURS = 48;           // precipitation frames for the map's forecast timeline
const CHUNK = 100;          // locations per request
const PAUSE_MS = 8000;      // stays well under Open-Meteo's free per-minute limit
const MOUNTAIN_M = 2400;    // grid points at or above this elevation feed the freezing level
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function points() {
  const cols = Math.round((GRID.east - GRID.west) / GRID.step) + 1, rows = Math.round((GRID.north - GRID.south) / GRID.step) + 1, pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push({lat: +(GRID.north - r * GRID.step).toFixed(3), lon: +(GRID.west + c * GRID.step).toFixed(3)});
  return {cols, rows, pts};
}
async function fetchChunk(pts) {
  const p = new URLSearchParams({latitude: pts.map(x => x.lat).join(','), longitude: pts.map(x => x.lon).join(','),
    hourly: 'snowfall,precipitation,freezing_level_height', forecast_days: '16', timezone: TZ, timeformat: 'unixtime'});
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Retry both HTTP errors and dropped connections; a single network blip must not fail the run.
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, {signal: AbortSignal.timeout(60000)});
      if (r.ok) { const j = await r.json(); return Array.isArray(j) ? j : [j]; } // a garbled body throws here and is retried
      log(`HTTP ${r.status}, attempt ${attempt}: ${(await r.text()).slice(0, 160)}`);
    } catch (e) { log(`Network error, attempt ${attempt}: ${e.cause?.code || e.message}`); }
    await sleep(attempt * 30000);
  }
  throw new Error('Open-Meteo request failed after retries');
}
const median = v => { const s = v.filter(finite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function main() {
  const {cols, rows, pts} = points(), today = localDate();
  const days = Array.from({length: DAYS}, (_, i) => shiftDate(today, i));
  const first = Math.floor(Date.now() / HOUR) * HOUR + HOUR, hours = Array.from({length: HOURS}, (_, i) => first + i * HOUR);
  const daily = days.map(() => []), precip = hours.map(() => []), freezing = days.map(() => []);
  for (let i = 0; i < pts.length; i += CHUNK) {
    const list = await fetchChunk(pts.slice(i, i + CHUNK));
    for (const raw of list) {
      const d = normalizeForecast(raw), byT = new Map(d.hours.map(h => [h.t, h]));
      days.forEach((date, k) => {
        const v = dailyTotal(d.hours, date);
        daily[k].push(finite(v) ? Math.round(v * 10) : null); // tenths of a cm
        if (finite(d.elevation) && d.elevation >= MOUNTAIN_M) {
          const [a, b] = dayBounds(date), fl = d.hours.filter(h => h.t > a && h.t <= b).map(h => h.freezing).filter(finite);
          if (fl.length) freezing[k].push(fl.reduce((s, x) => s + x, 0) / fl.length);
        }
      });
      hours.forEach((t, k) => { const v = byT.get(t)?.precip; precip[k].push(finite(v) ? Math.round(v * 10) : null); }); // tenths of a mm
    }
    log(`fetched ${Math.min(i + CHUNK, pts.length)}/${pts.length}`);
    if (i + CHUNK < pts.length) await sleep(PAUSE_MS);
  }
  const out = {generatedAt: new Date().toISOString(), source: 'Open-Meteo forecast API, best_match', grid: {...GRID, cols, rows},
    units: {daily: 'tenths of cm, calendar day in America/Denver', precip: 'tenths of mm in the hour ending at each time', freezingLevelM: 'meters'},
    days, daily, hours: hours.map(t => t / 1000), precip, freezingLevelM: freezing.map(f => { const m = median(f); return finite(m) ? Math.round(m) : null; })};
  await mkdir(OUT, {recursive: true});
  await writeFile(new URL('grid.json', OUT), JSON.stringify(out));
  log(`wrote data/grid.json: ${cols}x${rows} points, ${DAYS} days, ${HOURS} hours`);
}
main().catch(e => { console.error(e); process.exit(1); });
