// Builds data/boards.json for the location pages: for each location, the nearest human-read snow
// board (NWS COOP or CoCoRaHS, via RCC-ACIS) and its last 3 daily reports of new snow and depth.
// Run by .github/workflows/data.yml every 6 hours. By hand: node scripts/build-boards.mjs
import {writeFile, mkdir, access} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {localDate, shiftDate} from '../core.js';
import {LOCS} from '../locations.js';

const ACIS = 'https://data.rcc-acis.org/MultiStnData';
const BBOX = '-109.1,36.9,-104.9,41.1';  // Colorado plus a margin, as in the research report
const MAX_MILES = 10;          // farther boards say little about the location's snow
const MAX_ELEV_DIFF_FT = 1500; // station elevation vs the resort base or pass elevation
const SELECT_DAYS = 60;        // look-back window for judging whether an observer is active
const MIN_REPORTS = 30;        // active = a snowfall report on at least half the days in the window
const SHOW_DAYS = 3;           // today and the 2 days before
const EARTH_MI = 3958.8;       // mean Earth radius in miles
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ACIS daily value: number, 'T' trace, 'M' missing, or a number with an 'A' suffix for a multi-day
// accumulation ending that day. 'S' (seen in real responses just before an 'A' day) is not documented
// by ACIS and is treated as missing, like anything else unparseable.
export function parseValue(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === 'T') return {value: 0, trace: true, accumulated: false};
  if (/^\d+(\.\d+)?A$/.test(s)) return {value: null, trace: false, accumulated: true};
  if (/^\d+(\.\d+)?$/.test(s)) return {value: Number(s), trace: false, accumulated: false};
  return {value: null, trace: false, accumulated: false};
}
const reported = v => { const p = parseValue(v); return p.value !== null || p.accumulated; };

// ACIS sids are "<id> <type>"; type codes from Table 1 of https://www.rcc-acis.org/ACISWSdoc.html:
// 2 = 6-digit COOP id, 10 = 8-character CoCoRaHS id, 6 = 11-character GHCN-D id.
const sid = (sids, type) => (sids || []).map(s => String(s).split(' ')).find(([, t]) => t === String(type))?.[0] || null;
export function classify(sids) {
  const cocorahs = sid(sids, 10), coop = sid(sids, 2), ghcn = sid(sids, 6);
  // CoCoRaHS pages use CO-BO-322 for ACIS COBO0322 (checked against dex.cocorahs.org, 2026-10-21).
  if (cocorahs) return {network: 'CoCoRaHS', id: cocorahs,
    url: `https://dex.cocorahs.org/stations/${cocorahs.slice(0, 2)}-${cocorahs.slice(2, 4)}-${Number(cocorahs.slice(4))}`};
  if (coop) return {network: 'NWS COOP', id: coop,
    url: ghcn ? `https://www.ncei.noaa.gov/cdo-web/datasets/GHCND/stations/GHCND:${ghcn}/detail` : 'https://www.weather.gov/coop/'};
  return null; // SNOTEL and other automated networks: not an observer board
}

export function miles(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(a)) * EARTH_MI;
}
export const refElev = loc => loc.kind === 'resort' ? loc.base : loc.elev;

// stations: ACIS MultiStnData `data` (meta + one [snow, snwd] pair per day, oldest first).
export function nearestBoard(loc, stations, opts = {}) {
  const {maxMiles = MAX_MILES, maxElevDiffFt = MAX_ELEV_DIFF_FT, minReports = MIN_REPORTS} = opts;
  let best = null;
  for (const s of stations) {
    const net = classify(s.meta?.sids), [lon, lat] = s.meta?.ll || [], elev = s.meta?.elev;
    if (!net || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(elev)) continue;
    const mi = miles(loc.lat, loc.lon, lat, lon), diff = elev - refElev(loc);
    if (mi > maxMiles || Math.abs(diff) > maxElevDiffFt) continue;
    if ((s.data || []).filter(d => reported(d?.[0])).length < minReports) continue;
    if (!best || mi < best.mi) best = {s, net, lat, lon, elev, mi, diff};
  }
  if (!best) return null;
  return {station: {name: best.s.meta.name, network: best.net.network, id: best.net.id, lat: best.lat, lon: best.lon, elevFt: best.elev,
    miles: Math.round(best.mi * 10) / 10, elevDiffFt: Math.round(best.diff), url: best.net.url}, data: best.s.data};
}

// dates: the window's dates, oldest first, matching each station's data rows. Reports newest first.
export function lastReports(data, dates, n = SHOW_DAYS) {
  return dates.map((date, i) => ({date, row: data?.[i]})).slice(-n).reverse().map(({date, row}) => {
    const snow = parseValue(row?.[0]);
    return {date, snowIn: snow.value, trace: snow.trace, accumulated: snow.accumulated, depthIn: parseValue(row?.[1]).value};
  });
}

async function getJSON(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Retry dropped connections and server errors; a 4xx is our request's fault and will not improve.
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(120000)});
      if (r.ok) return await r.json(); // await so a garbled body is retried too
      log(`HTTP ${r.status}, attempt ${attempt}: ${(await r.text()).slice(0, 160)}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { log(`Network error, attempt ${attempt}: ${e.cause?.code || e.message}`); }
    if (attempt < 5) await sleep(attempt * 30000);
  }
  throw new Error(`Request failed: ${url.slice(0, 120)}`);
}

async function main() {
  // Output directory: first argument, or data/ next to the site for local runs.
  const OUT = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/?$/, '/')) : new URL('../data/', import.meta.url);
  const file = new URL('boards.json', OUT), today = localDate();
  const dates = Array.from({length: SELECT_DAYS}, (_, i) => shiftDate(today, i - SELECT_DAYS + 1));
  const p = new URLSearchParams({bbox: BBOX, sdate: dates[0], edate: today, elems: 'snow,snwd', meta: 'name,sids,ll,elev'});
  let stations;
  try {
    const j = await getJSON(`${ACIS}?${p}`);
    if (j.error) throw new Error(`ACIS error: ${j.error}`);
    stations = j.data;
    if (!Array.isArray(stations) || !stations.length) throw new Error('ACIS returned no stations');
  } catch (e) {
    // The job starts from the last published data, so a stale file beats none.
    // Exit non-zero anyway, so the data job turns red and the failure is noticed.
    if (await access(file).then(() => true, () => false)) { log(`WARNING: ${e.message}; keeping the previous boards.json`); process.exitCode = 1; return; }
    throw e;
  }
  const locations = {};
  for (const loc of LOCS) {
    const b = nearestBoard(loc, stations);
    locations[loc.id] = b && {station: b.station, reports: lastReports(b.data, dates)};
  }
  const out = {generatedAt: new Date().toISOString(), source: 'RCC-ACIS (NWS COOP and CoCoRaHS)', maxMiles: MAX_MILES, maxElevDiffFt: MAX_ELEV_DIFF_FT, locations};
  await mkdir(OUT, {recursive: true});
  await writeFile(file, JSON.stringify(out));
  log(`wrote boards.json: ${Object.values(locations).filter(Boolean).length}/${LOCS.length} locations with a board, ${stations.length} ACIS stations, ${dates[0]} to ${today}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
