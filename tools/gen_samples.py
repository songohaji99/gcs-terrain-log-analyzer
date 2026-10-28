"""Generate data demo SINTETIS ke web/public/demo/ (aman dipublikasikan — bukan data terbang nyata).

    python tools/gen_samples.py

Keluaran: survei_monas.plan + log_qgc_survei_monas.csv (menu Drone > Arsip),
          sentul_plane.plan, sentul_plane.waypoints (misi sama, dua format),
          sentul_plane.bin, sentul_plane.log (DataFlash biner/teks), sentul_plane.tlog (MAVLink2).
Simulasi kinematik sederhana (L1-ish + laju naik terbatas + angin), BUKAN data terbang nyata.
"""
import json
import math
import random
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pymavlink.dialects.v20 import ardupilotmega as mav2

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "demo"
random.seed(42)

HOME = (-6.5650, 106.8700, 201.0)  # elevasi DEM Terrarium di home
TERRAIN_C = 409.0  # elevasi DEM di WP TERRAIN_ALT (dipakai sim untuk AMSL target)
# seq, cmd, frame(.plan), frame(.waypoints), p1..p4, lat, lon, alt
MISSION = [
    (1, 22, 3, 3, 12, 0, 0, 0, 0.0, 0.0, 60),          # NAV_TAKEOFF (pesawat: posisi = lokasi saat ini)
    (2, 178, 2, 3, 0, 20, -1, 0, 0.0, 0.0, 0),         # DO_CHANGE_SPEED airspeed 20 m/s
    (3, 16, 3, 3, 0, 0, 0, 0, -6.5750, 106.8850, 150),
    (4, 16, 3, 3, 0, 0, 0, 0, -6.5850, 106.9050, 260),
    (5, 183, 2, 3, 9, 1900, 0, 0, 0.0, 0.0, 0),        # DO_SET_SERVO ch9 = 1900
    (6, 16, 10, 10, 0, 0, 0, 0, -6.5760, 106.9280, 120),  # TERRAIN_ALT
    (7, 16, 0, 0, 0, 0, 0, 0, -6.5600, 106.9300, 520),    # GLOBAL (AMSL)
    (8, 223, 2, 3, 1, 0, 0, 0, 0.0, 0.0, 0),           # DO_ENGINE_CONTROL start
    (9, 16, 3, 3, 0, 0, 0, 0, -6.5560, 106.9050, 300),
    (10, 18, 3, 3, 1, 0, 100, 0, -6.5560, 106.8800, 220),  # NAV_LOITER_TURNS 1 putaran r=100
    (11, 21, 3, 3, 0, 0, 0, 0, -6.5640, 106.8680, 0),     # NAV_LAND
]
NAV = {16, 18, 21, 22}
PARAMS = {"SERVO1_FUNCTION": 4, "SERVO2_FUNCTION": 19, "SERVO3_FUNCTION": 70, "SERVO4_FUNCTION": 21,
          "SERVO5_FUNCTION": 4, "SERVO9_FUNCTION": 0, "WP_RADIUS": 60, "TERRAIN_FOLLOW": 0, "ARSPD_FBW_MIN": 14}
PLANE_MODES = {"MANUAL": 0, "FBWA": 5, "AUTO": 10}


def write_missions():
    items = [{"type": "SimpleItem", "command": c, "frame": fp, "params": [p1, p2, p3, p4, la, lo, al],
              "autoContinue": True, "doJumpId": s, "AMSLAltAboveTerrain": None, "Altitude": al, "AltitudeMode": 1}
             for s, c, fp, fw, p1, p2, p3, p4, la, lo, al in MISSION]
    plan = {"fileType": "Plan", "version": 1, "groundStation": "QGroundControl",
            "geoFence": {"circles": [], "polygons": [], "version": 2}, "rallyPoints": {"points": [], "version": 2},
            "mission": {"version": 2, "firmwareType": 3, "vehicleType": 1, "cruiseSpeed": 18, "hoverSpeed": 5,
                        "plannedHomePosition": [HOME[0], HOME[1], HOME[2]], "items": items}}
    (OUT / "sentul_plane.plan").write_text(json.dumps(plan, indent=2))
    rows = ["QGC WPL 110", f"0\t1\t0\t16\t0\t0\t0\t0\t{HOME[0]:.8f}\t{HOME[1]:.8f}\t{HOME[2]:.6f}\t1"]
    for s, c, fp, fw, p1, p2, p3, p4, la, lo, al in MISSION:
        rows.append(f"{s}\t0\t{fw}\t{c}\t{p1:.8f}\t{p2:.8f}\t{p3:.8f}\t{p4:.8f}\t{la:.8f}\t{lo:.8f}\t{al:.6f}\t1")
    (OUT / "sentul_plane.waypoints").write_text("\n".join(rows) + "\n")


# ------------------------------------------------------------------ simulasi
KX = 111320 * math.cos(math.radians(HOME[0]))
KY = 110574.0
xy = lambda la, lo: ((lo - HOME[1]) * KX, (la - HOME[0]) * KY)
ll = lambda x, y: (HOME[0] + y / KY, HOME[1] + x / KX)


def target_amsl(item):
    s, c, fp, fw, p1, p2, p3, p4, la, lo, al = item
    return al if fp == 0 else al + TERRAIN_C if fp == 10 else al + HOME[2]


def simulate():
    """Mengembalikan daftar event (t, kind, data) urut waktu."""
    ev = []
    dt, g = 0.1, 9.81
    wind = (-4.5 * math.sin(math.radians(100)), -4.5 * math.cos(math.radians(100)))  # angin dari 100°
    x = y = 0.0
    alt, vz, roll, pitch, hdg = HOME[2], 0.0, 0.0, 0.0, 0.0
    aspd, aspd_tgt, thr, servo9 = 0.0, 18.0, 0.0, 1500
    mode, armed, phase = "MANUAL", False, "idle"
    nav_i = 0  # indeks ke MISSION
    prev_pt, prev_alt = (0.0, 0.0), HOME[2]
    loiter_acc, loiter_last = 0.0, None
    fbwa_until = None
    t = 0.0
    a_x, a_y = xy(MISSION[2][8], MISSION[2][9])
    hdg = math.atan2(a_x, a_y)

    def emit(kind, **d):
        ev.append((t, kind, d))

    def start_cmd(i):
        emit("CMD", seq=MISSION[i][0])

    emit("MODE", name="MANUAL")
    while t < 2000:
        des_roll = des_pitch = 0.0
        if phase == "idle" and t >= 15:
            armed, mode, phase = True, "AUTO", "takeoff"
            emit("MODE", name="AUTO")
            emit("MSG", text="Arming motors")
            start_cmd(0)
        elif phase == "takeoff":
            aspd += (22 - aspd) * dt / 3
            thr = 100
            if aspd > 13:
                vz += (4 - vz) * dt
                des_pitch = 12
            if alt - HOME[2] >= 54:
                emit("MSG", text=f"Takeoff complete at {alt - HOME[2]:.2f}m")
                emit("REACHED", seq=1)
                prev_pt, prev_alt = (x, y), alt
                nav_i = 1
                phase = "nav"
        elif phase in ("nav", "loiter", "land"):
            item = MISSION[nav_i]
            if item[1] not in NAV:  # perintah DO dieksekusi langsung
                start_cmd(nav_i)
                if item[1] == 178:
                    aspd_tgt = item[5]
                if item[1] == 183:
                    servo9 = int(item[5])
                    emit("MSG", text=f"Servo {int(item[4])} set to {int(item[5])}")
                if item[1] == 223:
                    emit("MSG", text="Engine: start requested")
                nav_i += 1
                if MISSION[nav_i][1] in NAV:
                    start_cmd(nav_i)
                continue
            if fbwa_until is None and item[0] == 6 and t > reach_b + 30:
                fbwa_until = t + 25
                mode = "FBWA"
                emit("MODE", name="FBWA")
            in_fbwa = fbwa_until is not None and t < fbwa_until
            if fbwa_until is not None and not in_fbwa and mode == "FBWA":
                mode = "AUTO"
                emit("MODE", name="AUTO")
                prev_pt, prev_alt = (x, y), alt
            wx, wy = xy(item[8], item[9])
            tgt_alt = target_amsl(item)
            lx, ly = wx - prev_pt[0], wy - prev_pt[1]
            L = math.hypot(lx, ly) or 1
            along = ((x - prev_pt[0]) * lx + (y - prev_pt[1]) * ly) / L
            xte = ((x - prev_pt[0]) * ly - (y - prev_pt[1]) * lx) / L  # + = kanan jalur
            frac = max(0.0, min(1.0, along / L))
            dist = math.hypot(wx - x, wy - y)
            if phase == "loiter":
                cx, cy, r = wx, wy, item[6]
                ang = math.atan2(x - cx, y - cy)
                course = ang + math.pi / 2 + math.atan((math.hypot(x - cx, y - cy) - r) / 40)
                alt_cmd = tgt_alt
                if loiter_last is not None:
                    loiter_acc += abs((hdg - loiter_last + math.pi) % (2 * math.pi) - math.pi)
                loiter_last = hdg
                if loiter_acc >= 2 * math.pi * item[4]:
                    emit("MSG", text=f"Reached waypoint #{item[0]} dist {abs(math.hypot(x - cx, y - cy) - r):.0f}m")
                    emit("REACHED", seq=item[0])
                    prev_pt, prev_alt = (x, y), alt
                    nav_i += 1
                    phase = "land"
                    start_cmd(nav_i)
                    continue
            else:
                course = math.atan2(lx, ly) + math.atan(-xte / 60)
                alt_cmd = prev_alt + (tgt_alt - prev_alt) * frac
                if phase == "land":
                    alt_cmd = max(HOME[2], prev_alt + (HOME[2] - prev_alt) * min(1.0, frac * 1.15))
            if in_fbwa:
                des_roll, alt_cmd = 0.0, alt
            else:
                gx = aspd * math.sin(course) - wind[0]
                gy = aspd * math.cos(course) - wind[1]
                want = math.atan2(gx, gy)
                err = (want - hdg + math.pi) % (2 * math.pi) - math.pi
                des_roll = max(-40.0, min(40.0, math.degrees(err) * 1.4))
            vz_cmd = max(-3.0, min(4.0, (alt_cmd - alt) * 0.4))
            vz += (vz_cmd - vz) * dt / 1.5
            des_pitch = math.degrees(math.asin(max(-0.5, min(0.5, vz_cmd / max(aspd, 1)))))
            aspd += (aspd_tgt - aspd) * dt / 4
            thr = max(0.0, min(100.0, 42 + 7 * vz + 4 * (aspd_tgt - 18) + random.gauss(0, 1.5)))
            if phase == "land":
                thr = max(0.0, thr - 25)
                if alt <= HOME[2] + 0.4:
                    alt, vz = HOME[2], 0.0
                    emit("MSG", text="Landed")
                    emit("REACHED", seq=item[0])
                    phase, touchdown = "rollout", t
            elif phase == "nav" and not in_fbwa and (dist < 60 or along > L):
                if item[1] == 18:
                    phase, loiter_acc, loiter_last = "loiter", 0.0, None
                    emit("MSG", text=f"Loiter {item[4]:.0f} turns r={item[6]:.0f}m")
                else:
                    emit("MSG", text=f"Reached waypoint #{item[0]} dist {dist:.0f}m")
                    emit("REACHED", seq=item[0])
                    if item[0] == 4:
                        reach_b = t
                    prev_pt, prev_alt = (wx, wy), tgt_alt
                    nav_i += 1
                    if MISSION[nav_i][1] == 21:
                        phase = "land"
                        prev_pt, prev_alt = (x, y), alt
                    start_cmd(nav_i) if MISSION[nav_i][1] in NAV else None
        elif phase == "rollout":
            aspd = max(0.0, aspd - 3 * dt)
            thr, des_roll = 0.0, 0.0
            if aspd <= 0 and t - touchdown > 8:
                armed, mode, phase = False, "MANUAL", "done"
                emit("MODE", name="MANUAL")
                emit("MSG", text="Disarming motors")
                end_t = t
        elif phase == "done" and t - end_t > 10:
            break

        # dinamika
        roll += (des_roll - roll) * dt / 0.5
        if aspd > 3 and phase not in ("idle", "done"):
            hdg += g * math.tan(math.radians(roll)) / max(aspd, 8) * dt
        airborne = alt > HOME[2] + 0.3
        if phase not in ("idle", "done"):
            vx = aspd * math.sin(hdg) + (wind[0] if airborne else 0)
            vy = aspd * math.cos(hdg) + (wind[1] if airborne else 0)
            x, y = x + vx * dt, y + vy * dt
            alt = max(HOME[2], alt + vz * dt)
        else:
            vx = vy = 0.0
        pitch += ((des_pitch if airborne else 0) - pitch) * dt / 0.6
        gs = math.hypot(vx, vy)
        step = round(t / dt)
        la, lo = ll(x, y)
        state = dict(lat=la, lon=lo, alt=alt, rel=alt - HOME[2], gs=gs, cog=math.degrees(math.atan2(vx, vy)) % 360,
                     vz=vz, roll=roll, des_roll=des_roll, pitch=pitch, des_pitch=des_pitch, yaw=math.degrees(hdg) % 360,
                     aspd=aspd, thr=thr if armed else 0.0, armed=armed, mode=mode, servo9=servo9, vx=vx, vy=vy)
        if step % 2 == 0:
            emit("GPS", **state)
        emit("FAST", **state)
        if step % 10 == 0:
            emit("SLOW", **state)
        t += dt
    return ev


# ------------------------------------------------------------------ penulis DataFlash
DF_FMTS = {  # nama: (tipe, format, kolom)
    "FMT": (128, "BBnNZ", "Type,Length,Name,Format,Columns"),
    "PARM": (129, "QNf", "TimeUS,Name,Value"),
    "MSG": (130, "QZ", "TimeUS,Message"),
    "MODE": (131, "QMBB", "TimeUS,Mode,ModeNum,Rsn"),
    "GPS": (132, "QBBIHBcLLefff", "TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ"),
    "ATT": (133, "Qffffff", "TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw"),
    "CTUN": (134, "Qffffff", "TimeUS,NavRoll,Roll,NavPitch,Pitch,ThO,As"),
    "ARSP": (135, "QBf", "TimeUS,I,Airspeed"),
    "RPM": (136, "Qff", "TimeUS,rpm1,rpm2"),
    "BAT": (137, "QBfffB", "TimeUS,Inst,Volt,Curr,CurrTot,RemPct"),
    "RCOU": (138, "Q" + "H" * 14, "TimeUS," + ",".join(f"C{i}" for i in range(1, 15))),
    "CMD": (139, "QHHHffffLLfB", "TimeUS,CTot,CNum,CId,Prm1,Prm2,Prm3,Prm4,Lat,Lng,Alt,Frame"),
}
PY = {"b": "b", "B": "B", "M": "B", "h": "h", "H": "H", "c": "h", "C": "H", "i": "i", "I": "I", "e": "i", "E": "I",
      "L": "i", "f": "f", "d": "d", "q": "q", "Q": "Q", "n": "4s", "N": "16s", "Z": "64s"}
SCALE = {"c": 100, "C": 100, "e": 100, "E": 100, "L": 1e7}


class DF:
    def __init__(self):
        self.bin, self.txt = bytearray(), []
        for name in DF_FMTS:
            typ, fmt, cols = DF_FMTS[name]
            size = 3 + struct.calcsize("<" + "".join(PY[c] for c in fmt))
            self.rec("FMT", [typ, size, name, fmt, cols])

    def rec(self, name, vals):
        typ, fmt, cols = DF_FMTS[name]
        packed, txt = [], []
        for c, v in zip(fmt, vals):
            if c in "nNZ":
                b = str(v).encode()
                packed.append(b)
                txt.append(str(v))
            elif c in SCALE:
                packed.append(int(round(v * SCALE[c])))
                txt.append(f"{v:.7f}" if c == "L" else f"{v:.2f}")
            elif c in "fd":
                packed.append(float(v))
                txt.append(f"{v:.6g}")
            else:
                packed.append(int(v))
                txt.append(str(int(v)))
        self.bin += bytes([0xA3, 0x95, typ]) + struct.pack("<" + "".join(PY[c] for c in fmt), *packed)
        self.txt.append(f"{name}, " + ", ".join(txt))


T0_UNIX = datetime(2026, 10, 25, 1, 0, 0, tzinfo=timezone.utc).timestamp()
BOOT = 60.0  # detik sejak boot saat t=0


def gps_time(t):
    g = T0_UNIX + t - 315964800 + 18
    return int(g // 604800), int(round((g % 604800) * 1000))


def write_dataflash(ev):
    df = DF()
    us = lambda t: int((t + BOOT) * 1e6)
    df.rec("MSG", [us(0), "ArduPlane V4.5.7 (sintetis)"])
    df.rec("MSG", [us(0), "SAMPLE SINTETIS Chakrawala - bukan data terbang nyata"])
    for k, v in PARAMS.items():
        df.rec("PARM", [us(0), k, v])
    rows = [(0, 16, 0, 0, 0, 0, 0, HOME[0], HOME[1], HOME[2])] + [(s, c, fw, p1, p2, p3, p4, la, lo, al) for s, c, fp, fw, p1, p2, p3, p4, la, lo, al in MISSION]
    for s, c, fr, p1, p2, p3, p4, la, lo, al in rows:
        df.rec("CMD", [us(0), len(rows), s, c, p1, p2, p3, p4, la, lo, al, fr])
    curr_tot, last_slow = 0.0, 0.0
    for t, kind, d in ev:
        if kind == "MODE":
            n = PLANE_MODES[d["name"]]
            df.rec("MODE", [us(t), n, n, 1])
        elif kind == "MSG":
            df.rec("MSG", [us(t), d["text"]])
        elif kind == "CMD":
            r = rows[d["seq"]]
            df.rec("CMD", [us(t), len(rows), r[0], r[1], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[2]])
        elif kind == "GPS":
            wk, ms = gps_time(t)
            df.rec("GPS", [us(t), 0, 3, ms, wk, 14, 0.8, d["lat"] + random.gauss(0, 3e-6), d["lon"] + random.gauss(0, 3e-6),
                           d["alt"] + random.gauss(0, 0.4), d["gs"], d["cog"], -d["vz"]])
            df.rec("ARSP", [us(t), 0, d["aspd"] + random.gauss(0, 0.3)])
            rpm = 0.0 if not d["armed"] else 1300 + d["thr"] * 52 + random.gauss(0, 25)
            df.rec("RPM", [us(t), rpm, 0.0])
        elif kind == "FAST":
            df.rec("ATT", [us(t), d["des_roll"], d["roll"], d["des_pitch"], d["pitch"], d["yaw"], d["yaw"]])
            df.rec("CTUN", [us(t), d["des_roll"], d["roll"], d["des_pitch"], d["pitch"], d["thr"], d["aspd"]])
            df.rec("RCOU", [us(t), *servo(d)])
        elif kind == "SLOW":
            curr = 0.9 + d["thr"] * 0.02
            curr_tot += curr * (t - last_slow) / 3.6
            last_slow = t
            df.rec("BAT", [us(t), 0, 12.6 - 0.0006 * t - 0.004 * d["thr"], curr, curr_tot, max(0, 100 - curr_tot / 50)])
    (OUT / "sentul_plane.bin").write_bytes(bytes(df.bin))
    (OUT / "sentul_plane.log").write_text("\n".join(df.txt) + "\n")


def servo(d):
    ail = max(1100, min(1900, int(1500 + 10 * (d["des_roll"] - d["roll"]) + 6 * d["des_roll"])))
    ele = max(1100, min(1900, int(1500 - 15 * (d["des_pitch"] - d["pitch"]) - 5 * d["des_pitch"])))
    ch = [ail, ele, int(1100 + 8 * d["thr"]), int(1500 + 3 * d["roll"]), 3000 - ail, 1500, 1500, 1500, d["servo9"]]
    return ch + [0] * (14 - len(ch))


# ------------------------------------------------------------------ penulis tlog
def write_tlog(ev):
    out = bytearray()
    ac = mav2.MAVLink(None, srcSystem=1, srcComponent=1)
    gcs = mav2.MAVLink(None, srcSystem=255, srcComponent=190)

    def put(link, msg, t):
        out.extend(struct.pack(">Q", int((T0_UNIX + t) * 1e6)) + msg.pack(link))

    put(ac, mav2.MAVLink_statustext_message(6, b"ArduPlane V4.5.7 (sintetis)"), 0)
    for k, v in PARAMS.items():
        put(ac, mav2.MAVLink_param_value_message(k.encode(), float(v), 9, len(PARAMS), 0), 0)
    rows = [(0, 16, 0, 0, 0, 0, 0, HOME[0], HOME[1], HOME[2])] + [(s, c, fw, p1, p2, p3, p4, la, lo, al) for s, c, fp, fw, p1, p2, p3, p4, la, lo, al in MISSION]
    for s, c, fr, p1, p2, p3, p4, la, lo, al in rows:
        put(ac, mav2.MAVLink_mission_item_int_message(255, 190, s, fr, c, 0, 1, p1, p2, p3, p4, int(la * 1e7), int(lo * 1e7), al, 0), 0.01)
    mode, armed, last_hb = "MANUAL", False, -1.0
    for t, kind, d in ev:
        if kind == "MODE":
            mode = d["name"]
        elif kind == "MSG":
            put(ac, mav2.MAVLink_statustext_message(6, d["text"].encode()[:50]), t)
        elif kind == "REACHED":
            put(ac, mav2.MAVLink_mission_item_reached_message(d["seq"]), t)
        elif kind == "GPS":
            armed = d["armed"]
            boot = int((t + BOOT) * 1000)
            put(ac, mav2.MAVLink_gps_raw_int_message(int((t + BOOT) * 1e6), 3, int(d["lat"] * 1e7), int(d["lon"] * 1e7), int(d["alt"] * 1000),
                                                     80, 120, int(d["gs"] * 100), int(d["cog"] * 100), 14), t)
            put(ac, mav2.MAVLink_global_position_int_message(boot, int(d["lat"] * 1e7), int(d["lon"] * 1e7), int(d["alt"] * 1000), int(d["rel"] * 1000),
                                                             int(d["vy"] * 100), int(d["vx"] * 100), int(-d["vz"] * 100), int(d["yaw"] * 100)), t)
            put(ac, mav2.MAVLink_vfr_hud_message(d["aspd"], d["gs"], int(d["yaw"]), int(round(d["thr"])), d["alt"], d["vz"]), t)
            rpm = 0.0 if not d["armed"] else 1300 + d["thr"] * 52
            put(ac, mav2.MAVLink_rpm_message(rpm, 0.0), t)
            ch = servo(d)
            put(ac, mav2.MAVLink_servo_output_raw_message(int((t + BOOT) * 1e6), 0, *ch[:8], *ch[8:14], 0, 0), t)
        elif kind == "FAST":
            if round(t * 10) % 2:
                continue  # 5 Hz
            boot = int((t + BOOT) * 1000)
            put(ac, mav2.MAVLink_attitude_message(boot, math.radians(d["roll"]), math.radians(d["pitch"]), math.radians(d["yaw"] if d["yaw"] <= 180 else d["yaw"] - 360), 0, 0, 0), t)
            put(ac, mav2.MAVLink_nav_controller_output_message(d["des_roll"], d["des_pitch"], 0, 0, 0, 0, 0, 0), t)
        elif kind == "SLOW":
            if t - last_hb >= 1:
                last_hb = t
                put(ac, mav2.MAVLink_heartbeat_message(1, 3, (128 if armed else 0) | 1, PLANE_MODES[mode], 4, 3), t)
                put(gcs, mav2.MAVLink_heartbeat_message(6, 8, 0, 0, 0, 3), t)
                put(ac, mav2.MAVLink_sys_status_message(0, 0, 0, 300, int((12.6 - 0.0006 * t - 0.004 * d["thr"]) * 1000), int((0.9 + d["thr"] * 0.02) * 100), 80, 0, 0, 0, 0, 0, 0), t)
    out.extend(b"\x00\x13\xff garbage-tail")  # ekor rusak: parser harus melewatinya
    (OUT / "sentul_plane.tlog").write_bytes(bytes(out))


def write_monas_survey():
    """Survei lawnmower 6 lajur di atas Monas (copter, 120 m relatif) + log CSV gaya QGC dengan satu penurunan ketinggian."""
    rnd = random.Random(7)
    home = (-6.1754, 106.8272)
    m_lat, m_lon = 1 / 110574, 1 / (111320 * math.cos(math.radians(home[0])))
    pts = [(0, 0)] + [p for i in range(6) for p in (((-300, -300 + i * 120), (300, -300 + i * 120)) if i % 2 == 0 else ((300, -300 + i * 120), (-300, -300 + i * 120)))] + [(0, 0)]
    wps = [(home[0] + y * m_lat, home[1] + x * m_lon) for x, y in pts]
    items = [{"type": "SimpleItem", "command": 22, "frame": 3, "doJumpId": 1, "autoContinue": True, "params": [0, 0, 0, None, home[0], home[1], 120]}]
    items += [{"type": "SimpleItem", "command": 16, "frame": 3, "doJumpId": k, "autoContinue": True, "params": [0, 0, 0, None, la, lo, 120]} for k, (la, lo) in enumerate(wps[1:-1], 2)]
    items.append({"type": "SimpleItem", "command": 20, "frame": 2, "doJumpId": len(items) + 1, "autoContinue": True, "params": [0, 0, 0, 0, 0, 0, 0]})
    plan = {"fileType": "Plan", "version": 1, "groundStation": "QGroundControl", "geoFence": {"circles": [], "polygons": [], "version": 2},
            "rallyPoints": {"points": [], "version": 2}, "mission": {"version": 2, "firmwareType": 12, "vehicleType": 2, "cruiseSpeed": 12,
                                                                   "hoverSpeed": 5, "plannedHomePosition": [home[0], home[1], 8], "items": items}}
    (OUT / "survei_monas.plan").write_text(json.dumps(plan, indent=1))
    t0 = datetime(2026, 10, 27, 9, 0, 0)
    rows, t, alt, (lat, lon) = [], 0, 0.0, home

    def add(gs):
        nonlocal t
        drift = 3 * math.sin(t / 25)
        rows.append(f"{t0 + timedelta(seconds=t):%Y-%m-%d %H:%M:%S},{alt:.2f},{8 + alt:.2f},{lat + drift / 110574 + rnd.gauss(0, 1.2e-5):.7f},{lon + rnd.gauss(0, 1.2e-5):.7f},{gs}")
        t += 1
    while alt < 120:
        alt = min(120, alt + 4); add(0)
    for i in range(1, len(wps)):
        (la, lo), (lb, lob) = wps[i - 1], wps[i]
        n = max(1, int(math.hypot((lb - la) * 110574, (lob - lo) * 111320 * math.cos(math.radians(la))) / 12))
        for k in range(1, n + 1):
            lat, lon = la + (lb - la) * k / n, lo + (lob - lo) * k / n
            alt = 120 - 95 * math.sin(math.pi * k / n) if i == 7 else 120  # penurunan tak sengaja di lajur 4 (demo peringatan AGL)
            add(12)
    while alt > 0:
        alt = max(0, alt - 3); add(0)
    header = "Timestamp,altitudeRelative,altitudeAMSL,gps.lat,gps.lon,groundSpeed"
    (OUT / "log_qgc_survei_monas.csv").write_text("\n".join([header, *rows]) + "\n")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    write_monas_survey()
    write_missions()
    events = simulate()
    write_dataflash(events)
    write_tlog(events)
    dur = events[-1][0]
    print(f"durasi {dur:.0f} s, event {len(events)}; reached:", [d["seq"] for _, k, d in events if k == "REACHED"])
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:28s} {f.stat().st_size / 1024:8.1f} KB")
