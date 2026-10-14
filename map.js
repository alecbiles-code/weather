// MapLibre GL 3D map: keyless basemap, keyless terrain, extruded snowfall columns.
// Loaded on demand so the homepage never pays for the map library.
const VERSION = '5.24.0';
const CDN = `https://unpkg.com/maplibre-gl@${VERSION}/dist/`;
const SRI = {
  js: 'sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp',
  css: 'sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK'
};
const STYLES = {light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark'};
const TERRAIN = {type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (Mapzen, USGS, others)'};
const HOME = {center: [-106.55, 38.95], pitch: 60, bearing: -14};
/** Zoom that fits the ski areas (about 480 km across) in this container. */
function homeCamera(el) { return {...HOME, zoom: Math.min(8.6, Math.max(6.4, Math.log2(121658 * el.clientWidth / 480000)))}; }
// Same sequential ramp as the matrix (light-mode steps read well on both basemaps once extruded).
const RAMP = ['#d9dee4', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const M_PER_CM = 650; // column height exaggeration: 1 cm of snow draws as 650 m

let map = null, opts = null, radarOn = false, popup = null;

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

/** 20-sided disc around a point, about `km` in radius, as a GeoJSON ring. */
function disc(lon, lat, km = 3.6) {
  const ring = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    ring.push([lon + (km / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return [ring];
}
function collections() {
  const columns = [], points = [];
  for (const f of opts.features) {
    const props = {id: f.loc.id, name: f.loc.name, label: f.label, bin: f.bin ?? -1, cm: Number.isFinite(f.v) ? f.v : -1,
      height: Number.isFinite(f.v) ? Math.max(60, f.v * M_PER_CM) : 30};
    columns.push({type: 'Feature', properties: props, geometry: {type: 'Polygon', coordinates: disc(f.loc.lon, f.loc.lat)}});
    points.push({type: 'Feature', properties: props, geometry: {type: 'Point', coordinates: [f.loc.lon, f.loc.lat]}});
  }
  return {columns: {type: 'FeatureCollection', features: columns}, points: {type: 'FeatureCollection', features: points}};
}
function addOverlays() {
  const {columns, points} = collections(), dark = opts.theme === 'dark';
  if (!map.getSource('dem')) map.addSource('dem', TERRAIN);
  if (!map.getSource('dem-shade')) map.addSource('dem-shade', TERRAIN);
  map.setTerrain({source: 'dem', exaggeration: 1.35});
  map.setSky({'sky-color': dark ? '#0b1a2c' : '#a9cbe8', 'horizon-color': dark ? '#22364d' : '#e6eef5', 'fog-color': dark ? '#0d1116' : '#f3f6f9',
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.25, 'atmosphere-blend': 0.6});
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  if (!map.getLayer('hillshade')) map.addLayer({id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: {'hillshade-shadow-color': dark ? '#000000' : '#4a5a6a', 'hillshade-exaggeration': dark ? 0.55 : 0.35, 'hillshade-highlight-color': dark ? '#3a4a5c' : '#ffffff'}}, firstSymbol);
  map.addSource('snow-columns', {type: 'geojson', data: columns});
  map.addSource('snow-points', {type: 'geojson', data: points});
  map.addLayer({id: 'snow-columns', type: 'fill-extrusion', source: 'snow-columns', paint: {
    'fill-extrusion-color': ['step', ['get', 'bin'], dark ? '#4b5563' : '#9aa5b1', ...RAMP.flatMap((c, i) => [i, c])],
    'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.92,
    'fill-extrusion-height-transition': {duration: opts.reduceMotion ? 0 : 450, delay: 0}}});
  map.addLayer({id: 'snow-labels', type: 'symbol', source: 'snow-points', minzoom: 6.9, layout: {
    'text-field': ['format', ['get', 'name'], {'font-scale': 0.85}, '\n', {}, ['get', 'label'], {'font-scale': 1.05, 'text-font': ['literal', ['Noto Sans Bold']]}],
    'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': false},
    paint: {'text-color': dark ? '#e8eef4' : '#16202b', 'text-halo-color': dark ? '#0d1116' : '#ffffff', 'text-halo-width': 1.4}});
  if (radarOn && radarState) addRadar(radarState);
}
function popupHTML(p) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  return `<div class="pop"><strong>${esc(p.name)}</strong><span class="pop-val">${esc(p.label)}</span><span class="pop-sub">${esc(opts.windowLabel)} · model</span><a href="#/resort/${esc(p.id)}">Open forecast</a></div>`;
}
function wireEvents() {
  const show = e => {
    const f = e.features?.[0];
    if (!f) return;
    popup?.remove();
    popup = new maplibregl.Popup({closeButton: true, offset: 8, maxWidth: '240px'}).setLngLat(e.lngLat).setHTML(popupHTML(f.properties)).addTo(map);
  };
  map.on('click', 'snow-columns', show);
  map.on('mouseenter', 'snow-columns', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'snow-columns', () => { map.getCanvas().style.cursor = ''; });
}

export async function mountMap(container, options) {
  opts = options;
  await loadLibrary();
  map = new maplibregl.Map({container, style: STYLES[opts.theme], ...homeCamera(container), maxPitch: 75, attributionControl: {compact: true}, canvasContextAttributes: {antialias: true}});
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
}
export function updateMap(options) {
  if (!map) return;
  const themeChanged = options.theme !== opts.theme;
  opts = options;
  if (themeChanged) { map.setStyle(STYLES[opts.theme]); return; } // style.load re-adds overlays
  if (!map.isStyleLoaded() || !map.getSource('snow-columns')) return;
  const {columns, points} = collections();
  map.getSource('snow-columns').setData(columns);
  map.getSource('snow-points').setData(points);
}
export function focus(id) {
  const f = opts?.features.find(x => x.loc.id === id);
  if (!map || !f) return;
  const camera = {center: [f.loc.lon, f.loc.lat], zoom: 9.6, pitch: 62, bearing: map.getBearing()};
  if (opts.reduceMotion) map.jumpTo(camera); else map.flyTo({...camera, duration: 1600, essential: false});
  popup?.remove();
  popup = new maplibregl.Popup({offset: 8, maxWidth: '240px'}).setLngLat(camera.center).setHTML(popupHTML({id, name: f.loc.name, label: f.label})).addTo(map);
}
export function resetView() {
  if (!map) return;
  popup?.remove();
  const cam = homeCamera(map.getContainer());
  if (opts.reduceMotion) map.jumpTo(cam); else map.easeTo({...cam, duration: 900});
}

/* ---- RainViewer radar: latest past frame only. RainViewer serves zoom 0 to 7. ---- */
let radarState = null;
function addRadar({host, path}) {
  if (map.getSource('radar')) return;
  map.addSource('radar', {type: 'raster', tiles: [`${host}${path}/256/{z}/{x}/{y}/2/1_1.png`], tileSize: 256, maxzoom: 7, attribution: 'Radar <a href="https://www.rainviewer.com/">RainViewer</a>'});
  map.addLayer({id: 'radar', type: 'raster', source: 'radar', paint: {'raster-opacity': 0.6}}, 'snow-columns');
}
export async function toggleRadar() {
  if (!map) throw new Error('map not ready');
  if (radarOn) { radarOn = false; if (map.getLayer('radar')) map.removeLayer('radar'); if (map.getSource('radar')) map.removeSource('radar'); return null; }
  const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', {credentials: 'omit'});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const meta = await r.json(), frame = meta.radar?.past?.at(-1);
  if (!frame || !/^https:\/\//.test(meta.host)) throw new Error('no radar frames');
  radarState = {host: meta.host, path: frame.path};
  radarOn = true;
  addRadar(radarState);
  return {time: frame.time * 1000};
}
