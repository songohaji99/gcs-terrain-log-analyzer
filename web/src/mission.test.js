import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMission, resolveAmsl, MissionError } from './mission.js';

const sample = (n) => readFileSync(new URL(`../public/demo/${n}`, import.meta.url), 'utf8');
const strip = (m) => m.items.map(({ frameRaw: _raw, ...rest }) => rest); // frame mentah memang beda (QGC 2 vs MP 3 untuk DO_*)

test('.plan dan .waypoints menghasilkan misi ternormalisasi yang sama', () => {
  const a = parseMission(sample('sentul_plane.plan'), 'x.plan');
  const b = parseMission(sample('sentul_plane.waypoints'), 'x.waypoints');
  assert.equal(a.format, 'QGC .plan');
  assert.equal(b.format, 'QGC WPL 110');
  assert.equal(a.items.length, 12);
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(a.home, b.home);
  assert.deepEqual(a.items.map((i) => i.seq), [...Array(12).keys()]);
});

test('frame & item NAV/DO dinormalisasi', () => {
  const { items, home } = parseMission(sample('sentul_plane.waypoints'));
  const by = (s) => items[s];
  assert.equal(by(1).name, 'NAV_TAKEOFF');
  assert.equal(by(1).lat, null); // takeoff pesawat tanpa posisi
  assert.equal(by(2).name, 'DO_CHANGE_SPEED');
  assert.equal(by(2).frame, 'MISSION');
  assert.equal(by(2).p2, 20);
  assert.equal(by(6).frame, 'TERRAIN');
  assert.equal(by(7).frame, 'GLOBAL');
  assert.equal(by(3).frame, 'RELATIVE');
  assert.equal(resolveAmsl(by(3), home.alt), 351);
  assert.equal(resolveAmsl(by(6), home.alt, 409), 529);
  assert.equal(resolveAmsl(by(7), home.alt), 520);
  assert.equal(resolveAmsl(by(6), home.alt, null), null); // tanpa DEM tidak ditebak
  assert.equal(resolveAmsl(by(2), home.alt), null);
});

test('file rusak memberi pesan jelas', () => {
  assert.throws(() => parseMission('{"mission": ', 'a.plan'), (e) => e instanceof MissionError && /JSON rusak/.test(e.message));
  assert.throws(() => parseMission('{"foo":1}', 'a.plan'), /bukan file \.plan/);
  assert.throws(() => parseMission('QGC WPL 110\n0\t1\t0\t16\t0\t0', 'a.waypoints'), /baris 2: harus 12 kolom/);
  assert.throws(() => parseMission('QGC WPL 110\n0\t1\t0\t16\t0\t0\t0\t0\tx\t106\t10\t1', 'a.waypoints'), /kolom 9 bukan angka/);
  assert.throws(() => parseMission('hello', 'a.txt'), /format misi tidak dikenali/);
  assert.throws(() => parseMission('QGC WPL 110\n', 'a.txt'), /tidak ada item/);
});
