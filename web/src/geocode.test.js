import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, combinedSearch, dedupe, nameSimilarity, rank, clearGeocodeCache, reverseGeocode } from './geocode.js';
import { parseCoordinate, toMGRS, toUTM48S } from './geo.js';

const MONAS = [106.8272, -6.1754];
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const photonBody = { features: [
  { geometry: { coordinates: [106.82715, -6.17541] }, properties: { name: 'Monumen Nasional', city: 'Jakarta', osm_value: 'monument' } },
  { geometry: { coordinates: [110.4, -7.0] }, properties: { name: 'Monas Semarang', city: 'Semarang', osm_value: 'shop' } },
] };
const nominatimBody = [
  { lat: '-6.17535', lon: '106.82720', name: 'Monumen Nasional', display_name: 'Monumen Nasional, Gambir, Jakarta Pusat, DKI Jakarta, Indonesia', type: 'monument' },
  { lat: '-6.1702', lon: '106.8306', name: 'Stasiun Gambir', display_name: 'Stasiun Gambir, Jakarta', type: 'station' },
];
function mockFetch(overrides = {}) {
  const calls = [];
  const f = (url, init) => {
    calls.push(String(url));
    for (const [host, fn] of Object.entries(overrides)) if (String(url).includes(host)) return fn(url, init);
    if (url.includes('photon')) return json(url.includes('/reverse') ? { features: [photonBody.features[0]] } : photonBody);
    if (url.includes('nominatim')) return json(nominatimBody);
    if (url.includes('mapbox')) return json({ features: [{ geometry: { coordinates: [106.8273, -6.1753] }, properties: { name: 'Monas', full_address: 'Gambir, Jakarta', feature_type: 'poi' } }] });
    if (url.includes('overture')) return json({ places: [['Monumen Nasional', 'monument', 106.8271, -6.1755], ['Museum Nasional', 'museum', 106.8222, -6.1764]] });
    return json({}, 404);
  };
  f.calls = calls;
  return f;
}
const env = { VITE_GEOCODERS: 'photon,overture,nominatim,mapbox', VITE_MAPBOX_TOKEN: 'test-token', VITE_OVERTURE_URL: '/overture.json' };

test('createProviders: provider berkunci hanya aktif bila key ada', () => {
  assert.deepEqual(createProviders({ VITE_GEOCODERS: 'photon,nominatim,mapbox,google' }, mockFetch()).map((p) => p.id), ['photon', 'nominatim']);
  assert.deepEqual(createProviders(env, mockFetch()).map((p) => p.id), ['photon', 'overture', 'nominatim', 'mapbox']);
});

test('nameSimilarity & dedupe (jarak + kemiripan nama)', () => {
  assert.equal(nameSimilarity('Jl. Sudirman', 'Jalan Sudirman'), 1);
  assert.ok(nameSimilarity('Monumen Nasional', 'Monumen Nasional (Monas)') > 0.6);
  assert.ok(nameSimilarity('Stasiun Gambir', 'Monumen Nasional') < 0.3);
  const r = (name, lon, lat, src, type) => ({ name, lon, lat, sources: [src], provRank: 0, type });
  const d = dedupe([r('Monumen Nasional', 106.82715, -6.17541, 'A'), r('Monumen Nasional', 106.8272, -6.17535, 'B'), r('Monumen Nasional', 106.9, -6.17, 'C'), r('Jakarta', 106.84, -6.2, 'A', 'city'), r('Jakarta', 106.85, -6.21, 'B', 'city')]);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0].sources, ['A', 'B']);
  assert.deepEqual(d[2].sources, ['A', 'B']); // area: toleransi jarak lebih besar
  const roads = dedupe([r('Jalan Halim Perdanakusuma', 106.88, -6.25, 'A', 'residential'), r('Jalan Halim Perdanakusuma', 106.89, -6.26, 'A', 'secondary'), r('Jalan Halim Perdanakusuma', 107.2, -6.5, 'A', 'residential')]);
  assert.equal(roads.length, 2); // ruas jalan sama digabung, kota lain tidak
  const mixed = dedupe([r('Bandar Udara Halim Perdanakusuma', 106.89, -6.266, 'A', 'aerodrome'), r('Jalan Halim Perdanakusuma', 106.88, -6.25, 'A', 'residential')]);
  assert.equal(mixed.length, 2); // nama mirip sebagian + jarak jauh = objek berbeda
  const rk = rank([{ name: 'SMA Angkasa 1 Halim Perdanakusuma', lon: 106.88, lat: -6.25, sources: ['x'], provRank: 0, type: 'high_school' }, { name: 'Bandar Udara Halim Perdanakusuma', lon: 106.89, lat: -6.266, sources: ['x'], provRank: 0, type: 'aerodrome' }], 'halim perdanakusuma', MONAS);
  assert.equal(rk[0].type, 'aerodrome');
});

test('rank: relevansi nama + jarak ke viewport', () => {
  const rs = rank([{ name: 'Monas Semarang', lon: 110.4, lat: -7, sources: ['x'], provRank: 0 }, { name: 'Monas', lon: 106.8273, lat: -6.1753, sources: ['x'], provRank: 1 }], 'monas', MONAS);
  assert.equal(rs[0].name, 'Monas');
});

test('combinedSearch: paralel, gabung, sumber ditampilkan', async () => {
  clearGeocodeCache();
  const f = mockFetch();
  const { results, used, skipped } = await combinedSearch(createProviders(env, f), 'monumen nasional', { mode: 'search', center: MONAS });
  assert.deepEqual(used.sort(), ['mapbox', 'nominatim', 'overture', 'photon']);
  assert.equal(skipped.length, 0);
  const top = results[0];
  assert.equal(top.name, 'Monumen Nasional');
  assert.ok(top.sources.length >= 3, top.sources.join());
  assert.ok(results.every((r, i) => !i || results[i - 1].score >= r.score));
  // hanya teks query & viewport yang dikirim keluar
  assert.ok(f.calls.filter((u) => u.startsWith('http')).every((u) => /[?&](q|text)=/.test(u)));
});

test('autocomplete tidak memanggil Nominatim; Nominatim jadi fallback bila online lain gagal', async () => {
  clearGeocodeCache();
  const f = mockFetch();
  await combinedSearch(createProviders(env, f), 'gambir', { center: MONAS });
  assert.ok(!f.calls.some((u) => u.includes('nominatim')));
  clearGeocodeCache();
  const f2 = mockFetch({ photon: () => json({}, 503), mapbox: () => Promise.reject(new TypeError('network')) });
  const r = await combinedSearch(createProviders(env, f2), 'stasiun gambir', { center: MONAS });
  assert.ok(f2.calls.some((u) => u.includes('nominatim')));
  assert.equal(r.results[0].name, 'Stasiun Gambir');
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ['mapbox', 'photon']);
});

test('rate limit & timeout dilewati tanpa error ke pengguna', async () => {
  clearGeocodeCache();
  const f = mockFetch({ photon: () => json({}, 429), mapbox: () => new Promise(() => {}) });
  const r = await combinedSearch(createProviders(env, f), 'monumen', { mode: 'search', center: MONAS, timeoutMs: 50 });
  assert.equal(r.skipped.find((s) => s.id === 'photon').reason, 'rate-limit');
  assert.equal(r.skipped.find((s) => s.id === 'mapbox').reason, 'timeout');
  assert.ok(r.results.length > 0);
  // Nominatim publik di-throttle maksimal 1 request/detik
  const p = createProviders({ VITE_GEOCODERS: 'nominatim' }, mockFetch());
  await combinedSearch(p, 'a b', { mode: 'search' });
  const r3 = await combinedSearch(p, 'c d', { mode: 'search' });
  assert.equal(r3.skipped[0].reason, 'rate-limit');
  assert.equal(r3.results.length, 0);
});

test('mode offline hanya memakai sumber lokal', async () => {
  clearGeocodeCache();
  const f = mockFetch();
  const r = await combinedSearch(createProviders(env, f), 'museum', { offline: true, center: MONAS });
  assert.deepEqual(r.used, ['overture']);
  assert.equal(r.results[0].name, 'Museum Nasional');
  assert.ok(f.calls.every((u) => !u.startsWith('http')));
});

test('reverse geocode memakai provider pertama yang berhasil', async () => {
  const r = await reverseGeocode(createProviders({ VITE_GEOCODERS: 'photon,nominatim' }, mockFetch({ photon: () => json({}, 500), nominatim: () => json(nominatimBody[0]) })), ...MONAS);
  assert.equal(r.name, 'Monumen Nasional');
  assert.equal(r.source, 'Nominatim (OSM)');
});

test('parseCoordinate: DD, DMS (termasuk LS/BT), UTM, MGRS', () => {
  const near = (r, kind) => { assert.equal(r?.kind, kind); assert.ok(Math.abs(r.lon - 106.8272) < 1e-4 && Math.abs(r.lat + 6.1754) < 1e-4, JSON.stringify(r)); };
  near(parseCoordinate('-6.1754, 106.8272'), 'DD');
  near(parseCoordinate('106.8272 -6.1754'), 'DD');
  near(parseCoordinate('6°10\'31.4"LS 106°49\'37.9"BT'), 'DMS');
  near(parseCoordinate('6°10\'31.4"S, 106°49\'37.9"E'), 'DMS');
  near(parseCoordinate('S 6 10 31.4 E 106 49 37.9'), 'DMS');
  near(parseCoordinate(toUTM48S(106.8272, -6.1754)), 'UTM');
  near(parseCoordinate('48M 702183 9317059'), 'UTM');
  near(parseCoordinate(toMGRS(106.8272, -6.1754)), 'MGRS');
  near(parseCoordinate('48MYU0218317059'), 'MGRS');
  for (const bad of ['Jalan 17 Agustus', '12', '', '6 75 S 106 E', '95, 200', 'monas']) assert.equal(parseCoordinate(bad), null, bad);
});
