"""Unduh ekstrak Overture Maps places untuk pencarian POI offline, lalu ringkas.

    python tools/overture_download.py [--bbox 106.76,-6.26,106.90,-6.12] [--release 2026-10-21.0]
Hasil mentah: tools/.overture/places_raw.geojson (di-ignore git); ringkas -> web/public/data/overture_places.json
lewat tools/build_overture_poi.py (juga di-ignore — data dibangun ulang di tiap mesin).
"""
import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "chakrawala/1.0 (+offline POI extract)"  # STAC Overture menolak urllib tanpa User-Agent


def latest_release():
    req = urllib.request.Request("https://stac.overturemaps.org/catalog.json", headers={"User-Agent": UA})
    cat = json.load(urllib.request.urlopen(req, timeout=30))
    return cat.get("latest") or [l["href"].split("/")[-2] for l in cat["links"] if l.get("rel") == "child"][-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default="106.76,-6.26,106.90,-6.12", help="minlon,minlat,maxlon,maxlat")
    ap.add_argument("--release", default=None)
    a = ap.parse_args()
    out = ROOT / "tools" / ".overture" / "places_raw.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    rel = a.release or latest_release()
    print("Rilis Overture:", rel)
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", UA)]
    urllib.request.install_opener(opener)
    from overturemaps.cli import cli  # pip install -r tools/requirements.txt
    try:
        cli(["download", "-r", rel, f"--bbox={a.bbox}", "-f", "geojson", "--type=place", "-o", str(out)], standalone_mode=False)
    except SystemExit as e:
        if e.code:
            raise
    subprocess.run([sys.executable, str(ROOT / "tools" / "build_overture_poi.py")], check=True)


if __name__ == "__main__":
    main()
