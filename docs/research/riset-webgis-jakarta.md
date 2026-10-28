# Riset WebGIS Dashboard Jakarta: Data, Tools, Arsitektur & Integrasi Drone

Oct 27, 2026 · @Luthfi Cakrayuda

## Ringkasan eksekutif

Stack inti yang paling realistis untuk Jakarta: **PostGIS + GeoServer/Martin + MapLibre (2D) + CesiumJS (3D)**, diisi oleh pipeline Python terjadwal, dengan jembatan **MAVLink → WebSocket** untuk drone. Semua komponen open source dan bisa berjalan offline di server dinas.

Sumber data prioritas untuk Jakarta:

- **Elevasi:** DEMNAS (BIG, \~8 m, DSM) untuk detail, FABDEM atau DeltaDTM (30 m, bare-earth) untuk terrain tanpa bangunan, dikoreksi ke INAGEOID2020.
- **Bangunan:** Overture Maps (gabungan OSM + Google + Microsoft + Esri) sebagai footprint utama; Google Open Buildings 2.5D Temporal untuk estimasi tinggi dan perubahan 2016–2023.
- **Citra:** Sentinel-2 (10 m, \~5 hari) dan Sentinel-1 SAR (tembus awan) sebagai sumber pembaruan rutin; ortofoto drone sendiri sebagai sumber paling aktual.
- **Data pemda:** Jakarta Satu (peta dasar tunggal DKI, RDTR, aset), Satu Data Jakarta, dan Pantau Banjir.
- **Dinamis:** PetaBencana.id API (laporan banjir urun-daya, tinggi muka air), produk InSAR penurunan tanah, Dynamic World untuk perubahan lahan.

Tiga catatan kritis: (1) DEMNAS dan Copernicus DEM adalah DSM, jadi di Jakarta nilainya ikut tinggi bangunan; (2) Jakarta turun beberapa cm per tahun, sehingga DEM lama bias secara sistematis; (3) ketinggian dari QGroundControl biasanya relatif terhadap titik home atau MSL versi EGM96, bukan INAGEOID2020, sehingga perlu konversi sebelum dibandingkan.

## 1. Sumber data geospasial

Untuk Jakarta, kombinasi terbaik adalah data nasional/pemda sebagai acuan resmi dan data global sebagai pengisi serta sumber pembaruan. Kolom “Sulit” = tingkat kesulitan integrasi (R = rendah, S = sedang, T = tinggi). Angka yang tidak terverifikasi langsung ditandai “±”.

### 1a. Elevasi, topografi, batimetri

| Sumber | Jenis | Resolusi | Pembaruan / terbaru | Cakupan | Format | Lisensi | Akses | Sulit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [DEMNAS – BIG](https://cdn.theconversation.com/static_files/files/4029/Cara_mengakses_data_DEMNAS.pdf) | DSM campuran (IFSAR, TerraSAR-X, ALOS) | [8,25 m, datum vertikal EGM2008](https://etd.repository.ugm.ac.id/penelitian/detail/191096) | Statis, tidak rutin | Indonesia | GeoTIFF | Terbuka pemerintah (wajib atribusi BIG) | Unduh per tile setelah registrasi di tanahair.indonesia.go.id; plugin QGIS [BIG Downloader](https://plugins.qgis.org/plugins/tags/big/) | R |
| Kontur & spot height RBI – BIG | Vektor kontur | Skala 1:25.000 (Jakarta ada skala lebih besar) | Bertahap | Indonesia | SHP/GDB | Terbuka pemerintah | Ina-Geoportal, BIG Downloader | R |
| BATNAS – BIG | Batimetri | ±6 arcsec (±180 m) | Statis | Perairan Indonesia | GeoTIFF | Terbuka pemerintah | Ina-Geoportal, BIG Downloader | R |
| Copernicus DEM GLO-30 | DSM (TanDEM-X) | 30 m | Statis (akuisisi 2011–2015) | Global | COG | Bebas, atribusi | AWS Open Data, Copernicus Data Space, OpenTopography | R |
| [FABDEM](https://meetingorganizer.copernicus.org/EGU22/EGU22-8994.html) | DTM (bangunan & pohon dihapus ML) | 30 m | Statis | Global 60°S–80°N | GeoTIFF | CC BY-NC-SA (non-komersial) | Unduh University of Bristol | R |
| [DeltaDTM v1.1](https://gee-community-catalog.org/projects/delta_dtm) | DTM pesisir (Copernicus + ICESat-2 + GEDI) | 30 m, MAE 0,43 m | Rilis Des 2024 | Pesisir global < 30 m MSL | GeoTIFF | CC BY 4.0 | [4TU.ResearchData](https://data.4tu.nl/datasets/1da2e70f-6c4d-4b03-86bd-b53e789cc629), GEE community catalog | R |
| FathomDEM | DTM bare-earth | 30 m | 2024–2025 | Global | GeoTIFF | Cek lisensi (riset) | Fathom | S |
| NASADEM / SRTM | DSM | 30 m | Statis (2000) | Global | HGT/GeoTIFF | Domain publik | NASA Earthdata, OpenTopography | R |
| ALOS AW3D30 | DSM optik | 30 m | Pembaruan versi berkala | Global | GeoTIFF | Gratis (registrasi JAXA) | JAXA EORC | R |
| ICESat-2 ATL08 / GEDI | Titik lidar satelit (terrain & kanopi) | Titik \~20 m sepanjang lintasan | Berkelanjutan | Global | HDF5 | Domain publik | NASA Earthdata, SlideRule | T |
| GEBCO | Batimetri global | 15 arcsec | Tahunan | Global | NetCDF/GeoTIFF | Domain publik | gebco.net | R |

### 1b. Bangunan (footprint, tinggi, 3D)

| Sumber | Jenis | Resolusi / akurasi | Pembaruan | Format | Lisensi | Akses | Sulit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Overture Maps – buildings](https://docs.overturemaps.org/guides/buildings) | Footprint gabungan OSM, Esri, Google, Microsoft; atribut `height`, `min_height` | Footprint poligon; tinggi hanya sebagian bangunan | Rilis bulanan | GeoParquet | ODbL | S3/Azure + DuckDB, CLI `overturemaps` | S |
| OpenStreetMap | Footprint + tag `building:levels`, `height` | Bervariasi; Jakarta cukup lengkap di pusat kota | Real-time (diff harian Geofabrik) | PBF, Overpass API | ODbL | Geofabrik, Overpass, planet | S |
| Google Open Buildings v3 | Footprint ML dari citra 50 cm | Poligon + skor kepercayaan | 2023 | CSV/GeoJSON | CC BY 4.0 / ODbL | GCS, Earth Engine | R |
| [Google Open Buildings 2.5D Temporal](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1?hl=en) | Raster keberadaan, jumlah, dan tinggi bangunan per tahun | Efektif 4 m, tinggi 0–100 m relatif terrain | Tahunan 2016–2023 | Raster (Earth Engine, GCS) | CC BY 4.0 | Earth Engine, GCS | S |
| Microsoft Global ML Building Footprints | Footprint ML | Poligon | Pembaruan tidak tetap | GeoJSONL | ODbL | GitHub/Azure | R |
| GHSL Built-Height | Tinggi rata-rata bangunan | 100 m (tahun 2018) | Rilis berkala | GeoTIFF | CC BY 4.0 | JRC GHSL | R |
| DLR World Settlement Footprint 3D | Tinggi & volume bangunan | 90 m | Statis | GeoTIFF | Cek lisensi DLR | geoservice.dlr.de | S |
| Jakarta Satu (DCKTRP) | Peta dasar tunggal skala besar, bangunan, persil, RDTR | Skala besar (1:1.000–1:5.000) | Diperbarui pemda | Layanan ArcGIS/OGC (cek katalog) | Sesuai ketentuan Pemprov | [jakartasatu.jakarta.go.id](https://esriindonesia.co.id/news/jakarta-satu-program-international-benchmark-smart-cities) | S |

Model 3D LOD2 terbuka untuk Jakarta belum ada. Jalur praktis: ekstrusi LOD1 dari footprint Overture/OSM dengan tinggi dari OSM, Open Buildings 2.5D, atau nDSM (DEMNAS dikurangi DTM), lalu dikonversi ke 3D Tiles.

### 1c. Citra satelit dan foto udara

| Sumber | Jenis | Resolusi | Revisit / terbaru | Format | Lisensi | Akses | Sulit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sentinel-2 (ESA Copernicus) | Optik multispektral 13 band | 10/20/60 m | ±5 hari | JP2/COG (L2A) | Bebas, atribusi | Copernicus Data Space (STAC, openEO, WMTS), AWS Element84 STAC, Earth Engine | R |
| Landsat 8/9 (USGS) | Optik + termal | 30 m (pan 15 m) | ±8 hari gabungan | COG | Domain publik | USGS EarthExplorer, AWS, Microsoft Planetary Computer STAC | R |
| Sentinel-1 | SAR C-band (tembus awan) | ±10 m (IW GRD) | 6–12 hari | SAFE/COG | Bebas | Copernicus Data Space, ASF Vertex | S |
| [Planet NICFI basemap](https://developers.google.com/earth-engine/datasets/catalog/projects_planet-nicfi_assets_basemaps_asia?hl=ko) | Mosaik optik bulanan | ±4,8 m | Arsip Des 2015 – awal 2026; kelanjutan tidak pasti | GeoTIFF, tile | Non-komersial, terbatas tujuan NICFI | Registrasi Planet, Earth Engine | S |
| ALOS-2 PALSAR-2 mosaic (JAXA) | SAR L-band | 25 m | Tahunan | GeoTIFF | Gratis | JAXA, Earth Engine | S |
| Umbra / Capella Open Data | SAR resolusi sangat tinggi (sampel) | < 1 m | Tidak rutin, lokasi terbatas | GeoTIFF/SICD | CC BY 4.0 | AWS Open Data (cek apakah ada Jakarta) | T |
| Maxar Open Data | Optik sangat tinggi | ±30–50 cm | Hanya saat bencana besar | COG | CC BY-NC | AWS STAC | S |
| Esri World Imagery / Bing | Basemap optik tinggi | Sub-meter | Tanggal bervariasi per lokasi | Tile XYZ | Proprietary (tampilan saja; Bing boleh untuk tracing OSM) | Tile service | R |
| Ortofoto drone sendiri | Optik sangat tinggi | 2–10 cm | Sesuai jadwal terbang | GeoTIFF/COG | Milik sendiri | Pipeline ODM | S |

### 1d. Tutupan lahan, jalan, sungai, batas administrasi

| Sumber | Jenis | Resolusi | Pembaruan | Format | Lisensi | Akses | Sulit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [ESA WorldCover](https://docs.terrabyte.lrz.de/datasets/esaworldcover/) | Tutupan lahan 11 kelas | 10 m, akurasi ±76,7% (2021) | 2020 dan 2021 saja | COG | CC BY 4.0 | ESA viewer, Copernicus openEO, AWS | R |
| [Dynamic World](https://atlas.co/data-sources/dynamic-world/) | Probabilitas 9 kelas per citra Sentinel-2 | 10 m | Setiap lintasan (2–5 hari) | Earth Engine | CC BY 4.0 | Earth Engine | S |
| Esri/Impact Observatory LULC | Tutupan lahan tahunan 9 kelas | 10 m | Tahunan | COG | CC BY 4.0 | Planetary Computer | R |
| KLHK – Penutupan Lahan | Tutupan lahan resmi nasional | 1:250.000 | Tahunan | SHP / WMS | Terbuka pemerintah | SIGAP KLHK | R |
| OSM / Overture Transportation | Jaringan jalan, rel, sungai, kanal | Vektor | Real-time / bulanan | PBF/GeoParquet | ODbL | Geofabrik, Overture | R |
| RBI – BIG | Jalan, hidrografi, toponimi | 1:25.000 | Bertahap | SHP | Terbuka pemerintah | Ina-Geoportal | R |
| Batas wilayah – BIG/Kemendagri | Batas resmi sampai desa/kelurahan | Vektor | Mengikuti regulasi | SHP | Terbuka pemerintah | BIG Downloader, Ina-Geoportal | R |
| BPS Wilkerstat (sig.bps.go.id) | Batas statistik desa/SLS | Vektor | Per sensus | SHP/WMS | Terbuka pemerintah | sig.bps.go.id | R |
| geoBoundaries / GADM | Batas administrasi global | Vektor | Berkala | SHP/GeoJSON | geoBoundaries CC BY; GADM non-komersial | Unduh | R |
| Jakarta Satu | RT/RW, zonasi RDTR, aset, persil | Skala besar | Diperbarui pemda | Layanan peta (cek katalog) | Ketentuan Pemprov | jakartasatu.jakarta.go.id | S |
| Dinas SDA DKI / Satu Data Jakarta | Saluran, pompa, pintu air, waduk | Vektor/tabel | Bervariasi | CSV/SHP | Terbuka pemda | data.jakarta.go.id | S |

### 1e. Data dinamis dan crowdsourced

| Sumber | Jenis | Resolusi | Pembaruan | Format / akses | Lisensi | Sulit |
| --- | --- | --- | --- | --- | --- | --- |
| [PetaBencana.id API](https://docs.petabencana.id/routes) | Laporan banjir urun-daya, genangan, alat ukur tinggi muka air, arsip & time series | Titik/poligon RW | Real-time | REST GeoJSON/TopoJSON (`/floods`, `/reports`, `/floodgauges`) | Terbuka (cek ketentuan) | R |
| [Pantau Banjir Jakarta](https://www.beritajakarta.id/en/read/38673/potret-jakarta) | Genangan berbasis RT, rekap lintas tahun | RT | Saat kejadian | Web/app; rekap di data.jakarta.go.id | Terbuka pemda | S |
| Satu Data Jakarta | Rekap kejadian banjir per RW, TMA, dll. | Tabel per wilayah | Bulanan/tahunan | CSV, API CKAN | Terbuka pemda | R |
| BMKG | Prakiraan cuaca per kelurahan, gempa, radar hujan | Kelurahan | Harian / real-time | API JSON (data.bmkg.go.id) | Terbuka (atribusi BMKG) | R |
| InaRISK – BNPB | Indeks bahaya & risiko banjir | Grid | Berkala | WMS/ArcGIS REST | Terbuka pemerintah | R |
| Penurunan tanah – produk riset | Kecepatan vertikal InSAR | [Contoh: TU Delft 2014–2025, hingga −7,7 cm/th](https://research.tudelft.nl/en/publications/land-subsidence-in-jakarta-in-three-dimensions-2014-2025-using-in/) | Per publikasi | Data pendamping artikel | Bervariasi | S |
| Penurunan tanah – olah sendiri | Sentinel-1 InSAR (SBAS/PSI) | ±20–100 m | Tiap akuisisi 6–12 hari | ASF HyP3 (on-demand gratis), COMET-LiCSAR/LiCSBAS, ESA SNAP + StaMPS, MintPy | Bebas | T |
| Copernicus EMS / Sentinel-1 flood mapping | Peta genangan dari SAR | 10–20 m | Saat aktivasi / tiap lintasan | Vektor/raster | Bebas | S |
| JRC Global Surface Water | Riwayat air permukaan | 30 m | 1984–sekarang, tahunan | Earth Engine/GeoTIFF | Bebas | R |
| OSM changesets, Mapillary, KartaView | Perubahan peta & foto jalanan urun-daya | Titik/foto | Real-time | API | ODbL / CC BY-SA | S |

## 2. Akurasi dan kemutakhiran

Yang paling dekat dengan kondisi lapangan hari ini adalah survei drone sendiri, disusul citra Sentinel terbaru dan laporan urun-daya; data statis (DEM, footprint ML) akurat secara geometri tetapi sudah “tua”.

| Peringkat kedekatan dengan kondisi aktual | Sumber | Mengapa | Keterbatasan utama |
| --- | --- | --- | --- |
| 1 | Ortofoto, DSM, model 3D dari drone sendiri | Resolusi cm, tanggal Anda tentukan | Cakupan kecil, butuh GCP/RTK agar akurat absolut, izin terbang di Jakarta (zona bandara Halim/Soekarno-Hatta, objek vital) |
| 2 | Sentinel-2 / Sentinel-1 terbaru, Dynamic World | Diperbarui tiap beberapa hari | 10 m tidak cukup untuk bangunan individual; Sentinel-2 sering tertutup awan di musim hujan (gunakan Sentinel-1) |
| 3 | PetaBencana, Pantau Banjir, BMKG | Real-time | Laporan urun-daya bias ke area padat pengguna; perlu filter waktu dan verifikasi |
| 4 | OSM / Overture (rilis bulanan) | Diperbarui terus oleh komunitas dan ML | Kelengkapan tidak merata; tinggi bangunan sering kosong |
| 5 | Jakarta Satu, RBI, batas BIG | Resmi dan skala besar | Siklus pembaruan lambat; akses layanan bisa berubah |
| 6 | Open Buildings 2.5D (2016–2023) | Tren perubahan tahunan | [Tinggi relatif dan tidak stabil antartahun](https://sites.research.google/gr/open-buildings/temporal); berhenti di 2023 |
| 7 | DEMNAS, Copernicus DEM, FABDEM, DeltaDTM | Geometri terrain terbaik yang tersedia gratis | Akuisisi bertahun-tahun lalu; DSM memuat bangunan; Jakarta turun beberapa cm/tahun |

**Catatan khusus elevasi Jakarta.** Studi InSAR menunjukkan [mangkuk penurunan tanah hingga −7,7 cm/tahun dengan latar regional sekitar −1,1 cm/tahun (2014–2025)](https://research.tudelft.nl/en/publications/land-subsidence-in-jakarta-in-three-dimensions-2014-2025-using-in/), dan studi lain menemukan [pesisir Jakarta Utara masih turun secara linear](https://ir.lib.ugm.ac.id/id/eprint/12554/). Artinya DEM berumur 10 tahun bisa meleset puluhan cm di utara. Untuk analisis bare-earth, [FABDEM menurunkan galat absolut di kawasan terbangun dari 1,61 m menjadi 1,12 m dibanding Copernicus DEM](https://meetingorganizer.copernicus.org/EGU22/EGU22-8994.html), dan [DeltaDTM mencapai MAE 0,43 m di dataran pesisir rendah](https://gee-community-catalog.org/projects/delta_dtm).

### Metode validasi dan pembaruan

1. **Samakan referensi dulu.** Konversi semua data ke SRGI2013 (horizontal) dan INAGEOID2020 v2 (vertikal). Geoid ini memiliki [akurasi internal 0,05–0,3 m di pulau besar](https://epsg.io/10144) dan menjadi [acuan vertikal nasional resmi](https://srgi.big.go.id/page/geoid-model). DEMNAS memakai EGM2008, GPS drone biasanya EGM96 atau elipsoid.
2. **Validasi silang antar-sumber.** Bandingkan DEMNAS vs Copernicus vs FABDEM vs DeltaDTM terhadap titik kontrol (BM BIG, titik ICESat-2 ATL08, survei GNSS RTK sendiri). Hitung ME, RMSE, dan sebarannya per tutupan lahan.
3. **Koreksi temporal penurunan tanah.** Elevasi saat ini ≈ elevasi DEM + (laju InSAR × tahun berlalu sejak akuisisi DEM). Simpan sebagai layer terpisah, bukan menimpa DEM asli.
4. **Konflasi bangunan.** Gabungkan footprint OSM/Overture dengan atribut tinggi dari beberapa sumber; simpan sumber dan tingkat kepercayaan per atribut (kolom `height_src`, `height_conf`).
5. **Deteksi perubahan otomatis.** Tren Dynamic World (built-up/air), selisih indeks Sentinel-2, amplitudo/koherensi Sentinel-1, dan perbandingan tahunan Open Buildings 2.5D untuk menandai area kandidat berubah.
6. **Verifikasi lapangan terarah.** Area kandidat dari langkah 5 menjadi target terbang drone atau survei QField/ODK Collect. Hasilnya memperbarui database dan menjadi data latih/validasi.
7. **Metadata dan versi.** Catat tanggal akuisisi, datum, dan lisensi per layer (STAC atau tabel metadata PostGIS) agar dashboard bisa menampilkan “umur data” di setiap layer.

## 3. Perangkat lunak dan integrasi

Seluruh alur kerja bisa ditutup dengan perangkat lunak open source; pilihan default yang dicetak tebal adalah yang paling mudah dirawat tim kecil.

| Tahap | Tools | Kelebihan | Kekurangan | Sulit |
| --- | --- | --- | --- | --- |
| Akuisisi & otomatisasi | **Python** (`pystac-client`, `requests`, `overturemaps`, `osmium`, `earthaccess`, `openeo`), **Prefect** atau cron; Apache Airflow untuk skala besar; plugin QGIS BIG Downloader | STAC membuat pencarian Sentinel/Landsat seragam; Prefect ringan dengan UI pemantauan | Portal pemerintah (DEMNAS, Jakarta Satu) kadang butuh login/scraping manual | R–S |
| Pengolahan raster & vektor | **GDAL/OGR**, **QGIS** (+ Processing), rasterio, GeoPandas, Shapely, WhiteboxTools, GRASS GIS, SAGA, Orfeo ToolBox | Standar industri; QGIS untuk QA visual | Butuh disiplin CRS dan datum | S |
| Pengolahan SAR / InSAR | ESA SNAP, ISCE2, MintPy, StaMPS, ASF HyP3, LiCSBAS | Gratis, hasil setara riset | Kurva belajar tinggi; komputasi berat | T |
| Analisis cloud (opsional) | Google Earth Engine (gratis non-komersial/riset), openEO Copernicus, Microsoft Planetary Computer | Tanpa unduh data besar | Ketergantungan layanan luar; tidak cocok untuk data rahasia | S |
| Point cloud & 3D | PDAL, CloudCompare, Potree, py3dtiles, Obj2Tiles | Konversi ke 3D Tiles untuk web | Volume data besar | S |
| Database spasial | **PostgreSQL + PostGIS** (vektor & raster), **TimescaleDB** untuk telemetri, pgstac (katalog STAC), DuckDB-spatial + GeoParquet untuk analitik, MinIO untuk file COG/3D Tiles | PostGIS = standar de facto; Timescale efisien untuk deret waktu drone | PostGIS raster kurang cepat untuk raster besar (simpan sebagai COG di object storage) | S |
| Server peta | **GeoServer** (WMS/WFS/WMTS/WCS), **Martin** atau pg\_tileserv (vector tiles dari PostGIS), **TiTiler** (COG dinamis), MapServer, QGIS Server, PMTiles (tile statis satu file) | Mencakup standar OGC dan vector tiles modern | GeoServer berat (Java) tetapi lengkap | S |
| Peta web 2D | **MapLibre GL JS**, OpenLayers (terkuat untuk OGC/proyeksi), Leaflet (paling sederhana) | MapLibre cepat, vector tiles, terrain 3D ringan | OpenLayers lebih verbose | R–S |
| Peta web 3D | **CesiumJS** (globe, terrain, 3D Tiles, CZML time-dynamic), deck.gl (visualisasi data besar, bisa di atas MapLibre), iTowns, three.js | Cesium paling cocok untuk jalur terbang 3D vs bangunan | Cesium ion (hosting) berbayar; gunakan terrain & tiles self-hosted (Cesium Terrain Builder / quantized-mesh) | S–T |
| Dashboard terpadu | **Aplikasi web sendiri** (React/Vue/Svelte + MapLibre/Cesium), Grafana (panel Geomap + telemetri real-time), Apache Superset, Kepler.gl, TerriaJS, GeoNode/MapStore, Streamlit/leafmap (prototipe) | Aplikasi sendiri paling fleksibel; Grafana cepat untuk telemetri | Superset/Grafana terbatas untuk interaksi peta kompleks | S–T |
| Survei lapangan | QField, ODK Collect / KoboToolbox, Mergin Maps | Sinkron langsung ke PostGIS/QGIS | Perlu manajemen perangkat | R |

### Posisi pengguna real-time dari laptop

| Opsi | Cara kerja | Akurasi tipikal | Kelebihan | Kekurangan | Sulit |
| --- | --- | --- | --- | --- | --- |
| Browser Geolocation API (`navigator.geolocation.watchPosition`) | Browser memakai Wi-Fi/IP (laptop umumnya tanpa chip GPS) | Puluhan hingga ratusan meter | Tanpa perangkat tambahan; MapLibre `GeolocateControl` sudah jadi | Butuh HTTPS atau localhost; tidak akurat di laptop; kurang andal offline | R |
| Receiver GNSS USB (mis. u-blox) + **Web Serial API** | Browser Chromium membaca NMEA langsung dari port serial | 1–3 m | Tanpa server tambahan | Hanya Chrome/Edge; perlu izin pengguna per sesi | S |
| Receiver GNSS USB + **gpsd** + jembatan WebSocket | gpsd membaca NMEA, skrip Python meneruskan JSON ke dashboard | 1–3 m | Stabil, bisa dibagi ke banyak klien | Komponen tambahan di laptop | S |
| GNSS RTK + NTRIP (RTKLIB/str2str, CORS InaCORS BIG) | Koreksi RTK dari base/CORS | 1–5 cm | Akurasi survei | Butuh receiver RTK dan akun koreksi | T |

Di dashboard, posisi ditampilkan sebagai titik + lingkaran akurasi, dengan mode “ikuti lokasi” (kamera peta mengunci ke posisi dan arah gerak) yang bisa dimatikan saat pengguna menggeser peta.

## 4. Arsitektur sistem

Semua alternatif memakai pola lapisan yang sama; yang berbeda hanya seberapa banyak lapisan dijalankan sebagai layanan terpisah. Untuk tim kecil di lingkungan dinas, **Arsitektur B naik bertahap ke C** adalah titik tengah terbaik.

&#91;embedded content: arsitektur berlapis · 5 lapisan, jalur drone live di kolom kanan\]

Data mengalir dari atas ke bawah; jalur drone live melewati bridge, TimescaleDB, dan WebSocket sehingga latensinya sekitar satu detik, sedangkan layer lain diperbarui oleh job terjadwal.

| Alternatif | Komponen | Pembaruan otomatis | Kelebihan | Kekurangan | Sulit |
| --- | --- | --- | --- | --- | --- |
| A. Statis / serverless | PMTiles + COG di folder web atau Nginx, MapLibre + CesiumJS, skrip Python via cron yang membangun ulang file | Batch (harian/mingguan) | Sangat murah, bisa offline penuh di satu laptop, minim perawatan | Tanpa query spasial di server; live drone hanya via WebSocket lokal | R |
| B. Klasik monolit (Docker Compose) | PostGIS + Martin/GeoServer + TiTiler + frontend; ETL Prefect; FastAPI untuk API | Terjadwal per sumber | Query spasial lengkap, standar OGC untuk QGIS/aplikasi lain, satu server cukup | Skala terbatas satu mesin | S |
| C. Real-time + drone | B + jembatan MAVLink (pymavlink/mavlink2rest) + TimescaleDB + WebSocket/MQTT (Mosquitto) + NodeODM untuk fotogrametri | Terjadwal + streaming | Posisi drone dan pengguna live, replay, komparasi otomatis | Lebih banyak layanan dan pemantauan | S–T |
| D. Skala lanjut | Kubernetes, Airflow, Kafka/Redpanda, pgstac + stac-fastapi, ClusterODM, object storage MinIO, Cesium 3D Tiles se-Jakarta, Keycloak, Prometheus/Grafana | Event-driven + terjadwal | Multi-pengguna, multi-drone, ketersediaan tinggi | Butuh tim DevOps; berlebihan untuk tahap awal | T |

Fitur dashboard yang sama di semua alternatif: panel layer dengan tanggal data, koordinat kursor (lat/lon desimal, DMS, UTM 48S, MGRS), mode ikuti lokasi, swipe/split view untuk komparasi, profil elevasi, dan menu Drone (live, arsip, komparasi).

## 5. Integrasi data drone (QGroundControl)

Menu “Drone” di dashboard sebaiknya punya dua jalur: **live** (MAVLink diteruskan dari QGC atau langsung dari telemetri radio) dan **arsip** (unggah .tlog/.ulg/.BIN/.plan/foto untuk diproses dan dibandingkan).

### 5a. Jenis data dan cara mengambilnya

| Data | Format | Asal | Cara ekspor / alir | Isi yang berguna |
| --- | --- | --- | --- | --- |
| Telemetry log | `.tlog` (MAVLink mentah bertimestamp) | Disimpan QGC di GCS | Otomatis bila “Save log after each flight” aktif; parse dengan `pymavlink`/`mavlogdump.py` | Semua pesan: posisi, attitude, baterai, mode, status misi |
| [CSV telemetri](https://docs.qgroundcontrol.com/master/en/qgc-user-guide/settings_view/csv.html) | `.csv` 1 Hz | QGC | Centang CSV Logging di Settings; dibuat bersamaan dengan .tlog | Posisi GPS, attitude, baterai — paling mudah diimpor |
| Log flight controller | PX4 `.ulg`, ArduPilot `.BIN` | Kartu SD autopilot | [QGC → Analyze Tools → Log Download](https://iqmotion.readthedocs.io/en/latest/tutorials/extracting_log_qgroundcontrol.html); parse `pyulog` / `pymavlink` | Data frekuensi tinggi, EKF, GPS mentah (termasuk tinggi elipsoid), event kamera |
| Rencana misi | `.plan` (JSON), juga ekspor KML | QGC Plan View | File → Save / Save as KML | Waypoint, Survey/Corridor Scan polygon, ketinggian & frame-nya (relatif/AMSL/terrain), rally point, geofence |
| Foto bergeotag | JPEG + EXIF/XMP | Kamera drone | QGC Analyze → GeoTag Images (pakai log) bila kamera tidak menulis GPS | Bahan ortofoto, DSM, model 3D |
| Stream real-time | MAVLink v2 via UDP/TCP/serial | Vehicle atau QGC | QGC Settings → MAVLink → MAVLink forwarding ke host lain, atau `mavlink-router` / MAVProxy membagi stream sebelum QGC | `GLOBAL_POSITION_INT` (lat/lon, `alt` MSL, `relative_alt`), `GPS_RAW_INT` (fix, HDOP, `alt_ellipsoid`), `ATTITUDE`, `VFR_HUD`, `HOME_POSITION`, `MISSION_CURRENT`, `BATTERY_STATUS` |

**Contoh alur live (paling sederhana).** QGC meneruskan MAVLink ke server dashboard; skrip Python mengubahnya menjadi JSON lewat WebSocket dan menyimpannya ke TimescaleDB (\`mav\_bridge.py\` di bawah adalah skrip yang ditulis sendiri, sekitar 50–100 baris).

Dijalankan di **terminal server dashboard (WSL Ubuntu atau Linux, di folder proyek, virtualenv aktif)**:

```bash
pip install pymavlink websockets psycopg[binary]
python mav_bridge.py --listen udpin:0.0.0.0:14551 --ws 0.0.0.0:8765
```

Di QGC (laptop GCS): aktifkan MAVLink forwarding ke `IP_SERVER:14551`. Alternatif tanpa menulis kode: **mavlink2rest** (REST + WebSocket JSON siap pakai) atau MAVSDK; untuk ekosistem ROS 2 gunakan MAVROS + rosbridge.

### 5b. Menampilkan di peta

- **2D (MapLibre):** posisi live sebagai ikon pesawat berputar sesuai heading; jalur sebagai `LineString` dengan gradasi warna menurut ketinggian atau kecepatan; misi dari `.plan` sebagai garis putus-putus + poligon survei.
- **3D (CesiumJS):** jalur 3D di atas terrain dan bangunan 3D Tiles; arsip penerbangan diputar ulang sebagai **CZML** dengan slider waktu; kerucut/footprint kamera dari attitude + FOV.
- **Layer drone hasil proses:** ortofoto (COG via TiTiler), DSM/DTM (hillshade + color ramp), model 3D (3D Tiles), point cloud (Potree/3D Tiles).
- **Panel samping:** grafik ketinggian vs jarak (profil) dengan garis terrain, atap bangunan, dan batas ketinggian; tabel event (mode, baterai, kehilangan link).

### 5c. Metode komparasi

| Komparasi | Metode | Output di dashboard | Sulit |
| --- | --- | --- | --- |
| Ketinggian terbang vs terrain | Ubah alt drone ke referensi yang sama, ambil elevasi DTM (FABDEM/DeltaDTM/DTM drone) di tiap titik (`ST_Value` di PostGIS atau rasterio), hitung AGL = alt − terrain | Profil AGL, segmen merah bila di bawah ambang | S |
| Ketinggian vs bangunan | Clearance = alt − (terrain + tinggi bangunan) dengan buffer horizontal sesuai galat GPS; sumber tinggi: OSM/Overture, Open Buildings 2.5D, atau nDSM | Titik konflik dan jarak aman minimum per misi | S |
| Rencana vs aktual | Bandingkan jalur `.plan` dengan jejak log: deviasi lateral, deviasi ketinggian, cakupan overlap foto | Heatmap deviasi, persentase cakupan survei | S |
| Ortofoto drone vs citra satelit | Ko-registrasi (GCP atau otomatis, mis. AROSICS), lalu selisih visual (swipe/split view), indeks spektral, atau deteksi objek | Peta perubahan dan slider pembanding | S–T |
| DSM drone vs DEMNAS/Copernicus | Samakan datum dan resolusi, hitung selisih (DoD); di Jakarta selisih bisa mengandung bangunan baru dan penurunan tanah | Raster selisih + statistik per zona | S |
| Point cloud antarwaktu | CloudCompare M3C2 atau PDAL untuk perubahan 3D | Peta perubahan volume | T |
| Drone vs footprint bangunan | Digitasi/segmentasi bangunan dari ortofoto (mis. model ML), bandingkan dengan Overture/OSM | Bangunan baru, hilang, berubah | T |

### 5d. Tools pengolahan foto drone

| Tool | Output | Catatan | Sulit |
| --- | --- | --- | --- |
| [OpenDroneMap (ODM) 3.6.x](https://en.wikipedia.org/wiki/OpenDroneMap) + NodeODM/ClusterODM | Ortofoto, DSM, DTM, point cloud, mesh, 3D Tiles | Mesin CLI/Docker, cocok diotomasi | S |
| WebODM (kini memakai engine ODX) | Sama, via antarmuka web dan API | [Sejak 6 April 2026 berpisah dari OpenDroneMap](https://www.skyebrowse.com/news/posts/webodm-vs-opendronemap); periksa kompatibilitas plugin/API sebelum memilih | R–S |
| MicMac (IGN) | Fotogrametri presisi tinggi | Kuat untuk survei akurat, kurva belajar tinggi | T |
| COLMAP + OpenMVS, Meshroom | Rekonstruksi 3D/mesh | Bagus untuk model objek/bangunan | S–T |
| PDAL, CloudCompare, Potree, Obj2Tiles | Olah dan sajikan point cloud/mesh | Konversi ke format web | S |

### 5e. Pertimbangan akurasi

- **Datum horizontal.** GPS drone memakai WGS84 (realisasi terkini), sedangkan data BIG memakai SRGI2013 (dinamis, terikat ITRF). Selisihnya kecil untuk tampilan tetapi bisa orde desimeter untuk analisis presisi; gunakan transformasi PROJ resmi.
- **Datum vertikal — sumber kesalahan terbesar.** `relative_alt` mengacu titik home; `alt` di `GLOBAL_POSITION_INT` umumnya MSL versi geoid EGM96 dari receiver; `alt_ellipsoid` adalah tinggi elipsoid; DEMNAS memakai EGM2008; acuan nasional INAGEOID2020. Konversi semuanya ke satu sistem (disarankan INAGEOID2020 v2, [file grid INAGEOID2020v2.gtx tersedia via PROJ/EPSG](https://epsg.io/10144)).
- **Barometer dan GPS.** Ketinggian autopilot berbasis barometer melayang seiring cuaca; GNSS tunggal ±2–5 m horizontal dan lebih buruk vertikal. Untuk survei, gunakan RTK/PPK atau minimal 5–10 GCP terukur GNSS geodetik.
- **Sinkronisasi waktu.** Samakan jam log, foto, dan server (UTC); geotag yang meleset 1 detik pada 15 m/s = 15 m kesalahan.
- **Kalibrasi kamera dan rolling shutter.** Aktifkan koreksi rolling shutter di ODM, gunakan profil kamera, dan pola terbang dengan overlap 75–80%.
- **Umur data pembanding.** DEM satelit di Jakarta harus dikoreksi penurunan tanah sebelum dibandingkan dengan DSM drone, agar selisih tidak disalahartikan sebagai perubahan bangunan.

## 6. Roadmap implementasi, lisensi, dan keamanan

Mulai dari Arsitektur A atau B dengan data statis Jakarta, lalu tambahkan telemetri live dan pipeline drone; InSAR dan 3D penuh dikerjakan terakhir karena paling berat.

1. **Fondasi (2–4 minggu):** Docker Compose berisi PostGIS + Martin + MapLibre; muat batas BIG, Overture buildings & transportation, DEMNAS, FABDEM/DeltaDTM, WorldCover; tetapkan CRS (SRGI2013) dan datum vertikal (INAGEOID2020 v2).
2. **Pembaruan otomatis (2–3 minggu):** job Prefect harian/mingguan: PetaBencana, BMKG, rilis Overture bulanan, diff OSM, pencarian STAC Sentinel-2/1 terbaru → COG → TiTiler.
3. **Menu drone live (2–3 minggu):** jembatan MAVLink → WebSocket, tabel TimescaleDB, ikon live + mode ikuti, posisi laptop (Geolocation API dulu, GNSS USB kemudian).
4. **Arsip & komparasi (3–4 minggu):** unggah .tlog/.ulg/.plan, profil AGL dan clearance bangunan, replay CZML di CesiumJS.
5. **Fotogrametri (2–4 minggu):** NodeODM/ODM di server GPU, hasil COG + 3D Tiles otomatis masuk katalog STAC, swipe vs satelit, selisih DSM.
6. **Lanjutan:** InSAR (HyP3/MintPy) untuk peta penurunan tanah sendiri, deteksi perubahan ML, LOD1 3D Tiles seluruh Jakarta.

### Lisensi yang perlu diperhatikan

| Lisensi | Berlaku untuk | Implikasi |
| --- | --- | --- |
| ODbL (share-alike database) | OSM, Overture buildings/transportation, Microsoft footprints | Database turunan yang dibagikan harus ODbL; peta/tampilan cukup atribusi |
| CC BY 4.0 | Google Open Buildings, WorldCover, Dynamic World, DeltaDTM, GHSL | Bebas dipakai dengan atribusi |
| Non-komersial | FABDEM (CC BY-NC-SA), Planet NICFI, GADM, Maxar Open Data (CC BY-NC) | Aman untuk riset/dinas non-komersial; hindari untuk produk komersial |
| Copernicus / USGS / NASA | Sentinel, Copernicus DEM, Landsat, SRTM | Bebas, atribusi |
| Data pemerintah Indonesia | DEMNAS, RBI, batas, Jakarta Satu, BMKG | Atribusi instansi; ikuti ketentuan masing-masing portal |
| Proprietary | Esri World Imagery, Bing, Google basemap | Tampilan sesuai ToS; jangan unduh massal atau dijadikan dataset turunan |

### Keamanan untuk penggunaan dinas

- Telemetri dan foto drone dinas sebaiknya tidak diproses di layanan cloud publik (Earth Engine, WebODM Lightning, Cesium ion); jalankan seluruh pipeline di server internal.
- Siapkan mode **offline**: basemap PMTiles lokal, terrain quantized-mesh lokal, tanpa CDN eksternal.
- Gunakan autentikasi (Keycloak atau reverse proxy dengan SSO), HTTPS internal, dan pisahkan layer publik dari layer terbatas.

### Sumber

Diakses 27 Oktober 2026; halaman dibuka melalui hasil pencarian.

- [Cara mengakses DEMNAS (BIG)](https://cdn.theconversation.com/static_files/files/4029/Cara_mengakses_data_DEMNAS.pdf)
- [Spesifikasi DEMNAS: 8,25 m, EGM2008 (UGM)](https://etd.repository.ugm.ac.id/penelitian/detail/191096)
- [Plugin QGIS BIG Downloader](https://plugins.qgis.org/plugins/tags/big/)
- [FABDEM – EGU22](https://meetingorganizer.copernicus.org/EGU22/EGU22-8994.html)
- [DeltaDTM – GEE community catalog](https://gee-community-catalog.org/projects/delta_dtm) dan [4TU.ResearchData](https://data.4tu.nl/datasets/1da2e70f-6c4d-4b03-86bd-b53e789cc629)
- [Overture Maps – Buildings guide](https://docs.overturemaps.org/guides/buildings)
- [Open Buildings 2.5D Temporal – Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1?hl=en) dan [Google Research FAQ](https://sites.research.google/gr/open-buildings/temporal)
- [Planet NICFI basemaps Asia – Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/projects_planet-nicfi_assets_basemaps_asia?hl=ko)
- [ESA WorldCover](https://docs.terrabyte.lrz.de/datasets/esaworldcover/) dan [Dynamic World](https://atlas.co/data-sources/dynamic-world/)
- [Jakarta Satu – Esri Indonesia](https://esriindonesia.co.id/news/jakarta-satu-program-international-benchmark-smart-cities)
- [Pantau Banjir & data banjir Jakarta – Berita Jakarta](https://www.beritajakarta.id/en/read/38673/potret-jakarta)
- [PetaBencana.id Open API](https://docs.petabencana.id/routes)
- [Penurunan tanah Jakarta 3D 2014–2025 – TU Delft](https://research.tudelft.nl/en/publications/land-subsidence-in-jakarta-in-three-dimensions-2014-2025-using-in/) dan [SBAS multi-track 2017–2022 – UGM](https://ir.lib.ugm.ac.id/id/eprint/12554/)
- [INAGEOID2020 – SRGI BIG](https://srgi.big.go.id/page/geoid-model) dan [EPSG:10144](https://epsg.io/10144)
- [QGroundControl CSV Logging](https://docs.qgroundcontrol.com/master/en/qgc-user-guide/settings_view/csv.html) dan [ekspor log via QGC](https://iqmotion.readthedocs.io/en/latest/tutorials/extracting_log_qgroundcontrol.html)
- [OpenDroneMap](https://en.wikipedia.org/wiki/OpenDroneMap) dan [pemisahan WebODM–ODM](https://www.skyebrowse.com/news/posts/webodm-vs-opendronemap)
