// Geocoding multi-provider. Hanya TEKS QUERY dan VIEWPORT (pusat/bbox) yang dikirim ke provider —
// data misi/log dicari lewat sumber lokal (app.localSources) dan tidak pernah keluar dari browser.
//
// Interface GeocodingProvider:
//   { id, label, autocomplete: bool, cacheable: bool, local?: bool,
//     search(q, ctx) -> Promise<Result[]>, reverse?(lon, lat, ctx) -> Promise<Result|null> }
//   ctx = { signal, center: [lon, lat], bbox: [w, s, e, n], limit, lang }
//   Result = { name, label, lon, lat, type, source }
// Provider baru: registerProvider(id, factory(env, fetch)) lalu tambahkan id-nya ke VITE_GEOCODERS.
import { haversine } from './geo.js';

export class RateLimitError extends Error {}
export const DEFAULTS = { order: ['photon', 'overture', 'nominatim', 'mapbox', 'maptiler', 'here', 'geoapify', 'google'], timeoutMs: 4500, limit: 8, cacheTtlMs: 10 * 60e3 };

const FACTORIES = {};
export const registerProvider = (id, factory) => (FACTORIES[id] = factory);

const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
async function getJSON(fetchImpl, url, ctx, init = {}) {
  const r = await fetchImpl(url, { ...init, signal: ctx.signal });
  if (r.status === 429) throw new RateLimitError('HTTP 429');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const join = (...a) => a.filter(Boolean).join(', ');

// ---------- provider bawaan ----------
registerProvider('photon', (env, f) => {
  const base = env.VITE_PHOTON_URL || 'https://photon.komoot.io';
  const map = (j) => (j.features ?? []).map((x) => { const p = x.properties; return { name: p.name ?? join(p.street, p.housenumber), label: join(p.street && p.name ? join(p.street, p.housenumber) : null, p.district, p.city, p.state), lon: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], type: p.osm_value ?? p.type }; });
  return {
    id: 'photon', label: 'Photon (OSM)', autocomplete: true, cacheable: true,
    search: async (q, c) => map(await getJSON(f, `${base}/api/?${qs({ q, limit: c.limit, lang: 'default', lat: c.center?.[1], lon: c.center?.[0] })}`, c)),
    reverse: async (lon, lat, c) => map(await getJSON(f, `${base}/reverse?${qs({ lon, lat, lang: 'default' })}`, c))[0] ?? null,
  };
});

// Nominatim: kebijakan OSMF melarang autocomplete & > 1 request/detik -> hanya pencarian eksplisit/fallback, di-throttle.
registerProvider('nominatim', (env, f) => {
  const base = env.VITE_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const minGap = base.includes('openstreetmap.org') ? 1100 : 0;
  let last = 0;
  const gate = () => { const now = Date.now(); if (now - last < minGap) throw new RateLimitError('throttle 1 req/s'); last = now; };
  const map = (x) => ({ name: x.name || x.display_name?.split(',')[0], label: x.display_name, lon: +x.lon, lat: +x.lat, type: x.type });
  return {
    id: 'nominatim', label: 'Nominatim (OSM)', autocomplete: false, cacheable: true,
    search: async (q, c) => { gate(); const b = c.bbox; return (await getJSON(f, `${base}/search?${qs({ q, format: 'jsonv2', limit: c.limit, 'accept-language': c.lang, viewbox: b && `${b[0]},${b[3]},${b[2]},${b[1]}`, email: env.VITE_NOMINATIM_EMAIL })}`, c)).map(map); },
    reverse: async (lon, lat, c) => { gate(); const j = await getJSON(f, `${base}/reverse?${qs({ lon, lat, format: 'jsonv2', zoom: 18, 'accept-language': c.lang, email: env.VITE_NOMINATIM_EMAIL })}`, c); return j?.lat ? map(j) : null; },
  };
});

registerProvider('mapbox', (env, f) => env.VITE_MAPBOX_TOKEN && {
  id: 'mapbox', label: 'Mapbox', autocomplete: true, cacheable: false,
  search: async (q, c) => (await getJSON(f, `https://api.mapbox.com/search/geocode/v6/forward?${qs({ q, access_token: env.VITE_MAPBOX_TOKEN, limit: Math.min(c.limit, 10), language: c.lang, autocomplete: true, proximity: c.center?.join(',') })}`, c)).features
    .map((x) => ({ name: x.properties.name, label: x.properties.full_address ?? x.properties.place_formatted, lon: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], type: x.properties.feature_type })),
});

registerProvider('maptiler', (env, f) => env.VITE_MAPTILER_KEY && {
  id: 'maptiler', label: 'MapTiler', autocomplete: true, cacheable: false,
  search: async (q, c) => (await getJSON(f, `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?${qs({ key: env.VITE_MAPTILER_KEY, limit: Math.min(c.limit, 10), language: c.lang, autocomplete: true, proximity: c.center?.join(',') })}`, c)).features
    .map((x) => ({ name: x.text, label: x.place_name, lon: (x.center ?? x.geometry.coordinates)[0], lat: (x.center ?? x.geometry.coordinates)[1], type: x.place_type?.[0] })),
});

registerProvider('here', (env, f) => env.VITE_HERE_API_KEY && {
  id: 'here', label: 'HERE', autocomplete: true, cacheable: false,
  search: async (q, c) => (await getJSON(f, `https://autosuggest.search.hereapi.com/v1/autosuggest?${qs({ q, at: c.center && `${c.center[1]},${c.center[0]}`, limit: c.limit, lang: c.lang, apiKey: env.VITE_HERE_API_KEY })}`, c)).items
    .filter((x) => x.position).map((x) => ({ name: x.title, label: x.address?.label, lon: x.position.lng, lat: x.position.lat, type: x.resultType })),
});

registerProvider('geoapify', (env, f) => env.VITE_GEOAPIFY_KEY && {
  id: 'geoapify', label: 'Geoapify', autocomplete: true, cacheable: false,
  search: async (q, c) => (await getJSON(f, `https://api.geoapify.com/v1/geocode/autocomplete?${qs({ text: q, limit: c.limit, lang: c.lang, format: 'json', bias: c.center && `proximity:${c.center[0]},${c.center[1]}`, apiKey: env.VITE_GEOAPIFY_KEY })}`, c)).results
    .map((x) => ({ name: x.name ?? x.address_line1, label: x.formatted, lon: x.lon, lat: x.lat, type: x.result_type })),
});

// Google Places (New) Text Search: hanya pencarian eksplisit (autocomplete tidak memberi koordinat); hasil tidak boleh di-cache (ToS).
registerProvider('google', (env, f) => env.VITE_GOOGLE_PLACES_KEY && {
  id: 'google', label: 'Google Places', autocomplete: false, cacheable: false,
  search: async (q, c) => (await getJSON(f, 'https://places.googleapis.com/v1/places:searchText', c, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.VITE_GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.primaryType' },
    body: JSON.stringify({ textQuery: q, languageCode: c.lang, maxResultCount: Math.min(c.limit, 20), ...(c.center && { locationBias: { circle: { center: { latitude: c.center[1], longitude: c.center[0] }, radius: 50000 } } }) }),
  })).places?.map((x) => ({ name: x.displayName?.text, label: x.formattedAddress, lon: x.location.longitude, lat: x.location.latitude, type: x.primaryType })) ?? [],
});

// Overture Maps places: ekstrak lokal (tools/build_overture_poi.py) — offline, tanpa request keluar.
registerProvider('overture', (env, f) => {
  const url = env.VITE_OVERTURE_URL || '/data/overture_places.json';
  let data = null;
  const load = () => (data ??= f(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((j) => j.places.map(([name, cat, lon, lat]) => ({ name, cat, lon, lat, n: norm(name) }))).catch((e) => { data = null; throw e; }));
  return {
    id: 'overture', label: 'Overture POI (lokal)', autocomplete: true, cacheable: true, local: true,
    search: async (q, c) => {
      const toks = norm(q).split(' ').filter(Boolean);
      if (!toks.length) return [];
      const hits = (await load()).filter((p) => toks.every((t) => p.n.includes(t)));
      const d = (p) => (c.center ? haversine(c.center, [p.lon, p.lat]) : 0);
      return hits.sort((a, b) => (b.n.startsWith(toks[0]) - a.n.startsWith(toks[0])) || d(a) - d(b)).slice(0, c.limit)
        .map((p) => ({ name: p.name, label: p.cat?.replace(/_/g, ' '), lon: p.lon, lat: p.lat, type: p.cat }));
    },
  };
});

// ---------- konfigurasi ----------
// env.VITE_GEOCODERS = "photon,nominatim,..." (urutan = prioritas). Provider berkunci aktif hanya bila key-nya ada.
export function createProviders(env = {}, fetchImpl = (...a) => fetch(...a)) {
  const order = env.VITE_GEOCODERS ? env.VITE_GEOCODERS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULTS.order;
  return order.map((id) => FACTORIES[id]?.(env, fetchImpl)).filter(Boolean);
}

// ---------- gabung, dedupe, ranking ----------
export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\bjl\b\.?/g, 'jalan').replace(/\bgg\b\.?/g, 'gang').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Koefisien Dice bigram (0..1).
export function nameSimilarity(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (A.length - 1 + B.length - 1);
}

const AREA = /^(city|town|village|suburb|district|county|state|region|locality|place|neighbourhood|administrative|postcode|country)/i;
// Ruas jalan OSM bernama sama terpecah jadi banyak objek -> digabung dalam radius lebih besar.
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|road|street|pedestrian)/i;
// Objek berdekatan (≤ distM) cukup mirip namanya (minSim); penggabungan jarak jauh (area/ruas jalan) wajib nama hampir sama (farSim).
export function dedupe(results, { distM = 250, areaDistM = 2000, roadDistM = 5000, minSim = 0.6, farSim = 0.85 } = {}) {
  const lim = (x) => (AREA.test(x.type ?? '') ? areaDistM : ROAD.test(x.type ?? '') ? roadDistM : distM);
  const same = (o, r) => {
    const d = haversine([o.lon, o.lat], [r.lon, r.lat]), sim = nameSimilarity(o.name, r.name);
    return d <= distM ? sim >= minSim : d <= Math.min(lim(r), lim(o)) && sim >= farSim;
  };
  const out = [];
  for (const r of results) {
    const hit = out.find((o) => same(o, r));
    if (hit) {
      for (const s of r.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
      hit.provRank = Math.min(hit.provRank, r.provRank);
      if ((r.label?.length ?? 0) > (hit.label?.length ?? 0)) hit.label = r.label;
    } else out.push({ ...r, sources: [...r.sources] });
  }
  return out;
}

// Objek penting diberi bobot tambahan agar tidak kalah oleh POI kecil yang kebetulan lebih dekat.
const MAJOR = /^(aerodrome|airport|station|train_station|bus_station|city|town|administrative|hospital|university|stadium|monument|attraction|ferry_terminal)/i;
export function rank(results, q, center) {
  const nq = norm(q), toks = nq.split(' ').filter(Boolean);
  for (const r of results) {
    const n = norm(r.name);
    const text = n === nq ? 1 : n.startsWith(nq) ? 0.9 : toks.every((t) => n.includes(t)) ? 0.75 : nameSimilarity(n, nq) * 0.7;
    const dist = center ? 1 / (1 + haversine(center, [r.lon, r.lat]) / 10000) : 0.5;
    r.distM = center ? haversine(center, [r.lon, r.lat]) : null;
    const major = MAJOR.test(r.type ?? '') ? 0.12 : 0;
    r.score = 0.45 * text + 0.25 * (1 - Math.min(r.provRank, 9) / 10) + 0.2 * dist + 0.08 * (r.sources.length - 1) + major;
  }
  return results.sort((a, b) => b.score - a.score);
}

// ---------- pencarian gabungan ----------
const cache = new Map();
function cached(p, q, ctx, mode) {
  if (!p.cacheable) return p.search(q, ctx);
  const key = `${p.id}|${mode}|${norm(q)}|${ctx.center?.map((v) => v.toFixed(2)).join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < DEFAULTS.cacheTtlMs) return hit.v;
  const v = p.search(q, ctx);
  cache.set(key, { t: Date.now(), v });
  v.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return v;
}
export const clearGeocodeCache = () => cache.clear();

function withTimeout(promise, ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); });
    promise.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

// mode: 'autocomplete' (provider ber-autocomplete saja; Nominatim sebagai fallback bila semua gagal/kosong) | 'search' (semua).
// offline: hanya provider lokal. Provider gagal/rate-limit dilewati dan dicatat di `skipped`, tidak dilempar ke pemanggil.
export async function combinedSearch(providers, q, { mode = 'autocomplete', offline = false, signal, center, bbox, limit = DEFAULTS.limit, lang = 'id', timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const ctx = { signal, center, bbox, limit, lang };
  const pool = providers.filter((p) => (!offline || p.local));
  const run = async (list) => {
    const settled = await Promise.allSettled(list.map((p) => withTimeout(cached(p, q, ctx, mode), timeoutMs, signal)));
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const ok = [], skipped = [];
    settled.forEach((s, k) => (s.status === 'fulfilled' ? ok.push([list[k], s.value]) : skipped.push({ id: list[k].id, reason: s.reason instanceof RateLimitError ? 'rate-limit' : s.reason?.message ?? 'error' })));
    return { ok, skipped };
  };
  const first = await run(pool.filter((p) => mode === 'search' || p.autocomplete));
  let { ok } = first;
  const skipped = [...first.skipped];
  const onlineHits = ok.filter(([p, r]) => !p.local && r.length).length;
  if (mode === 'autocomplete' && !offline && onlineHits === 0) {
    const fb = await run(pool.filter((p) => !p.autocomplete && p.cacheable)); // fallback (mis. Nominatim)
    ok = [...ok, ...fb.ok]; skipped.push(...fb.skipped);
  }
  const flat = ok.flatMap(([p, rs]) => rs.filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat) && r.name).map((r, i) => ({ ...r, source: p.id, sources: [p.label], provRank: i, cacheable: p.cacheable })));
  const merged = rank(dedupe(flat), q, center).slice(0, limit);
  return { results: merged, used: ok.map(([p]) => p.id), skipped };
}

export async function reverseGeocode(providers, lon, lat, { signal, lang = 'id', timeoutMs = DEFAULTS.timeoutMs } = {}) {
  for (const p of providers.filter((x) => x.reverse && !x.local)) {
    try {
      const r = await withTimeout(p.reverse(lon, lat, { signal, lang }), timeoutMs, signal);
      if (r) return { ...r, source: p.label };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  return null;
}
