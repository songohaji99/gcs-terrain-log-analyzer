// Parser flight log ArduPilot: DataFlash biner (.bin), DataFlash teks (.log), MAVLink telemetry (.tlog).
// Semua fungsi murni (tanpa DOM) agar bisa jalan di Web Worker dan di node --test.
// Keluaran normalizeLog(): model kolom { meta, streams:{gps,att,thr,aspd,rpm,bat,servo}, modes, msgs, reached, cmdStarts, params, cmds }.
import { MAVLINK_DEFS } from './mavlink-defs.js';

// Pesan DataFlash yang dipakai (lainnya dilewati tanpa di-decode).
const DF_WANT = new Set(['GPS', 'ATT', 'CTUN', 'ARSP', 'RPM', 'BAT', 'RCOU', 'MODE', 'MSG', 'PARM', 'CMD']);

// ---------------------------------------------------------------- DataFlash biner
const DF_SIZE = { b: 1, B: 1, M: 1, h: 2, H: 2, c: 2, C: 2, i: 4, I: 4, e: 4, E: 4, L: 4, f: 4, n: 4, d: 8, q: 8, Q: 8, N: 16, Z: 64, a: 64 };
const dec = new TextDecoder('latin1');
const str = (u8, o, n) => { let e = o; while (e < o + n && u8[e]) e++; return dec.decode(u8.subarray(o, e)); };

function dfRead(dv, u8, o, ch) {
  switch (ch) {
    case 'b': return dv.getInt8(o);
    case 'B': case 'M': return dv.getUint8(o);
    case 'h': return dv.getInt16(o, true);
    case 'H': return dv.getUint16(o, true);
    case 'c': return dv.getInt16(o, true) / 100;
    case 'C': return dv.getUint16(o, true) / 100;
    case 'i': return dv.getInt32(o, true);
    case 'I': return dv.getUint32(o, true);
    case 'e': return dv.getInt32(o, true) / 100;
    case 'E': return dv.getUint32(o, true) / 100;
    case 'L': return dv.getInt32(o, true) / 1e7;
    case 'f': return dv.getFloat32(o, true);
    case 'd': return dv.getFloat64(o, true);
    case 'q': return Number(dv.getBigInt64(o, true));
    case 'Q': return Number(dv.getBigUint64(o, true));
    case 'n': return str(u8, o, 4);
    case 'N': return str(u8, o, 16);
    case 'Z': return str(u8, o, 64);
    default: return null; // 'a' (array int16[32]) tidak dipakai
  }
}

const push = (out, name, cols, vals) => {
  const m = (out[name] ??= Object.fromEntries(cols.map((c) => [c, []])));
  cols.forEach((c, k) => m[c]?.push(vals[k]));
};

export function parseDataflashBin(buf, onProgress) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), N = u8.length;
  const fmts = { 128: { name: 'FMT', len: 89, format: 'BBnNZ', cols: ['Type', 'Length', 'Name', 'Format', 'Columns'] } };
  const out = {};
  let p = 0, bad = 0, nextTick = 0;
  while (p + 3 <= N) {
    if (u8[p] !== 0xa3 || u8[p + 1] !== 0x95) { p++; bad++; continue; }
    const f = fmts[u8[p + 2]];
    if (!f || p + f.len > N) { p++; bad++; continue; }
    if (f.name === 'FMT' || DF_WANT.has(f.name)) {
      let o = p + 3;
      const vals = [];
      for (const ch of f.format) { vals.push(dfRead(dv, u8, o, ch)); o += DF_SIZE[ch] ?? 0; }
      if (f.name === 'FMT') {
        const [type, len, name, format, cols] = vals;
        const size = 3 + [...format].reduce((a, ch) => a + (DF_SIZE[ch] ?? NaN), 0);
        if (size === len) fmts[type] = { name, len, format, cols: cols.split(',') };
      } else push(out, f.name, f.cols, vals);
    }
    p += f.len;
    if (onProgress && p > nextTick) { nextTick = p + N / 20; onProgress(p / N); }
  }
  return { msgs: out, skippedBytes: bad };
}

// ---------------------------------------------------------------- DataFlash teks
export function parseDataflashText(text) {
  const fmts = {}, out = {};
  for (const line of text.split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const name = line.slice(0, comma).trim();
    if (name === 'FMT') {
      const p = line.split(',').map((s) => s.trim());
      if (p.length >= 6) fmts[p[3]] = { format: p[4], cols: p.slice(5) };
      continue;
    }
    if (!DF_WANT.has(name) || !fmts[name]) continue;
    const { format, cols } = fmts[name];
    let parts = line.slice(comma + 1).split(',').map((s) => s.trim());
    if (parts.length > cols.length) parts = [...parts.slice(0, cols.length - 1), parts.slice(cols.length - 1).join(',')]; // teks MSG berisi koma
    push(out, name, cols, parts.map((v, k) => (/[nNZ]/.test(format[k]) ? v : +v)));
  }
  return { msgs: out, skippedBytes: 0 };
}

// ---------------------------------------------------------------- MAVLink .tlog
const STRUCT = { b: [1, 'getInt8'], B: [1, 'getUint8'], h: [2, 'getInt16'], H: [2, 'getUint16'], i: [4, 'getInt32'], I: [4, 'getUint32'], f: [4, 'getFloat32'], d: [8, 'getFloat64'], q: [8, 'getBigInt64'], Q: [8, 'getBigUint64'] };

function crcX25(u8, from, to, extra) {
  let crc = 0xffff;
  const acc = (b) => { let t = b ^ (crc & 0xff); t = (t ^ (t << 4)) & 0xff; crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff; };
  for (let i = from; i < to; i++) acc(u8[i]);
  acc(extra);
  return crc;
}

function decodePayload(def, u8, o, plen) {
  const buf = new Uint8Array(def.len); // MAVLink2 memangkas nol di akhir payload -> pad kembali
  buf.set(u8.subarray(o, o + Math.min(plen, def.len)));
  const dv = new DataView(buf.buffer), msg = {};
  let k = 0;
  for (const [name, t, n] of def.fields) {
    if (t === 's' || t === 'c') { msg[name] = str(buf, k, n); k += n; continue; }
    const [sz, fn] = STRUCT[t];
    const read = () => { const v = dv[fn](k, true); k += sz; return typeof v === 'bigint' ? Number(v) : v; };
    msg[name] = n === 1 ? read() : Array.from({ length: n }, read);
  }
  return msg;
}

// Mengembalikan daftar pesan terdekode { ts (µs unix), sys, comp, name, m }.
export function parseTlog(buf, onProgress) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), N = u8.length;
  const out = [];
  let p = 0, bad = 0, nextTick = 0;
  while (p + 8 + 8 <= N) {
    const magic = u8[p + 8];
    let ok = false;
    if (magic === 0xfe || magic === 0xfd) {
      const v2 = magic === 0xfd, plen = u8[p + 9], hdr = v2 ? 10 : 6;
      const sig = v2 && u8[p + 10] & 1 ? 13 : 0, size = hdr + plen + 2 + sig;
      if (p + 8 + size <= N) {
        const s = p + 8;
        const id = v2 ? u8[s + 7] | (u8[s + 8] << 8) | (u8[s + 9] << 16) : u8[s + 5];
        const def = MAVLINK_DEFS[id];
        if (def) {
          const crc = u8[s + hdr + plen] | (u8[s + hdr + plen + 1] << 8);
          if (crcX25(u8, s + 1, s + hdr + plen, def.crc) === crc) {
            out.push({ ts: Number(dv.getBigUint64(p, false)), sys: u8[s + (v2 ? 5 : 3)], comp: u8[s + (v2 ? 6 : 4)], name: def.name, m: decodePayload(def, u8, s + hdr, plen) });
            ok = true;
          }
        } else {
          // pesan tanpa definisi: CRC tak bisa dicek, terima hanya bila paket berikutnya juga sinkron
          const nx = p + 8 + size;
          ok = nx === N || (nx + 8 < N && (u8[nx + 8] === 0xfe || u8[nx + 8] === 0xfd));
        }
        if (ok) { p += 8 + size; if (onProgress && p > nextTick) { nextTick = p + N / 20; onProgress(p / N); } continue; }
      }
    }
    p++; bad++;
  }
  return { packets: out, skippedBytes: bad };
}

// ---------------------------------------------------------------- normalisasi
export const MODES = {
  plane: { 0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL', 25: 'LOITER_ALT_QLAND' },
  copter: { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 27: 'AUTO_RTL' },
};
const vehicleFromText = (s) => (/ArduPlane/i.test(s) ? 'plane' : /ArduCopter/i.test(s) ? 'copter' : /ArduRover/i.test(s) ? 'rover' : /ArduSub/i.test(s) ? 'sub' : null);
const REACHED_RE = /Reached (?:waypoint|command) #(\d+)/i;
const MISSION_START_RE = /^Mission: (\d+) /; // ArduPilot 4.x: "Mission: 3 WP" saat perintah #3 mulai dieksekusi
const cols = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Float64Array.from(v)]));

export function normalizeDataflash({ msgs }, format) {
  const g = msgs.GPS, t0us = Math.min(...['GPS', 'ATT', 'MODE', 'MSG'].map((n) => msgs[n]?.TimeUS?.[0] ?? Infinity));
  const T = (us) => (us - t0us) / 1e6;
  const texts = (msgs.MSG?.Message ?? []).map((m, i) => ({ t: T(msgs.MSG.TimeUS[i]), text: m }));
  const vehicleText = texts.find((m) => vehicleFromText(m.text));
  const vehicle = vehicleText ? vehicleFromText(vehicleText.text) : null;

  const streams = {};
  if (g) {
    const idx = g.TimeUS.map((_, i) => i).filter((i) => (g.Status?.[i] ?? 3) >= 3 && (g.I?.[i] ?? 0) === 0);
    streams.gps = cols({ t: idx.map((i) => T(g.TimeUS[i])), lat: idx.map((i) => g.Lat[i]), lon: idx.map((i) => g.Lng[i]), alt: idx.map((i) => g.Alt[i]), spd: idx.map((i) => g.Spd[i]), sats: idx.map((i) => g.NSats?.[i] ?? NaN) });
  }
  const a = msgs.ATT;
  if (a) streams.att = cols({ t: a.TimeUS.map(T), roll: a.Roll, desRoll: a.DesRoll ?? a.Roll.map(() => NaN), pitch: a.Pitch, desPitch: a.DesPitch ?? a.Pitch.map(() => NaN), yaw: a.Yaw });
  const c = msgs.CTUN;
  if (c?.ThO) {
    const scale = Math.max(...c.ThO.map(Math.abs)) <= 1.01 ? 100 : 1; // Copter: 0..1, Plane: persen
    streams.thr = cols({ t: c.TimeUS.map(T), v: c.ThO.map((v) => v * scale) });
  }
  if (msgs.ARSP?.Airspeed) streams.aspd = cols({ t: msgs.ARSP.TimeUS.map(T), v: msgs.ARSP.Airspeed });
  else if (c?.As) streams.aspd = cols({ t: c.TimeUS.map(T), v: c.As });
  const r = msgs.RPM, rv = r?.rpm1 ?? r?.RPM;
  if (rv) streams.rpm = cols({ t: r.TimeUS.map(T), v: rv });
  const b = msgs.BAT;
  if (b) {
    const idx = b.TimeUS.map((_, i) => i).filter((i) => (b.Inst?.[i] ?? 0) === 0);
    streams.bat = cols({ t: idx.map((i) => T(b.TimeUS[i])), volt: idx.map((i) => b.Volt[i]), curr: idx.map((i) => b.Curr?.[i] ?? NaN) });
  }
  const rc = msgs.RCOU;
  if (rc) streams.servo = cols({ t: rc.TimeUS.map(T), ...Object.fromEntries(Object.keys(rc).filter((k) => /^C\d+$/.test(k)).map((k) => [`ch${k.slice(1)}`, rc[k]])) });

  const md = msgs.MODE;
  const modes = md ? md.TimeUS.map((us, i) => ({ t: T(us), num: md.ModeNum?.[i] ?? md.Mode[i], name: modeName(vehicle, md.ModeNum?.[i] ?? md.Mode[i]) })) : [];
  const params = {};
  (msgs.PARM?.Name ?? []).forEach((n, i) => (params[n] = msgs.PARM.Value[i]));

  // CMD: blok pertama (unggahan misi, CNum 0..CTot-1) = misi; CMD sesudahnya = awal eksekusi perintah.
  const cm = msgs.CMD, cmds = [], cmdStarts = [];
  if (cm) {
    let uploading = true;
    cm.TimeUS.forEach((us, i) => {
      const rec = { seq: cm.CNum[i], command: cm.CId[i], frame: cm.Frame?.[i] ?? 3, params: [cm.Prm1[i], cm.Prm2[i], cm.Prm3[i], cm.Prm4[i]], lat: cm.Lat[i], lon: cm.Lng[i], alt: cm.Alt[i] };
      if (uploading && rec.seq === cmds.length) { cmds.push(rec); if (cmds.length >= cm.CTot[i]) uploading = false; }
      else { uploading = false; cmdStarts.push({ t: T(us), seq: rec.seq }); }
    });
  }
  let t0Unix = null;
  if (g?.GWk) {
    const i = g.TimeUS.findIndex((_, k) => g.GWk[k] > 0 && (g.Status?.[k] ?? 3) >= 3);
    if (i >= 0) t0Unix = 315964800 + g.GWk[i] * 604800 + g.GMS[i] / 1000 - 18 - T(g.TimeUS[i]); // GPS->UTC, 18 detik kabisat
  }
  return finish({ format, vehicle, firmware: vehicleText?.text ?? null, t0Unix, streams, modes, msgs: texts, params, cmds, cmdStarts });
}

export function normalizeTlog({ packets }) {
  const hb = packets.find((p) => p.name === 'HEARTBEAT' && p.m.type !== 6); // 6 = MAV_TYPE_GCS
  const sys = hb?.sys;
  const P = packets.filter((p) => p.sys === sys && (p.comp === 1 || p.name === 'HEARTBEAT'));
  if (!P.length) return finish({ format: 'MAVLink .tlog', vehicle: null, streams: {}, modes: [], msgs: [], params: {}, cmds: [], cmdStarts: [], t0Unix: null });
  const ts0 = P[0].ts, T = (ts) => (ts - ts0) / 1e6;
  const by = (name) => P.filter((p) => p.name === name);
  const vt = hb?.m.type;
  const vehicle = vt === 1 || (vt >= 19 && vt <= 25) ? 'plane' : [2, 3, 4, 13, 14, 15].includes(vt) ? 'copter' : vt === 10 ? 'rover' : vt === 12 ? 'sub' : null;
  const S = {};
  const gr = by('GPS_RAW_INT').filter((p) => p.m.fix_type >= 3);
  const gp = gr.length ? gr : by('GLOBAL_POSITION_INT');
  if (gp.length) S.gps = cols({ t: gp.map((p) => T(p.ts)), lat: gp.map((p) => p.m.lat / 1e7), lon: gp.map((p) => p.m.lon / 1e7), alt: gp.map((p) => p.m.alt / 1000),
    spd: gp.map((p) => (gr.length ? p.m.vel / 100 : Math.hypot(p.m.vx, p.m.vy) / 100)), sats: gp.map((p) => p.m.satellites_visible ?? NaN) });
  const at = by('ATTITUDE'), nc = by('NAV_CONTROLLER_OUTPUT');
  if (at.length) {
    const des = (key) => at.map((p) => { const q = nearestPacket(nc, p.ts); return q ? q.m[key] : NaN; });
    S.att = cols({ t: at.map((p) => T(p.ts)), roll: at.map((p) => deg(p.m.roll)), desRoll: des('nav_roll'), pitch: at.map((p) => deg(p.m.pitch)), desPitch: des('nav_pitch'), yaw: at.map((p) => deg(p.m.yaw)) });
  }
  const vh = by('VFR_HUD');
  if (vh.length) { S.thr = cols({ t: vh.map((p) => T(p.ts)), v: vh.map((p) => p.m.throttle) }); S.aspd = cols({ t: vh.map((p) => T(p.ts)), v: vh.map((p) => p.m.airspeed) }); }
  const rp = by('RPM');
  if (rp.length) S.rpm = cols({ t: rp.map((p) => T(p.ts)), v: rp.map((p) => p.m.rpm1) });
  const ss = by('SYS_STATUS');
  if (ss.length) S.bat = cols({ t: ss.map((p) => T(p.ts)), volt: ss.map((p) => p.m.voltage_battery / 1000), curr: ss.map((p) => (p.m.current_battery < 0 ? NaN : p.m.current_battery / 100)) });
  const so = by('SERVO_OUTPUT_RAW').filter((p) => p.m.port === 0);
  if (so.length) S.servo = cols({ t: so.map((p) => T(p.ts)), ...Object.fromEntries(Array.from({ length: 16 }, (_, k) => [`ch${k + 1}`, so.map((p) => p.m[`servo${k + 1}_raw`] ?? NaN)])) });

  const modes = [];
  for (const p of by('HEARTBEAT')) {
    const name = modeName(vehicle, p.m.custom_mode);
    if (modes.at(-1)?.name !== name) modes.push({ t: T(p.ts), num: p.m.custom_mode, name });
  }
  const msgs = by('STATUSTEXT').map((p) => ({ t: T(p.ts), text: p.m.text }));
  const params = {};
  by('PARAM_VALUE').forEach((p) => (params[p.m.param_id] = p.m.param_value));
  const reachedPk = by('MISSION_ITEM_REACHED').map((p) => ({ t: T(p.ts), seq: p.m.seq }));
  const cmds = [];
  by('MISSION_ITEM_INT').filter((p) => p.m.mission_type === 0).forEach((p) => (cmds[p.m.seq] = { seq: p.m.seq, command: p.m.command, frame: p.m.frame, params: [p.m.param1, p.m.param2, p.m.param3, p.m.param4], lat: p.m.x / 1e7, lon: p.m.y / 1e7, alt: p.m.z }));
  return finish({ format: 'MAVLink .tlog', vehicle, firmware: msgs.find((m) => vehicleFromText(m.text))?.text ?? null, t0Unix: ts0 / 1e6,
    streams: S, modes, msgs, params, cmds: cmds.filter(Boolean), cmdStarts: [], reachedPk });
}

function finish(o) {
  // "Reached" dari pesan teks + MISSION_ITEM_REACHED (tlog), digabung tanpa duplikat (seq sama dalam 2 detik).
  const reached = [...(o.reachedPk ?? []), ...o.msgs.map((m) => { const r = REACHED_RE.exec(m.text); return r && { t: m.t, seq: +r[1] }; }).filter(Boolean)]
    .sort((a, b) => a.t - b.t)
    .filter((r, i, arr) => !arr.slice(0, i).some((q) => q.seq === r.seq && Math.abs(q.t - r.t) < 2));
  delete o.reachedPk;
  const cmdStarts = [...o.cmdStarts, ...o.msgs.map((m) => { const r = MISSION_START_RE.exec(m.text); return r && { t: m.t, seq: +r[1] }; }).filter(Boolean)]
    .sort((a, b) => a.t - b.t)
    .filter((r, i, arr) => !arr.slice(0, i).some((q) => q.seq === r.seq && Math.abs(q.t - r.t) < 2));
  const ts = Object.values(o.streams).map((s) => s.t.at(-1)).filter(Number.isFinite);
  const assumed = !o.vehicle;
  return { ...o, vehicle: o.vehicle ?? 'plane', vehicleAssumed: assumed, duration: ts.length ? Math.max(...ts) : 0, reached, cmdStarts };
}

const deg = (r) => (r * 180) / Math.PI;
const modeName = (vehicle, n) => MODES[vehicle ?? 'plane']?.[n] ?? `MODE ${n}`;
function nearestPacket(arr, ts) {
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ts < ts) lo = mid + 1; else hi = mid; }
  return lo > 0 && ts - arr[lo - 1].ts < arr[lo].ts - ts ? arr[lo - 1] : arr[lo];
}

// Downsampling min-max per bucket pada kolom `key` agar puncak/lembah tetap ada. Mengembalikan stream baru.
export function decimate(stream, maxN, key) {
  const n = stream.t.length;
  if (n <= maxN) return stream;
  const buckets = Math.floor(maxN / 2), size = n / buckets, keep = [];
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.min(n, Math.floor((b + 1) * size));
    let lo = s, hi = s;
    for (let i = s; i < e; i++) { if (stream[key][i] < stream[key][lo]) lo = i; if (stream[key][i] > stream[key][hi]) hi = i; }
    keep.push(Math.min(lo, hi)); if (hi !== lo) keep.push(Math.max(lo, hi));
  }
  return Object.fromEntries(Object.entries(stream).map(([k, v]) => [k, Float64Array.from(keep, (i) => v[i])]));
}

export const DECIMATE_KEY = { gps: 'alt', att: 'roll', thr: 'v', aspd: 'v', rpm: 'v', bat: 'volt', servo: 'ch1' };

// Deteksi format dari nama/isi lalu parse + normalisasi + downsampling.
export function parseLogFile(name, buf, { maxPoints = 20000, onProgress } = {}) {
  const u8 = new Uint8Array(buf), ext = name.toLowerCase().split('.').pop();
  if (ext === 'ulg' || (u8[0] === 0x55 && u8[1] === 0x4c && u8[2] === 0x6f && u8[3] === 0x67)) throw new Error('Format PX4 ULog (.ulg) belum didukung — konversi ke .tlog atau gunakan log ArduPilot.');
  let model;
  if (ext === 'tlog') model = normalizeTlog(parseTlog(buf, onProgress));
  else if (u8[0] === 0xa3 && u8[1] === 0x95) model = normalizeDataflash(parseDataflashBin(buf, onProgress), 'DataFlash .bin');
  else if (/^FMT\s*,/.test(dec.decode(u8.subarray(0, 64)))) model = normalizeDataflash(parseDataflashText(new TextDecoder().decode(u8)), 'DataFlash .log (teks)');
  else throw new Error(`${name}: format log tidak dikenali (harus ArduPilot .bin/.log atau .tlog).`);
  if (!model.streams.gps?.t.length) throw new Error(`${name}: tidak ada data GPS dengan fix 3D — jalur tidak bisa digambar.`);
  for (const [k, s] of Object.entries(model.streams)) model.streams[k] = decimate(s, maxPoints, DECIMATE_KEY[k] in s ? DECIMATE_KEY[k] : 't');
  return model;
}
