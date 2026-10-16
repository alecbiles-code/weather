// MapLibre GL 3D map: keyless basemap and terrain, snowfall columns and field, radar timeline,
// avalanche zones, SNOTEL pins, ski trails, freezing-level shading, falling snow, storm tour.
// Loaded on demand so the homepage never pays for the map library.
import {parseProviderDate, finite, SNOW_RAMP} from './core.js';

const VERSION = '5.24.0';
const CDN = `https://unpkg.com/maplibre-gl@${VERSION}/dist/`;
const SRI = {
  js: 'sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp',
  css: 'sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK'
};
const STYLES = {light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark'};
const DEM = {type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>'};
const TRAILS = {type: 'vector', url: 'https://tiles.openskimap.org/openskimap.json'};
const RADAR_TILE = stamp => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
const HOME = {center: [-106.55, 38.95], pitch: 60, bearing: -14};
const DANGER = ['#9aa5b1', '#5bb85b', '#f2d649', '#f39a3c', '#d9372b', '#1c1c1c'];
const M_PER_CM = 650; // column height exaggeration: 1 cm of snow draws as 650 m

let map = null, opts = null, popup = null, snowCanvas = null, paused = false, tourToken = 0, radarKey = '';

function loadLibrary() {
  if (window.maplibregl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: CDN + 'maplibre-gl.css', integrity: SRI.css, crossOrigin: 'anonymous'});
    const js = Object.assign(document.createElement('script'), {src: CDN + 'maplibre-gl.js', integrity: SRI.js, crossOrigin: 'anonymous'});
    js.onload = () => window.maplibregl ? resolve() : reject(new Error('library did not initialize'));
    js.onerror = () => reject(new Error('map library could not be downloaded'));
    document.head.append(css, js);
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const homeCamera = el => ({...HOME, zoom: Math.min(8.6, Math.max(6.4, Math.log2(121658 * el.clientWidth / 480000)))});

/* ---- GeoJSON builders ---- */
function disc(lon, lat, km = 3.6) {
  const ring = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    ring.push([lon + (km / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return [ring];
}
function locationCollections() {
  const columns = [], points = [];
  for (const f of opts.features) {
    const props = {id: f.loc.id, name: f.loc.name, label: f.label, inches: finite(f.v) ? f.v / 2.54 : -1, height: finite(f.v) ? Math.max(60, f.v * M_PER_CM) : 30};
    columns.push({type: 'Feature', properties: props, geometry: {type: 'Polygon', coordinates: disc(f.loc.lon, f.loc.lat)}});
    points.push({type: 'Feature', properties: props, geometry: {type: 'Point', coordinates: [f.loc.lon, f.loc.lat]}});
  }
  return {columns: {type: 'FeatureCollection', features: columns}, points: {type: 'FeatureCollection', features: points}};
}
function avalancheCollection() {
  const now = Date.now();
  return {type: 'FeatureCollection', features: (opts.bulletins || []).filter(f => f.geometry).map(f => {
    const p = f.properties || {}, zone = p.timezone || 'America/Denver', s = parseProviderDate(p.start_date, zone), e = parseProviderDate(p.end_date, zone);
    const lvl = finite(s) && finite(e) && s <= now && e > now && Number.isInteger(+p.danger_level) && +p.danger_level >= 1 && +p.danger_level <= 5 ? +p.danger_level : 0;
    return {type: 'Feature', geometry: f.geometry, properties: {name: p.name || 'CAIC zone', lvl, link: p.link || 'https://avalanche.state.co.us/'}};
  })};
}
function snotelCollection() {
  return {type: 'FeatureCollection', features: (opts.snotel || []).map(s => ({type: 'Feature', geometry: {type: 'Point', coordinates: [s.lon, s.lat]},
    properties: {name: s.name || s.triplet, depth: finite(s.depthIn) ? (opts.unit === 'in' ? `${s.depthIn} in deep` : `${Math.round(s.depthIn * 2.54)} cm deep`) : 'no depth'}}))};
}

/* ---- High-resolution frames from the scheduled job (hires/), draped as images ---- */
function corners() { const [w, so, e, n] = opts.hires.bounds; return [[w, n], [e, n], [e, so], [w, so]]; }
function setImage(id, url) {
  const src = map.getSource(id);
  if (src) src.updateImage({url, coordinates: corners()});
  else map.addSource(id, {type: 'image', url, coordinates: corners()});
}

/* ---- Layers ---- */
function firstSymbolId() { return map.getStyle().layers.find(l => l.type === 'symbol')?.id; }
function addOverlays() {
  const dark = opts.theme === 'dark', below = firstSymbolId();
  radarKey = '';
  if (!map.getSource('dem')) map.addSource('dem', DEM);
  if (!map.getSource('dem-shade')) map.addSource('dem-shade', DEM);
  if (!map.getSource('dem-relief')) map.addSource('dem-relief', DEM);
  map.setTerrain({source: 'dem', exaggeration: 1.35});
  map.setSky({'sky-color': dark ? '#0b1a2c' : '#a9cbe8', 'horizon-color': dark ? '#22364d' : '#e6eef5', 'fog-color': dark ? '#000000' : '#f3f6f9',
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.25, 'atmosphere-blend': 0.6});
  map.addLayer({id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: {'hillshade-shadow-color': dark ? '#000000' : '#4a5a6a', 'hillshade-exaggeration': dark ? 0.55 : 0.35, 'hillshade-highlight-color': dark ? '#3a4a5c' : '#ffffff'}}, below);
  map.addLayer({id: 'freezing', type: 'color-relief', source: 'dem-relief', layout: {visibility: 'none'}, paint: {'color-relief-opacity': 1, 'color-relief-color': reliefColor(3000)}}, below);
  map.addSource('trails', TRAILS);
  const runColor = ['match', ['get', 'difficulty'], ['novice', 'easy'], '#1f9d3a', 'intermediate', '#1f63d6', ['advanced', 'expert', 'extreme'], dark ? '#f2f2f2' : '#111111', 'freeride', '#f28c00', '#888888'];
  map.addLayer({id: 'trail-runs', type: 'line', source: 'trails', 'source-layer': 'runs', minzoom: 10, filter: ['==', ['geometry-type'], 'LineString'], paint: {'line-color': runColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2.2]}});
  map.addLayer({id: 'trail-lifts', type: 'line', source: 'trails', 'source-layer': 'lifts', minzoom: 10, paint: {'line-color': dark ? '#ff5c5c' : '#c00000', 'line-width': 1.2, 'line-dasharray': [3, 1.5]}});
  map.addSource('avalanche', {type: 'geojson', data: avalancheCollection()});
  map.addLayer({id: 'avalanche-fill', type: 'fill', source: 'avalanche', layout: {visibility: 'none'}, paint: {'fill-color': ['step', ['get', 'lvl'], DANGER[0], ...DANGER.slice(1).flatMap((c, i) => [i + 1, c])], 'fill-opacity': 0.38}});
  map.addLayer({id: 'avalanche-line', type: 'line', source: 'avalanche', layout: {visibility: 'none'}, paint: {'line-color': dark ? '#ffffff' : '#333333', 'line-width': 0.8}});
  const {columns, points} = locationCollections();
  map.addSource('snow-columns', {type: 'geojson', data: columns, promoteId: 'id'});
  map.addSource('snow-points', {type: 'geojson', data: points, promoteId: 'id'});
  map.addLayer({id: 'snow-columns', type: 'fill-extrusion', source: 'snow-columns', paint: {
    'fill-extrusion-color': ['step', ['get', 'inches'], dark ? '#4b5563' : '#9aa5b1', ...SNOW_RAMP.flatMap(([v, c]) => [v, c])],
    // Statewide view: tall columns. Zoomed into a resort: short and see-through so trails and terrain show.
    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 8, ['get', 'height'], 10.5, ['*', ['get', 'height'], 0.2]], 'fill-extrusion-base': 0,
    'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0.92, 10.5, 0.35],
    'fill-extrusion-height-transition': {duration: opts.reduceMotion ? 0 : 450, delay: 0}}});
  map.addSource('snotel', {type: 'geojson', data: snotelCollection()});
  map.addLayer({id: 'snotel-dots', type: 'circle', source: 'snotel', layout: {visibility: 'none'}, paint: {'circle-radius': 5, 'circle-color': '#39ff14', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5}});
  map.addLayer({id: 'snotel-labels', type: 'symbol', source: 'snotel', minzoom: 7.5, layout: {visibility: 'none', 'text-field': ['format', ['get', 'name'], {'font-scale': 0.8}, '\n', {}, ['get', 'depth'], {'font-scale': 0.9}], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top'},
    paint: {'text-color': dark ? '#b6ff9e' : '#0a5a00', 'text-halo-color': dark ? '#000' : '#fff', 'text-halo-width': 1.3}});
  map.addLayer({id: 'snow-labels', type: 'symbol', source: 'snow-points', minzoom: 6.9, layout: {
    'text-field': ['format', ['get', 'name'], {'font-scale': 0.85}, '\n', {}, ['get', 'label'], {'font-scale': 1.05, 'text-font': ['literal', ['Noto Sans Bold']]}],
    'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top'},
    paint: {'text-color': dark ? '#e8eef4' : '#16202b', 'text-halo-color': dark ? '#000000' : '#ffffff', 'text-halo-width': 1.4}});
  applyData();
}
const reliefColor = fl => ['interpolate', ['linear'], ['elevation'], fl - 1, 'rgba(255,255,255,0)', fl, 'rgba(255,255,255,0.55)', fl + 2000, 'rgba(225,240,255,0.7)'];
function vis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }
function addRaster(id, source, opacity, beforeId) { if (!map.getLayer(id)) map.addLayer({id, type: 'raster', source, paint: {'raster-opacity': opacity, 'raster-fade-duration': 0}}, beforeId); }

/** Pushes the current options into sources and layer visibility. Cheap when nothing changed. */
function applyData() {
  if (!map?.getSource('snow-columns')) return;
  const L = opts.layers, {columns, points} = locationCollections();
  map.getSource('snow-columns').setData(columns);
  map.getSource('snow-points').setData(points);
  map.getSource('avalanche').setData(avalancheCollection());
  map.getSource('snotel').setData(snotelCollection());
  vis('snow-columns', L.columns); vis('snow-labels', L.columns);
  vis('trail-runs', L.trails); vis('trail-lifts', L.trails);
  vis('avalanche-fill', L.avalanche); vis('avalanche-line', L.avalanche);
  vis('snotel-dots', L.snotel); vis('snotel-labels', L.snotel);
  vis('freezing', L.freezing && finite(opts.freezingM));
  if (finite(opts.freezingM)) map.setPaintProperty('freezing', 'color-relief-color', reliefColor(opts.freezingM));
  // Snow field: observed (NOHRSC) left of now, forecast (NBM) right of now.
  const f = opts.snowFrame, showField = L.field && opts.hires && f?.file;
  if (showField) { setImage('snow-field', opts.hires.base + f.file); addRaster('snow-field', 'snow-field', 0.78, 'trail-runs'); }
  vis('snow-field', showField);
  // Radar timeline: observed NEXRAD tiles for the past, HRRR simulated radar images for the future.
  const r = L.radar ? opts.radarFrame : null;
  if (r?.kind === 'radar') {
    const d = new Date(r.t), stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
    if (!map.getSource('radar')) map.addSource('radar', {type: 'raster', tiles: [RADAR_TILE(stamp)], tileSize: 256, maxzoom: 8, attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>'});
    else if (stamp !== radarKey) map.getSource('radar').setTiles([RADAR_TILE(stamp)]);
    radarKey = stamp;
    addRaster('radar', 'radar', 0.7, 'avalanche-fill');
  }
  vis('radar', r?.kind === 'radar');
  if (r?.kind === 'model' && opts.hires) { setImage('radar-model', opts.hires.base + r.file); addRaster('radar-model', 'radar-model', 0.75, 'avalanche-fill'); }
  vis('radar-model', r?.kind === 'model' && !!opts.hires);
}

/* ---- Falling snow over locations with at least 1 in in the selected window ---- */
let flakes = [], fxFrame = null;
function seedFlakes() {
  flakes = [];
  if (opts.snowFrame?.kind !== 'future') return;
  for (const f of opts.features) {
    if (!finite(f.v) || f.v < 2.54) continue;
    const n = Math.min(45, Math.round(f.v / 2.54 * 5));
    for (let i = 0; i < n; i++) flakes.push({lon: f.loc.lon, lat: f.loc.lat, dx: (Math.random() - 0.5) * 90, y: Math.random() * 90 - 80, s: 14 + Math.random() * 18, r: 1 + Math.random() * 1.6, sway: Math.random() * 6.28});
  }
}
function drawFlakes(ts) {
  fxFrame = null;
  const on = opts.snowfx && opts.layers.snowfx && !paused && !document.hidden && flakes.length;
  const ctx = snowCanvas.getContext('2d'), w = snowCanvas.clientWidth, h = snowCanvas.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (snowCanvas.width !== Math.round(w * dpr)) { snowCanvas.width = Math.round(w * dpr); snowCanvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!on) return;
  const dt = 1 / 60;
  ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.strokeStyle = 'rgba(20,50,90,0.55)'; ctx.lineWidth = 0.8;
  for (const p of flakes) {
    p.y += p.s * dt; if (p.y > 20) p.y = -80;
    const base = map.project([p.lon, p.lat]), x = base.x + p.dx + Math.sin(ts / 700 + p.sway) * 4, y = base.y + p.y;
    if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  fxFrame = requestAnimationFrame(drawFlakes);
}
function restartFlakes() { if (fxFrame) cancelAnimationFrame(fxFrame); fxFrame = requestAnimationFrame(drawFlakes); }

/* ---- Popups ---- */
function showPopup(lngLat, html) { popup?.remove(); popup = new maplibregl.Popup({offset: 8, maxWidth: '260px'}).setLngLat(lngLat).setHTML(html).addTo(map); }
const locPopup = p => `<div class="pop"><strong>${esc(p.name)}</strong><span class="pop-val">${esc(p.label)}</span><span class="pop-sub">${esc(opts.windowLabel)}</span><a href="#/resort/${esc(p.id)}">Open forecast</a></div>`;
function wireEvents() {
  map.on('click', e => {
    const hit = map.queryRenderedFeatures(e.point, {layers: ['snow-columns', 'snotel-dots', 'avalanche-fill'].filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')})[0];
    if (!hit) return;
    const p = hit.properties;
    if (hit.layer.id === 'snow-columns') showPopup(e.lngLat, locPopup(p));
    else if (hit.layer.id === 'snotel-dots') showPopup(e.lngLat, `<div class="pop"><strong>${esc(p.name)} SNOTEL</strong><span class="pop-sub">Measured snow ${esc(p.depth)}</span></div>`);
    else showPopup(e.lngLat, `<div class="pop"><strong>${esc(p.name)}</strong><span class="pop-sub">${+p.lvl ? `Danger ${['', 'Low', 'Moderate', 'Considerable', 'High', 'Extreme'][+p.lvl]} (${p.lvl} of 5)` : 'No current rating'}</span><a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Read the CAIC forecast</a></div>`);
  });
  for (const id of ['snow-columns', 'snotel-dots', 'avalanche-fill']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  for (const ev of ['mousedown', 'touchstart', 'wheel']) map.on(ev, () => { tourToken++; }); // any user gesture ends a tour
}

/* ---- Public API ---- */
export async function mountMap(container, canvas, options) {
  window.__powcastMap = () => map; // for automated checks only
  opts = options; snowCanvas = canvas;
  await loadLibrary();
  map = new maplibregl.Map({container, style: STYLES[opts.theme], ...homeCamera(container), maxPitch: 75, attributionControl: false, canvasContextAttributes: {antialias: true}});
  map.addControl(new maplibregl.AttributionControl({compact: true}), 'top-left'); // bottom edge holds the timeline bar
  map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  map.addControl(new maplibregl.TerrainControl({source: 'dem', exaggeration: 1.35}), 'top-right');
  map.on('style.load', addOverlays);
  map.on('error', e => console.warn('Map:', e.error?.message || e));
  // The OpenFreeMap dark style references a few icons its sprite lacks; draw them as nothing.
  map.on('styleimagemissing', e => { if (!map.hasImage(e.id)) map.addImage(e.id, {width: 1, height: 1, data: new Uint8Array(4)}); });
  wireEvents();
  map.once('load', () => { if (opts.focusId) focus(opts.focusId); });
  container.dataset.theme = opts.theme;
  seedFlakes(); restartFlakes();
}
export function updateMap(options) {
  if (!map) return;
  const themeChanged = options.theme !== opts.theme, windowChanged = options.windowLabel !== opts.windowLabel || options.unit !== opts.unit;
  opts = options;
  if (themeChanged) { map.setStyle(STYLES[opts.theme]); return; } // style.load re-adds every overlay
  applyData(); // isStyleLoaded() is false while tiles load, which silently dropped updates; applyData guards itself
  if (windowChanged || !flakes.length) seedFlakes();
  restartFlakes();
}
export function pause(on) {
  paused = on;
  if (!map) return;
  if (!on) { map.resize(); restartFlakes(); }
}
const flyOrJump = camera => opts.reduceMotion ? map.jumpTo(camera) : map.flyTo({...camera, duration: 2200, essential: false});
export function focus(id) {
  const f = opts?.features.find(x => x.loc.id === id);
  if (!map || !f) return;
  tourToken++;
  flyOrJump({center: [f.loc.lon, f.loc.lat], zoom: 10.4, pitch: 64, bearing: map.getBearing()});
  showPopup([f.loc.lon, f.loc.lat], locPopup({id, name: f.loc.name, label: f.label}));
}
export function resetView() {
  if (!map) return;
  tourToken++; popup?.remove();
  const cam = homeCamera(map.getContainer());
  if (opts.reduceMotion) map.jumpTo(cam); else map.easeTo({...cam, duration: 900});
}
/** Flies to each location in turn, with its popup. Any drag, scroll, or new tour stops it. */
export async function tour(ids) {
  if (!map) return;
  const token = ++tourToken, wait = ms => new Promise(r => setTimeout(r, ms));
  for (const [i, id] of ids.entries()) {
    const f = opts.features.find(x => x.loc.id === id);
    if (!f) continue;
    flyOrJump({center: [f.loc.lon, f.loc.lat], zoom: 10.2, pitch: 66, bearing: -20 + i * 25});
    await wait(opts.reduceMotion ? 300 : 2400);
    if (token !== tourToken) return;
    showPopup([f.loc.lon, f.loc.lat], locPopup({id, name: `#${i + 1} ${f.loc.name}`, label: f.label}));
    await wait(2600);
    if (token !== tourToken) return;
  }
  resetView();
}
