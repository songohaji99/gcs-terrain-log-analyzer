// Salin aset statis CesiumJS (worker, tekstur, widget) ke public/cesium — dibutuhkan CESIUM_BASE_URL.
import { cpSync, existsSync } from 'node:fs';

const src = 'node_modules/cesium/Build/Cesium', dst = 'public/cesium';
for (const d of ['Workers', 'ThirdParty', 'Assets', 'Widgets'])
  if (!existsSync(`${dst}/${d}`)) cpSync(`${src}/${d}`, `${dst}/${d}`, { recursive: true });
