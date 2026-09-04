// BUN-B-001 tripwire — the entrypoint boot guard + ERC-7562 config floors.
//
// RED (at the parent commit, before the fix): the entrypoint hardcoded
// `--unsafe` unconditionally and generated bundler.config.json with
// minStake:"1" / minUnstakeDelay:0. These tests fail on that pinned code:
//   - the boot guard did not exist, so the "unsafe + open" launch succeeded;
//   - the generated floors were below the ERC-7562 constant table.
// GREEN after the fix: unsafe+open boot is refused, floors are at 1e18 / 86400.
//
// The tests drive the REAL entrypoint shell script and the REAL CI checker,
// so they validate the shipped artifacts rather than a restated copy.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'citrate-bundler-entrypoint.sh');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-config-floors.mjs');

const BASE_ENV = {
  MNEMONIC: 'test test test test test test test test test test test junk',
  NETWORK: 'https://rpc.citrate.ai',
  ENTRYPOINT: '0x0000000000000000000000000000000000000000',
  CITRATE_ENTRYPOINT_DRY_RUN: '1',
};

function runEntrypoint(extraEnv: Record<string, string>) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'bun-cfg-'));
  const res = spawnSync('sh', [ENTRYPOINT], {
    env: { ...process.env, ...BASE_ENV, CFG_DIR: cfgDir, ...extraEnv },
    encoding: 'utf8',
  });
  return { ...res, cfgDir };
}

describe('BUN-B-001 boot guard (entrypoint)', () => {
  it('REFUSES to start: --unsafe on an anonymous front door (unsafe + no key)', () => {
    const res = runEntrypoint({ BUNDLER_UNSAFE: 'true', GATE_REQUIRE_API_KEY: 'false' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/refusing to start/i);
    expect(res.stderr).toContain('BUN-B-001');
  });

  it('starts: --unsafe WITH a mandatory API key (unsafe + key)', () => {
    const res = runEntrypoint({ BUNDLER_UNSAFE: 'true', GATE_REQUIRE_API_KEY: 'true' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--unsafe');
    expect(res.stdout).toContain('--auto');
  });

  it('starts: safe mode on an open front door, and drops --unsafe (safe + no key)', () => {
    const res = runEntrypoint({ BUNDLER_UNSAFE: 'false', GATE_REQUIRE_API_KEY: 'false' });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('--unsafe');
    expect(res.stdout).toContain('--auto');
  });
});

describe('BUN-B-001 generated config carries ERC-7562 reputation floors', () => {
  it('writes minStake=1e18 wei and minUnstakeDelay=86400 s', () => {
    const res = runEntrypoint({ BUNDLER_UNSAFE: 'false', GATE_REQUIRE_API_KEY: 'false' });
    expect(res.status).toBe(0);
    const cfg = JSON.parse(readFileSync(join(res.cfgDir, 'bundler.config.json'), 'utf8'));
    expect(cfg.minStake).toBe('1000000000000000000');
    expect(cfg.minUnstakeDelay).toBe(86400);
  });
});

describe('BUN-B-001 CI tripwire (check-config-floors.mjs)', () => {
  it('PASSES on the config the entrypoint actually generates', () => {
    // No arg → the checker generates via the entrypoint dry-run itself.
    const res = spawnSync('node', [CHECKER], { encoding: 'utf8', env: { ...process.env } });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OK/);
  });

  it('FAILS on the pre-fix insecure posture (RC-8 inversion fixture)', () => {
    // RC-8: this fixture ENCODES THE DEFECT (the pre-BUN-B-001 posture:
    // minStake=1 wei / minUnstakeDelay=0). It exists only to prove the
    // tripwire fires on it — it must NEVER be shipped as real config.
    const dir = mkdtempSync(join(tmpdir(), 'bun-insecure-'));
    const p = join(dir, 'bundler.config.json');
    writeFileSync(p, JSON.stringify({ minStake: '1', minUnstakeDelay: 0 }));
    const res = spawnSync('node', [CHECKER, p], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('minStake');
    expect(res.stderr).toContain('minUnstakeDelay');
    expect(res.stderr).toMatch(/below floor/);
  });
});

// Sanity: the entrypoint script must be syntactically valid sh.
describe('entrypoint script integrity', () => {
  it('passes `sh -n`', () => {
    expect(() => execFileSync('sh', ['-n', ENTRYPOINT])).not.toThrow();
  });
});
