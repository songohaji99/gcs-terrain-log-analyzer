#!/usr/bin/env node
// Jalankan skrip Python lintas OS. Urutan: .venv proyek (bila ada) -> python3 (macOS/Linux) -> python / py (Windows).
// Memakai .venv langsung membuat skrip npm tidak bergantung pada aktivasi venv di shell tertentu.
// Pemakaian: node scripts/py.mjs <script.py | -m modul> [argumen...]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const venv = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const candidates = [...(existsSync(venv) ? [venv] : []), ...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])];
const exe = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
if (!exe) {
  console.error('Python 3.10+ tidak ditemukan. Install dari https://www.python.org/downloads/ atau buat .venv di folder proyek.');
  process.exit(1);
}
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
