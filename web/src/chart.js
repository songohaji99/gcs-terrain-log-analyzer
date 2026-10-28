// Grafik garis SVG ringan: profil elevasi / ketinggian vs jarak / deret waktu.
// series: [{ name, color, values, area?, unit? }], x: jarak (m) atau waktu. onHover(i|null) untuk sinkron ke peta.
// bands: [{ x0, x1, color, label? }] latar (mode/segmen berisiko); marks: [{ x, label, color }] garis vertikal yang bisa diklik (onMark(k)).
// Mengembalikan { setCursor(i|null) } untuk sinkronisasi dari luar.
export function renderChart(el, { x, series, onHover, fmtX = fmtDist, unit = 'm', bands = [], marks = [], onMark }) {
  const W = el.clientWidth, H = el.clientHeight, P = { l: 48, r: 14, t: 12, b: 24 };
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity || x.length < 2) { el.innerHTML = '<div class="muted" style="padding:16px">Tidak ada data.</div>'; return { setCursor() {} }; }
  const pad = Math.max(2, (hi - lo) * 0.1); lo -= pad; hi += pad;
  const xmin = x[0], xmax = x.at(-1) > xmin ? x.at(-1) : xmin + 1;
  const sx = (v) => P.l + ((v - xmin) / (xmax - xmin)) * (W - P.l - P.r);
  const sy = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);

  const ticks = niceTicks(lo, hi, 5);
  let svg = `<svg viewBox="0 0 ${W} ${H}"><defs>${series.map((s, k) =>
    `<linearGradient id="g${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".35"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`).join('')}</defs>`;
  for (const b of bands) svg += `<rect x="${sx(b.x0)}" y="${P.t}" width="${Math.max(1, sx(b.x1) - sx(b.x0))}" height="${H - P.t - P.b}" fill="${b.color}"/>` +
    (b.label && sx(b.x1) - sx(b.x0) > 40 ? `<text x="${sx(b.x0) + 4}" y="${P.t + 10}" style="font-size:9px">${b.label}</text>` : '');
  for (const t of ticks) svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="rgba(148,163,184,.12)"/><text x="${P.l - 6}" y="${sy(t) + 3}" text-anchor="end">${t} ${unit}</text>`;
  for (let k = 0; k <= 5; k++) { const v = xmin + ((xmax - xmin) * k) / 5; svg += `<text x="${sx(v)}" y="${H - 6}" text-anchor="middle">${fmtX(v)}</text>`; }
  marks.forEach((m, k) => (svg += `<g class="mark" data-k="${k}" style="cursor:pointer"><line x1="${sx(m.x)}" x2="${sx(m.x)}" y1="${P.t}" y2="${H - P.b}" stroke="${m.color}" stroke-width="1.2" stroke-dasharray="2 3"/>` +
    `<rect x="${sx(m.x) - 14}" y="${P.t}" width="28" height="13" rx="3" fill="${m.color}"/><text x="${sx(m.x)}" y="${P.t + 10}" text-anchor="middle" style="fill:#0b1220;font-size:9px;font-weight:700">${m.label}</text></g>`));

  series.forEach((s, k) => {
    const segs = []; let cur = [];
    Array.prototype.forEach.call(s.values, (v, i) => { if (Number.isFinite(v)) cur.push([sx(x[i]), sy(v)]); else if (cur.length) { segs.push(cur); cur = []; } });
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      const d = seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (s.area) svg += `<path d="${d}L${seg.at(-1)[0]},${H - P.b}L${seg[0][0]},${H - P.b}Z" fill="url(#g${k})"/>`;
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
    }
  });
  svg += `<line id="cursor" y1="${P.t}" y2="${H - P.b}" stroke="rgba(226,232,240,.5)" stroke-dasharray="3 3" visibility="hidden"/>` +
    `<line id="cursor2" y1="${P.t}" y2="${H - P.b}" stroke="#fbbf24" stroke-width="1.5" visibility="hidden"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = svg;

  const cursor = el.querySelector('#cursor'), cursor2 = el.querySelector('#cursor2'), tip = el.querySelector('.tip');
  const place = (ln, i) => { ln.setAttribute('x1', sx(x[i])); ln.setAttribute('x2', sx(x[i])); ln.setAttribute('visibility', 'visible'); };
  el.onmousemove = (e) => {
    const r = el.getBoundingClientRect(), mx = e.clientX - r.left;
    const target = xmin + ((mx - P.l) / (W - P.l - P.r)) * (xmax - xmin);
    let i = 0; while (i < x.length - 1 && x[i + 1] < target) i++;
    if (i < x.length - 1 && Math.abs(x[i + 1] - target) < Math.abs(x[i] - target)) i++;
    place(cursor, i);
    tip.hidden = false;
    tip.innerHTML = `${fmtX(x[i])}<br>` + series.map((s) => `<span style="color:${s.color}">●</span> ${s.name}: ${Number.isFinite(s.values[i]) ? s.values[i].toFixed(1) + ' ' + (s.unit ?? unit) : '—'}`).join('<br>');
    tip.style.left = Math.min(mx + 12, W - tip.offsetWidth - 4) + 'px'; tip.style.top = '10px';
    onHover?.(i);
  };
  el.onmouseleave = () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; onHover?.(null); };
  el.onclick = (e) => { const g = e.target.closest('.mark'); if (g) onMark?.(+g.dataset.k); };
  return { setCursor: (i) => (i == null || i < 0 ? cursor2.setAttribute('visibility', 'hidden') : place(cursor2, Math.min(i, x.length - 1))) };
}

export const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m');

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toFixed(6));
  return out;
}
