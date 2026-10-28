import proj4 from 'proj4';
import * as mgrs from 'mgrs';
const mgrsForward = mgrs.forward ?? mgrs.default.forward; // ESM (Vite) vs CJS (node --test)

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function toDMS(v, pos, neg) {
  const h = v >= 0 ? pos : neg;
  v = Math.abs(v);
  const d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″${h}`;
}

const UTM48S = '+proj=utm +zone=48 +south +datum=WGS84 +units=m +no_defs';
export function toUTM48S(lon, lat) {
  const [e, n] = proj4('EPSG:4326', UTM48S, [lon, lat]);
  return `48S ${e.toFixed(0)} E ${n.toFixed(0)} N`;
}

export function toMGRS(lon, lat) {
  try {
    return mgrsForward([lon, lat], 5).replace(/^(\d+\w)(\w\w)(\d{5})(\d{5})$/, '$1 $2 $3 $4');
  } catch {
    return '—';
  }
}

// Jarak lateral (m) titik ke polyline, dalam proyeksi lokal equirectangular (cukup untuk skala misi drone).
export function distToPolyline(p, line) {
  const k = Math.cos(rad(p[1])) * rad(1) * R, kl = rad(1) * R;
  const xy = ([lon, lat]) => [(lon - p[0]) * k, (lat - p[1]) * kl];
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]), [bx, by] = xy(line[i]);
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return line.length === 1 ? haversine(p, line[0]) : best;
}

export const terrariumHeight = (r, g, b) => r * 256 + g + b / 256 - 32768;

// Tile XYZ (Web Mercator) beserta posisi piksel di dalamnya.
export function lngLatToTilePixel(lon, lat, z, size = 256) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n;
  const tx = Math.floor(x), ty = Math.floor(y);
  return { tx, ty, px: Math.min(size - 1, Math.floor((x - tx) * size)), py: Math.min(size - 1, Math.floor((y - ty) * size)) };
}

// Sisipkan titik setiap `step` meter di sepanjang polyline -> [{lngLat, d}]
export function densify(line, step) {
  const out = [{ lngLat: line[0], d: 0 }];
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], seg = haversine(a, b);
    const n = Math.max(1, Math.ceil(seg / step));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      out.push({ lngLat: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: acc + seg * t });
    }
    acc += seg;
  }
  return out;
}

// Heightmap n×n (Float32, baris-mayor dari utara) untuk tile Web Mercator (x, y, level),
// diambil dari tile Terrarium leluhur pada zoom z ≤ level. Tepi kanan/bawah di-clamp ke piksel 255.
export function terrariumHeightmap(rgba, x, y, level, z, n = 65) {
  const s = 2 ** (level - z), span = 256 / s;
  const ox = (x - Math.floor(x / s) * s) * span, oy = (y - Math.floor(y / s) * s) * span;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const py = Math.min(255, Math.floor(oy + (j / (n - 1)) * span));
    for (let i = 0; i < n; i++) {
      const k = (py * 256 + Math.min(255, Math.floor(ox + (i / (n - 1)) * span))) * 4;
      out[j * n + i] = terrariumHeight(rgba[k], rgba[k + 1], rgba[k + 2]);
    }
  }
  return out;
}

// ---------- input koordinat (diproses lokal) ----------
// Mengembalikan { lon, lat, kind: 'DD'|'DMS'|'UTM'|'MGRS' } atau null bila teks bukan koordinat.
// UTM: huruf setelah zona 'S'/'N' = belahan selatan/utara (konvensi tampilan app ini, "48S 702183 E 9317059 N");
//      huruf band lain (C–X) diperlakukan sebagai band lintang MGRS (C–M selatan).
export function parseCoordinate(input) {
  const s = String(input ?? '').trim().toUpperCase();
  if (!s) return null;
  const compact = s.replace(/\s+/g, '');
  if (/^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d{2}){1,5}$/.test(compact)) {
    try { const [lon, lat] = mgrs.toPoint?.(compact) ?? mgrs.default.toPoint(compact); return valid(lon, lat, 'MGRS'); } catch { return null; }
  }
  const u = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{3,7}(?:\.\d+)?)\s*M?E?\s*,?\s+(\d{1,8}(?:\.\d+)?)\s*M?N?$/.exec(s);
  if (u) {
    const zone = +u[1], south = u[2] === 'S' || (u[2] !== 'N' && u[2] < 'N');
    if (zone < 1 || zone > 60) return null;
    const [lon, lat] = proj4(`+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`, 'EPSG:4326', [+u[3], +u[4]]);
    return valid(lon, lat, 'UTM');
  }
  const t = s.replace(/(?<![A-Z])LU(?![A-Z])/g, 'N').replace(/(?<![A-Z])LS(?![A-Z])/g, 'S').replace(/(?<![A-Z])BT(?![A-Z])/g, 'E').replace(/(?<![A-Z])BB(?![A-Z])/g, 'W');
  if (!/^[\d\s.,°'"′″:+\-NSEW]+$/.test(t)) return null;
  const parts = [];
  let cur = { nums: [], hemi: null }, pending = null;
  const close = () => { if (cur.nums.length) { parts.push(cur); cur = { nums: [], hemi: null }; } };
  for (const m of t.matchAll(/(-?\d+(?:\.\d+)?)|([NSEW])|(,)/g)) {
    if (m[1]) { if (pending) { cur.hemi = pending; pending = null; } cur.nums.push(+m[1]); }
    else if (m[2]) { if (cur.nums.length && !cur.hemi) { cur.hemi = m[2]; close(); } else { close(); pending = m[2]; } }
    else close();
  }
  close();
  if (parts.length === 1 && [2, 4, 6].includes(parts[0].nums.length)) { // tanpa pemisah: bagi dua
    const n = parts[0].nums, h = n.length / 2;
    parts.splice(0, 1, { nums: n.slice(0, h), hemi: null }, { nums: n.slice(h), hemi: parts[0].hemi });
  }
  if (parts.length !== 2 || parts.some((p) => p.nums.length > 3)) return null;
  const val = (p) => {
    const [d, m = 0, sec = 0] = p.nums;
    if (m < 0 || m >= 60 || sec < 0 || sec >= 60 || (p.nums.length > 1 && !Number.isInteger(d))) return NaN;
    const v = Math.abs(d) + m / 60 + sec / 3600;
    return (d < 0 || Object.is(d, -0) || p.hemi === 'S' || p.hemi === 'W' ? -1 : 1) * v;
  };
  let [a, b] = parts.map(val);
  const latFirst = parts[0].hemi ? 'NS'.includes(parts[0].hemi) : parts[1].hemi ? 'EW'.includes(parts[1].hemi) : Math.abs(a) <= 90;
  if (!latFirst) [a, b] = [b, a];
  return valid(b, a, parts.every((p) => p.nums.length === 1) ? 'DD' : 'DMS');
}
const valid = (lon, lat, kind) => (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lon, lat, kind } : null);
