// Run: node --test test/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {HOUR, integrate, dailyTotal, dayBounds, zonedEpoch, sumComplete, normalizeForecast, normalizeModels, spreadStats, kucheraSLR, slrEstimate, binIndex, horizon, measuredDay, qualityLabel, parseCSV, dailyPick, waterYearStart, seasonSnow, percentileRank,
  parseProviderDate, bulletinWindow, parseStationData, analysisByDate, withRetry, retryableStatus, request, parseRoute, SNOTEL_SNOW_RATIO, SNOTEL_WATER_MAX_F} from '../core.js';
import {parseValue, classify, nearestBoard, lastReports, miles} from '../scripts/build-boards.mjs';
import {LOCS} from '../locations.js';

const hoursFrom = (start, values) => values.map((snow, i) => ({t: start + (i + 1) * HOUR, snow}));

test('missing hours make a window incomplete, never zero', () => {
  const start = Date.UTC(2026, 0, 10);
  const r = integrate(hoursFrom(start, [1, null, 1]), start, start + 3 * HOUR);
  assert.equal(r.value, null);
  assert.equal(r.partial, 2);
  assert.equal(integrate(hoursFrom(start, [1, 0, 1]), start, start + 3 * HOUR).value, 2);
});

test('calendar days follow Colorado DST (25 hour day on 2026-11-01)', () => {
  const [a, b] = dayBounds('2026-11-01');
  assert.equal((b - a) / HOUR, 25);
  assert.equal(a, zonedEpoch('2026-11-01'));
  const hours = hoursFrom(a, Array(25).fill(0.4));
  assert.ok(Math.abs(dailyTotal(hours, '2026-11-01') - 10) < 1e-9);
  assert.equal(dailyTotal(hours.slice(0, 24), '2026-11-01'), null);
});

test('sumComplete refuses partial totals', () => {
  assert.equal(sumComplete([1, 2, 3]), 6);
  assert.equal(sumComplete([1, null]), null);
  assert.equal(sumComplete([]), null);
});

test('normalizeForecast converts inches and keeps nulls', () => {
  const d = normalizeForecast({hourly: {time: [3600, 7200], snowfall: [1, null], temperature_2m: [-5, null]}, hourly_units: {snowfall: 'inch', temperature_2m: '°C'}});
  assert.equal(d.hours[0].snow, 2.54);
  assert.equal(d.hours[1].snow, null);
  assert.equal(d.hours[0].temp, -5);
  assert.throws(() => normalizeForecast({hourly: {time: [1, 2], snowfall: [0, 0]}, hourly_units: {snowfall: 'mm'}}));
});

test('normalizeModels reads per-model suffixed keys', () => {
  const m = normalizeModels({hourly: {time: [3600, 7200, 10800], snowfall_a: [1, 2, null], snowfall_b: [0, 0, 0]}, hourly_units: {snowfall_a: 'cm', snowfall_b: 'cm'}}, ['a', 'b', 'c']);
  assert.equal(m.a[1].snow, 2);
  assert.equal(m.c, null);
  assert.equal(horizon(m.a), 7200 * 1000);
});

test('spread labels describe disagreement', () => {
  assert.equal(spreadStats([5]).label, 'Too few models');
  assert.equal(spreadStats([0, 0.1]).label, 'All dry');
  assert.equal(spreadStats([10, 11, 12]).label, 'Tight');
  assert.equal(spreadStats([0, 2, 30]).label, 'Wide');
  assert.equal(spreadStats([1, 3, 4, 10]).median, 3.5);
});

test('Kuchera ratio rises as the column cools', () => {
  assert.ok(kucheraSLR(-15) > kucheraSLR(-5));
  assert.ok(kucheraSLR(0) < 12);
  assert.equal(kucheraSLR(-60), 30);
  const start = Date.UTC(2026, 0, 1);
  const est = slrEstimate([{t: start + HOUR, snow: 0.7, temp: -12, t600: -14, t500: -25}], start, start + HOUR);
  assert.ok(Math.abs(est.liquidMm - 1) < 1e-9);
  assert.ok(est.ratio > 12);
  assert.equal(slrEstimate([{t: start + HOUR, snow: 0.7}], start, start + HOUR), null);
});

test('color bins', () => {
  assert.equal(binIndex(null), null);
  assert.equal(binIndex(0), 0);
  assert.equal(binIndex(2.54), 2);
  assert.equal(binIndex(100), 7);
});

test('SNOTEL measured snow uses end-of-day readings and ignores sensor jitter', () => {
  const st = {SNWD: [{date: '2026-01-01', value: 20}, {date: '2026-01-02', value: 32}, {date: '2026-01-03', value: 31}, {date: '2026-01-04', value: 33}],
    WTEQ: [{date: '2026-01-01', value: 5.0}, {date: '2026-01-02', value: 5.8}, {date: '2026-01-03', value: 5.8}, {date: '2026-01-04', value: 5.7}],
    TMAX: [{date: '2026-01-02', value: 20}]}; // a cold day, so the measured ratio is snow
  const jan2 = measuredDay(st, '2026-01-02');
  assert.ok(Math.abs(jan2.cm - 12 * 2.54) < 1e-9);
  assert.equal(jan2.quality, 'Powder'); // 12 in from 0.8 in of water = 15:1
  assert.equal(measuredDay(st, '2026-01-03').cm, 0); // settling
  assert.equal(measuredDay(st, '2026-01-04').cm, 0); // +2 in but water fell: sensor jitter
  assert.equal(measuredDay(st, '2026-01-01'), null); // no previous reading
});

test('season snow sums measured days and counts missing ones instead of zeroing them', () => {
  const st = {SNWD: [{date: '2026-01-01', value: 20}, {date: '2026-01-02', value: 32}, {date: '2026-01-03', value: 31}, {date: '2026-01-04', value: 36}],
    WTEQ: [{date: '2026-01-01', value: 5.0}, {date: '2026-01-02', value: 5.8}, {date: '2026-01-03', value: 5.8}, {date: '2026-01-04', value: 6.1}]};
  const s = seasonSnow(st, '2026-01-02', '2026-01-05');
  assert.ok(Math.abs(s.cm - 17 * 2.54) < 1e-9); // 12 in + 0 (settling) + 5 in; Jan 5 has no reading
  assert.equal(s.days, 4);
  assert.equal(s.missing, 1);
  assert.equal(seasonSnow(st, '2026-01-06', '2026-01-07').cm, null); // nothing measured is not zero
  assert.equal(waterYearStart('2026-10-19'), '2026-10-01');
  assert.equal(waterYearStart('2027-03-05'), '2026-10-01');
  assert.equal(waterYearStart('2026-09-30'), '2025-10-01');
});

test('percentile rank uses mid-rank for ties', () => {
  assert.equal(percentileRank([1, 2, 3, 4], 5), 100);
  assert.equal(percentileRank([1, 2, 3, 4], 0), 0);
  assert.equal(percentileRank([1, 2, 3, 4], 3), 62.5); // 2 below, 1 tie
  assert.equal(percentileRank([0, 0, 0, 0], 0), 50);
  assert.equal(percentileRank([], 1), null);
  assert.equal(percentileRank([1, 2], null), null);
});

test('quality names', () => {
  assert.equal(qualityLabel(20), 'Blower');
  assert.equal(qualityLabel(14), 'Powder');
  assert.equal(qualityLabel(11), 'Average');
  assert.equal(qualityLabel(7), 'Heavy');
  assert.equal(qualityLabel(null), null);
});

test('CSV with quotes and commas', () => {
  const rows = parseCSV('first_name,home\nAlec,"Denver, Colorado"\r\nSophia,"Say ""hi"""\n\n');
  assert.deepEqual(rows, [{first_name: 'Alec', home: 'Denver, Colorado'}, {first_name: 'Sophia', home: 'Say "hi"'}]);
});

test('daily pick is stable per date and covers the list before repeating', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(dailyPick(list, '2026-10-14'), dailyPick(list, '2026-10-14'));
  const start = Math.ceil(Date.parse('2026-10-14T12:00:00Z') / 86400000 / 5) * 5; // first day of a pass
  const seen = new Set();
  for (let i = 0; i < 5; i++) seen.add(dailyPick(list, new Date((start + i) * 86400000).toISOString().slice(0, 10)));
  assert.equal(seen.size, 5);
  assert.equal(dailyPick([], '2026-10-14'), null);
});

test('CSV ignores a byte-order mark', () => {
  assert.deepEqual(parseCSV('﻿fact\r\nBurrito is the best food.\r\n'), [{fact: 'Burrito is the best food.'}]);
});

/* ---- Avalanche bulletin times (bug audit 3.1): the map-layer feed's offset-less times are UTC ---- */
// Feature properties exactly as api.avalanche.org/v2/public/products/map-layer/CAIC served them on 2026-10-21.
const CAIC_FEATURE = {name: 'CAIC zone', center: 'Colorado Avalanche Information Center', center_link: 'https://avalanche.state.co.us/', timezone: 'America/Denver', center_id: 'CAIC', state: 'CO', off_season: false,
  travel_advice: 'Watch for signs of unstable snow such as recent avalanches, cracking in the snow, and audible collapsing. Avoid traveling on or under similar slopes.',
  danger: 'no rating', danger_level: -1, color: '#888888', stroke: '#104efb', font_color: '#ffffff', link: 'https://avalanche.state.co.us/',
  start_date: '2026-10-21T22:30:00', end_date: '2026-10-31T22:30:00', fillOpacity: 0.5, fillIncrement: 0.1, warning: {product: null}};
// The same bulletin from the products API (id 185553), which states the offset.
const CAIC_PRODUCT = {id: 185553, published_time: '2026-10-21T22:30:00+00:00', expires_time: '2026-10-31T22:30:00+00:00'};

test('bulletin times from the real CAIC feed are read as UTC, matching the products API', () => {
  const w = bulletinWindow(CAIC_FEATURE, Date.parse('2026-10-21T23:00:00Z'));
  assert.equal(w.start, parseProviderDate(CAIC_PRODUCT.published_time));
  assert.equal(w.end, parseProviderDate(CAIC_PRODUCT.expires_time));
  assert.equal(w.start, Date.UTC(2026, 9, 21, 22, 30)); // 4:30 PM MDT, not 10:30 PM
  assert.equal(w.valid, true); // half an hour after publication it is in force
  assert.equal(w.level, 0); // danger_level -1 is "no rating"
  // Read as Denver time (the old bug), the same bulletin would not start for another 6 hours.
  assert.ok(parseProviderDate(CAIC_FEATURE.start_date, CAIC_FEATURE.timezone) - w.start === 6 * HOUR);
});

test('an in-season rating shows from publication to expiry, in both daylight and standard time', () => {
  const rated = {...CAIC_FEATURE, danger_level: 3};
  assert.equal(bulletinWindow(rated, Date.parse('2026-10-21T22:30:00Z')).level, 3);
  assert.equal(bulletinWindow(rated, Date.parse('2026-10-21T22:29:59Z')).level, 0); // not yet issued
  assert.equal(bulletinWindow(rated, Date.parse('2026-10-31T22:30:00Z')).valid, false); // expired
  const winter = {...rated, start_date: '2026-12-15T13:30:00', end_date: '2026-12-16T13:30:00'}; // 6:30 AM MST
  assert.equal(bulletinWindow(winter, Date.parse('2026-12-15T07:00:00-07:00')).level, 3);
  assert.equal(bulletinWindow({...rated, danger_level: 9}, Date.parse('2026-10-22T00:00:00Z')).level, 0);
  assert.equal(bulletinWindow({}, Date.now()).valid, false);
});

/* ---- Station estimate (snow research rec 1): max(depth rule, ratio x water gain), water only on cold days ---- */
const station = (days) => ({SNWD: days.map(([date, d]) => ({date, value: d})), WTEQ: days.map(([date, , w]) => ({date, value: w})), TMAX: days.map(([date, , , t]) => ({date, value: t}))});

test('the water term recovers snow that settled during the storm', () => {
  const st = station([['2026-01-01', 30, 6.0, 20], ['2026-01-02', 33, 6.6, 22]]);
  const m = measuredDay(st, '2026-01-02');
  assert.equal(SNOTEL_SNOW_RATIO, 10);
  assert.ok(Math.abs(m.cm - 6 * 2.54) < 1e-9); // 10 x 0.6 in of water beats a 3 in depth gain
  assert.equal(m.method, 'water');
  assert.equal(m.quality, null); // a water-term day would only echo the assumed ratio
  assert.ok(Math.abs(measuredDay(st, '2026-01-02', {ratio: 12}).cm - 7.2 * 2.54) < 1e-9); // the ratio is a setting
});

test('the depth gain wins when it is larger, and keeps the measured quality', () => {
  const m = measuredDay(station([['2026-01-01', 20, 5.0, 15], ['2026-01-02', 32, 5.8, 18]]), '2026-01-02');
  assert.ok(Math.abs(m.cm - 12 * 2.54) < 1e-9); // 12 in beats 8 in from water
  assert.equal(m.method, 'depth');
  assert.equal(m.quality, 'Powder'); // 15:1
  const warm = measuredDay(station([['2026-01-01', 20, 5.0, 15], ['2026-01-02', 22, 5.8, 38]]), '2026-01-02');
  assert.equal(warm.quality, null); // a warm day's water may be rain, so the ratio is not called measured quality
});

test('warm days do not count water as snow', () => {
  const st = station([['2026-04-01', 40, 20.0, 30], ['2026-04-02', 39, 20.6, SNOTEL_WATER_MAX_F + 6]]);
  const m = measuredDay(st, '2026-04-02');
  assert.equal(m.cm, 0); // rain on snow: water up, depth down
  assert.equal(m.waterGated, 'warm');
  assert.equal(m.method, null);
  const edge = station([['2026-04-01', 40, 20.0, 30], ['2026-04-02', 40, 20.2, SNOTEL_WATER_MAX_F]]);
  assert.ok(Math.abs(measuredDay(edge, '2026-04-02').cm - 2 * 2.54) < 1e-9); // at the limit it still counts
});

test('missing water or temperature drops only the water term; missing depth drops the day', () => {
  const noTemp = {SNWD: [{date: '2026-01-01', value: 30}, {date: '2026-01-02', value: 33}], WTEQ: [{date: '2026-01-01', value: 6}, {date: '2026-01-02', value: 6.6}]};
  assert.ok(Math.abs(measuredDay(noTemp, '2026-01-02').cm - 3 * 2.54) < 1e-9);
  assert.equal(measuredDay(noTemp, '2026-01-02').waterGated, 'no-temp'); // said as a missing reading, never as a temperature
  assert.equal(measuredDay(noTemp, '2026-01-02').quality, null); // rain cannot be ruled out, so no measured ratio
  const noWater = {SNWD: noTemp.SNWD, TMAX: [{date: '2026-01-02', value: 10}]};
  const m = measuredDay(noWater, '2026-01-02');
  assert.ok(Math.abs(m.cm - 3 * 2.54) < 1e-9);
  assert.equal(m.sweChangeIn, null);
  assert.equal(measuredDay({WTEQ: noTemp.WTEQ, TMAX: noWater.TMAX}, '2026-01-02'), null); // no depth: missing, not zero
});

test('water gain is rounded so floating-point noise is not snow', () => {
  const m = measuredDay(station([['2026-01-01', 30, 5.7, 10], ['2026-01-02', 30, 5.8, 10]]), '2026-01-02');
  assert.equal(m.sweChangeIn, 0.1);
  assert.ok(Math.abs(m.cm - 1 * 2.54) < 1e-9);
  assert.equal(measuredDay(station([['2026-01-01', 30, 5.8, 10], ['2026-01-02', 30, 5.8, 10]]), '2026-01-02').cm, 0);
});

test('season totals use the station estimate', () => {
  const st = station([['2026-01-01', 30, 6.0, 20], ['2026-01-02', 33, 6.6, 22], ['2026-01-03', 32, 6.6, 25], ['2026-01-04', 38, 7.0, 28]]);
  const s = seasonSnow(st, '2026-01-02', '2026-01-04');
  assert.ok(Math.abs(s.cm - (6 + 0 + 6) * 2.54) < 1e-9); // water 6 in, settling 0, depth 6 in vs water 4 in
  assert.equal(s.missing, 0);
});

test('station parsing keeps below-zero highs but drops negative depths and wrong units', () => {
  const raw = [{stationTriplet: 'x', data: [
    {stationElement: {elementCode: 'TMAX', storedUnitCode: 'degF'}, values: [{date: '2026-01-02', value: -4}]},
    {stationElement: {elementCode: 'SNWD', storedUnitCode: 'in'}, values: [{date: '2026-01-02', value: -1}, {date: '2026-01-01', value: 30}]},
    {stationElement: {elementCode: 'WTEQ', storedUnitCode: 'mm'}, values: [{date: '2026-01-02', value: 10}]}]}];
  const st = parseStationData(raw, 'x');
  assert.equal(st.TMAX[0].value, -4);
  assert.deepEqual(st.SNWD.map(v => v.value), [30, null]); // sorted by date; negative depth is missing
  assert.equal(st.WTEQ, undefined);
  assert.throws(() => parseStationData(raw, 'y'));
});

/* ---- NOAA analysis points (snow research rec 2) ---- */
test('analysis days are filed under the local date their 12Z window starts', () => {
  const a = analysisByDate([{from: '2026-10-20T12:00:00Z', to: '2026-10-21T12:00:00Z', inches: 1}, {from: '2026-12-01T12:00:00Z', to: '2026-12-02T12:00:00Z', inches: null},
    {from: '2026-12-02T12:00:00Z', inches: -2}, {from: 'garbage', inches: 3}]);
  assert.deepEqual(Object.keys(a).sort(), ['2026-10-20', '2026-12-01', '2026-12-02']);
  assert.equal(a['2026-10-20'], 2.54);
  assert.equal(a['2026-12-01'], null); // missing stays missing
  assert.equal(a['2026-12-02'], null);
  assert.deepEqual(analysisByDate(undefined), {});
});

test('every resort has an on-mountain analysis point near its listed point; passes use the pass', () => {
  for (const l of LOCS) {
    if (l.kind !== 'resort') { assert.equal(l.sample, null); continue; }
    assert.ok(Array.isArray(l.sample), l.name);
    assert.ok(miles(l.lat, l.lon, ...l.sample) < 6, `${l.name} sample is ${miles(l.lat, l.lon, ...l.sample).toFixed(1)} mi away`);
    assert.ok(l.elev === l.top, `${l.name}: elev should be the summit`);
  }
});

/* ---- Network policy: timeouts and bounded retries ---- */
const noSleep = {sleep: async () => {}};
const reply = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => String(body)});

test('withRetry backs off 1 s then 3 s and stops after the retries', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('down'); }, {sleep: async ms => { waits.push(ms); }}), /down/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 3000]);
  calls = 0;
  assert.equal(await withRetry(async n => { calls++; if (n < 1) throw new Error('blip'); return 'ok'; }, noSleep), 'ok');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('bad request'), {retryable: false}); }, noSleep));
  assert.equal(calls, 1);
  assert.deepEqual([408, 429, 500, 503, 400, 404].map(retryableStatus), [true, true, true, true, false, false]);
});

test('request retries server errors and network failures, not client errors', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? reply(503, {}) : reply(200, {x: 1}));
  assert.deepEqual(await request('u', {fetchImpl: flaky, ...noSleep}), {x: 1});
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(request('u', {fetchImpl: async () => { calls++; return reply(404, 'nope'); }, ...noSleep}), /HTTP 404/);
  assert.equal(calls, 1);
  await assert.rejects(request('u', {fetchImpl: async () => reply(400, {error: true, reason: 'Bad latitude'}), ...noSleep}), /Bad latitude \(HTTP 400\)/);
  calls = 0;
  await assert.rejects(request('u', {fetchImpl: async () => { calls++; return reply(200, {error: true, reason: 'No data'}); }, ...noSleep}), /No data/);
  assert.equal(calls, 1); // a provider error will not change on retry
  calls = 0;
  await assert.rejects(request('u', {fetchImpl: async () => { calls++; throw new TypeError('Failed to fetch'); }, ...noSleep}), /Network unavailable/);
  assert.equal(calls, 3);
  await assert.rejects(request('u', {fetchImpl: async () => reply(200, '{garbled'), retries: 0}), /Unreadable response/);
  assert.equal(await request('u', {as: 'text', fetchImpl: async () => reply(200, 'a,b')}), 'a,b');
});

test('request times out a stalled response', async () => {
  const stall = (url, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));
  await assert.rejects(request('u', {fetchImpl: stall, timeout: 20, retries: 1, ...noSleep}), /Request timed out/);
});

/* ---- Routes (bug audit 3.3): the skip link's #main is not a route ---- */
test('hash routes, legacy links, and non-route hashes', () => {
  const ids = new Set(['vail']);
  assert.equal(parseRoute('#main', ids), null);
  assert.deepEqual(parseRoute('', ids), {view: 'home'});
  assert.deepEqual(parseRoute('#/', ids), {view: 'home'});
  assert.deepEqual(parseRoute('#/zzz', ids), {view: 'home'});
  assert.deepEqual(parseRoute('#/resort/vail?band=summit', ids), {view: 'resort', id: 'vail', band: 'summit'});
  assert.deepEqual(parseRoute('#/map?focus=vail', ids), {view: 'map', focus: 'vail'});
  assert.deepEqual(parseRoute('#/about', ids), {view: 'about'});
  assert.deepEqual(parseRoute('#view=map', ids), {view: 'map'});
  assert.deepEqual(parseRoute('#loc=vail&view=detail', ids), {view: 'resort', id: 'vail'});
  assert.deepEqual(parseRoute('#loc=nope&view=detail', ids), {view: 'home'});
});

/* ---- Nearest observer snow board (snow research rec 3) ---- */
test('ACIS values: trace, missing, multi-day accumulations', () => {
  assert.deepEqual(parseValue('T'), {value: 0, trace: true, accumulated: false});
  assert.deepEqual(parseValue('2.5'), {value: 2.5, trace: false, accumulated: false});
  assert.deepEqual(parseValue('4.0A'), {value: null, trace: false, accumulated: true});
  for (const v of ['M', 'S', '', null, undefined, 3]) assert.equal(parseValue(v).value, null);
});

test('board stations: observer networks only, with working links', () => {
  assert.deepEqual(classify(['COBO0322 10', '12345 2']), {network: 'CoCoRaHS', id: 'COBO0322', url: 'https://dex.cocorahs.org/stations/CO-BO-322'});
  const coop = classify(['058064 2', 'USC00058064 6']);
  assert.equal(coop.network, 'NWS COOP');
  assert.ok(coop.url.endsWith('GHCND:USC00058064/detail'));
  assert.equal(classify(['1234 7']), null); // SNOTEL and other automated networks are not boards
});

test('nearest board is the closest active observer within the distance and elevation limits', () => {
  const loc = {lat: 39.5, lon: -106.0, kind: 'resort', base: 9600};
  const active = Array.from({length: 40}, () => ['0', '10']), quiet = Array.from({length: 40}, () => ['M', 'M']);
  const st = (name, lat, lon, elev, data, sids = ['011111 2']) => ({meta: {name, sids, ll: [lon, lat], elev}, data});
  const stations = [st('FAR', 39.5, -105.7, 9600, active), st('NEAR QUIET', 39.501, -106.0, 9600, quiet), st('LOW', 39.51, -106.0, 7000, active), st('GOOD', 39.52, -106.0, 9500, active)];
  const b = nearestBoard(loc, stations);
  assert.equal(b.station.name, 'GOOD');
  assert.equal(b.station.elevDiffFt, -100);
  assert.equal(nearestBoard(loc, stations.slice(0, 3)), null);
  const reports = lastReports([['1.0', '5'], ['T', '5'], ['M', 'M'], ['2.0A', '7']], ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.deepEqual(reports.map(r => r.date), ['2026-01-04', '2026-01-03', '2026-01-02']); // newest first
  assert.equal(reports[0].accumulated, true);
  assert.equal(reports[1].snowIn, null);
  assert.equal(reports[2].trace, true);
});
