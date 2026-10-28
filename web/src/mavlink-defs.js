// DIHASILKAN oleh tools/gen_mavlink_defs.py dari pymavlink (ardupilotmega) — jangan diedit manual.
// fields: [nama, kode struct Python, jumlah] dalam urutan wire.
export const MAVLINK_DEFS = {
 "0": {
  "name": "HEARTBEAT",
  "crc": 50,
  "len": 9,
  "fields": [
   [
    "custom_mode",
    "I",
    1
   ],
   [
    "type",
    "B",
    1
   ],
   [
    "autopilot",
    "B",
    1
   ],
   [
    "base_mode",
    "B",
    1
   ],
   [
    "system_status",
    "B",
    1
   ],
   [
    "mavlink_version",
    "B",
    1
   ]
  ]
 },
 "1": {
  "name": "SYS_STATUS",
  "crc": 124,
  "len": 43,
  "fields": [
   [
    "onboard_control_sensors_present",
    "I",
    1
   ],
   [
    "onboard_control_sensors_enabled",
    "I",
    1
   ],
   [
    "onboard_control_sensors_health",
    "I",
    1
   ],
   [
    "load",
    "H",
    1
   ],
   [
    "voltage_battery",
    "H",
    1
   ],
   [
    "current_battery",
    "h",
    1
   ],
   [
    "drop_rate_comm",
    "H",
    1
   ],
   [
    "errors_comm",
    "H",
    1
   ],
   [
    "errors_count1",
    "H",
    1
   ],
   [
    "errors_count2",
    "H",
    1
   ],
   [
    "errors_count3",
    "H",
    1
   ],
   [
    "errors_count4",
    "H",
    1
   ],
   [
    "battery_remaining",
    "b",
    1
   ],
   [
    "onboard_control_sensors_present_extended",
    "I",
    1
   ],
   [
    "onboard_control_sensors_enabled_extended",
    "I",
    1
   ],
   [
    "onboard_control_sensors_health_extended",
    "I",
    1
   ]
  ]
 },
 "24": {
  "name": "GPS_RAW_INT",
  "crc": 24,
  "len": 52,
  "fields": [
   [
    "time_usec",
    "Q",
    1
   ],
   [
    "lat",
    "i",
    1
   ],
   [
    "lon",
    "i",
    1
   ],
   [
    "alt",
    "i",
    1
   ],
   [
    "eph",
    "H",
    1
   ],
   [
    "epv",
    "H",
    1
   ],
   [
    "vel",
    "H",
    1
   ],
   [
    "cog",
    "H",
    1
   ],
   [
    "fix_type",
    "B",
    1
   ],
   [
    "satellites_visible",
    "B",
    1
   ],
   [
    "alt_ellipsoid",
    "i",
    1
   ],
   [
    "h_acc",
    "I",
    1
   ],
   [
    "v_acc",
    "I",
    1
   ],
   [
    "vel_acc",
    "I",
    1
   ],
   [
    "hdg_acc",
    "I",
    1
   ],
   [
    "yaw",
    "H",
    1
   ]
  ]
 },
 "30": {
  "name": "ATTITUDE",
  "crc": 39,
  "len": 28,
  "fields": [
   [
    "time_boot_ms",
    "I",
    1
   ],
   [
    "roll",
    "f",
    1
   ],
   [
    "pitch",
    "f",
    1
   ],
   [
    "yaw",
    "f",
    1
   ],
   [
    "rollspeed",
    "f",
    1
   ],
   [
    "pitchspeed",
    "f",
    1
   ],
   [
    "yawspeed",
    "f",
    1
   ]
  ]
 },
 "33": {
  "name": "GLOBAL_POSITION_INT",
  "crc": 104,
  "len": 28,
  "fields": [
   [
    "time_boot_ms",
    "I",
    1
   ],
   [
    "lat",
    "i",
    1
   ],
   [
    "lon",
    "i",
    1
   ],
   [
    "alt",
    "i",
    1
   ],
   [
    "relative_alt",
    "i",
    1
   ],
   [
    "vx",
    "h",
    1
   ],
   [
    "vy",
    "h",
    1
   ],
   [
    "vz",
    "h",
    1
   ],
   [
    "hdg",
    "H",
    1
   ]
  ]
 },
 "36": {
  "name": "SERVO_OUTPUT_RAW",
  "crc": 222,
  "len": 37,
  "fields": [
   [
    "time_usec",
    "I",
    1
   ],
   [
    "servo1_raw",
    "H",
    1
   ],
   [
    "servo2_raw",
    "H",
    1
   ],
   [
    "servo3_raw",
    "H",
    1
   ],
   [
    "servo4_raw",
    "H",
    1
   ],
   [
    "servo5_raw",
    "H",
    1
   ],
   [
    "servo6_raw",
    "H",
    1
   ],
   [
    "servo7_raw",
    "H",
    1
   ],
   [
    "servo8_raw",
    "H",
    1
   ],
   [
    "port",
    "B",
    1
   ],
   [
    "servo9_raw",
    "H",
    1
   ],
   [
    "servo10_raw",
    "H",
    1
   ],
   [
    "servo11_raw",
    "H",
    1
   ],
   [
    "servo12_raw",
    "H",
    1
   ],
   [
    "servo13_raw",
    "H",
    1
   ],
   [
    "servo14_raw",
    "H",
    1
   ],
   [
    "servo15_raw",
    "H",
    1
   ],
   [
    "servo16_raw",
    "H",
    1
   ]
  ]
 },
 "62": {
  "name": "NAV_CONTROLLER_OUTPUT",
  "crc": 183,
  "len": 26,
  "fields": [
   [
    "nav_roll",
    "f",
    1
   ],
   [
    "nav_pitch",
    "f",
    1
   ],
   [
    "alt_error",
    "f",
    1
   ],
   [
    "aspd_error",
    "f",
    1
   ],
   [
    "xtrack_error",
    "f",
    1
   ],
   [
    "nav_bearing",
    "h",
    1
   ],
   [
    "target_bearing",
    "h",
    1
   ],
   [
    "wp_dist",
    "H",
    1
   ]
  ]
 },
 "74": {
  "name": "VFR_HUD",
  "crc": 20,
  "len": 20,
  "fields": [
   [
    "airspeed",
    "f",
    1
   ],
   [
    "groundspeed",
    "f",
    1
   ],
   [
    "alt",
    "f",
    1
   ],
   [
    "climb",
    "f",
    1
   ],
   [
    "heading",
    "h",
    1
   ],
   [
    "throttle",
    "H",
    1
   ]
  ]
 },
 "46": {
  "name": "MISSION_ITEM_REACHED",
  "crc": 11,
  "len": 2,
  "fields": [
   [
    "seq",
    "H",
    1
   ]
  ]
 },
 "73": {
  "name": "MISSION_ITEM_INT",
  "crc": 38,
  "len": 38,
  "fields": [
   [
    "param1",
    "f",
    1
   ],
   [
    "param2",
    "f",
    1
   ],
   [
    "param3",
    "f",
    1
   ],
   [
    "param4",
    "f",
    1
   ],
   [
    "x",
    "i",
    1
   ],
   [
    "y",
    "i",
    1
   ],
   [
    "z",
    "f",
    1
   ],
   [
    "seq",
    "H",
    1
   ],
   [
    "command",
    "H",
    1
   ],
   [
    "target_system",
    "B",
    1
   ],
   [
    "target_component",
    "B",
    1
   ],
   [
    "frame",
    "B",
    1
   ],
   [
    "current",
    "B",
    1
   ],
   [
    "autocontinue",
    "B",
    1
   ],
   [
    "mission_type",
    "B",
    1
   ]
  ]
 },
 "22": {
  "name": "PARAM_VALUE",
  "crc": 220,
  "len": 25,
  "fields": [
   [
    "param_value",
    "f",
    1
   ],
   [
    "param_count",
    "H",
    1
   ],
   [
    "param_index",
    "H",
    1
   ],
   [
    "param_id",
    "s",
    16
   ],
   [
    "param_type",
    "B",
    1
   ]
  ]
 },
 "253": {
  "name": "STATUSTEXT",
  "crc": 83,
  "len": 54,
  "fields": [
   [
    "severity",
    "B",
    1
   ],
   [
    "text",
    "s",
    50
   ],
   [
    "id",
    "H",
    1
   ],
   [
    "chunk_seq",
    "B",
    1
   ]
  ]
 },
 "226": {
  "name": "RPM",
  "crc": 207,
  "len": 8,
  "fields": [
   [
    "rpm1",
    "f",
    1
   ],
   [
    "rpm2",
    "f",
    1
   ]
  ]
 },
 "147": {
  "name": "BATTERY_STATUS",
  "crc": 154,
  "len": 54,
  "fields": [
   [
    "current_consumed",
    "i",
    1
   ],
   [
    "energy_consumed",
    "i",
    1
   ],
   [
    "temperature",
    "h",
    1
   ],
   [
    "voltages",
    "H",
    10
   ],
   [
    "current_battery",
    "h",
    1
   ],
   [
    "id",
    "B",
    1
   ],
   [
    "battery_function",
    "B",
    1
   ],
   [
    "type",
    "B",
    1
   ],
   [
    "battery_remaining",
    "b",
    1
   ],
   [
    "time_remaining",
    "i",
    1
   ],
   [
    "charge_state",
    "B",
    1
   ],
   [
    "voltages_ext",
    "H",
    4
   ],
   [
    "mode",
    "B",
    1
   ],
   [
    "fault_bitmask",
    "I",
    1
   ]
  ]
 }
};
