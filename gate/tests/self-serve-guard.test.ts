// PBA-L3b-I04: self-serve `bk_` key minting must never be live while the
// bundler runs `--unsafe`.
//
// BUN-B-001 made `--unsafe` (no ERC-7562 opcode/storage/stake checking)
// conditional on a mandatory API key. That is only a control while keys are
// operator-issued. Once anyone can mint a `bk_` key for themselves, "API key
// required" is an anonymous front door with one extra step, and the funds-loss
// DoS BUN-B-001 closed (UserOps that pass off-chain simulation and revert
// on-chain, burning the operator EOA's gas) is back. So both the bundler
// entrypoint and the gate refuse to start with GATE_SELF_SERVE_KEYS=true while
// BUNDLER_UNSAFE=true. The tests drive the real entrypoint and the real
// config loader.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'citrate-bundler-entrypoint.sh');

const BASE_ENV = {
  MNEMONIC: 'test test test test test test test test test test test junk',
  NETWORK: 'https://rpc.citrate.ai',
  ENTRYPOINT: '0x0000000000000000000000000000000000000000',
  CITRATE_ENTRYPOINT_DRY_RUN: '1',
};

function runEntrypoint(extraEnv: Record<string, string>) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'bun-cfg-i04-'));
  const env: Record<string, string | undefined> = { ...process.env, ...BASE_ENV, CFG_DIR: cfgDir };
  delete env.GATE_SELF_SERVE_KEYS;
  return spawnSync('sh', [ENTRYPOINT], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
}

describe('PBA-L3b-I04 entrypoint guard', () => {
  it('REFUSES to start: --unsafe with self-serve keys, even with a mandatory key', () => {
    const res = runEntrypoint({
      BUNDLER_UNSAFE: 'true',
      GATE_REQUIRE_API_KEY: 'true',
      GATE_SELF_SERVE_KEYS: 'true',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/refusing to start/i);
    expect(res.stderr).toContain('PBA-L3b-I04');
  });

  it('starts: self-serve keys on a safe (non --unsafe) bundler', () => {
    const res = runEntrypoint({
      BUNDLER_UNSAFE: 'false',
      GATE_REQUIRE_API_KEY: 'true',
      GATE_SELF_SERVE_KEYS: 'true',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('--unsafe');
  });

  it('starts: --unsafe with operator-issued keys only (the shipped posture)', () => {
    for (const selfServe of [undefined, 'false']) {
      const res = runEntrypoint({
        BUNDLER_UNSAFE: 'true',
        GATE_REQUIRE_API_KEY: 'true',
        ...(selfServe === undefined ? {} : { GATE_SELF_SERVE_KEYS: selfServe }),
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('--unsafe');
    }
  });

  it('treats a set-but-empty value as on, agreeing with the gate', () => {
    const res = runEntrypoint({
      BUNDLER_UNSAFE: 'true',
      GATE_REQUIRE_API_KEY: 'true',
      GATE_SELF_SERVE_KEYS: '',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PBA-L3b-I04');
    expect(() =>
      loadConfig({
        GATE_REDIS_URL: 'redis://localhost:6379',
        NODE_ENV: 'test',
        BUNDLER_UNSAFE: 'true',
        GATE_SELF_SERVE_KEYS: '',
      }),
    ).toThrow(/PBA-L3b-I04/);
  });

  it('fails closed on a value it does not understand', () => {
    const res = runEntrypoint({
      BUNDLER_UNSAFE: 'true',
      GATE_REQUIRE_API_KEY: 'true',
      GATE_SELF_SERVE_KEYS: 'yes',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PBA-L3b-I04');
  });
});

describe('PBA-L3b-I04 gate config guard', () => {
  const base = { GATE_REDIS_URL: 'redis://localhost:6379' };

  it('throws in any environment when self-serve keys meet an --unsafe bundler', () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
      expect(() =>
        loadConfig({ ...base, NODE_ENV, BUNDLER_UNSAFE: 'true', GATE_SELF_SERVE_KEYS: 'true' }),
      ).toThrow(/PBA-L3b-I04/);
    }
    // The refusal names both ways out, so an operator can act on it.
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'test', BUNDLER_UNSAFE: 'true', GATE_SELF_SERVE_KEYS: 'true' }),
    ).toThrow(/anonymous front door[\s\S]*BUN-B-001[\s\S]*GATE_SELF_SERVE_KEYS=false[\s\S]*BUNDLER_UNSAFE=false/);
  });

  it('treats an unset BUNDLER_UNSAFE as unsafe (the compose default is true)', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', GATE_SELF_SERVE_KEYS: 'true' })).toThrow(
      /PBA-L3b-I04/,
    );
  });

  it('loads with self-serve keys on a safe bundler, and with operator-issued keys on an unsafe one', () => {
    const safe = loadConfig({ ...base, NODE_ENV: 'test', BUNDLER_UNSAFE: 'false', GATE_SELF_SERVE_KEYS: 'true' });
    expect(safe.selfServeKeys).toBe(true);
    const unsafe = loadConfig({ ...base, NODE_ENV: 'test', BUNDLER_UNSAFE: 'true' });
    expect(unsafe.selfServeKeys).toBe(false);
  });
});
