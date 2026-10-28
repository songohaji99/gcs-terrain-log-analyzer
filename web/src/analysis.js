// Analisis misi vs flight log (murni, tanpa DOM). Ketinggian dalam m AMSL; jarak dalam m.
import { haversine, distToPolyline, densify } from './geo.js';
import { resolveAmsl } from './mission.js';

const TAKEOFF_LAND = new Set([21, 22, 84, 85]);
const LOITER = new Set([17, 18, 19, 31]);
export const AILERON_FN = 4, ELEVON_FN = [77, 78];

// ---------- utilitas deret waktu ----------
export function nearestIndex(t, x) {
  let lo = 0, hi = t.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
  return lo > 0 && x - t[lo - 1] < t[lo] - x ? lo - 1 : lo;
}
// Interpolasi linear; NaN di luar rentang data (tidak mengekstrapolasi).
export function interp(t, v, x) {
  if (!t?.length || x < t[0] || x > t[t.length - 1]) return NaN;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
  const f = t[hi] === t[lo] ? 0 : (x - t[lo]) / (t[hi] - t[lo]);
  return v[lo] + (v[hi] - v[lo]) * f;
}
export const modeAt = (modes, t) => { let m = null; for (const x of modes) { if (x.t <= t) m = x; else break; } return m?.name ?? null; };
export const isAuto = (name) => name === 'AUTO';

// ---------- titik navigasi misi ----------
// terrainBySeq: { seq: elevasi DEM } untuk item TERRAIN (dan semua item, untuk AGL rencana).
export function buildNav(mission, homeAmsl, terrainBySeq = {}) {
  const home = mission.items.find((i) => i.seq === 0);
  const nav = [{ seq: 0, item: home, lon: home?.lon, lat: home?.lat, amsl: homeAmsl }];
  for (const it of mission.items) {
    if (!it.nav || it.seq === 0 || it.command === 20) continue;
    const prev = nav.at(-1);
    nav.push({ seq: it.seq, item: it, lon: it.lon ?? prev.lon, lat: it.lat ?? prev.lat, posAssumed: it.lon == null, amsl: resolveAmsl(it, homeAmsl, terrainBySeq[it.seq]) });
  }
  return nav;
}

// Indeks target (ke nav) pada waktu t dari event terakhir sebelum t:
//   'reached' seq r -> NAV berikutnya setelah r; 'start' seq s (awal perintah, CMD DataFlash) -> NAV pertama dengan seq >= s.
export function targetIndexAt(nav, events, t) {
  let last = null;
  for (const e of events) { if (e.t > t) break; last = e; }
  if (!last) return nav.length > 1 ? 1 : -1;
  return last.kind === 'start' ? nav.findIndex((n) => n.seq >= last.seq) : nav.findIndex((n) => n.seq > last.seq);
}

// Ketinggian rencana (AMSL) per sampel GPS, hanya saat mode AUTO (lainnya NaN).
export function plannedProfile(gps, nav, { reached = [], cmdStarts = [], modes = [] } = {}) {
  const n = gps.t.length, planned = new Float64Array(n).fill(NaN), target = new Int32Array(n).fill(-1);
  const events = [...reached.map((r) => ({ ...r, kind: 'reached' })), ...cmdStarts.map((r) => ({ ...r, kind: 'start' }))].sort((a, b) => a.t - b.t);
  for (let i = 0; i < n; i++) {
    if (!isAuto(modeAt(modes, gps.t[i])) && modes.length) continue;
    const p = [gps.lon[i], gps.lat[i]];
    const k = events.length ? targetIndexAt(nav, events, gps.t[i]) : nearestLeg(nav, p);
    if (k < 1) continue;
    target[i] = k;
    const A = nav[k - 1], B = nav[k];
    if (B.amsl == null || A.amsl == null) continue;
    const cmd = B.item.command;
    if (cmd === 22 || (LOITER.has(cmd) && haversine(p, [B.lon, B.lat]) < (B.item.p3 || 80) * 1.5)) { planned[i] = B.amsl; continue; }
    planned[i] = A.amsl + (B.amsl - A.amsl) * legFraction(p, A, B);
  }
  return { planned, target };
}

function legFraction(p, A, B) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (A.lon - p[0]) * k, ay = A.lat - p[1], bx = (B.lon - p[0]) * k, by = B.lat - p[1];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  return L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 1;
}
function nearestLeg(nav, p) {
  let best = -1, bd = Infinity;
  for (let k = 1; k < nav.length; k++) { const d = distToPolyline(p, [[nav[k - 1].lon, nav[k - 1].lat], [nav[k].lon, nav[k].lat]]); if (d < bd) { bd = d; best = k; } }
  return best;
}

// ---------- AGL, clearance, segmen berisiko ----------
// mask -> rentang indeks berurutan [{i0, i1}]
export function runs(mask) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && mask[i]) { if (s < 0) s = i; } else if (s >= 0) { out.push({ i0: s, i1: i - 1 }); s = -1; }
  }
  return out;
}

export function flightRisk(gps, terrain, target, nav, threshold) {
  const n = gps.t.length, agl = new Float64Array(n), risk = new Uint8Array(n);
  let minAgl = Infinity, minIdx = -1, riskSec = 0;
  for (let i = 0; i < n; i++) {
    agl[i] = terrain[i] == null || !Number.isFinite(terrain[i]) ? NaN : gps.alt[i] - terrain[i];
    const airborne = agl[i] > 3 && gps.spd[i] > 5;
    const tl = target[i] > 0 && TAKEOFF_LAND.has(nav[target[i]]?.item.command);
    if (airborne && !tl) {
      if (agl[i] < minAgl) { minAgl = agl[i]; minIdx = i; }
      if (agl[i] < threshold) { risk[i] = 1; if (i) riskSec += gps.t[i] - gps.t[i - 1]; }
    }
  }
  return { agl, risk, runs: runs(risk), minAgl: Number.isFinite(minAgl) ? minAgl : NaN, minIdx, riskSec };
}

// Profil rencana sepanjang jalur misi (sebelum terbang). Kembalikan sampel; terrain diisi pemanggil.
export function missionSamples(nav, step = 30) {
  const out = [];
  let d0 = 0;
  for (let k = 1; k < nav.length; k++) {
    const A = nav[k - 1], B = nav[k];
    if (A.amsl == null || B.amsl == null || TAKEOFF_LAND.has(B.item.command)) { d0 += haversine([A.lon, A.lat], [B.lon, B.lat]); continue; }
    const seg = densify([[A.lon, A.lat], [B.lon, B.lat]], step);
    const L = seg.at(-1).d || 1;
    for (const s of seg) out.push({ lngLat: s.lngLat, d: d0 + s.d, k, planned: A.amsl + ((B.amsl - A.amsl) * s.d) / L });
    d0 += L;
  }
  return out;
}

export function planRisk(samples, terrain, threshold) {
  const clr = samples.map((s, i) => (terrain[i] == null ? NaN : s.planned - terrain[i]));
  const mask = clr.map((c) => c < threshold);
  const perLeg = {};
  samples.forEach((s, i) => { if (Number.isFinite(clr[i])) perLeg[s.k] = Math.min(perLeg[s.k] ?? Infinity, clr[i]); });
  return { clearance: clr, runs: runs(mask), perLeg, min: Math.min(...clr.filter(Number.isFinite)) };
}

// ---------- komparasi waypoint ----------
export const status = (v, tol) => (!Number.isFinite(v) ? 'na' : Math.abs(v) <= tol ? 'ok' : Math.abs(v) <= 2 * tol ? 'warn' : 'bad');

// afterT: waktu event WP sebelumnya — event/titik terdekat untuk WP ini dicari sesudahnya (mis. LAND dekat home tidak cocok ke awal terbang).
export function compareWaypoint(k, nav, mission, log, { terrainBySeq = {}, tolH = 30, tolV = 10, afterT = -Infinity } = {}) {
  const N = nav[k], it = N.item, prev = nav[k - 1];
  const terrain = terrainBySeq[it.seq] ?? null;
  const mis = { seq: it.seq, name: it.name, lat: N.lat, lon: N.lon, posAssumed: !!N.posAssumed, alt: it.alt, frame: it.frame, amsl: N.amsl, terrain, aglPlan: N.amsl != null && terrain != null ? N.amsl - terrain : null };
  const out = { mission: mis, log: null, status: {}, engine: null, aileron: null };
  if (!log) return out;

  const g = log.streams.gps;
  let ev = log.reached.find((r) => r.seq === it.seq && r.t >= afterT), source = 'reached';
  if (!ev) {
    const nextStart = log.cmdStarts.find((c) => c.seq > it.seq && c.t > afterT);
    if (nextStart) { ev = { t: nextStart.t }; source = 'start'; }
  }
  if (!ev && N.lon != null && !N.posAssumed) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < g.t.length; i++) { if (g.t[i] < afterT) continue; const d = haversine([g.lon[i], g.lat[i]], [N.lon, N.lat]); if (d < bd) { bd = d; bi = i; } }
    if (bi >= 0) { ev = { t: g.t[bi] }; source = 'closest'; }
  }
  if (ev) {
    const t = ev.t, lat = interp(g.t, g.lat, t), lon = interp(g.t, g.lon, t), alt = interp(g.t, g.alt, t);
    const horiz = N.posAssumed ? NaN : haversine([lon, lat], [N.lon, N.lat]);
    const xtrack = prev && !N.posAssumed && prev.lon != null ? distToPolyline([lon, lat], [[prev.lon, prev.lat], [N.lon, N.lat]]) : NaN;
    const dAlt = N.amsl == null ? NaN : alt - N.amsl;
    out.log = { t, source, lat, lon, alt, gs: interp(g.t, g.spd, t), horiz, xtrack, d3: Math.hypot(horiz, Number.isFinite(dAlt) ? dAlt : 0), dAlt, mode: modeAt(log.modes, t) };
    out.status = { horiz: status(horiz, tolH), xtrack: status(xtrack, tolH), d3: status(Number.isFinite(dAlt) ? out.log.d3 : NaN, tolH), alt: status(dAlt, tolV) };
  }

  // perintah DO_* di antara NAV sebelumnya dan WP ini (berlaku untuk leg menuju WP ini)
  const between = mission ? mission.items.filter((x) => x.seq > (prev?.seq ?? 0) && x.seq < it.seq && !x.nav) : [];
  const at = (s, key) => (s && out.log ? interp(s.t, s[key], out.log.t) : NaN);
  const S = log.streams;
  out.engine = {
    thr: at(S.thr, 'v'), rpm: at(S.rpm, 'v'),
    has: { thr: !!S.thr, rpm: !!S.rpm },
    cmds: between.filter((x) => x.command === 178 || x.command === 223),
  };
  const fnParams = Object.entries(log.params).filter(([k]) => /^SERVO\d+_FUNCTION$/.test(k));
  const chans = (fns) => fnParams.filter(([, v]) => fns.includes(v)).map(([k, v]) => ({ ch: +k.match(/\d+/)[0], fn: v }));
  out.aileron = {
    paramsKnown: fnParams.length > 0,
    channels: [...chans([AILERON_FN]), ...chans(ELEVON_FN)].map((c) => ({ ...c, pwm: S.servo?.[`ch${c.ch}`] ? at(S.servo, `ch${c.ch}`) : NaN })),
    roll: at(S.att, 'roll'), desRoll: at(S.att, 'desRoll'),
    cmds: [...between.filter((x) => x.command === 183 || x.command === 184), it],
  };
  return out;
}
