import { densify, haversine } from './geo.js';
import { elevations } from './elevation.js';
import { renderChart, fmtDist } from './chart.js';

const $ = (s) => document.querySelector(s);
const FC = (features = []) => ({ type: 'FeatureCollection', features });

export function initProfile(app) {
  const { map } = app;
  let drawing = false, pts = [], samples = [];

  map.addSource('prof', { type: 'geojson', data: FC() });
  map.addLayer({ id: 'prof-line', type: 'line', source: 'prof', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#fbbf24', 'line-width': 3 } });
  map.addLayer({ id: 'prof-pt', type: 'circle', source: 'prof', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': ['case', ['get', 'hover'], 7, 4], 'circle-color': ['case', ['get', 'hover'], '#fbbf24', '#0b1220'], 'circle-stroke-color': '#fbbf24', 'circle-stroke-width': 2 } });

  const draw = (hover) => map.getSource('prof').setData(FC([
    ...(pts.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }] : []),
    ...pts.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
    ...(hover ? [{ type: 'Feature', properties: { hover: true }, geometry: { type: 'Point', coordinates: hover } }] : []),
  ]));

  const setDrawing = (on) => {
    drawing = on;
    $('#prof-draw').textContent = on ? 'Selesai (klik ganda)' : 'Gambar garis';
    $('#prof-draw').classList.toggle('active', on);
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    on ? map.doubleClickZoom.disable() : setTimeout(() => map.doubleClickZoom.enable(), 0);
  };

  $('#prof-draw').onclick = () => {
    if (drawing) return finish();
    pts = []; draw(); setDrawing(true);
    app.toast('Klik titik-titik di peta, klik ganda untuk selesai');
  };
  $('#prof-clear').onclick = () => { pts = []; samples = []; draw(); setDrawing(false); $('#prof-stats').innerHTML = ''; app.closeDrawer(); };

  map.on('click', (e) => { if (drawing) { pts.push(e.lngLat.toArray()); draw(); } });
  map.on('dblclick', (e) => { if (drawing) { e.preventDefault(); finish(); } });

  async function finish() {
    setDrawing(false);
    pts = pts.filter((p, i) => !i || haversine(p, pts[i - 1]) > 0.5); // klik ganda menambah titik duplikat
    draw();
    if (pts.length < 2) return app.toast('Butuh minimal 2 titik');
    let total = 0; for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
    samples = densify(pts, Math.max(10, total / 400));
    const h = await elevations(samples.map((s) => s.lngLat));
    const vals = h.map((v) => v ?? NaN), ok = vals.filter(Number.isFinite);
    let gain = 0, loss = 0;
    for (let i = 1; i < vals.length; i++) { const dv = vals[i] - vals[i - 1]; if (dv > 0) gain += dv; else if (dv < 0) loss -= dv; }
    $('#prof-stats').innerHTML = [
      ['Panjang', fmtDist(total)], ['Sampel', samples.length],
      ['Elev min', `${Math.min(...ok).toFixed(1)} m`], ['Elev maks', `${Math.max(...ok).toFixed(1)} m`],
      ['Naik total', `${gain.toFixed(0)} m`], ['Turun total', `${loss.toFixed(0)} m`],
    ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
    renderChart(app.openDrawer('Profil elevasi', [['#fbbf24', 'Elevasi DEM (DSM, ±EGM96)']]), {
      x: samples.map((s) => s.d),
      series: [{ name: 'Elevasi', color: '#fbbf24', values: vals, area: true }],
      onHover: (i) => draw(i == null ? null : samples[i].lngLat),
    });
  }
}
