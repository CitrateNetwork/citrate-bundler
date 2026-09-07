#!/usr/bin/env node
// CI tripwire (BUN-B-004): the money-path image must be built from a PINNED
// upstream commit with lockfile integrity ENFORCED — not from a moving branch
// with an error-swallowing integrity fallback.
//
// Usage: node scripts/check-image-pins.mjs
//
// Enforced (statically verifiable, no Docker build needed):
//   1. Dockerfile: `ARG BUNDLER_REF` default is a 40-char lowercase hex SHA,
//      not a branch name (`releases/v0.7` is a MOVING branch head).
//   2. Dockerfile: no `yarn install --immutable || yarn install` fallback —
//      a lockfile-integrity failure (the exact signal of a supply-chain
//      substitution) must be FATAL, not silently retried without --immutable.
//   3. gate/Dockerfile: dependency installs use `npm ci` (lockfile-exact),
//      not `npm install` (which treats package-lock.json as advisory).
//
// NOT enforced here (tracked as a HELD follow-up on BUN-B-004): digest-pinning
// the four `FROM` base images (node:22-alpine, node:20-alpine, redis:7-alpine,
// caddy:2-alpine). Resolving trustworthy @sha256 digests needs network access
// and a build to validate, so it is deliberately out of this static check's
// scope; see the finding's suggested_fix.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const problems = [];

// ── 1 + 2: root Dockerfile ──────────────────────────────────────────
const df = readFileSync(join(root, 'Dockerfile'), 'utf8');

const refMatch = /^\s*ARG\s+BUNDLER_REF=(\S+)/m.exec(df);
if (!refMatch) {
  problems.push('Dockerfile: no `ARG BUNDLER_REF=` default found');
} else if (!/^[0-9a-f]{40}$/.test(refMatch[1])) {
  problems.push(
    `Dockerfile: BUNDLER_REF="${refMatch[1]}" is not a pinned 40-char commit SHA ` +
      '(a branch/tag head can move — pin to a SHA)',
  );
}

if (/--immutable\s*\|\|\s*yarn\s+install/.test(df)) {
  problems.push(
    'Dockerfile: `yarn install --immutable || yarn install` swallows a lockfile ' +
      'integrity failure — drop the `|| yarn install` fallback',
  );
}

// ── 3: gate Dockerfile ──────────────────────────────────────────────
const gateDf = readFileSync(join(root, 'gate', 'Dockerfile'), 'utf8');
for (const line of gateDf.split('\n')) {
  if (/^\s*RUN\s+npm\s+install\b/.test(line)) {
    problems.push(`gate/Dockerfile: "${line.trim()}" — use \`npm ci\` for a lockfile-exact install`);
  }
}

if (problems.length > 0) {
  console.error('check-image-pins: unpinned / integrity-bypassing image build (BUN-B-004):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('check-image-pins: OK — BUNDLER_REF pinned to a SHA, integrity fallbacks removed, gate uses npm ci');
