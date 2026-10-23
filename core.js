// Pure forecast logic: time zones, null-safe accumulation, parsing, model spread, and the network policy.
// No DOM access here, so `node --test test/core.test.mjs` can verify it without a browser.

export const HOUR = 3600000;
export const TZ = 'America/Denver';

export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const numeric = v => v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const round = (v, digits = 1) => finite(v) ? Number(v.toFixed(digits)) : null;

/* ---- DST-aware Colorado calendar. The API returns UTC epochs. ---- */
const formatters = new Map();
function partsFormatter(zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}));
  return formatters.get(zone);
}
export function localParts(ms = Date.now(), zone = TZ) {
  return Object.fromEntries(partsFormatter(zone).formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function localDate(ms = Date.now()) { const p = localParts(ms); return `${p.year}-${p.month}-${p.day}`; }
export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function shiftDate(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function zonedEpoch(date, time = '00:00', zone = TZ) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm, ss = 0] = time.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, ss);
  let estimate = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(estimate, zone);
    const diff = target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    if (!diff) break;
    estimate += diff;
  }
  return estimate;
}
export function parseProviderDate(value, zone = TZ) {
  if (!value) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value);
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(s)) { const n = Date.parse(s); return finite(n) ? n : null; }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) { try { return zonedEpoch(m[1], m[2], zone); } catch { return null; } }
  return null;
}
/**
 * Validity window of an avalanche.org map-layer bulletin. Its start_date and end_date carry no offset but are
 * UTC: the products API gives the same clock values with +00:00 (verified 2026-10-21, product 185553). The
 * feature's `timezone` names the center, not the timestamps. Level is 0 unless the bulletin is in force.
 */
export function bulletinWindow(props, now = Date.now()) {
  const start = parseProviderDate(props?.start_date, 'UTC'), end = parseProviderDate(props?.end_date, 'UTC');
  const valid = finite(start) && finite(end) && start <= now && end > now, n = numeric(props?.danger_level);
  return {start, end, valid, level: valid && Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0};
}
/** Calendar day in Colorado as [start, end) epochs; 23 or 25 hours on DST days. */
export function dayBounds(date) { return [zonedEpoch(date), zonedEpoch(shiftDate(date, 1))]; }

/* ---- Null-safe accumulation: missing never becomes zero. ----
 * Hourly snowfall at timestamp t is the amount in (t - 1h, t].
 * Fractional boundary hours are apportioned uniformly.
 */
export function integrate(hours, start, end, field = 'snow') {
  if (!Array.isArray(hours) || !finite(start) || !finite(end) || end <= start) return {value: null, partial: null, coverage: 0, complete: false};
  let total = 0, covered = 0;
  for (const h of hours) {
    const overlap = Math.max(0, Math.min(end, h.t) - Math.max(start, h.t - HOUR));
    if (!overlap) continue;
    if (finite(h[field]) && h[field] >= 0) { total += h[field] * overlap / HOUR; covered += overlap; }
  }
  const coverage = Math.min(1, covered / (end - start)), complete = coverage > 0.999999;
  return {value: complete ? total : null, partial: covered ? total : null, coverage, complete};
}
export function dailyTotal(hours, date, field = 'snow') { const [a, b] = dayBounds(date); return integrate(hours, a, b, field).value; }
/** Instantaneous samples inside [start, end); null unless every hour is present. */
export function sampleStat(hours, start, end, field, fn = 'max') {
  if (!Array.isArray(hours)) return null;
  const vals = hours.filter(h => h.t >= start && h.t < end).map(h => h[field]);
  if (vals.length < Math.round((end - start) / HOUR) || !vals.every(finite)) return null;
  return fn === 'min' ? Math.min(...vals) : Math.max(...vals);
}
/** Sum of values, or null when any part is missing. */
export function sumComplete(values) { return values.length && values.every(finite) ? values.reduce((s, v) => s + v, 0) : null; }

/* ---- Network retry policy, pure so it can be tested without a network ---- */
/** Runs task(attempt) up to 1 + retries times, waiting baseMs, then 3 x baseMs, between tries. An error marked retryable: false is thrown at once. */
export async function withRetry(task, {retries = 2, baseMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await task(attempt); }
    catch (e) { if (attempt >= retries || e?.retryable === false) throw e; await sleep(baseMs * 3 ** attempt); }
  }
}
/** HTTP statuses worth another try: timeouts, rate limits and server errors. Other 4xx answers will not change. */
export const retryableStatus = status => status === 408 || status === 429 || status >= 500;
/**
 * GET with a timeout on every attempt (body included) and the withRetry policy. Network failures, timeouts,
 * unreadable bodies and retryableStatus answers are retried; other HTTP errors and provider errors
 * (Open-Meteo's {error: true, reason}) are not. Errors carry a short message fit for the page.
 */
export function request(url, {as = 'json', timeout = 15000, retries = 2, baseMs = 1000, init = {}, fetchImpl = (...a) => fetch(...a), sleep} = {}) {
  const attempt = async () => {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetchImpl(url, {...init, signal: ctrl.signal});
      if (!r.ok) {
        const reason = r.status < 500 ? (await r.json().catch(() => null))?.reason : null;
        throw Object.assign(new Error(reason ? `${reason} (HTTP ${r.status})` : `HTTP ${r.status}`), {retryable: retryableStatus(r.status)});
      }
      const body = as === 'text' ? await r.text() : await r.json();
      if (as === 'json' && body?.error === true) throw Object.assign(new Error(body.reason || 'Provider error'), {retryable: false});
      return body;
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('Request timed out');
      if (e instanceof SyntaxError) throw new Error('Unreadable response');
      if (e instanceof TypeError) throw new Error('Network unavailable'); // fetch's own failure: offline, DNS, CORS
      throw e;
    } finally { clearTimeout(timer); }
  };
  return withRetry(attempt, {retries, baseMs, ...(sleep ? {sleep} : {})});
}

/* ---- Hash routes ---- */
/**
 * The view for a location hash, or null when the hash is not a route (for example #main from the skip link),
 * so the caller keeps the current view. ids: the known location ids, for links from Powcast v2.
 */
export function parseRoute(hash, ids) {
  const raw = String(hash || '').replace(/^#/, '');
  if (/(^|&)(view|loc)=/.test(raw)) {
    const p = new URLSearchParams(raw), id = p.get('loc');
    return ids.has(id) && (p.get('report') === '1' || p.get('view') === 'detail') ? {view: 'resort', id} : {view: p.get('view') === 'map' ? 'map' : 'home'};
  }
  if (raw && !raw.startsWith('/')) return null;
  const [path, query = ''] = raw.split('?'), parts = path.split('/').filter(Boolean), q = new URLSearchParams(query);
  if (parts[0] === 'resort' && parts[1]) return {view: 'resort', id: parts[1], band: q.get('band')};
  if (parts[0] === 'map') return {view: 'map', focus: q.get('focus')};
  if (parts[0] === 'about') return {view: 'about'};
  return {view: 'home'};
}

/* ---- Open-Meteo parsing ---- */
const FIELDS = {precipitation: 'precip', temperature_2m: 'temp', temperature_600hPa: 't600', temperature_500hPa: 't500', wind_speed_10m: 'wind', wind_gusts_10m: 'gust', freezing_level_height: 'freezing', rain: 'rain', weather_code: 'code', precipitation_probability: 'pop'};
function snowFactor(unit) { if (unit === 'cm') return 1; if (unit === 'inch') return 2.54; throw new Error('Unrecognized snowfall unit'); }
function checkTimeline(hours) {
  if (hours.some((h, i) => i > 0 && h.t - hours[i - 1].t < HOUR)) throw new Error('Duplicate or non-hourly forecast timestamps');
  return hours;
}
export function normalizeForecast(raw, {fetchedAt = Date.now(), variant = 'point'} = {}) {
  const h = raw?.hourly, u = raw?.hourly_units || {};
  if (!Array.isArray(h?.time) || h.time.length < 2) throw new Error('Forecast response has no hourly timeline');
  if (!Array.isArray(h.snowfall)) throw new Error('Forecast response has no snowfall');
  const sf = snowFactor(u.snowfall);
  if (u.temperature_2m && u.temperature_2m !== '\u00b0C') throw new Error('Unexpected temperature unit');
  if (u.wind_speed_10m && !['km/h', 'kmh'].includes(u.wind_speed_10m)) throw new Error('Unexpected wind unit');
  const nonneg = n => n !== null && n >= 0 ? n : null;
  const hours = h.time.map((t, i) => {
    if (!finite(t)) throw new Error('Expected UTC epoch timestamps');
    const s = nonneg(numeric(h.snowfall[i]));
    const row = {t: t * 1000, snow: s === null ? null : s * sf};
    for (const [key, name] of Object.entries(FIELDS)) if (h[key]) {
      const v = numeric(h[key][i]);
      row[name] = ['wind', 'gust', 'rain', 'precip'].includes(name) ? nonneg(v) : v;
    }
    return row;
  }).sort((a, b) => a.t - b.t);
  return {hours: checkTimeline(hours), fetchedAt, lat: numeric(raw.latitude), lon: numeric(raw.longitude), elevation: numeric(raw.elevation), variant};
}
/** Multi-model response: Open-Meteo suffixes each variable with the model id. */
export function normalizeModels(raw, ids) {
  const h = raw?.hourly, u = raw?.hourly_units || {};
  if (!Array.isArray(h?.time)) throw new Error('Model response has no hourly timeline');
  const out = {};
  for (const id of ids) {
    const key = `snowfall_${id}`;
    if (!Array.isArray(h[key])) { out[id] = null; continue; }
    const sf = snowFactor(u[key]);
    out[id] = checkTimeline(h.time.map((t, i) => { const v = numeric(h[key][i]); return {t: t * 1000, snow: v !== null && v >= 0 ? v * sf : null}; }).sort((a, b) => a.t - b.t));
  }
  return out;
}
/** Last hour with a value: the model's effective horizon at this point. */
export function horizon(hours) { for (let i = (hours?.length || 0) - 1; i >= 0; i--) if (finite(hours[i].snow)) return hours[i].t; return null; }

/* ---- Model spread: disagreement between models, never a probability. ---- */
export function spreadStats(values) {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (v.length < 2) return {n: v.length, min: v[0] ?? null, max: v[0] ?? null, median: v[0] ?? null, spread: null, label: 'Too few models'};
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const min = v[0], max = v.at(-1), spread = max - min;
  // Thresholds in cm: 0.25 cm ~ 0.1 in, 1.3 cm ~ 0.5 in, 5 cm ~ 2 in.
  const label = max < 0.25 ? 'All dry' : spread <= Math.max(1.3, 0.35 * median) ? 'Tight' : spread > Math.max(5, median) ? 'Wide' : 'Moderate';
  return {n: v.length, min, max, median, spread, label};
}

/* ---- Snow-to-liquid estimate (labeled estimate, never an observation). ----
 * Open-Meteo snowfall uses a fixed 0.7 cm per mm of water (7:1).
 * Kuchera-style ratio from the warmest temperature between the 2 m point and 500 hPa:
 *   T > 271.16 K: 12 + 2 (271.16 - T); otherwise 12 + (271.16 - T); clamped to 3..30.
 */
export const OPEN_METEO_CM_PER_MM = 0.7;
export function kucheraSLR(tMaxC) {
  if (!finite(tMaxC)) return null;
  const k = tMaxC + 273.15, d = 271.16 - k;
  return clamp(k > 271.16 ? 12 + 2 * d : 12 + d, 3, 30);
}
export function slrEstimate(hours, start, end) {
  let liquid = 0, adjusted = 0, any = false;
  for (const h of hours || []) {
    if (h.t <= start || h.t > end || !finite(h.snow) || h.snow <= 0) continue;
    const slr = kucheraSLR(Math.max(...[h.temp, h.t600, h.t500].filter(finite)));
    if (slr === null) return null; // no temperature at all for a snowing hour
    const mm = h.snow / OPEN_METEO_CM_PER_MM;
    liquid += mm; adjusted += mm * slr / 10; any = true;
  }
  if (!any) return {liquidMm: 0, snowCm: 0, ratio: null};
  return {liquidMm: liquid, snowCm: adjusted, ratio: adjusted * 10 / liquid};
}
/** Snow quality from snow-to-liquid ratio. Higher ratio = lighter, drier snow. */
export function qualityLabel(ratio) { return !finite(ratio) ? null : ratio >= 17 ? 'Blower' : ratio >= 13 ? 'Powder' : ratio >= 10 ? 'Average' : 'Heavy'; }

/* ---- NRCS SNOTEL: snow-depth changes are never called snowfall. ---- */
const STATION_UNITS = {SNWD: 'in', WTEQ: 'in', TMAX: 'degF'};
export function parseStationData(raw, triplet) {
  const item = Array.isArray(raw) ? raw.find(s => s.stationTriplet === triplet) : null;
  if (!item || !Array.isArray(item.data)) throw new Error('No matching station in response');
  const out = {};
  for (const block of item.data) {
    const element = block.stationElement?.elementCode;
    if (!STATION_UNITS[element] || block.error || block.stationElement?.storedUnitCode !== STATION_UNITS[element]) continue;
    const keep = v => element === 'TMAX' ? numeric(v) : numeric(v) >= 0 ? numeric(v) : null; // temperatures go below zero
    out[element] = (block.values || []).filter(v => validDate(String(v.date || '').slice(0, 10)))
      .map(v => ({date: String(v.date).slice(0, 10), value: keep(v.value), median: keep(v.median)}))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

/**
 * Snow-to-water ratio for the water term of the station estimate, and the daily high above which water is not
 * counted as snow (rain). Calibration knobs, not constants of nature. At the four Colorado SNOTEL stations with an
 * observer snow board within 5 km and 1,000 ft, Dec to Mar of water years 2021 to 2026 (23 station-seasons,
 * 2,560 in of board snow): depth gain alone caught 61% of board snowfall; this rule (10:1, 34F) 84%, with the
 * lowest daily error (0.70 in) and no season above 128%; ungated 93% but up to 146% in one season; a 36F or
 * 38F gate 86% or 88% but up to 137%. No variant met both of the research report's tests (85% to 105% pooled,
 * no season above 130%); 34F was kept as the only one under 130%, 1 point below the band, with the lowest error.
 * Re-check each autumn: node scripts/check-station-estimate.mjs
 */
export const SNOTEL_SNOW_RATIO = 10;
export const SNOTEL_WATER_MAX_F = 34;

/**
 * Station estimate of new snow at a SNOTEL station for one calendar day, in cm.
 * NRCS daily values are end-of-day readings (the value dated D equals the hourly reading at
 * midnight ending D), so snow during D is depth(D) - depth(D - 1).
 * Two terms, and the larger wins:
 *   depth: the depth gain, counted only when it is at least 1 in and the water did not fall
 *          (the sensor jitters by about an inch); otherwise 0.
 *   water: ratio x the water gain, counted only when the day's high was at or below maxTempF.
 *          Water is not lost to settling, so it recovers snow that settles while a storm is still falling.
 * Missing depth on either day makes the day null. Missing water or temperature only drops the water term.
 */
export function measuredDay(station, date, {ratio = SNOTEL_SNOW_RATIO, maxTempF = SNOTEL_WATER_MAX_F} = {}) {
  const get = (el, d) => station?.[el]?.find(v => v.date === d)?.value ?? null;
  const prev = shiftDate(date, -1);
  const d1 = get('SNWD', date), d0 = get('SNWD', prev);
  if (!finite(d1) || !finite(d0)) return null;
  const w1 = get('WTEQ', date), w0 = get('WTEQ', prev), tmaxF = get('TMAX', date);
  const dDepth = d1 - d0, dSwe = finite(w1) && finite(w0) ? round(w1 - w0, 2) : null;
  const depthIn = dDepth >= 1 && (dSwe === null || dSwe >= 0) ? dDepth : 0;
  const cold = finite(tmaxF) && tmaxF <= maxTempF, gained = dSwe !== null && dSwe > 0;
  const waterIn = gained && cold ? ratio * dSwe : 0;
  const snowIn = Math.max(depthIn, waterIn), method = snowIn === 0 ? null : waterIn > depthIn ? 'water' : 'depth';
  // Measured quality is depth gain over water gain, so only on cold depth days: when the water term won, the depth
  // gain lost snow to settling and would read too heavy; on a warm or unknown day the water may include rain.
  const q = method === 'depth' && cold && depthIn >= 2 && dSwe >= 0.1 ? depthIn / dSwe : null;
  // Why the water term did not count, when water rose: 'warm' (high above maxTempF) or 'no-temp' (no reading).
  const waterGated = gained && !cold ? (finite(tmaxF) ? 'warm' : 'no-temp') : null;
  return {cm: snowIn * 2.54, method, depthIn: d1, depthChangeIn: dDepth, sweChangeIn: dSwe, tmaxF, waterGated, ratio: q, quality: qualityLabel(q)};
}

/**
 * NOHRSC analysis point values (hires/manifest.json past.points) by Colorado calendar day, in cm. Each 24 h
 * window runs 12Z to 12Z (5 or 6 AM to 5 or 6 AM local), so it is filed under the local date it starts on.
 */
export function analysisByDate(days) {
  const out = {};
  for (const d of Array.isArray(days) ? days : []) {
    const from = Date.parse(d?.from);
    if (finite(from)) out[localDate(from)] = finite(d.inches) && d.inches >= 0 ? d.inches * 2.54 : null;
  }
  return out;
}

/** First day of the water year (Oct 1) that contains `date`; NRCS season totals start here. */
export function waterYearStart(date) { const y = +date.slice(0, 4); return `${date.slice(5) >= '10-01' ? y : y - 1}-10-01`; }
/**
 * Season-to-date station estimate at a SNOTEL station: the sum of measuredDay over [start, end].
 * Missing days are counted, never treated as zero, so a total with missing days is a lower bound.
 */
export function seasonSnow(station, start, end, opts) {
  let cm = 0, days = 0, missing = 0;
  for (let d = start; d <= end; d = shiftDate(d, 1)) { const m = measuredDay(station, d, opts); days++; if (m) cm += m.cm; else missing++; }
  return {cm: days > missing ? cm : null, days, missing};
}
/** Percentile of x among sorted historical values: share below, plus half of ties (mid-rank), 0 to 100. */
export function percentileRank(sorted, x) {
  if (!Array.isArray(sorted) || !sorted.length || !finite(x)) return null;
  let below = 0, equal = 0;
  for (const v of sorted) { if (v < x) below++; else if (v === x) equal++; }
  return 100 * (below + equal / 2) / sorted.length;
}

/* ---- Small CSV reader for the owner-edited lists in data/ ---- */
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ''); // some editors add a byte-order mark, which would rename the first column
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter(r => r.some(v => v.trim()));
  const head = clean.shift()?.map(h => h.trim()) || [];
  return clean.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/**
 * Same pick for everyone on a given Colorado date, and no repeats until the whole list is used.
 * Each pass through the list uses a different shuffle, seeded by the pass number.
 */
export function dailyPick(list, date) {
  if (!list.length) return null;
  const day = Math.floor(Date.parse(date + 'T12:00:00Z') / 86400000), pass = Math.floor(day / list.length);
  let seed = (pass * 2654435761) >>> 0;
  const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const order = list.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return list[order[day % list.length]];
}

/* ---- CAIC polygons ---- */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(point, rings) { return !!rings?.length && pointInRing(point, rings[0]) && !rings.slice(1).some(r => pointInRing(point, r)); }
export function containsPoint(feature, point) {
  const g = feature?.geometry;
  return g?.type === 'Polygon' ? pointInPolygon(point, g.coordinates) : g?.type === 'MultiPolygon' ? g.coordinates.some(p => pointInPolygon(point, p)) : false;
}

/* ---- Map snowfall colors (inches), the common NWS/OpenSnow breaks. scripts/build_hires.py uses the same list. ---- */
export const SNOW_RAMP = [[0.1, '#c0d8e6'], [1, '#66abd3'], [3, '#00278f'], [6, '#eeef92'], [8, '#fcc80f'], [10, '#ff8300'],
  [12, '#db1c00'], [18, '#9e0101'], [24, '#750000'], [30, '#c9c8fb'], [36, '#9c8bd6'], [48, '#805daa'], [60, '#56226f'], [72, '#340439'], [100, '#3fe1ff']];
/** Radar reflectivity colors (dBZ), NWS standard; the HRRR forecast frames use the same list. */
export const RADAR_RAMP = [[10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'],
  [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd'], [70, '#9854c6']];

/* ---- Table color bins for snowfall, in cm so both unit systems share colors. ---- */
export const BIN_EDGES_CM = [0.25, 2.54, 7.62, 15.24, 25.4, 38.1, 60.96]; // 0.1, 1, 3, 6, 10, 15, 24 in
export function binIndex(cm) { if (!finite(cm)) return null; let i = 0; while (i < BIN_EDGES_CM.length && cm >= BIN_EDGES_CM[i]) i++; return i; }
