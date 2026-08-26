#!/usr/bin/env node
// Creates apps/ai/.venv and installs dependencies. Idempotent.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venvPython = [
  join(root, '.venv', 'Scripts', 'python.exe'),
  join(root, '.venv', 'bin', 'python'),
];

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!venvPython.some((p) => existsSync(p))) {
  const base = process.env.PYTHON ?? 'python';
  console.error(`apps/ai: creating virtualenv with ${base}`);
  run(base, ['-m', 'venv', '.venv']);
}

const python = venvPython.find((p) => existsSync(p));
if (!python) {
  console.error('apps/ai: virtualenv creation failed. Set PYTHON to a Python 3.11+ interpreter.');
  process.exit(1);
}

run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(python, ['-m', 'pip', 'install', '-r', 'requirements-dev.txt']);
