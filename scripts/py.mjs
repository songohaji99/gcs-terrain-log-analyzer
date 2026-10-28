#!/usr/bin/env node
// Jalankan skrip Python lintas OS: coba python3 (macOS/Linux) lalu python / py (Windows).
// Pemakaian: node scripts/py.mjs <script.py> [argumen...]
import { spawnSync } from 'node:child_process';

const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
const exe = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
if (!exe) {
  console.error('Python 3.10+ tidak ditemukan di PATH. Install dari https://www.python.org/downloads/');
  process.exit(1);
}
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
