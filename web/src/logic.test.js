import test from 'node:test';
import assert from 'node:assert/strict';
import { terrariumHeightmap, haversine, toDMS, toUTM48S, toMGRS, distToPolyline, terrariumHeight, densify, lngLatToTilePixel } from './geo.js';
import { parseTelemetryCSV, parsePlan } from './parsers.js';

test('geo helpers', () => {
  assert.ok(Math.abs(haversine([106.8, -6.2], [106.81, -6.2]) - 1105.5) < 2);
  assert.equal(toDMS(-6.175, 'U', 'S'), '6°10′30.00″S');
  assert.match(toUTM48S(106.8272, -6.1754), /^48S 70\d{4} E 9317\d{3} N$/);
  assert.match(toMGRS(106.8272, -6.1754), /^48M YU 02183 17059$/);
  assert.ok(Math.abs(distToPolyline([106.8, -6.2009], [[106.79, -6.2], [106.81, -6.2]]) - 100) < 1);
  assert.equal(terrariumHeight(128, 10, 128), 10.5);
  const d = densify([[106.8, -6.2], [106.81, -6.2]], 100);
  assert.equal(d.length, 13);
  assert.ok(Math.abs(d.at(-1).d - 1105.5) < 2);
  const tp = lngLatToTilePixel(106.8272, -6.1754, 12);
  assert.deepEqual([tp.tx, tp.ty], [3263, 2118]);
});

test('parse QGC CSV', () => {
  const csv = 'Timestamp,altitudeRelative,altitudeAMSL,gps.lat,gps.lon,groundSpeed\n' +
    '2026-10-27 10:00:00,0,8,-6.17,106.82,0\n2026-10-27 10:00:01,5,13,-6.1701,106.8201,3\n2026-10-27 10:00:02,5,13,0,0,3';
  const p = parseTelemetryCSV(csv);
  assert.equal(p.length, 2);
  assert.equal(p[1].alt, 13);
  assert.equal(p[1].rel, 5);
  assert.equal(p[1].t - p[0].t, 1);
});

test('parse .plan', () => {
  const plan = {
    mission: {
      plannedHomePosition: [-6.17, 106.82, 10],
      items: [
        { type: 'SimpleItem', command: 22, frame: 3, params: [0, 0, 0, null, -6.17, 106.82, 50] },
        { type: 'ComplexItem', complexItemType: 'survey', polygon: [[-6.171, 106.821], [-6.172, 106.821], [-6.172, 106.822]],
          TransectStyleComplexItem: { Items: [{ type: 'SimpleItem', command: 16, frame: 3, params: [0, 0, 0, null, -6.171, 106.821, 80] }] } },
        { type: 'SimpleItem', command: 20, frame: 2, params: [0, 0, 0, 0, 0, 0, 0] },
      ],
    },
  };
  const r = parsePlan(plan);
  assert.equal(r.wps.length, 2);
  assert.equal(r.wps[1].alt, 80);
  assert.equal(r.wps[0].frame, 'Relatif home');
  assert.equal(r.surveys[0][0][0], 106.821);
});

test('terrarium heightmap resampling', () => {
  const rgba = new Uint8ClampedArray(256 * 256 * 4);
  for (let p = 0; p < 256 * 256; p++) { rgba[p * 4] = 128; rgba[p * 4 + 1] = p % 256; } // tinggi = kolom piksel
  const same = terrariumHeightmap(rgba, 5, 7, 3, 3, 65);
  assert.equal(same[0], 0);
  assert.equal(same[64], 255); // tepi kanan di-clamp
  const child = terrariumHeightmap(rgba, 11, 14, 4, 3, 65); // anak kanan-atas: kolom 128..255
  assert.equal(child[0], 128);
  assert.equal(child[32], 192);
});
