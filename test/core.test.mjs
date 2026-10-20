// Run: node --test test/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {HOUR, integrate, dailyTotal, dayBounds, zonedEpoch, sumComplete, normalizeForecast, normalizeModels, spreadStats, kucheraSLR, slrEstimate, binIndex, horizon, measuredDay, qualityLabel, parseCSV, dailyPick, waterYearStart, seasonSnow, percentileRank} from '../core.js';

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
    WTEQ: [{date: '2026-01-01', value: 5.0}, {date: '2026-01-02', value: 5.8}, {date: '2026-01-03', value: 5.8}, {date: '2026-01-04', value: 5.7}]};
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
