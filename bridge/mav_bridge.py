"""Jembatan MAVLink -> WebSocket JSON untuk dashboard Chakrawala.

Live (QGC: Settings > MAVLink > MAVLink forwarding ke IP_SERVER:14551):
    python mav_bridge.py --listen udpin:0.0.0.0:14551
Simulasi (tanpa drone, survei lawnmower di atas Monas):
    python mav_bridge.py --sim

Setiap sesi juga direkam ke logs/flight_*.csv (bisa diunggah di menu Drone > Arsip).
"""
__author__ = "Development by Cakrayuda"

import argparse
import asyncio
import csv
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import websockets

CLIENTS = set()
FIELDS = ["t", "lat", "lon", "alt_msl", "alt_rel", "heading", "groundspeed", "battery", "mode", "armed", "fix", "sats", "hdop"]


class Recorder:
    def __init__(self, folder: Path):
        folder.mkdir(exist_ok=True)
        self.path = folder / f"flight_{datetime.now():%Y%m%d_%H%M%S}.csv"
        self.f = open(self.path, "w", newline="", encoding="utf-8")
        self.w = csv.DictWriter(self.f, fieldnames=FIELDS, extrasaction="ignore")
        self.w.writeheader()
        self.last = 0.0

    def write(self, s):
        if s["t"] - self.last >= 1.0:  # 1 Hz seperti CSV logging QGC
            self.last = s["t"]
            self.w.writerow(s)
            self.f.flush()


async def broadcast(state):
    msg = json.dumps({"type": "telemetry", **state})
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except websockets.ConnectionClosed:
            CLIENTS.discard(ws)


async def handler(ws):
    CLIENTS.add(ws)
    try:
        await ws.send(json.dumps({"type": "hello", "source": SOURCE}))
        await ws.wait_closed()
    finally:
        CLIENTS.discard(ws)


def sim_path():
    """Takeoff dari Lapangan Monas, survei 6 lajur 600 m, lalu kembali."""
    home = (-6.1754, 106.8272)
    m_lat, m_lon = 1 / 110574, 1 / (111320 * math.cos(math.radians(home[0])))
    wps = [(0, 0)]
    for i in range(6):
        y = -300 + i * 120
        xs = (-300, 300) if i % 2 == 0 else (300, -300)
        wps += [(xs[0], y), (xs[1], y)]
    wps.append((0, 0))
    return home, [(home[0] + y * m_lat, home[1] + x * m_lon) for x, y in wps]


async def run_sim(rec):
    home, wps = sim_path()
    ground_msl, cruise, speed, hz = 8.0, 120.0, 12.0, 5
    lat, lon, alt, batt, i = home[0], home[1], 0.0, 100.0, 1
    while True:
        tlat, tlon = wps[i]
        dy, dx = (tlat - lat) * 110574, (tlon - lon) * 111320 * math.cos(math.radians(lat))
        dist = math.hypot(dx, dy)
        heading = (math.degrees(math.atan2(dx, dy)) + 360) % 360
        climbing = alt < cruise and i == 1
        if climbing:
            alt = min(cruise, alt + 4 / hz)
            gs = 0.0
        else:
            step = speed / hz
            if dist <= step:
                lat, lon, i = tlat, tlon, i + 1
                if i >= len(wps):
                    # Mendarat lalu ulangi misi
                    while alt > 0:
                        alt = max(0, alt - 3 / hz)
                        await emit(rec, lat, lon, ground_msl + alt, alt, heading, 0, batt, "LAND")
                        await asyncio.sleep(1 / hz)
                    batt, i = 100.0, 1
                    await asyncio.sleep(3)
                    continue
            else:
                lat += dy / dist * step / 110574
                lon += dx / dist * step / (111320 * math.cos(math.radians(lat)))
            gs = speed
        batt = max(5.0, batt - 0.02)
        wobble = 1.5 * math.sin(time.time() / 3)  # simulasi drift barometer
        await emit(rec, lat, lon, ground_msl + alt + wobble, alt + wobble, heading, gs, batt, "TAKEOFF" if climbing else "MISSION")
        await asyncio.sleep(1 / hz)


async def emit(rec, lat, lon, alt_msl, alt_rel, heading, gs, batt, mode):
    s = dict(t=time.time(), lat=lat, lon=lon, alt_msl=round(alt_msl, 2), alt_rel=round(alt_rel, 2), heading=round(heading, 1),
             groundspeed=gs, battery=round(batt), mode=mode, armed=alt_rel > 0.5, fix=3, sats=17, hdop=0.7)
    rec.write(s)
    await broadcast(s)


async def run_mavlink(url, rec):
    from pymavlink import mavutil  # hanya diperlukan untuk mode live

    conn = mavutil.mavlink_connection(url, source_system=255)
    print(f"Menunggu MAVLink di {url} ...")
    s = dict(t=0, lat=None, lon=None, alt_msl=None, alt_rel=None, heading=None, groundspeed=None,
             battery=None, mode="?", armed=False, fix=None, sats=None, hdop=None)
    last_tx = 0.0
    while True:
        msg = await asyncio.to_thread(conn.recv_match, blocking=True, timeout=1)
        if msg is None:
            continue
        typ = msg.get_type()
        if typ == "GLOBAL_POSITION_INT":
            s.update(lat=msg.lat / 1e7, lon=msg.lon / 1e7, alt_msl=msg.alt / 1000, alt_rel=msg.relative_alt / 1000)
            if msg.hdg != 65535:
                s["heading"] = msg.hdg / 100
        elif typ == "VFR_HUD":
            s.update(groundspeed=round(msg.groundspeed, 1), heading=s["heading"] if s["heading"] is not None else msg.heading)
        elif typ == "SYS_STATUS" and msg.battery_remaining >= 0:
            s["battery"] = msg.battery_remaining
        elif typ == "GPS_RAW_INT":
            s.update(fix=msg.fix_type, sats=msg.satellites_visible, hdop=msg.eph / 100 if msg.eph != 65535 else None)
        elif typ == "HEARTBEAT" and msg.type != mavutil.mavlink.MAV_TYPE_GCS:
            s.update(mode=mavutil.mode_string_v10(msg), armed=bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED))
        now = time.time()
        if s["lat"] is not None and now - last_tx >= 0.2:  # maks 5 Hz ke browser
            last_tx = s["t"] = now
            rec.write(s)
            await broadcast(s)


async def main():
    global SOURCE
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="udpin:0.0.0.0:14551", help="URL koneksi pymavlink")
    ap.add_argument("--ws", default="0.0.0.0:8765", help="host:port WebSocket")
    ap.add_argument("--sim", action="store_true", help="jalankan simulasi tanpa drone")
    a = ap.parse_args()
    SOURCE = "simulasi" if a.sim else a.listen
    host, port = a.ws.rsplit(":", 1)
    rec = Recorder(Path(__file__).parent / "logs")
    print(f"WebSocket ws://{host}:{port}  |  sumber: {SOURCE}  |  log: {rec.path}")
    async with websockets.serve(handler, host, int(port)):
        await (run_sim(rec) if a.sim else run_mavlink(a.listen, rec))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\nSelesai {datetime.now(timezone.utc):%H:%M:%SZ}")
