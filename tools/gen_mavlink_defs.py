"""Generate web/src/mavlink-defs.js dari definisi pymavlink (dialek ardupilotmega).

    python tools/gen_mavlink_defs.py
"""
import json
import re
from pathlib import Path

from pymavlink.dialects.v20 import ardupilotmega as m

NAMES = ["HEARTBEAT", "SYS_STATUS", "GPS_RAW_INT", "ATTITUDE", "GLOBAL_POSITION_INT", "SERVO_OUTPUT_RAW",
         "NAV_CONTROLLER_OUTPUT", "VFR_HUD", "MISSION_ITEM_REACHED", "MISSION_ITEM_INT", "PARAM_VALUE",
         "STATUSTEXT", "RPM", "BATTERY_STATUS"]

defs = {}
for name in NAMES:
    cls = getattr(m, f"MAVLink_{name.lower()}_message")
    fmt = cls.unpacker.format if hasattr(cls.unpacker, "format") else cls.native_format
    fmt = fmt.decode() if isinstance(fmt, bytes) else fmt
    toks = re.findall(r"(\d*)([a-zA-Z])", fmt.lstrip("<"))
    assert len(toks) == len(cls.ordered_fieldnames), (name, toks, cls.ordered_fieldnames)
    fields = [[f, t, int(n) if n else 1] for f, (n, t) in zip(cls.ordered_fieldnames, toks)]
    defs[cls.id] = {"name": name, "crc": cls.crc_extra, "len": cls.unpacker.size, "fields": fields}

out = Path(__file__).resolve().parents[1] / "web" / "src" / "mavlink-defs.js"
out.write_text(
    "// DIHASILKAN oleh tools/gen_mavlink_defs.py dari pymavlink (ardupilotmega) — jangan diedit manual.\n"
    "// fields: [nama, kode struct Python, jumlah] dalam urutan wire.\n"
    f"export const MAVLINK_DEFS = {json.dumps(defs, indent=1)};\n", encoding="utf-8")
print("tulis", out, len(defs), "pesan")
