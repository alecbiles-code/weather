// Powcast: static Colorado snowfall viewer. No build step, no backend, no API keys.
import {HOUR, TZ, finite, numeric, round, localDate, shiftDate, validDate, zonedEpoch, dayBounds, parseProviderDate,
  integrate, dailyTotal, sampleStat, sumComplete, normalizeForecast, normalizeModels, horizon, spreadStats,
  slrEstimate, densityLabel, parseStationData, containsPoint, binIndex} from './core.js';

/* ---- Locations (coordinates and elevations carried over unchanged from Powcast v2) ---- */
const ORIGINAL_LOCATIONS = [
  {name:'Vail',lat:39.6403,lon:-106.3742,elev:12408,region:'Central',kind:'resort',snotel:'842:CO:SNTL',acres:5289,vertical:3450,base:8120,top:11570,lifts:31,avgSnow:354},
  {name:'Beaver Creek',lat:39.6042,lon:-106.5165,elev:11440,region:'Central',kind:'resort',snotel:'1041:CO:SNTL',acres:1832,vertical:3340,base:8100,top:11440,lifts:24,avgSnow:325},
  {name:'Breckenridge',lat:39.4817,lon:-106.0384,elev:12998,region:'Central',kind:'resort',snotel:'415:CO:SNTL',acres:2908,vertical:3398,base:9600,top:12998,lifts:35,avgSnow:366},
  {name:'Keystone',lat:39.6069,lon:-105.9439,elev:12408,region:'Central',kind:'resort',snotel:'505:CO:SNTL',acres:3148,vertical:3128,base:9280,top:12408,lifts:20,avgSnow:235},
  {name:'Copper Mountain',lat:39.5022,lon:-106.1511,elev:12313,region:'Central',kind:'resort',snotel:'415:CO:SNTL',acres:2507,vertical:2601,base:9712,top:12313,lifts:24,avgSnow:282},
  {name:'Arapahoe Basin',lat:39.6425,lon:-105.8717,elev:13050,region:'Central',kind:'resort',snotel:'505:CO:SNTL',acres:1428,vertical:2530,base:10780,top:13050,lifts:9,avgSnow:350},
  {name:'Winter Park',lat:39.8868,lon:-105.7625,elev:12060,region:'Front Range',kind:'resort',snotel:'1186:CO:SNTL',acres:3081,vertical:3060,base:9000,top:12060,lifts:25,avgSnow:347},
  {name:'Steamboat',lat:40.4572,lon:-106.8045,elev:10568,region:'Northern',kind:'resort',snotel:'457:CO:SNTL',acres:2965,vertical:3668,base:6900,top:10568,lifts:23,avgSnow:368},
  {name:'Aspen Snowmass',lat:39.2084,lon:-106.9490,elev:12510,region:'Western',kind:'resort',snotel:'669:CO:SNTL',acres:5517,vertical:4406,base:8104,top:12510,lifts:42,avgSnow:300},
  {name:'Telluride',lat:37.9375,lon:-107.8123,elev:13150,region:'Southern',kind:'resort',snotel:'1344:CO:SNTL',acres:2000,vertical:4425,base:8725,top:13150,lifts:19,avgSnow:280},
  {name:'Crested Butte',lat:38.8991,lon:-106.9659,elev:12162,region:'Western',kind:'resort',snotel:'380:CO:SNTL',acres:1547,vertical:2787,base:9375,top:12162,lifts:15,avgSnow:216},
  {name:'Loveland',lat:39.6800,lon:-105.8979,elev:13010,region:'Central',kind:'resort',snotel:'602:CO:SNTL',acres:1800,vertical:2210,base:10800,top:13010,lifts:11,avgSnow:422},
  {name:'Eldora',lat:39.9372,lon:-105.5827,elev:10600,region:'Front Range',kind:'resort',snotel:'564:CO:SNTL',acres:680,vertical:1400,base:9200,top:10600,lifts:10,avgSnow:225},
  {name:'Monarch Mountain',lat:38.5122,lon:-106.3320,elev:11961,region:'Central',kind:'resort',snotel:'701:CO:SNTL',acres:800,vertical:1162,base:10790,top:11961,lifts:7,avgSnow:350},
  {name:'Purgatory',lat:37.6303,lon:-107.8140,elev:10822,region:'Southern',kind:'resort',snotel:'387:CO:SNTL',acres:1635,vertical:2029,base:8793,top:10822,lifts:12,avgSnow:260},
  {name:'Wolf Creek',lat:37.4722,lon:-106.7930,elev:11904,region:'Southern',kind:'resort',snotel:'874:CO:SNTL',acres:1600,vertical:1604,base:10300,top:11904,lifts:9,avgSnow:430},
  {name:'Silverton Mountain',lat:37.8846,lon:-107.6659,elev:13487,region:'Southern',kind:'resort',snotel:'713:CO:SNTL',acres:1819,vertical:3087,base:10400,top:13487,lifts:1,avgSnow:400},
  {name:'Powderhorn',lat:39.0694,lon:-108.1507,elev:9850,region:'Western',kind:'resort',snotel:'622:CO:SNTL',acres:1600,vertical:1650,base:8200,top:9850,lifts:4,avgSnow:250},
  {name:'Sunlight Mountain',lat:39.3998,lon:-107.3387,elev:9895,region:'Western',kind:'resort',snotel:'618:CO:SNTL',acres:730,vertical:2010,base:7885,top:9895,lifts:3,avgSnow:250},
  {name:'Ski Cooper',lat:39.3603,lon:-106.3014,elev:11700,region:'Central',kind:'resort',snotel:'485:CO:SNTL',acres:480,vertical:1200,base:10500,top:11700,lifts:5,avgSnow:250},
  {name:'Berthoud Pass',lat:39.7986,lon:-105.7778,elev:11307,region:'Front Range',kind:'bc',snotel:'335:CO:SNTL'},
  {name:'Loveland Pass',lat:39.6636,lon:-105.8794,elev:11990,region:'Central',kind:'bc',snotel:'505:CO:SNTL'},
  {name:'Vail Pass',lat:39.5303,lon:-106.2175,elev:10662,region:'Central',kind:'bc',snotel:'415:CO:SNTL'},
  {name:'Rabbit Ears Pass',lat:40.4847,lon:-106.6114,elev:9426,region:'Northern',kind:'bc',snotel:'825:CO:SNTL'},
  {name:'Cameron Pass',lat:40.5208,lon:-105.8925,elev:10276,region:'Northern',kind:'bc',snotel:'551:CO:SNTL'},
  {name:'Jones Pass',lat:39.7736,lon:-105.8919,elev:12340,region:'Front Range',kind:'bc',snotel:'970:CO:SNTL'},
  {name:'Independence Pass',lat:39.1089,lon:-106.5639,elev:12095,region:'Western',kind:'bc',snotel:'369:CO:SNTL'},
  {name:'Hoosier Pass',lat:39.3617,lon:-106.0625,elev:11542,region:'Central',kind:'bc',snotel:'531:CO:SNTL'},
  {name:'Monarch Pass',lat:38.4967,lon:-106.3256,elev:11312,region:'Central',kind:'bc',snotel:'701:CO:SNTL'},
  {name:'Wolf Creek Pass',lat:37.4831,lon:-106.8003,elev:10857,region:'Southern',kind:'bc',snotel:'874:CO:SNTL'},
  {name:'Red Mountain Pass',lat:37.8983,lon:-107.7114,elev:11018,region:'Southern',kind:'bc',snotel:'713:CO:SNTL'},
  {name:'Fremont Pass',lat:39.3667,lon:-106.1867,elev:11318,region:'Central',kind:'bc',snotel:'485:CO:SNTL'},
];
const LINKS = {
  'Vail':'https://www.vail.com/', 'Beaver Creek':'https://www.beavercreek.com/', 'Breckenridge':'https://www.breckenridge.com/',
  'Keystone':'https://www.keystoneresort.com/', 'Copper Mountain':'https://www.coppercolorado.com/', 'Arapahoe Basin':'https://www.arapahoebasin.com/',
  'Winter Park':'https://www.winterparkresort.com/', 'Steamboat':'https://www.steamboat.com/', 'Aspen Snowmass':'https://www.aspensnowmass.com/',
  'Telluride':'https://tellurideskiresort.com/', 'Crested Butte':'https://www.skicb.com/', 'Loveland':'https://skiloveland.com/',
  'Eldora':'https://www.eldora.com/', 'Monarch Mountain':'https://skimonarch.com/', 'Purgatory':'https://www.purgatory.ski/',
  'Wolf Creek':'https://wolfcreekski.com/', 'Silverton Mountain':'https://silvertonmountain.com/', 'Powderhorn':'https://www.powderhorn.com/',
  'Sunlight Mountain':'https://sunlightmtn.com/', 'Ski Cooper':'https://www.skicooper.com/'
};
export const LOCS = ORIGINAL_LOCATIONS.map(l => ({...l, id: l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), url: LINKS[l.name] || null}));
const byId = Object.fromEntries(LOCS.map(l => [l.id, l]));

const CONFIG = Object.freeze({
  forecast: 'https://api.open-meteo.com/v1/forecast',
  station: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/',
  avalanche: 'https://api.avalanche.org/v2/public/products/map-layer/CAIC',
  pastDays: 10,
  forecastDays: 16, // day 16 ends one hour short in local time, so the matrix shows today + 14
  futureColumns: 15,
  cacheMs: 30 * 60000,
  staleMs: 3 * HOUR,
  timeout: 15000
});

// Open-Meteo model ids verified against Colorado coordinates on 2026-10-14.
// Excluded: ids that return no snowfall here (GraphCast, BOM ACCESS, KMA) and regional
// "seamless" ids that silently fall back to ECMWF outside Europe (MET Norway, KNMI, DMI).
export const MODELS = [
  {id: 'ncep_hrrr_conus', name: 'HRRR', org: 'NOAA', kind: 'High-res regional', note: '3 km, about 48 h'},
  {id: 'ncep_nam_conus', name: 'NAM', org: 'NOAA', kind: 'High-res regional', note: '3 km CONUS nest, 60 h'},
  {id: 'cmc_gem_rdps', name: 'GEM Regional', org: 'Environment Canada', kind: 'Regional', note: 'RDPS, about 3.5 days'},
  {id: 'ncep_nbm_conus', name: 'NBM', org: 'NOAA', kind: 'Statistical blend', note: 'National Blend of Models, 2.5 km'},
  {id: 'ncep_gfs_global', name: 'GFS', org: 'NOAA', kind: 'Global', note: '16 days'},
  {id: 'ecmwf_ifs', name: 'ECMWF IFS', org: 'ECMWF', kind: 'Global', note: 'HRES 9 km, 15 days'},
  {id: 'ecmwf_aifs025_single', name: 'ECMWF AIFS', org: 'ECMWF', kind: 'Global AI', note: 'Machine-learning model, 0.25°'},
  {id: 'dwd_icon_global', name: 'ICON', org: 'DWD Germany', kind: 'Global', note: 'About 7.5 days'},
  {id: 'cmc_gem_gdps', name: 'GEM Global', org: 'Environment Canada', kind: 'Global', note: 'GDPS, 10 days'},
  {id: 'ukmo_global_deterministic_10km', name: 'UKMO', org: 'UK Met Office', kind: 'Global', note: '10 km, about 7 days'},
  {id: 'jma_gsm', name: 'JMA GSM', org: 'Japan Meteorological Agency', kind: 'Global', note: 'About 11 days'},
  {id: 'meteofrance_arpege_world', name: 'ARPEGE', org: 'Météo-France', kind: 'Global', note: 'About 4 days'},
  {id: 'cma_grapes_global', name: 'CMA GRAPES', org: 'China Meteorological Administration', kind: 'Global', note: 'About 5 days'},
  {id: 'ncep_aigfs025', name: 'AIGFS', org: 'NOAA', kind: 'Global AI', note: 'Machine-learning GFS, 0.25°, 16 days'},
];

/* ---- Preferences: units, theme, favorites. Device-local only. ---- */
const STORE = 'powcast-v3';
function readStore(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: keep working in memory */ } }
function loadPrefs() {
  const p = readStore(STORE, null) || {};
  const old = p.migrated ? {} : readStore('powcast-v2', {}) || {};
  const favs = Array.isArray(p.favs) ? p.favs : Array.isArray(old.favs) ? old.favs : [];
  return {
    units: ['imperial', 'metric'].includes(p.units) ? p.units : old.units === 'metric' ? 'metric' : 'imperial',
    theme: ['light', 'dark'].includes(p.theme) ? p.theme : old.theme === 'day' ? 'light' : old.theme === 'night' ? 'dark' : null,
    favs: favs.filter(id => byId[id]),
    migrated: true
  };
}
const prefs = loadPrefs();
const persist = () => writeStore(STORE, prefs);

const app = {data: {}, errors: {}, busy: false, lastAttempt: null, detail: {}, models: {}, stations: {}, bulletins: null,
  bulletinAt: null, bulletinError: null, bulletinTry: null, route: {view: 'home'}, sort: {key: 'next5', dir: -1}, show: 'resort', query: '', mapWindow: 'next5'};
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

/* ---- Formatting ---- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const imperial = () => prefs.units === 'imperial';
const snowUnit = () => imperial() ? 'in' : 'cm';
/** Compact snowfall for dense cells: T = trace (non-zero but tiny), '' = zero. */
function cellSnow(cm) {
  if (!finite(cm)) return '–';
  const v = imperial() ? cm / 2.54 : cm;
  if (v === 0) return '';
  if (v < (imperial() ? 0.05 : 0.5)) return 'T';
  return imperial() ? (v < 10 ? v.toFixed(1) : Math.round(v).toString()) : (v < 10 ? v.toFixed(1) : Math.round(v).toString());
}
export function snow(cm, unit = true) {
  if (!finite(cm)) return 'No data';
  const v = imperial() ? cm / 2.54 : cm;
  return `${v === 0 ? '0' : v < 0.05 ? '<0.1' : v < 10 ? v.toFixed(1) : Math.round(v)}${unit ? '\u00a0' + snowUnit() : ''}`;
}
const temp = c => finite(c) ? `${Math.round(imperial() ? c * 9 / 5 + 32 : c)}°` : '–';
const speed = kmh => finite(kmh) ? `${Math.round(imperial() ? kmh / 1.609344 : kmh)}\u00a0${imperial() ? 'mph' : 'km/h'}` : '–';
const elev = m => finite(m) ? `${Math.round(imperial() ? m * 3.28084 : m).toLocaleString('en-US')}\u00a0${imperial() ? 'ft' : 'm'}` : '–';
const ft = f => finite(f) ? elev(f / 3.28084) : '–';
const rainFmt = mm => !finite(mm) ? '–' : mm < 0.05 ? '' : imperial() ? `${(mm / 25.4).toFixed(2)}\u00a0in` : `${mm.toFixed(1)}\u00a0mm`;
const fmt = (date, opts) => new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', ...opts}).format(new Date(date + 'T12:00:00Z'));
const timeFmt = (ms, opts = {}) => finite(ms) ? new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts}).format(new Date(ms)) : 'unknown';
function ago(ms) { if (!finite(ms)) return 'never'; const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} d ago`; }
const external = (url, text, cls = 'link') => url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}${icon('external', 'icon-xs')}</a>` : '';
const heat = cm => { const b = binIndex(cm); return b === null ? 'missing' : `b${b}`; };
function toast(message) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; $('toasts').append(el); setTimeout(() => el.remove(), 5000); }

/* ---- Calendar columns: past 10 days, today, next 14 ---- */
function columns() {
  const today = localDate();
  return Array.from({length: CONFIG.pastDays + CONFIG.futureColumns}, (_, i) => {
    const date = shiftDate(today, i - CONFIG.pastDays);
    return {date, past: date < today, today: date === today};
  });
}
export function totals(d, cols = columns()) {
  const daily = Object.fromEntries(cols.map(c => [c.date, d ? dailyTotal(d.hours, c.date) : null]));
  const pick = list => sumComplete(list.map(c => daily[c.date]));
  const future = cols.filter(c => !c.past);
  return {daily, past10: pick(cols.filter(c => c.past)), next5: pick(future.slice(0, 5)), next15: pick(future)};
}

/* ---- Network ---- */
const inflight = new Map();
async function fetchJSON(url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), CONFIG.timeout);
    try {
      const r = await fetch(url, {signal: ctrl.signal, headers: {Accept: 'application/json'}, credentials: 'omit'});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const value = await r.json();
      if (value?.error === true) throw new Error(value.reason || 'Provider error');
      return value;
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'Request timed out' : e.message || 'Network unavailable'); }
    finally { clearTimeout(timer); inflight.delete(url); }
  })();
  inflight.set(url, p);
  return p;
}
function bandElevation(loc, band) {
  const f = band === 'base' ? loc.base : band === 'summit' ? loc.top : band === 'mid' ? (loc.base + loc.top) / 2 : null;
  return finite(f) ? String(round(f / 3.28084, 1)) : null;
}
function forecastURL(locs, {hourly = 'snowfall', band = 'point', models = null, pastDays = CONFIG.pastDays} = {}) {
  const p = new URLSearchParams({latitude: locs.map(l => l.lat).join(','), longitude: locs.map(l => l.lon).join(','), hourly,
    past_days: String(pastDays), forecast_days: String(CONFIG.forecastDays), timeformat: 'unixtime', timezone: TZ,
    temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm'});
  if (models) p.set('models', models.join(','));
  const e = band !== 'point' && bandElevation(locs[0], band);
  if (e) p.set('elevation', e);
  return `${CONFIG.forecast}?${p}`;
}

/* ---- Homepage data: one hourly snowfall series per location, cached on device ---- */
function restoreCache() {
  const cached = readStore(`${STORE}-forecasts`, {});
  for (const [id, d] of Object.entries(cached || {})) {
    if (!byId[id] || !finite(d?.fetchedAt) || Date.now() - d.fetchedAt > 24 * HOUR || !Array.isArray(d.h)) continue;
    app.data[id] = {fetchedAt: d.fetchedAt, elevation: d.elevation, hours: d.h.map(([t, s]) => ({t, snow: s}))};
  }
}
function saveCache() {
  writeStore(`${STORE}-forecasts`, Object.fromEntries(Object.entries(app.data).map(([id, d]) => [id, {fetchedAt: d.fetchedAt, elevation: d.elevation, h: d.hours.map(h => [h.t, h.snow])}])));
}
const fresh = d => !!d && Date.now() - d.fetchedAt <= CONFIG.staleMs;
async function loadGroup(group) {
  try {
    const raw = await fetchJSON(forecastURL(group));
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length !== group.length) throw new Error('Location count does not match the response');
    const at = Date.now();
    group.forEach((loc, i) => {
      try { app.data[loc.id] = normalizeForecast(list[i], {fetchedAt: at}); delete app.errors[loc.id]; }
      catch (e) { app.errors[loc.id] = e.message; }
    });
  } catch (e) { group.forEach(l => { app.errors[l.id] = e.message; }); }
  rerender();
}
async function refresh(force = false) {
  if (app.busy) return;
  const wanted = LOCS.filter(l => force || !app.data[l.id] || Date.now() - app.data[l.id].fetchedAt > CONFIG.cacheMs);
  if (!wanted.length) return;
  app.busy = true; app.lastAttempt = Date.now(); renderStatus();
  const groups = [];
  for (let i = 0; i < wanted.length; i += 8) groups.push(wanted.slice(i, i + 8));
  for (let i = 0; i < groups.length; i += 2) await Promise.all(groups.slice(i, i + 2).map(loadGroup));
  app.busy = false; saveCache(); rerender();
  if (force) toast(Object.keys(app.errors).length ? 'Some locations could not refresh. Earlier data was kept and is labeled.' : 'Forecasts refreshed.');
}

/* ---- Status line ---- */
function renderStatus() {
  const loaded = LOCS.filter(l => app.data[l.id]), ok = loaded.filter(l => fresh(app.data[l.id])).length;
  const latest = loaded.length ? Math.max(...loaded.map(l => app.data[l.id].fetchedAt)) : null;
  const failed = Object.keys(app.errors).filter(id => byId[id]).length;
  let text;
  if (app.busy) text = `Loading forecasts for ${LOCS.length} locations…`;
  else if (!loaded.length) text = failed ? 'Forecasts could not be loaded. Nothing has been substituted.' : 'No forecasts loaded yet.';
  else text = `Open-Meteo forecast · ${loaded.length}/${LOCS.length} locations · updated ${ago(latest)}`;
  const stale = loaded.length && ok < loaded.length;
  $('status').innerHTML = `<span class="dot ${app.busy ? 'busy' : stale || failed ? 'warn' : 'ok'}" aria-hidden="true"></span><span>${esc(text)}</span>${stale ? '<span class="pill warn">Stale data shown</span>' : ''}${failed && !app.busy ? `<span class="pill warn">${failed} unavailable</span>` : ''}<button type="button" class="text-btn" data-action="refresh" ${app.busy ? 'disabled' : ''}>${icon('refresh', 'icon-xs')}Refresh</button>`;
}

/* ============================== HOMEPAGE ============================== */
function homeRows(cols) {
  const q = app.query.trim().toLowerCase();
  return LOCS.filter(l => (app.show === 'all' || (app.show === 'fav' ? prefs.favs.includes(l.id) : l.kind === app.show)) && (!q || `${l.name} ${l.region}`.toLowerCase().includes(q)))
    .map(loc => ({loc, d: app.data[loc.id], t: totals(app.data[loc.id], cols)}));
}
function sortValue(row, key) { return key === 'name' ? row.loc.name : key.startsWith('d:') ? row.t.daily[key.slice(2)] : row.t[key]; }
function sortRows(rows) {
  const {key, dir} = app.sort;
  return rows.sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (key === 'name') return dir * va.localeCompare(vb);
    if (finite(va) !== finite(vb)) return finite(va) ? -1 : 1; // missing always sorts last
    return (finite(va) && finite(vb) ? dir * (va - vb) : 0) || a.loc.name.localeCompare(b.loc.name);
  });
}
function sortHeader(key, label, cls, sub = '') {
  const active = app.sort.key === key;
  const aria = active ? ` aria-sort="${app.sort.dir < 0 ? 'descending' : 'ascending'}"` : '';
  return `<th scope="col" class="${cls}${active ? ' sorted' : ''}"${aria}><button type="button" data-sort="${key}"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button></th>`;
}
/** Storm timeline: how many visible locations get >= 1 in on each day, and who leads. */
function stormRow(rows, cols) {
  const unit = imperial() ? '1 in' : '2.5 cm';
  const counts = cols.map(c => {
    const vals = rows.map(r => ({r, v: r.t.daily[c.date]})).filter(x => finite(x.v));
    const lead = vals.sort((a, b) => b.v - a.v)[0];
    return {c, n: vals.filter(x => x.v >= 2.54).length, total: vals.length, lead};
  });
  const max = Math.max(1, ...counts.map(x => x.n));
  const cells = counts.map(({c, n, total, lead}) => {
    const tip = total ? `${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${n} of ${total} at ≥ ${unit}${lead && lead.v > 0 ? `. Most: ${lead.r.loc.name}, ${snow(lead.v)}` : ''}` : 'No data';
    return `<td class="storm ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(tip)}"><span class="storm-bar" style="--h:${n / max}"></span><span class="storm-n">${n || ''}</span></td>`;
  }).join('');
  return `<tr class="storm-row"><th scope="row" class="name-cell"><span class="storm-label">Locations ≥ ${unit}</span></th>${cells}<td class="total" colspan="3"></td></tr>`;
}
function matrixRow({loc, d, t}, cols) {
  const fav = prefs.favs.includes(loc.id);
  const stale = d && !fresh(d) ? '<span class="pill warn">Stale</span>' : '';
  const err = !d && app.errors[loc.id] ? '<span class="pill warn">Unavailable</span>' : '';
  const cells = cols.map(c => {
    const v = t.daily[c.date];
    const tip = `${loc.name}, ${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${finite(v) ? snow(v) : 'no data'}${c.past ? ' (modeled past, not measured)' : ''}`;
    return `<td class="cell ${heat(v)} ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(tip)}">${cellSnow(v)}</td>`;
  }).join('');
  const tot = (v, cls) => `<td class="total ${cls} ${heat(v)}">${finite(v) ? snow(v, false) : '–'}</td>`;
  return `<tr><th scope="row" class="name-cell"><button type="button" class="star ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(loc.name)} ${fav ? 'from' : 'to'} favorites">${icon('star')}</button><a href="#/resort/${loc.id}"><span class="loc-name">${esc(loc.name)}</span><span class="loc-sub">${esc(loc.region)}${loc.kind === 'bc' ? ' · Backcountry' : ''}${stale}${err}</span></a></th>${cells}${tot(t.past10, 'first')}${tot(t.next5, '')}${tot(t.next15, '')}</tr>`;
}
function stormSummary(rows, cols) {
  const resorts = rows.filter(r => r.loc.kind === 'resort');
  const pool = resorts.length ? resorts : rows, what = resorts.length ? 'resorts' : 'locations';
  if (!pool.some(r => r.d)) return '';
  const next = cols.filter(c => !c.past).map(c => {
    const vals = pool.map(r => ({r, v: r.t.daily[c.date]})).filter(x => finite(x.v)).sort((a, b) => b.v - a.v);
    return {c, n: vals.filter(x => x.v >= 2.54).length, total: vals.length, lead: vals[0]};
  }).find(x => x.n >= 3);
  const best5 = pool.filter(r => finite(r.t.next5)).sort((a, b) => b.t.next5 - a.t.next5)[0];
  const parts = [];
  if (next) parts.push(`Next widespread snow: <strong>${next.c.today ? 'today' : esc(fmt(next.c.date, {weekday: 'long', month: 'short', day: 'numeric'}))}</strong>, ${next.n} of ${next.total} ${what} at ≥ ${imperial() ? '1 in' : '2.5 cm'}, most at <a href="#/resort/${next.lead.r.loc.id}">${esc(next.lead.r.loc.name)}</a> (${snow(next.lead.v)}).`);
  else parts.push(`No day in the next ${CONFIG.futureColumns} shows 3 or more ${what} at ≥ ${imperial() ? '1 in' : '2.5 cm'}.`);
  if (best5 && best5.t.next5 > 0) parts.push(`Most over the next 5 days: <a href="#/resort/${best5.loc.id}">${esc(best5.loc.name)}</a>, ${snow(best5.t.next5)}.`);
  return parts.join(' ');
}
function legend() {
  const edges = imperial() ? ['0.1', '1', '3', '6', '10', '15', '24'] : ['0.25', '2.5', '7.5', '15', '25', '38', '61'];
  return `<div class="legend" aria-label="Color scale in ${imperial() ? 'inches' : 'centimeters'}"><span class="legend-title">${imperial() ? 'Inches' : 'cm'}</span>${edges.map((e, i) => `<span class="swatch b${i + 1}"></span><span>${e}${i === edges.length - 1 ? '+' : ''}</span>`).join('')}<span class="swatch missing"></span><span>No data</span><span class="legend-t">T = trace</span></div>`;
}
function renderHome() {
  const view = $('view-home'), cols = columns();
  const rows = sortRows(homeRows(cols));
  const scroller = view.querySelector('.matrix-scroll'), keepScroll = scroller ? scroller.scrollLeft : null;
  const showBtn = (v, label) => `<button type="button" data-show="${v}" aria-pressed="${app.show === v}">${label}</button>`;
  const head = cols.map(c => {
    const label = c.today ? 'Today' : fmt(c.date, {weekday: 'short'});
    const day = fmt(c.date, {day: 'numeric'}), month = (c.date.endsWith('-01') || c === cols[0]) ? fmt(c.date, {month: 'short'}) + ' ' : '';
    return sortHeader(`d:${c.date}`, label, `day ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}`, month + day);
  }).join('');
  view.innerHTML = `
    <div class="page-head">
      <h1 id="homeTitle">Colorado snowfall, day by day</h1>
      <p class="lede">Modeled daily snowfall for ${LOCS.filter(l => l.kind === 'resort').length} resorts and ${LOCS.filter(l => l.kind === 'bc').length} backcountry passes: the past ${CONFIG.pastDays} days and the next ${CONFIG.futureColumns}, midnight to midnight Colorado time.</p>
      <p class="summary">${stormSummary(rows, cols)}</p>
    </div>
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Locations to show">${showBtn('resort', 'Resorts')}${showBtn('bc', 'Backcountry')}${showBtn('all', 'All')}${showBtn('fav', `Favorites${prefs.favs.length ? ' ' + prefs.favs.length : ''}`)}</div>
      <label class="search"><span class="sr-only">Filter by name or region</span>${icon('search', 'icon-sm')}<input type="search" id="homeSearch" name="q" placeholder="Filter locations…" autocomplete="off" value="${esc(app.query)}"></label>
      ${legend()}
    </div>
    ${rows.length ? `<div class="matrix-scroll" tabindex="0" aria-label="Daily snowfall table, scrolls sideways">
      <table class="matrix">
        <caption class="sr-only">Daily snowfall in ${imperial() ? 'inches' : 'centimeters'} by location. Past days are modeled, not measured. Select a column header to sort.</caption>
        <thead><tr>${sortHeader('name', 'Location', 'name-cell')}${head}${sortHeader('past10', 'Past', 'total first', '10 days')}${sortHeader('next5', 'Next', 'total', '5 days')}${sortHeader('next15', 'Next', 'total', `${CONFIG.futureColumns} days`)}</tr>
        <tr class="band-row"><td class="name-cell"></td><td colspan="${CONFIG.pastDays}" class="band past">Modeled past, not measured</td><td colspan="${CONFIG.futureColumns}" class="band">Forecast</td><td colspan="3" class="band total first">Totals, ${snowUnit()}</td></tr>
        ${stormRow(rows, cols)}</thead>
        <tbody>${rows.map(r => matrixRow(r, cols)).join('')}</tbody>
      </table>
    </div>` : `<div class="empty"><h2>No locations match</h2><p>${app.show === 'fav' && !prefs.favs.length ? 'Star a location in the table to pin it to Favorites.' : 'Try a different filter.'}</p><button type="button" class="btn" data-show="resort">Show all resorts</button></div>`}
    <p class="note">Each cell is a calendar-day total from Open-Meteo's best-match forecast for the listed coordinates. Past days are model output stitched from recent runs, not station measurements. A dash means the data is missing, never zero. Totals require every day in the window. Forecast skill falls off sharply beyond about a week.</p>`;
  const sc = view.querySelector('.matrix-scroll');
  if (sc) {
    // Open on today's column so the forecast leads on narrow screens.
    if (keepScroll !== null) sc.scrollLeft = keepScroll;
    else { const today = sc.querySelector('th.today'), name = sc.querySelector('th.name-cell'); if (today && name && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = today.offsetLeft - name.offsetWidth - 2 * today.offsetWidth; }
  }
}

/* ============================== RESORT DEEP-DIVE ============================== */
const DETAIL_HOURLY = 'snowfall,temperature_2m,temperature_600hPa,temperature_500hPa,wind_speed_10m,wind_gusts_10m,freezing_level_height,rain,weather_code';
/** A record is due for a request when it was never tried, or its last attempt (success or failure) is older than the cache window. */
const due = rec => !rec || (!rec.loading && Date.now() - (rec.at || 0) >= CONFIG.cacheMs);
async function loadDetail(loc, band) {
  const key = `${loc.id}:${band}`;
  if (!due(app.detail[key])) return;
  app.detail[key] = {...app.detail[key], loading: true};
  try { app.detail[key] = {data: normalizeForecast(await fetchJSON(forecastURL([loc], {hourly: DETAIL_HOURLY, band})), {variant: band}), at: Date.now()}; }
  catch (e) { app.detail[key] = {...app.detail[key], loading: false, error: e.message, at: Date.now()}; }
  if (app.route.view === 'resort' && app.route.id === loc.id) renderResort();
}
async function loadModels(loc) {
  if (!due(app.models[loc.id])) return;
  app.models[loc.id] = {...app.models[loc.id], loading: true};
  try {
    const raw = await fetchJSON(forecastURL([loc], {models: MODELS.map(m => m.id), pastDays: 1}));
    app.models[loc.id] = {series: normalizeModels(raw, MODELS.map(m => m.id)), at: Date.now()};
  } catch (e) { app.models[loc.id] = {error: e.message, at: Date.now()}; }
  if (app.route.view === 'resort' && app.route.id === loc.id) renderResort();
}
async function loadStation(loc) {
  const key = loc.snotel, old = app.stations[key];
  if (!due(old)) return;
  app.stations[key] = {...old, loading: true};
  const p = new URLSearchParams({stationTriplets: key, elements: 'SNWD,WTEQ', duration: 'DAILY', beginDate: shiftDate(localDate(), -8), endDate: localDate(), centralTendencyType: 'MEDIAN', returnSuspectData: 'false'});
  const [meta, data] = await Promise.allSettled([fetchJSON(`${CONFIG.station}stations?${new URLSearchParams({stationTriplets: key})}`), fetchJSON(`${CONFIG.station}data?${p}`)]);
  const r = {at: Date.now(), meta: meta.status === 'fulfilled' ? meta.value.find?.(s => s.stationTriplet === key) || null : null};
  if (data.status === 'fulfilled') { try { r.data = parseStationData(data.value, key); } catch (e) { r.error = e.message; } } else r.error = data.reason.message;
  app.stations[key] = r;
  if (app.route.view === 'resort' && byId[app.route.id]?.snotel === key) renderResort();
}
async function loadAvalanche() {
  if (!due(app.bulletinTry)) return;
  app.bulletinTry = {loading: true};
  try {
    const data = await fetchJSON(CONFIG.avalanche);
    if (!Array.isArray(data.features)) throw new Error('Bulletin has no geographic features');
    app.bulletins = data.features; app.bulletinAt = Date.now(); app.bulletinError = null;
  } catch (e) { app.bulletinError = e.message; }
  app.bulletinTry = {at: Date.now()};
  if (app.route.view === 'resort') renderResort();
}

function dailyBars(d, cols) {
  const vals = cols.map(c => d ? dailyTotal(d.hours, c.date) : null), max = Math.max(imperial() ? 2.54 * 2 : 5, ...vals.filter(finite));
  return `<div class="bars" role="img" aria-label="Daily snowfall bar chart; the table below lists every value">${cols.map((c, i) => {
    const v = vals[i], tip = `${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${finite(v) ? snow(v) : 'no data'}${c.past ? ' (modeled past)' : ''}`;
    return `<div class="bar-col ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(tip)}"><span class="bar-val">${finite(v) && v >= 0.25 ? cellSnow(v) : ''}</span><span class="bar ${finite(v) ? '' : 'missing'}" style="--h:${finite(v) ? Math.max(0.01, v / max) : 0.06}"></span><span class="bar-day">${c.today ? 'Today' : fmt(c.date, {weekday: 'narrow'})}</span><span class="bar-date">${fmt(c.date, {day: 'numeric'})}</span></div>`;
  }).join('')}</div>`;
}
function dayTable(d, cols) {
  const rows = cols.map(c => {
    const [a, b] = dayBounds(c.date), h = d?.hours;
    const v = dailyTotal(h, c.date), est = h ? slrEstimate(h, a, b) : null;
    const covered = integrate(h, a, b).complete;
    const slr = !covered || !est ? '–' : est.ratio ? `${snow(est.snowCm)} <span class="muted">${Math.round(est.ratio)}:1 ${densityLabel(est.ratio)}</span>` : '';
    return `<tr class="${c.past ? 'past' : ''} ${c.today ? 'today' : ''}"><th scope="row">${c.today ? 'Today' : esc(fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'}))}</th><td class="num ${heat(v)}">${finite(v) ? snow(v) : '–'}</td><td class="num">${slr}</td><td class="num">${temp(sampleStat(h, a, b, 'temp'))} / ${temp(sampleStat(h, a, b, 'temp', 'min'))}</td><td class="num">${speed(sampleStat(h, a, b, 'gust'))}</td><td class="num">${elev(sampleStat(h, a, b, 'freezing', 'min'))}</td><td class="num">${rainFmt(integrate(h, a, b, 'rain').value)}</td></tr>`;
  }).join('');
  return `<div class="table-scroll" tabindex="0" aria-label="Daily details, scrolls sideways"><table class="data-table"><thead><tr><th scope="col">Day</th><th scope="col" class="num">Snow (model)</th><th scope="col" class="num">Estimate at variable ratio</th><th scope="col" class="num">High / low</th><th scope="col" class="num">Max gust</th><th scope="col" class="num">Lowest freezing level</th><th scope="col" class="num">Rain</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">"Snow (model)" is Open-Meteo snowfall, which converts frozen precipitation at a fixed 7:1 ratio (0.7 cm per mm of water). The variable-ratio column is an <strong>estimate</strong>: the same water multiplied by a Kuchera-style ratio from the warmest of the 2 m, 600 hPa, and 500 hPa temperatures. It is a rough guide to density (light vs dense), not a measurement of snow quality. Freezing level is the 0°C altitude, not the snow line.</p>`;
}
function hourlyStrip(d) {
  const start = Math.floor(Date.now() / HOUR) * HOUR, hrs = Array.from({length: 48}, (_, i) => start + (i + 1) * HOUR);
  const pts = hrs.map(t => ({t, h: d?.hours.find(x => x.t === t)}));
  const max = Math.max(imperial() ? 0.5 * 2.54 : 1, ...pts.map(p => p.h?.snow).filter(finite));
  return `<div class="hourly" role="img" aria-label="Hourly snowfall for the next 48 hours">${pts.map(({t, h}) => {
    const v = h?.snow, tip = `${timeFmt(t, {weekday: 'short'})}: ${finite(v) ? snow(v) : 'no data'}, ${temp(h?.temp)}, gusts ${speed(h?.gust)}`;
    return `<span class="hour ${finite(v) ? '' : 'missing'}" data-tip="${esc(tip)}" style="--h:${finite(v) ? Math.max(0.02, v / max) : 0.08}"></span>`;
  }).join('')}</div><div class="hour-axis">${[0, 12, 24, 36, 47].map(i => `<span>${esc(timeFmt(hrs[i], {weekday: 'short', minute: undefined}))}</span>`).join('')}</div>`;
}

/* ---- Model comparison ---- */
function modelRows(loc) {
  const m = app.models[loc.id];
  const blend = app.data[loc.id];
  const rows = MODELS.map(def => ({...def, hours: m?.series?.[def.id] || null}));
  return {rows, blend: blend ? {id: 'best_match', name: 'Blend', org: 'Open-Meteo best match', kind: 'Used on the homepage', hours: blend.hours} : null};
}
function modelTable(loc) {
  const m = app.models[loc.id];
  if (!m || m.loading) return '<div class="skeleton" style="height:320px" aria-label="Loading model comparison"></div>';
  if (m.error) return `<div class="notice">Model comparison could not load: ${esc(m.error)}. No values are substituted.</div>`;
  const now = Date.now(), days = Array.from({length: 10}, (_, i) => shiftDate(localDate(), i));
  const wins = [['24 h', 24], ['72 h', 72], ['7 days', 168], ['10 days', 240]];
  const {rows, blend} = modelRows(loc);
  const all = blend ? [blend, ...rows] : rows;
  const vals = r => ({days: days.map(dt => r.hours ? dailyTotal(r.hours, dt) : null), wins: wins.map(([, h]) => r.hours ? integrate(r.hours, now, now + h * HOUR).value : null)});
  const table = all.map(r => ({r, v: vals(r)}));
  const cell = v => `<td class="num ${finite(v) ? heat(v) : ''}">${finite(v) ? cellSnow(v) || '0' : '<span class="muted" title="Beyond this model’s range or missing">–</span>'}</td>`;
  const body = table.map(({r, v}) => {
    const hz = r.hours ? horizon(r.hours) : null;
    return `<tr class="${r.id === 'best_match' ? 'blend' : ''}" data-model="${r.id}"><th scope="row"><span class="model-name">${esc(r.name)}</span><span class="model-sub">${esc(r.org)}${r.note ? ' · ' + esc(r.note) : ''}${hz ? ' · data to ' + esc(timeFmt(hz, {weekday: 'short', minute: undefined})) : ' · no data'}</span></th>${v.days.map(cell).join('')}${v.wins.map((x, i) => cell(x).replace('<td class="num', `<td class="num${i === 0 ? ' first' : ''}`)).join('')}</tr>`;
  }).join('');
  const modelsOnly = table.filter(x => x.r.id !== 'best_match');
  const stat = idx => spreadStats(modelsOnly.map(x => idx < days.length ? x.v.days[idx] : x.v.wins[idx - days.length]));
  const stats = Array.from({length: days.length + wins.length}, (_, i) => stat(i));
  const sRow = (label, f, cls = '') => `<tr class="stat ${cls}"><th scope="row">${label}</th>${stats.map((s, i) => `<td class="num${i === days.length ? ' first' : ''}">${f(s)}</td>`).join('')}</tr>`;
  const hits = i => modelsOnly.filter(x => (i < days.length ? x.v.days[i] : x.v.wins[i - days.length]) >= 2.54).length;
  return `<div class="table-scroll" tabindex="0" aria-label="Model comparison, scrolls sideways"><table class="data-table models">
    <thead><tr><th scope="col">Model</th>${days.map((dt, i) => `<th scope="col" class="num">${i === 0 ? 'Today' : esc(fmt(dt, {weekday: 'short'}))}<small>${esc(fmt(dt, {day: 'numeric'}))}</small></th>`).join('')}${wins.map(([l], i) => `<th scope="col" class="num${i === 0 ? ' first' : ''}">Next<small>${l}</small></th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot>${sRow('Range (min to max)', s => s.n >= 2 ? `${cellSnow(s.min) || '0'}–${cellSnow(s.max) || '0'}` : '–')}${sRow('Median', s => finite(s.median) ? cellSnow(s.median) || '0' : '–')}${sRow('Models reporting', s => s.n || '–')}${sRow(`Models ≥ ${imperial() ? '1 in' : '2.5 cm'}`, s => s.n ? `${hits(stats.indexOf(s))} of ${s.n}` : '–')}${sRow('Spread', s => `<span class="spread ${s.label.toLowerCase().replace(/\s+/g, '-')}">${s.label}</span>`, 'spread-row')}</tfoot>
  </table></div>
  <p class="note">Calendar-day totals in Colorado time; rolling windows start now. A dash means the model does not reach that far or returned nothing, never zero. <strong>Spread is disagreement between models, not a probability.</strong> "Tight" means the range is within about 0.5 in or a third of the median; "Wide" means it exceeds about 2 in and the median itself. "Models ≥ 1 in" is a count of models, not a chance of snow. The blend row is shown for reference and excluded from the spread. Retrieved ${esc(timeFmt(m.at))}; model run times are not supplied by this endpoint.</p>`;
}
let chartState = null; // geometry of the last drawn model chart, for the crosshair readout
/** Cumulative snowfall per model from now: gray lines, blend in accent, crosshair readout. */
function modelChart(loc, width) {
  const m = app.models[loc.id];
  if (!m?.series) return '';
  const {rows, blend} = modelRows(loc), now = Math.floor(Date.now() / HOUR) * HOUR, span = 240, W = Math.max(320, width), H = W < 560 ? 220 : 280;
  const pad = {l: 40, r: 12, t: 12, b: 26}, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const series = [...rows, ...(blend ? [blend] : [])].filter(r => r.hours).map(r => {
    const byT = new Map(r.hours.map(h => [h.t, h.snow]));
    let acc = 0; const pts = [];
    for (let i = 1; i <= span; i++) { const v = byT.get(now + i * HOUR); if (!finite(v)) break; acc += v; pts.push(acc); }
    return {...r, pts};
  }).filter(s => s.pts.length);
  const top = Math.max(imperial() ? 2.54 : 2, ...series.map(s => s.pts.at(-1))) * 1.08;
  const x = i => pad.l + (i / span) * iw, y = v => pad.t + ih - (v / top) * ih;
  const path = s => 'M' + [x(0), y(0)].join(',') + s.pts.map((v, i) => `L${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const step = imperial() ? (top / 2.54 > 12 ? 5 : top / 2.54 > 4 ? 2 : 1) * 2.54 : (top > 30 ? 10 : top > 10 ? 5 : 2);
  const grid = []; for (let v = 0; v <= top; v += step) grid.push(v);
  const dayTicks = Array.from({length: 11}, (_, i) => zonedEpoch(shiftDate(localDate(), i))).filter(t => t > now && t <= now + span * HOUR);
  chartState = {series: series.map(s => ({id: s.id, name: s.name, pts: s.pts})), now, span, x0: pad.l, iw, W};
  return `<figure class="chart-figure"><svg class="model-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative snowfall by model for the next 10 days. The table below lists the values.">
    ${grid.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${imperial() ? Math.round(v / 2.54) : Math.round(v)}</text>`).join('')}
    ${dayTicks.map(t => { const i = (t - now) / HOUR; return `<line class="tick" x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="axis" x="${x(i) + 3}" y="${H - 8}">${esc(new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short'}).format(t + HOUR))}</text>`; }).join('')}
    ${series.filter(s => s.id !== 'best_match').map(s => `<path class="line" data-model="${s.id}" d="${path(s)}"/>`).join('')}
    ${series.filter(s => s.id === 'best_match').map(s => `<path class="line blend" data-model="${s.id}" d="${path(s)}"/>`).join('')}
    <line class="crosshair" id="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>
  </svg><figcaption><span class="key"><i class="key-line"></i>Each model</span><span class="key"><i class="key-line blend"></i>Blend (homepage)</span><span class="muted">Cumulative ${snowUnit()} from now. Lines stop where a model's data ends. Hover or tap for values; hover a table row to highlight its line.</span></figcaption></figure>`;
}
function chartReadout(evt) {
  const c = chartState, svg = evt.target.closest('svg');
  if (!c || !svg) return;
  const r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * (c.W / r.width);
  const i = Math.round(((px - c.x0) / c.iw) * c.span);
  if (i < 1 || i > c.span) return hideTip();
  const line = svg.querySelector('#crosshair'), xp = c.x0 + (i / c.span) * c.iw;
  line.setAttribute('x1', xp); line.setAttribute('x2', xp); line.setAttribute('visibility', 'visible');
  const vals = c.series.map(s => ({n: s.name, v: s.pts[i - 1]})).filter(s => finite(s.v)).sort((a, b) => b.v - a.v);
  showTip(evt.clientX, evt.clientY, `<strong>${esc(timeFmt(c.now + i * HOUR, {weekday: 'short'}))}</strong>${vals.map(s => `<span class="tip-row"><span>${esc(s.n)}</span><span>${snow(s.v)}</span></span>`).join('')}`, true);
}

/* ---- Station and avalanche panels ---- */
function stationHTML(loc) {
  const r = app.stations[loc.snotel];
  if (!r || (r.loading && !r.data)) return '<div class="skeleton" style="height:150px" aria-label="Loading station data"></div>';
  const depth = r.data?.SNWD?.filter(x => x.value !== null).at(-1), swe = r.data?.WTEQ?.filter(x => x.value !== null).at(-1);
  const pct = finite(swe?.median) && swe.median > 0 && finite(swe?.value) ? Math.round(swe.value / swe.median * 100) : null;
  const old = [depth?.date, swe?.date].some(dt => dt && dt < shiftDate(localDate(), -2));
  const shared = LOCS.filter(l => l.snotel === loc.snotel).length;
  return `${r.error ? `<div class="notice">Station request failed: ${esc(r.error)}. No measurement is inferred.</div>` : ''}
  <p class="panel-sub">${esc(r.meta?.name || 'Station')} · ${esc(loc.snotel)}${finite(numeric(r.meta?.elevation)) ? ' · ' + ft(numeric(r.meta.elevation)) : ''}${old ? ' <span class="pill warn">Old observation</span>' : ''}</p>
  <dl class="facts"><div><dt>Snow depth (measured)</dt><dd>${depth ? snow(depth.value * 2.54) : 'No data'}</dd></div><div><dt>Snow water equivalent</dt><dd>${swe ? snow(swe.value * 2.54) : 'No data'}</dd></div><div><dt>SWE vs 30-year median</dt><dd>${pct === null ? 'No data' : pct + '%'}</dd></div><div><dt>Observation date</dt><dd>${esc(depth?.date || swe?.date || 'No data')}</dd></div></dl>
  <p class="note">A SNOTEL station is a measurement near, not at, this location${shared > 1 ? `, and ${shared} Powcast locations share it` : ''}. Depth changes are settling plus new snow, so they are not reported as snowfall. ${external(`https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${encodeURIComponent(loc.snotel.split(':')[0])}`, 'Open NRCS station')}</p>`;
}
function avalancheHTML(loc) {
  const caveat = '<p class="note">Current bulletin for the surrounding area, not a route assessment or a forecast for later days. Read danger by elevation, problems, and aspect in the full CAIC forecast.</p>';
  const link = external('https://avalanche.state.co.us/', 'Full CAIC forecast');
  if (!app.bulletins && !app.bulletinError) return '<div class="skeleton" style="height:150px" aria-label="Loading avalanche bulletin"></div>';
  const matches = (app.bulletins || []).filter(f => containsPoint(f, [loc.lon, loc.lat]));
  if (matches.length !== 1) return `<p><span class="pill warn">${matches.length > 1 ? 'Boundary overlap' : 'Bulletin unavailable'}</span></p><p>${matches.length > 1 ? 'Several bulletin areas overlap this point, so no single rating is shown.' : app.bulletinError ? 'The bulletin feed could not be reached. Missing does not mean low danger.' : 'No CAIC zone matched this point. No rating is inferred.'}</p>${caveat}${link}`;
  const p = matches[0].properties, zone = p.timezone || TZ, start = parseProviderDate(p.start_date, zone), end = parseProviderDate(p.end_date, zone), now = Date.now();
  const valid = finite(start) && finite(end) && start <= now && end > now;
  const level = numeric(p.danger_level), named = valid && Number.isInteger(level) && level >= 1 && level <= 5;
  const label = named ? `${['', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'][level]} (${level} of 5)` : valid ? 'No rating published' : 'Expired or unverified';
  return `<p class="panel-sub">${esc(p.name || 'CAIC zone')}</p><p class="danger-line"><span class="danger d${named ? level : 0}">${esc(label)}</span></p>
  <dl class="facts"><div><dt>Issued</dt><dd>${esc(timeFmt(start, {month: 'short', day: 'numeric'}))}</dd></div><div><dt>Expires</dt><dd>${esc(timeFmt(end, {month: 'short', day: 'numeric'}))}</dd></div></dl>
  ${valid && p.travel_advice ? `<p>${esc(p.travel_advice)}</p>` : ''}${p.warning?.product && valid ? '<p class="warn-text"><strong>An avalanche warning is in effect. Read the official product.</strong></p>' : ''}${caveat}${external(p.link || 'https://avalanche.state.co.us/', 'This zone on CAIC')}`;
}

function renderResort() {
  const loc = byId[app.route.id], view = $('view-resort');
  if (!loc) { view.innerHTML = `<div class="empty"><h1>Location not found</h1><p><a href="#/">Back to all locations</a></p></div>`; return; }
  const band = loc.base && ['base', 'mid', 'summit'].includes(app.route.band) ? app.route.band : 'point';
  const det = app.detail[`${loc.id}:${band}`], d = det?.data || (band === 'point' ? app.data[loc.id] : null), cols = columns(), t = totals(d, cols);
  const fav = prefs.favs.includes(loc.id);
  const bands = loc.base ? [['point', 'Grid point'], ['base', `Base ${ft(loc.base)}`], ['mid', 'Mid'], ['summit', `Summit ${ft(loc.top)}`]] : [];
  const keepY = window.scrollY, width = Math.min(1100, (view.querySelector('.chart-slot')?.clientWidth) || Math.min(window.innerWidth - 32, 1100));
  view.setAttribute('aria-labelledby', 'resortTitle');
  view.innerHTML = `
  <a class="back" href="#/">${icon('back', 'icon-sm')}All locations</a>
  <div class="resort-head">
    <div><h1 id="resortTitle">${esc(loc.name)}</h1>
    <p class="meta">${esc(loc.region)} Colorado · ${loc.kind === 'bc' ? 'Backcountry pass (weather only, not a safety rating)' : 'Resort'}${loc.base ? ` · ${ft(loc.base)} to ${ft(loc.top)}` : ` · ${ft(loc.elev)}`}${d ? ` · forecast grid ${elev(d.elevation)}` : ''}</p></div>
    <div class="actions"><button type="button" class="btn ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}">${icon('star', 'icon-sm')}${fav ? 'Favorite' : 'Add favorite'}</button><button type="button" class="btn" data-action="share">${icon('link', 'icon-sm')}Copy link</button><a class="btn" href="#/map?focus=${loc.id}">${icon('map', 'icon-sm')}On map</a>${loc.url ? external(loc.url, 'Official site', 'btn') : ''}</div>
  </div>
  <dl class="kpis"><div><dt>Past 10 days</dt><dd>${finite(t.past10) ? snow(t.past10) : '–'}</dd><span>modeled</span></div><div><dt>Next 5 days</dt><dd>${finite(t.next5) ? snow(t.next5) : '–'}</dd><span>today + 4</span></div><div><dt>Next ${CONFIG.futureColumns} days</dt><dd>${finite(t.next15) ? snow(t.next15) : '–'}</dd><span>today + 14</span></div><div><dt>Data</dt><dd class="small">${d ? (fresh(d) ? 'Model forecast' : 'Stale model') : det?.loading ? 'Loading…' : 'Unavailable'}</dd><span>${d ? 'retrieved ' + ago(d.fetchedAt) : esc(det?.error || '')}</span></div></dl>
  ${bands.length ? `<div class="band-switch"><div class="segmented" role="group" aria-label="Forecast elevation">${bands.map(([v, l]) => `<button type="button" data-band="${v}" aria-pressed="${band === v}">${l}</button>`).join('')}</div><p class="note">Base, mid, and summit re-run the same coordinates at that elevation (Open-Meteo lapse-rate adjustment). They are not separate stations. Model comparison always uses the grid point.</p></div>` : ''}
  <section class="panel"><h2>Daily snowfall</h2><p class="panel-sub">Past ${CONFIG.pastDays} days (modeled) and the next ${CONFIG.futureColumns}, in ${imperial() ? 'inches' : 'centimeters'}.</p>${d ? dailyBars(d, cols) : '<div class="skeleton" style="height:180px"></div>'}</section>
  <section class="panel"><h2>Next 48 hours</h2><p class="panel-sub">Hourly snowfall; hover or tap a bar for temperature and gusts.</p>${det?.data ? hourlyStrip(det.data) : '<div class="skeleton" style="height:120px"></div>'}</section>
  <section class="panel"><h2>Model comparison</h2><p class="panel-sub">${MODELS.length} models from Open-Meteo at the grid point. When they agree, confidence is higher; when they scatter, treat any single number loosely.</p><div class="chart-slot">${modelChart(loc, width)}</div>${modelTable(loc)}</section>
  <section class="panel"><h2>Day by day</h2><p class="panel-sub">${band === 'point' ? 'Grid point' : `${bands.find(b => b[0] === band)[1]} scenario`}. Temperatures and gusts are model values for the calendar day.</p>${det?.data ? dayTable(det.data, cols) : det?.error ? `<div class="notice">Details could not load: ${esc(det.error)}.</div>` : '<div class="skeleton" style="height:420px"></div>'}</section>
  <div class="two-up"><section class="panel"><h2>Observed snowpack</h2>${stationHTML(loc)}</section><section class="panel"><h2>Avalanche bulletin</h2>${avalancheHTML(loc)}</section></div>
  <p class="note">Coordinates ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}; Open-Meteo returned grid ${d?.lat?.toFixed(3) ?? '–'}, ${d?.lon?.toFixed(3) ?? '–'}. Resort-reported snowfall, lift status, and webcams live on the ${loc.url ? external(loc.url, 'official site') : 'operator’s site'}; Powcast does not scrape them.</p>`;
  if (app.route.rendered === loc.id + band) window.scrollTo(0, keepY);
  app.route.rendered = loc.id + band;
  loadDetail(loc, band); loadModels(loc); loadStation(loc); loadAvalanche();
}

/* ============================== MAP ============================== */
let mapModule = null;
export function mapValue(loc, key) {
  const d = app.data[loc.id];
  if (!d) return null;
  if (key.startsWith('d:')) return dailyTotal(d.hours, key.slice(2));
  return totals(d)[key];
}
function mapWindowLabel(key) { return key === 'past10' ? 'Past 10 days' : key === 'next5' ? 'Next 5 days' : key === 'next15' ? `Next ${CONFIG.futureColumns} days` : fmt(key.slice(2), {weekday: 'long', month: 'short', day: 'numeric'}); }
function mapFeatures() {
  return LOCS.map(loc => {
    const v = mapValue(loc, app.mapWindow);
    return {loc, v, label: finite(v) ? snow(v) : 'No data', bin: binIndex(v)};
  });
}
function renderMapList() {
  const list = mapFeatures().sort((a, b) => (finite(b.v) ? b.v : -1) - (finite(a.v) ? a.v : -1));
  const max = Math.max(1, ...list.map(x => x.v).filter(finite));
  const el = $('mapList');
  if (el) el.innerHTML = list.map(x => `<li><button type="button" data-focus="${x.loc.id}"><span class="ml-name">${esc(x.loc.name)}<small>${esc(x.loc.region)}${x.loc.kind === 'bc' ? ' · Pass' : ''}</small></span><span class="ml-val">${x.label}</span><span class="ml-bar"><i class="b${x.bin ?? 0}" style="--w:${finite(x.v) ? x.v / max : 0}"></i></span></button></li>`).join('');
  const lab = $('mapWindowLabel');
  if (lab) lab.textContent = mapWindowLabel(app.mapWindow);
  const slider = $('daySlider');
  if (slider && app.mapWindow.startsWith('d:')) slider.value = String(columns().findIndex(c => c.date === app.mapWindow.slice(2)));
  document.querySelectorAll('[data-window]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.window === app.mapWindow)));
}
function renderMap() {
  const view = $('view-map'), cols = columns();
  if (!view.querySelector('#mapCanvas')) {
    view.innerHTML = `<div class="map-head"><div><h1 id="mapTitle">3D snowfall map</h1><p class="lede">Columns rise with modeled snowfall at each location over real terrain. Drag to pan, right-drag or two-finger drag to tilt and rotate.</p></div></div>
    <div class="map-layout">
      <div class="map-stage">
        <div id="mapCanvas" class="map-canvas" role="region" aria-label="Interactive 3D map of Colorado snowfall"></div>
        <div class="map-controls">
          <div class="segmented" role="group" aria-label="Snowfall window"><button type="button" data-window="past10">Past 10 d</button><button type="button" data-window="next5">Next 5 d</button><button type="button" data-window="next15">Next ${CONFIG.futureColumns} d</button></div>
          <div class="day-control"><button type="button" class="icon-btn" id="playDays" aria-label="Play through days">${icon('play')}</button><label class="sr-only" for="daySlider">Day</label><input type="range" id="daySlider" min="0" max="${cols.length - 1}" step="1" value="${CONFIG.pastDays}"><span id="mapWindowLabel" class="window-label" aria-live="polite"></span></div>
          <button type="button" class="btn" id="radarToggle" aria-pressed="false">${icon('radar', 'icon-sm')}Radar</button>
          <button type="button" class="btn" id="resetView">${icon('compass', 'icon-sm')}Reset view</button>
        </div>
        <div class="map-legend">${legend()}<p>Column height and color scale with snowfall (heights exaggerated). <span id="radarNote"></span></p></div>
        <div class="map-fallback" id="mapFallback" hidden></div>
      </div>
      <aside class="map-side" aria-label="Locations ranked for the selected window"><h2 class="side-title">Ranked</h2><ol class="map-list" id="mapList"></ol></aside>
    </div>`;
    import('./map.js').then(mod => { mapModule = mod; return mod.mountMap($('mapCanvas'), mapOptions()); })
      .catch(e => { const f = $('mapFallback'); f.hidden = false; f.textContent = `The 3D map could not start (${e.message}). The ranked list still works.`; });
  }
  renderMapList();
  mapModule?.updateMap(mapOptions());
  if (app.route.focus && byId[app.route.focus]) mapModule?.focus(app.route.focus);
}
function mapOptions() {
  return {features: mapFeatures(), theme: effectiveTheme(), reduceMotion: reduceMotion.matches, focusId: app.route.focus,
    onSelect: id => { location.hash = `#/resort/${id}`; }, windowLabel: mapWindowLabel(app.mapWindow), unit: snowUnit()};
}
let playTimer = null;
function togglePlay() {
  const btn = $('playDays');
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.innerHTML = icon('play'); btn.setAttribute('aria-label', 'Play through days'); return; }
  const cols = columns();
  btn.innerHTML = icon('pause'); btn.setAttribute('aria-label', 'Pause');
  let i = app.mapWindow.startsWith('d:') ? cols.findIndex(c => c.date === app.mapWindow.slice(2)) : -1;
  const step = () => { i = (i + 1) % cols.length; app.mapWindow = `d:${cols[i].date}`; renderMap(); };
  step(); playTimer = setInterval(step, 1100);
}

/* ============================== ABOUT ============================== */
function renderAbout() {
  $('view-about').innerHTML = `<h1 id="aboutTitle">Data and methods</h1>
  <p class="lede">Powcast shows three kinds of information and keeps them apart: model forecasts, station measurements, and official bulletins. Missing data is shown as a dash, never as zero.</p>
  <h2>Snowfall forecasts</h2>
  <p>All forecasts come from the free <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo forecast API</a> at the coordinates listed for each location. The homepage and map use Open-Meteo's best-match blend, requested with <code>past_days=${CONFIG.pastDays}</code> and <code>forecast_days=${CONFIG.forecastDays}</code>. Hourly snowfall is the amount in the preceding hour; Powcast sums hours into calendar days in Colorado time, including 23 and 25 hour days at daylight-saving changes. A day with any missing hour is shown as missing.</p>
  <p>The "past" columns are model output stitched from recent runs, not measurements. They are useful for "how much fell recently" at a glance but can differ from what a resort reports.</p>
  <h2>Model comparison</h2>
  <p>Each location page requests these Open-Meteo model ids in one call. Each was checked against Colorado coordinates; models that return no snowfall here, or that silently fall back to another model outside their home region, are left out.</p>
  <div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">Model</th><th scope="col">Open-Meteo id</th><th scope="col">From</th><th scope="col">Type</th><th scope="col">Notes</th></tr></thead><tbody>${MODELS.map(m => `<tr><th scope="row">${esc(m.name)}</th><td><code>${m.id}</code></td><td>${esc(m.org)}</td><td>${esc(m.kind)}</td><td>${esc(m.note)}</td></tr>`).join('')}</tbody></table></div>
  <p>Spread (largest minus smallest) describes disagreement between models. It is not a calibrated probability and is never presented as one.</p>
  <h2>Snow density estimate</h2>
  <p>Open-Meteo converts frozen precipitation to snowfall at a fixed 0.7 cm per mm of water. Colorado snow is often lighter than that. The day table adds an estimate using a Kuchera-style ratio from the warmest temperature among 2 m, 600 hPa, and 500 hPa. It is labeled as an estimate and is not a measurement of snow quality.</p>
  <h2>Observations and bulletins</h2>
  <p>Snow depth and snow water equivalent come from the nearest configured <a href="https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html" target="_blank" rel="noopener noreferrer">NRCS SNOTEL station</a>. Depth changes are not called snowfall. Avalanche danger comes from the <a href="https://avalanche.state.co.us/" target="_blank" rel="noopener noreferrer">Colorado Avalanche Information Center</a> via the avalanche.org public map layer, shown only when exactly one zone contains the point and the bulletin is within its valid period.</p>
  <h2>Map</h2>
  <p>The 3D map uses <a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre GL JS</a> with <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> basemaps (OpenStreetMap data), terrain from the keyless <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">AWS Terrain Tiles</a> dataset, and optional radar from <a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener noreferrer">RainViewer</a>. Radar is past precipitation, not a snow forecast. Columns are point forecasts, not a gridded snowfall field.</p>
  <h2>Privacy</h2>
  <p>Units, theme, and favorites are stored in this browser only. There are no accounts and no API keys. Forecast requests send the listed mountain coordinates to Open-Meteo. Open-Meteo's free API is for non-commercial use.</p>`;
}

/* ============================== ROUTING AND EVENTS ============================== */
function parseRoute() {
  const raw = location.hash.replace(/^#/, '');
  if (/(^|&)(view|loc)=/.test(raw)) { // links from Powcast v2
    const p = new URLSearchParams(raw), id = p.get('loc');
    return byId[id] && (p.get('report') === '1' || p.get('view') === 'detail') ? {view: 'resort', id} : {view: p.get('view') === 'map' ? 'map' : 'home'};
  }
  const [path, query = ''] = raw.split('?'), parts = path.split('/').filter(Boolean), q = new URLSearchParams(query);
  if (parts[0] === 'resort' && parts[1]) return {view: 'resort', id: parts[1], band: q.get('band')};
  if (parts[0] === 'map') return {view: 'map', focus: q.get('focus')};
  if (parts[0] === 'about') return {view: 'about'};
  return {view: 'home'};
}
function route() {
  const prev = app.route;
  app.route = parseRoute();
  if (playTimer && app.route.view !== 'map') togglePlay();
  for (const v of ['home', 'resort', 'map', 'about']) $(`view-${v}`).hidden = v !== app.route.view;
  document.querySelectorAll('[data-route]').forEach(a => a.toggleAttribute('aria-current', a.dataset.route === (app.route.view === 'resort' ? 'home' : app.route.view)));
  document.body.dataset.view = app.route.view;
  const loc = byId[app.route.id];
  document.title = app.route.view === 'resort' && loc ? `${loc.name} snow forecast | Powcast` : app.route.view === 'map' ? '3D snowfall map | Powcast' : app.route.view === 'about' ? 'Data and methods | Powcast' : 'Powcast | Colorado snowfall';
  if (prev.view !== app.route.view || prev.id !== app.route.id) window.scrollTo(0, 0);
  rerender();
}
function rerender() {
  renderStatus();
  const v = app.route.view;
  if (v === 'home') renderHome(); else if (v === 'resort') renderResort(); else if (v === 'map') renderMap(); else renderAbout();
}
function effectiveTheme() { return prefs.theme || (darkQuery.matches ? 'dark' : 'light'); }
function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme;
  const dark = effectiveTheme() === 'dark';
  $('themeButton').innerHTML = icon(dark ? 'sun' : 'moon');
  $('themeButton').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
  document.querySelectorAll('[data-units]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.units === prefs.units)));
  mapModule?.updateMap(mapOptions());
}

/* Floating tooltip shared by matrix cells, bars, and the model chart. */
function showTip(x, y, html, isHTML = false) {
  const tip = $('tip');
  if (isHTML) tip.innerHTML = html; else tip.textContent = html;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.transform = `translate(${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px, ${y - h - 14 < 8 ? y + 18 : y - h - 14}px)`;
}
function hideTip() { $('tip').hidden = true; const c = document.getElementById('crosshair'); c?.setAttribute('visibility', 'hidden'); }

async function share() {
  try { await navigator.clipboard.writeText(location.href); toast('Link copied.'); }
  catch { toast('Copy failed. The address bar has the link for this view.'); }
}
function toggleFav(id) {
  const on = !prefs.favs.includes(id);
  prefs.favs = on ? [...prefs.favs, id] : prefs.favs.filter(x => x !== id);
  persist(); rerender();
  toast(`${byId[id].name} ${on ? 'added to' : 'removed from'} favorites.`);
}
document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-tip]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.sort) { const k = ds.sort; app.sort = {key: k, dir: app.sort.key === k ? -app.sort.dir : k === 'name' ? 1 : -1}; renderHome(); }
  else if (ds.show) { app.show = ds.show; renderHome(); }
  else if (ds.fav) toggleFav(ds.fav);
  else if (ds.units) { prefs.units = ds.units; persist(); applyTheme(); rerender(); }
  else if (ds.band) location.hash = `#/resort/${app.route.id}${ds.band === 'point' ? '' : '?band=' + ds.band}`;
  else if (ds.window) { if (playTimer) togglePlay(); app.mapWindow = ds.window; renderMap(); }
  else if (ds.focus) mapModule?.focus(ds.focus);
  else if (ds.action === 'refresh') refresh(true);
  else if (ds.action === 'share') share();
  else if (t.id === 'themeButton') { prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); }
  else if (t.id === 'playDays') togglePlay();
  else if (t.id === 'resetView') mapModule?.resetView();
  else if (t.id === 'radarToggle') mapModule?.toggleRadar().then(info => { t.setAttribute('aria-pressed', String(!!info)); $('radarNote').textContent = info ? `Radar: past precipitation at ${timeFmt(info.time)}, not a snow forecast. RainViewer.` : ''; }).catch(err => toast(`Radar unavailable: ${err.message}`));
  else if (ds.tip && e.pointerType !== 'mouse') showTip(e.clientX, e.clientY, ds.tip); // tap shows the readout on touch
});
document.addEventListener('input', e => {
  if (e.target.id === 'homeSearch') { app.query = e.target.value; const pos = e.target.selectionStart; renderHome(); const s = $('homeSearch'); s.focus(); s.setSelectionRange(pos, pos); }
  else if (e.target.id === 'daySlider') { if (playTimer) togglePlay(); app.mapWindow = `d:${columns()[+e.target.value].date}`; renderMap(); }
});
document.addEventListener('pointerover', e => { const t = e.target.closest('[data-tip]'); if (t && e.pointerType === 'mouse') showTip(e.clientX, e.clientY, t.dataset.tip); });
document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) hideTip(); });
document.addEventListener('pointermove', e => {
  if (e.target.closest('.model-chart')) chartReadout(e);
  else if (e.target.closest('[data-tip]') && e.pointerType === 'mouse') showTip(e.clientX, e.clientY, e.target.closest('[data-tip]').dataset.tip);
});
document.addEventListener('pointerleave', hideTip);
document.addEventListener('pointerover', e => {
  const row = e.target.closest('tr[data-model]');
  document.querySelectorAll('.line.hot').forEach(l => l.classList.remove('hot'));
  if (row) document.querySelector(`.line[data-model="${row.dataset.model}"]`)?.classList.add('hot');
});
document.addEventListener('scroll', hideTip, {passive: true, capture: true});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
window.addEventListener('hashchange', route);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (app.route.view === 'resort') renderResort(); }, 200); });
darkQuery.addEventListener('change', applyTheme);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', () => refresh());

// Testing surface for the console and automated checks.
window.Powcast = {app, prefs, LOCS, MODELS, totals, refresh};

restoreCache();
applyTheme();
route();
refresh();
setInterval(() => { renderStatus(); if (!document.hidden) refresh(); }, 10 * 60000);
