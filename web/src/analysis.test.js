import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMission } from './mission.js';
import { parseLogFile } from './logparse.js';
import { buildNav, plannedProfile, flightRisk, runs, compareWaypoint, status, interp, missionSamples, planRisk, modeAt } from './analysis.js';

const read = (n) => readFileSync(new URL(`../public/demo/${n}`, import.meta.url));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const mission = parseMission(read('sentul_plane.waypoints').toString());
const log = parseLogFile('s.bin', ab(read('sentul_plane.bin')));
const nav = buildNav(mission, 201, { 6: 409 });

test('buildNav: AMSL per frame, takeoff tanpa posisi', () => {
  assert.deepEqual(nav.map((n) => n.seq), [0, 1, 3, 4, 6, 7, 9, 10, 11]);
  assert.deepEqual(nav.map((n) => n.amsl), [201, 261, 351, 461, 529, 520, 501, 421, 201]);
  assert.equal(nav[1].posAssumed, true);
  assert.equal(buildNav(mission, 201, {}).find((n) => n.seq === 6).amsl, null); // TERRAIN tanpa DEM -> tidak ditebak
});

test('plannedProfile mengikuti leg aktif, NaN di luar AUTO', () => {
  const g = log.streams.gps;
  const { planned, target } = plannedProfile(g, nav, log);
  const at = (t) => planned[g.t.findIndex((x) => x >= t)];
  const r4 = log.reached.find((r) => r.seq === 4).t;
  assert.ok(Math.abs(at(r4 - 1) - 461) < 15);
  const fbwa = log.modes.find((m) => m.name === 'FBWA').t;
  assert.ok(Number.isNaN(at(fbwa + 5)));
  const tgts = [...new Set(target.filter((k) => k > 0))];
  assert.deepEqual(tgts.map((k) => nav[k].seq), [1, 3, 4, 6, 7, 9, 10, 11]);
  assert.equal(modeAt(log.modes, fbwa + 1), 'FBWA');
});

test('flightRisk & runs', () => {
  assert.deepEqual(runs([0, 1, 1, 0, 1]), [{ i0: 1, i1: 2 }, { i0: 4, i1: 4 }]);
  const g = log.streams.gps, { target } = plannedProfile(g, nav, log);
  const r3 = log.reached.find((r) => r.seq === 3).t, r4 = log.reached.find((r) => r.seq === 4).t;
  const terrain = Array.from(g.t, (t, i) => (t > r3 && t < r4 ? g.alt[i] - 20 : 201)); // terrain naik 20 m di bawah pesawat antara WP3–WP4
  const r = flightRisk(g, terrain, target, nav, 30);
  assert.equal(r.runs.length, 1);
  assert.ok(Math.abs(r.minAgl - 20) < 1e-6);
  assert.ok(Math.abs(r.riskSec - (r4 - r3)) < 2);
});

test('planRisk per leg', () => {
  const s = missionSamples(nav, 50);
  const terrain = s.map((x) => (x.k === nav.findIndex((n) => n.seq === 6) ? x.planned - 10 : 200));
  const pr = planRisk(s, terrain, 30);
  assert.equal(pr.runs.length, 1);
  assert.ok(Math.abs(pr.perLeg[nav.findIndex((n) => n.seq === 6)] - 10) < 1e-6);
});

test('compareWaypoint: mission vs log, engine & aileron', () => {
  const k6 = nav.findIndex((n) => n.seq === 6);
  const c = compareWaypoint(k6, nav, mission, log, { terrainBySeq: { 6: 409 }, tolH: 30, tolV: 10 });
  assert.equal(c.mission.frame, 'TERRAIN');
  assert.equal(c.mission.aglPlan, 120);
  assert.equal(c.log.source, 'reached');
  assert.ok(c.log.horiz < 65);
  assert.ok(Number.isFinite(c.log.dAlt) && Number.isFinite(c.log.gs));
  assert.deepEqual(c.aileron.channels.map((x) => x.ch), [1, 5]);
  assert.ok(c.aileron.channels.every((x) => x.pwm >= 1100 && x.pwm <= 1900));
  assert.ok(Number.isFinite(c.aileron.roll) && Number.isFinite(c.aileron.desRoll));
  assert.deepEqual(c.aileron.cmds.map((x) => x.name), ['DO_SET_SERVO', 'NAV_WAYPOINT']);
  assert.ok(c.engine.thr > 0 && c.engine.rpm > 1000);
  const k9 = nav.findIndex((n) => n.seq === 9);
  assert.deepEqual(compareWaypoint(k9, nav, mission, log).engine.cmds.map((x) => x.name), ['DO_ENGINE_CONTROL']);
  // takeoff tidak punya teks "Reached" di .bin -> pakai awal perintah berikutnya, ditandai
  assert.equal(compareWaypoint(1, nav, mission, log).log.source, 'start');
  // data tidak ada -> tidak ditebak
  const bare = { ...log, params: {}, streams: { gps: log.streams.gps } };
  const cb = compareWaypoint(k6, nav, mission, bare);
  assert.equal(cb.aileron.paramsKnown, false);
  assert.equal(cb.engine.has.rpm, false);
  assert.ok(Number.isNaN(cb.engine.rpm) && Number.isNaN(cb.aileron.roll));
});

test('status toleransi & interp', () => {
  assert.equal(status(5, 10), 'ok');
  assert.equal(status(-15, 10), 'warn');
  assert.equal(status(30, 10), 'bad');
  assert.equal(status(NaN, 10), 'na');
  assert.equal(interp([0, 10], [0, 100], 2.5), 25);
  assert.ok(Number.isNaN(interp([0, 10], [0, 100], 11)));
});

test('compareWaypoint: titik terdekat dicari setelah WP sebelumnya', () => {
  const k11 = nav.findIndex((n) => n.seq === 11);
  const bare = { ...log, reached: [], cmdStarts: [] };
  const early = compareWaypoint(k11, nav, mission, bare);
  assert.equal(early.log.source, 'closest');
  const late = compareWaypoint(k11, nav, mission, bare, { afterT: early.log.t + 1 });
  assert.ok(late.log.t > early.log.t);
  const k3 = nav.findIndex((n) => n.seq === 3);
  assert.notEqual(compareWaypoint(k3, nav, mission, log, { afterT: log.duration - 1 }).log.source, 'reached'); // event reached sebelum afterT diabaikan
});
