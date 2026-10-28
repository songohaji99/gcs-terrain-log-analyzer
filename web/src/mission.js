// Parser misi ternormalisasi: QGC .plan (JSON) dan QGC WPL 110 (.waypoints/.txt, Mission Planner).
// Model item: { seq, command, name, frame, frameRaw, lat, lon, alt, p1..p4, nav }
//   frame: 'GLOBAL' (AMSL) | 'RELATIVE' (di atas home) | 'TERRAIN' (di atas terrain) | 'MISSION' (perintah DO/tanpa posisi)
//   seq 0 = home (konvensi MAVLink/WPL; untuk .plan diambil dari plannedHomePosition).

export const FRAMES = { 0: 'GLOBAL', 5: 'GLOBAL', 3: 'RELATIVE', 6: 'RELATIVE', 10: 'TERRAIN', 11: 'TERRAIN', 2: 'MISSION' };
export const FRAME_LABEL = { GLOBAL: 'AMSL', RELATIVE: 'relatif home', TERRAIN: 'di atas terrain', MISSION: '—' };

export const CMD = {
  16: 'NAV_WAYPOINT', 17: 'NAV_LOITER_UNLIM', 18: 'NAV_LOITER_TURNS', 19: 'NAV_LOITER_TIME', 20: 'NAV_RETURN_TO_LAUNCH',
  21: 'NAV_LAND', 22: 'NAV_TAKEOFF', 30: 'NAV_CONTINUE_AND_CHANGE_ALT', 31: 'NAV_LOITER_TO_ALT', 82: 'NAV_SPLINE_WAYPOINT',
  84: 'NAV_VTOL_TAKEOFF', 85: 'NAV_VTOL_LAND', 93: 'NAV_DELAY', 112: 'CONDITION_DELAY', 114: 'CONDITION_DISTANCE',
  177: 'DO_JUMP', 178: 'DO_CHANGE_SPEED', 179: 'DO_SET_HOME', 181: 'DO_SET_RELAY', 183: 'DO_SET_SERVO', 189: 'DO_LAND_START',
  201: 'DO_SET_ROI', 203: 'DO_DIGICAM_CONTROL', 206: 'DO_SET_CAM_TRIGG_DIST', 223: 'DO_ENGINE_CONTROL', 3000: 'DO_VTOL_TRANSITION',
};
// Perintah NAV (16–95) membawa posisi; sisanya (DO_*, CONDITION_*) tidak.
const isNavCmd = (c) => c >= 16 && c < 100 && c !== 93;

export function normalizeItem(seq, command, frameRaw, params, lat, lon, alt) {
  const nav = isNavCmd(command);
  const hasPos = nav && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
  const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
  return {
    seq, command, name: CMD[command] ?? `CMD_${command}`,
    frame: nav ? (FRAMES[frameRaw] ?? `FRAME_${frameRaw}`) : 'MISSION', frameRaw,
    lat: hasPos ? lat : null, lon: hasPos ? lon : null, alt: nav ? num(alt) : null,
    p1: num(params[0]), p2: num(params[1]), p3: num(params[2]), p4: num(params[3]), nav,
  };
}

export class MissionError extends Error {}

export function parseMission(text, filename = '') {
  const t = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart(); // buang BOM
  if (/^QGC WPL/i.test(t)) return parseWPL(t, filename);
  if (t.startsWith('{')) return parseQgcPlan(t, filename);
  throw new MissionError(`${filename || 'File'}: format misi tidak dikenali (harus QGC .plan JSON atau QGC WPL 110).`);
}

export function parseQgcPlan(text, filename = '.plan') {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    throw new MissionError(`${filename}: JSON rusak — ${e.message}`);
  }
  const m = plan?.mission;
  if (!m || !Array.isArray(m.items)) throw new MissionError(`${filename}: bukan file .plan QGroundControl (tidak ada mission.items).`);
  const hp = m.plannedHomePosition;
  const items = [];
  if (Array.isArray(hp) && hp.length >= 3) items.push(normalizeItem(0, 16, 0, [0, 0, 0, 0], hp[0], hp[1], hp[2]));
  const warnings = [];
  const pushSimple = (it, where) => {
    if (it.type !== 'SimpleItem') return;
    if (!Array.isArray(it.params) || it.params.length < 7 || typeof it.command !== 'number') {
      warnings.push(`${where}: item tidak lengkap dilewati`);
      return;
    }
    const [p1, p2, p3, p4, lat, lon, alt] = it.params;
    items.push(normalizeItem(items.length || 1, it.command, it.frame ?? 3, [p1, p2, p3, p4], lat, lon, alt));
  };
  const surveys = [];
  m.items.forEach((it, i) => {
    if (it?.type === 'ComplexItem') {
      if (Array.isArray(it.polygon)) surveys.push(it.polygon.map(([lat, lon]) => [lon, lat]));
      (it.TransectStyleComplexItem?.Items ?? []).forEach((s, k) => pushSimple(s, `item ${i + 1}.${k + 1}`));
    } else if (it?.type === 'SimpleItem') pushSimple(it, `item ${i + 1}`);
    else warnings.push(`item ${i + 1}: tipe "${it?.type}" tidak dikenali, dilewati`);
  });
  items.forEach((it, i) => (it.seq = hp ? i : i + 1));
  const fence = (plan.geoFence?.polygons ?? []).map((p) => p.polygon.map(([lat, lon]) => [lon, lat]));
  return finish(items, { format: 'QGC .plan', surveys, fence, warnings });
}

export function parseWPL(text, filename = '.waypoints') {
  const lines = text.split(/\r?\n/);
  const ver = lines[0].trim().split(/\s+/)[2];
  const warnings = ver === '110' ? [] : [`versi WPL "${ver ?? '?'}" (diharapkan 110)`];
  const items = [];
  for (let n = 1; n < lines.length; n++) {
    const raw = lines[n].trim();
    if (!raw) continue;
    const f = raw.split(/\t|\s+/);
    if (f.length < 12) throw new MissionError(`${filename} baris ${n + 1}: harus 12 kolom (seq, current, frame, command, p1–p4, lat, lon, alt, autocontinue), ditemukan ${f.length}.`);
    const v = f.map(Number);
    const bad = v.findIndex((x) => Number.isNaN(x));
    if (bad >= 0) throw new MissionError(`${filename} baris ${n + 1}: kolom ${bad + 1} bukan angka ("${f[bad]}").`);
    const [seq, , frame, command, p1, p2, p3, p4, lat, lon, alt] = v;
    items.push(normalizeItem(seq, command, frame, [p1, p2, p3, p4], lat, lon, alt));
  }
  if (!items.length) throw new MissionError(`${filename}: tidak ada item misi.`);
  items.forEach((it, i) => it.seq !== i && warnings.push(`seq ${it.seq} di posisi ${i} (urutan tidak berurutan)`));
  return finish(items, { format: 'QGC WPL 110', surveys: [], fence: [], warnings });
}

function finish(items, extra) {
  const home = items[0]?.seq === 0 && items[0].lat != null ? { lat: items[0].lat, lon: items[0].lon, alt: items[0].alt } : null;
  return { items, home, ...extra };
}

// Ketinggian AMSL sebuah item NAV. terrain = elevasi DEM di posisi item (m) bila frame TERRAIN.
export function resolveAmsl(item, homeAmsl, terrain) {
  if (!item.nav || item.alt == null) return null;
  if (item.frame === 'GLOBAL') return item.alt;
  if (item.frame === 'RELATIVE') return homeAmsl == null ? null : homeAmsl + item.alt;
  if (item.frame === 'TERRAIN') return terrain == null ? null : terrain + item.alt;
  return null;
}
