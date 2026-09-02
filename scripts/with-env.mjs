#!/usr/bin/env node
/**
 * Run a development process with the repository's `.env` loaded.
 *
 * Every app in this workspace reads its configuration from the environment,
 * and nothing was loading it: each `dev` script inherited whatever the shell
 * happened to hold. That works until a shell holds something *stale*, and then
 * the failure is silent and misleading — a rotated API key comes back as an
 * opaque 401 from the Control API rather than as "your shell is out of date".
 * Diagnosing it costs more than this file does.
 *
 * **The file wins over the shell**, which is the opposite of the usual dotenv
 * convention and is the entire point. The normal precedence exists so an
 * operator can override a committed default for one run; here there is no
 * committed default, `.env` is the single local source of truth, and a shell
 * variable that disagrees with it is a stale copy rather than an intention.
 * To override deliberately, edit `.env` — it is gitignored and yours.
 *
 * The same launcher pattern as `apps/ai/scripts/py.mjs`, and for the same
 * reason: a pnpm script should behave identically in PowerShell, Git Bash, and
 * an IDE's run button, none of which agree about how to set a variable.
 *
 * Deliberately not used by `test`, `lint`, `typecheck` or `build`. Those must
 * not depend on a developer's local `.env`, and a test that passes only
 * because of one is a test that fails in CI.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = resolve(process.env.VCIP_ENV_FILE ?? join(repoRoot, '.env'));

/**
 * Parse `KEY=value` lines.
 *
 * Split on the first `=` only, because values contain them — a URL with a
 * query string, a base64 secret. Surrounding quotes are stripped so both
 * `KEY=value` and `KEY="value"` mean the same thing. Trailing whitespace goes
 * too: an invisible space at the end of a credential is a 401 nobody can see.
 */
function parse(text) {
  const values = new Map();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    values.set(key, value);
  }

  return values;
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('with-env: nothing to run. Usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

if (existsSync(envPath)) {
  const values = parse(readFileSync(envPath, 'utf8'));
  const overridden = [];

  for (const [key, value] of values) {
    if (process.env[key] !== undefined && process.env[key] !== value) overridden.push(key);
    process.env[key] = value;
  }

  // Named, not valued. Knowing *that* a stale shell copy was replaced is the
  // diagnostic; printing what replaced it would put credentials in a terminal
  // scrollback and every CI log that ever captures one.
  const note =
    overridden.length > 0 ? ` (replaced stale shell values: ${overridden.join(', ')})` : '';
  console.error(`with-env: loaded ${String(values.size)} variables from .env${note}`);
} else {
  // Not fatal. Some apps have working defaults for local development, and the
  // ones that do not fail at boot with a message naming what they need.
  console.error(`with-env: no .env at ${envPath}; using the environment as-is`);
}

// `shell: true` because the commands are workspace binaries — `next`, `nest`,
// `drizzle-kit` — which pnpm exposes as `.cmd` shims on Windows, and Node
// refuses to spawn a `.cmd` without a shell.
//
// One string rather than a command and an args array: with `shell: true` Node
// concatenates them anyway, and passing them separately earns a deprecation
// warning on every start (DEP0190). Arguments containing whitespace are quoted
// on the way in, so concatenating cannot split one into two.
const quoted = command.map((argument) =>
  /\s/.test(argument) ? JSON.stringify(argument) : argument,
);
const child = spawn(quoted.join(' '), { stdio: 'inherit', shell: true });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
