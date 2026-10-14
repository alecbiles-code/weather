// Pure forecast logic: time zones, null-safe accumulation, parsing, model spread.
// No DOM access here, so `node --test test/` can verify it without a browser.

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

/* ---- Open-Meteo parsing ---- */
const FIELDS = {temperature_2m: 'temp', temperature_600hPa: 't600', temperature_500hPa: 't500', wind_speed_10m: 'wind', wind_gusts_10m: 'gust', freezing_level_height: 'freezing', rain: 'rain', weather_code: 'code', precipitation_probability: 'pop'};
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
      row[name] = ['wind', 'gust', 'rain'].includes(name) ? nonneg(v) : v;
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
export function densityLabel(ratio) { return !finite(ratio) ? null : ratio < 10 ? 'Dense' : ratio <= 15 ? 'Average' : 'Light'; }

/* ---- NRCS SNOTEL: snow-depth changes are never called snowfall. ---- */
export function parseStationData(raw, triplet) {
  const item = Array.isArray(raw) ? raw.find(s => s.stationTriplet === triplet) : null;
  if (!item || !Array.isArray(item.data)) throw new Error('No matching station in response');
  const out = {};
  for (const block of item.data) {
    const element = block.stationElement?.elementCode;
    if (!['SNWD', 'WTEQ'].includes(element) || block.error || block.stationElement?.storedUnitCode !== 'in') continue;
    out[element] = (block.values || []).filter(v => validDate(String(v.date || '').slice(0, 10)))
      .map(v => ({date: String(v.date).slice(0, 10), value: numeric(v.value) >= 0 ? numeric(v.value) : null, median: numeric(v.median) >= 0 ? numeric(v.median) : null}))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
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

/* ---- Color bins for snowfall, in cm so both unit systems share colors. ---- */
export const BIN_EDGES_CM = [0.25, 2.54, 7.62, 15.24, 25.4, 38.1, 60.96]; // 0.1, 1, 3, 6, 10, 15, 24 in
export function binIndex(cm) { if (!finite(cm)) return null; let i = 0; while (i < BIN_EDGES_CM.length && cm >= BIN_EDGES_CM[i]) i++; return i; }
