// Builds data/model-ranking.json: how well each model forecast winter precipitation at the
// SNOTEL stations Powcast uses, 1 and 3 days ahead, scored against what the gauges measured.
// Forecasts come from Open-Meteo's Previous Runs API, which keeps each model's earlier runs.
// Run weekly by .github/workflows/data.yml. By hand: node scripts/rank-models.mjs
import {writeFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Output directory: first argument, or data/ next to the site for local runs.
const OUT = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/?$/, '/')) : new URL('../data/', import.meta.url);
import {HOUR, finite, numeric, shiftDate, localDate, integrate} from '../core.js';
import {LOCS, MODELS} from '../locations.js';

const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/';
// Days ahead. Not 0: Open-Meteo's same-day archive stitches each run's first hour or two, where HRRR is
// nearly dry while it spins up, so it would measure spin-up rather than forecast skill.
const LEADS = [1, 3];
const WET_MM = 0.5;          // a station-day counts as wet when either side reaches 0.5 mm (0.02 in)
const STORM_MM = 5;         // a storm day: 5 mm of water, roughly 2 to 3 in of snow
const MIN_COVERAGE = 0.5;    // models with fewer scored days than this share are listed, not ranked
const PAUSE_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
// SNOTEL days are local standard time (UTC-7) all year, so model days use the same fixed offset.
const dayStart = date => Date.parse(`${date}T00:00:00-07:00`);

/** Winter windows (Dec 1 to Mar 31): the last two complete ones, plus the current one to date. */
function windows(today = localDate()) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7), out = [];
  const lastEnd = m >= 4 ? y : y - 1;
  for (const end of [lastEnd - 1, lastEnd]) out.push({start: `${end - 1}-12-01`, end: `${end}-03-31`});
  if (m === 12 || m <= 3) out.push({start: `${m === 12 ? y : y - 1}-12-01`, end: shiftDate(today, -2)});
  return out;
}
async function getJSON(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Retry both HTTP errors and dropped connections; a single network blip must not fail the run.
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(60000)});
      if (r.ok) return await r.json(); // await so a garbled body is retried too
      log(`HTTP ${r.status}, attempt ${attempt}: ${(await r.text()).slice(0, 160)}`);
    } catch (e) { log(`Network error, attempt ${attempt}: ${e.cause?.code || e.message}`); }
    await sleep(attempt * 30000);
  }
  throw new Error(`Request failed: ${url.slice(0, 120)}`);
}
/** Measured daily precipitation (mm) from the accumulated gauge (PREC), end-of-day readings. */
async function measured(triplets, win) {
  const p = new URLSearchParams({stationTriplets: triplets.join(','), elements: 'PREC', duration: 'DAILY', beginDate: shiftDate(win.start, -1), endDate: win.end});
  const out = {};
  for (const st of await getJSON(`${AWDB}data?${p}`)) {
    const vals = new Map((st.data?.[0]?.values || []).map(v => [String(v.date).slice(0, 10), numeric(v.value)]));
    out[st.stationTriplet] = date => {
      const a = vals.get(shiftDate(date, -1)), b = vals.get(date);
      if (!finite(a) || !finite(b)) return null;
      const mm = (b - a) * 25.4;
      return mm < 0 || mm > 150 ? null : mm; // gauge resets and spikes are not precipitation
    };
  }
  return out;
}
async function forecasts(st, win) {
  const ids = MODELS.map(m => m.id);
  const p = new URLSearchParams({latitude: st.lat, longitude: st.lon, hourly: LEADS.map(l => `precipitation_previous_day${l}`).join(','),
    models: ids.join(','), start_date: win.start, end_date: shiftDate(win.end, 1), timezone: 'GMT', timeformat: 'unixtime'});
  const raw = await getJSON(`https://previous-runs-api.open-meteo.com/v1/forecast?${p}`), h = raw.hourly;
  const out = {};
  for (const id of ids) for (const lead of LEADS) {
    const series = h[`precipitation_previous_day${lead}_${id}`];
    if (!series) continue;
    const hours = h.time.map((t, i) => ({t: t * 1000, p: numeric(series[i])}));
    out[`${id}:${lead}`] = date => integrate(hours, dayStart(date), dayStart(shiftDate(date, 1)), 'p').value;
  }
  return out;
}
/** Equitable threat score at a threshold: storm days caught, minus chance hits, over all storm calls. 1 is perfect, 0 is no skill. */
function ets(pairs, t) {
  let a = 0, b = 0, c = 0;
  for (const [f, o] of pairs) { if (f >= t && o >= t) a++; else if (f >= t) b++; else if (o >= t) c++; }
  const ar = (a + b) * (a + c) / pairs.length, den = a + b + c - ar;
  return {ets: den > 0 ? +((a - ar) / den).toFixed(3) : null, caught: a + c ? +(a / (a + c)).toFixed(2) : null, falseAlarms: a + b ? +(b / (a + b)).toFixed(2) : null};
}
/** 90% interval for the storm score from 300 resamples of station-days (deterministic seed). */
function etsInterval(pairs) {
  if (pairs.length < 50) return null;
  let seed = 12345; // mulberry32: 32-bit integer math, so no float precision loss
  const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const vals = [];
  for (let b = 0; b < 300; b++) { const sample = pairs.map(() => pairs[Math.floor(rand() * pairs.length)]); const e = ets(sample, STORM_MM).ets; if (finite(e)) vals.push(e); }
  vals.sort((a, b) => a - b);
  return [+vals[Math.floor(vals.length * 0.05)].toFixed(3), +vals[Math.floor(vals.length * 0.95)].toFixed(3)];
}
function score(pairs) {
  const wet = pairs.filter(([f, o]) => f >= WET_MM || o >= WET_MM);
  const sumF = pairs.reduce((s, [f]) => s + f, 0), sumO = pairs.reduce((s, [, o]) => s + o, 0);
  return {days: pairs.length, wetDays: wet.length,
    maeWetMm: wet.length ? +(wet.reduce((s, [f, o]) => s + Math.abs(f - o), 0) / wet.length).toFixed(2) : null,
    biasPct: sumO > 0 ? Math.round((sumF / sumO - 1) * 100) : null, ...(pairs.length ? ets(pairs, STORM_MM) : {ets: null, caught: null, falseAlarms: null}), etsRange: etsInterval(pairs)};
}

async function main() {
  const triplets = [...new Set(LOCS.map(l => l.snotel))];
  const meta = await getJSON(`${AWDB}stations?${new URLSearchParams({stationTriplets: triplets.join(',')})}`);
  const stations = meta.map(s => ({triplet: s.stationTriplet, name: s.name, lat: s.latitude, lon: s.longitude}));
  const pairs = {}; let possible = 0;
  for (const win of windows()) {
    const obs = await measured(triplets, win);
    const dates = []; for (let d = win.start; d <= win.end; d = shiftDate(d, 1)) dates.push(d);
    for (const st of stations) {
      const fc = await forecasts(st, win);
      possible += dates.length;
      for (const [key, f] of Object.entries(fc)) for (const date of dates) {
        const o = obs[st.triplet]?.(date), v = f(date);
        if (finite(o) && finite(v)) (pairs[key] ||= []).push([v, o]);
      }
      log(`${st.name} ${win.start}..${win.end}`);
      await sleep(PAUSE_MS);
    }
  }
  const leads = {};
  for (const lead of LEADS) {
    const rows = MODELS.map(m => ({id: m.id, name: m.name, ...score(pairs[`${m.id}:${lead}`] || [])}))
      .map(r => ({...r, coverage: +(r.days / possible).toFixed(2)}));
    const ranked = rows.filter(r => r.coverage >= MIN_COVERAGE && finite(r.ets)).sort((a, b) => b.ets - a.ets);
    ranked.forEach((r, i) => { r.rank = i + 1; r.tiedWithBest = !!(r.etsRange && ranked[0].etsRange && r.etsRange[1] >= ranked[0].etsRange[0]); });
    leads[`day${lead}`] = [...ranked, ...rows.filter(r => !ranked.includes(r))];
  }
  const out = {generatedAt: new Date().toISOString(), windows: windows(), stations: stations.length,
    method: 'Daily liquid precipitation forecast 1 and 3 days ahead (Open-Meteo Previous Runs API) at each SNOTEL station, compared with the station precipitation gauge. Ranked by equitable threat score for storm days (5 mm of water, roughly 2 to 3 in of snow): it rewards catching storms and penalizes false alarms, and unlike average error it does not favor smooth, under-forecasting models. Wet-day error is mean absolute error on days where either side reached 0.5 mm. Bias is total forecast versus total measured. Gauges undercatch snow, which affects every model equally.',
    leads};
  await mkdir(OUT, {recursive: true});
  await writeFile(new URL('model-ranking.json', OUT), JSON.stringify(out, null, 1));
  for (const [k, rows] of Object.entries(leads)) log(k, rows.map(r => `${r.rank ?? '-'} ${r.name} ets=${r.ets} pod=${r.caught} far=${r.falseAlarms} mae=${r.maeWetMm} bias=${r.biasPct}% cov=${r.coverage}`).join(' | '));
}
main().catch(e => { console.error(e); process.exit(1); });
