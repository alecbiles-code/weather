// ALEC'S SNOW PAGE: static Colorado snowfall viewer. No build step, no backend, no API keys.
import {HOUR, TZ, finite, numeric, round, localDate, shiftDate, zonedEpoch, dayBounds, bulletinWindow, request, parseRoute,
  integrate, dailyTotal, sampleStat, sumComplete, normalizeForecast, normalizeModels, horizon, spreadStats,
  slrEstimate, qualityLabel, measuredDay, analysisByDate, parseStationData, containsPoint, binIndex, SNOW_RAMP, RADAR_RAMP,
  waterYearStart, seasonSnow, percentileRank, SNOTEL_SNOW_RATIO, SNOTEL_WATER_MAX_F} from './core.js';
import {LOCS, MODELS} from './locations.js';
import {esc, initChrome, setTicker, loadLists, skierHTML, factHTML, todaysSkier, todaysFact, loadGuestbook, guestbookHTML, submitGuestbook} from './retro.js';

const byId = Object.fromEntries(LOCS.map(l => [l.id, l]));
const TRIPLETS = [...new Set(LOCS.map(l => l.snotel))];
const CONFIG = Object.freeze({
  forecast: 'https://api.open-meteo.com/v1/forecast',
  station: 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/',
  avalanche: 'https://api.avalanche.org/v2/public/products/map-layer/CAIC',
  pastDays: 10,
  forecastDays: 16, // day 16 ends one hour short in local time, so tables show today + 14
  futureColumns: 15,
  cacheMs: 30 * 60000,
  staleMs: 3 * HOUR,
  keepMs: 3 * 24 * HOUR, // oldest saved copy of a source shown when its fetch fails
  timeout: 15000,
  retries: 2, // after the first try; waits 1 s, then 3 s
  slowTimeout: 30000, // NRCS: responses of 4 s to over 100 s were seen on the same request
  retryMs: 2 * 60000 // a failed source is tried again after this, not after cacheMs
});
/**
 * Files the scheduled job generates live on the repo's "data" branch. On GitHub Pages read them from
 * raw.githubusercontent.com; anywhere else (local testing) read ./data/.
 */
const GEN_BASE = (() => {
  const user = location.hostname.match(/^([^.]+)\.github\.io$/)?.[1], repo = location.pathname.split('/').filter(Boolean)[0];
  return user && repo ? `https://raw.githubusercontent.com/${user}/${repo}/data/` : 'data/';
})();
const HOME_HOURLY = 'snowfall,temperature_2m,temperature_600hPa,temperature_500hPa';
const DETAIL_HOURLY = 'snowfall,temperature_2m,temperature_600hPa,temperature_500hPa,wind_speed_10m,wind_gusts_10m,freezing_level_height,rain,weather_code';

/* ---- Preferences: units, theme, favorites, animations, past source. Device-local only. ---- */
const STORE = 'powcast-v3';
function readStore(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: keep working in memory */ } }
function loadPrefs() {
  const p = readStore(STORE, null) || {}, old = p.migrated ? {} : readStore('powcast-v2', {}) || {};
  const favs = Array.isArray(p.favs) ? p.favs : Array.isArray(old.favs) ? old.favs : [];
  return {
    units: ['imperial', 'metric'].includes(p.units) ? p.units : old.units === 'metric' ? 'metric' : 'imperial',
    theme: ['light', 'dark'].includes(p.theme) ? p.theme : old.theme === 'day' ? 'light' : old.theme === 'night' ? 'dark' : null,
    favs: favs.filter(id => byId[id]),
    anim: p.anim !== false,
    past: ['modeled', 'analysis'].includes(p.past) ? p.past : 'measured', // 'measured' = SNOTEL station estimate (key kept for saved prefs)
    migrated: true
  };
}
const prefs = loadPrefs();
const persist = () => writeStore(STORE, prefs);

// src: per-source state (see loadSource). Each source loads, fails and falls back on its own.
const app = {data: {}, errors: {}, busy: false, detail: {}, models: {}, snotel: {}, snotelMeta: {}, src: {},
  bulletins: null, season: {}, snowpack: null, ranking: null, rankLead: 'day1', grid: null, boards: null, lists: {skiers: [], facts: []}, guestbook: false,
  route: {view: 'home'}, sort: {key: 'next5', dir: -1}, show: 'resort', query: '', table: null,
  hires: null, map: {snowIndex: null, radarIndex: null, layers: {field: true, columns: true, trails: true, avalanche: false, snotel: false, freezing: false, snowfx: true, radar: false}}};
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

/* ---- Formatting ---- */
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const imperial = () => prefs.units === 'imperial';
const snowUnit = () => imperial() ? 'in' : 'cm';
/** Compact snowfall for dense cells: T = trace (non-zero but tiny), '' = zero. */
function cellSnow(cm) {
  if (!finite(cm)) return '–';
  const v = imperial() ? cm / 2.54 : cm;
  if (v === 0) return '';
  if (v < (imperial() ? 0.05 : 0.5)) return 'T';
  // SNOTEL depth is whole inches; show 2 rather than 2.0 so it does not look more precise than it is.
  return v >= 10 || Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v).toString() : v.toFixed(1);
}
function snow(cm, unit = true) {
  if (!finite(cm)) return 'No data';
  const v = imperial() ? cm / 2.54 : cm;
  const whole = Math.abs(v - Math.round(v)) < 1e-9; // SNOTEL sums are whole inches; do not print 3.0
  return `${v === 0 ? '0' : v < 0.05 ? '<0.1' : v < 10 && !whole ? v.toFixed(1) : Math.round(v)}${unit ? ' ' + snowUnit() : ''}`;
}
const temp = c => finite(c) ? `${Math.round(imperial() ? c * 9 / 5 + 32 : c)}°` : '–';
const speed = kmh => finite(kmh) ? `${Math.round(imperial() ? kmh / 1.609344 : kmh)} ${imperial() ? 'mph' : 'km/h'}` : '–';
const elev = m => finite(m) ? `${Math.round(imperial() ? m * 3.28084 : m).toLocaleString('en-US')} ${imperial() ? 'ft' : 'm'}` : '–';
const ft = f => finite(f) ? elev(f / 3.28084) : '–';
const water = mm => finite(mm) ? (imperial() ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`) : '–';
const rainFmt = mm => !finite(mm) ? '–' : mm < 0.05 ? '' : water(mm);
const fmt = (date, opts) => new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', ...opts}).format(new Date(date + 'T12:00:00Z'));
const timeFmt = (ms, opts = {}) => finite(ms) ? new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts}).format(new Date(ms)) : 'unknown';
function ago(ms) { if (!finite(ms)) return 'never'; const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} d ago`; }
const external = (url, text, cls = 'link') => url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}${icon('external', 'icon-xs')}</a>` : '';
const heat = cm => { const b = binIndex(cm); return b === null ? 'missing' : `b${b}`; };
const qual = label => label ? `<span class="q q-${label}">${label}</span>` : '';
function toast(message) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; $('toasts').append(el); setTimeout(() => el.remove(), 5000); }
const win = (title, body, {iconName = 'flake', id = '', cls = ''} = {}) => `<div class="win ${cls}"${id ? ` id="${id}"` : ''}><div class="titlebar">${icon(iconName)}<h2>${title}</h2><span class="title-btns" aria-hidden="true"><i>_</i><i>&#9633;</i><i>&times;</i></span></div><div class="win-body">${body}</div></div>`;
/** Builds one panel's HTML; a panel that throws (for example on a malformed data file) shows a notice instead of blanking the page. */
function safe(what, render) {
  try { return render(); }
  catch (e) { console.error(what, e); return `<div class="notice">${esc(what)} could not be shown (${esc(e.message)}). The rest of the page is unaffected.</div>`; }
}

/* ---- Keyboard focus survives re-renders: views are rebuilt with innerHTML on every change. ---- */
const FOCUS_KEYS = ['sort', 'show', 'table', 'past', 'fav', 'band', 'lead', 'action', 'focus'];
function focusSelector(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name && el.form?.id) return `#${CSS.escape(el.form.id)} [name="${CSS.escape(el.name)}"]`; // guestbook fields
  const key = FOCUS_KEYS.find(k => el.dataset?.[k] !== undefined), tag = el.tagName.toLowerCase();
  if (key) return `${tag}[data-${key}="${CSS.escape(el.dataset[key])}"]`;
  const label = el.getAttribute('aria-label'); // scrollable table wrappers
  if (label) return `${tag}[aria-label="${CSS.escape(label)}"]`;
  const href = tag === 'a' && el.getAttribute('href');
  return href ? `a[href="${CSS.escape(href)}"]` : null;
}
/**
 * Replaces an element's content and moves focus to the matching new control if focus was inside it (the same
 * occurrence when several match, such as two links to one page). Typed guestbook text survives too.
 */
function setHTML(el, html) {
  const active = document.activeElement, sel = el.contains(active) ? focusSelector(active) : null;
  const nth = sel ? [...el.querySelectorAll(sel)].indexOf(active) : -1;
  const caret = active?.id === 'homeSearch' ? active.selectionStart : null;
  const drafts = [...el.querySelectorAll('#guestForm [name]')].map(f => [f.name, f.value]);
  el.innerHTML = html;
  for (const [name, value] of drafts) { const f = el.querySelector(`#guestForm [name="${name}"]`); if (f) f.value = value; }
  // If the control itself is gone (an unstarred row under the Favorites filter), land on a stable neighbour.
  const next = sel && (el.querySelectorAll(sel)[Math.max(0, nth)] || el.querySelector('[data-show="fav"], [data-action="show-all"]'));
  if (!next) return;
  next.focus({preventScroll: true});
  if (caret !== null) next.setSelectionRange(caret, caret);
}

/* ---- Calendar columns: past 10 days, today, next 14 ---- */
function columns() {
  const today = localDate();
  return Array.from({length: CONFIG.pastDays + CONFIG.futureColumns}, (_, i) => {
    const date = shiftDate(today, i - CONFIG.pastDays);
    return {date, past: date < today, today: date === today};
  });
}
const measuredFor = (loc, date) => measuredDay(app.snotel[loc.snotel], date);
/** NOAA (NOHRSC) analysis point values for a location by local date, in cm; empty until the data job has sampled them. */
const analysisCache = new WeakMap();
function analysisFor(loc) {
  const p = app.hires?.past?.points?.[loc.id];
  if (!p) return null;
  if (!analysisCache.has(p)) analysisCache.set(p, analysisByDate(p.days));
  return analysisCache.get(p);
}
/** Past columns come from one of three labeled sources, never mixed: 'measured' (SNOTEL station estimate), 'analysis' (NOAA), 'modeled'. */
const pastSource = () => prefs.past;
const PAST_NAMES = {measured: 'station estimate (SNOTEL)', analysis: 'NOAA snowfall analysis', modeled: 'modeled past'};
function pastValue(loc, d, date) {
  if (pastSource() === 'measured') return measuredFor(loc, date)?.cm ?? null;
  if (pastSource() === 'analysis') return analysisFor(loc)?.[date] ?? null;
  return d ? dailyTotal(d.hours, date) : null;
}
/** Daily snowfall for one location: past days from the chosen past source, today and later from the forecast. */
function dailyFor(loc, d, cols = columns()) {
  return Object.fromEntries(cols.map(c => [c.date, c.past ? pastValue(loc, d, c.date) : d ? dailyTotal(d.hours, c.date) : null]));
}
function totals(loc, d, cols = columns()) {
  const daily = dailyFor(loc, d, cols), pick = list => sumComplete(list.map(c => daily[c.date])), future = cols.filter(c => !c.past);
  return {daily, past10: pick(cols.filter(c => c.past)), next5: pick(future.slice(0, 5)), next10: pick(future.slice(0, 10)), next15: pick(future)};
}
/** Snow-weighted quality estimate for a forecast window, from temperatures (labeled estimate). */
function forecastQuality(d, startDate, days) {
  if (!d) return null;
  const est = slrEstimate(d.hours, zonedEpoch(startDate), zonedEpoch(shiftDate(startDate, days)));
  return est && est.snowCm > 0 && est.liquidMm >= 1 ? {ratio: est.ratio, label: qualityLabel(est.ratio)} : null;
}

/* ---- Network: every request has a timeout and a bounded retry (core.js request) ---- */
const inflight = new Map();
const JSON_INIT = {headers: {Accept: 'application/json'}, credentials: 'omit'};
function fetchJSON(url, init = JSON_INIT, timeout = CONFIG.timeout) {
  if (inflight.has(url)) return inflight.get(url);
  const p = request(url, {timeout, retries: CONFIG.retries, init}).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}
/** A file from the scheduled data job. */
const genJSON = file => fetchJSON(GEN_BASE + file, {cache: 'no-cache', credentials: 'omit'});

/* ---- Saved copies: the last good value of each source, shown (and labeled) when a fetch fails ---- */
const SAVED = `${STORE}-saved`;
const recall = name => { const c = readStore(`${SAVED}-${name}`, null); return c && finite(c.at) && Date.now() - c.at < CONFIG.keepMs ? c : null; };
const keep = (name, value) => writeStore(`${SAVED}-${name}`, {at: Date.now(), v: value});
/** State of one source: when the shown data was fetched (at), whether it is a saved copy (cached), the last error. */
const src = name => app.src[name] ||= {at: null, cached: false, error: null, tried: null};
/**
 * Loads one source on its own: load() fetches and returns a value, apply(value) puts it on the page state and
 * throws if the value is malformed. On failure, data already shown stays; with none, the last good copy saved
 * on this device is used and marked as cached. One source failing never blanks another.
 */
async function loadSource(name, load, apply, {force = false, save = true} = {}) {
  const s = src(name);
  if (!force && !due(s.tried)) return;
  s.tried = {loading: true};
  try {
    const value = await load();
    apply(value);
    Object.assign(s, {at: Date.now(), cached: false, error: null});
    if (save) keep(name, value);
  } catch (e) {
    s.error = e.message || 'Unavailable';
    // due() lets it through by then. A hidden tab waits for visibilitychange; a file not built yet waits for the 30-min cycle.
    setTimeout(() => { if (src(name).error && !document.hidden && !notBuilt(name)) refresh(); }, CONFIG.retryMs + 1000);
    const c = save && !s.at ? recall(name) : null;
    if (c) { try { apply(c.v); Object.assign(s, {at: c.at, cached: true}); } catch { /* a malformed saved copy is ignored */ } }
  }
  s.tried = {at: Date.now(), failed: !!s.error};
  rerender();
}
/** Back online: retry every source that failed, without waiting for its retry window. */
function retryFailed() {
  for (const s of Object.values(app.src)) if (s.error && !s.tried?.loading) s.tried = null;
  for (const recs of [app.detail, app.models]) for (const [k, r] of Object.entries(recs)) if (r?.error && !r.loading) recs[k] = {...r, at: 0};
  refresh(false, true);
  if (app.route.view === 'resort') renderResort(); // reloads the page's details through due()
}
/** Status words for a source, and whether they need a warning. */
function sourceState(name, label) {
  const s = src(name);
  if (s.cached) return {text: `${label}: saved copy from ${ago(s.at)}`, warn: 'Offline copy'};
  if (s.at) return {text: `${label} updated ${ago(s.at)}`, warn: s.error ? 'Refresh failed' : ''};
  if (s.error) return {text: `${label} unavailable`, warn: 'Down'};
  return {text: `${label} loading…`, warn: ''};
}
/** A notice for panels showing a saved copy, so cached data is never mistaken for live. */
function cachedNotice(name, what) {
  const s = src(name);
  return s.cached ? `<div class="notice">${esc(what)} could not be loaded (${esc(s.error)}). Showing the copy saved on this device ${esc(ago(s.at))}.</div>` : '';
}
function bandElevation(loc, band) {
  const f = band === 'base' ? loc.base : band === 'summit' ? loc.top : band === 'mid' ? (loc.base + loc.top) / 2 : null;
  return finite(f) ? String(round(f / 3.28084, 1)) : null;
}
function forecastURL(locs, {hourly = HOME_HOURLY, band = 'point', models = null, pastDays = CONFIG.pastDays} = {}) {
  const p = new URLSearchParams({latitude: locs.map(l => l.lat).join(','), longitude: locs.map(l => l.lon).join(','), hourly,
    past_days: String(pastDays), forecast_days: String(CONFIG.forecastDays), timeformat: 'unixtime', timezone: TZ,
    temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm'});
  if (models) p.set('models', models.join(','));
  const e = band !== 'point' && bandElevation(locs[0], band);
  if (e) p.set('elevation', e);
  return `${CONFIG.forecast}?${p}`;
}
/** A record is due when never tried, or its last attempt (success or failure) is older than the cache window. */
const due = rec => !rec || (!rec.loading && Date.now() - (rec.at || 0) >= (rec.failed ? CONFIG.retryMs : CONFIG.cacheMs));

/* ---- Homepage forecasts, cached on the device ---- */
const COMPACT = ['snow', 'temp', 't600', 't500'];
function restoreCache() {
  const cached = readStore(`${STORE}-forecasts-2`, {});
  for (const [id, d] of Object.entries(cached || {})) {
    if (!byId[id] || !finite(d?.fetchedAt) || Date.now() - d.fetchedAt > 24 * HOUR || !Array.isArray(d.h)) continue;
    app.data[id] = {fetchedAt: d.fetchedAt, elevation: d.elevation, hours: d.h.map(([t, ...v]) => Object.fromEntries([['t', t], ...COMPACT.map((k, i) => [k, v[i]])]))};
  }
}
function saveCache() {
  writeStore(`${STORE}-forecasts-2`, Object.fromEntries(Object.entries(app.data).map(([id, d]) => [id, {fetchedAt: d.fetchedAt, elevation: d.elevation, h: d.hours.map(h => [h.t, ...COMPACT.map(k => h[k] ?? null)])}])));
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
/** force: reload everything (the Refresh button). retryErrors: also forecasts whose last refresh failed. */
async function refresh(force = false, retryErrors = false) {
  loadSnotel(force); loadSeason(force); loadAvalanche(force); loadGenerated(force); // independent sources, in parallel
  if (force && app.route.view === 'resort') { for (const recs of [app.detail, app.models]) for (const k of Object.keys(recs)) if (!recs[k]?.loading) recs[k] = {...recs[k], at: 0}; renderResort(); }
  if (app.busy) return;
  const wanted = LOCS.filter(l => force || !app.data[l.id] || (retryErrors && app.errors[l.id]) || Date.now() - app.data[l.id].fetchedAt > CONFIG.cacheMs);
  if (!wanted.length) return;
  app.busy = true; renderStatus();
  const groups = [];
  for (let i = 0; i < wanted.length; i += 8) groups.push(wanted.slice(i, i + 8));
  for (let i = 0; i < groups.length; i += 2) await Promise.all(groups.slice(i, i + 2).map(loadGroup));
  app.busy = false; saveCache(); rerender();
  if (force) toast(Object.keys(app.errors).length ? 'Some locations could not refresh. Earlier data was kept and is labeled.' : 'Forecasts refreshed.');
}
/** SNOTEL daily request: depth, water, and the daily high (it gates the water term of the station estimate). */
const snotelURL = params => `${CONFIG.station}data?${new URLSearchParams({stationTriplets: TRIPLETS.join(','), elements: 'SNWD,WTEQ,TMAX', duration: 'DAILY', endDate: localDate(), returnSuspectData: 'false', ...params})}`;
function parseStations(raw) {
  const out = {};
  for (const t of TRIPLETS) { try { out[t] = parseStationData(raw, t); } catch { out[t] = null; } }
  if (!Object.values(out).some(Boolean)) throw new Error('No station data in the response');
  return out;
}
/** All SNOTEL stations in two requests: the recent daily values (with medians), and station metadata. */
function loadSnotel(force = false) {
  return loadSource('snotel', async () => {
    const [data, meta] = await Promise.allSettled([fetchJSON(snotelURL({beginDate: shiftDate(localDate(), -(CONFIG.pastDays + 2)), centralTendencyType: 'MEDIAN'}), JSON_INIT, CONFIG.slowTimeout),
      fetchJSON(`${CONFIG.station}stations?${new URLSearchParams({stationTriplets: TRIPLETS.join(',')})}`, JSON_INIT, CONFIG.slowTimeout)]);
    if (data.status === 'rejected') throw data.reason;
    const metaOut = {...app.snotelMeta}; // a failed metadata request keeps what is known
    if (meta.status === 'fulfilled' && Array.isArray(meta.value)) for (const s of meta.value) metaOut[s.stationTriplet] = {name: s.name, lat: numeric(s.latitude), lon: numeric(s.longitude), elevationFt: numeric(s.elevation)};
    return {stations: parseStations(data.value), meta: metaOut};
  }, v => { if (!v?.stations) throw new Error('Malformed station data'); app.snotel = v.stations; app.snotelMeta = v.meta || {}; }, {force});
}
/**
 * Season-to-date station estimate per station, from the water-year start (Oct 1) through each station's latest
 * depth reading. Its own request, so a slow or failed season pull never touches the past-10-day columns.
 */
function loadSeason(force = false) {
  const start = waterYearStart(localDate());
  return loadSource('season', async () => {
    const stations = parseStations(await fetchJSON(snotelURL({beginDate: shiftDate(start, -1)}), JSON_INIT, CONFIG.slowTimeout)), out = {};
    for (const t of TRIPLETS) {
      const st = stations[t], end = st?.SNWD?.filter(x => x.value !== null).at(-1)?.date;
      out[t] = end && end >= start ? {start, end, ...seasonSnow(st, start, end)} : null;
    }
    return out;
  }, v => {
    if (!v || typeof v !== 'object') throw new Error('Malformed season data');
    if (Object.values(v).some(s => s && s.start !== start)) throw new Error('Saved totals are from an earlier season');
    app.season = v;
  }, {force});
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, what) => { if (!ok) throw new Error(`Malformed ${what}`); };
/** Files from the scheduled data job, each on its own, checked for the shape the page uses. The page renders without any of them. */
const GENERATED = [
  ['ranking', 'model-ranking.json', v => { check(isObj(v?.leads) && Object.values(v.leads).every(Array.isArray) && Array.isArray(v.windows), 'model ranking'); app.ranking = v; }],
  ['grid', 'grid.json', v => { check(Array.isArray(v?.days) && Array.isArray(v.freezingLevelM ?? []), 'grid'); app.grid = v; }],
  ['hires', 'hires/manifest.json', v => {
    check(Array.isArray(v?.bounds) && v.bounds.length === 4 && ['past', 'snow', 'radar'].every(k => v[k] == null || (Array.isArray(v[k].frames ?? []) && (v[k].frames ?? []).every(isObj))) && (v.past?.points == null || isObj(v.past.points)), 'map manifest');
    app.hires = v;
  }],
  ['boards', 'boards.json', v => { check(isObj(v?.locations) && Object.values(v.locations).every(x => x === null || Array.isArray(x?.reports)), 'snow-board file'); app.boards = v; }],
  ['snowpack', 'snowpack-history.json', v => { check(isObj(v?.stations), 'snowpack history'); app.snowpack = v; }, false] // too large to keep a copy
];
function loadGenerated(force = false) {
  for (const [name, file, apply, save = true] of GENERATED) loadSource(name, () => genJSON(file), apply, {force, save});
}
/** A generated file that is missing (not built yet) rather than unreachable. */
const notBuilt = name => !src(name).at && /HTTP 404/.test(src(name).error || '');
async function loadExtras() {
  const [lists, guest] = await Promise.allSettled([loadLists(), loadGuestbook()]);
  if (lists.status === 'fulfilled') app.lists = lists.value;
  app.guestbook = guest.status === 'fulfilled' && guest.value;
  rerender();
}

/* ---- Status bar: forecasts, stations and avalanche bulletins each report their own state ---- */
let lastStatus = '';
function renderStatus() {
  const loaded = LOCS.filter(l => app.data[l.id]), ok = loaded.filter(l => fresh(app.data[l.id])).length;
  const latest = loaded.length ? Math.max(...loaded.map(l => app.data[l.id].fetchedAt)) : null;
  const errIds = Object.keys(app.errors).filter(id => byId[id]), failed = errIds.length, kept = errIds.filter(id => app.data[id]).length;
  const stale = loaded.length && ok < loaded.length;
  const text = app.busy ? `Loading forecasts for ${LOCS.length} locations…` : !loaded.length ? (failed ? 'Forecasts could not be loaded. Nothing has been substituted.' : 'No forecasts loaded yet.') : `Forecasts ${loaded.length}/${LOCS.length} · updated ${ago(latest)}`;
  const part = ({text: t, warn}) => `<span>${esc(t)}${warn ? `<span class="pill warn">${esc(warn)}</span>` : ''}</span>`;
  const html = `<span class="grow"><span class="dot ${app.busy ? 'busy' : stale || failed ? 'warn' : 'ok'}" aria-hidden="true"></span>${esc(text)}${app.busy ? '<span class="progress" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' : ''}${stale ? '<span class="pill warn">Stale data shown</span>' : ''}${failed - kept && !app.busy ? `<span class="pill warn">${failed - kept} unavailable</span>` : ''}${kept && !app.busy ? `<span class="pill warn">${kept} refresh failed, earlier data kept</span>` : ''}</span>
    ${part(sourceState('snotel', 'SNOTEL'))}${part(sourceState('bulletins', 'CAIC'))}
    <span><button type="button" class="text-btn" data-action="refresh"${app.busy ? ' aria-disabled="true"' : ''}>${icon('refresh', 'icon-xs')}Refresh</button></span>`;
  if (html !== lastStatus) { lastStatus = html; setHTML($('status'), html); }
  // The bar itself has clock-like times, so it is not a live region. Screen readers hear only state changes.
  const words = [app.busy ? 'Loading forecasts' : failed ? `${failed} forecasts not refreshed` : loaded.length ? 'Forecasts loaded' : '',
    ...[['snotel', 'SNOTEL'], ['bulletins', 'CAIC']].map(([n, label]) => [label, sourceState(n, label).warn]).filter(([, w]) => w).map(([label, w]) => `${label}: ${w.toLowerCase()}`)].filter(Boolean).join('. ');
  const live = $('statusLive');
  if (live && live.textContent !== words) live.textContent = words;
}

/* ============================== HOMEPAGE ============================== */
function homeRows(cols) {
  const q = app.query.trim().toLowerCase();
  return LOCS.filter(l => (app.show === 'all' || (app.show === 'fav' ? prefs.favs.includes(l.id) : l.kind === app.show)) && (!q || `${l.name} ${l.region}`.toLowerCase().includes(q)))
    .map(loc => ({loc, d: app.data[loc.id], t: totals(loc, app.data[loc.id], cols), q: forecastQuality(app.data[loc.id], localDate(), 5)}));
}
const QUALITY_ORDER = {Blower: 4, Powder: 3, Average: 2, Heavy: 1};
function sortValue(row, key) { return key === 'name' ? row.loc.name : key === 'quality' ? (row.q ? QUALITY_ORDER[row.q.label] : null) : key.startsWith('d:') ? row.t.daily[key.slice(2)] : row.t[key]; }
/** Favorites stay on top; each group follows the chosen sort. Missing values always sort last. */
function sortRows(rows) {
  const {key, dir} = app.sort;
  const cmp = (a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (key === 'name') return dir * va.localeCompare(vb);
    if (finite(va) !== finite(vb)) return finite(va) ? -1 : 1;
    return (finite(va) && finite(vb) ? dir * (va - vb) : 0) || a.loc.name.localeCompare(b.loc.name);
  };
  const fav = r => prefs.favs.includes(r.loc.id);
  return [...rows.filter(fav).sort(cmp), ...rows.filter(r => !fav(r)).sort(cmp)];
}
function sortHeader(key, label, cls, sub = '') {
  const active = app.sort.key === key;
  return `<th scope="col" class="${cls}${active ? ' sorted' : ''}"${active ? ` aria-sort="${app.sort.dir < 0 ? 'descending' : 'ascending'}"` : ''}><button type="button" data-sort="${key}"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button></th>`;
}
function dayStats(rows, c) {
  const vals = rows.map(r => ({r, v: r.t.daily[c.date]})).filter(x => finite(x.v)).sort((a, b) => b.v - a.v);
  return {n: vals.filter(x => x.v >= 2.54).length, total: vals.length, lead: vals[0]};
}
const oneInch = () => imperial() ? '1 in' : '2.5 cm';
function stormRow(rows, cols) {
  const counts = cols.map(c => ({c, ...dayStats(rows, c)})), max = Math.max(1, ...counts.map(x => x.n));
  const cells = counts.map(({c, n, total, lead}) => {
    const tip = total ? `${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${n} of ${total} at ≥ ${oneInch()}${lead && lead.v > 0 ? `. Most: ${lead.r.loc.name}, ${snow(lead.v)}` : ''}` : 'No data';
    return `<td class="storm ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(tip)}"><span class="storm-bar" style="--h:${n / max}"></span><span class="storm-n">${n || ''}</span></td>`;
  }).join('');
  return `<tr class="storm-row"><th scope="row" class="name-cell"><span class="storm-label">Locations ≥ ${oneInch()}</span></th>${cells}<td class="total" colspan="5"></td></tr>`;
}
/** How a station-estimate day was reached, in words: which term won and why the other did not count. */
function stationWhy(m) {
  const water = finite(m.sweChangeIn) ? `${m.sweChangeIn >= 0 ? '+' : ''}${m.sweChangeIn.toFixed(1)} in of water` : 'no water reading';
  const how = m.method === 'water' ? `from ${m.sweChangeIn.toFixed(1)} in of water at ${SNOTEL_SNOW_RATIO}:1 (depth ${m.depthChangeIn >= 0 ? 'gained' : 'changed'} ${m.depthChangeIn} in)`
    : m.method === 'depth' ? `depth gain, ${water}` : `depth ${m.depthChangeIn >= 0 ? '+' : ''}${m.depthChangeIn} in, ${water}`;
  const gate = m.waterGated === 'warm' ? `; water not counted as snow, high of ${Math.round(m.tmaxF)}°F` : m.waterGated === 'no-temp' ? '; water not counted as snow: no temperature reading' : '';
  return `${how}${gate}`;
}
function cellTip(loc, c, v, d) {
  const day = fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'});
  if (c.past && pastSource() === 'measured') {
    const m = measuredFor(loc, c.date), st = app.snotelMeta[loc.snotel]?.name || loc.snotel;
    if (!m) return `${loc.name}, ${day}: no SNOTEL reading (${st})`;
    return `${loc.name}, ${day}: ${snow(m.cm)} station estimate at ${st} SNOTEL (${stationWhy(m)}). Depth ${m.depthIn} in${m.quality ? `. ${m.quality} (${Math.round(m.ratio)}:1, measured)` : ''}`;
  }
  if (c.past && pastSource() === 'analysis') return `${loc.name}, ${day}: ${finite(v) ? snow(v) : 'no data'}, NOAA snowfall analysis (4 km grid), the 24 h from 5 AM (6 AM in daylight time)`;
  const q = !c.past && v > 0.25 ? forecastQuality(d, c.date, 1) : null;
  return `${loc.name}, ${day}: ${finite(v) ? snow(v) : 'no data'}${c.past ? ' (modeled past)' : ''}${q ? `. Est. ${q.label} (${Math.round(q.ratio)}:1)` : ''}`;
}
function matrixRow(row, cols, lastFav) {
  const {loc, d, t, q} = row, fav = prefs.favs.includes(loc.id);
  const stale = d && !fresh(d) ? '<span class="pill warn">Stale</span>' : '';
  const err = !d && app.errors[loc.id] ? '<span class="pill warn">Unavailable</span>' : '';
  const cells = cols.map(c => { const v = t.daily[c.date]; return `<td class="cell ${heat(v)} ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(cellTip(loc, c, v, d))}">${cellSnow(v)}</td>`; }).join('');
  const tot = (v, cls) => `<td class="total ${cls} ${heat(v)}">${finite(v) ? snow(v, false) : '–'}</td>`;
  return `<tr class="${lastFav ? 'fav-last' : ''}"><th scope="row" class="name-cell"><div class="name-wrap"><button type="button" class="star ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(loc.name)} ${fav ? 'from' : 'to'} favorites">${icon('star')}</button><a href="#/resort/${loc.id}"><span class="loc-name">${esc(loc.name)}</span><span class="loc-sub">${esc(loc.region)}${loc.kind === 'bc' ? ' · Pass' : ''}${stale}${err}</span></a></div></th>${cells}${tot(t.past10, 'first')}${tot(t.next5, '')}${tot(t.next10, '')}${tot(t.next15, '')}<td class="qual" data-tip="${esc(q ? `Estimated from forecast temperatures: about ${Math.round(q.ratio)}:1 snow to water` : 'Not enough forecast snow to estimate')}">${q ? qual(q.label) : ''}</td></tr>`;
}
/**
 * Storm Watch and the ticker: always every resort statewide, whatever the table filter shows, so the box and the
 * ticker agree. The last-3-days list is always the SNOTEL station estimate.
 */
function stormFacts(cols = columns()) {
  const pool = LOCS.filter(l => l.kind === 'resort').map(loc => ({loc, d: app.data[loc.id], t: totals(loc, app.data[loc.id], cols)}));
  const next = cols.filter(c => !c.past).map(c => ({c, ...dayStats(pool, c)})).find(x => x.n >= 3);
  const best5 = pool.filter(r => finite(r.t.next5)).sort((a, b) => b.t.next5 - a.t.next5)[0];
  const last3 = pool.map(({loc}) => ({loc, v: sumComplete([1, 2, 3].map(i => measuredFor(loc, shiftDate(localDate(), -i))?.cm ?? null))}))
    .filter(x => finite(x.v)).sort((a, b) => b.v - a.v);
  return {next, best5, last3, total: pool.length, withForecast: pool.filter(r => r.d).length};
}
function stormWatchHTML(f) {
  const scope = `<p class="box-sub">All ${f.total} resorts statewide, whatever the table shows.</p>`;
  const partial = f.withForecast < f.total ? ` (${f.total - f.withForecast} without a forecast)` : '';
  const nextLine = !f.withForecast ? `<p><b>Next widespread snow:</b> ${app.busy ? 'loading forecasts…' : 'forecasts unavailable, so nothing is claimed.'}</p>`
    : f.next ? `<p><b>Next widespread snow:</b> ${f.next.c.today ? 'today' : esc(fmt(f.next.c.date, {weekday: 'long', month: 'short', day: 'numeric'}))}. ${f.next.n} of ${f.next.total} resorts at ≥ ${oneInch()}; most at <a href="#/resort/${f.next.lead.r.loc.id}">${esc(f.next.lead.r.loc.name)}</a> (${snow(f.next.lead.v)}).</p>`
    : `<p><b>Next widespread snow:</b> none in the next ${CONFIG.futureColumns} days${partial}.</p>`;
  const best = f.best5 && f.best5.t.next5 > 0 ? `<p><b>Most in the next 5 days:</b> <a href="#/resort/${f.best5.loc.id}">${esc(f.best5.loc.name)}</a>, ${snow(f.best5.t.next5)}.</p>` : '';
  const s = src('snotel'), head = '<b>Last 3 days</b> (SNOTEL station estimate)';
  const measured = f.last3.length ? (f.last3[0].v > 0 ? `<p class="recap-gap">${head}:</p><ol>${f.last3.filter(x => x.v > 0).slice(0, 3).map(x => `<li><a href="#/resort/${x.loc.id}">${esc(x.loc.name)}</a><span>${snow(x.v)}</span></li>`).join('')}</ol>` : `<p class="recap-gap">${head}: no new snow at any resort station.</p>`)
    : `<p class="recap-gap">${head}: ${s.at ? 'no station has all 3 days.' : s.error ? 'station data unavailable.' : 'loading…'}</p>`;
  return `<div class="recap">${scope}${nextLine}${best}${measured}</div>`;
}
/* ---- Season leaderboard and snowpack percentile: resorts only; nearby resorts can share a station ---- */
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const sweFmt = inches => imperial() ? `${inches.toFixed(1)} in` : `${Math.round(inches * 25.4)} mm`;
/** A total with missing station days is a lower bound, so it says so. */
const seasonText = s => `${s.missing ? '≥ ' : ''}${snow(s.cm)}`;
function seasonHTML() {
  const since = esc(fmt(waterYearStart(localDate()), {month: 'short', day: 'numeric'}));
  const rows = LOCS.filter(l => l.kind === 'resort').map(loc => ({loc, s: app.season[loc.snotel]})).filter(x => finite(x.s?.cm))
    .sort((a, b) => b.s.cm - a.s.cm || a.loc.name.localeCompare(b.loc.name));
  const s = src('season');
  if (!rows.length) return s.error && !s.at ? `<p class="notice">Season totals could not load (${esc(s.error)}). Nothing is substituted.</p>` : !s.at ? '<div class="skeleton" style="height:120px" aria-label="Loading season totals"></div>' : '<p class="muted">No station readings this season yet.</p>';
  const list = rows[0].s.cm > 0 ? `<ol>${rows.slice(0, 5).map((x, i) => `<li><span class="rank">${i + 1}.</span><a href="#/resort/${x.loc.id}">${esc(x.loc.name)}</a><span>${seasonText(x.s)}</span></li>`).join('')}</ol>` : `<p>No new snow at any resort station since ${since}.</p>`;
  return `<div class="recap">${cachedNotice('season', 'NRCS')}<p><b>Most snow since ${since}</b> (SNOTEL station estimate):</p>${list}<p class="box-foot">Each resort’s station, daily estimates added up. Near four observer snow boards over six winters this rule caught 84% of board snowfall (the old depth-only rule 61%). Full list below.</p></div>`;
}
const PCT_LABELS = [[90, 'Much above normal'], [70, 'Above normal'], [30, 'Near normal'], [10, 'Below normal'], [0, 'Much below normal']];
/** Live SWE against the station's own record for that calendar date (snowpack-history.json, built by the scheduled job). */
function snowpackFor(loc) {
  const swe = app.snotel[loc.snotel]?.WTEQ?.filter(x => x.value !== null).at(-1);
  if (!swe) return null;
  const hist = app.snowpack?.stations?.[loc.snotel]?.swe?.[swe.date.slice(5)] || [], med = spreadStats(hist).median;
  const enough = hist.length >= 10, none = enough && swe.value === 0 && med === 0; // bare ground on a date that is usually bare says nothing
  return {swe, years: hist.length, none, early: enough && med < 1, pct: enough && !none ? percentileRank(hist, swe.value) : null,
    pctMedian: finite(swe.median) && swe.median > 0 ? swe.value / swe.median * 100 : null};
}
function powerHTML() {
  const rows = LOCS.filter(l => l.kind === 'resort').map(loc => ({loc, p: snowpackFor(loc), s: app.season[loc.snotel]}));
  const sn = src('snotel');
  if (!rows.some(r => r.p)) return sn.error && !sn.at ? `<div class="notice">Station data could not load: ${esc(sn.error)}. No ranking is inferred.</div>` : '<div class="skeleton" style="height:200px" aria-label="Loading snowpack"></div>';
  const key = r => finite(r.p?.pct) ? r.p.pct : -1;
  rows.sort((a, b) => key(b) - key(a) || (b.p?.swe.value ?? -1) - (a.p?.swe.value ?? -1) || a.loc.name.localeCompare(b.loc.name));
  const noHistory = notBuilt('snowpack') ? 'History not built yet' : src('snowpack').error ? 'History could not load' : 'History loading';
  const why = p => !p ? 'No reading' : !app.snowpack ? noHistory : p.years < 10 ? `Only ${p.years} year${p.years === 1 ? '' : 's'} of record` : 'No snowpack yet, normal for the date';
  const body = rows.map(({loc, p, s}) => {
    const has = finite(p?.pct), label = has ? PCT_LABELS.find(([t]) => p.pct >= t)[1] : '';
    return `<tr><td>${has ? rows.findIndex(r => key(r) === p.pct) + 1 : '–'}</td><th scope="row"><a href="#/resort/${loc.id}">${esc(loc.name)}</a></th>
      <td>${has ? `<b>${ordinal(Math.round(p.pct))}</b> <span class="score-bar" style="width:${Math.max(2, p.pct * 0.8)}px"></span> <span class="muted">${label}${p.early ? ', early season' : ''}</span>` : `<span class="muted">${why(p)}</span>`}</td>
      <td class="num">${finite(p?.pctMedian) ? Math.round(p.pctMedian) + '%' : '–'}</td><td class="num">${p ? sweFmt(p.swe.value) : '–'}</td><td class="num">${finite(s?.cm) ? seasonText(s) : '–'}</td>
      <td>${esc(app.snotelMeta[loc.snotel]?.name || loc.snotel)}${p && p.swe.date < shiftDate(localDate(), -2) ? '<span class="pill warn">Old reading</span>' : ''}</td></tr>`;
  }).join('');
  const since = fmt(waterYearStart(localDate()), {month: 'short', day: 'numeric'}), sp = app.snowpack;
  return `${cachedNotice('snotel', 'NRCS')}<p class="panel-sub">Where today’s snowpack at each resort’s SNOTEL station ranks against the same date in every past year on record. 50th is a typical year; 90th means only 1 year in 10 had more.</p>
  <div class="table-scroll" tabindex="0" aria-label="Snowpack rankings, scrolls sideways"><table class="data-table power"><thead><tr><th scope="col">Rank</th><th scope="col">Resort</th><th scope="col">Percentile<small>snow water vs record</small></th><th scope="col" class="num">% of median<small>NRCS, this date</small></th><th scope="col" class="num">Snow water<small>at the station now</small></th><th scope="col" class="num">Season snow<small>since ${esc(since)}, station est.</small></th><th scope="col">SNOTEL station</th></tr></thead><tbody>${body}</tbody></table></div>
  <p class="note">Modeled on the ${external('https://www.wcc.nrcs.usda.gov/ftpref/support/states/CO/products/#state=co&element=wteq', 'NRCS Colorado snowpack products')}. Percentile is computed by this site: the station’s latest snow water equivalent (SWE) placed among its SWE on the same calendar date in every past water year${sp ? ` through ${esc(fmt(sp.through, {month: 'short', year: 'numeric'}))}` : ''}, ties counted as half. It needs at least 10 years of record. Early in the season a few tenths of an inch swing the percentile a lot, and bare ground on a date that is usually bare is not ranked. % of median is the NRCS median for the date. Season snow adds up the daily station estimate (the same rule as the past columns: the larger of the depth gain and ${SNOTEL_SNOW_RATIO} times the water gain); ≥ marks a total with missing station days. Resorts that share a station share a value, and a station is near the resort, not on its slopes.${sp ? ` History rebuilt ${esc(ago(Date.parse(sp.generatedAt)))}.` : ' The percentile appears once the scheduled data job has built the station history.'}</p>`;
}
function tickerItems(f) {
  const items = [];
  if (f.next) items.push(`NEXT WIDESPREAD SNOW: <b>${esc((f.next.c.today ? 'today' : fmt(f.next.c.date, {weekday: 'short', month: 'short', day: 'numeric'})).toUpperCase())}</b>, MOST AT ${esc(f.next.lead.r.loc.name.toUpperCase())} ${esc(snow(f.next.lead.v).toUpperCase())}`);
  if (f.best5 && f.best5.t.next5 > 0) items.push(`5-DAY LEADER: <b>${esc(f.best5.loc.name.toUpperCase())}</b> ${esc(snow(f.best5.t.next5).toUpperCase())}`);
  if (f.last3[0]?.v > 0) items.push(`LAST 3 DAYS (SNOTEL EST.): <b>${esc(f.last3[0].loc.name.toUpperCase())}</b> ${esc(snow(f.last3[0].v).toUpperCase())}`);
  const sk = todaysSkier(app.lists.skiers), fact = todaysFact(app.lists.facts), pick = topPick('day1');
  if (sk) items.push(`SKIER OF THE DAY: <b>${esc((sk.nickname || sk.first_name).toUpperCase())}</b>`);
  if (pick) items.push(`MODEL TO TRUST FOR TOMORROW: <b>${esc(pick.name.toUpperCase())}</b> (BEST STORM SCORE LAST WINTER)`);
  if (fact) items.push(`FUN FACT: ${esc(fact)}`);
  return items.length ? items : ['WELCOME TO ALEC’S SNOW PAGE'];
}
function legend() {
  const edges = imperial() ? ['0.1', '1', '3', '6', '10', '15', '24'] : ['0.25', '2.5', '7.5', '15', '25', '38', '61'];
  return `<div class="legend" aria-label="Color scale in ${imperial() ? 'inches' : 'centimeters'}"><span class="legend-title">${imperial() ? 'Inches' : 'cm'}</span>${edges.map((e, i) => `<span class="swatch b${i + 1}"></span><span>${e}${i === edges.length - 1 ? '+' : ''}</span>`).join('')}<span class="swatch missing"></span><span>No data</span><span class="legend-t">T = trace</span></div>`;
}
/** Phones start on the summary table; anyone can switch. */
const summaryMode = () => app.table ? app.table === 'summary' : matchMedia('(max-width: 640px)').matches;
/** Past-days band label and the note under the table, per past source. */
// Short: when the table opens on today only two past columns (about 80 px) are visible. The note below has the full wording.
const PAST_BAND = {measured: 'STATION', analysis: 'NOAA', modeled: 'MODELED'};
/** Why the NOAA analysis is missing or old, in words; empty when it is current. */
function analysisStatus() {
  const h = app.hires, s = src('hires');
  if (h?.past?.error && !h.past.points) return ` The last data run could not build it (${h.past.error}).`;
  const notYet = ' Not built yet: it appears after the scheduled data job runs.';
  if (!h?.past?.points) return notBuilt('hires') ? notYet : s.error ? ` The file could not load (${s.error}).` : h ? notYet : ' Loading.';
  return s.cached ? ` Showing the copy saved on this device ${ago(s.at)}; the file could not be loaded (${s.error}).` : '';
}
function pastNote() {
  if (pastSource() === 'measured') return `Past days: a station estimate from each location’s nearest SNOTEL station, the larger of the day’s depth gain (gains under 1 in count as 0) and ${SNOTEL_SNOW_RATIO} times its water gain (only on days with a high at or below ${SNOTEL_WATER_MAX_F}°F). Nearby locations can share a station, and a station is not the resort’s own snow stake.`;
  if (pastSource() === 'analysis') return `Past days: the NOAA National Snowfall Analysis (NOHRSC), radar and gauge water turned into snow and pulled toward observer reports, read at one 4 km cell per location (on the ski area for resorts), each the 24 h from 5 AM (6 AM in daylight time). An analysis, not a measurement.${esc(analysisStatus())}`;
  return 'Past days: Open-Meteo model output stitched from recent runs, not measurements.';
}
function renderHome() {
  const view = $('view-home'), cols = columns(), rows = sortRows(homeRows(cols));
  const summary = summaryMode(), dayCols = summary ? [] : cols, layout = summary ? 'summary' : 'days';
  // Keep the sideways scroll only within the same layout; a new layout opens on today (3.5).
  // Until the user scrolls the table, every render re-aims at today (early renders can have a narrower table).
  const scroller = view.querySelector('.matrix-scroll'), manual = scroller?.dataset.layout === layout && scroller.dataset.manual === '1';
  const keepCol = manual ? firstVisibleDay(scroller) : null, keepX = scroller?.scrollLeft ?? 0, keepY = scroller?.dataset.layout === layout ? scroller.scrollTop : 0;
  const showBtn = (v, label) => `<button type="button" data-show="${v}" aria-pressed="${app.show === v}">${label}</button>`;
  const pastBtn = (v, label, tip) => `<button type="button" data-past="${v}" aria-pressed="${prefs.past === v}" title="${tip}">${label}</button>`;
  const tableBtn = (v, label) => `<button type="button" data-table="${v}" aria-pressed="${(v === 'summary') === summary}">${label}</button>`;
  const head = dayCols.map(c => {
    const day = fmt(c.date, {day: 'numeric'}), month = (c.date.endsWith('-01') || c === cols[0]) ? fmt(c.date, {month: 'short'}) + ' ' : '';
    return sortHeader(`d:${c.date}`, c.today ? 'Today' : fmt(c.date, {weekday: 'short'}), `day ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}`, month + day);
  }).join('');
  const favCount = rows.filter(r => prefs.favs.includes(r.loc.id)).length;
  const pastDown = pastSource() === 'measured' && src('snotel').error && !src('snotel').at ? `<div class="notice">SNOTEL could not be reached (${esc(src('snotel').error)}), so the past columns show dashes. Nothing is substituted.</div>` : '';
  const table = () => rows.length ? `${pastDown}<div class="matrix-scroll" data-layout="${layout}" tabindex="0" aria-label="Daily snowfall table, scrolls sideways">
      <table class="matrix ${summary ? 'summary' : ''}">
        <caption class="sr-only">Daily snowfall in ${imperial() ? 'inches' : 'centimeters'} by location. Past days are the ${PAST_NAMES[pastSource()]}. Select a column header to sort.</caption>
        <thead><tr>${sortHeader('name', 'Location', 'name-cell')}${head}${sortHeader('past10', 'Past', 'total first', '10 days')}${sortHeader('next5', 'Next', 'total', '5 days')}${sortHeader('next10', 'Next', 'total', '10 days')}${sortHeader('next15', 'Next', 'total', `${CONFIG.futureColumns} days`)}${sortHeader('quality', 'Quality', 'qual', 'next 5 d')}</tr>
        ${summary ? '' : `<tr class="band-row"><td class="name-cell"></td><td colspan="${CONFIG.pastDays}" class="band past" title="Past days: ${PAST_NAMES[pastSource()]}"><span class="band-text">${PAST_BAND[pastSource()]}</span></td><td colspan="${CONFIG.futureColumns}" class="band">Forecast (Open-Meteo blend)</td><td colspan="5" class="band total first">Totals, ${snowUnit()}</td></tr>
        ${stormRow(rows, cols)}`}</thead>
        <tbody>${rows.map((r, i) => matrixRow(r, dayCols, favCount && i === favCount - 1 && favCount < rows.length)).join('')}</tbody>
      </table>
    </div>` : `<div class="notice">No locations match. ${app.show === 'fav' && !prefs.favs.length ? 'Star a location in the table to add it to Favorites.' : 'Try a different filter.'} <button type="button" class="btn" data-action="show-all">Show all resorts</button></div>`;
  setHTML(view, `<div class="home-stack">
    <div class="win-grid">
      ${win('Skier of the Day', safe('Skier of the Day', () => skierHTML(app.lists.skiers)), {iconName: 'star'})}
      ${win('Alec’s Fun Fact of the Day', safe('Fun fact', () => factHTML(app.lists.facts)), {iconName: 'doc'})}
      ${win('Storm Watch', safe('Storm Watch', () => stormWatchHTML(stormFacts(cols))), {iconName: 'flake'})}
      ${win('Season Snowfall Leaders', safe('Season leaders', seasonHTML), {iconName: 'table'})}
    </div>
    ${win(summary ? 'Snowfall summary' : 'Snowfall, day by day', `<div class="toolbar">
      <div class="segmented" role="group" aria-label="Table layout">${tableBtn('summary', 'Summary')}${tableBtn('days', 'Day by day')}</div>
      <div class="segmented" role="group" aria-label="Locations to show">${showBtn('resort', 'Resorts')}${showBtn('bc', 'Backcountry')}${showBtn('all', 'All')}${showBtn('fav', `Favorites${prefs.favs.length ? ' ' + prefs.favs.length : ''}`)}</div>
      <span class="tool-group"><span class="label" id="pastLabel">Past:</span><span class="segmented" role="group" aria-labelledby="pastLabel">${pastBtn('measured', 'Station', 'SNOTEL station estimate')}${pastBtn('analysis', 'NOAA', 'NOAA snowfall analysis, 4 km grid')}${pastBtn('modeled', 'Modeled', 'Model output, not measured')}</span></span>
      <label class="search"><span class="sr-only">Filter by name or region</span>${icon('search', 'icon-sm')}<input type="search" id="homeSearch" name="q" placeholder="Filter locations…" autocomplete="off" value="${esc(app.query)}"></label>
      ${legend()}</div>${safe('The snowfall table', table)}
      <p class="note">${pastNote()} Today and later: Open-Meteo forecast for the listed coordinates (for resorts, near the base area; each resort page has mid and summit), calendar days in Colorado time. A dash means missing, never zero. Quality is an estimate from forecast temperatures. Favorites stay pinned to the top.</p>`, {iconName: 'table', cls: 'snow-win'})}
    ${win('Snowpack Power Rankings', safe('Snowpack rankings', powerHTML), {iconName: 'star', cls: 'power-win'})}
    ${app.guestbook ? safe('Guestbook', guestbookHTML) : ''}</div>`);
  const sc = view.querySelector('.matrix-scroll');
  if (sc) {
    if (manual) sc.dataset.manual = '1';
    if (keepCol !== null) alignDay(sc, keepCol);
    else if (manual) sc.scrollLeft = keepX; // scrolled past the day columns, to the totals
    else scrollToToday(sc);
    sc.scrollTop = keepY;
  }
}
/**
 * Opens the day-by-day table with two past days, then today, just right of the sticky name column. The scroll
 * always lands on a column edge: on wide screens, where that target is past the end, it backs off a column at a time.
 */
const dayHeads = sc => [...sc.querySelectorAll('thead tr:first-child th.day')];
function scrollToToday(sc) { const i = dayHeads(sc).findIndex(th => th.classList.contains('today')); if (i >= 0) alignDay(sc, Math.max(0, i - 2)); }
/** Index of the first day column not hidden under the sticky name column (re-renders keep the column, not a pixel offset that goes stale). */
function firstVisibleDay(sc) {
  const name = sc.querySelector('thead th.name-cell'), i = name ? dayHeads(sc).findIndex(th => th.getBoundingClientRect().right > name.getBoundingClientRect().right + 1) : -1;
  return i >= 0 ? i : null;
}
function alignDay(sc, i) {
  const days = dayHeads(sc), name = sc.querySelector('thead th.name-cell');
  if (!days.length || !name || sc.scrollWidth <= sc.clientWidth) return;
  const max = sc.scrollWidth - sc.clientWidth, base = sc.scrollLeft, edge = name.getBoundingClientRect().right;
  for (let j = Math.min(i, days.length - 1); j >= 0; j--) {
    const want = base + days[j].getBoundingClientRect().left - edge;
    if (want <= max + 0.5) { sc.scrollLeft = Math.max(0, want); return; }
  }
}

/* ============================== RESORT DEEP-DIVE ============================== */
async function loadDetail(loc, band) {
  const key = `${loc.id}:${band}`;
  if (!due(app.detail[key])) return;
  app.detail[key] = {...app.detail[key], loading: true};
  try { app.detail[key] = {data: normalizeForecast(await fetchJSON(forecastURL([loc], {hourly: DETAIL_HOURLY, band})), {variant: band}), at: Date.now()}; }
  catch (e) { app.detail[key] = {...app.detail[key], loading: false, error: e.message, at: Date.now(), failed: true}; }
  if (app.route.view === 'resort' && app.route.id === loc.id) renderResort();
}
async function loadModels(loc) {
  if (!due(app.models[loc.id])) return;
  app.models[loc.id] = {...app.models[loc.id], loading: true};
  try {
    const raw = await fetchJSON(forecastURL([loc], {models: MODELS.map(m => m.id), pastDays: 1}));
    app.models[loc.id] = {series: normalizeModels(raw, MODELS.map(m => m.id)), at: Date.now()};
  } catch (e) { app.models[loc.id] = {series: app.models[loc.id]?.series, error: e.message, at: Date.now(), failed: true}; } // a failed refresh keeps the last good series
  if (app.route.view === 'resort' && app.route.id === loc.id) renderResort();
}
function loadAvalanche(force = false) {
  return loadSource('bulletins', async () => {
    const data = await fetchJSON(CONFIG.avalanche);
    if (!Array.isArray(data?.features)) throw new Error('Bulletin has no geographic features');
    return data.features;
  }, v => { if (!Array.isArray(v)) throw new Error('Malformed bulletin'); app.bulletins = v; }, {force});
}

const PAST_SHORT = {measured: 'station est., SNOTEL', analysis: 'NOAA analysis', modeled: 'modeled past'};
function dailyBars(loc, d, cols) {
  const vals = cols.map(c => dailyFor(loc, d, [c])[c.date]), max = Math.max(imperial() ? 5.08 : 5, ...vals.filter(finite)), ps = pastSource();
  const pastKey = ps === 'modeled' ? '<span class="key-sw"></span>Modeled past' : `<span class="key-sw measured"></span>${ps === 'measured' ? 'Station estimate (SNOTEL)' : 'NOAA analysis'}`;
  return `<div class="chart-field"><div class="bars" role="img" aria-label="Daily snowfall bar chart; the day table below lists every value">${cols.map((c, i) => {
    const v = vals[i], m = c.past && ps !== 'modeled', tip = `${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${finite(v) ? snow(v) : 'no data'}${c.past ? ` (${PAST_SHORT[ps]})` : ''}`;
    const day = fmt(c.date, {weekday: 'narrow'});
    return `<div class="bar-col ${c.today ? 'today' : ''}" data-tip="${esc(tip)}"><span class="bar-val">${finite(v) && v >= 0.25 ? cellSnow(v) : ''}</span><span class="bar ${finite(v) ? (m ? 'measured' : '') : 'missing'}" style="--h:${finite(v) ? Math.max(0.01, v / max) : 0.06}"></span><span class="bar-day">${c.today ? `<span class="wide-only">Today</span><span class="narrow-only">${day}</span>` : day}</span><span class="bar-date">${fmt(c.date, {day: 'numeric'})}</span></div>`;
  }).join('')}</div></div><p class="note">${pastKey}<span class="key-sw"></span>Forecast. Today is outlined. In ${imperial() ? 'inches' : 'centimeters'}.</p>`;
}
function dayTable(loc, d, cols) {
  const an = analysisFor(loc);
  const rows = cols.map(c => {
    const [a, b] = dayBounds(c.date), h = d?.hours, v = dailyTotal(h, c.date), m = c.past ? measuredFor(loc, c.date) : null, nv = c.past ? an?.[c.date] : null;
    const est = !c.past && h && integrate(h, a, b).complete ? slrEstimate(h, a, b) : null;
    const quality = m?.quality ? `${qual(m.quality)} <span class="muted">${Math.round(m.ratio)}:1 measured</span>` : est?.ratio && est.liquidMm >= 0.5 ? `${qual(qualityLabel(est.ratio))} <span class="muted">${Math.round(est.ratio)}:1 est.</span>` : '';
    const station = c.past ? (m ? `<span data-tip="${esc(stationWhy(m))}">${snow(m.cm)}${m.method === 'water' ? '<sup>w</sup>' : ''}</span>` : '–') : '';
    return `<tr class="${c.past ? 'past' : ''} ${c.today ? 'today' : ''}"><th scope="row">${c.today ? 'Today' : esc(fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'}))}</th><td class="num ${heat(v)}">${finite(v) ? snow(v) : '–'}</td><td class="num">${est ? snow(est.snowCm) : ''}</td><td class="num">${station}</td><td class="num">${c.past ? (finite(nv) ? snow(nv) : '–') : ''}</td><td>${quality}</td><td class="num">${temp(sampleStat(h, a, b, 'temp'))} / ${temp(sampleStat(h, a, b, 'temp', 'min'))}</td><td class="num">${speed(sampleStat(h, a, b, 'gust'))}</td><td class="num">${elev(sampleStat(h, a, b, 'freezing', 'min'))}</td><td class="num">${rainFmt(integrate(h, a, b, 'rain').value)}</td></tr>`;
  }).join('');
  return `<div class="table-scroll" tabindex="0" aria-label="Daily details, scrolls sideways"><table class="data-table"><thead><tr><th scope="col">Day</th><th scope="col" class="num">Snow (model)</th><th scope="col" class="num">Snow (ratio est.)</th><th scope="col" class="num">Station est.<small>SNOTEL</small></th><th scope="col" class="num">NOAA analysis<small>4 km grid</small></th><th scope="col">Snow quality</th><th scope="col" class="num">High / low</th><th scope="col" class="num">Max gust</th><th scope="col" class="num">Lowest freezing level</th><th scope="col" class="num">Rain</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">"Station est." is the SNOTEL station estimate: the larger of the depth gain and ${SNOTEL_SNOW_RATIO} times the water gain (the water counts only on days with a high at or below ${SNOTEL_WATER_MAX_F}°F); <sup>w</sup> marks days where the water term won. "NOAA analysis" is the NOHRSC snowfall analysis at one 4 km cell${loc.sample ? ' on the ski area' : ' at this point'}, the 24 h from 5 AM (6 AM in daylight time); an analysis, not a measurement.${esc(analysisStatus())} Snow quality is the snow-to-water ratio: Blower 17:1 or more, Powder 13 to 17, Average 10 to 13, Heavy under 10. Past days use the ratio measured at the SNOTEL station (depth gain over water gain, shown on cold days when the depth rose at least 2 in). Forecast days are an <b>estimate</b> from a Kuchera-style rule using the warmest of the 2 m, 600 hPa and 500 hPa temperatures. "Snow (model)" uses Open-Meteo’s fixed 7:1 ratio, so light snow can read low. "Snow (ratio est.)" is the same forecast water at the estimated ratio: an estimate, not a better model, and it can run high in marginal or windy storms. Freezing level is the 0°C altitude, not the snow line.</p>`;
}
function hourlyStrip(d) {
  const start = Math.floor(Date.now() / HOUR) * HOUR, hrs = Array.from({length: 48}, (_, i) => start + (i + 1) * HOUR);
  const pts = hrs.map(t => ({t, h: d?.hours.find(x => x.t === t)}));
  const max = Math.max(imperial() ? 1.27 : 1, ...pts.map(p => p.h?.snow).filter(finite));
  return `<div class="chart-field"><div class="hourly" role="img" aria-label="Hourly snowfall for the next 48 hours">${pts.map(({t, h}) => {
    const v = h?.snow, tip = `${timeFmt(t, {weekday: 'short'})}: ${finite(v) ? snow(v) : 'no data'}, ${temp(h?.temp)}, gusts ${speed(h?.gust)}`;
    return `<span class="hour ${finite(v) ? '' : 'missing'}" data-tip="${esc(tip)}" style="--h:${finite(v) ? Math.max(0.02, v / max) : 0.08}"></span>`;
  }).join('')}</div><div class="hour-axis">${[0, 12, 24, 36, 47].map(i => `<span>${esc(timeFmt(hrs[i], {weekday: 'short', minute: undefined}))}</span>`).join('')}</div></div>`;
}

/* ---- Model scoreboard (from data/model-ranking.json) and comparison ---- */
const leadRows = lead => Array.isArray(app.ranking?.leads?.[lead]) ? app.ranking.leads[lead] : [];
const topPick = lead => leadRows(lead).find(r => r.rank === 1) || null;
/** Models statistically tied with the leader at a lead time (their 90% ranges overlap). */
const topTier = lead => leadRows(lead).filter(r => r.tiedWithBest).map(r => r.name);
function scoreboardHTML() {
  const r = app.ranking;
  if (!r) return notBuilt('ranking') ? '<p class="muted">The model scoreboard appears once the scheduled data job has run.</p>'
    : src('ranking').error ? `<div class="notice">The model ranking file could not load (${esc(src('ranking').error)}).</div>` : '<p class="muted">Loading the model scoreboard…</p>';
  const rows = leadRows(app.rankLead), best = Math.max(...rows.map(x => x.ets || 0)), p1 = topPick('day1'), p3 = topPick('day3');
  const leadBtn = (v, l) => `<button type="button" data-lead="${v}" aria-pressed="${app.rankLead === v}">${l}</button>`;
  const pct = v => finite(v) ? `${Math.round(v * 100)}%` : '\u2013';
  const tier = lead => topTier(lead).filter(n => n !== topPick(lead)?.name);
  const hrrr = (r.leads.day1 || []).find(x => x.id === 'ncep_hrrr_conus');
  return `${cachedNotice('ranking', 'The model ranking file')}<dl class="picks">
    <div><dt>Next few hours</dt><dd>HRRR</dd><span class="muted">Best for timing and where bands set up. It runs dry at high elevation, so read its totals as a floor.</span></div>
    <div><dt>1 to 2 days out, trust</dt><dd>${esc(p1?.name || '\u2013')}</dd><span class="muted">${tier('day1').length ? `Statistically tied: ${esc(tier('day1').join(', '))}.` : ''}${hrrr?.rank ? ` HRRR placed #${hrrr.rank}.` : ''}</span></div>
    <div><dt>3 to 7 days out, trust</dt><dd>${esc(p3?.name || '\u2013')}</dd><span class="muted">${tier('day3').length ? `Statistically tied: ${esc(tier('day3').join(', '))}.` : ''} Past a week, trends only.</span></div></dl>
  <div class="toolbar"><div class="segmented" role="group" aria-label="Forecast lead time">${leadBtn('day1', '1 day ahead')}${leadBtn('day3', '3 days ahead')}</div></div>
  <div class="table-scroll" tabindex="0" aria-label="Model scoreboard, scrolls sideways"><table class="data-table"><thead><tr><th scope="col">Rank</th><th scope="col">Model</th><th scope="col">Storm score</th><th scope="col" class="num">Storms caught</th><th scope="col" class="num">False alarms</th><th scope="col" class="num">Typical miss on wet days</th><th scope="col" class="num">Total vs measured</th></tr></thead>
  <tbody>${rows.map(x => `<tr><td>${x.rank ?? '\u2013'}</td><th scope="row">${esc(x.name)}${x.tiedWithBest && x.rank > 1 ? ' <em class="pick">TIED #1</em>' : ''}${x.rank ? '' : ' <span class="muted">(not enough history)</span>'}</th><td>${finite(x.ets) ? `${Math.round(x.ets * 100)} <span class="score-bar" style="width:${Math.max(2, x.ets / best * 80)}px"></span>${x.etsRange ? ` <span class="muted">${Math.round(x.etsRange[0] * 100)}\u2013${Math.round(x.etsRange[1] * 100)}</span>` : ''}` : '\u2013'}</td><td class="num">${pct(x.caught)}</td><td class="num">${pct(x.falseAlarms)}</td><td class="num">${water(x.maeWetMm)}</td><td class="num">${finite(x.biasPct) ? `${x.biasPct > 0 ? '+' : ''}${x.biasPct}%` : '\u2013'}</td></tr>`).join('')}</tbody></table></div>
  <p class="note">Scored by this site from real measurements: each model\u2019s ${app.rankLead === 'day1' ? '1-day' : '3-day'} forecasts of daily precipitation (water) at the ${finite(r.stations) ? `${r.stations} ` : ''}SNOTEL stations this site uses, ${r.windows.map(w => `${esc(fmt(w.start, {month: 'short', year: 'numeric'}))} to ${esc(fmt(w.end, {month: 'short', year: 'numeric'}))}`).join(' and ')}, against each station\u2019s gauge. Storm score is the equitable threat score for days with at least 5 mm of water (about 2 to 3 in of snow), times 100; the small numbers are its 90% range from resampling, and "TIED #1" means that range overlaps the leader\u2019s. HRRR is the common pick for the next few hours, and published studies agree that 3 km models beat coarse ones over narrow ranges, but they also find HRRR under-forecasts high-elevation Colorado and Utah precipitation by roughly 25 to 65% (Gowan et al. 2018; Bytheway et al. 2024; Pletcher et al. 2024). Its first hours cannot be scored fairly with this archive, so the "next few hours" pick is guidance, not a score. Gauges undercatch snow, which affects every model equally. Rebuilt weekly; last built ${esc(timeFmt(Date.parse(r.generatedAt), {month: 'short', day: 'numeric'}))}.</p>`;
}
/** Sharpest grid first; ties keep the scoreboard order. */
function modelOrder() {
  const ranks = Object.fromEntries((app.ranking?.leads?.day1 || []).map(r => [r.id, r.rank ?? 99]));
  return [...MODELS].sort((a, b) => a.km - b.km || (ranks[a.id] ?? 99) - (ranks[b.id] ?? 99));
}
function modelTable(loc) {
  const m = app.models[loc.id];
  if (!m?.series && (!m || m.loading)) return '<div class="skeleton" style="height:320px" aria-label="Loading model comparison"></div>';
  if (!m.series) return `<div class="notice">Model comparison could not load: ${esc(m.error)}. No values are substituted.</div>`;
  const failed = m.error ? `<div class="notice">The latest refresh failed (${esc(m.error)}). Showing the models retrieved ${esc(timeFmt(m.at, {month: 'short', day: 'numeric'}))}.</div>` : '';
  const now = Date.now(), days = Array.from({length: 10}, (_, i) => shiftDate(localDate(), i)), wins = [['24 h', 24], ['72 h', 72], ['7 days', 168], ['10 days', 240]];
  const p1 = topPick('day1')?.id, p3 = topPick('day3')?.id;
  const blend = app.data[loc.id] ? {id: 'best_match', name: 'Blend', about: 'Open-Meteo best match; used on the homepage.', hours: app.data[loc.id].hours} : null;
  const all = [...(blend ? [blend] : []), ...modelOrder().map(def => ({...def, hours: m.series?.[def.id] || null}))];
  const vals = r => ({days: days.map(dt => r.hours ? dailyTotal(r.hours, dt) : null), wins: wins.map(([, h]) => r.hours ? integrate(r.hours, now, now + h * HOUR).value : null)});
  const table = all.map(r => ({r, v: vals(r)}));
  const cell = (v, first = false) => `<td class="num${first ? ' first' : ''} ${finite(v) ? heat(v) : ''}">${finite(v) ? cellSnow(v) || '0' : '<span class="muted" title="Beyond this model’s range or missing">–</span>'}</td>`;
  const body = table.map(({r, v}) => {
    const hz = r.hours ? horizon(r.hours) : null;
    const badges = `${r.id === p1 ? '<em class="pick">BEST 1-DAY</em>' : ''}${r.id === p3 ? '<em class="pick">BEST 3-DAY</em>' : ''}`;
    return `<tr class="${r.id === 'best_match' ? 'blend' : ''}" data-model="${r.id}"><th scope="row"><span class="model-name">${esc(r.name)}${badges}</span><span class="model-sub">${r.km ? `${r.km} km grid. ` : ''}${esc(r.about || '')}</span><span class="model-hz">${hz ? `Data to ${esc(timeFmt(hz, {weekday: 'short', month: 'short', day: 'numeric', minute: undefined}))}.` : r.id === 'best_match' ? '' : 'No data here.'}</span></th>${v.days.map(x => cell(x)).join('')}${v.wins.map((x, i) => cell(x, i === 0)).join('')}</tr>`;
  }).join('');
  const modelsOnly = table.filter(x => x.r.id !== 'best_match');
  const valueAt = (x, i) => i < days.length ? x.v.days[i] : x.v.wins[i - days.length];
  const stats = Array.from({length: days.length + wins.length}, (_, i) => ({i, ...spreadStats(modelsOnly.map(x => valueAt(x, i)))}));
  const sRow = (label, f) => `<tr><th scope="row">${label}</th>${stats.map(s => `<td class="num${s.i === days.length ? ' first' : ''}">${f(s)}</td>`).join('')}</tr>`;
  return `${failed}<div class="table-scroll" tabindex="0" aria-label="Model comparison, scrolls sideways"><table class="data-table models">
    <thead><tr><th scope="col">Model (sharpest grid first)</th>${days.map((dt, i) => `<th scope="col" class="num">${i === 0 ? 'Today' : esc(fmt(dt, {weekday: 'short'}))}<small>${esc(fmt(dt, {day: 'numeric'}))}</small></th>`).join('')}${wins.map(([l], i) => `<th scope="col" class="num${i === 0 ? ' first' : ''}">Next<small>${l}</small></th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot>${sRow('Range (min to max)', s => s.n >= 2 ? `${cellSnow(s.min) || '0'}–${cellSnow(s.max) || '0'}` : '–')}${sRow('Median', s => finite(s.median) ? cellSnow(s.median) || '0' : '–')}${sRow('Models reporting', s => s.n || '–')}${sRow(`Models ≥ ${oneInch()}`, s => s.n ? `${modelsOnly.filter(x => valueAt(x, s.i) >= 2.54).length} of ${s.n}` : '–')}${sRow('Spread', s => `<span class="spread ${s.label.toLowerCase().replace(/\s+/g, '-')}">${s.label}</span>`)}</tfoot>
  </table></div>
  <p class="note">Calendar-day totals in Colorado time; rolling windows start now. A dash means the model does not reach that far, never zero. <b>Spread is disagreement between models, not a probability.</b> "Models ≥ ${oneInch()}" is a count of models, not a chance of snow. The blend row is for reference and is not part of the spread. NBM’s snowfall uses variable snow ratios while most others use a fixed 7:1, so NBM often reads higher for the same water. Retrieved ${esc(timeFmt(m.at))}.</p>`;
}
let chartState = null; // geometry of the last drawn model chart, for the crosshair readout
function modelChart(loc, width) {
  const m = app.models[loc.id];
  if (!m?.series) return '';
  const now = Math.floor(Date.now() / HOUR) * HOUR, span = 240, W = Math.max(320, width), H = W < 560 ? 220 : 280;
  const pad = {l: 40, r: 12, t: 12, b: 34}, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, p1 = topPick('day1')?.id;
  const rows = [...MODELS.map(def => ({...def, hours: m.series[def.id]})), ...(app.data[loc.id] ? [{id: 'best_match', name: 'Blend', hours: app.data[loc.id].hours}] : [])];
  const series = rows.filter(r => r.hours).map(r => {
    const byT = new Map(r.hours.map(h => [h.t, h.snow]));
    let acc = 0; const pts = [];
    for (let i = 1; i <= span; i++) { const v = byT.get(now + i * HOUR); if (!finite(v)) break; acc += v; pts.push(acc); }
    return {...r, pts};
  }).filter(s => s.pts.length);
  const top = Math.max(imperial() ? 2.54 : 2, ...series.map(s => s.pts.at(-1))) * 1.08;
  const x = i => pad.l + (i / span) * iw, y = v => pad.t + ih - (v / top) * ih;
  const path = s => `M${x(0)},${y(0)}` + s.pts.map((v, i) => `L${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const step = imperial() ? (top / 2.54 > 12 ? 5 : top / 2.54 > 4 ? 2 : 1) * 2.54 : (top > 30 ? 10 : top > 10 ? 5 : 2);
  const grid = []; for (let v = 0; v <= top; v += step) grid.push(v);
  const dayTicks = Array.from({length: 11}, (_, i) => zonedEpoch(shiftDate(localDate(), i))).filter(t => t > now && t <= now + span * HOUR);
  chartState = {series: series.map(s => ({name: s.name, pts: s.pts})), now, span, x0: pad.l, iw, W};
  const cls = s => s.id === 'best_match' ? 'line blend' : s.id === p1 ? 'line pick' : 'line';
  return `<figure class="chart-figure chart-field"><svg class="model-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative snowfall by model for the next 10 days. The table below lists the values.">
    ${grid.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${imperial() ? Math.round(v / 2.54) : Math.round(v)}</text>`).join('')}
    ${dayTicks.map(t => { const i = (t - now) / HOUR, day = new Date(t + HOUR); return `<line class="tick" x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="axis" x="${x(i) + 3}" y="${H - 18}">${esc(new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short'}).format(day))}</text><text class="axis" x="${x(i) + 3}" y="${H - 5}">${esc(new Intl.DateTimeFormat('en-US', {timeZone: TZ, day: 'numeric'}).format(day))}</text>`; }).join('')}
    ${[...series].sort((a, b) => (a.id === 'best_match' || a.id === p1) - (b.id === 'best_match' || b.id === p1)).map(s => `<path class="${cls(s)}" data-model="${s.id}" d="${path(s)}"/>`).join('')}
    <line class="crosshair" id="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>
  </svg><figcaption><span class="key"><i class="key-line"></i>Each model</span><span class="key"><i class="key-line blend"></i>Blend (homepage)</span>${p1 ? `<span class="key"><i class="key-line pick"></i>Best 1-day scorer</span>` : ''}<span>Cumulative ${snowUnit()} from now. Hover or tap the chart for values; hover or tap a table row to highlight its line.</span></figcaption></figure>`;
}
function chartReadout(evt) {
  const c = chartState, svg = evt.target.closest('svg');
  if (!c || !svg) return;
  const r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * (c.W / r.width), i = Math.round(((px - c.x0) / c.iw) * c.span);
  if (i < 1 || i > c.span) return hideTip();
  const line = svg.querySelector('#crosshair'), xp = c.x0 + (i / c.span) * c.iw;
  line.setAttribute('x1', xp); line.setAttribute('x2', xp); line.setAttribute('visibility', 'visible');
  const vals = c.series.map(s => ({n: s.name, v: s.pts[i - 1]})).filter(s => finite(s.v)).sort((a, b) => b.v - a.v);
  showTip(evt.clientX, evt.clientY, `<strong>${esc(timeFmt(c.now + i * HOUR, {weekday: 'short', month: 'short', day: 'numeric'}))}</strong>${vals.map(s => `<span class="tip-row"><span>${esc(s.n)}</span><span>${snow(s.v)}</span></span>`).join('')}`, true);
}

/* ---- Station and avalanche panels ---- */
function stationHTML(loc) {
  const data = app.snotel[loc.snotel], meta = app.snotelMeta[loc.snotel], s = src('snotel');
  if (!data && !s.error) return '<div class="skeleton" style="height:140px" aria-label="Loading station data"></div>';
  const depth = data?.SNWD?.filter(x => x.value !== null).at(-1), swe = data?.WTEQ?.filter(x => x.value !== null).at(-1);
  const pct = finite(swe?.median) && swe.median > 0 && finite(swe?.value) ? Math.round(swe.value / swe.median * 100) : null;
  const old = [depth?.date, swe?.date].some(dt => dt && dt < shiftDate(localDate(), -2)), shared = LOCS.filter(l => l.snotel === loc.snotel).length;
  const sp = snowpackFor(loc), season = app.season[loc.snotel];
  return `${s.error && !data ? `<div class="notice">Station request failed: ${esc(s.error)}. No measurement is inferred.</div>` : cachedNotice('snotel', 'NRCS')}
  <p class="panel-sub">${esc(meta?.name || 'Station')} SNOTEL · ${esc(loc.snotel)}${finite(meta?.elevationFt) ? ' · ' + ft(meta.elevationFt) : ''}${old ? ' <span class="pill warn">Old observation</span>' : ''}</p>
  <dl class="facts"><div><dt>Snow depth (measured)</dt><dd>${depth ? snow(depth.value * 2.54) : 'No data'}</dd></div><div><dt>Snow water equivalent</dt><dd>${swe ? snow(swe.value * 2.54) : 'No data'}</dd></div><div><dt>Water vs 30-year median</dt><dd>${pct === null ? 'No data' : pct + '%'}</dd></div><div><dt>Reading for</dt><dd>${esc(depth?.date || swe?.date || 'No data')}</dd></div><div><dt>Percentile for the date</dt><dd>${finite(sp?.pct) ? ordinal(Math.round(sp.pct)) : sp?.none ? 'No snowpack yet' : 'No data'}</dd></div><div><dt>Season snow since ${esc(fmt(waterYearStart(localDate()), {month: 'short', day: 'numeric'}))}, station est.</dt><dd>${finite(season?.cm) ? seasonText(season) : 'No data'}</dd></div></dl>
  <p class="note">A SNOTEL station is near, not at, this location${shared > 1 ? `, and ${shared} locations here share it` : ''}. ${external(`https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${encodeURIComponent(loc.snotel.split(':')[0])}`, 'Open NRCS station')}</p>`;
}
function avalancheHTML(loc) {
  const caveat = '<p class="note">Current bulletin for the surrounding backcountry, not a route assessment or a forecast for later days. Read the full CAIC forecast.</p>';
  const s = src('bulletins');
  if (!app.bulletins && !s.error) return '<div class="skeleton" style="height:140px" aria-label="Loading avalanche bulletin"></div>';
  const matches = (app.bulletins || []).filter(f => containsPoint(f, [loc.lon, loc.lat]));
  if (matches.length !== 1) return `<p><span class="pill warn">${matches.length > 1 ? 'Boundary overlap' : 'Bulletin unavailable'}</span></p><p>${matches.length > 1 ? 'Several bulletin areas overlap this point, so no single rating is shown.' : s.error ? `The bulletin feed could not be loaded (${esc(s.error)}). Missing does not mean low danger.` : 'No CAIC zone matched this point. No rating is inferred.'}</p>${caveat}${external('https://avalanche.state.co.us/', 'Full CAIC forecast')}`;
  const p = matches[0].properties, {start, end, valid, level} = bulletinWindow(p), named = level > 0;
  const label = named ? `${['', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'][level]} (${level} of 5)` : valid ? 'No rating published' : 'Expired or unverified';
  return `${cachedNotice('bulletins', 'The CAIC feed')}<p class="panel-sub">${esc(p.name || 'CAIC zone')}</p><p><span class="danger d${level}">${esc(label)}</span></p>
  <dl class="facts"><div><dt>Issued</dt><dd>${esc(timeFmt(start, {month: 'short', day: 'numeric'}))}</dd></div><div><dt>Expires</dt><dd>${esc(timeFmt(end, {month: 'short', day: 'numeric'}))}</dd></div></dl>
  ${valid && p.travel_advice ? `<p>${esc(p.travel_advice)}</p>` : ''}${p.warning?.product && valid ? '<p class="warn-text"><b>An avalanche warning is in effect. Read the official product.</b></p>' : ''}${caveat}${external(p.link || 'https://avalanche.state.co.us/', 'This zone on CAIC')}`;
}

/** Nearest human-read snow board (NWS COOP or CoCoRaHS), from boards.json built by the data job. */
function boardHTML(loc) {
  const b = app.boards, s = src('boards');
  if (!b) return notBuilt('boards') ? '<p class="muted">Nearby snow-board reports appear once the scheduled data job has run.</p>'
    : s.error ? `<div class="notice">Snow-board reports could not load (${esc(s.error)}).</div>` : '<div class="skeleton" style="height:90px" aria-label="Loading snow-board reports"></div>';
  const x = b.locations?.[loc.id];
  if (!x) return `<p class="muted">No observer snow board within ${b.maxMiles} mi and ${b.maxElevDiffFt.toLocaleString('en-US')} ft of this ${loc.kind === 'bc' ? 'pass' : 'resort’s base'} reports regularly. The station estimate and NOAA analysis above still apply.</p>`;
  const st = x.station, ref = loc.kind === 'resort' ? 'the base' : 'the pass', diff = st.elevDiffFt;
  const value = r => r.accumulated ? 'Multi-day total' : r.trace ? 'Trace' : finite(r.snowIn) ? snow(r.snowIn * 2.54) : '–';
  const rows = x.reports.map(r => `<tr><th scope="row">${esc(fmt(r.date, {weekday: 'short', month: 'short', day: 'numeric'}))}</th><td class="num">${value(r)}</td><td class="num">${finite(r.depthIn) ? snow(r.depthIn * 2.54) : '–'}</td></tr>`).join('');
  const licence = st.network === 'CoCoRaHS' ? `CoCoRaHS data, ${external('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}` : 'NWS Cooperative Observer data';
  return `${cachedNotice('boards', 'The snow-board file')}<p class="panel-sub">${external(st.url, esc(st.name))} (${esc(st.network)}) · ${ft(st.elevFt)} · ${st.miles} mi away · ${Math.abs(diff).toLocaleString('en-US')} ft ${diff >= 0 ? 'above' : 'below'} ${ref}</p>
  <div class="table-scroll" tabindex="0" aria-label="Snow-board reports"><table class="data-table"><thead><tr><th scope="col">Report for the morning of</th><th scope="col" class="num">New snow</th><th scope="col" class="num">Snow depth</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">A person measures new snow on a board, usually once each morning; each report covers about the 24 hours before it. A dash means no report yet, never zero. The board is near ${ref} elevation, not on the slopes. ${licence}, via RCC-ACIS, preliminary. Built ${esc(ago(Date.parse(b.generatedAt)))}.</p>`;
}

function renderResort() {
  const loc = byId[app.route.id], view = $('view-resort');
  if (!loc) { $('winTitle').textContent = "Location not found - ALEC'S SNOW PAGE"; setHTML(view, win('Error', `<p>Location not found. <a href="#/">Back to all locations</a></p>`)); return; }
  const band = loc.base && ['base', 'mid', 'summit'].includes(app.route.band) ? app.route.band : 'point';
  const det = app.detail[`${loc.id}:${band}`], d = det?.data || (band === 'point' ? app.data[loc.id] : null), cols = columns(), t = totals(loc, d, cols);
  const fav = prefs.favs.includes(loc.id), q5 = forecastQuality(d, localDate(), 5), depth = app.snotel[loc.snotel]?.SNWD?.filter(x => x.value !== null).at(-1);
  const bands = loc.base ? [['point', 'Grid point'], ['base', `Base ${ft(loc.base)}`], ['mid', 'Mid'], ['summit', `Summit ${ft(loc.top)}`]] : [];
  const keepY = window.scrollY, width = Math.min(1100, (view.querySelector('.chart-slot')?.clientWidth || Math.min(window.innerWidth - 60, 1100)) - 12);
  $('winTitle').textContent = `${loc.name} - ALEC'S SNOW PAGE`;
  view.setAttribute('aria-labelledby', 'resortTitle');
  setHTML(view, `
  <a class="back" href="#/">${icon('back', 'icon-sm')}All locations</a>
  <div class="resort-head">
    <div><h2 id="resortTitle">${esc(loc.name)}</h2>
    <p class="meta">${esc(loc.region)} Colorado · ${loc.kind === 'bc' ? 'Backcountry pass (weather only, not a safety rating)' : 'Resort'}${loc.base ? ` · ${ft(loc.base)} to ${ft(loc.top)}` : ` · ${ft(loc.elev)}`}${d ? ` · forecast grid ${elev(d.elevation)}` : ''}</p></div>
    <div class="actions"><button type="button" class="btn ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}">${icon('star', 'icon-sm')}${fav ? 'Favorite' : 'Add favorite'}</button>${loc.webcam ? `<a class="btn" href="${esc(loc.webcam)}" target="_blank" rel="noopener noreferrer">${icon('cam', 'icon-sm')}Webcams</a>` : ''}<button type="button" class="btn" data-action="share">${icon('link', 'icon-sm')}Copy link</button><a class="btn" href="#/map?focus=${loc.id}">${icon('map', 'icon-sm')}On 3D map</a>${loc.url ? external(loc.url, 'Official site', 'btn') : ''}</div>
  </div>
  <dl class="kpis"><div><dt>Past 10 days</dt><dd>${finite(t.past10) ? snow(t.past10) : '–'}</dd><span>${PAST_SHORT[pastSource()]}</span></div><div><dt>Next 5 days</dt><dd>${finite(t.next5) ? snow(t.next5) : '–'}</dd><span>today + 4, forecast</span></div><div><dt>Next 10 days</dt><dd>${finite(t.next10) ? snow(t.next10) : '–'}</dd><span>today + 9, forecast</span></div><div><dt>Next ${CONFIG.futureColumns} days</dt><dd>${finite(t.next15) ? snow(t.next15) : '–'}</dd><span>today + 14, forecast</span></div><div><dt>Snow quality next 5 days</dt><dd>${q5 ? qual(q5.label) : '–'}</dd><span>${q5 ? `about ${Math.round(q5.ratio)}:1, estimate` : 'not enough snow to estimate'}${depth ? ` · depth now ${snow(depth.value * 2.54)}` : ''}</span></div></dl>
  ${bands.length ? `<div class="band-switch"><div class="segmented" role="group" aria-label="Forecast elevation">${bands.map(([v, l]) => `<button type="button" data-band="${v}" aria-pressed="${band === v}">${l}</button>`).join('')}</div><p class="note">Base, mid and summit re-run the same coordinates at that elevation (Open-Meteo lapse-rate adjustment). They are not separate stations. The model comparison always uses the grid point.</p></div>` : ''}
  ${win('Daily snowfall', safe('Daily snowfall', () => d ? dailyBars(loc, d, cols) : det?.error || app.errors[loc.id] ? `<div class="notice">The forecast could not load (${esc(det?.error || app.errors[loc.id])}). Nothing is substituted.</div>` : '<div class="skeleton" style="height:180px"></div>'), {iconName: 'table'})}
  ${win('Next 48 hours', safe('Next 48 hours', () => `<p class="panel-sub">Hourly snowfall; hover or tap a bar for temperature and gusts.</p>${det?.data ? hourlyStrip(det.data) : det?.error ? `<div class="notice">Hourly details could not load: ${esc(det.error)}.</div>` : '<div class="skeleton" style="height:110px"></div>'}`))}
  ${win('Which model to trust', safe('The model scoreboard', scoreboardHTML), {iconName: 'star'})}
  ${win('Model comparison', safe('The model comparison', () => `<p class="panel-sub">${MODELS.length} models at the grid point, sharpest grid first. When they agree, confidence is higher; when they scatter, treat any single number loosely.</p><div class="chart-slot">${modelChart(loc, width)}</div>${modelTable(loc)}`), {iconName: 'table'})}
  ${win('Day by day', safe('The day table', () => `<p class="panel-sub">${band === 'point' ? 'Grid point' : `${bands.find(b => b[0] === band)[1]} scenario`}.</p>${det?.data ? dayTable(loc, det.data, cols) : det?.error ? `<div class="notice">Details could not load: ${esc(det.error)}.</div>` : '<div class="skeleton" style="height:420px"></div>'}`), {iconName: 'doc'})}
  <div class="two-up">${win('Observed snowpack', safe('The station panel', () => stationHTML(loc)))}${win('Avalanche bulletin', safe('The avalanche panel', () => avalancheHTML(loc)))}</div>
  ${win('Nearest snow board', safe('The snow-board panel', () => boardHTML(loc)), {iconName: 'doc'})}
  <p class="note">Coordinates ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}; Open-Meteo returned grid ${d?.lat?.toFixed(3) ?? '–'}, ${d?.lon?.toFixed(3) ?? '–'}.${loc.sample ? ` NOAA analysis sampled at ${loc.sample[0].toFixed(4)}, ${loc.sample[1].toFixed(4)}, the center of the ski area’s outline in OpenStreetMap.` : ''} Resort-reported snowfall and lift status live on the ${loc.url ? external(loc.url, 'official site') : 'operator’s site'}.</p>`);
  if (app.route.rendered === loc.id + band) window.scrollTo(0, keepY);
  app.route.rendered = loc.id + band;
  loadDetail(loc, band); loadModels(loc); loadAvalanche();
}

/* ============================== MAP ============================== */
let mapModule = null, mapState = 'none', snowTimer = null, radarTimer = null;
function mountMapView() {
  mapState = 'mounting';
  import('./map.js').then(mod => { mapModule = mod; return mod.mountMap($('mapCanvas'), $('snowCanvas'), mapOptions()); })
    .then(() => { mapState = 'ok'; $('mapFallback').hidden = true; })
    .catch(e => { mapState = /timed out/.test(e.message) ? 'timed-out' : 'failed'; const f = $('mapFallback'); f.hidden = false; f.textContent = `The 3D map could not start (${e.message}). The ranked list still works.`; });
}
/**
 * Snow timeline. Left of "Now": observed totals from a past day up to now (NOHRSC field; columns from
 * SNOTEL or the modeled past). Right of "Now": forecast totals up to a future time (NBM field, hourly
 * for 2 days then 6-hourly to day 11; columns from Open-Meteo out to day 15).
 */
function snowFrames() {
  const m = app.hires, now = Date.now(), today = localDate(), out = [];
  const past = m?.past?.frames?.length ? [...m.past.frames].reverse().map(f => ({from: Date.parse(f.from), to: Date.parse(f.to), file: f.file}))
    : Array.from({length: CONFIG.pastDays}, (_, i) => ({from: zonedEpoch(shiftDate(today, -(CONFIG.pastDays - i))), to: zonedEpoch(today), file: null}));
  for (const f of past) out.push({kind: 'past', ...f});
  out.push({kind: 'now', from: now, to: now, file: null});
  const start = m?.snow?.accumulatedFrom ? Date.parse(m.snow.accumulatedFrom) : now;
  for (const f of m?.snow?.frames || []) { const t = Date.parse(f.t); if (t > now) out.push({kind: 'future', from: start, to: t, file: f.file}); }
  const last = out.at(-1).to;
  for (let d = 1; d <= CONFIG.futureColumns; d++) { const t = zonedEpoch(shiftDate(today, d)); if (t > last + 3 * HOUR) out.push({kind: 'future', from: start, to: t, file: null}); }
  return out;
}
/** Radar timeline: 3 hours of observed radar every 10 minutes, then hourly HRRR simulated radar. */
function radarFrames() {
  const step = 10 * 60000, end = Math.floor((Date.now() - 10 * 60000) / step) * step, frames = [];
  for (let t = end - 17 * step; t <= end; t += step) frames.push({t, kind: 'radar'});
  for (const f of app.hires?.radar?.frames || []) { const t = Date.parse(f.t); if (t > end) frames.push({t, kind: 'model', file: f.file}); }
  return frames;
}
const nowIndex = frames => frames.findIndex(f => f.kind === 'now');
// Selected positions are indexes; frame lists are rebuilt on every render, so compare by index, never by object.
/** Opens on "now to the end of day 5", matching the homepage's Next 5 days. */
const defaultSnowIdx = fr => { const end = zonedEpoch(shiftDate(localDate(), 5)), i = fr.findIndex(f => f.kind === 'future' && f.to >= end); return i < 0 ? fr.length - 1 : i; };
const snowIdx = (fr = snowFrames()) => Math.min(app.map.snowIndex ?? defaultSnowIdx(fr), fr.length - 1);
const radarIdx = (fr = radarFrames()) => Math.min(app.map.radarIndex ?? fr.findLastIndex(f => f.kind === 'radar'), fr.length - 1);
const snowFrame = () => { const fr = snowFrames(); return fr[snowIdx(fr)]; };
const radarFrame = () => { const fr = radarFrames(); return fr[radarIdx(fr)]; };
/** Number of whole days in a past frame; the station columns sum that many calendar days through yesterday. */
const frameDays = f => Math.max(1, Math.round((f.to - f.from) / (24 * HOUR)));
/** Column value for a location over the selected snow window, from the chosen past source for past frames. */
function mapValue(loc, f) {
  const d = app.data[loc.id];
  if (f.kind === 'now') return 0;
  if (f.kind === 'past' && pastSource() === 'measured') return sumComplete(Array.from({length: frameDays(f)}, (_, i) => measuredFor(loc, shiftDate(localDate(), -(i + 1)))?.cm ?? null));
  if (f.kind === 'past' && pastSource() === 'analysis') {
    // The same NOHRSC 24 h windows the field shows, so columns and field cover exactly the same hours.
    const days = (app.hires?.past?.points?.[loc.id]?.days || []).filter(x => Date.parse(x.from) >= f.from && Date.parse(x.to) <= f.to);
    return days.length === frameDays(f) ? sumComplete(days.map(x => finite(x.inches) ? x.inches * 2.54 : null)) : null;
  }
  return d ? integrate(d.hours, f.from, f.to).value : null;
}
const when = ms => timeFmt(ms, {weekday: 'short', month: 'short', day: 'numeric', minute: undefined});
/** The window label states the real hours of the field and of the columns, which differ for the station estimate. */
function snowLabel(f) {
  if (f.kind === 'now') return 'Now: drag left for past snow, right for forecast snow';
  if (f.kind === 'past') {
    const n = frameDays(f), first = shiftDate(localDate(), -n), last = shiftDate(localDate(), -1), day = dt => fmt(dt, {month: 'short', day: 'numeric'});
    const field = f.file ? `NOAA analysis ${when(f.from)} to ${when(f.to)}` : `No NOAA field; past ${n} day${n === 1 ? '' : 's'}, ${when(f.from)} to ${when(f.to)}`;
    const cols = pastSource() === 'measured' ? `columns: SNOTEL station estimate, ${day(first)}${n > 1 ? ` to ${day(last)}` : ''}, whole days`
      : pastSource() === 'analysis' ? (app.hires?.past?.points ? 'columns: the same analysis at each location' : 'columns: NOAA analysis unavailable')
      : `columns: modeled, ${when(f.from)} to ${when(f.to)}`;
    return `${field}; ${cols}`;
  }
  return `Forecast, ${when(f.from)} to ${when(f.to)}${f.file ? '' : app.hires?.snow?.frames?.length ? ' (columns only; the high-res field ends around day 11)' : ' (columns only; no high-res forecast field is available)'}`;
}
/** Statewide freezing level for a date from grid.json, by its own date list: an old grid never lends a value to the wrong day. */
function freezingFor(date) { const i = app.grid?.days?.indexOf(date) ?? -1; return i >= 0 ? app.grid.freezingLevelM?.[i] ?? null : null; }
function mapOptions() {
  const sf = snowFrame(), rf = radarFrame(), dayAhead = Math.max(0, Math.min(14, Math.round((sf.to - zonedEpoch(localDate())) / (24 * HOUR)) - 1));
  return {theme: effectiveTheme(), reduceMotion: reduceMotion.matches || !prefs.anim, unit: snowUnit(), windowLabel: snowLabel(sf),
    features: LOCS.map(loc => { const v = mapValue(loc, sf); return {loc, v, label: finite(v) ? snow(v) : 'No data'}; }),
    layers: app.map.layers, hires: app.hires ? {base: `${GEN_BASE}hires/`, bounds: app.hires.bounds} : null, snowFrame: sf, radarFrame: rf,
    freezingM: freezingFor(shiftDate(localDate(), sf.kind === 'future' ? dayAhead : 0)),
    snotel: TRIPLETS.map(t => ({triplet: t, ...app.snotelMeta[t], depthIn: app.snotel[t]?.SNWD?.filter(x => x.value !== null).at(-1)?.value ?? null})).filter(s => finite(s.lat)),
    bulletins: app.bulletins, focusId: app.route.focus, snowfx: prefs.anim && !reduceMotion.matches,
    onSelect: id => { location.hash = `#/resort/${id}`; }};
}
function mapLegend() {
  const steps = SNOW_RAMP.map(([v, c]) => [imperial() ? v : Math.round(v * 2.54 * 10) / 10, c]);
  return `<div class="legend ramp" aria-label="Snowfall colors in ${imperial() ? 'inches' : 'centimeters'}"><span class="legend-title">${imperial() ? 'in' : 'cm'}</span>${steps.map(([v, c]) => `<span class="swatch" style="background:${c}"></span><span>${v}</span>`).join('')}</div>`;
}
function renderMapSide() {
  const opts = mapOptions(), list = opts.features.sort((a, b) => (finite(b.v) ? b.v : -1) - (finite(a.v) ? a.v : -1)), max = Math.max(1, ...list.map(x => x.v).filter(finite));
  const el = $('mapList');
  if (el) setHTML(el, list.map(x => `<li><button type="button" data-focus="${x.loc.id}"><span class="ml-name">${esc(x.loc.name)}<small>${esc(x.loc.region)}${x.loc.kind === 'bc' ? ' · Pass' : ''}</small></span><span class="ml-val">${x.label}</span><span class="ml-bar"><i style="--w:${finite(x.v) ? x.v / max : 0}"></i></span></button></li>`).join(''));
  const set = (id, v) => { const n = $(id); if (n && n.textContent !== v) n.textContent = v; }; // some are live regions: write only on change
  const sf = snowFrames(), rf = radarFrames(), si = snowIdx(sf), ri = radarIdx(rf), r = opts.radarFrame;
  set('snowLabel', opts.windowLabel);
  set('radarLabel', r ? `${r.kind === 'radar' ? 'Radar, observed' : 'HRRR simulated radar, forecast'}: ${timeFmt(r.t, {weekday: 'short'})}` : '');
  const ss = $('snowSlider'); if (ss) { ss.max = String(sf.length - 1); ss.value = String(si); ss.style.setProperty('--now', `${nowIndex(sf) / (sf.length - 1) * 100}%`); }
  const rs = $('radarSlider'); if (rs) { rs.max = String(rf.length - 1); rs.value = String(ri); const n = rf.findLastIndex(f => f.kind === 'radar'); rs.style.setProperty('--now', `${n / Math.max(1, rf.length - 1) * 100}%`); }
  const nowPct = nowIndex(sf) / (sf.length - 1) * 100;
  const nowTick = $('snowNow'); if (nowTick) nowTick.style.left = `${nowPct}%`;
  set('snowStart', `-${nowIndex(sf)} d`);
  const startTick = $('snowStart');
  if (startTick && nowTick) { // hide "-10 d" only when it would actually touch "Now"
    startTick.style.visibility = '';
    startTick.style.visibility = startTick.getBoundingClientRect().right + 4 > nowTick.getBoundingClientRect().left ? 'hidden' : '';
  }
  const rNow = $('radarNow'); if (rNow) rNow.style.left = `${rf.findLastIndex(f => f.kind === 'radar') / Math.max(1, rf.length - 1) * 100}%`;
  set('snowEnd', sf.at(-1) ? `+${Math.round((sf.at(-1).to - Date.now()) / (24 * HOUR))} d` : '');
  set('radarEnd', rf.at(-1)?.kind === 'model' ? `+${Math.round((rf.at(-1).t - Date.now()) / HOUR)} h` : 'now');
  const radarRow = $('radarRow'); if (radarRow) radarRow.hidden = !app.map.layers.radar;
  const fl = opts.freezingM;
  set('freezingLabel', finite(fl) ? `Freezing level ${elev(fl)} (statewide model median for the selected day${src('grid').cached ? `; saved copy from ${ago(src('grid').at)}` : ''})` : 'Freezing level unavailable for the selected day');
  const h = app.hires;
  const hs = src('hires');
  set('fieldNote', h ? `Snow field: ${h.past?.frames?.length ? 'NOHRSC observed analysis (about 4 km)' : 'no observed field'} for the past, ${h.snow?.frames?.length ? `NBM 2.5 km forecast (run of ${when(Date.parse(h.snow.run))})` : 'no forecast field'}. Rebuilt ${ago(Date.parse(h.generatedAt))}${hs.cached ? ` (saved copy; the file could not be loaded: ${hs.error})` : ''}.`
    : notBuilt('hires') ? 'The high-resolution snow field appears once the scheduled data job has run.' : hs.error ? `The high-resolution snow field could not load (${hs.error}).` : 'Loading the high-resolution snow field…');
}
function renderMap() {
  const view = $('view-map');
  $('winTitle').textContent = '3D Map - ALEC\'S SNOW PAGE';
  if (!view.querySelector('#mapCanvas')) {
    const L = app.map.layers, box = (k, label) => `<label class="check"><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}>${label}</label>`;
    const radarLegend = RADAR_RAMP.filter((_, i) => i % 2 === 0).map(([v, c]) => `<i style="background:${c}"></i><span>${v}</span>`).join('');
    view.innerHTML = `<div class="map-layout">
      <div>${win('3D snowfall map', `<div class="map-stage"><div id="mapCanvas" class="map-canvas" role="region" aria-label="Interactive 3D map of Colorado snowfall. Drag to pan, right-drag or two fingers to tilt and rotate."></div><canvas class="snow-canvas" id="snowCanvas" aria-hidden="true"></canvas><div class="map-fallback" id="mapFallback" hidden></div>
        <div class="timebar">
          <div class="tb-row"><button type="button" class="icon-btn" id="playSnow" aria-label="Play snow timeline">${icon('play', 'icon-sm')}</button><span class="tb-name">Snow</span>
            <div class="tb-track"><label class="sr-only" for="snowSlider">Snow time window</label><input type="range" id="snowSlider" min="0" max="1" step="1" value="0"><div class="tb-ticks" aria-hidden="true"><span id="snowStart">-10 d</span><span class="tb-now" id="snowNow">Now</span><span id="snowEnd"></span></div></div></div>
          <p class="tb-label" id="snowLabel" aria-live="polite"></p>
          <div id="radarRow" ${L.radar ? '' : 'hidden'}>
            <div class="tb-row"><button type="button" class="icon-btn" id="playRadar" aria-label="Play radar">${icon('play', 'icon-sm')}</button><span class="tb-name">Radar</span>
              <div class="tb-track"><label class="sr-only" for="radarSlider">Radar time</label><input type="range" id="radarSlider" min="0" max="1" step="1" value="0"><div class="tb-ticks" aria-hidden="true"><span>-3 h</span><span class="tb-now" id="radarNow">Now</span><span id="radarEnd"></span></div></div></div>
            <p class="tb-label" id="radarLabel" aria-live="polite"></p>
          </div>
        </div></div>
        <p class="note">Drag to pan. Scroll or pinch to zoom. Right-drag, Ctrl-drag, or two-finger drag to tilt and rotate. Click a column for its forecast.</p>`, {iconName: 'map'})}</div>
      <div class="map-side">
        ${win('Controls', `
          <div class="ctl-group"><span class="glabel">Layers</span><div class="layer-list">
            ${box('field', 'Snow field')}${box('columns', '3D columns')}${box('trails', 'Ski trails')}${box('snowfx', 'Falling snow')}${box('avalanche', 'Avalanche danger')}${box('snotel', 'SNOTEL stations')}${box('freezing', 'Freezing level')}${box('radar', 'Radar timeline')}</div>
            <p class="note" id="freezingLabel"></p></div>
          <div class="ctl-row"><button type="button" class="btn" id="tourButton">${icon('plane', 'icon-sm')}Storm tour</button><button type="button" class="btn" id="resetView">${icon('compass', 'icon-sm')}Reset view</button></div>
          <div class="map-legend">${mapLegend()}<p>Snow field and columns share these colors; column heights are exaggerated. <span id="fieldNote"></span></p>
            <div class="radar-scale" aria-label="Radar colors in dBZ"><span class="legend-title">dBZ</span>${radarLegend}</div>
            <p>Radar: the past 3 hours are NEXRAD (Iowa Environmental Mesonet); after now it is HRRR simulated radar, a forecast.</p></div>`, {iconName: 'compass'})}
        ${win('Ranked', '<div class="map-list-wrap"><ol class="map-list" id="mapList"></ol></div>', {iconName: 'table'})}
      </div></div>`;
    mountMapView();
  } else if (mapState === 'timed-out' && window.maplibregl) mountMapView(); // the library arrived after its timeout; other failures (no WebGL) are final
  const f = $('mapFallback');
  try { renderMapSide(); mapModule?.updateMap(mapOptions()); if (f && mapState === 'ok') f.hidden = true; }
  catch (e) { console.error('map', e); if (f) { f.hidden = false; f.textContent = `The map could not update (${e.message}). Other pages still work.`; } }
}
function stopTimer(which) {
  const [timer, id, label] = which === 'snow' ? [snowTimer, 'playSnow', 'Play snow timeline'] : [radarTimer, 'playRadar', 'Play radar'];
  if (!timer) return;
  clearInterval(timer);
  if (which === 'snow') snowTimer = null; else radarTimer = null;
  const b = $(id); if (b) { b.innerHTML = icon('play', 'icon-sm'); b.setAttribute('aria-label', label); }
}
/** Plays forward from the current position and wraps to the start. */
function togglePlay(which) {
  if (which === 'snow' ? snowTimer : radarTimer) return stopTimer(which);
  const b = $(which === 'snow' ? 'playSnow' : 'playRadar');
  b.innerHTML = icon('pause', 'icon-sm'); b.setAttribute('aria-label', 'Pause');
  const step = () => {
    const n = (which === 'snow' ? snowFrames() : radarFrames()).length, key = which === 'snow' ? 'snowIndex' : 'radarIndex';
    const cur = which === 'snow' ? snowIdx() : radarIdx();
    app.map[key] = (cur + 1) % n; renderMap();
  };
  const timer = setInterval(step, which === 'snow' ? 600 : 700);
  if (which === 'snow') snowTimer = timer; else radarTimer = timer;
}
function stormTour() {
  if (!mapModule) return;
  const top = mapOptions().features.filter(f => finite(f.v) && f.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);
  if (!top.length) { toast('No snow in this window, so there is nothing to tour.'); return; }
  mapModule.tour(top.map(f => f.loc.id));
}

/* ============================== ABOUT ============================== */
let lastAbout = '';
function renderAbout() {
  $('winTitle').textContent = 'METHODS.TXT - ALEC\'S SNOW PAGE';
  const r = app.ranking;
  const html = win('METHODS.TXT', `<div class="prose">
  <h2>What you are looking at</h2>
  <p>Five kinds of information, kept apart: model forecasts, SNOTEL station estimates, the NOAA snowfall analysis, observer snow-board reports, and official avalanche bulletins. Missing data shows as a dash, never as zero.</p>
  <h2>Past days: three sources, kept apart</h2>
  <p>No instrument measures new snow at every resort every day for free, so the past columns offer three labeled sources, switched with the "Past: Station / NOAA / Modeled" buttons. They are never mixed.</p>
  <p><b>Station estimate (the default).</b> From the <a href="https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html" target="_blank" rel="noopener noreferrer">NRCS SNOTEL</a> station assigned to each location. SNOTEL measures snow depth and snow water, not snowfall, so new snow is derived. NRCS daily readings are taken at the end of their date, so a day’s change is that day’s reading minus the previous day’s. The estimate is the larger of two terms: the depth gain (counted when it is at least 1 in and the water did not drop, because depth sensors jitter by about an inch) and ${SNOTEL_SNOW_RATIO} times the water gain (counted only when the station’s high that day was at or below ${SNOTEL_WATER_MAX_F}°F, so rain is not counted as snow). Water is not lost when fresh snow settles, so the water term recovers snow that settles while a storm is still falling. At the four places in Colorado where an observer’s snow board sits within 5 km and 1,000 ft of a SNOTEL station, over six winters (2020-21 to 2025-26, December to March, 23 station-seasons, 2,560 in of board snow), depth gain alone caught 61% of the board total and this rule caught 84%, with the lowest day-to-day error of the variants tried (0.70 in) and no season above 128% of its board. That is one point short of the 85% the snow research set as its target, but no variant met that target without some season reading above 130% of its board. Without the temperature check it would catch 93%, but one season read 146%; a warmer check (36 or 38°F) reads 86 or 88% with seasons up to 137%. That is four station pairs, so it is still an estimate: the ${SNOTEL_SNOW_RATIO}:1 ratio and the ${SNOTEL_WATER_MAX_F}°F check are settings re-checked each autumn against the boards, and a station is near the location, not on its slopes. Several locations share a station.</p>
  <p><b>NOAA analysis.</b> The <a href="https://www.nohrsc.noaa.gov/snowfall_v2/" target="_blank" rel="noopener noreferrer">NOHRSC National Snowfall Analysis</a>: radar and gauge water turned into snow with a model snow ratio, then pulled toward reports from COOP, CoCoRaHS and NWS spotters. The scheduled data job reads one 4 km cell per location every 6 hours and re-reads the last 10 days each time, because NOAA revises each day for about 5 days. For resorts the cell is at the center of the ski area’s outline in OpenStreetMap, between base and summit, not at the base-area point the forecasts use (the point moves season totals by up to almost 3 times). For passes it is the pass. Each value covers the 24 h from 5 AM (6 AM in daylight time) and is filed under the day it starts. Few observers report above 9,000 ft, so in high terrain it leans on the radar and gauge background. It is an analysis, not a measurement.</p>
  <p><b>Modeled.</b> Open-Meteo model output for past days, stitched from recent runs. Not a measurement.</p>
  <p><b>Nearest snow board</b> (location pages). The closest NWS Cooperative Observer or CoCoRaHS station within 10 mi and 1,500 ft of the resort base or the pass that reported on at least half of the last 60 days, from <a href="https://www.rcc-acis.org/" target="_blank" rel="noopener noreferrer">RCC-ACIS</a>, rebuilt every 6 hours. These are real measurements by people on a snow board, but at town or base elevation, sometimes days late, and missing near most passes. CoCoRaHS data are CC BY 4.0.</p>
  <p>There is no free, licensed feed of resort-reported snowfall, so the site does not show one, and it does not copy other snow sites (their terms forbid it). Resort reports stay on the resorts’ own websites.</p>
  <h2>Season snowfall and snowpack rankings</h2>
  <p>Season snow is the station estimate added up from October 1 (the start of the NRCS water year) through each station’s latest reading. In the board comparison above, the same rule caught 84% of board totals over six winters. Resorts measure on their own stakes, usually higher on the mountain, so their numbers can still differ; the totals are best for comparing resorts with each other. A total with missing station days is marked ≥, because it can only be too low.</p>
  <p>The Snowpack Power Rankings follow the <a href="https://www.wcc.nrcs.usda.gov/ftpref/support/states/CO/products/#state=co&element=wteq" target="_blank" rel="noopener noreferrer">NRCS Colorado snowpack products</a>. A scheduled job pulls every past daily snow water equivalent (SWE) reading for each station; the page then places today’s live reading among the readings for the same calendar date in every past water year, counting ties as half. 50th is a typical year for the date. At least 10 years of record are required, and bare ground on a date that is usually bare is not ranked, because it says nothing. Early in the season a few tenths of an inch move the percentile a lot. % of median is the NRCS median for the date.</p>
  <h2>Forecasts</h2>
  <p>From the free <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo forecast API</a> (best-match blend) at each location’s coordinates, summed into calendar days in Colorado time, including the 23 and 25 hour days at daylight-saving changes. A day with any missing hour is shown as missing. Resort coordinates sit near the base area, so the homepage is a base-area forecast; each resort page can re-run it at mid-mountain and summit elevation.</p>
  <h2>Snow quality</h2>
  <p>Quality is the snow-to-water ratio: Blower 17:1 or higher, Powder 13 to 17, Average 10 to 13, Heavy under 10. For past days it is measured at the SNOTEL station (depth gain divided by water gain, shown when the depth rose at least 2 in and the high was at or below ${SNOTEL_WATER_MAX_F}°F, since warmer water may include rain; on days where the water term set the estimate it would only repeat the assumed ratio, so none is shown). For forecast days it is an estimate: Open-Meteo converts frozen water to snow at a fixed 7:1, and the site re-estimates the ratio from the warmest temperature between the 2 m point and 500 hPa using a Kuchera-style rule. It is a guide to light versus heavy snow, not a measurement.</p>
  <h2>Which model to trust</h2>
  <p>The site ranks the models itself. A scheduled job pulls each model\u2019s earlier forecasts from Open-Meteo\u2019s <a href="https://open-meteo.com/en/docs/previous-runs-api" target="_blank" rel="noopener noreferrer">Previous Runs API</a> and compares their 1-day and 3-day daily precipitation forecasts at ${finite(r?.stations) ? `${r.stations} SNOTEL stations` : 'the SNOTEL stations this site uses'} with what the station gauges measured over the last two winters. It scores water rather than snow depth because water is what models forecast directly and gauges measure. The ranking uses the equitable threat score for storm days (at least 5 mm of water), which rewards catching storms and penalizes false alarms; a resampled 90% range shows which models are statistically tied with the leader. The same-day (first hours) test was dropped: the archive stitches each run\u2019s first hour or two, where HRRR is known to be nearly dry while it spins up, so it would measure spin-up rather than skill. Published research agrees 3 km models such as HRRR beat coarse models at short range over narrow ranges, and also that HRRR under-forecasts high-elevation Colorado and Utah precipitation by roughly 25 to 65% (Gowan, Steenburgh and Schwartz 2018; Bytheway et al. 2024; Pletcher et al. 2024). The comparison table lists models from the sharpest grid to the coarsest.</p>
  <div class="table-scroll" tabindex="0" aria-label="Model list, scrolls sideways"><table class="data-table"><thead><tr><th scope="col">Model</th><th scope="col">Open-Meteo id</th><th scope="col">From</th><th scope="col">About</th></tr></thead><tbody>${MODELS.map(m => `<tr><th scope="row">${esc(m.name)}</th><td><code>${m.id}</code></td><td>${esc(m.org)}</td><td>${esc(m.about)}</td></tr>`).join('')}</tbody></table></div>
  <p>Spread (largest minus smallest) describes disagreement between models. It is never presented as a probability.</p>
  <h2>3D map</h2>
  <p><a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre GL JS</a> with <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> basemaps, keyless <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">AWS Terrain Tiles</a> for 3D terrain, ski trails from <a href="https://openskimap.org/" target="_blank" rel="noopener noreferrer">OpenSkiMap</a>, and avalanche zones from CAIC. The snow field comes from free NOAA data that a GitHub Action processes every 6 hours: the past is the <a href="https://www.nohrsc.noaa.gov/snowfall/" target="_blank" rel="noopener noreferrer">NOHRSC National Snowfall Analysis</a> (radar-estimated precipitation adjusted to observed snowfall reports, about 4 km); the future is the <a href="https://vlab.noaa.gov/web/mdl/nbm" target="_blank" rel="noopener noreferrer">National Blend of Models</a> snowfall at 2.5 km, hourly for 2 days then 6-hourly to day 11. The radar timeline shows observed NEXRAD radar for the last 3 hours (<a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener noreferrer">Iowa Environmental Mesonet</a>), then HRRR simulated radar, a 3 km forecast, hourly to 48 hours. Snow colors follow the common NWS snowfall scale. Columns are point values for each location: the chosen past source for the past (the station estimate adds whole calendar days through yesterday, and the time label says so), Open-Meteo for the future. The freezing-level shading uses one statewide median per day, so it is approximate in any single valley.</p>
  <h2>When a source is down</h2>
  <p>Each source (forecasts, SNOTEL, CAIC, and each file from the data job) loads on its own, with a ${CONFIG.timeout / 1000} second timeout (${CONFIG.slowTimeout / 1000} seconds for NRCS, which is often slow) and up to ${CONFIG.retries} retries, so one dead source never blanks the page. The status bar names each source’s state. When a fetch fails and nothing newer is on screen, the page shows the last good copy saved in this browser (forecasts up to a day old, other sources up to 3 days), marked with its age; it never fills a gap with zeros. Avalanche bulletins are checked against their own issue and expiry times, so a saved bulletin that has expired shows as expired.</p>
  <h2>Privacy</h2>
  <p>Units, theme, animations, favorites, and the saved copies of each source are stored in this browser only. There are no accounts and no API keys. Guestbook entries are public.</p></div>`, {iconName: 'doc'});
  if (html !== lastAbout) { lastAbout = html; setHTML($('view-about'), html); }
}

/* ============================== ROUTING AND EVENTS ============================== */
const IDS = new Set(LOCS.map(l => l.id));
function route() {
  const prev = app.route;
  app.route = parseRoute(location.hash, IDS) ?? prev; // a hash that is not a route (such as #main) keeps the current view
  if (app.route.view !== 'map') { stopTimer('snow'); stopTimer('radar'); mapModule?.pause(true); } else mapModule?.pause(false);
  for (const v of ['home', 'resort', 'map', 'about']) $(`view-${v}`).hidden = v !== app.route.view;
  const navKey = app.route.view === 'resort' ? 'home' : app.route.view;
  document.querySelectorAll('[data-route]').forEach(a => a.toggleAttribute('aria-current', a.dataset.route === navKey));
  const loc = byId[app.route.id];
  document.title = app.route.view === 'resort' && loc ? `${loc.name} | ALEC'S SNOW PAGE` : app.route.view === 'map' ? "3D Map | ALEC'S SNOW PAGE" : app.route.view === 'about' ? "Methods | ALEC'S SNOW PAGE" : "ALEC'S SNOW PAGE";
  if (prev.view !== app.route.view || prev.id !== app.route.id) {
    window.scrollTo(0, 0);
    const v = $(`view-${app.route.view}`); v.style.animation = 'none'; void v.offsetWidth; v.style.animation = ''; // replay the window-open effect
  }
  if (app.route.view === 'map' && app.route.focus) mapModule?.focus(app.route.focus);
  rerender();
}
/** The ticker runs on every page, always from all resorts regardless of the table filter, like Storm Watch. */
function updateTicker() {
  try { setTicker(tickerItems(stormFacts())); } catch (e) { console.error('ticker', e); setTicker(['WELCOME TO ALEC’S SNOW PAGE']); }
}
function rerender() {
  const v = app.route.view;
  try {
    renderStatus();
    updateTicker();
    if (v === 'home') { $('winTitle').textContent = "Snowfall - ALEC'S SNOW PAGE"; renderHome(); }
    else if (v === 'resort') renderResort(); else if (v === 'map') renderMap(); else renderAbout();
  } catch (e) { // last line of defense: panels already fail on their own (safe), so this is a bug, said plainly
    console.error(e);
    setHTML($(`view-${v}`), `<div class="notice">This page hit an error (${esc(e.message)}). Other pages may still work; Refresh may fix it.</div>`);
  }
}
function effectiveTheme() { return prefs.theme || (darkQuery.matches ? 'dark' : 'light'); }
function applyPrefs() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme;
  const anim = prefs.anim && !reduceMotion.matches;
  document.documentElement.classList.toggle('anim-on', anim);
  document.documentElement.classList.toggle('anim-off', !anim);
  $('themeButton').textContent = `Theme: ${effectiveTheme() === 'dark' ? 'High Contrast Black' : 'Windows Standard'}`;
  $('animButton').textContent = `Animations: ${prefs.anim ? 'ON' : 'OFF'}${reduceMotion.matches ? ' (system reduces motion)' : ''}`;
  document.querySelectorAll('[data-units-toggle]').forEach(b => {
    const tray = b.closest('.tray'), short = imperial() ? 'in' : 'cm';
    b.textContent = tray ? short : `Units: ${imperial() ? 'inches' : 'centimeters'}`;
    if (tray) b.setAttribute('aria-label', `${short}, switch units`); // the accessible name starts with the visible text
  });
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
function hideTip() { $('tip').hidden = true; document.getElementById('crosshair')?.setAttribute('visibility', 'hidden'); }

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
  if (e.target.closest('a.skip')) { e.preventDefault(); $('main').focus(); return; } // hash routing would treat #main as a route
  if (e.target.closest('.model-chart')) { chartReadout(e); return; } // tap on touch screens, where there is no hover
  const t = e.target.closest('button, [data-tip]');
  if (!t || !t.dataset.tip) hideTip(); // a tap elsewhere closes a tap tooltip
  if (!t) return;
  const ds = t.dataset;
  if (ds.sort) { const k = ds.sort; app.sort = {key: k, dir: app.sort.key === k ? -app.sort.dir : k === 'name' ? 1 : -1}; renderHome(); }
  else if (ds.show) { app.show = ds.show; renderHome(); }
  else if (ds.action === 'show-all') { app.show = 'resort'; app.query = ''; renderHome(); $('homeSearch')?.focus(); }
  else if (ds.table) { app.table = ds.table; renderHome(); }
  else if (ds.past) { prefs.past = ds.past; persist(); rerender(); }
  else if (ds.lead) { app.rankLead = ds.lead; renderResort(); }
  else if (ds.fav) toggleFav(ds.fav);
  else if ('unitsToggle' in ds) { prefs.units = imperial() ? 'metric' : 'imperial'; persist(); applyPrefs(); rerender(); }
  else if (ds.band) location.hash = `#/resort/${app.route.id}${ds.band === 'point' ? '' : '?band=' + ds.band}`;
  else if (ds.focus) mapModule?.focus(ds.focus);
  else if (ds.action === 'refresh') { if (!app.busy) refresh(true); }
  else if (ds.action === 'share') share();
  else if (t.id === 'themeButton') { prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; persist(); applyPrefs(); }
  else if (t.id === 'animButton') { prefs.anim = !prefs.anim; persist(); applyPrefs(); }
  else if (t.id === 'playSnow') togglePlay('snow');
  else if (t.id === 'playRadar') togglePlay('radar');
  else if (t.id === 'tourButton') stormTour();
  else if (t.id === 'resetView') mapModule?.resetView();
  else if (ds.tip && e.pointerType !== 'mouse') showTip(e.clientX, e.clientY, ds.tip); // tap shows the readout on touch
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.layer) { app.map.layers[t.dataset.layer] = t.checked; if (t.dataset.layer === 'radar' && !t.checked) stopTimer('radar'); renderMap(); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'homeSearch') { app.query = t.value; renderHome(); } // setHTML keeps focus and the caret
  else if (t.id === 'snowSlider') { stopTimer('snow'); app.map.snowIndex = +t.value; renderMap(); }
  else if (t.id === 'radarSlider') { stopTimer('radar'); app.map.radarIndex = +t.value; renderMap(); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'guestForm') return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const msg = await submitGuestbook(e.target);
    toast(msg);
    if (msg.startsWith('Signed')) e.target.reset(); // the draft restore in setHTML must not bring a posted entry back
    if (!e.target.querySelector('[name="website"]').value) renderHome();
  }
  catch { toast('Could not reach the guestbook. Please try again.'); btn.disabled = false; }
});
document.addEventListener('pointerover', e => {
  const t = e.target.closest('[data-tip]');
  if (t && e.pointerType === 'mouse') showTip(e.clientX, e.clientY, t.dataset.tip);
  const row = e.target.closest('tr[data-model]');
  document.querySelectorAll('.line.hot').forEach(l => l.classList.remove('hot'));
  if (row) document.querySelector(`.line[data-model="${row.dataset.model}"]`)?.classList.add('hot');
});
document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) hideTip(); });
document.addEventListener('pointermove', e => {
  if (e.target.closest('.model-chart')) chartReadout(e);
  else if (e.target.closest('[data-tip]') && e.pointerType === 'mouse') showTip(e.clientX, e.clientY, e.target.closest('[data-tip]').dataset.tip);
});
document.addEventListener('scroll', hideTip, {passive: true, capture: true});
for (const ev of ['wheel', 'pointerdown', 'keydown']) document.addEventListener(ev, e => { const sc = e.target.closest?.('.matrix-scroll'); if (sc) sc.dataset.manual = '1'; }, {passive: true, capture: true});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
window.addEventListener('hashchange', route);
let resizeTimer;
// Home re-renders too: rotation can switch the phone summary layout, and an unscrolled table re-aims at today.
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (app.route.view === 'resort') renderResort(); else if (app.route.view === 'home') renderHome(); }, 200); });
darkQuery.addEventListener('change', applyPrefs);
reduceMotion.addEventListener('change', applyPrefs);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', retryFailed);

// Console and automated-check surface.
window.Powcast = {app, prefs, LOCS, MODELS, totals, refresh, mapOptions};

initChrome();
restoreCache();
applyPrefs();
route();
refresh();
loadExtras();
setInterval(() => { renderStatus(); if (!document.hidden) refresh(); }, 10 * 60000);
