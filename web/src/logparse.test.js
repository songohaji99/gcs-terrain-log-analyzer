import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLogFile, parseTlog, decimate, normalizeDataflash } from './logparse.js';

const buf = (n) => { const b = readFileSync(new URL(`../public/demo/${n}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const bin = parseLogFile('s.bin', buf('sentul_plane.bin'));
const txt = parseLogFile('s.log', buf('sentul_plane.log'));
const tlog = parseLogFile('s.tlog', buf('sentul_plane.tlog'));

test('DataFlash .bin terbaca lengkap', () => {
  assert.equal(bin.format, 'DataFlash .bin');
  assert.equal(bin.vehicle, 'plane');
  assert.equal(bin.vehicleAssumed, false);
  assert.ok(bin.streams.gps.t.length > 4000);
  for (const k of ['att', 'thr', 'aspd', 'rpm', 'bat', 'servo']) assert.ok(bin.streams[k]?.t.length, k);
  assert.deepEqual(bin.modes.map((m) => m.name), ['MANUAL', 'AUTO', 'FBWA', 'AUTO', 'MANUAL']);
  assert.deepEqual(bin.reached.map((r) => r.seq), [3, 4, 6, 7, 9, 10]); // takeoff/land tidak punya teks "Reached"
  assert.equal(bin.params.SERVO1_FUNCTION, 4);
  assert.equal(bin.cmds.length, 12);
  assert.ok(bin.cmdStarts.length >= 8);
  assert.equal(new Date(bin.t0Unix * 1000).toISOString().slice(0, 16), '2026-10-25T01:00');
});

test('DataFlash teks .log setara dengan .bin', () => {
  assert.equal(txt.streams.gps.t.length, bin.streams.gps.t.length);
  const i = 2000;
  assert.ok(Math.abs(txt.streams.gps.lat[i] - bin.streams.gps.lat[i]) < 1e-6);
  assert.ok(Math.abs(txt.streams.gps.alt[i] - bin.streams.gps.alt[i]) < 0.01);
  assert.deepEqual(txt.reached, bin.reached);
  assert.equal(txt.msgs.length, bin.msgs.length);
});

test('MAVLink .tlog: filter GCS, reached, servo, ekor rusak dilewati', () => {
  assert.equal(tlog.vehicle, 'plane');
  assert.deepEqual(tlog.reached.map((r) => r.seq), [1, 3, 4, 6, 7, 9, 10, 11]);
  assert.deepEqual(tlog.modes.map((m) => m.name), ['MANUAL', 'AUTO', 'FBWA', 'AUTO', 'MANUAL']);
  assert.equal(tlog.params.SERVO5_FUNCTION, 4);
  assert.equal(tlog.cmds.length, 12);
  assert.ok(tlog.streams.servo.ch9.includes(1900));
  // posisi tlog vs bin pada waktu reached WP 6 berdekatan
  const r = (m) => m.reached.find((x) => x.seq === 6).t;
  assert.ok(Math.abs(r(tlog) - r(bin)) < 1.5);
  const { skippedBytes } = parseTlog(buf('sentul_plane.tlog'));
  assert.ok(skippedBytes > 0 && skippedBytes < 64);
});

test('error jelas & downsampling', () => {
  assert.throws(() => parseLogFile('x.ulg', new Uint8Array([0x55, 0x4c, 0x6f, 0x67]).buffer), /ULog/);
  assert.throws(() => parseLogFile('x.bin', new Uint8Array(100).buffer), /format log tidak dikenali/);
  assert.throws(() => parseLogFile('x.tlog', new Uint8Array(100).buffer), /tidak ada data GPS/);
  const s = { t: Float64Array.from({ length: 1000 }, (_, i) => i), v: Float64Array.from({ length: 1000 }, (_, i) => (i === 517 ? 99 : 0)) };
  const d = decimate(s, 100, 'v');
  assert.ok(d.t.length <= 100);
  assert.ok(d.v.includes(99)); // puncak tidak hilang
});

test('ArduPilot 4.x "Mission: N" menjadi event awal perintah', () => {
  const msgs = { MSG: { TimeUS: [1e6, 5e6, 9e6], Message: ['ArduPlane V4.6.3 (3fc701)', 'Mission: 1 Takeoff', 'Mission: 2 WP'] } };
  const m = normalizeDataflash({ msgs }, 'DataFlash .bin');
  assert.deepEqual(m.cmdStarts.map((c) => c.seq), [1, 2]);
  assert.equal(m.cmdStarts[1].t, 8);
  assert.equal(m.reached.length, 0);
});
