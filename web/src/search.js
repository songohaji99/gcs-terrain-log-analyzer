// Kotak pencarian di top bar: koordinat (lokal) + misi/log (lokal) + geocoding multi-provider.
import maplibregl from 'maplibre-gl';
import { createProviders, combinedSearch, reverseGeocode } from './geocode.js';
import { parseCoordinate, toDMS, toUTM48S, toMGRS, haversine } from './geo.js';
import { elevationAt } from './elevation.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HIST_KEY = 'chakrawala.searchHistory', OFF_KEY = 'chakrawala.offline';
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage diblokir */ } } };
const fmtD = (m) => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

export function initSearch(app) {
  const { map } = app;
  const providers = createProviders(import.meta.env);
  const input = $('#q'), list = $('#q-list');
  let items = [], active = -1, ctrl = null, timer = 0, popup = null;
  let offline = store.get(OFF_KEY, false) || !navigator.onLine;

  const offBtn = $('#q-offline');
  const paintOffline = () => { offBtn.classList.toggle('on', offline); offBtn.title = offline ? 'Mode offline: hanya koordinat, misi/log, POI Overture lokal' : 'Online: Photon/Nominatim + provider berkunci'; };
  offBtn.onclick = () => { offline = !offline; store.set(OFF_KEY, offline); paintOffline(); app.toast(offline ? 'Pencarian offline — tidak ada request ke provider online' : 'Pencarian online aktif'); input.focus(); run('autocomplete'); };
  addEventListener('offline', () => { offline = true; paintOffline(); });
  paintOffline();

  const viewport = () => { const b = map.getBounds(); return { center: map.getCenter().toArray(), bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] }; };

  function localResults(q) {
    const out = [];
    const c = parseCoordinate(q);
    if (c) out.push({ name: `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`, label: `Koordinat ${c.kind}`, lon: c.lon, lat: c.lat, sources: ['Koordinat (lokal)'], kind: 'coord', local: true, cacheable: true });
    for (const fn of app.localSources.values()) for (const r of fn(q)) out.push({ ...r, sources: [r.source], kind: 'local', cacheable: true });
    const nq = q.trim().toLowerCase();
    if (nq) store.get(HIST_KEY, []).filter((h) => h.lon != null && h.name.toLowerCase().includes(nq)).slice(0, 3).forEach((h) => out.push({ ...h, sources: [...h.sources, 'riwayat'], kind: 'history' }));
    return out;
  }

  async function run(mode) {
    const q = input.value.trim();
    ctrl?.abort();
    if (!q) return showHistory();
    const local = localResults(q);
    render(local, true);
    if (local[0]?.kind === 'coord') return render(local, false); // koordinat: tidak perlu provider
    ctrl = new AbortController();
    try {
      const { results, skipped } = await combinedSearch(providers, q, { mode, offline, signal: ctrl.signal, ...viewport() });
      const center = map.getCenter().toArray();
      results.forEach((r) => (r.distM = haversine(center, [r.lon, r.lat])));
      const dupOfLocal = (r) => local.some((l) => l.name === r.name && haversine([l.lon, l.lat], [r.lon, r.lat]) < 250); // mis. entri riwayat
      render([...local, ...results.filter((r) => !dupOfLocal(r))], false, skipped);
    } catch (e) {
      if (e.name !== 'AbortError') render(local, false);
    }
  }

  function showHistory() {
    const h = store.get(HIST_KEY, []);
    items = h.map((x) => ({ ...x, kind: x.lon == null ? 'query' : 'history' }));
    list.innerHTML = items.length ? `<div class="q-head">Riwayat</div>` + items.map(row).join('') : '';
    list.hidden = !items.length;
    active = -1;
  }

  function render(rs, loading, skipped = []) {
    items = rs;
    active = rs.length ? 0 : -1;
    const foot = `<div class="q-foot">${loading ? 'Mencari…' : rs.length ? '' : 'Tidak ada hasil.'}${skipped.length ? ` <span title="${esc(skipped.map((s) => `${s.id}: ${s.reason}`).join('\n'))}">${skipped.length} provider dilewati</span>` : ''}
      <span>${offline ? 'offline' : '© OpenStreetMap · Overture'}${rs.some((r) => r.sources?.includes('Google Places')) ? ' · Powered by Google' : ''}</span></div>`;
    list.innerHTML = rs.map(row).join('') + foot;
    list.hidden = document.activeElement !== input; // hasil async jangan membuka lagi dropdown yang sudah ditutup
    highlight();
  }

  function row(r, i) {
    const icon = { coord: '⌖', local: '✈', history: '↺', query: '↺' }[r.kind] ?? '●';
    return `<div class="q-item" role="option" data-i="${i}"><span class="q-ic">${icon}</span><div class="q-txt"><b>${esc(r.name ?? r.q)}</b><small>${esc(r.label ?? '')}</small>
      <span class="q-src">${(r.sources ?? []).map((s) => `<i>${esc(s)}</i>`).join('')}${r.distM != null ? `<em>${fmtD(r.distM)}</em>` : ''}</span></div></div>`;
  }
  const highlight = () => list.querySelectorAll('.q-item').forEach((el) => el.classList.toggle('on', +el.dataset.i === active));

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run('autocomplete'), 300); });
  input.addEventListener('focus', () => (input.value ? run('autocomplete') : showHistory()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      highlight();
      list.querySelector('.q-item.on')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      const it = items[active];
      if (it?.kind === 'query') { input.value = it.q; run('search'); } else if (it && !e.shiftKey) select(it); else run('search'); // Shift+Enter: pencarian penuh (semua provider)
    } else if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  list.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.q-item'); if (!el) return;
    e.preventDefault();
    const it = items[+el.dataset.i];
    if (it.kind === 'query') { input.value = it.q; run('search'); } else select(it);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) list.hidden = true; });
  addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); input.focus(); } });

  function remember(it) {
    // ToS: hasil provider non-cacheable (Mapbox/MapTiler/HERE/Geoapify/Google) tidak disimpan — hanya teks query-nya.
    const h = store.get(HIST_KEY, []).filter((x) => (x.name ?? x.q) !== (it.name ?? input.value));
    const entry = it.cacheable && it.kind !== 'local' ? { name: it.name, label: it.label, lon: it.lon, lat: it.lat, sources: it.sources.filter((s) => s !== 'riwayat') } : { q: input.value.trim() };
    store.set(HIST_KEY, [entry, ...h].slice(0, 15));
  }

  async function select(it) {
    list.hidden = true;
    input.blur();
    remember(it);
    if (it.action) { it.action(); return; } // waypoint/event log: buka popup komparasi/cursor waktu
    if (app.is3d?.()) { app.globeFlyTo?.(it.lon, it.lat); app.toast(`${it.name} — ${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}`); return; }
    map.flyTo({ center: [it.lon, it.lat], zoom: Math.max(map.getZoom(), it.kind === 'coord' ? 16 : 15.5), duration: 1200 });
    const elev = await elevationAt(it.lon, it.lat);
    const dd = `${it.lat.toFixed(6)}, ${it.lon.toFixed(6)}`;
    popup?.remove();
    popup = new maplibregl.Popup({ offset: 14, maxWidth: '320px', className: 'q-popup' }).setLngLat([it.lon, it.lat]).setHTML(`
      <div class="q-pop"><b>${esc(it.name)}</b>${it.label ? `<small>${esc(it.label)}</small>` : ''}
      <div class="kv"><span>DD</span><b>${dd}</b><span>DMS</span><b>${toDMS(it.lat, 'LU', 'LS')} ${toDMS(it.lon, 'BT', 'BB')}</b><span>UTM</span><b>${toUTM48S(it.lon, it.lat)}</b><span>MGRS</span><b>${toMGRS(it.lon, it.lat)}</b>
      <span>Elevasi</span><b>${elev == null ? 'tidak tersedia' : `${elev.toFixed(1)} m (DEM ±30 m)`}</b><span>Sumber</span><b>${esc(it.sources.join(' · '))}</b></div>
      <div class="q-rev"></div>
      <div class="btns"><button class="btn" data-copy="${dd}">Salin koordinat</button><button class="btn" data-copy="${toMGRS(it.lon, it.lat)}">Salin MGRS</button></div></div>`).addTo(map);
    popup.getElement().addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]'); if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); app.toast(`Disalin: ${b.dataset.copy}`); } catch { app.toast('Clipboard tidak diizinkan browser'); }
    });
    if (it.kind === 'coord' && !offline) { // alamat terdekat hanya untuk input koordinat (reverse), koordinatnya saja yang dikirim
      const r = await reverseGeocode(providers, it.lon, it.lat).catch(() => null);
      const el = popup.getElement()?.querySelector('.q-rev');
      if (el && r) el.innerHTML = `<small>Terdekat: ${esc(r.label ?? r.name)} <i>(${esc(r.source)})</i></small>`;
    }
  }
}
