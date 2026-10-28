// Tampilan Globe 3D (CesiumJS), dimuat malas saat pertama dibuka.
// Tanpa Cesium ion: terrain dari DEM Terrarium yang sama dengan 2D, bangunan LOD1 dari tile vektor OSM
// yang sudah dimuat MapLibre. Ketinggian MSL dipakai langsung sebagai tinggi Cesium; karena terrain,
// bangunan dan drone memakai acuan yang sama, posisi relatifnya konsisten (absolutnya bergeser ±undulasi geoid).
import { demTile, elevationAt, DEM_MAXZOOM } from './elevation.js';
import { terrariumHeightmap } from './geo.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BASEMAPS = {
  esri: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, credit: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  s2: { url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg', max: 15, credit: 'Sentinel-2 cloudless 2023 © EOX' },
  dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', max: 19, credit: '© OpenStreetMap, © CARTO', sub: 'abcd' },
};
const HEIGHT_STOPS = [[0, '#1e3a5f'], [30, '#2563eb'], [80, '#38bdf8'], [200, '#a5f3fc']]; // sama dengan 2D
const DRONE_SVG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M20 3 L29 33 L20 27 L11 33 Z" fill="#22d3ee" stroke="#0b1220" stroke-width="1.5"/></svg>');

export function initCesium(app) {
  const { map } = app;
  let C = null, viewer = null, loading = null, is3d = false;
  // State yang dikumpulkan walau globe belum dibuka.
  const st = { trail: [], last: null, archive: null, floods: [] };
  let ent = {}, archiveEnts = [], floodSrc = null, bldPrims = [], seenBld = new Set(), harvestBusy = false;

  app.bus.addEventListener('telemetry', (e) => {
    const t = e.detail;
    st.last = t;
    st.trail.push([t.lon, t.lat, t.alt_msl]);
    if (st.trail.length > 4000) st.trail.shift();
    if (viewer) updateDrone();
  });
  app.bus.addEventListener('trail-clear', () => { st.trail = []; });
  app.bus.addEventListener('archive', (e) => { st.archive = e.detail; if (viewer) drawArchive(true); });
  app.bus.addEventListener('floods', (e) => { st.floods = e.detail; if (viewer) drawFloods(); });

  // ---------- 2D <-> 3D ----------
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setMode(b.dataset.view === '3d')));

  async function setMode(on) {
    if (on === is3d) return;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', (b.dataset.view === '3d') === on));
    if (on) {
      if ($('#t-swipe').checked) { $('#t-swipe').checked = false; $('#t-swipe').dispatchEvent(new Event('change')); }
      $('#globe-status').textContent = 'Memuat CesiumJS…';
      $('#globe').hidden = $('#globe-bar').hidden = false;
      document.body.classList.add('mode-3d');
      try { await ensureViewer(); } catch (err) {
        console.error(err); app.toast(`Gagal memuat CesiumJS: ${err.message}`, 5000);
        document.body.classList.remove('mode-3d'); $('#globe').hidden = $('#globe-bar').hidden = true;
        document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === '2d'));
        return;
      }
      is3d = true;
      const view = mapView();
      $('#map').style.visibility = 'hidden'; // tetap memuat tile (dipakai untuk panen bangunan)
      viewer.resize();
      await cameraFrom2D(view);
      harvestBuildings();
    } else {
      is3d = false;
      const v = cameraTo2D();
      document.body.classList.remove('mode-3d');
      $('#globe').hidden = $('#globe-bar').hidden = true;
      $('#map').style.visibility = '';
      if (v) map.jumpTo(v);
    }
  }
  app.is3d = () => is3d;
  app.globeFlyTo = (lon, lat, h = 1500) => viewer?.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, h), duration: 1.5 });

  function ensureViewer() {
    loading ??= (async () => {
      window.CESIUM_BASE_URL = '/cesium/';
      [C] = await Promise.all([import('cesium'), import('cesium/Build/Cesium/Widgets/widgets.css')]);
      createViewer();
    })();
    return loading;
  }

  function createViewer() {
    const terrainProvider = new C.CustomHeightmapTerrainProvider({
      width: 65, height: 65,
      tilingScheme: new C.WebMercatorTilingScheme(),
      credit: 'Elevasi: Mapzen Terrarium (SRTM/NASADEM)',
      callback: async (x, y, level) => {
        const z = Math.min(level, DEM_MAXZOOM), s = 2 ** (level - z);
        try {
          return terrariumHeightmap(await demTile(z, Math.floor(x / s), Math.floor(y / s)), x, y, level, z);
        } catch {
          return new Float32Array(65 * 65); // tile laut/gagal -> datar 0 m
        }
      },
    });
    viewer = new C.Viewer('globe', {
      baseLayer: new C.ImageryLayer(provider('esri')),
      terrainProvider,
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false, timeline: true, animation: true,
      infoBox: true, selectionIndicator: true, shouldAnimate: true,
    });
    const sc = viewer.scene;
    sc.globe.depthTestAgainstTerrain = true;
    sc.globe.baseColor = C.Color.fromCssColorString('#070c17');
    sc.backgroundColor = C.Color.fromCssColorString('#070c17');
    sc.fog.enabled = true;
    viewer.clock.multiplier = 1;

    $('#globe-base').onchange = (e) => {
      viewer.imageryLayers.removeAll();
      viewer.imageryLayers.add(new C.ImageryLayer(provider(e.target.value)));
    };
    $('#globe-bld').onchange = (e) => bldPrims.forEach((p) => (p.show = e.target.checked));
    $('#globe-exag').oninput = (e) => { sc.verticalExaggeration = +e.target.value; $('#globe-exag-v').textContent = e.target.value + '×'; };
    $('#globe-fly').onclick = () => (archiveEnts.length ? viewer.flyTo(archiveEnts) : app.toast('Belum ada arsip — muat di Drone › Arsip'));
    $('#d-follow').addEventListener('change', updateDrone);

    // koordinat kursor -> bar bawah yang sama dengan 2D
    new C.ScreenSpaceEventHandler(sc.canvas).setInputAction((m) => {
      const ll = pickLonLat(m.endPosition);
      if (ll) app.showCoords(ll[0], ll[1]);
    }, C.ScreenSpaceEventType.MOUSE_MOVE);

    let t;
    viewer.camera.moveEnd.addEventListener(() => { clearTimeout(t); t = setTimeout(harvestBuildings, 400); });

    updateDrone();
    drawArchive(false);
    drawFloods();
  }

  function provider(key) {
    const b = BASEMAPS[key];
    return new C.UrlTemplateImageryProvider({ url: b.url, maximumLevel: b.max, credit: b.credit, ...(b.sub ? { subdomains: b.sub } : {}) });
  }

  // ---------- sinkron kamera ----------
  const mapView = () => ({ center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
  const mppML = (lat, z) => (78271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** z; // meter/piksel, tile MapLibre 512 px

  async function cameraFrom2D({ center: [lon, lat], zoom, bearing, pitch }) {
    const ground = (await elevationAt(lon, lat)) ?? 0;
    const fov = viewer.camera.frustum.fovy ?? Math.PI / 3;
    const range = (mppML(lat, zoom) * $('#globe').clientHeight) / 2 / Math.tan(fov / 2);
    viewer.camera.lookAt(C.Cartesian3.fromDegrees(lon, lat, ground),
      new C.HeadingPitchRange(C.Math.toRadians(bearing), C.Math.toRadians(-(90 - Math.min(pitch, 80))), range));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  }

  function cameraTo2D() {
    if (!viewer) return null;
    const cam = viewer.camera, mid = new C.Cartesian2($('#globe').clientWidth / 2, $('#globe').clientHeight / 2);
    const hit = viewer.scene.globe.pick(cam.getPickRay(mid), viewer.scene);
    const pitch = Math.max(0, Math.min(80, 90 + C.Math.toDegrees(cam.pitch)));
    const bearing = C.Math.toDegrees(cam.heading);
    if (!hit) { const c = cam.positionCartographic; return { center: [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)], zoom: 10, bearing, pitch }; }
    const c = C.Cartographic.fromCartesian(hit), lat = C.Math.toDegrees(c.latitude);
    const range = C.Cartesian3.distance(cam.position, hit);
    const fov = cam.frustum.fovy ?? Math.PI / 3;
    const zoom = Math.log2((78271.51696 * Math.cos((lat * Math.PI) / 180) * $('#globe').clientHeight) / (2 * range * Math.tan(fov / 2)));
    return { center: [C.Math.toDegrees(c.longitude), lat], zoom: Math.max(1, Math.min(20, zoom)), bearing, pitch };
  }

  function pickLonLat(px) {
    const ray = viewer.camera.getPickRay(px), hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
    if (!hit) return null;
    const c = C.Cartographic.fromCartesian(hit);
    return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
  }

  // ---------- bangunan LOD1 dari tile vektor OSM MapLibre ----------
  async function harvestBuildings() {
    if (!is3d || harvestBusy) return;
    const h = viewer.camera.positionCartographic.height;
    const v = cameraTo2D();
    if (!v || h > 8000) { $('#globe-status').textContent = 'Dekatkan kamera (< 8 km) untuk memuat bangunan 3D'; return; }
    harvestBusy = true;
    $('#globe-status').textContent = 'Memuat bangunan…';
    map.jumpTo({ center: v.center, zoom: 15, bearing: 0, pitch: 0 });
    await new Promise((r) => (map.loaded() ? r() : map.once('idle', r)));
    const feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
    const polys = [];
    for (const f of feats) {
      const g = f.geometry, rings = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const r of rings) {
        if (!r[0] || r[0].length < 4) continue;
        // tile z13/z14/z15 memuat bangunan yang sama dengan simplifikasi berbeda -> dedupe per sel ±5 m dari centroid
        const cx = r[0].reduce((a, c) => a + c[0], 0) / r[0].length, cy = r[0].reduce((a, c) => a + c[1], 0) / r[0].length;
        const key = `${f.id}:${Math.round(cx / 5e-5)},${Math.round(cy / 5e-5)}`;
        if (seenBld.has(key)) continue;
        seenBld.add(key);
        polys.push({ r, h: +(f.properties.render_height ?? 6), base: +(f.properties.render_min_height ?? 0) });
      }
    }
    const grounds = await Promise.all(polys.map((p) => elevationAt(p.r[0][0][0], p.r[0][0][1])));
    const instances = [];
    polys.forEach((p, i) => {
      const g = grounds[i] ?? 0;
      if (p.h <= p.base) return;
      instances.push(new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(p.r[0].flat()),
            p.r.slice(1).map((hole) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(hole.flat())))),
          height: g + p.base, extrudedHeight: g + p.h,
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(heightColor(p.h)) },
      }));
    });
    if (instances.length) {
      const prim = new C.Primitive({ geometryInstances: instances, appearance: new C.PerInstanceColorAppearance({ translucent: false }), show: $('#globe-bld').checked });
      viewer.scene.primitives.add(prim);
      bldPrims.push(prim);
    }
    $('#globe-status').textContent = `${seenBld.size.toLocaleString('id-ID')} bangunan OSM (LOD1)`;
    harvestBusy = false;
  }

  function heightColor(h) {
    let i = HEIGHT_STOPS.findIndex(([v]) => v > h);
    if (i === -1) return C.Color.fromCssColorString(HEIGHT_STOPS.at(-1)[1]);
    if (i === 0) return C.Color.fromCssColorString(HEIGHT_STOPS[0][1]);
    const [v0, c0] = HEIGHT_STOPS[i - 1], [v1, c1] = HEIGHT_STOPS[i];
    return C.Color.lerp(C.Color.fromCssColorString(c0), C.Color.fromCssColorString(c1), (h - v0) / (v1 - v0), new C.Color());
  }

  // ---------- drone live ----------
  function updateDrone() {
    const t = st.last;
    if (!viewer || !t) return;
    if (!ent.drone) {
      ent.trail = viewer.entities.add({
        polyline: { positions: new C.CallbackProperty(() => C.Cartesian3.fromDegreesArrayHeights(st.trail.flat()), false), width: 6,
          material: new C.PolylineGlowMaterialProperty({ glowPower: 0.25, color: C.Color.fromCssColorString('#22d3ee') }) },
      });
      ent.stem = viewer.entities.add({
        polyline: { positions: new C.CallbackProperty(() => {
          const s = st.last; return C.Cartesian3.fromDegreesArrayHeights([s.lon, s.lat, s.ground ?? 0, s.lon, s.lat, s.alt_msl]);
        }, false), width: 1.5, material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.7) }) },
      });
      ent.drone = viewer.entities.add({
        name: 'Drone live',
        viewFrom: new C.Cartesian3(-250, -350, 220), // sudut kamera "chase" saat mode ikuti
        billboard: { image: DRONE_SVG, width: 44, height: 44, alignedAxis: C.Cartesian3.UNIT_Z, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { font: '600 13px Inter, sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#070c17'), outlineWidth: 4,
          style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -36), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    ent.drone.position = C.Cartesian3.fromDegrees(t.lon, t.lat, t.alt_msl);
    ent.drone.billboard.rotation = -C.Math.toRadians(t.heading ?? 0);
    ent.drone.label.text = `MSL ${t.alt_msl?.toFixed(0)} m · AGL ${t.agl == null ? '—' : t.agl.toFixed(0) + ' m'}`;
    ent.drone.label.fillColor = t.low ? C.Color.fromCssColorString('#f87171') : C.Color.WHITE;
    const follow = is3d && $('#d-follow').checked;
    if (follow && viewer.trackedEntity !== ent.drone) viewer.trackedEntity = ent.drone;
    if (!follow && viewer.trackedEntity === ent.drone) viewer.trackedEntity = undefined;
  }

  // ---------- arsip: replay waktu (CZML-style) ----------
  async function drawArchive(fly) {
    archiveEnts.forEach((e) => viewer.entities.remove(e));
    archiveEnts = [];
    const a = st.archive;
    if (!a || (!a.track && !a.plan)) return;
    const add = (o) => { const e = viewer.entities.add(o); archiveEnts.push(e); return e; };

    if (a.plan) {
      const homeAlt = a.plan.home?.alt ?? 0;
      const g = await Promise.all(a.plan.wps.map((w) => (w.frame === 'Terrain' ? elevationAt(w.lon, w.lat) : null)));
      const pts = a.plan.wps.map((w, i) => [w.lon, w.lat, w.frame === 'AMSL' ? w.alt : w.frame === 'Terrain' ? w.alt + (g[i] ?? 0) : w.alt + homeAlt]);
      if (pts.length > 1) add({ name: 'Rencana misi', polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(pts.flat()), width: 2,
        material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#fbbf24'), dashLength: 12 }) } });
      pts.forEach(([lon, lat, h], i) => add({ name: `WP ${i + 1}`, position: C.Cartesian3.fromDegrees(lon, lat, h),
        point: { pixelSize: 8, color: C.Color.fromCssColorString('#0b1220'), outlineColor: C.Color.fromCssColorString('#fbbf24'), outlineWidth: 2 },
        description: `Waypoint ${i + 1}<br>${h.toFixed(1)} m MSL (${a.plan.wps[i].frame})` }));
      a.plan.surveys.forEach((p) => add({ name: 'Area survei', polygon: { hierarchy: C.Cartesian3.fromDegreesArray(p.flat()),
        material: C.Color.fromCssColorString('#fbbf24').withAlpha(0.15), classificationType: C.ClassificationType.TERRAIN } }));
    }

    const tr = a.track?.filter((p) => Number.isFinite(p.alt));
    if (tr?.length > 1) {
      const pos = tr.map((p) => C.Cartesian3.fromDegrees(p.lon, p.lat, p.alt));
      add({ name: 'Tirai jalur', wall: { positions: pos, minimumHeights: tr.map((p) => p.ground ?? 0), maximumHeights: tr.map((p) => p.alt),
        material: C.Color.fromCssColorString('#22d3ee').withAlpha(0.12), outline: false } });
      add({ name: 'Jejak penerbangan', polyline: { positions: pos, width: 2, material: C.Color.fromCssColorString('#22d3ee').withAlpha(0.45) } });
      const low = tr.filter((p) => p.agl < (a.aglMin ?? 30) && p.agl > 2);
      low.forEach((p) => add({ name: 'AGL di bawah batas', position: C.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
        point: { pixelSize: 6, color: C.Color.fromCssColorString('#f87171') }, description: `AGL ${p.agl.toFixed(1)} m` }));

      const t0 = C.JulianDate.fromDate(new Date(tr[0].t * 1000)), t1 = C.JulianDate.fromDate(new Date(tr.at(-1).t * 1000));
      const sp = new C.SampledPositionProperty();
      tr.forEach((p, i) => sp.addSample(C.JulianDate.fromDate(new Date(p.t * 1000)), pos[i]));
      add({ name: 'Replay drone', availability: new C.TimeIntervalCollection([new C.TimeInterval({ start: t0, stop: t1 })]), position: sp,
        billboard: { image: DRONE_SVG, width: 40, height: 40, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        path: { leadTime: 0, trailTime: 1e6, width: 5, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: C.Color.fromCssColorString('#e879f9') }) } });
      Object.assign(viewer.clock, { startTime: t0.clone(), stopTime: t1.clone(), currentTime: t0.clone(), clockRange: C.ClockRange.LOOP_STOP, multiplier: 10, shouldAnimate: true });
      viewer.timeline.zoomTo(t0, t1);
    }
    if (fly && is3d) viewer.flyTo(archiveEnts, { duration: 1.5 });
  }

  // ---------- laporan banjir ----------
  function drawFloods() {
    if (!floodSrc) { floodSrc = new C.CustomDataSource('banjir'); viewer.dataSources.add(floodSrc); }
    floodSrc.entities.removeAll();
    for (const f of st.floods) {
      const [lon, lat] = f.geometry.coordinates;
      floodSrc.entities.add({ name: `Laporan ${f.properties.type}`, position: C.Cartesian3.fromDegrees(lon, lat),
        point: { pixelSize: 11, color: C.Color.fromCssColorString('#3b82f6'), outlineColor: C.Color.fromCssColorString('#e0f2fe'), outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        description: `${esc(f.properties.created_at)}<br>${esc(f.properties.text)}` });
    }
  }
}
