"""Ringkas ekstrak Overture places (GeoJSON) menjadi web/public/data/overture_places.json untuk pencarian POI offline.

    python tools/.overture/run.py download -r <rilis> --bbox=106.76,-6.26,106.90,-6.12 -f geojson --type=place -o tools/.overture/places_raw.geojson
    python tools/build_overture_poi.py
Format keluaran: {release, license, bbox, places: [[nama, kategori, lon, lat], ...]} (confidence >= 0.8).
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = root / "tools" / ".overture" / "places_raw.geojson"
state = json.loads((src.parent / (src.name + ".state")).read_text()) if (src.parent / (src.name + ".state")).exists() else {}
places = []
with src.open(encoding="utf-8") as f:
    data = json.load(f)
for ft in data["features"]:
    p = ft["properties"]
    name = (p.get("names") or {}).get("primary")
    if not name or (p.get("confidence") or 0) < 0.8:
        continue
    cat = (p.get("categories") or {}).get("primary") or (p.get("basic_category") or "")
    lon, lat = ft["geometry"]["coordinates"][:2]
    places.append([name, cat, round(lon, 6), round(lat, 6)])
out = root / "web" / "public" / "data" / "overture_places.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"release": state.get("last_release", "?"), "license": "Overture Maps Places — CDLA Permissive 2.0 / ODbL (lihat atribusi sumber)",
                           "bbox": [106.76, -6.26, 106.90, -6.12], "places": places}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(len(places), "POI ->", out, f"{out.stat().st_size / 1e6:.1f} MB")
