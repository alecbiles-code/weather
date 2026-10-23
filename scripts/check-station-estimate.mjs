// Checks the SNOTEL station estimate (measuredDay in core.js) against the four Colorado observer snow boards
// that sit within 5 km and 1,000 ft of a SNOTEL station (snow research report, 2026-10-21, section 3.1).
// Run each autumn before the season, and after changing SNOTEL_SNOW_RATIO or SNOTEL_WATER_MAX_F:
//   node scripts/check-station-estimate.mjs [first water year] [last water year]
// Prints each variant's share of board snowfall (Dec 1 to Mar 31), daily mean absolute error and correlation.
// The report's acceptance test: pooled share 85% to 105%, no station-season above 130%.
import {measuredDay, parseStationData, shiftDate, request, SNOTEL_SNOW_RATIO, SNOTEL_WATER_MAX_F} from '../core.js';

const PAIRS = [ // [ACIS board id, SNOTEL triplet, label]
  ['USC00051660', '485:CO:SNTL', 'Climax / Fremont Pass'],
  ['US1COGN0066', '380:CO:SNTL', 'Crested Butte 1.9 NNE / Butte'],
  ['USC00058184', '680:CO:SNTL', 'Taylor Park / Park Cone'],
  ['US1COGR0073', '793:CO:SNTL', 'Granby 7.7 N / Stillwater Creek'],
];
const MIN_DAYS = 30; // a station-season with fewer paired days is skipped
const inches = cm => cm / 2.54;
const VARIANTS = {
  'depth rule only': (st, d) => measuredDay(st, d, {ratio: 0}),
  'max, no gate': (st, d) => { const m = measuredDay(st, d, {ratio: 0}); return m && {cm: Math.max(m.cm, m.sweChangeIn > 0 ? SNOTEL_SNOW_RATIO * m.sweChangeIn * 2.54 : 0)}; },
  [`site rule (${SNOTEL_SNOW_RATIO}:1, gate ${SNOTEL_WATER_MAX_F}F)`]: (st, d) => measuredDay(st, d),
};

/** Board snowfall by date: T is 0; missing, accumulated (A) and other flags are null. */
function boardDays(json) {
  return new Map((json.data || []).map(([d, v]) => { const s = String(v).trim(); return [d, s === 'T' ? 0 : /^\d+(\.\d+)?$/.test(s) ? Number(s) : null]; }));
}
function correlation(x, y) {
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length, mx = mean(x), my = mean(y);
  let c = 0, vx = 0, vy = 0;
  x.forEach((xi, i) => { c += (xi - mx) * (y[i] - my); vx += (xi - mx) ** 2; vy += (y[i] - my) ** 2; });
  return c / Math.sqrt(vx * vy);
}

async function main() {
  const first = Number(process.argv[2] || 2021), last = Number(process.argv[3] || 2026);
  const awdb = new URLSearchParams({stationTriplets: PAIRS.map(p => p[1]).join(','), elements: 'SNWD,WTEQ,TMAX', duration: 'DAILY', beginDate: `${first - 1}-11-29`, endDate: `${last}-04-01`, returnSuspectData: 'false'});
  const raw = await request(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${awdb}`, {timeout: 300000});
  const total = Object.fromEntries(Object.keys(VARIANTS).map(k => [k, {sum: 0, abs: 0, x: [], y: [], worst: 0}]));
  let boardTotal = 0;
  for (const [sid, triplet, label] of PAIRS) {
    const acis = new URLSearchParams({sid, sdate: `${first - 1}-11-30`, edate: `${last}-04-01`, elems: 'snow'});
    const board = boardDays(await request(`https://data.rcc-acis.org/StnData?${acis}`, {timeout: 120000})), st = parseStationData(raw, triplet);
    for (let wy = first; wy <= last; wy++) {
      const season = Object.fromEntries(Object.keys(VARIANTS).map(k => [k, 0])), rows = [];
      let boardSum = 0;
      for (let d = `${wy - 1}-12-01`; d <= `${wy}-03-31`; d = shiftDate(d, 1)) {
        const b = board.get(shiftDate(d, 1)); // a board report dated D+1 covers about 7 AM D to 7 AM D+1
        const est = Object.fromEntries(Object.entries(VARIANTS).map(([k, f]) => [k, f(st, d)?.cm]));
        if (b == null || measuredDay(st, d)?.sweChangeIn == null || Object.values(est).some(v => v == null)) continue;
        boardSum += b; rows.push([b, est]);
      }
      if (rows.length < MIN_DAYS) { console.log(`WY${wy} ${label}: ${rows.length} paired days, skipped`); continue; }
      boardTotal += boardSum;
      for (const [b, est] of rows) for (const [k, cm] of Object.entries(est)) {
        const v = inches(cm), t = total[k];
        season[k] += v; t.sum += v; t.abs += Math.abs(v - b); t.x.push(v); t.y.push(b);
      }
      for (const k of Object.keys(season)) total[k].worst = Math.max(total[k].worst, season[k] / boardSum);
      console.log(`WY${wy} ${label}: ${rows.length} days, board ${boardSum.toFixed(1)} in; ${Object.entries(season).map(([k, v]) => `${k} ${Math.round(100 * v / boardSum)}%`).join(', ')}`);
    }
  }
  console.log(`\nPooled, board total ${boardTotal.toFixed(0)} in:`);
  for (const [k, t] of Object.entries(total)) {
    const share = t.sum / boardTotal, pass = share >= 0.85 && share <= 1.05 && t.worst <= 1.3;
    console.log(`  ${k}: ${Math.round(100 * share)}% of board snow, daily MAE ${(t.abs / t.x.length).toFixed(2)} in, r ${correlation(t.x, t.y).toFixed(2)}, worst season ${Math.round(100 * t.worst)}%, acceptance ${pass ? 'PASS' : 'FAIL'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
