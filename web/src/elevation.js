import { lngLatToTilePixel, terrariumHeight } from './geo.js';

export const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAXZOOM = 14; // ±9,5 m/piksel di Jakarta, sudah lebih rapat dari resolusi sumber 30 m
const cache = new Map();

// Piksel RGBA 256×256 satu tile Terrarium (di-cache).
export function demTile(z, tx, ty) {
  const key = `${z}/${tx}/${ty}`;
  if (!cache.has(key)) {
    const url = DEM_TILES.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
    cache.set(key, fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then(createImageBitmap)
      .then((bmp) => {
        const c = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
        c.drawImage(bmp, 0, 0);
        return c.getImageData(0, 0, 256, 256).data;
      })
      .catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

// Elevasi (m, ±EGM96) dari DEM Terrarium; null bila gagal.
export async function elevationAt(lon, lat) {
  const { tx, ty, px, py } = lngLatToTilePixel(lon, lat, DEM_MAXZOOM);
  try {
    const d = await demTile(DEM_MAXZOOM, tx, ty), i = (py * 256 + px) * 4;
    return terrariumHeight(d[i], d[i + 1], d[i + 2]);
  } catch {
    return null;
  }
}

export const elevations = (pts) => Promise.all(pts.map(([lon, lat]) => elevationAt(lon, lat)));
