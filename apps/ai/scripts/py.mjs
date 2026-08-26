#!/usr/bin/env node
// Runs a command with the app's virtualenv interpreter, so pnpm scripts work
// from any shell on any platform without requiring venv activation.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = [
  join(root, '.venv', 'Scripts', 'python.exe'),
  join(root, '.venv', 'bin', 'python'),
];

const python = candidates.find((p) => existsSync(p));
if (!python) {
  console.error('apps/ai: no virtualenv found. Run: pnpm --filter @vcip/ai run setup');
  process.exit(1);
}

const result = spawnSync(python, process.argv.slice(2), { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
