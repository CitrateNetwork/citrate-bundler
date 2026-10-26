/**
 * Deploy-descriptor tripwires, run by `npm test` so CI exercises them.
 *
 * `scripts/check-compose.mjs` and `scripts/check-image-pins.mjs` guard the two
 * files that decide what actually gets deployed: the compose file must load,
 * and the money-path image must build from a pinned upstream commit with
 * lockfile integrity enforced. Both scripts existed, but nothing ran them, so
 * reintroducing a duplicate compose key or a branch-name BUNDLER_REF left the
 * suite green. These tests run each checker against the real repo files
 * (must pass) and against a corrupted copy (must fail), so a checker that
 * stops detecting anything is caught too.
 *
 * Each negative control works on a private copy under a fresh mkdtemp dir and
 * removes exactly that dir. PATH is narrowed to the node binary's directory so
 * the result never depends on a Docker install on the host.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_CHECK = join(REPO_ROOT, 'scripts', 'check-compose.mjs');
const PINS_CHECK = join(REPO_ROOT, 'scripts', 'check-image-pins.mjs');

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) {
    if (d.startsWith(tmpdir()) && d.includes('bundler-desc-')) rmSync(d, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bundler-desc-'));
  created.push(d);
  return d;
}

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: dirname(process.execPath), HOME: tmpdir() },
  });
}

/** A private repo-shaped copy with the image-pin checker and both Dockerfiles. */
function pinsFixture(mutate: (files: { root: string; gate: string }) => { root: string; gate: string }) {
  const d = freshDir();
  mkdirSync(join(d, 'scripts'));
  mkdirSync(join(d, 'gate'));
  cpSync(PINS_CHECK, join(d, 'scripts', 'check-image-pins.mjs'));
  const out = mutate({
    root: readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8'),
    gate: readFileSync(join(REPO_ROOT, 'gate', 'Dockerfile'), 'utf8'),
  });
  writeFileSync(join(d, 'Dockerfile'), out.root);
  writeFileSync(join(d, 'gate', 'Dockerfile'), out.gate);
  return join(d, 'scripts', 'check-image-pins.mjs');
}

function replaceOnce(src: string, from: string | RegExp, to: string): string {
  const next = src.replace(from, to);
  expect(next, `fixture edit did not apply: ${String(from)}`).not.toBe(src);
  return next;
}

describe('docker-compose.yml loads', () => {
  it('the repo compose file passes the structural check', () => {
    const r = runNode(COMPOSE_CHECK);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('negative control: a duplicated service key is rejected', () => {
    const src = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const bad = replaceOnce(src, /^  redis:\n/m, '  redis:\n    image: redis:7-alpine\n  redis:\n');
    const p = join(freshDir(), 'docker-compose.yml');
    writeFileSync(p, bad);
    const r = runNode(COMPOSE_CHECK, [p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/duplicate mapping key "redis"/);
  });

  it('the bundler service waits for a healthy redis (no orphaned depends_on)', () => {
    const src = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const bundler = /^  bundler:\n([\s\S]*?)^  \S/m.exec(src)?.[1] ?? '';
    expect(bundler).toMatch(/depends_on:\n\s+redis:\n\s+condition: service_healthy/);
  });
});

describe('money-path image build is pinned', () => {
  it('the repo Dockerfiles pass the image-pin check', () => {
    const r = runNode(PINS_CHECK);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('negative control: a branch-name BUNDLER_REF is rejected', () => {
    const script = pinsFixture((f) => ({
      ...f,
      root: replaceOnce(f.root, /^ARG BUNDLER_REF=\S+/m, 'ARG BUNDLER_REF=releases/v0.7'),
    }));
    const r = runNode(script);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a pinned 40-char commit SHA/);
  });

  it('negative control: an --immutable fallback install is rejected', () => {
    const script = pinsFixture((f) => ({
      ...f,
      root: replaceOnce(f.root, /^RUN yarn install --immutable$/m, 'RUN yarn install --immutable || yarn install'),
    }));
    const r = runNode(script);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/swallows a lockfile/);
  });

  it('negative control: npm install in the gate image is rejected', () => {
    const script = pinsFixture((f) => ({
      ...f,
      gate: replaceOnce(f.gate, /^RUN npm ci --omit=dev/m, 'RUN npm install --omit=dev'),
    }));
    const r = runNode(script);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/use `npm ci`/);
  });
});
