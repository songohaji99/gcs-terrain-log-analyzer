import maplibregl from 'maplibre-gl';
import { elevationAt, elevations } from './elevation.js';
import { haversine, distToPolyline } from './geo.js';
import { parseTelemetryCSV, parsePlan } from './parsers.js';
import { renderChart, fmtDist } from './chart.js';

const $ = (s) => document.querySelector(s);
const FC = (features = []) => ({ type: 'FeatureCollection', features });
const seg = (a, b, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [a, b] } });
const DRONE_SVG = `<svg viewBox="0 0 40 40" style="stroke:none"><path d="M20 3 L29 33 L20 27 L11 33 Z" fill="#22d3ee" stroke="#0b1220" stroke-width="1.5"/></svg>`;
const ALT_COLOR = ['interpolate', ['linear'], ['get', 'v'], 0, '#22d3ee', 60, '#818cf8', 150, '#e879f9'];

export function initDrone(app) {
  const { map } = app;
  const aglMin = () => +$('#d-agl-min').value || 0;
  const emit = (type, detail) => app.bus.dispatchEvent(new CustomEvent(type, { detail }));

  // ---------- sumber & layer ----------
  map.addSource('d-trail', { type: 'geojson', data: FC(), tolerance: 0 }); // segmen 2-titik pendek jangan dibuang simplifikasi
  map.addLayer({ id: 'd-trail', type: 'line', source: 'd-trail', layout: { 'line-cap': 'round' },
    paint: { 'line-width': 4, 'line-color': ['case', ['get', 'low'], '#f87171', ALT_COLOR] } });
  map.addSource('a-plan', { type: 'geojson', data: FC() });
  map.addLayer({ id: 'a-survey', type: 'fill', source: 'a-plan', filter: ['==', ['get', 'k'], 'survey'], paint: { 'fill-color': '#fbbf24', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'a-fence', type: 'line', source: 'a-plan', filter: ['in', ['get', 'k'], ['literal', ['survey', 'fence']]],
    paint: { 'line-color': ['match', ['get', 'k'], 'fence', '#f87171', '#fbbf24'], 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'a-plan-line', type: 'line', source: 'a-plan', filter: ['==', ['get', 'k'], 'route'], paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'a-wp', type: 'circle', source: 'a-plan', filter: ['==', ['get', 'k'], 'wp'],
    paint: { 'circle-radius': 4, 'circle-color': '#0b1220', 'circle-stroke-color': '#fbbf24', 'circle-stroke-width': 2 } });
  map.addSource('a-track', { type: 'geojson', data: FC(), tolerance: 0 });
  map.addLayer({ id: 'a-track', type: 'line', source: 'a-track', layout: { 'line-cap': 'round' },
    paint: { 'line-width': 4, 'line-color': ['case', ['get', 'low'], '#f87171', ALT_COLOR] } });

  const mkMarker = () => {
    const el = document.createElement('div'); el.className = 'drone-marker'; el.innerHTML = DRONE_SVG;
    return new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
  };

  // ---------- mode switch ----------
  document.querySelectorAll('[data-dmode]').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('[data-dmode]').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('[data-dpane]').forEach((p) => (p.hidden = p.dataset.dpane !== b.dataset.dmode));
  }));

  // =====================================================================
  // LIVE
  // =====================================================================
  let ws = null, want = false, live = [], trail = FC(), marker = null, lastFollow = 0, home = null, chartTick = 0, liveChart = false;

  function connect() {
    want = true;
    ws = new WebSocket($('#ws-url').value.trim());
    $('#ws-connect').textContent = 'Menghubungkan…';
    ws.onopen = () => { $('#ws-connect').textContent = 'Putuskan'; $('#ws-connect').classList.add('active'); app.setChip('#chip-drone', true, 'Drone terhubung'); };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'hello') app.toast(`Bridge terhubung · sumber: ${m.source}`); if (m.type === 'telemetry') onTelemetry(m); };
    ws.onclose = () => {
      app.setChip('#chip-drone', want ? false : null, want ? 'Bridge terputus' : 'Drone bridge');
      if (want) { $('#ws-connect').textContent = 'Mencoba ulang…'; setTimeout(() => want && connect(), 3000); }
      else { $('#ws-connect').textContent = 'Hubungkan'; $('#ws-connect').classList.remove('active'); }
    };
  }
  $('#ws-connect').onclick = () => {
    if (want) { want = false; ws?.close(); } else connect();
  };
  $('#d-clear').onclick = () => { live = []; trail = FC(); map.getSource('d-trail').setData(trail); emit('trail-clear'); };

  async function onTelemetry(t) {
    const pos = [t.lon, t.lat];
    if (!marker) marker = mkMarker().setLngLat(pos).addTo(map);
    marker.setLngLat(pos).setRotation(t.heading ?? 0);
    const ground = await elevationAt(t.lon, t.lat);
    const agl = ground == null || t.alt_msl == null ? null : t.alt_msl - ground;
    if (!home && t.armed) home = { ground };
    const prev = live.at(-1);
    live.push({ pos, alt: t.alt_msl, ground, agl, t: t.t });
    emit('telemetry', { ...t, ground, agl, low: agl != null && t.armed && agl < aglMin() });
    if (live.length > 4000) live.shift();
    if (prev && haversine(prev.pos, pos) < 500) {
      trail.features.push(seg(prev.pos, pos, { v: t.alt_rel ?? 0, low: agl != null && t.armed && agl < aglMin() }));
      if (trail.features.length > 4000) trail.features.shift();
      map.getSource('d-trail').setData(trail);
    }

    const f = (v, u, d = 1) => (v == null || !Number.isFinite(+v) ? '—' : `${(+v).toFixed(d)} ${u}`);
    $('#h-alt').textContent = f(t.alt_msl, 'm');
    $('#h-agl').textContent = f(agl, 'm');
    $('#h-agl').className = agl != null && t.armed && agl < aglMin() ? 'warn' : 'ok';
    $('#h-rel').textContent = f(t.alt_rel, 'm');
    $('#h-gs').textContent = f(t.groundspeed, 'm/s');
    $('#h-hdg').textContent = f(t.heading, '°', 0);
    $('#h-bat').textContent = f(t.battery, '%', 0);
    $('#h-bat').className = t.battery != null && t.battery < 25 ? 'warn' : '';
    $('#h-mode').textContent = `${t.mode ?? '—'}${t.armed ? ' ●' : ''}`;
    $('#h-gps').textContent = t.fix == null ? '—' : `${t.fix >= 3 ? '3D' : t.fix + 'D'} · ${t.sats ?? '?'} sat`;

    const now = performance.now();
    if ($('#d-follow').checked && now - lastFollow > 1000) { lastFollow = now; map.easeTo({ center: pos, duration: 900 }); }
    if (liveChart && now - chartTick > 1000) { chartTick = now; drawLiveChart(); }
  }

  function drawLiveChart() {
    const pts = live.slice(-600), t0 = pts[0]?.t ?? 0;
    const el = app.openDrawer('Ketinggian live vs terrain (10 menit terakhir)', [['#22d3ee', 'Drone (MSL)'], ['#64748b', 'Terrain DEM'], ['#f87171', `Batas AGL ${aglMin()} m`]]);
    renderChart(el, {
      x: pts.map((p) => p.t - t0), fmtX: (s) => `${Math.round(s)} s`,
      series: [
        { name: 'Terrain', color: '#64748b', values: pts.map((p) => p.ground), area: true },
        { name: 'Batas', color: '#f87171', values: pts.map((p) => (p.ground == null ? NaN : p.ground + aglMin())), dash: true, width: 1.2 },
        { name: 'Drone', color: '#22d3ee', values: pts.map((p) => p.alt) },
      ],
    });
  }
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.textContent = 'Grafik ketinggian live';
  btn.onclick = () => { liveChart = true; drawLiveChart(); };
  $('#hud').after(btn);
  $('#drawer-x').addEventListener('click', () => (liveChart = false));

  // =====================================================================
  // ARSIP & KOMPARASI
  // =====================================================================
  let track = null, plan = null, rMarker = null, playing = null;
  const files = [];

  const drop = $('#drop');
  drop.onclick = () => $('#file').click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); };
  $('#file').onchange = (e) => handleFiles(e.target.files);
  $('#arch-sample').onclick = async () => {
    const get = async (n) => new File([await (await fetch(`/demo/${n}`)).blob()], n);
    handleFiles(await Promise.all(['survei_monas.plan', 'log_qgc_survei_monas.csv'].map(get)));
  };
  $('#arch-clear').onclick = () => {
    track = plan = null; files.length = 0; rMarker?.remove(); rMarker = null; emit('archive', { track, plan });
    map.getSource('a-track').setData(FC()); map.getSource('a-plan').setData(FC());
    $('#arch-files').innerHTML = $('#arch-stats').innerHTML = '';
    $('#replay-row').hidden = $('#replay-play').hidden = true;
    app.closeDrawer();
  };

  async function handleFiles(list) {
    for (const file of list) {
      try {
        const text = await file.text();
        if (/\.(plan|json)$/i.test(file.name)) {
          plan = parsePlan(text);
          files.push([file.name, `misi · ${plan.wps.length} WP`]);
        } else {
          track = parseTelemetryCSV(text);
          files.push([file.name, `log · ${track.length} titik`]);
        }
      } catch (err) {
        app.toast(`${file.name}: ${err.message}`, 4000);
      }
    }
    $('#arch-files').innerHTML = files.map(([n, d]) => `<div><b>${n}</b><span>${d}</span></div>`).join('');
    await analyse();
  }

  async function analyse() {
    const feats = [];
    if (plan) {
      plan.surveys.forEach((p) => feats.push({ type: 'Feature', properties: { k: 'survey' }, geometry: { type: 'Polygon', coordinates: [[...p, p[0]]] } }));
      plan.fence.forEach((p) => feats.push({ type: 'Feature', properties: { k: 'fence' }, geometry: { type: 'Polygon', coordinates: [[...p, p[0]]] } }));
      const route = plan.wps.map((w) => [w.lon, w.lat]);
      if (route.length > 1) feats.push({ type: 'Feature', properties: { k: 'route' }, geometry: { type: 'LineString', coordinates: route } });
      plan.wps.forEach((w) => feats.push({ type: 'Feature', properties: { k: 'wp' }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } }));
    }
    map.getSource('a-plan').setData(FC(feats));

    const bounds = new maplibregl.LngLatBounds();
    plan?.wps.forEach((w) => bounds.extend([w.lon, w.lat]));
    plan?.surveys.flat().forEach((c) => bounds.extend(c));

    const stats = [];
    if (track) {
      const ground = await elevations(track.map((p) => [p.lon, p.lat]));
      const homeGround = ground.find((g) => g != null) ?? 0;
      let d = 0;
      track.forEach((p, i) => {
        p.ground = ground[i];
        if (!Number.isFinite(p.alt)) p.alt = Number.isFinite(p.rel) ? p.rel + homeGround : NaN; // shortcut: alt relatif diasumsikan home = elevasi DEM titik pertama
        p.agl = p.ground == null ? NaN : p.alt - p.ground;
        d += i ? haversine([track[i - 1].lon, track[i - 1].lat], [p.lon, p.lat]) : 0;
        p.d = d;
        bounds.extend([p.lon, p.lat]);
      });
      const airborne = track.filter((p) => (Number.isFinite(p.rel) ? p.rel > 2 : p.agl > 2));
      const low = airborne.filter((p) => p.agl < aglMin());
      map.getSource('a-track').setData(FC(track.slice(1).map((p, i) => seg([track[i].lon, track[i].lat], [p.lon, p.lat],
        { v: Number.isFinite(p.rel) ? p.rel : p.agl, low: airborne.includes(p) && p.agl < aglMin() }))));
      const dur = track.at(-1).t - track[0].t;
      const maxAlt = Math.max(...track.map((p) => p.alt).filter(Number.isFinite));
      const minAgl = Math.min(...airborne.map((p) => p.agl).filter(Number.isFinite));
      stats.push(['Jarak tempuh', fmtDist(d)], ['Durasi', `${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s`],
        ['Alt maks (MSL)', `${maxAlt.toFixed(1)} m`], ['AGL min (udara)', Number.isFinite(minAgl) ? `${minAgl.toFixed(1)} m` : '—', minAgl < aglMin()],
        ['Di bawah batas AGL', `${airborne.length ? ((low.length / airborne.length) * 100).toFixed(1) : 0}%`, low.length > 0]);

      if (plan && plan.wps.length > 1) {
        const route = plan.wps.map((w) => [w.lon, w.lat]);
        const dev = airborne.map((p) => distToPolyline([p.lon, p.lat], route));
        if (dev.length) stats.push(['Deviasi lateral rata²', `${(dev.reduce((a, b) => a + b, 0) / dev.length).toFixed(1)} m`],
          ['Deviasi lateral maks', `${Math.max(...dev).toFixed(1)} m`, Math.max(...dev) > 20]);
      }

      const el = app.openDrawer('Profil penerbangan: ketinggian vs terrain', [['#22d3ee', 'Drone (MSL)'], ['#64748b', 'Terrain DEM'], ['#f87171', `Terrain + ${aglMin()} m`]]);
      renderChart(el, {
        x: track.map((p) => p.d),
        series: [
          { name: 'Terrain', color: '#64748b', values: track.map((p) => p.ground ?? NaN), area: true },
          { name: 'Batas AGL', color: '#f87171', values: track.map((p) => (p.ground == null ? NaN : p.ground + aglMin())), dash: true, width: 1.2 },
          { name: 'Drone', color: '#22d3ee', values: track.map((p) => p.alt) },
        ],
        onHover: (i) => i != null && setReplay(i),
      });

      $('#replay').max = track.length - 1; $('#replay').value = 0;
      $('#replay-row').hidden = $('#replay-play').hidden = false;
      setReplay(0);
    }
    if (plan) stats.push(['Waypoint misi', plan.wps.length], ['Frame ketinggian', plan.wps[0]?.frame ?? '—']);
    $('#arch-stats').innerHTML = stats.map(([k, v, warn]) => `<div><small>${k}</small><b class="${warn ? 'warn' : ''}">${v}</b></div>`).join('');
    emit('archive', { track, plan, aglMin: aglMin() });
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 60, bottom: 300, left: 60, right: 60 }, pitch: 40, duration: 1200 });
  }

  function setReplay(i) {
    const p = track[i]; if (!p) return;
    rMarker ??= mkMarker().setLngLat([p.lon, p.lat]).addTo(map);
    const n = track[Math.min(i + 1, track.length - 1)], b = track[Math.max(i - 1, 0)];
    rMarker.setLngLat([p.lon, p.lat]).setRotation((Math.atan2(n.lon - b.lon, n.lat - b.lat) * 180) / Math.PI);
    $('#replay').value = i;
    $('#replay-t').textContent = `${Math.round(p.t - track[0].t)}s`;
  }
  $('#replay').oninput = (e) => setReplay(+e.target.value);
  $('#replay-play').onclick = () => {
    if (playing) { clearInterval(playing); playing = null; $('#replay-play').textContent = '▶ Putar'; return; }
    $('#replay-play').textContent = '❚❚ Jeda';
    playing = setInterval(() => {
      const i = +$('#replay').value + 1;
      if (i >= track.length) { $('#replay-play').click(); return; }
      setReplay(i);
    }, 120);
  };
}
