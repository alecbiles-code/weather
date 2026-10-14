// ALEC'S SNOW PAGE: static Colorado snowfall viewer. No build step, no backend, no API keys.
import {HOUR, TZ, finite, numeric, round, localDate, shiftDate, zonedEpoch, dayBounds, parseProviderDate,
  integrate, dailyTotal, sampleStat, sumComplete, normalizeForecast, normalizeModels, horizon, spreadStats,
  slrEstimate, qualityLabel, measuredDay, parseStationData, containsPoint, binIndex} from './core.js';
import {LOCS, MODELS} from './locations.js';
import {esc, animOn, initChrome, setTicker, loadLists, skierHTML, factHTML, todaysSkier, todaysFact, loadGuestbook, guestbookHTML, submitGuestbook} from './retro.js';

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
  timeout: 15000
});
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
    past: p.past === 'modeled' ? 'modeled' : 'measured',
    migrated: true
  };
}
const prefs = loadPrefs();
const persist = () => writeStore(STORE, prefs);

const app = {data: {}, errors: {}, busy: false, detail: {}, models: {}, snotel: {}, snotelMeta: {}, snotelAt: null, snotelTry: null, snotelError: null,
  bulletins: null, bulletinError: null, bulletinTry: null, ranking: null, rankLead: 'day1', grid: null, lists: {skiers: [], facts: []}, guestbook: false,
  route: {view: 'home'}, sort: {key: 'next5', dir: -1}, show: 'resort', query: '',
  map: {mode: 'future', day: 4, accum: true, radarIndex: null, layers: {field: true, columns: true, trails: true, avalanche: false, snotel: false, freezing: false, snowfx: true, radar: false}}};
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
  return `${v === 0 ? '0' : v < 0.05 ? '<0.1' : v < 10 ? v.toFixed(1) : Math.round(v)}${unit ? ' ' + snowUnit() : ''}`;
}
const temp = c => finite(c) ? `${Math.round(imperial() ? c * 9 / 5 + 32 : c)}°` : '–';
const speed = kmh => finite(kmh) ? `${Math.round(imperial() ? kmh / 1.609344 : kmh)} ${imperial() ? 'mph' : 'km/h'}` : '–';
const elev = m => finite(m) ? `${Math.round(imperial() ? m * 3.28084 : m).toLocaleString('en-US')} ${imperial() ? 'ft' : 'm'}` : '–';
const ft = f => finite(f) ? elev(f / 3.28084) : '–';
const water = mm => finite(mm) ? (imperial() ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`) : '–';
const rainFmt = mm => !finite(mm) ? '–' : mm < 0.05 ? '' : water(mm);
const fmt = (date, opts) => new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', ...opts}).format(new Date(date + 'T12:00:00Z'));
const timeFmt = (ms, opts = {}) => finite(ms) ? new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts}).format(new Date(ms)) : 'unknown';
function ago(ms) { if (!finite(ms)) return 'never'; const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} d ago`; }
const external = (url, text, cls = 'link') => url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}${icon('external', 'icon-xs')}</a>` : '';
const heat = cm => { const b = binIndex(cm); return b === null ? 'missing' : `b${b}`; };
const qual = label => label ? `<span class="q q-${label}">${label}</span>` : '';
function toast(message) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; $('toasts').append(el); setTimeout(() => el.remove(), 5000); }
const win = (title, body, {iconName = 'flake', id = '', cls = ''} = {}) => `<div class="win ${cls}"${id ? ` id="${id}"` : ''}><div class="titlebar">${icon(iconName)}<h2>${title}</h2><span class="title-btns" aria-hidden="true"><i>_</i><i>&#9633;</i><i>&times;</i></span></div><div class="win-body">${body}</div></div>`;

/* ---- Calendar columns: past 10 days, today, next 14 ---- */
function columns() {
  const today = localDate();
  return Array.from({length: CONFIG.pastDays + CONFIG.futureColumns}, (_, i) => {
    const date = shiftDate(today, i - CONFIG.pastDays);
    return {date, past: date < today, today: date === today};
  });
}
const measuredFor = (loc, date) => measuredDay(app.snotel[loc.snotel], date);
const usingMeasured = () => prefs.past === 'measured';
/** Daily snowfall for one location: past days measured at SNOTEL (or modeled, by preference), the rest modeled. */
function dailyFor(loc, d, cols = columns()) {
  return Object.fromEntries(cols.map(c => [c.date, c.past && usingMeasured() ? measuredFor(loc, c.date)?.cm ?? null : d ? dailyTotal(d.hours, c.date) : null]));
}
function totals(loc, d, cols = columns()) {
  const daily = dailyFor(loc, d, cols), pick = list => sumComplete(list.map(c => daily[c.date])), future = cols.filter(c => !c.past);
  return {daily, past10: pick(cols.filter(c => c.past)), next5: pick(future.slice(0, 5)), next15: pick(future)};
}
/** Snow-weighted quality estimate for a forecast window, from temperatures (labeled estimate). */
function forecastQuality(d, startDate, days) {
  if (!d) return null;
  const est = slrEstimate(d.hours, zonedEpoch(startDate), zonedEpoch(shiftDate(startDate, days)));
  return est && est.snowCm > 0 && est.liquidMm >= 1 ? {ratio: est.ratio, label: qualityLabel(est.ratio)} : null;
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
const due = rec => !rec || (!rec.loading && Date.now() - (rec.at || 0) >= CONFIG.cacheMs);

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
async function refresh(force = false) {
  loadSnotel(force);
  if (app.busy) return;
  const wanted = LOCS.filter(l => force || !app.data[l.id] || Date.now() - app.data[l.id].fetchedAt > CONFIG.cacheMs);
  if (!wanted.length) return;
  app.busy = true; renderStatus();
  const groups = [];
  for (let i = 0; i < wanted.length; i += 8) groups.push(wanted.slice(i, i + 8));
  for (let i = 0; i < groups.length; i += 2) await Promise.all(groups.slice(i, i + 2).map(loadGroup));
  app.busy = false; saveCache(); rerender();
  if (force) toast(Object.keys(app.errors).length ? 'Some locations could not refresh. Earlier data was kept and is labeled.' : 'Forecasts refreshed.');
}
/** All SNOTEL stations in two requests: daily depth and water (with medians), and station metadata. */
async function loadSnotel(force = false) {
  if (!force && !due(app.snotelTry)) return;
  app.snotelTry = {loading: true};
  const p = new URLSearchParams({stationTriplets: TRIPLETS.join(','), elements: 'SNWD,WTEQ', duration: 'DAILY', beginDate: shiftDate(localDate(), -(CONFIG.pastDays + 2)), endDate: localDate(), centralTendencyType: 'MEDIAN', returnSuspectData: 'false'});
  const [data, meta] = await Promise.allSettled([fetchJSON(`${CONFIG.station}data?${p}`), fetchJSON(`${CONFIG.station}stations?${new URLSearchParams({stationTriplets: TRIPLETS.join(',')})}`)]);
  if (data.status === 'fulfilled') {
    for (const t of TRIPLETS) { try { app.snotel[t] = parseStationData(data.value, t); } catch { app.snotel[t] = null; } }
    app.snotelAt = Date.now(); app.snotelError = null;
  } else app.snotelError = data.reason.message;
  if (meta.status === 'fulfilled') for (const s of meta.value) app.snotelMeta[s.stationTriplet] = {name: s.name, lat: numeric(s.latitude), lon: numeric(s.longitude), elevationFt: numeric(s.elevation)};
  app.snotelTry = {at: Date.now()};
  rerender();
}
async function loadExtras() {
  const [lists, ranking, grid, guest] = await Promise.allSettled([loadLists(), fetch('data/model-ranking.json', {cache: 'no-cache'}).then(r => r.ok ? r.json() : null),
    fetch('data/grid.json', {cache: 'no-cache'}).then(r => r.ok ? r.json() : null), loadGuestbook()]);
  if (lists.status === 'fulfilled') app.lists = lists.value;
  if (ranking.status === 'fulfilled') app.ranking = ranking.value;
  if (grid.status === 'fulfilled') app.grid = grid.value;
  app.guestbook = guest.status === 'fulfilled' && guest.value;
  rerender();
}

/* ---- Status bar ---- */
function renderStatus() {
  const loaded = LOCS.filter(l => app.data[l.id]), ok = loaded.filter(l => fresh(app.data[l.id])).length;
  const latest = loaded.length ? Math.max(...loaded.map(l => app.data[l.id].fetchedAt)) : null;
  const failed = Object.keys(app.errors).filter(id => byId[id]).length;
  const stale = loaded.length && ok < loaded.length;
  const text = app.busy ? `Loading forecasts for ${LOCS.length} locations…` : !loaded.length ? (failed ? 'Forecasts could not be loaded. Nothing has been substituted.' : 'No forecasts loaded yet.') : `Forecasts ${loaded.length}/${LOCS.length} · updated ${ago(latest)}`;
  $('status').innerHTML = `<span class="grow"><span class="dot ${app.busy ? 'busy' : stale || failed ? 'warn' : 'ok'}" aria-hidden="true"></span>${esc(text)}${app.busy ? '<span class="progress" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' : ''}${stale ? '<span class="pill warn">Stale data shown</span>' : ''}${failed && !app.busy ? `<span class="pill warn">${failed} unavailable</span>` : ''}</span>
    <span>SNOTEL ${app.snotelAt ? 'updated ' + ago(app.snotelAt) : app.snotelError ? 'unavailable' : 'loading…'}</span>
    <span><button type="button" class="text-btn" data-action="refresh" ${app.busy ? 'disabled' : ''}>${icon('refresh', 'icon-xs')}Refresh</button></span>`;
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
  return `<tr class="storm-row"><th scope="row" class="name-cell"><span class="storm-label">Locations ≥ ${oneInch()}</span></th>${cells}<td class="total" colspan="4"></td></tr>`;
}
function cellTip(loc, c, v, d) {
  const day = fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'});
  if (c.past && usingMeasured()) {
    const m = measuredFor(loc, c.date), st = app.snotelMeta[loc.snotel]?.name || loc.snotel;
    if (!m) return `${loc.name}, ${day}: no SNOTEL reading (${st})`;
    return `${loc.name}, ${day}: ${snow(m.cm)} measured at ${st} SNOTEL. Depth ${m.depthIn} in${finite(m.sweChangeIn) ? `, water ${m.sweChangeIn >= 0 ? '+' : ''}${m.sweChangeIn.toFixed(1)} in` : ''}${m.quality ? `. ${m.quality} (${Math.round(m.ratio)}:1, measured)` : ''}`;
  }
  const q = !c.past && v > 0.25 ? forecastQuality(d, c.date, 1) : null;
  return `${loc.name}, ${day}: ${finite(v) ? snow(v) : 'no data'}${c.past ? ' (modeled past)' : ''}${q ? `. Est. ${q.label} (${Math.round(q.ratio)}:1)` : ''}`;
}
function matrixRow(row, cols, lastFav) {
  const {loc, d, t, q} = row, fav = prefs.favs.includes(loc.id);
  const stale = d && !fresh(d) ? '<span class="pill warn">Stale</span>' : '';
  const err = !d && app.errors[loc.id] ? '<span class="pill warn">Unavailable</span>' : '';
  const cells = cols.map(c => { const v = t.daily[c.date]; return `<td class="cell ${heat(v)} ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}" data-tip="${esc(cellTip(loc, c, v, d))}">${cellSnow(v)}</td>`; }).join('');
  const tot = (v, cls) => `<td class="total ${cls} ${heat(v)}">${finite(v) ? snow(v, false) : '–'}</td>`;
  return `<tr class="${lastFav ? 'fav-last' : ''}"><th scope="row" class="name-cell"><button type="button" class="star ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(loc.name)} ${fav ? 'from' : 'to'} favorites">${icon('star')}</button><a href="#/resort/${loc.id}"><span class="loc-name">${esc(loc.name)}</span><span class="loc-sub">${esc(loc.region)}${loc.kind === 'bc' ? ' · Pass' : ''}${stale}${err}</span></a></th>${cells}${tot(t.past10, 'first')}${tot(t.next5, '')}${tot(t.next15, '')}<td class="qual" data-tip="${esc(q ? `Estimated from forecast temperatures: about ${Math.round(q.ratio)}:1 snow to water` : 'Not enough forecast snow to estimate')}">${q ? qual(q.label) : ''}</td></tr>`;
}
function stormFacts(rows, cols) {
  const resorts = rows.filter(r => r.loc.kind === 'resort'), pool = resorts.length ? resorts : rows;
  const next = cols.filter(c => !c.past).map(c => ({c, ...dayStats(pool, c)})).find(x => x.n >= 3);
  const best5 = pool.filter(r => finite(r.t.next5)).sort((a, b) => b.t.next5 - a.t.next5)[0];
  const last3 = LOCS.filter(l => l.kind === 'resort').map(loc => ({loc, v: sumComplete([1, 2, 3].map(i => measuredFor(loc, shiftDate(localDate(), -i))?.cm ?? null))}))
    .filter(x => finite(x.v)).sort((a, b) => b.v - a.v);
  return {next, best5, last3, what: resorts.length ? 'resorts' : 'locations'};
}
function stormWatchHTML(f) {
  const nextLine = f.next ? `<p><b>Next widespread snow:</b> ${f.next.c.today ? 'today' : esc(fmt(f.next.c.date, {weekday: 'long', month: 'short', day: 'numeric'}))}. ${f.next.n} of ${f.next.total} ${f.what} at ≥ ${oneInch()}; most at <a href="#/resort/${f.next.lead.r.loc.id}">${esc(f.next.lead.r.loc.name)}</a> (${snow(f.next.lead.v)}).</p>` : `<p><b>Next widespread snow:</b> none in the next ${CONFIG.futureColumns} days.</p>`;
  const best = f.best5 && f.best5.t.next5 > 0 ? `<p><b>Most in the next 5 days:</b> <a href="#/resort/${f.best5.loc.id}">${esc(f.best5.loc.name)}</a>, ${snow(f.best5.t.next5)}.</p>` : '';
  const measured = f.last3.length ? (f.last3[0].v > 0 ? `<p style="margin-top:6px"><b>Measured, last 3 days</b> (SNOTEL):</p><ol>${f.last3.filter(x => x.v > 0).slice(0, 3).map(x => `<li><a href="#/resort/${x.loc.id}">${esc(x.loc.name)}</a><span>${snow(x.v)}</span></li>`).join('')}</ol>` : '<p style="margin-top:6px"><b>Measured, last 3 days:</b> no new snow at any resort station.</p>') : '';
  return `<div class="recap">${nextLine}${best}${measured}</div>`;
}
function tickerItems(f) {
  const items = [];
  if (f.next) items.push(`NEXT WIDESPREAD SNOW: <b>${esc((f.next.c.today ? 'today' : fmt(f.next.c.date, {weekday: 'short', month: 'short', day: 'numeric'})).toUpperCase())}</b>, MOST AT ${esc(f.next.lead.r.loc.name.toUpperCase())} ${esc(snow(f.next.lead.v).toUpperCase())}`);
  if (f.best5 && f.best5.t.next5 > 0) items.push(`5-DAY LEADER: <b>${esc(f.best5.loc.name.toUpperCase())}</b> ${esc(snow(f.best5.t.next5).toUpperCase())}`);
  if (f.last3[0]?.v > 0) items.push(`MEASURED LAST 3 DAYS: <b>${esc(f.last3[0].loc.name.toUpperCase())}</b> ${esc(snow(f.last3[0].v).toUpperCase())}`);
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
function renderHome() {
  const view = $('view-home'), cols = columns(), rows = sortRows(homeRows(cols)), facts = stormFacts(rows, cols);
  const scroller = view.querySelector('.matrix-scroll'), keepScroll = scroller ? scroller.scrollLeft : null;
  const showBtn = (v, label) => `<button type="button" data-show="${v}" aria-pressed="${app.show === v}">${label}</button>`;
  const pastBtn = (v, label) => `<button type="button" data-past="${v}" aria-pressed="${prefs.past === v}">${label}</button>`;
  const head = cols.map(c => {
    const day = fmt(c.date, {day: 'numeric'}), month = (c.date.endsWith('-01') || c === cols[0]) ? fmt(c.date, {month: 'short'}) + ' ' : '';
    return sortHeader(`d:${c.date}`, c.today ? 'Today' : fmt(c.date, {weekday: 'short'}), `day ${c.past ? 'past' : ''} ${c.today ? 'today' : ''}`, month + day);
  }).join('');
  const favCount = rows.filter(r => prefs.favs.includes(r.loc.id)).length;
  const table = rows.length ? `<div class="matrix-scroll" tabindex="0" aria-label="Daily snowfall table, scrolls sideways">
      <table class="matrix">
        <caption class="sr-only">Daily snowfall in ${imperial() ? 'inches' : 'centimeters'} by location. Past days are ${usingMeasured() ? 'measured at the nearest SNOTEL station' : 'modeled'}. Select a column header to sort.</caption>
        <thead><tr>${sortHeader('name', 'Location', 'name-cell')}${head}${sortHeader('past10', 'Past', 'total first', '10 days')}${sortHeader('next5', 'Next', 'total', '5 days')}${sortHeader('next15', 'Next', 'total', `${CONFIG.futureColumns} days`)}${sortHeader('quality', 'Quality', 'qual', 'next 5 d')}</tr>
        <tr class="band-row"><td class="name-cell"></td><td colspan="${CONFIG.pastDays}" class="band past">${usingMeasured() ? 'MEASURED at nearest SNOTEL station' : 'Modeled past, not measured'}</td><td colspan="${CONFIG.futureColumns}" class="band">Forecast (Open-Meteo blend)</td><td colspan="4" class="band total first">Totals, ${snowUnit()}</td></tr>
        ${stormRow(rows, cols)}</thead>
        <tbody>${rows.map((r, i) => matrixRow(r, cols, favCount && i === favCount - 1 && favCount < rows.length)).join('')}</tbody>
      </table>
    </div>` : `<div class="notice">No locations match. ${app.show === 'fav' && !prefs.favs.length ? 'Star a location in the table to add it to Favorites.' : 'Try a different filter.'} <button type="button" class="btn" data-show="resort">Show all resorts</button></div>`;
  view.innerHTML = `<div class="home-stack">
    <div class="win-grid">
      ${win('Skier of the Day', skierHTML(app.lists.skiers), {iconName: 'star'})}
      ${win('Alec’s Fun Fact of the Day', factHTML(app.lists.facts), {iconName: 'doc'})}
      ${win('Storm Watch', stormWatchHTML(facts), {iconName: 'flake'})}
    </div>
    ${win('Snowfall, day by day', `<div class="toolbar">
      <div class="segmented" role="group" aria-label="Locations to show">${showBtn('resort', 'Resorts')}${showBtn('bc', 'Backcountry')}${showBtn('all', 'All')}${showBtn('fav', `Favorites${prefs.favs.length ? ' ' + prefs.favs.length : ''}`)}</div>
      <span class="label">Past days:</span><div class="segmented" role="group" aria-label="Past days source">${pastBtn('measured', 'Measured')}${pastBtn('modeled', 'Modeled')}</div>
      <label class="search"><span class="sr-only">Filter by name or region</span>${icon('search', 'icon-sm')}<input type="search" id="homeSearch" name="q" placeholder="Filter locations…" autocomplete="off" value="${esc(app.query)}"></label>
      ${legend()}</div>${table}
      <p class="note">${usingMeasured() ? 'Past days: new snow measured at each location’s nearest SNOTEL station (depth gain from the previous day’s reading; gains under 1 in, or with no added water, count as 0). Nearby locations can share a station, and a station is not the resort’s own snow stake.' : 'Past days: Open-Meteo model output stitched from recent runs, not measurements.'} Today and later: Open-Meteo forecast for the listed coordinates, calendar days in Colorado time. A dash means missing, never zero. Quality is an estimate from forecast temperatures. Favorites stay pinned to the top.</p>`, {iconName: 'table', cls: 'snow-win'})}
    ${app.guestbook ? guestbookHTML() : ''}</div>`;
  const sc = view.querySelector('.matrix-scroll');
  if (sc) {
    if (keepScroll !== null) sc.scrollLeft = keepScroll;
    else { const today = sc.querySelector('th.today'), name = sc.querySelector('th.name-cell'); if (today && name && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = today.offsetLeft - name.offsetWidth - 2 * today.offsetWidth; }
  }
}

/* ============================== RESORT DEEP-DIVE ============================== */
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
async function loadAvalanche() {
  if (!due(app.bulletinTry)) return;
  app.bulletinTry = {loading: true};
  try {
    const data = await fetchJSON(CONFIG.avalanche);
    if (!Array.isArray(data.features)) throw new Error('Bulletin has no geographic features');
    app.bulletins = data.features; app.bulletinError = null;
  } catch (e) { app.bulletinError = e.message; }
  app.bulletinTry = {at: Date.now()};
  rerender();
}

function dailyBars(loc, d, cols) {
  const vals = cols.map(c => dailyFor(loc, d, [c])[c.date]), max = Math.max(imperial() ? 5.08 : 5, ...vals.filter(finite));
  return `<div class="chart-field"><div class="bars" role="img" aria-label="Daily snowfall bar chart; the day table below lists every value">${cols.map((c, i) => {
    const v = vals[i], m = c.past && usingMeasured(), tip = `${fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'})}: ${finite(v) ? snow(v) : 'no data'}${c.past ? (m ? ' (measured, SNOTEL)' : ' (modeled past)') : ''}`;
    return `<div class="bar-col ${c.today ? 'today' : ''}" data-tip="${esc(tip)}"><span class="bar-val">${finite(v) && v >= 0.25 ? cellSnow(v) : ''}</span><span class="bar ${finite(v) ? (m ? 'measured' : '') : 'missing'}" style="--h:${finite(v) ? Math.max(0.01, v / max) : 0.06}"></span><span class="bar-day">${c.today ? 'Today' : fmt(c.date, {weekday: 'narrow'})}</span><span class="bar-date">${fmt(c.date, {day: 'numeric'})}</span></div>`;
  }).join('')}</div></div><p class="note">${usingMeasured() ? '<span class="key-sw measured"></span>Measured at SNOTEL' : '<span class="key-sw"></span>Modeled past'}<span class="key-sw"></span>Forecast. In ${imperial() ? 'inches' : 'centimeters'}.</p>`;
}
function dayTable(loc, d, cols) {
  const rows = cols.map(c => {
    const [a, b] = dayBounds(c.date), h = d?.hours, v = dailyTotal(h, c.date), m = c.past ? measuredFor(loc, c.date) : null;
    const est = !c.past && h && integrate(h, a, b).complete ? slrEstimate(h, a, b) : null;
    const quality = m?.quality ? `${qual(m.quality)} <span class="muted">${Math.round(m.ratio)}:1 measured</span>` : est?.ratio && est.liquidMm >= 0.5 ? `${qual(qualityLabel(est.ratio))} <span class="muted">${Math.round(est.ratio)}:1 est.</span>` : '';
    return `<tr class="${c.past ? 'past' : ''} ${c.today ? 'today' : ''}"><th scope="row">${c.today ? 'Today' : esc(fmt(c.date, {weekday: 'short', month: 'short', day: 'numeric'}))}</th><td class="num ${heat(v)}">${finite(v) ? snow(v) : '–'}</td><td class="num">${c.past ? (m ? snow(m.cm) : '–') : ''}</td><td>${quality}</td><td class="num">${temp(sampleStat(h, a, b, 'temp'))} / ${temp(sampleStat(h, a, b, 'temp', 'min'))}</td><td class="num">${speed(sampleStat(h, a, b, 'gust'))}</td><td class="num">${elev(sampleStat(h, a, b, 'freezing', 'min'))}</td><td class="num">${rainFmt(integrate(h, a, b, 'rain').value)}</td></tr>`;
  }).join('');
  return `<div class="table-scroll" tabindex="0" aria-label="Daily details, scrolls sideways"><table class="data-table"><thead><tr><th scope="col">Day</th><th scope="col" class="num">Snow (model)</th><th scope="col" class="num">Measured (SNOTEL)</th><th scope="col">Snow quality</th><th scope="col" class="num">High / low</th><th scope="col" class="num">Max gust</th><th scope="col" class="num">Lowest freezing level</th><th scope="col" class="num">Rain</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="note">Snow quality is the snow-to-water ratio: Blower 17:1 or more, Powder 13 to 17, Average 10 to 13, Heavy under 10. Past days use the ratio actually measured at the SNOTEL station (shown when at least 2 in fell). Forecast days are an <b>estimate</b> from a Kuchera-style rule using the warmest of the 2 m, 600 hPa and 500 hPa temperatures. "Snow (model)" uses Open-Meteo’s fixed 7:1 ratio, so light snow can read low. Freezing level is the 0°C altitude, not the snow line.</p>`;
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
const topPick = lead => app.ranking?.leads?.[lead]?.find(r => r.rank === 1) || null;
function scoreboardHTML() {
  const r = app.ranking;
  if (!r) return '<p class="muted">The model scoreboard has not been built yet.</p>';
  const rows = r.leads[app.rankLead] || [], best = Math.max(...rows.map(x => x.ets || 0)), p1 = topPick('day1'), p3 = topPick('day3');
  const leadBtn = (v, l) => `<button type="button" data-lead="${v}" aria-pressed="${app.rankLead === v}">${l}</button>`;
  const pct = v => finite(v) ? `${Math.round(v * 100)}%` : '–';
  return `<dl class="picks"><div><dt>Next 1 to 2 days, trust</dt><dd>${esc(p1?.name || '–')}</dd><span class="muted">HRRR and NAM add useful storm timing</span></div><div><dt>Days 3 to 7, trust</dt><dd>${esc(p3?.name || '–')}</dd><span class="muted">and compare with the other top three</span></div><div><dt>Past a week</dt><dd>Trends only</dd><span class="muted">No model has real snow skill that far out</span></div></dl>
  <div class="toolbar"><div class="segmented" role="group" aria-label="Forecast lead time">${leadBtn('day1', '1 day ahead')}${leadBtn('day3', '3 days ahead')}</div></div>
  <div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">Rank</th><th scope="col">Model</th><th scope="col">Storm score</th><th scope="col" class="num">Storms caught</th><th scope="col" class="num">False alarms</th><th scope="col" class="num">Typical miss on wet days</th><th scope="col" class="num">Total vs measured</th></tr></thead>
  <tbody>${rows.map(x => `<tr><td>${x.rank ?? '–'}</td><th scope="row">${esc(x.name)}${x.rank ? '' : ' <span class="muted">(not enough history)</span>'}</th><td>${finite(x.ets) ? `${Math.round(x.ets * 100)} <span class="score-bar" style="width:${Math.max(2, x.ets / best * 80)}px"></span>` : '–'}</td><td class="num">${pct(x.caught)}</td><td class="num">${pct(x.falseAlarms)}</td><td class="num">${water(x.maeWetMm)}</td><td class="num">${finite(x.biasPct) ? `${x.biasPct > 0 ? '+' : ''}${x.biasPct}%` : '–'}</td></tr>`).join('')}</tbody></table></div>
  <p class="note">Scored by this site, not taken from anyone’s opinion: each model’s ${app.rankLead === 'day1' ? '1-day' : '3-day'} forecasts of daily precipitation (water) at the ${r.stations} SNOTEL stations Powcast uses, ${r.windows.map(w => `${esc(fmt(w.start, {month: 'short', year: 'numeric'}))} to ${esc(fmt(w.end, {month: 'short', year: 'numeric'}))}`).join(' and ')}, against what each station’s gauge measured. Storm score is the equitable threat score for days with at least 5 mm of water (about 2 to 3 in of snow), times 100: higher is better, and it rewards catching storms while penalizing false alarms. Scores within about 2 points are effectively tied. One season at 22 stations is a real sample but not the final word. Gauges undercatch snow, which affects every model equally. Updated weekly in winter; last built ${esc(timeFmt(Date.parse(r.generatedAt), {month: 'short', day: 'numeric'}))}.</p>`;
}
function modelOrder() {
  const ranks = Object.fromEntries((app.ranking?.leads?.day1 || []).map(r => [r.id, r.rank ?? 99]));
  return [...MODELS].sort((a, b) => (ranks[a.id] ?? 99) - (ranks[b.id] ?? 99));
}
function modelTable(loc) {
  const m = app.models[loc.id];
  if (!m || m.loading) return '<div class="skeleton" style="height:320px" aria-label="Loading model comparison"></div>';
  if (m.error) return `<div class="notice">Model comparison could not load: ${esc(m.error)}. No values are substituted.</div>`;
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
    return `<tr class="${r.id === 'best_match' ? 'blend' : ''}" data-model="${r.id}"><th scope="row"><span class="model-name">${esc(r.name)}${badges}</span><span class="model-sub">${esc(r.about || '')}${hz ? ` Data to ${esc(timeFmt(hz, {weekday: 'short', minute: undefined}))}.` : r.id === 'best_match' ? '' : ' No data here.'}</span></th>${v.days.map(x => cell(x)).join('')}${v.wins.map((x, i) => cell(x, i === 0)).join('')}</tr>`;
  }).join('');
  const modelsOnly = table.filter(x => x.r.id !== 'best_match');
  const valueAt = (x, i) => i < days.length ? x.v.days[i] : x.v.wins[i - days.length];
  const stats = Array.from({length: days.length + wins.length}, (_, i) => ({i, ...spreadStats(modelsOnly.map(x => valueAt(x, i)))}));
  const sRow = (label, f) => `<tr><th scope="row">${label}</th>${stats.map(s => `<td class="num${s.i === days.length ? ' first' : ''}">${f(s)}</td>`).join('')}</tr>`;
  return `<div class="table-scroll" tabindex="0" aria-label="Model comparison, scrolls sideways"><table class="data-table models">
    <thead><tr><th scope="col">Model (best scorers first)</th>${days.map((dt, i) => `<th scope="col" class="num">${i === 0 ? 'Today' : esc(fmt(dt, {weekday: 'short'}))}<small>${esc(fmt(dt, {day: 'numeric'}))}</small></th>`).join('')}${wins.map(([l], i) => `<th scope="col" class="num${i === 0 ? ' first' : ''}">Next<small>${l}</small></th>`).join('')}</tr></thead>
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
  const pad = {l: 40, r: 12, t: 12, b: 26}, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, p1 = topPick('day1')?.id;
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
    ${dayTicks.map(t => { const i = (t - now) / HOUR; return `<line class="tick" x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="axis" x="${x(i) + 3}" y="${H - 8}">${esc(new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short'}).format(t + HOUR))}</text>`; }).join('')}
    ${[...series].sort((a, b) => (a.id === 'best_match' || a.id === p1) - (b.id === 'best_match' || b.id === p1)).map(s => `<path class="${cls(s)}" data-model="${s.id}" d="${path(s)}"/>`).join('')}
    <line class="crosshair" id="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>
  </svg><figcaption><span class="key"><i class="key-line"></i>Each model</span><span class="key"><i class="key-line blend"></i>Blend (homepage)</span>${p1 ? `<span class="key"><i class="key-line pick"></i>Best 1-day scorer</span>` : ''}<span>Cumulative ${snowUnit()} from now. Hover or tap for values; hover a table row to highlight its line.</span></figcaption></figure>`;
}
function chartReadout(evt) {
  const c = chartState, svg = evt.target.closest('svg');
  if (!c || !svg) return;
  const r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * (c.W / r.width), i = Math.round(((px - c.x0) / c.iw) * c.span);
  if (i < 1 || i > c.span) return hideTip();
  const line = svg.querySelector('#crosshair'), xp = c.x0 + (i / c.span) * c.iw;
  line.setAttribute('x1', xp); line.setAttribute('x2', xp); line.setAttribute('visibility', 'visible');
  const vals = c.series.map(s => ({n: s.name, v: s.pts[i - 1]})).filter(s => finite(s.v)).sort((a, b) => b.v - a.v);
  showTip(evt.clientX, evt.clientY, `<strong>${esc(timeFmt(c.now + i * HOUR, {weekday: 'short'}))}</strong>${vals.map(s => `<span class="tip-row"><span>${esc(s.n)}</span><span>${snow(s.v)}</span></span>`).join('')}`, true);
}

/* ---- Station and avalanche panels ---- */
function stationHTML(loc) {
  const data = app.snotel[loc.snotel], meta = app.snotelMeta[loc.snotel];
  if (!data && !app.snotelError) return '<div class="skeleton" style="height:140px" aria-label="Loading station data"></div>';
  const depth = data?.SNWD?.filter(x => x.value !== null).at(-1), swe = data?.WTEQ?.filter(x => x.value !== null).at(-1);
  const pct = finite(swe?.median) && swe.median > 0 && finite(swe?.value) ? Math.round(swe.value / swe.median * 100) : null;
  const old = [depth?.date, swe?.date].some(dt => dt && dt < shiftDate(localDate(), -2)), shared = LOCS.filter(l => l.snotel === loc.snotel).length;
  return `${app.snotelError && !data ? `<div class="notice">Station request failed: ${esc(app.snotelError)}. No measurement is inferred.</div>` : ''}
  <p class="panel-sub">${esc(meta?.name || 'Station')} SNOTEL · ${esc(loc.snotel)}${finite(meta?.elevationFt) ? ' · ' + ft(meta.elevationFt) : ''}${old ? ' <span class="pill warn">Old observation</span>' : ''}</p>
  <dl class="facts"><div><dt>Snow depth (measured)</dt><dd>${depth ? snow(depth.value * 2.54) : 'No data'}</dd></div><div><dt>Snow water equivalent</dt><dd>${swe ? snow(swe.value * 2.54) : 'No data'}</dd></div><div><dt>Water vs 30-year median</dt><dd>${pct === null ? 'No data' : pct + '%'}</dd></div><div><dt>Reading for</dt><dd>${esc(depth?.date || swe?.date || 'No data')}</dd></div></dl>
  <p class="note">A SNOTEL station is near, not at, this location${shared > 1 ? `, and ${shared} locations here share it` : ''}. ${external(`https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${encodeURIComponent(loc.snotel.split(':')[0])}`, 'Open NRCS station')}</p>`;
}
function avalancheHTML(loc) {
  const caveat = '<p class="note">Current bulletin for the surrounding backcountry, not a route assessment or a forecast for later days. Read the full CAIC forecast.</p>';
  if (!app.bulletins && !app.bulletinError) return '<div class="skeleton" style="height:140px" aria-label="Loading avalanche bulletin"></div>';
  const matches = (app.bulletins || []).filter(f => containsPoint(f, [loc.lon, loc.lat]));
  if (matches.length !== 1) return `<p><span class="pill warn">${matches.length > 1 ? 'Boundary overlap' : 'Bulletin unavailable'}</span></p><p>${matches.length > 1 ? 'Several bulletin areas overlap this point, so no single rating is shown.' : app.bulletinError ? 'The bulletin feed could not be reached. Missing does not mean low danger.' : 'No CAIC zone matched this point. No rating is inferred.'}</p>${caveat}${external('https://avalanche.state.co.us/', 'Full CAIC forecast')}`;
  const p = matches[0].properties, zone = p.timezone || TZ, start = parseProviderDate(p.start_date, zone), end = parseProviderDate(p.end_date, zone), now = Date.now();
  const valid = finite(start) && finite(end) && start <= now && end > now, level = numeric(p.danger_level), named = valid && Number.isInteger(level) && level >= 1 && level <= 5;
  const label = named ? `${['', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'][level]} (${level} of 5)` : valid ? 'No rating published' : 'Expired or unverified';
  return `<p class="panel-sub">${esc(p.name || 'CAIC zone')}</p><p><span class="danger d${named ? level : 0}">${esc(label)}</span></p>
  <dl class="facts"><div><dt>Issued</dt><dd>${esc(timeFmt(start, {month: 'short', day: 'numeric'}))}</dd></div><div><dt>Expires</dt><dd>${esc(timeFmt(end, {month: 'short', day: 'numeric'}))}</dd></div></dl>
  ${valid && p.travel_advice ? `<p>${esc(p.travel_advice)}</p>` : ''}${p.warning?.product && valid ? '<p class="warn-text"><b>An avalanche warning is in effect. Read the official product.</b></p>' : ''}${caveat}${external(p.link || 'https://avalanche.state.co.us/', 'This zone on CAIC')}`;
}

function renderResort() {
  const loc = byId[app.route.id], view = $('view-resort');
  if (!loc) { view.innerHTML = win('Error', `<p>Location not found. <a href="#/">Back to all locations</a></p>`); return; }
  const band = loc.base && ['base', 'mid', 'summit'].includes(app.route.band) ? app.route.band : 'point';
  const det = app.detail[`${loc.id}:${band}`], d = det?.data || (band === 'point' ? app.data[loc.id] : null), cols = columns(), t = totals(loc, d, cols);
  const fav = prefs.favs.includes(loc.id), q5 = forecastQuality(d, localDate(), 5), depth = app.snotel[loc.snotel]?.SNWD?.filter(x => x.value !== null).at(-1);
  const bands = loc.base ? [['point', 'Grid point'], ['base', `Base ${ft(loc.base)}`], ['mid', 'Mid'], ['summit', `Summit ${ft(loc.top)}`]] : [];
  const keepY = window.scrollY, width = Math.min(1100, (view.querySelector('.chart-slot')?.clientWidth || Math.min(window.innerWidth - 60, 1100)) - 12);
  $('winTitle').textContent = `${loc.name} - ALEC'S SNOW PAGE`;
  view.setAttribute('aria-labelledby', 'resortTitle');
  view.innerHTML = `
  <a class="back" href="#/">${icon('back', 'icon-sm')}All locations</a>
  <div class="resort-head">
    <div><h1 id="resortTitle">${esc(loc.name)}</h1>
    <p class="meta">${esc(loc.region)} Colorado · ${loc.kind === 'bc' ? 'Backcountry pass (weather only, not a safety rating)' : 'Resort'}${loc.base ? ` · ${ft(loc.base)} to ${ft(loc.top)}` : ` · ${ft(loc.elev)}`}${d ? ` · forecast grid ${elev(d.elevation)}` : ''}</p></div>
    <div class="actions"><button type="button" class="btn ${fav ? 'on' : ''}" data-fav="${loc.id}" aria-pressed="${fav}">${icon('star', 'icon-sm')}${fav ? 'Favorite' : 'Add favorite'}</button>${loc.webcam ? `<a class="btn" href="${esc(loc.webcam)}" target="_blank" rel="noopener noreferrer">${icon('cam', 'icon-sm')}Webcams</a>` : ''}<button type="button" class="btn" data-action="share">${icon('link', 'icon-sm')}Copy link</button><a class="btn" href="#/map?focus=${loc.id}">${icon('map', 'icon-sm')}On 3D map</a>${loc.url ? external(loc.url, 'Official site', 'btn') : ''}</div>
  </div>
  <dl class="kpis"><div><dt>Past 10 days</dt><dd>${finite(t.past10) ? snow(t.past10) : '–'}</dd><span>${usingMeasured() ? 'measured, SNOTEL' : 'modeled'}</span></div><div><dt>Next 5 days</dt><dd>${finite(t.next5) ? snow(t.next5) : '–'}</dd><span>today + 4, forecast</span></div><div><dt>Next ${CONFIG.futureColumns} days</dt><dd>${finite(t.next15) ? snow(t.next15) : '–'}</dd><span>today + 14, forecast</span></div><div><dt>Snow quality next 5 days</dt><dd>${q5 ? qual(q5.label) : '–'}</dd><span>${q5 ? `about ${Math.round(q5.ratio)}:1, estimate` : 'not enough snow to estimate'}${depth ? ` · depth now ${snow(depth.value * 2.54)}` : ''}</span></div></dl>
  ${bands.length ? `<div class="band-switch"><div class="segmented" role="group" aria-label="Forecast elevation">${bands.map(([v, l]) => `<button type="button" data-band="${v}" aria-pressed="${band === v}">${l}</button>`).join('')}</div><p class="note">Base, mid and summit re-run the same coordinates at that elevation (Open-Meteo lapse-rate adjustment). They are not separate stations. The model comparison always uses the grid point.</p></div>` : ''}
  ${win('Daily snowfall', d ? dailyBars(loc, d, cols) : '<div class="skeleton" style="height:180px"></div>', {iconName: 'table'})}
  ${win('Next 48 hours', `<p class="panel-sub">Hourly snowfall; hover or tap a bar for temperature and gusts.</p>${det?.data ? hourlyStrip(det.data) : '<div class="skeleton" style="height:110px"></div>'}`)}
  ${win('Which model to trust', scoreboardHTML(), {iconName: 'star'})}
  ${win('Model comparison', `<p class="panel-sub">${MODELS.length} models at the grid point, best scorers first. When they agree, confidence is higher; when they scatter, treat any single number loosely.</p><div class="chart-slot">${modelChart(loc, width)}</div>${modelTable(loc)}`, {iconName: 'table'})}
  ${win('Day by day', `<p class="panel-sub">${band === 'point' ? 'Grid point' : `${bands.find(b => b[0] === band)[1]} scenario`}.</p>${det?.data ? dayTable(loc, det.data, cols) : det?.error ? `<div class="notice">Details could not load: ${esc(det.error)}.</div>` : '<div class="skeleton" style="height:420px"></div>'}`, {iconName: 'doc'})}
  <div class="two-up">${win('Observed snowpack', stationHTML(loc))}${win('Avalanche bulletin', avalancheHTML(loc))}</div>
  <p class="note">Coordinates ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}; Open-Meteo returned grid ${d?.lat?.toFixed(3) ?? '–'}, ${d?.lon?.toFixed(3) ?? '–'}. Resort-reported snowfall and lift status live on the ${loc.url ? external(loc.url, 'official site') : 'operator’s site'}.</p>`;
  if (app.route.rendered === loc.id + band) window.scrollTo(0, keepY);
  app.route.rendered = loc.id + band;
  loadDetail(loc, band); loadModels(loc); loadAvalanche();
}

/* ============================== MAP ============================== */
let mapModule = null, playTimer = null, radarTimer = null;
function mapValue(loc) {
  const cols = columns(), t = totals(loc, app.data[loc.id], cols), future = cols.filter(c => !c.past);
  if (app.map.mode === 'past') return t.past10;
  const sel = future.slice(app.map.accum ? 0 : app.map.day, app.map.day + 1);
  return sumComplete(sel.map(c => t.daily[c.date]));
}
function mapWindowLabel() {
  if (app.map.mode === 'past') return `Past 10 days (${usingMeasured() ? 'measured' : 'modeled'})`;
  const date = shiftDate(localDate(), app.map.day), name = app.map.day === 0 ? 'today' : fmt(date, {weekday: 'short', month: 'short', day: 'numeric'});
  return app.map.accum ? `Total through ${name}` : `Snow on ${name}`;
}
/** Radar timeline: the last 3 hours of observed radar every 10 minutes, then hourly model precipitation from grid.json. */
function radarFrames() {
  const step = 10 * 60000, end = Math.floor((Date.now() - 10 * 60000) / step) * step, frames = [];
  for (let t = end - 17 * step; t <= end; t += step) frames.push({t, kind: 'radar'});
  for (const [i, s] of (app.grid?.hours || []).entries()) if (s * 1000 > end) frames.push({t: s * 1000, kind: 'model', index: i});
  return frames;
}
function mapOptions() {
  const frames = radarFrames(), ri = Math.min(app.map.radarIndex ?? frames.findLastIndex(f => f.kind === 'radar'), frames.length - 1);
  return {theme: effectiveTheme(), reduceMotion: reduceMotion.matches || !prefs.anim, unit: snowUnit(), windowLabel: mapWindowLabel(),
    features: LOCS.map(loc => { const v = mapValue(loc); return {loc, v, label: finite(v) ? snow(v) : 'No data'}; }),
    layers: app.map.layers, grid: app.grid, gridSel: app.map.mode === 'future' ? {day: app.map.day, accum: app.map.accum} : null,
    freezingM: app.grid?.freezingLevelM?.[app.map.mode === 'future' ? app.map.day : 0] ?? null,
    snotel: TRIPLETS.map(t => ({triplet: t, ...app.snotelMeta[t], depthIn: app.snotel[t]?.SNWD?.filter(x => x.value !== null).at(-1)?.value ?? null})).filter(s => finite(s.lat)),
    bulletins: app.bulletins, radarFrame: frames[ri], focusId: app.route.focus, snowfx: prefs.anim && !reduceMotion.matches,
    onSelect: id => { location.hash = `#/resort/${id}`; }};
}
function renderMapSide() {
  const list = mapOptions().features.sort((a, b) => (finite(b.v) ? b.v : -1) - (finite(a.v) ? a.v : -1)), max = Math.max(1, ...list.map(x => x.v).filter(finite));
  const el = $('mapList');
  if (el) el.innerHTML = list.map(x => `<li><button type="button" data-focus="${x.loc.id}"><span class="ml-name">${esc(x.loc.name)}<small>${esc(x.loc.region)}${x.loc.kind === 'bc' ? ' · Pass' : ''}</small></span><span class="ml-val">${x.label}</span><span class="ml-bar"><i style="--w:${finite(x.v) ? x.v / max : 0}"></i></span></button></li>`).join('');
  const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
  set('mapWindowLabel', mapWindowLabel());
  set('fieldNote', app.grid ? `The snow field is a ${app.grid.grid.step}\u00b0 model grid, rebuilt ${ago(Date.parse(app.grid.generatedAt))}.` : 'The snow field appears once the scheduled data job has run.');
  const frames = radarFrames(), ri = Math.min(app.map.radarIndex ?? frames.findLastIndex(f => f.kind === 'radar'), frames.length - 1), f = frames[ri];
  set('radarLabel', f ? `${f.kind === 'radar' ? 'Radar (observed)' : 'Model precipitation (forecast)'}: ${timeFmt(f.t, {weekday: 'short'})}` : '');
  const fl = mapOptions().freezingM;
  set('freezingLabel', finite(fl) ? `Freezing level ${elev(fl)} (statewide model median${app.map.mode === 'future' ? ', selected day' : ', today'})` : 'Freezing level unavailable');
  const slider = $('daySlider'); if (slider) { slider.value = String(app.map.day); slider.disabled = app.map.mode !== 'future'; }
  const rs = $('radarSlider'); if (rs) { rs.max = String(frames.length - 1); rs.value = String(ri); }
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === app.map.mode)));
  const radarCtl = $('radarCtl'); if (radarCtl) radarCtl.hidden = !app.map.layers.radar;
  const acc = $('accumBox'); if (acc) acc.checked = app.map.accum;
}
function renderMap() {
  const view = $('view-map');
  $('winTitle').textContent = '3D Map - ALEC\'S SNOW PAGE';
  if (!view.querySelector('#mapCanvas')) {
    const L = app.map.layers, box = (k, label) => `<label class="check"><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}>${label}</label>`;
    const radarScale = [['#04e9e7', 'light'], ['#019ff4', ''], ['#02fd02', ''], ['#fdf802', 'moderate'], ['#fd9500', ''], ['#fd0000', 'heavy']];
    view.innerHTML = `<div class="map-layout">
      <div>${win('3D snowfall map', `<div class="map-stage"><div id="mapCanvas" class="map-canvas" role="region" aria-label="Interactive 3D map of Colorado snowfall. Drag to pan, right-drag or two fingers to tilt and rotate."></div><canvas class="snow-canvas" id="snowCanvas" aria-hidden="true"></canvas><div class="map-fallback" id="mapFallback" hidden></div></div>
        <p class="note">Drag to pan. Scroll or pinch to zoom. Right-drag, Ctrl-drag, or two-finger drag to tilt and rotate. Click a column for its forecast.</p>`, {iconName: 'map'})}</div>
      <div class="map-side">
        ${win('Controls', `
          <div class="ctl-group"><span class="glabel">Time</span>
            <div class="segmented" role="group" aria-label="Time window"><button type="button" data-mode="past">Past 10 days</button><button type="button" data-mode="future">Next 15 days</button></div>
            <div class="ctl-row"><button type="button" class="icon-btn" id="playDays" aria-label="Play through days">${icon('play', 'icon-sm')}</button><label class="sr-only" for="daySlider">Forecast day</label><input type="range" id="daySlider" min="0" max="${CONFIG.futureColumns - 1}" step="1" value="${app.map.day}"></div>
            <div class="ctl-row"><label class="check"><input type="checkbox" id="accumBox" ${app.map.accum ? 'checked' : ''}>Accumulate from today</label></div>
            <p class="window-label" id="mapWindowLabel" aria-live="polite"></p></div>
          <div class="ctl-group"><span class="glabel">Layers</span><div class="layer-list">
            ${box('field', 'Snow field')}${box('columns', '3D columns')}${box('trails', 'Ski trails')}${box('snowfx', 'Falling snow')}${box('avalanche', 'Avalanche danger')}${box('snotel', 'SNOTEL stations')}${box('freezing', 'Freezing level')}${box('radar', 'Radar timeline')}</div>
            <p class="note" id="freezingLabel"></p></div>
          <div class="ctl-group" id="radarCtl" ${L.radar ? '' : 'hidden'}><span class="glabel">Radar</span>
            <div class="ctl-row"><button type="button" class="icon-btn" id="playRadar" aria-label="Play radar">${icon('play', 'icon-sm')}</button><label class="sr-only" for="radarSlider">Radar time</label><input type="range" id="radarSlider" min="0" max="1" step="1" value="0"></div>
            <p class="window-label" id="radarLabel" aria-live="polite"></p>
            <div class="radar-scale" aria-hidden="true">${radarScale.map(([c, l]) => `<i style="background:${c}"></i>${l ? `<span>${l}</span>` : ''}`).join('')}</div>
            <p class="note">Past 3 hours: NEXRAD radar (Iowa Environmental Mesonet). After now: forecast precipitation from the scheduled model grid, not radar.</p></div>
          <div class="ctl-row"><button type="button" class="btn" id="tourButton">${icon('plane', 'icon-sm')}Storm tour</button><button type="button" class="btn" id="resetView">${icon('compass', 'icon-sm')}Reset view</button></div>
          <div class="map-legend">${legend()}<p>Columns and the snow field share this scale. Column heights are exaggerated. <span id="fieldNote"></span></p></div>`, {iconName: 'compass'})}
        ${win('Ranked', '<div class="map-list-wrap"><ol class="map-list" id="mapList"></ol></div>', {iconName: 'table'})}
      </div></div>`;
    import('./map.js').then(mod => { mapModule = mod; return mod.mountMap($('mapCanvas'), $('snowCanvas'), mapOptions()); })
      .catch(e => { const f = $('mapFallback'); f.hidden = false; f.textContent = `The 3D map could not start (${e.message}). The ranked list still works.`; });
  }
  renderMapSide();
  mapModule?.updateMap(mapOptions());
}
function stopTimer(which) {
  if (which === 'days' && playTimer) { clearInterval(playTimer); playTimer = null; const b = $('playDays'); if (b) { b.innerHTML = icon('play', 'icon-sm'); b.setAttribute('aria-label', 'Play through days'); } }
  if (which === 'radar' && radarTimer) { clearInterval(radarTimer); radarTimer = null; const b = $('playRadar'); if (b) { b.innerHTML = icon('play', 'icon-sm'); b.setAttribute('aria-label', 'Play radar'); } }
}
function togglePlayDays() {
  if (playTimer) return stopTimer('days');
  app.map.mode = 'future';
  $('playDays').innerHTML = icon('pause', 'icon-sm'); $('playDays').setAttribute('aria-label', 'Pause');
  const step = () => { app.map.day = (app.map.day + 1) % CONFIG.futureColumns; renderMap(); };
  if (app.map.day === CONFIG.futureColumns - 1) app.map.day = -1;
  step(); playTimer = setInterval(step, 1000);
}
function togglePlayRadar() {
  if (radarTimer) return stopTimer('radar');
  $('playRadar').innerHTML = icon('pause', 'icon-sm'); $('playRadar').setAttribute('aria-label', 'Pause radar');
  const step = () => { const n = radarFrames().length; app.map.radarIndex = ((app.map.radarIndex ?? 0) + 1) % n; renderMap(); };
  radarTimer = setInterval(step, 700);
}
function stormTour() {
  if (!mapModule) return;
  const top = mapOptions().features.filter(f => finite(f.v) && f.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);
  if (!top.length) { toast('No snow in this window, so there is nothing to tour.'); return; }
  mapModule.tour(top.map(f => f.loc.id));
}

/* ============================== ABOUT ============================== */
function renderAbout() {
  $('winTitle').textContent = 'METHODS.TXT - ALEC\'S SNOW PAGE';
  const r = app.ranking;
  $('view-about').innerHTML = win('METHODS.TXT', `<div class="prose">
  <h2>What you are looking at</h2>
  <p>Three kinds of information, kept apart: model forecasts, station measurements, and official bulletins. Missing data shows as a dash, never as zero.</p>
  <h2>Past days: measured</h2>
  <p>By default the past 10 days come from the <a href="https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html" target="_blank" rel="noopener noreferrer">NRCS SNOTEL</a> station assigned to each location. NRCS daily readings are taken at the end of their date, so new snow for a day is that day’s depth minus the previous day’s. Depth sensors jitter by about an inch, so a gain counts only when it is at least 1 in and the water content did not drop. Fresh snow also settles, so this tends to undercount big storms a little. Several locations share a station. There is no free feed of resort-reported snowfall, so the site does not show one; resort reports stay on their own websites. You can switch the past columns to modeled values with the "Past days" buttons.</p>
  <h2>Forecasts</h2>
  <p>From the free <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo forecast API</a> (best-match blend) at each location’s coordinates, summed into calendar days in Colorado time, including the 23 and 25 hour days at daylight-saving changes. A day with any missing hour is shown as missing.</p>
  <h2>Snow quality</h2>
  <p>Quality is the snow-to-water ratio: Blower 17:1 or higher, Powder 13 to 17, Average 10 to 13, Heavy under 10. For past days it is measured at the SNOTEL station (depth gain divided by water gain, shown when at least 2 in fell). For forecast days it is an estimate: Open-Meteo converts frozen water to snow at a fixed 7:1, and the site re-estimates the ratio from the warmest temperature between the 2 m point and 500 hPa using a Kuchera-style rule. It is a guide to light versus heavy snow, not a measurement.</p>
  <h2>Which model to trust</h2>
  <p>The site ranks the models itself. A scheduled job pulls each model’s earlier forecasts from Open-Meteo’s <a href="https://open-meteo.com/en/docs/previous-runs-api" target="_blank" rel="noopener noreferrer">Previous Runs API</a> and compares their 1-day and 3-day daily precipitation forecasts at ${r ? r.stations : 22} SNOTEL stations with what the station gauges measured over winter. It scores water rather than snow depth because water is what models forecast directly and gauges measure; depth depends on settling and ratio assumptions. The ranking uses the equitable threat score for storm days (at least 5 mm of water), which rewards catching storms and penalizes false alarms. Average error alone would favor smooth models that under-forecast.</p>
  <div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">Model</th><th scope="col">Open-Meteo id</th><th scope="col">From</th><th scope="col">About</th></tr></thead><tbody>${MODELS.map(m => `<tr><th scope="row">${esc(m.name)}</th><td><code>${m.id}</code></td><td>${esc(m.org)}</td><td>${esc(m.about)}</td></tr>`).join('')}</tbody></table></div>
  <p>Spread (largest minus smallest) describes disagreement between models. It is never presented as a probability.</p>
  <h2>3D map</h2>
  <p><a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre GL JS</a> with <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> basemaps, keyless <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">AWS Terrain Tiles</a> for 3D terrain, ski trails from <a href="https://openskimap.org/" target="_blank" rel="noopener noreferrer">OpenSkiMap</a>, radar from the <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener noreferrer">Iowa Environmental Mesonet</a>, and avalanche zones from CAIC. The snow field and the forecast part of the radar timeline come from a model grid that a GitHub Action rebuilds every 6 hours (data/grid.json). The freezing-level shading uses one statewide median per day, so it is approximate in any single valley.</p>
  <h2>Privacy</h2>
  <p>Units, theme, animations, and favorites are stored in this browser only. There are no accounts and no API keys. Guestbook entries are public.</p></div>`, {iconName: 'doc'});
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
  if (app.route.view !== 'map') { stopTimer('days'); stopTimer('radar'); mapModule?.pause(true); } else mapModule?.pause(false);
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
/** The ticker runs on every page, always from all resorts regardless of the table filter. */
function updateTicker() {
  const cols = columns(), rows = LOCS.map(loc => ({loc, d: app.data[loc.id], t: totals(loc, app.data[loc.id], cols)}));
  setTicker(tickerItems(stormFacts(rows, cols)));
}
function rerender() {
  renderStatus();
  updateTicker();
  const v = app.route.view;
  if (v === 'home') { $('winTitle').textContent = "Snowfall - ALEC'S SNOW PAGE"; renderHome(); }
  else if (v === 'resort') renderResort(); else if (v === 'map') renderMap(); else renderAbout();
}
function effectiveTheme() { return prefs.theme || (darkQuery.matches ? 'dark' : 'light'); }
function applyPrefs() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme;
  const anim = prefs.anim && !reduceMotion.matches;
  document.documentElement.classList.toggle('anim-on', anim);
  document.documentElement.classList.toggle('anim-off', !anim);
  $('themeButton').textContent = `Theme: ${effectiveTheme() === 'dark' ? 'High Contrast Black' : 'Windows Standard'}`;
  $('animButton').textContent = `Animations: ${prefs.anim ? 'ON' : 'OFF'}${reduceMotion.matches ? ' (system reduces motion)' : ''}`;
  document.querySelectorAll('[data-units-toggle]').forEach(b => { b.textContent = b.closest('.tray') ? (imperial() ? 'in' : 'cm') : `Units: ${imperial() ? 'inches' : 'centimeters'}`; });
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
  const t = e.target.closest('button, [data-tip]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.sort) { const k = ds.sort; app.sort = {key: k, dir: app.sort.key === k ? -app.sort.dir : k === 'name' ? 1 : -1}; renderHome(); }
  else if (ds.show) { app.show = ds.show; renderHome(); }
  else if (ds.past) { prefs.past = ds.past; persist(); rerender(); }
  else if (ds.lead) { app.rankLead = ds.lead; renderResort(); }
  else if (ds.fav) toggleFav(ds.fav);
  else if ('unitsToggle' in ds) { prefs.units = imperial() ? 'metric' : 'imperial'; persist(); applyPrefs(); rerender(); }
  else if (ds.band) location.hash = `#/resort/${app.route.id}${ds.band === 'point' ? '' : '?band=' + ds.band}`;
  else if (ds.mode) { stopTimer('days'); app.map.mode = ds.mode; renderMap(); }
  else if (ds.focus) mapModule?.focus(ds.focus);
  else if (ds.action === 'refresh') refresh(true);
  else if (ds.action === 'share') share();
  else if (t.id === 'themeButton') { prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; persist(); applyPrefs(); }
  else if (t.id === 'animButton') { prefs.anim = !prefs.anim; persist(); applyPrefs(); }
  else if (t.id === 'playDays') togglePlayDays();
  else if (t.id === 'playRadar') togglePlayRadar();
  else if (t.id === 'tourButton') stormTour();
  else if (t.id === 'resetView') mapModule?.resetView();
  else if (ds.tip && e.pointerType !== 'mouse') showTip(e.clientX, e.clientY, ds.tip); // tap shows the readout on touch
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.layer) { app.map.layers[t.dataset.layer] = t.checked; if (t.dataset.layer === 'radar' && !t.checked) stopTimer('radar'); renderMap(); }
  else if (t.id === 'accumBox') { app.map.accum = t.checked; app.map.mode = 'future'; renderMap(); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'homeSearch') { app.query = t.value; const pos = t.selectionStart; renderHome(); const s = $('homeSearch'); s.focus(); s.setSelectionRange(pos, pos); }
  else if (t.id === 'daySlider') { stopTimer('days'); app.map.mode = 'future'; app.map.day = +t.value; renderMap(); }
  else if (t.id === 'radarSlider') { stopTimer('radar'); app.map.radarIndex = +t.value; renderMap(); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'guestForm') return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try { toast(await submitGuestbook(e.target)); if (!e.target.querySelector('[name="website"]').value) renderHome(); }
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
window.addEventListener('hashchange', route);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (app.route.view === 'resort') renderResort(); }, 200); });
darkQuery.addEventListener('change', applyPrefs);
reduceMotion.addEventListener('change', applyPrefs);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', () => refresh());

// Console and automated-check surface.
window.Powcast = {app, prefs, LOCS, MODELS, totals, refresh, mapOptions};

initChrome();
restoreCache();
applyPrefs();
route();
refresh();
loadExtras();
loadAvalanche();
setInterval(() => { renderStatus(); if (!document.hidden) refresh(); }, 10 * 60000);
