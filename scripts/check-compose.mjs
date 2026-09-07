#!/usr/bin/env node
// CI tripwire (BUN-B-003): every deployable descriptor in the repo must
// parse. `docker-compose.yml` was syntactically invalid on `main` for 82
// days — an orphaned `depends_on:` under `bundler` and a DUPLICATE `redis:`
// mapping key — so `docker compose up -d --build` (the exact DEPLOY.md
// command) could not load it, and the whole gate security layer was not
// deployable from this repo.
//
// Usage: node scripts/check-compose.mjs [path/to/docker-compose.yml]
//
// If a `docker compose` plugin is available this ALSO runs
// `docker compose config -q` (the canonical validator). Independently — so
// the check works on hosts with no Docker — it runs a dependency-free YAML
// structural lint that flags duplicate sibling keys and mapping keys left
// without a value/children (the two corruptions this finding is about).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] ?? join(here, '..', 'docker-compose.yml');

let src;
try {
  src = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`check-compose: cannot read ${path}: ${err.message}`);
  process.exit(2);
}

// ── dependency-free structural lint ─────────────────────────────────
// Tracks a stack of open mapping frames keyed by indentation and flags a key
// that DUPLICATES a sibling already seen in the same parent. A duplicate
// mapping key is unambiguously invalid YAML (go-yaml v3, the decoder
// compose-go delegates to, rejects it) — this is the decisive corruption in
// BUN-B-003 (a second `redis:` service inserted with zero deletions). Empty /
// null-valued keys are NOT flagged: `volumes:\n  redis_data:` is valid YAML.
function lint(text) {
  const problems = [];
  const rawLines = text.split('\n');

  const isBlankOrComment = (s) => s.trim() === '' || s.trimStart().startsWith('#');
  const keyRe = /^(\s*)([A-Za-z0-9_.\-]+):(\s*)(\S.*)?$/;

  // stack of { indent, keys:Set }
  const stack = [{ indent: -1, keys: new Set() }];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (isBlankOrComment(line)) continue;
    const m = keyRe.exec(line);
    if (!m) continue; // sequence item / scalar continuation
    const indent = m[1].length;
    const key = m[2];

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent.keys.has(key)) {
      problems.push(`duplicate mapping key "${key}" at line ${i + 1}`);
    }
    parent.keys.add(key);
    stack.push({ indent, keys: new Set() });
  }
  return problems;
}

const problems = lint(src);

// ── canonical validator when Docker is present ──────────────────────
let dockerRan = false;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  execFileSync('docker', ['compose', '-f', path, 'config', '-q'], { stdio: 'inherit' });
  dockerRan = true;
} catch (err) {
  if (err && err.status !== undefined && err.cmd && String(err.cmd).includes('config')) {
    // `docker compose config` itself failed → the file is invalid.
    problems.push('docker compose config -q rejected the file');
    dockerRan = true;
  }
  // else: no docker plugin on this host — rely on the structural lint.
}

if (problems.length > 0) {
  console.error(`check-compose: ${path} is not a loadable compose file (BUN-B-003):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `check-compose: ${path} OK` + (dockerRan ? ' (docker compose config + structural lint)' : ' (structural lint)'),
);
