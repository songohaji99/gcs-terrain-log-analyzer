// Parser arsip drone: CSV telemetri (QGC CSV logging / CSV dari mav_bridge) dan rencana misi QGC (.plan).

const FRAMES = { 0: 'AMSL', 3: 'Relatif home', 10: 'Terrain' };
const NAV_WITH_POS = new Set([16, 17, 18, 19, 21, 22, 82]); // waypoint, loiter*, land, takeoff, spline

export function parseTelemetryCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  const find = (...res) => {
    for (const re of res) {
      const i = head.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iLat = find(/^(gps\.)?lat(itude)?$/i, /lat/i);
  const iLon = find(/^(gps\.)?(lon|lng)(gitude)?$/i, /lon|lng/i);
  const iAlt = find(/altitudeAMSL|alt_msl|amsl/i, /^alt(itude)?$/i);
  const iRel = find(/altitudeRelative|alt_rel|relative/i);
  const iT = find(/^(timestamp|time|t)$/i, /time/i);
  const iSpd = find(/groundSpeed|groundspeed/i);
  if (iLat < 0 || iLon < 0) throw new Error('Kolom lat/lon tidak ditemukan di CSV');

  const pts = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const lat = +c[iLat], lon = +c[iLon];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const tRaw = iT >= 0 ? c[iT] : null;
    const tNum = tRaw != null && tRaw !== '' && !isNaN(+tRaw) ? +tRaw : Date.parse(tRaw);
    pts.push({
      lon, lat,
      alt: iAlt >= 0 ? +c[iAlt] : NaN,
      rel: iRel >= 0 ? +c[iRel] : NaN,
      spd: iSpd >= 0 ? +c[iSpd] : NaN,
      t: Number.isFinite(tNum) ? (tNum > 1e11 ? tNum / 1000 : tNum) : k, // detik
    });
  }
  if (!pts.length) throw new Error('Tidak ada baris posisi valid di CSV');
  return pts;
}

export function parsePlan(json) {
  const plan = typeof json === 'string' ? JSON.parse(json) : json;
  const m = plan.mission;
  if (!m || !Array.isArray(m.items)) throw new Error('Bukan file .plan QGroundControl');
  const home = m.plannedHomePosition ? { lat: m.plannedHomePosition[0], lon: m.plannedHomePosition[1], alt: m.plannedHomePosition[2] } : null;
  const wps = [], surveys = [];
  const pushSimple = (it) => {
    if (it.type !== 'SimpleItem' || !NAV_WITH_POS.has(it.command)) return;
    const [, , , , lat, lon, alt] = it.params;
    if (lat == null || lon == null || (lat === 0 && lon === 0)) return;
    wps.push({ lon, lat, alt, frame: FRAMES[it.frame ?? it.AltitudeMode] ?? `frame ${it.frame}`, cmd: it.command });
  };
  for (const it of m.items) {
    if (it.type === 'ComplexItem') {
      if (Array.isArray(it.polygon)) surveys.push(it.polygon.map(([lat, lon]) => [lon, lat]));
      (it.TransectStyleComplexItem?.Items ?? []).forEach(pushSimple);
    } else pushSimple(it);
  }
  const fence = (plan.geoFence?.polygons ?? []).map((p) => p.polygon.map(([lat, lon]) => [lon, lat]));
  return { home, wps, surveys, fence };
}
