import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { toDMS, toUTM48S, toMGRS } from './geo.js';
import { elevationAt, DEM_TILES } from './elevation.js';
import { initLive } from './live.js';
import { initDrone } from './drone.js';
import { initProfile } from './profile.js';
import { initCesium } from './cesium3d.js';
import { initFlightLog } from './flightlog.js';
import { initSearch } from './search.js';

const $ = (s) => document.querySelector(s);
const JAKARTA = [106.8235, -6.1890];

const RASTERS = {
  esri: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  s2: { tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg'], maxzoom: 15, attribution: 'Sentinel-2 cloudless 2023 © EOX (Copernicus 2023)' },
  s2_2018: { tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2018_3857/default/g/{z}/{y}/{x}.jpg'], maxzoom: 15, attribution: 'Sentinel-2 cloudless 2018 © EOX (Copernicus 2018)' },
};

// Katalog layer + metadata "umur data". date = tanggal akuisisi/rilis terbaru (ISO) atau 'live'.
const LAYERS = [
  { id: 'esri', name: 'Citra Esri World Imagery', color: '#a3e635', type: 'raster', src: 'Esri / Maxar', res: '±0,3–0,5 m', date: '2023-01-01', lic: 'Proprietary, tampilan saja' },
  { id: 's2', name: 'Sentinel-2 cloudless 2023', color: '#4ade80', type: 'raster', src: 'EOX / Copernicus', res: '10 m', date: '2023-12-31', lic: 'CC BY-NC-SA 4.0' },
  { id: 'hillshade', name: 'Hillshade DEM', color: '#94a3b8', src: 'Terrarium (SRTM/NASADEM)', res: '±30 m (DSM)', date: '2000-02-22', lic: 'Domain publik' },
  { id: 'buildings', name: 'Bangunan 3D', color: '#38bdf8', on: true, src: 'OpenStreetMap via OpenFreeMap', res: 'Footprint vektor', date: 'weekly', lic: 'ODbL' },
  { id: 'pb', name: 'Laporan banjir', color: '#60a5fa', on: true, src: 'PetaBencana.id API', res: 'Titik laporan', date: 'live', lic: 'Terbuka (atribusi)' },
  { id: 'eq', name: 'Gempa terkini', color: '#f87171', on: true, src: 'BMKG autogempa', res: 'Episenter', date: 'live', lic: 'Atribusi BMKG' },
];

function ageBadge(date) {
  if (date === 'live') return '<span class="age fresh">LIVE</span>';
  if (date === 'weekly') return '<span class="age fresh">≤ 1 MINGGU</span>';
  const yrs = (Date.now() - Date.parse(date)) / 3.156e10;
  const cls = yrs < 1 ? 'fresh' : yrs < 4 ? 'mid' : 'old';
  return `<span class="age ${cls}">${yrs < 1 ? '< 1 TAHUN' : Math.floor(yrs) + ' TAHUN'}</span>`;
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: JAKARTA, zoom: 14.2, pitch: 55, bearing: -20,
  maxPitch: 80, attributionControl: { compact: true, customAttribution: 'Chakrawala · Development by Cakrayuda' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');

const app = {
  map,
  bus: new EventTarget(),
  localSources: new Map(), // sumber pencarian lokal (misi/log) — tidak pernah dikirim keluar
  layerIds: {},
  toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
  },
  // tabs (opsional): { items: [{ id, label, disabled }], active, onSelect(id) } — dipakai analisis log.
  openDrawer(title, legend, tabs = null) {
    $('#drawer').hidden = false; $('#drawer-title').textContent = title;
    $('#drawer').classList.toggle('tall', !!tabs);
    $('#drawer-legend').innerHTML = legend.map(([c, n]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
    $('#drawer-tabs').innerHTML = tabs ? tabs.items.map((t) => `<button data-id="${t.id}" class="${t.id === tabs.active ? 'on' : ''}" ${t.disabled ? 'disabled title="tidak tersedia di log"' : ''}>${t.label}</button>`).join('') : '';
    $('#drawer-tabs').onclick = (e) => { const b = e.target.closest('button'); if (b && !b.disabled) tabs?.onSelect(b.dataset.id); };
    return $('#chart');
  },
  closeDrawer: () => ($('#drawer').hidden = true),
  setChip(id, ok, text) { const c = $(id); c.classList.toggle('ok', ok); c.classList.toggle('bad', ok === false); if (text) c.lastChild.textContent = text; },
};
$('#drawer-x').onclick = app.closeDrawer;

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  app.firstSymbol = firstSymbol;

  for (const id of ['esri', 's2']) {
    map.addSource(id, { type: 'raster', tileSize: 256, ...RASTERS[id] });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' } }, firstSymbol);
  }
  map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevasi: Mapzen Terrarium (SRTM/NASADEM)' });
  map.addSource('dem-hs', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', layout: { visibility: 'none' },
    paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#020617', 'hillshade-highlight-color': '#67e8f9' } }, firstSymbol);

  map.addLayer({
    id: 'buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#1e3a5f', 30, '#2563eb', 80, '#38bdf8', 200, '#a5f3fc'],
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, ['coalesce', ['get', 'render_height'], 6]],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  }, firstSymbol);
  map.setSky?.({ 'sky-color': '#0b1220', 'horizon-color': '#1e293b', 'fog-color': '#070c17', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.4 });

  buildLayerList();
  initLive(app);
  initDrone(app);
  initProfile(app);
  initCesium(app);
  initFlightLog(app);
  initSearch(app);
});

// ---------- layer panel ----------
function buildLayerList() {
  $('#layer-list').innerHTML = LAYERS.map((l) => `
    <div class="layer ${l.on ? 'on' : ''}" data-id="${l.id}">
      <label class="layer-h toggle"><span class="sw" style="background:${l.color}"></span><span class="name">${l.name}</span><input type="checkbox" ${l.on ? 'checked' : ''}/></label>
      <div class="layer-meta">${ageBadge(l.date)} ${l.src} · ${l.res}<br>Lisensi: ${l.lic}</div>
      ${l.type === 'raster' ? '<input type="range" min="0" max="1" step="0.05" value="1" title="Opasitas"/>' : ''}
    </div>`).join('');
  $('#layer-list').querySelectorAll('.layer').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('input[type=checkbox]').onchange = (e) => { el.classList.toggle('on', e.target.checked); setVisible(id, e.target.checked); };
    const op = el.querySelector('input[type=range]');
    if (op) op.oninput = () => map.setPaintProperty(id, 'raster-opacity', +op.value);
  });
}
function setVisible(id, on) {
  const ids = app.layerIds[id] ?? [id];
  for (const l of ids) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
  if (id === 'eq') app.eqMarker?.getElement().style.setProperty('display', on ? '' : 'none');
}

// ---------- terrain ----------
const exag = $('#t-exag');
const applyTerrain = () => map.setTerrain($('#t-terrain').checked ? { source: 'dem', exaggeration: +exag.value } : null);
$('#t-terrain').onchange = applyTerrain;
exag.oninput = () => { $('#t-exag-v').textContent = exag.value + '×'; if ($('#t-terrain').checked) applyTerrain(); };

// ---------- swipe komparasi (peta kedua di-clip & disinkronkan) ----------
let cmp = null, swipeX = 0.5;
function ensureCmp() {
  if (cmp) return cmp;
  cmp = new maplibregl.Map({
    container: 'map-cmp', interactive: false, attributionControl: false,
    style: { version: 8, sources: Object.fromEntries(Object.entries(RASTERS).map(([k, v]) => [k, { type: 'raster', tileSize: 256, ...v }])),
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#070c17' } },
        ...Object.keys(RASTERS).map((k) => ({ id: k, type: 'raster', source: k, layout: { visibility: 'none' } }))] },
    center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
  });
  map.on('move', syncCmp);
  return cmp;
}
const syncCmp = () => cmp?.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
function setCmpSource() {
  const src = $('#t-swipe-src').value, c = ensureCmp();
  const apply = () => Object.keys(RASTERS).forEach((k) => c.setLayoutProperty(k, 'visibility', k === src ? 'visible' : 'none'));
  c.isStyleLoaded() ? apply() : c.once('load', apply);
}
function placeSwipe() {
  const w = $('#map-wrap').clientWidth, px = w * swipeX;
  $('#swipe').style.left = px + 'px';
  $('#map-cmp').style.clipPath = `inset(0 ${w - px}px 0 0)`;
}
$('#t-swipe').onchange = (e) => {
  const on = e.target.checked;
  if (on) { setCmpSource(); syncCmp(); placeSwipe(); app.toast('Geser garis untuk membandingkan citra (kiri) dengan peta utama (kanan)'); }
  $('#map-cmp').classList.toggle('on', on); $('#swipe').hidden = !on;
};
$('#t-swipe-src').onchange = () => cmp && setCmpSource();
$('#swipe').onpointerdown = (e) => {
  e.target.setPointerCapture(e.pointerId);
  const r = $('#map-wrap').getBoundingClientRect();
  const mv = (ev) => { swipeX = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width)); placeSwipe(); };
  e.target.onpointermove = mv; e.target.onpointerup = () => (e.target.onpointermove = null);
};
new ResizeObserver(() => { map.resize(); cmp?.resize(); if (!$('#swipe').hidden) placeSwipe(); }).observe($('#map-wrap'));

// ---------- koordinat kursor ----------
let elevSeq = 0;
app.showCoords = async (lng, lat) => {
  $('#c-dd').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  $('#c-dms').textContent = `${toDMS(lat, 'LU', 'LS')} ${toDMS(lng, 'BT', 'BB')}`;
  $('#c-utm').textContent = toUTM48S(lng, lat);
  $('#c-mgrs').textContent = toMGRS(lng, lat);
  const seq = ++elevSeq, h = await elevationAt(lng, lat);
  if (seq === elevSeq) $('#c-elev').textContent = h == null ? '—' : `${h.toFixed(1)} m`;
};
map.on('mousemove', (e) => app.showCoords(e.lngLat.lng, e.lngLat.lat));
const zoomTxt = () => ($('#c-z').textContent = map.getZoom().toFixed(1));
map.on('zoom', zoomTxt); zoomTxt();

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => {
  const already = b.classList.contains('active') && !document.body.classList.contains('panel-off');
  document.body.classList.toggle('panel-off', already);
  $('#panel').classList.toggle('collapsed', already);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
}));

if (innerWidth < 760) { document.body.classList.add('panel-off'); $('#panel').classList.add('collapsed'); } // layar sempit: peta dulu

// ---------- jam WIB ----------
const clock = () => ($('#clock').textContent = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB');
setInterval(clock, 1000); clock();
