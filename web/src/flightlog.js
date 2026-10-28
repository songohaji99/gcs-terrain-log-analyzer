// Tab "Log": analisis misi (.plan/.waypoints) + flight log ArduPilot (.bin/.log/.tlog).
// Semua file diproses lokal (Web Worker untuk log); tidak ada data misi/log yang dikirim ke server mana pun.
import maplibregl from 'maplibre-gl';
import { parseMission, normalizeItem, FRAME_LABEL } from './mission.js';
import { buildNav, plannedProfile, flightRisk, missionSamples, planRisk, compareWaypoint, interp, nearestIndex, modeAt } from './analysis.js';
import { elevationAt, elevations } from './elevation.js';
import { renderChart, fmtDist } from './chart.js';
import { haversine } from './geo.js';

const $ = (s) => document.querySelector(s);
const FC = (features = []) => ({ type: 'FeatureCollection', features });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MODE_COLORS = { AUTO: '#22d3ee', FBWA: '#fbbf24', FBWB: '#f59e0b', CRUISE: '#2dd4bf', MANUAL: '#94a3b8', STABILIZE: '#94a3b8', RTL: '#f87171', LOITER: '#a78bfa', CIRCLE: '#c084fc', TAKEOFF: '#34d399', GUIDED: '#60a5fa', LAND: '#fb7185', QLAND: '#fb7185', ALT_HOLD: '#fbbf24', POSHOLD: '#a3e635' };
const PALETTE = ['#60a5fa', '#f472b6', '#2dd4bf', '#facc15', '#c084fc', '#fb923c', '#4ade80', '#38bdf8'];
const modeColor = (m) => MODE_COLORS[m] ?? PALETTE[[...String(m)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]; // selalu hex (alpha ditambahkan sebagai akhiran)
const ST_COLOR = { ok: '#34d399', warn: '#fbbf24', bad: '#f87171', na: '#64748b' };
const LOG_EXT = /\.(bin|log|tlog|ulg)$/i, MIS_EXT = /\.(plan|waypoints|txt|json)$/i;
const DRONE_SVG = `<svg viewBox="0 0 40 40" style="stroke:none"><path d="M20 3 L29 33 L20 27 L11 33 Z" fill="#fbbf24" stroke="#0b1220" stroke-width="1.5"/></svg>`;
const f1 = (v, u = '', d = 1) => (Number.isFinite(v) ? `${v.toFixed(d)}${u}` : '<span class="na">tidak tersedia</span>');
const fA = (v) => (v == null ? '—' : String(+(+v).toFixed(1))); // ketinggian float32 dari QGC (15.239999…) -> 15.2
const fmtT = (s) => `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function initFlightLog(app) {
  const { map } = app;
  const S = { mission: null, missionName: null, log: null, logName: null, files: [], nav: [], terrainBySeq: {}, cursorT: 0, tab: 'profile', chart: null, play: null };
  let worker = null, jobId = 0;
  const thr = () => +$('#fl-thr').value || 30, tolH = () => +$('#fl-tolh').value || 30, tolV = () => +$('#fl-tolv').value || 10;

  // ---------- layer peta ----------
  for (const id of ['fl-plan', 'fl-plan-risk', 'fl-track', 'fl-risk', 'fl-reach']) map.addSource(id, { type: 'geojson', data: FC(), tolerance: 0 });
  map.addLayer({ id: 'fl-plan-line', type: 'line', source: 'fl-plan', filter: ['==', ['get', 'k'], 'route'], paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'fl-plan-risk', type: 'line', source: 'fl-plan-risk', paint: { 'line-color': '#f87171', 'line-width': 4, 'line-dasharray': [1, 1] } });
  map.addLayer({ id: 'fl-risk', type: 'line', source: 'fl-risk', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#f87171', 'line-width': 11, 'line-opacity': 0.45, 'line-blur': 2 } });
  map.addLayer({ id: 'fl-track', type: 'line', source: 'fl-track', layout: { 'line-cap': 'round' }, paint: { 'line-width': 3.5, 'line-color': '#22d3ee' } });
  map.addLayer({ id: 'fl-reach', type: 'circle', source: 'fl-reach', paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'fl-wp', type: 'circle', source: 'fl-plan', filter: ['==', ['get', 'k'], 'wp'],
    paint: { 'circle-radius': 9, 'circle-color': '#0b1220', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'fl-wp-label', type: 'symbol', source: 'fl-plan', filter: ['==', ['get', 'k'], 'wp'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-allow-overlap': true }, paint: { 'text-color': '#fbbf24' } });
  const cursorEl = Object.assign(document.createElement('div'), { className: 'drone-marker', innerHTML: DRONE_SVG });
  const cursor = new maplibregl.Marker({ element: cursorEl, rotationAlignment: 'map', pitchAlignment: 'map' });

  for (const id of ['fl-wp', 'fl-reach', 'fl-track']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'fl-wp', (e) => openCompare(e.features[0].properties.idx));
  map.on('click', 'fl-reach', (e) => openCompare(e.features[0].properties.k));
  let raf = 0;
  map.on('mousemove', 'fl-track', (e) => {
    const i = e.features[0].properties.i;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => S.mg && setCursor(S.mg.t[i]));
  });

  // ---------- file ----------
  const drop = $('#fl-drop');
  drop.onclick = () => $('#fl-file').click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); };
  $('#fl-file').onchange = (e) => handleFiles([...e.target.files]);
  const sample = (names) => async () => handleFiles(await Promise.all(names.map(async (n) => new File([await (await fetch(`/demo/${n}`)).blob()], n))));
  $('#fl-sample-bin').onclick = sample(['sentul_plane.plan', 'sentul_plane.bin']);
  $('#fl-sample-tlog').onclick = sample(['sentul_plane.waypoints', 'sentul_plane.tlog']);
  $('#fl-clear').onclick = clearAll;
  for (const id of ['#fl-thr', '#fl-tolh', '#fl-tolv']) $(id).onchange = () => analyse(false);
  $('#fl-color').onchange = paintTrack;

  function setFile(name, kind, status, cls = '') {
    const f = S.files.find((x) => x.name === name);
    if (f) Object.assign(f, { kind, status, cls }); else S.files.push({ name, kind, status, cls });
    $('#fl-files').innerHTML = S.files.map((x) => `<div><b>${esc(x.name)}</b><span class="${x.cls}">${esc(x.status)}</span></div>`).join('');
  }

  async function handleFiles(files) {
    const jobs = [];
    for (const file of files) {
      if (MIS_EXT.test(file.name)) {
        try {
          const m = parseMission(await file.text(), file.name);
          S.mission = m; S.missionName = file.name;
          setFile(file.name, 'misi', `${m.format} · ${m.items.length} item${m.warnings.length ? ` · ${m.warnings.length} peringatan` : ''}`, m.warnings.length ? 'warn' : '');
        } catch (e) { setFile(file.name, 'misi', e.message, 'err'); }
      } else if (LOG_EXT.test(file.name)) {
        jobs.push(parseLogInWorker(file).then((model) => {
          S.log = model; S.logName = file.name;
          setFile(file.name, 'log', `${model.format} · ${model.streams.gps.t.length.toLocaleString('id-ID')} titik GPS · ${fmtT(model.duration)}`);
        }).catch((e) => setFile(file.name, 'log', e.message, 'err')));
      } else setFile(file.name, '?', 'ekstensi tidak didukung (.plan .waypoints .txt .bin .log .tlog)', 'err');
    }
    await Promise.all(jobs);
    analyse(true);
  }

  function parseLogInWorker(file) {
    worker ??= new Worker(new URL('./logworker.js', import.meta.url), { type: 'module' });
    const id = ++jobId;
    setFile(file.name, 'log', 'memproses…');
    return file.arrayBuffer().then((buf) => new Promise((resolve, reject) => {
      const onMsg = ({ data }) => {
        if (data.id !== id) return;
        if (data.progress != null) return setFile(file.name, 'log', `memproses ${Math.round(data.progress * 100)}%`);
        worker.removeEventListener('message', onMsg);
        data.error ? reject(new Error(data.error)) : resolve(data.model);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id, name: file.name, buf }, [buf]);
    }));
  }

  function clearAll() {
    Object.assign(S, { mission: null, log: null, files: [], nav: [], mg: null, pr: null });
    for (const id of ['fl-plan', 'fl-plan-risk', 'fl-track', 'fl-risk', 'fl-reach']) map.getSource(id).setData(FC());
    cursor.remove(); clearInterval(S.play); S.play = null;
    ['#fl-files', '#fl-stats', '#fl-legend', '#fl-wplist', '#fl-assume', '#fl-readout'].forEach((s) => ($(s).innerHTML = ''));
    $('#fl-time-row').hidden = $('#fl-play').hidden = $('#fl-readout').hidden = true;
    app.closeDrawer();
  }

  // ---------- analisis ----------
  async function analyse(fit) {
    const log = S.log;
    let mission = S.mission;
    if (!mission && log?.cmds.length) mission = { format: 'misi dari log (CMD/MISSION_ITEM)', items: log.cmds.map((c) => normalizeItem(c.seq, c.command, c.frame, c.params, c.lat, c.lon, c.alt)), surveys: [], fence: [], warnings: [] };
    if (!mission && !log) return;
    S.missionUsed = mission;

    // home AMSL: home di log (CMD#0/MISSION_ITEM_INT#0) > home file misi > fix GPS pertama
    const logHome = log?.cmds.find((c) => c.seq === 0 && c.lat);
    const fileHome = mission?.items.find((i) => i.seq === 0 && i.lat != null);
    const homeAmsl = logHome?.alt ?? fileHome?.alt ?? log?.streams.gps.alt[0] ?? null;
    S.homeSrc = logHome ? 'home di log' : fileHome ? 'home file misi' : 'fix GPS pertama';

    if (mission) {
      const navItems = mission.items.filter((i) => i.nav && i.lat != null);
      const tv = await elevations(navItems.map((i) => [i.lon, i.lat]));
      S.terrainBySeq = Object.fromEntries(navItems.map((i, k) => [i.seq, tv[k]]));
      S.nav = buildNav(mission, homeAmsl, S.terrainBySeq);
      S.planSamples = missionSamples(S.nav, 30);
      S.planTerrain = await elevations(S.planSamples.map((s) => s.lngLat));
      S.pr = planRisk(S.planSamples, S.planTerrain, thr());
    } else S.nav = [];

    if (log) {
      const g = log.streams.gps, step = Math.max(1, Math.ceil(g.t.length / 5000));
      const idx = Array.from({ length: Math.ceil(g.t.length / step) }, (_, k) => k * step);
      const mg = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Float64Array.from(idx, (i) => v[i])]));
      mg.terrain = Float64Array.from(await elevations(idx.map((i) => [g.lon[i], g.lat[i]])), (v) => v ?? NaN);
      mg.d = new Float64Array(mg.t.length);
      for (let i = 1; i < mg.t.length; i++) mg.d[i] = mg.d[i - 1] + haversine([mg.lon[i - 1], mg.lat[i - 1]], [mg.lon[i], mg.lat[i]]);
      const pp = S.nav.length ? plannedProfile(mg, S.nav, log) : { planned: new Float64Array(mg.t.length).fill(NaN), target: new Int32Array(mg.t.length).fill(-1) };
      mg.planned = pp.planned; mg.target = pp.target;
      mg.mode = Array.from(mg.t, (t) => modeAt(log.modes, t));
      S.risk = flightRisk(mg, mg.terrain, mg.target, S.nav, thr());
      S.mg = mg;
    } else S.mg = null;

    let afterT = -Infinity;
    S.comp = S.nav.map((n, k) => {
      if (!k) return null;
      const c = compareWaypoint(k, S.nav, mission, log, { terrainBySeq: S.terrainBySeq, tolH: tolH(), tolV: tolV(), afterT });
      if (c.log) afterT = c.log.t;
      return c;
    });
    drawMap(fit);
    drawStats(mission, log);
    drawWpList();
    if (log) {
      $('#fl-time').max = log.duration; $('#fl-time-row').hidden = $('#fl-play').hidden = $('#fl-readout').hidden = false;
      setCursor(Math.min(S.cursorT, log.duration));
    }
    drawChart();
    app.bus.dispatchEvent(new CustomEvent('flightlog', { detail: { mission, log } }));
  }

  const worst = (st) => (['bad', 'warn', 'ok'].find((x) => Object.values(st ?? {}).includes(x)) ?? 'na');

  function drawMap(fit) {
    const feats = [];
    const nav = S.nav.filter((n) => n.lon != null);
    if (nav.length > 1) feats.push({ type: 'Feature', properties: { k: 'route' }, geometry: { type: 'LineString', coordinates: nav.map((n) => [n.lon, n.lat]) } });
    S.nav.forEach((n, k) => k && !n.posAssumed && feats.push({ type: 'Feature', properties: { k: 'wp', label: String(n.seq), color: ST_COLOR[worst(S.comp[k]?.status)], idx: k }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } }));
    map.getSource('fl-plan').setData(FC(feats));
    map.getSource('fl-plan-risk').setData(FC((S.pr?.runs ?? []).map((r) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: S.planSamples.slice(r.i0, r.i1 + 1).map((s) => s.lngLat) } })).filter((f) => f.geometry.coordinates.length > 1)));

    const mg = S.mg;
    if (mg) {
      // potongan ≤ 8 titik (putus saat mode berganti): segmen 2-titik ±3 m akan dibuang simplifikasi geojson-vt di zoom rendah
      const seg = [];
      for (let s0 = 0; s0 < mg.t.length - 1;) {
        let e = s0 + 1;
        while (e < mg.t.length - 1 && e - s0 < 8 && mg.mode[e] === mg.mode[s0 + 1]) e++;
        const mid = (s0 + e) >> 1;
        seg.push({ type: 'Feature', properties: { i: mid, alt: mg.alt[mid], spd: mg.spd[mid], mode: mg.mode[mid] ?? '?' }, geometry: { type: 'LineString', coordinates: Array.from({ length: e - s0 + 1 }, (_, j) => [mg.lon[s0 + j], mg.lat[s0 + j]]) } });
        s0 = e;
      }
      map.getSource('fl-track').setData(FC(seg));
      map.getSource('fl-risk').setData(FC(S.risk.runs.map((r) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: Math.max(2, r.i1 - r.i0 + 1) }, (_, j) => [mg.lon[Math.min(r.i0 + j, mg.t.length - 1)], mg.lat[Math.min(r.i0 + j, mg.t.length - 1)]]) } }))));
      map.getSource('fl-reach').setData(FC(S.comp.map((c, k) => c?.log && { type: 'Feature', properties: { k, color: ST_COLOR[worst(c.status)] }, geometry: { type: 'Point', coordinates: [c.log.lon, c.log.lat] } }).filter(Boolean)));
      paintTrack();
    } else ['fl-track', 'fl-risk', 'fl-reach'].forEach((id) => map.getSource(id).setData(FC()));

    if (fit) {
      const b = new maplibregl.LngLatBounds();
      nav.forEach((n) => b.extend([n.lon, n.lat]));
      if (mg) for (let i = 0; i < mg.t.length; i += 10) b.extend([mg.lon[i], mg.lat[i]]);
      if (!b.isEmpty()) map.fitBounds(b, { padding: { top: 70, bottom: 360, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 900 });
    }
  }

  function paintTrack() {
    const mg = S.mg; if (!mg) return;
    const by = $('#fl-color').value;
    let expr, legend;
    if (by === 'mode') {
      const modes = [...new Set(mg.mode.filter(Boolean))];
      expr = modes.length ? ['match', ['get', 'mode'], ...modes.flatMap((m) => [m, modeColor(m)]), '#64748b'] : '#64748b';
      legend = modes.map((m) => `<span class="chip-m"><i style="background:${modeColor(m)}"></i>${esc(m)}</span>`).join('');
    } else {
      const key = by === 'speed' ? 'spd' : 'alt', vals = mg[key].filter(Number.isFinite);
      let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1) hi = lo + 1;
      const cols = by === 'speed' ? ['#34d399', '#fbbf24', '#f87171'] : ['#22d3ee', '#818cf8', '#e879f9'];
      expr = ['interpolate', ['linear'], ['get', key], lo, cols[0], (lo + hi) / 2, cols[1], hi, cols[2]];
      legend = `<div class="grad" style="background:linear-gradient(90deg,${cols.join(',')})"></div><div class="grad-l"><span>${lo.toFixed(0)}</span><span>${by === 'speed' ? 'Groundspeed (m/s)' : 'Ketinggian GPS (m AMSL)'}</span><span>${hi.toFixed(0)}</span></div>`;
    }
    map.setPaintProperty('fl-track', 'line-color', expr);
    $('#fl-legend').innerHTML = legend + `<div class="leg-row"><i style="background:#f87171;opacity:.6"></i>AGL &lt; ${thr()} m (aktual) <i style="background:#f87171" class="dash"></i>clearance rencana &lt; ${thr()} m</div>`;
  }

  function drawStats(mission, log) {
    const st = [];
    const warn = (v) => Number.isFinite(v) && v < thr();
    if (log) {
      const mg = S.mg, alts = mg.alt.filter(Number.isFinite);
      st.push(['Format', log.format], ['Durasi', fmtT(log.duration).slice(2)], ['Jarak', fmtDist(mg.d.at(-1))], ['Alt maks', `${Math.max(...alts).toFixed(0)} m AMSL`],
        ['AGL min (aktual)', f1(S.risk.minAgl, ' m'), warn(S.risk.minAgl)], ['Durasi berisiko', `${S.risk.riskSec.toFixed(0)} s · ${S.risk.runs.length} segmen`, S.risk.runs.length > 0]);
      const navK = S.nav.length - 1, got = S.comp.filter((c) => c?.log?.source === 'reached').length;
      if (navK > 0) st.push(['WP tercapai (event)', `${got} / ${navK}`, got < navK]);
    }
    if (mission) st.push(['Misi', `${mission.format}`], ['Clearance min rencana', f1(S.pr?.min, ' m'), warn(S.pr?.min)], ['Leg rencana berisiko', `${Object.values(S.pr?.perLeg ?? {}).filter((v) => v < thr()).length}`, Object.values(S.pr?.perLeg ?? {}).some((v) => v < thr())]);
    $('#fl-stats').innerHTML = st.map(([k, v, w]) => `<div><small>${k}</small><b class="${w ? 'warn' : ''}">${v}</b></div>`).join('');
    const notes = [];
    if (log?.vehicleAssumed) notes.push('Tipe kendaraan tidak terdeteksi di log — <b>diasumsikan ArduPlane</b> (tabel mode Plane).');
    if (log && !Object.keys(log.params).some((k) => /^SERVO\d+_FUNCTION$/.test(k))) notes.push('Parameter SERVOn_FUNCTION tidak ada di log — kanal aileron tidak bisa ditentukan.');
    if (S.nav.length) notes.push(`Home AMSL dari ${S.homeSrc}. Terrain: DEM Terrarium ±30 m (DSM, ±EGM96).`);
    (S.mission?.warnings ?? []).forEach((w) => notes.push(`Misi: ${esc(w)}`));
    $('#fl-assume').innerHTML = notes.join('<br>');
  }

  function drawWpList() {
    $('#fl-wplist').innerHTML = S.nav.map((n, k) => {
      if (!k) return '';
      const c = S.comp[k];
      return `<div data-k="${k}"><i class="dot" style="background:${ST_COLOR[worst(c?.status)]}"></i><b>WP ${n.seq}</b> ${esc(n.item.name.replace('NAV_', ''))}
        <small>${fA(n.item.alt)} m ${FRAME_LABEL[n.item.frame] ?? n.item.frame}${n.amsl != null ? ` → ${n.amsl.toFixed(0)} m AMSL` : ''}${c?.log ? ` · Δ ${Number.isFinite(c.log.horiz) ? c.log.horiz.toFixed(0) : '—'} m / ${Number.isFinite(c.log.dAlt) ? c.log.dAlt.toFixed(0) : '—'} m` : ''}</small></div>`;
    }).join('');
    $('#fl-wplist').onclick = (e) => { const d = e.target.closest('[data-k]'); if (d) openCompare(+d.dataset.k); };
  }

  // ---------- grafik ----------
  const TABS = [
    ['profile', 'Profil terrain'], ['alt', 'Ketinggian'], ['speed', 'Kecepatan'], ['att', 'Attitude'],
    ['engine', 'Throttle'], ['rpm', 'RPM'], ['servo', 'Aileron'], ['bat', 'Baterai'],
  ];
  function drawChart() {
    const log = S.log, st = log?.streams ?? {};
    const avail = { profile: !!(S.mg || S.planSamples?.length), alt: !!log, speed: !!log, att: !!st.att, engine: !!st.thr, rpm: !!st.rpm, servo: !!st.servo, bat: !!st.bat };
    if (!avail[S.tab]) S.tab = 'profile';
    if (!avail.profile) return;
    const tabs = { items: TABS.map(([id, label]) => ({ id, label, disabled: !avail[id] })), active: S.tab, onSelect: (id) => { S.tab = id; drawChart(); } };
    const thrV = thr();
    let cfg;
    if (S.tab === 'profile') {
      if (S.mg) {
        const mg = S.mg;
        cfg = { title: 'Profil: terrain vs rencana vs aktual', legend: [['#64748b', 'Terrain DEM'], ['#fbbf24', 'Rencana (leg aktif)'], ['#22d3ee', 'Aktual (GPS)'], ['#f87171', `Terrain + ${thrV} m`]],
          x: mg.d, series: [{ name: 'Terrain', color: '#64748b', values: mg.terrain, area: true }, { name: `Terrain+${thrV}`, color: '#f87171', values: mg.terrain.map((v) => v + thrV), dash: true, width: 1.2 },
            { name: 'Rencana', color: '#fbbf24', values: mg.planned, dash: true }, { name: 'Aktual', color: '#22d3ee', values: mg.alt }],
          bands: S.risk.runs.map((r) => ({ x0: mg.d[r.i0], x1: mg.d[r.i1], color: 'rgba(248,113,113,.18)' })),
          marks: reachMarks((t) => mg.d[nearestIndex(mg.t, t)]), toIndex: (t) => nearestIndex(mg.t, t), fromIndex: (i) => mg.t[i] };
      } else {
        const ps = S.planSamples;
        cfg = { title: 'Profil rencana (tanpa log)', legend: [['#64748b', 'Terrain DEM'], ['#fbbf24', 'Rencana'], ['#f87171', `Terrain + ${thrV} m`]],
          x: ps.map((s) => s.d), series: [{ name: 'Terrain', color: '#64748b', values: S.planTerrain.map((v) => v ?? NaN), area: true }, { name: `Terrain+${thrV}`, color: '#f87171', values: S.planTerrain.map((v) => (v ?? NaN) + thrV), dash: true, width: 1.2 }, { name: 'Rencana', color: '#fbbf24', values: ps.map((s) => s.planned) }],
          bands: S.pr.runs.map((r) => ({ x0: ps[r.i0].d, x1: ps[r.i1].d, color: 'rgba(248,113,113,.18)' })), marks: [] };
      }
    } else {
      const N = Math.min(1500, Math.max(2, Math.round(log.duration * 4)));
      const grid = Float64Array.from({ length: N }, (_, i) => (log.duration * i) / (N - 1));
      const on = (s, key) => grid.map((t) => interp(s.t, s[key], t));
      const series = {
        alt: [{ name: 'Terrain', color: '#64748b', values: grid.map((t) => interp(S.mg.t, S.mg.terrain, t)), area: true }, { name: 'Rencana', color: '#fbbf24', values: grid.map((t) => interp(S.mg.t, S.mg.planned, t)), dash: true }, { name: 'GPS', color: '#22d3ee', values: on(st.gps, 'alt') }],
        speed: [{ name: 'Groundspeed', color: '#22d3ee', values: on(st.gps, 'spd'), unit: 'm/s' }, ...(st.aspd ? [{ name: 'Airspeed', color: '#e879f9', values: on(st.aspd, 'v'), unit: 'm/s' }] : [])],
        att: st.att && [{ name: 'DesRoll', color: '#fbbf24', values: on(st.att, 'desRoll'), dash: true, unit: '°' }, { name: 'Roll', color: '#22d3ee', values: on(st.att, 'roll'), unit: '°' }, { name: 'Pitch', color: '#a3e635', values: on(st.att, 'pitch'), unit: '°', width: 1.2 }],
        engine: st.thr && [{ name: 'Throttle', color: '#f97316', values: on(st.thr, 'v'), unit: '%' }],
        rpm: st.rpm && [{ name: 'RPM', color: '#f97316', values: on(st.rpm, 'v'), unit: 'rpm' }],
        servo: st.servo && aileronChannels().map((c, j) => ({ name: `SERVO${c.ch} (fn ${c.fn})`, color: ['#22d3ee', '#e879f9', '#a3e635', '#fbbf24'][j % 4], values: on(st.servo, `ch${c.ch}`), unit: 'µs' })),
        bat: st.bat && [{ name: 'Tegangan', color: '#34d399', values: on(st.bat, 'volt'), unit: 'V' }],
      }[S.tab];
      const unit = { alt: 'm', speed: 'm/s', att: '°', engine: '%', rpm: '', servo: 'µs', bat: 'V' }[S.tab];
      const title = { alt: 'Ketinggian vs waktu', speed: 'Kecepatan', att: 'Roll vs DesRoll, Pitch', engine: 'Throttle (CTUN.ThO / VFR_HUD)', rpm: 'RPM mesin', servo: 'Output servo aileron (SERVOn_FUNCTION)', bat: 'Baterai' }[S.tab];
      cfg = { title, legend: [], x: grid, series: series?.length ? series : [], unit, fmtX: (s) => fmtT(s).slice(2),
        bands: log.modes.map((m, i) => ({ x0: m.t, x1: log.modes[i + 1]?.t ?? log.duration, color: modeColor(m.name) + '1f', label: m.name })),
        marks: reachMarks((t) => t), toIndex: (t) => nearestIndex(grid, t), fromIndex: (i) => grid[i] };
      if (S.tab === 'servo' && !cfg.series.length) cfg.empty = 'Kanal aileron tidak dapat ditentukan: SERVOn_FUNCTION = 4 tidak ada di log.';
    }
    const el = app.openDrawer(cfg.title, cfg.legend, tabs);
    if (cfg.empty) { el.innerHTML = `<div class="muted" style="padding:16px">${cfg.empty}</div>`; S.chart = null; return; }
    S.chart = { ...renderChart(el, { x: cfg.x, series: cfg.series, unit: cfg.unit, fmtX: cfg.fmtX, bands: cfg.bands, marks: cfg.marks,
      onHover: (i) => i != null && cfg.fromIndex && setCursor(cfg.fromIndex(i), 'chart'), onMark: (j) => openCompare(cfg.marks[j].k) }), toIndex: cfg.toIndex };
    S.chart.toIndex && S.chart.setCursor(S.chart.toIndex(S.cursorT));
  }
  function reachMarks(xOf) {
    return S.comp.map((c, k) => c?.log && { x: xOf(c.log.t), label: String(c.mission.seq), color: ST_COLOR[worst(c.status)], k }).filter(Boolean);
  }
  function aileronChannels() {
    return Object.entries(S.log?.params ?? {}).filter(([k, v]) => /^SERVO\d+_FUNCTION$/.test(k) && [4, 77, 78].includes(v)).map(([k, v]) => ({ ch: +k.match(/\d+/)[0], fn: v }));
  }

  // ---------- cursor waktu (sinkron peta ↔ grafik ↔ slider) ----------
  function setCursor(t, from) {
    const log = S.log; if (!log) return;
    S.cursorT = t;
    const g = log.streams.gps, lat = interp(g.t, g.lat, t), lon = interp(g.t, g.lon, t);
    if (Number.isFinite(lat)) {
      const yaw = log.streams.att ? interp(log.streams.att.t, log.streams.att.yaw, t) : NaN;
      cursor.setLngLat([lon, lat]).setRotation(Number.isFinite(yaw) ? yaw : 0);
      if (!cursor._map) cursor.addTo(map);
    }
    $('#fl-time').value = t;
    $('#fl-time-v').textContent = fmtT(t);
    if (from !== 'chart' && S.chart?.toIndex) S.chart.setCursor(S.chart.toIndex(t));
    const mg = S.mg, i = nearestIndex(mg.t, t), st = log.streams;
    const at = (s, k) => (s ? interp(s.t, s[k], t) : NaN);
    const utc = log.t0Unix ? new Date((log.t0Unix + t) * 1000).toISOString().slice(11, 19) + ' UTC' : '';
    $('#fl-readout').innerHTML = `<div class="card-h">${fmtT(t)} <small>${utc}</small><span class="pill" style="background:${modeColor(modeAt(log.modes, t))}33;color:${modeColor(modeAt(log.modes, t))}">${esc(modeAt(log.modes, t) ?? '—')}</span></div>
      <div class="kv"><span>Alt GPS</span><b>${f1(at(g, 'alt'), ' m AMSL')}</b><span>AGL</span><b class="${S.risk.agl[i] < thr() ? 'warn' : ''}">${f1(S.risk.agl[i], ' m')}</b>
      <span>Rencana</span><b>${f1(mg.planned[i], ' m AMSL')}</b><span>Groundspeed</span><b>${f1(at(g, 'spd'), ' m/s')}</b>
      <span>Throttle</span><b>${f1(at(st.thr, 'v'), ' %', 0)}</b><span>Roll / Des</span><b>${f1(at(st.att, 'roll'), '°')} / ${f1(at(st.att, 'desRoll'), '°')}</b></div>`;
  }
  $('#fl-time').oninput = (e) => setCursor(+e.target.value);
  $('#fl-play').onclick = () => {
    if (S.play) { clearInterval(S.play); S.play = null; $('#fl-play').textContent = '▶ Putar 10×'; return; }
    $('#fl-play').textContent = '❚❚ Jeda';
    S.play = setInterval(() => { const t = S.cursorT + 0.5; if (t > S.log.duration) return $('#fl-play').click(); setCursor(t); }, 50);
  };

  // ---------- popup komparasi waypoint ----------
  async function openCompare(k) {
    const c = S.comp[k], n = S.nav[k]; if (!c) return;
    const m = c.mission, L = c.log, log = S.log;
    const tAt = L && (await elevationAt(L.lon, L.lat));
    const cls = (s) => `st-${s ?? 'na'}`;
    const dv = (v, s, u = ' m') => `<td class="${cls(s)}">${Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + u : '—'}</td>`;
    const src = { reached: 'event reached', start: 'perkiraan: awal perintah berikutnya', closest: 'titik terdekat (tak ada event)' }[L?.source];
    const cmdTxt = (it) => `<li><b>${esc(it.name)}</b> <small>seq ${it.seq}</small> ${paramText(it)}</li>`;
    const eng = c.engine, ail = c.aileron;
    const html = `<div class="cmp">
      <div class="cmp-h"><b>WP ${m.seq}</b> ${esc(m.name)} <span class="pill">${esc(FRAME_LABEL[m.frame] ?? m.frame)}</span></div>
      <table><tr><th></th><th>Misi</th><th>Log</th><th>Δ</th></tr>
        <tr><td>Posisi</td><td>${m.posAssumed ? '<span class="na">tanpa posisi</span>' : `${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}`}</td><td>${L ? `${L.lat.toFixed(6)}, ${L.lon.toFixed(6)}` : '<span class="na">tidak tersedia</span>'}</td>${dv(L?.horiz, c.status.horiz)}</tr>
        <tr><td>Cross-track</td><td>—</td><td>leg WP ${S.nav[k - 1].seq}→${m.seq}</td>${dv(L?.xtrack, c.status.xtrack)}</tr>
        <tr><td>Ketinggian</td><td>${fA(m.alt)} m ${esc(FRAME_LABEL[m.frame] ?? '')}<br><small>= ${f1(m.amsl, ' m AMSL', 0)}</small></td><td>${L ? f1(L.alt, ' m AMSL') : '—'}</td>${dv(L?.dAlt, c.status.alt)}</tr>
        <tr><td>Selisih 3D</td><td></td><td></td>${dv(L?.d3, c.status.d3)}</tr>
        <tr><td>Terrain</td><td>${f1(m.terrain, ' m')}</td><td>${f1(tAt ?? NaN, ' m')}</td><td></td></tr>
        <tr><td>AGL</td><td>${f1(m.aglPlan, ' m')}</td><td>${L && tAt != null ? f1(L.alt - tAt, ' m') : '—'}</td><td></td></tr>
        <tr><td>Groundspeed</td><td></td><td>${L ? f1(L.gs, ' m/s') : '—'}</td><td></td></tr>
        <tr><td>Waktu</td><td></td><td>${L ? `${fmtT(L.t)}${log.t0Unix ? ' · ' + new Date((log.t0Unix + L.t) * 1000).toISOString().slice(11, 19) + ' UTC' : ''}<br><small>${src} · mode ${esc(L.mode ?? '—')}</small>` : '<span class="na">tidak tersedia</span>'}</td><td></td></tr>
      </table>
      <div class="cmp-s"><b>Engine</b>
        <div class="kv"><span>Throttle</span><b>${eng ? (eng.has.thr ? f1(eng.thr, ' %', 0) : '<span class="na">tidak tersedia (tak ada CTUN.ThO/VFR_HUD)</span>') : '—'}</b>
        <span>RPM</span><b>${eng ? (eng.has.rpm ? f1(eng.rpm, '', 0) : '<span class="na">tidak tersedia (tak ada pesan RPM)</span>') : '—'}</b></div>
        ${eng?.cmds.length ? `<ul>${eng.cmds.map(cmdTxt).join('')}</ul>` : '<small class="na">Tidak ada DO_CHANGE_SPEED / DO_ENGINE_CONTROL pada leg ini.</small>'}</div>
      <div class="cmp-s"><b>Aileron</b>
        ${ail ? (ail.paramsKnown ? (ail.channels.length ? `<div class="kv">${ail.channels.map((ch) => `<span>SERVO${ch.ch} ${ch.fn === 4 ? 'aileron' : 'elevon'}</span><b>${f1(ch.pwm, ' µs', 0)}</b>`).join('')}</div>` : '<small class="na">Tidak ada kanal dengan SERVOn_FUNCTION = 4/77/78.</small>')
          : '<small class="na">SERVOn_FUNCTION tidak ada di log — kanal aileron tidak ditebak.</small>') : '—'}
        <div class="kv"><span>Roll / DesRoll</span><b>${ail ? `${f1(ail.roll, '°')} / ${f1(ail.desRoll, '°')}${Number.isFinite(ail.roll - ail.desRoll) ? ` <small>(Δ ${(ail.roll - ail.desRoll).toFixed(1)}°)</small>` : ''}` : '—'}</b></div>
        ${ail ? `<ul>${ail.cmds.map(cmdTxt).join('')}</ul>` : ''}</div>
      <small class="muted">Toleransi: horizontal ${tolH()} m, vertikal ${tolV()} m · hijau ≤ tol, kuning ≤ 2×tol, merah &gt; 2×tol.</small></div>`;
    const at = n.posAssumed && L ? [L.lon, L.lat] : [n.lon, n.lat];
    S.popup?.remove();
    S.popup = new maplibregl.Popup({ maxWidth: '420px', className: 'cmp-popup', offset: 12, anchor: 'top-left' }).setLngLat(at).setHTML(html).addTo(map);
    const box = map.getContainer();
    map.easeTo({ center: at, offset: [-box.clientWidth * 0.22, -(box.clientHeight / 2 - 90)], duration: 600 }); // WP di kiri-atas, popup terbuka ke kanan-bawah
    if (L) setCursor(L.t);
  }

  // ---------- pencarian lokal (waypoint & event log) ----------
  app.localSources?.set('flightlog', (q) => {
    const s = q.trim().toLowerCase(), out = [];
    if (!s) return out;
    const wp = /^(?:wp|waypoint)\s*#?(\d+)$/.exec(s);
    S.nav.forEach((n, k) => {
      if (!k || n.lon == null) return;
      if ((wp && +wp[1] === n.seq) || n.item.name.toLowerCase().includes(s)) out.push({ name: `WP ${n.seq} · ${n.item.name}`, label: `${fA(n.item.alt)} m ${FRAME_LABEL[n.item.frame] ?? ''}`, lon: n.lon, lat: n.lat, source: 'Misi', local: true, action: () => openCompare(k) });
    });
    const log = S.log;
    if (log && s.length >= 2) {
      const g = log.streams.gps, pos = (t) => [interp(g.t, g.lon, t), interp(g.t, g.lat, t)];
      const ev = [...log.modes.map((m) => ({ t: m.t, text: `Mode ${m.name}` })), ...log.msgs.map((m) => ({ t: m.t, text: m.text }))];
      ev.filter((e) => e.text.toLowerCase().includes(s)).slice(0, 8).forEach((e) => {
        const [lon, lat] = pos(e.t);
        if (Number.isFinite(lon)) out.push({ name: e.text, label: fmtT(e.t), lon, lat, source: 'Log', local: true, action: () => setCursor(e.t) });
      });
    }
    return out;
  });
}

function paramText(it) {
  const p = [it.p1, it.p2, it.p3, it.p4];
  switch (it.command) {
    case 178: return `${p[0] === 1 ? 'groundspeed' : 'airspeed'} ${p[1]} m/s${p[2] >= 0 ? `, throttle ${p[2]}%` : ''}`;
    case 223: return `${p[0] ? 'START' : 'STOP'} mesin${p[1] ? ', cold start' : ''}${p[2] ? `, tunda tinggi ${p[2]} m` : ''}`;
    case 183: return `servo ${p[0]} → ${p[1]} µs`;
    case 184: return `servo ${p[0]} → ${p[1]} µs ×${p[2]} tiap ${p[3]} s`;
    case 16: return `hold ${p[0]} s, radius terima ${p[1]} m`;
    case 18: return `${p[0]} putaran, radius ${p[2]} m`;
    case 22: return `pitch ${p[0]}°`;
    default: return p.some((v) => v) ? `p1–p4: ${p.map((v) => v ?? '—').join(', ')}` : '';
  }
}
