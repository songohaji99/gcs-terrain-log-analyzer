import maplibregl from 'maplibre-gl';

const $ = (s) => document.querySelector(s);
const WX_LOCS = [
  ['31.71.01.1001', 'Gambir · Jakpus'],
  ['31.72.01.1001', 'Penjaringan · Jakut'],
  ['31.73.01.1001', 'Cengkareng Barat · Jakbar'],
  ['31.74.01.1001', 'Tebet Timur · Jaksel'],
  ['31.75.01.1001', 'Pisangan Baru · Jaktim'],
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const fmtTime = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function initLive(app) {
  const { map } = app;
  $('#wx-loc').innerHTML = WX_LOCS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('#wx-loc').onchange = () => weather();

  map.addSource('pb', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Laporan banjir © PetaBencana.id' });
  map.addLayer({ id: 'pb-halo', type: 'circle', source: 'pb', paint: { 'circle-radius': 14, 'circle-color': '#3b82f6', 'circle-opacity': 0.18, 'circle-blur': 0.6 } });
  map.addLayer({ id: 'pb', type: 'circle', source: 'pb', paint: {
    'circle-radius': 6, 'circle-stroke-width': 2, 'circle-stroke-color': '#e0f2fe',
    'circle-color': ['interpolate', ['linear'], ['coalesce', ['get', 'depth'], 0], 0, '#60a5fa', 50, '#2563eb', 150, '#7c3aed'] } });
  app.layerIds.pb = ['pb-halo', 'pb'];
  map.on('click', 'pb', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 10 }).setLngLat(e.lngLat).setHTML(
      `<b>Laporan ${esc(p.type)}</b><br><small>${esc(fmtTime(p.created_at))} · ${esc(p.source)}</small>` +
      (p.depth ? `<br>Kedalaman: <b>${esc(p.depth)} cm</b>` : '') +
      (p.text ? `<p style="margin:6px 0 0">${esc(p.text)}</p>` : '') +
      (p.image ? `<img src="${esc(p.image)}" style="width:100%;border-radius:6px;margin-top:6px">` : '')).addTo(map);
  });
  map.on('mouseenter', 'pb', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'pb', () => (map.getCanvas().style.cursor = ''));


  async function weather() {
    try {
      const j = await getJSON(`/api/bmkg/publik/prakiraan-cuaca?adm4=${$('#wx-loc').value}`);
      const all = j.data[0].cuaca.flat();
      const now = Date.now();
      let i = all.findIndex((c) => Date.parse(c.utc_datetime.replace(' ', 'T') + 'Z') > now) - 1;
      if (i < 0) i = 0;
      const c = all[i], img = (u) => encodeURI(decodeURI(u));
      $('#wx-body').classList.remove('muted');
      $('#wx-body').innerHTML = `
        <div class="wx-now"><img src="${img(c.image)}" alt=""><div><div class="t">${c.t}°C</div><div class="d">${esc(c.weather_desc)}</div></div></div>
        <div class="kv" style="margin-top:8px"><span>Kelembapan</span><b>${c.hu}%</b><span>Angin</span><b>${c.ws} km/j dari ${esc(c.wd)}</b><span>Tutupan awan</span><b>${c.tcc}%</b></div>
        <div class="wx-strip">${all.slice(i + 1, i + 7).map((n) => `<div>${n.local_datetime.slice(11, 16)}<img src="${img(n.image)}" alt=""><b>${n.t}°</b></div>`).join('')}</div>
        <small class="muted">Sumber: BMKG · analisis ${esc(c.analysis_date?.slice(0, 10))}</small>`;
      return true;
    } catch (e) {
      $('#wx-body').textContent = `Gagal memuat cuaca BMKG (${e.message}).`;
      return false;
    }
  }

  async function floods() {
    try {
      const j = await getJSON('/api/pb/reports?admin=ID-JK&timeperiod=604800&geoformat=geojson');
      const feats = j.result.features.map((f) => ({ ...f, properties: {
        type: f.properties.disaster_type, created_at: f.properties.created_at, source: f.properties.source,
        text: f.properties.text, image: f.properties.image_url, depth: f.properties.report_data?.flood_depth ?? null } }));
      map.getSource('pb').setData({ type: 'FeatureCollection', features: feats });
      app.bus.dispatchEvent(new CustomEvent('floods', { detail: feats }));
      const recent = [...feats].sort((a, b) => b.properties.created_at.localeCompare(a.properties.created_at));
      $('#pb-body').classList.remove('muted');
      $('#pb-body').innerHTML = `<div class="big">${feats.length}</div><small class="muted">laporan di DKI Jakarta, 7 hari terakhir</small>
        <div class="list">${recent.slice(0, 12).map((f, k) => `<div data-k="${k}">${esc(f.properties.type)}${f.properties.depth ? ` · ${f.properties.depth} cm` : ''}<small>${esc(fmtTime(f.properties.created_at))} — ${esc((f.properties.text || '').slice(0, 70))}</small></div>`).join('')}</div>`;
      $('#pb-body').querySelectorAll('.list div').forEach((d) => (d.onclick = () => map.flyTo({ center: recent[d.dataset.k].geometry.coordinates, zoom: 16 })));
      return true;
    } catch (e) {
      $('#pb-body').textContent = `Gagal memuat PetaBencana (${e.message}).`;
      return false;
    }
  }

  async function quake() {
    try {
      const g = (await getJSON('/api/gempa/DataMKG/TEWS/autogempa.json')).Infogempa.gempa;
      const [lat, lon] = g.Coordinates.split(',').map(Number);
      const el = Object.assign(document.createElement('div'), { className: 'eq-marker' });
      app.eqMarker?.remove();
      app.eqMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(`<b>M ${esc(g.Magnitude)}</b> · ${esc(g.Kedalaman)}<br>${esc(g.Wilayah)}<br><small>${esc(g.Tanggal)} ${esc(g.Jam)}</small>`)).addTo(map);
      $('#eq-body').classList.remove('muted');
      $('#eq-body').innerHTML = `<div style="display:flex;gap:12px;align-items:center"><div class="big" style="color:var(--bad)">M${esc(g.Magnitude)}</div>
        <div style="font-size:12.5px">${esc(g.Wilayah)}</div></div>
        <div class="kv" style="margin-top:8px"><span>Waktu</span><b>${esc(g.Tanggal)} ${esc(g.Jam)}</b><span>Kedalaman</span><b>${esc(g.Kedalaman)}</b><span>Lokasi</span><b>${esc(g.Lintang)} ${esc(g.Bujur)}</b><span>Potensi</span><b>${esc(g.Potensi)}</b></div>
        <div class="btns"><button class="btn" id="eq-fly">Lihat di peta</button></div>`;
      $('#eq-fly').onclick = () => map.flyTo({ center: [lon, lat], zoom: 7, pitch: 0 });
      return true;
    } catch (e) {
      $('#eq-body').textContent = `Gagal memuat gempa BMKG (${e.message}).`;
      return false;
    }
  }

  async function refreshAll() {
    const res = await Promise.all([weather(), floods(), quake()]);
    const ok = res.filter(Boolean).length;
    app.setChip('#chip-live', ok > 0 ? true : false, `Data live ${ok}/3`);
  }
  $('#live-refresh').onclick = (e) => { e.preventDefault(); refreshAll(); app.toast('Memperbarui data live…'); };
  refreshAll();
  setInterval(refreshAll, 5 * 60 * 1000);
}
