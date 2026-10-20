// Builds data/snowpack-history.json for the homepage's Snowpack Power Rankings: for each SNOTEL
// station the site uses, the snow water equivalent (SWE) on the same calendar date in every past
// water year of its record, sorted, for a window of dates around today. The site compares the live
// SWE reading with that list to get a percentile, as in the NRCS state snowpack products.
// Run by .github/workflows/data.yml every 6 hours. By hand: node scripts/build-snowpack.mjs
import {writeFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Output directory: first argument, or data/ next to the site for local runs.
const OUT = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/?$/, '/')) : new URL('../data/', import.meta.url);
import {numeric, finite, shiftDate, localDate, waterYearStart} from '../core.js';
import {LOCS} from '../locations.js';

const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/';
const WINDOW = [-3, 12];  // days around today; the site keeps working if a few runs are missed
const CHUNK = 6;          // stations per request (about 3.5 MB of daily values)
const PAUSE_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function getJSON(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Retry both HTTP errors and dropped connections; a single network blip must not fail the run.
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(120000)});
      if (r.ok) return await r.json(); // await so a garbled body is retried too
      log(`HTTP ${r.status}, attempt ${attempt}: ${(await r.text()).slice(0, 160)}`);
    } catch (e) { log(`Network error, attempt ${attempt}: ${e.cause?.code || e.message}`); }
    await sleep(attempt * 30000);
  }
  throw new Error(`Request failed: ${url.slice(0, 120)}`);
}

async function main() {
  const today = localDate(), triplets = [...new Set(LOCS.map(l => l.snotel))];
  // History ends with the last complete water year, so the current season is never compared with itself.
  const lastDay = shiftDate(waterYearStart(today), -1);
  const keys = [];
  for (let i = WINDOW[0]; i <= WINDOW[1]; i++) keys.push(shiftDate(today, i).slice(5));
  const stations = {};
  for (let i = 0; i < triplets.length; i += CHUNK) {
    const p = new URLSearchParams({stationTriplets: triplets.slice(i, i + CHUNK).join(','), elements: 'WTEQ', duration: 'DAILY',
      beginDate: '1900-01-01', endDate: lastDay, returnSuspectData: 'false'});
    for (const st of await getJSON(`${AWDB}data?${p}`)) {
      const block = (st.data || []).find(b => b.stationElement?.elementCode === 'WTEQ' && b.stationElement?.storedUnitCode === 'in');
      const byKey = Object.fromEntries(keys.map(k => [k, []]));
      let first = null;
      for (const v of block?.values || []) {
        const date = String(v.date || '').slice(0, 10), x = numeric(v.value);
        if (!finite(x) || x < 0 || !(date.slice(5) in byKey)) continue;
        byKey[date.slice(5)].push(x);
        first ??= date.slice(0, 4);
      }
      for (const k of keys) byKey[k].sort((a, b) => a - b);
      stations[st.stationTriplet] = {since: first, swe: byKey};
    }
    log(`fetched ${Math.min(i + CHUNK, triplets.length)}/${triplets.length} stations`);
    if (i + CHUNK < triplets.length) await sleep(PAUSE_MS);
  }
  const out = {generatedAt: new Date().toISOString(), through: lastDay, units: 'inches of snow water equivalent',
    method: 'NRCS SNOTEL daily SWE (WTEQ) on each calendar date (MM-DD) in every water year of the station record through the last complete one, sorted ascending.',
    stations};
  await mkdir(OUT, {recursive: true});
  await writeFile(new URL('snowpack-history.json', OUT), JSON.stringify(out));
  log(`wrote snowpack-history.json: ${Object.keys(stations).length} stations, dates ${keys[0]} to ${keys.at(-1)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
