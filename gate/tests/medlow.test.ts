/**
 * RM-Q MEDIUM + LOW remediation tripwires (2026-09-02 graded audit).
 *
 * Each block is red-test-first: it fails on the pre-fix code and passes on the
 * fix. Real local HTTP fixtures + ioredis-mock, same precedent as gate.test.ts.
 *
 * Covers: BUN-B-005 (prod API-key fail-closed), BUN-B-006 (precheck fail-closed
 * + strict hex), BUN-B-007 (metric label escaping), BUN-B-008 (healthz cache),
 * BUN-B-009 (trusted-proxy IP), BUN-B-012 (method allow-list), BUN-B-013 (SALT
 * gauge precision), BUN-B-014 (fetch timeout + alert in-flight guard),
 * CB-04 (POST / alias), CB-06 (API-key lifecycle).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';

import { createGateHandler } from '../src/server.js';
import { createGateMetrics, weiToSalt, escapeLabelValue } from '../src/metrics.js';
import { loadConfig, type GateConfig } from '../src/config.js';
import { precheckUserOp } from '../src/precheck.js';
import { isTrustedProxy } from '../src/netmatch.js';
import { AlertWatcher } from '../src/alerts.js';
import {
  mintApiKey,
  validateApiKey,
  revokeApiKeysByLabel,
  listApiKeys,
  hashApiKey,
} from '../src/apikeys.js';

const REGISTERED = '0x5ce327300221659b66323dc344c2275a7da756ff';
const PAYMASTER = '0x96bb6ca3b6a3e2e08a3557dfab6c7a29eb048373';
const ENTRY_POINT = '0x4a86659bdab24dc444c72fbbad4cd83491820e40';

// ── fixtures ─────────────────────────────────────────────────────────
let upstream: { server: Server; url: string; count: () => number };
let chain: { server: Server; url: string };

function startCountingRpc(
  respond: (method: string, params: unknown[]) => unknown,
): Promise<{ server: Server; url: string; count: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        n += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: respond(body.method, body.params ?? []) }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, count: () => n });
    });
  });
}

beforeAll(async () => {
  upstream = await startCountingRpc((method) => {
    if (method === 'eth_chainId') return '0x9d0c';
    if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
    return null;
  });
  chain = await startCountingRpc((method, params) => {
    if (method === 'eth_call') {
      const call = (params as [{ to: string; data: string }])[0];
      if (call.data.startsWith('0xc3c5a547')) {
        const queried = '0x' + call.data.slice(10 + 24);
        return queried.toLowerCase() === REGISTERED ? '0x' + '0'.repeat(63) + '1' : '0x' + '0'.repeat(64);
      }
      if (call.data.startsWith('0x70a08231')) return '0x' + '0'.repeat(48) + 'de0b6b3a7640000';
    }
    return '0x';
  });
});

afterAll(async () => {
  for (const s of [upstream?.server, chain?.server]) {
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

function makeConfig(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    port: 0,
    upstreamUrl: upstream.url,
    chainRpcUrl: chain.url,
    redisUrl: 'redis://mock',
    paymaster: PAYMASTER,
    entryPoint: ENTRY_POINT,
    requireApiKey: false,
    ipLimitPerMinute: 60,
    keyLimitPerMinute: 600,
    precheckFailOpen: false,
    paymasterDepositAlertWei: 0n,
    operatorBalanceAlertWei: 0n,
    trustedProxies: [],
    ...overrides,
  };
}

async function startGate(config: GateConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const redis = new RedisMock();
  const handler = createGateHandler({ config, redis: redis as never, metrics: createGateMetrics() });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ── BUN-B-005: API-key enforcement is fail-closed in production ──────
describe('BUN-B-005 production API-key enforcement', () => {
  const base = {
    NODE_ENV: 'production',
    GATE_REDIS_URL: 'redis://x',
    CITRATE_AA_PAYMASTER: PAYMASTER,
    BUNDLER_ENTRYPOINT: ENTRY_POINT,
  } as NodeJS.ProcessEnv;

  it('REFUSES to boot when GATE_REQUIRE_API_KEY=false and no risk acceptance', () => {
    expect(() => loadConfig({ ...base, GATE_REQUIRE_API_KEY: 'false' })).toThrow(/GATE_REQUIRE_API_KEY/);
  });

  it('defaults requireApiKey to true when unset', () => {
    expect(loadConfig({ ...base }).requireApiKey).toBe(true);
  });

  it('boots anonymous only with the explicit GATE_ALLOW_ANONYMOUS opt-out', () => {
    const cfg = loadConfig({ ...base, GATE_REQUIRE_API_KEY: 'false', GATE_ALLOW_ANONYMOUS: 'true' });
    expect(cfg.requireApiKey).toBe(false);
  });
});

// ── BUN-B-006: precheck fails closed + strict hex category byte ──────
describe('BUN-B-006 paymaster precheck', () => {
  it('rejects a malformed (non-hex) category byte instead of coercing it to 0', async () => {
    const r = await precheckUserOp(
      { chainRpcUrl: chain.url, paymaster: PAYMASTER, entryPoint: ENTRY_POINT },
      { sender: REGISTERED, paymaster: PAYMASTER, paymasterData: '0x0z' },
    );
    expect(r.ok).toBe(false);
  });

  it('fails CLOSED when the chain RPC is unreachable (default)', async () => {
    const r = await precheckUserOp(
      { chainRpcUrl: 'http://127.0.0.1:1/', paymaster: PAYMASTER, entryPoint: ENTRY_POINT },
      { sender: REGISTERED, paymaster: PAYMASTER, paymasterData: '0x00' },
    );
    expect(r.ok).toBe(false);
  });

  it('fails OPEN only when explicitly configured', async () => {
    const r = await precheckUserOp(
      { chainRpcUrl: 'http://127.0.0.1:1/', paymaster: PAYMASTER, entryPoint: ENTRY_POINT, failOpen: true },
      { sender: REGISTERED, paymaster: PAYMASTER, paymasterData: '0x00' },
    );
    expect(r.ok).toBe(true);
  });
});

// ── BUN-B-007: metric label values cannot inject new series ─────────
describe('BUN-B-007 metric label escaping', () => {
  it('escapes backslash, quote and newline in a label value', () => {
    expect(escapeLabelValue('a"b')).toBe('a\\"b');
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
  });

  it('a newline in a label value cannot forge a new exposition line', () => {
    const m = createGateMetrics();
    m.inc('bundler_gate_requests_total', {
      method: 'x"} 1\nbundler_gate_paymaster_deposit_salt 999',
    });
    const text = m.render();
    expect(text).not.toMatch(/^bundler_gate_paymaster_deposit_salt 999$/m);
  });
});

// ── BUN-B-008: /healthz collapses concurrent probes to one upstream hit
describe('BUN-B-008 healthz caching', () => {
  it('N concurrent /healthz requests produce at most one upstream probe', async () => {
    const before = upstream.count();
    const gate = await startGate(makeConfig());
    try {
      await Promise.all(Array.from({ length: 25 }, () => fetch(`${gate.url}/healthz`)));
      expect(upstream.count() - before).toBeLessThanOrEqual(1);
    } finally {
      await gate.close();
    }
  });
});

// ── BUN-B-009: rate-limit identity ignores spoofed headers from untrusted peers
describe('BUN-B-009 trusted-proxy IP derivation', () => {
  it('isTrustedProxy matches loopback + private CIDRs, rejects public', () => {
    const trusted = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12'];
    expect(isTrustedProxy('127.0.0.1', trusted)).toBe(true);
    expect(isTrustedProxy('::ffff:172.18.0.5', trusted)).toBe(true);
    expect(isTrustedProxy('8.8.8.8', trusted)).toBe(false);
  });

  it('an untrusted peer cannot mint a fresh bucket by rotating X-Real-IP', async () => {
    // trustedProxies empty ⇒ the 127.0.0.1 test socket is NOT trusted ⇒ all
    // requests count by socket address regardless of the spoofed header.
    const gate = await startGate(makeConfig({ ipLimitPerMinute: 2, trustedProxies: [] }));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${gate.url}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-real-ip': `9.9.9.${i}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
        });
        const body = (await res.json()) as { error?: { code: number } };
        if (body.error) codes.push(body.error.code);
      }
      expect(codes).toContain(-32005); // rate limited despite rotated header
    } finally {
      await gate.close();
    }
  });

  it('a trusted peer DOES honour X-Real-IP (separate buckets)', async () => {
    const gate = await startGate(makeConfig({ ipLimitPerMinute: 1, trustedProxies: ['127.0.0.0/8'] }));
    try {
      let limited = 0;
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${gate.url}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-real-ip': `9.9.9.${i}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
        });
        const body = (await res.json()) as { error?: { code: number } };
        if (body.error?.code === -32005) limited += 1;
      }
      expect(limited).toBe(0); // each distinct forwarded IP is its own bucket
    } finally {
      await gate.close();
    }
  });
});

// ── BUN-B-012: the gate refuses methods outside the ERC-4337 allow-list
describe('BUN-B-012 method allow-list', () => {
  it('rejects debug_bundler_sendBundleNow at the gate with -32601', async () => {
    const gate = await startGate(makeConfig());
    try {
      const res = await fetch(`${gate.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_bundler_sendBundleNow', params: [] }),
      });
      const body = (await res.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32601);
    } finally {
      await gate.close();
    }
  });

  it('still proxies an allow-listed method', async () => {
    const gate = await startGate(makeConfig());
    try {
      const res = await fetch(`${gate.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const body = (await res.json()) as { result?: string };
      expect(body.result).toBe('0x9d0c');
    } finally {
      await gate.close();
    }
  });
});

// ── BUN-B-013: balance gauges keep precision above 2^53 wei ─────────
describe('BUN-B-013 SALT gauge precision', () => {
  it('preserves precision where a raw Number(wei) is lossy', () => {
    // The pre-fix bug: wei bigints above 2^53 lose their low-order digits when
    // forced through IEEE-754 (the audit's PoC — 1 wei vanishes).
    expect(Number(10n ** 18n + 1n)).toBe(Number(10n ** 18n));
    // The fix keeps milli-SALT resolution exact.
    expect(weiToSalt(10n ** 20n)).toBe(100);
    expect(weiToSalt(10n ** 18n + 10n ** 15n)).toBe(1.001);
    expect(weiToSalt(123_456_789n * 10n ** 15n)).toBe(123456.789);
  });
});

// ── BUN-B-014: outbound calls time out; alert ticks don't overlap ───
describe('BUN-B-014 timeouts + alert in-flight guard', () => {
  it('precheck rejects (does not hang) when the chain accepts but never responds', async () => {
    const black = createServer(() => { /* never responds */ });
    await new Promise<void>((r) => black.listen(0, '127.0.0.1', r));
    const { port } = black.address() as AddressInfo;
    try {
      const r = await precheckUserOp(
        { chainRpcUrl: `http://127.0.0.1:${port}/`, paymaster: PAYMASTER, entryPoint: ENTRY_POINT },
        { sender: REGISTERED, paymaster: PAYMASTER, paymasterData: '0x00' },
      );
      expect(r.ok).toBe(false);
    } finally {
      await new Promise<void>((r) => black.close(() => r()));
    }
  }, 10_000);

  it('AlertWatcher.tick does not overlap with an in-flight tick', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowChain = createServer((req, res) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => {
        concurrent -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
      }, 80);
    });
    await new Promise<void>((r) => slowChain.listen(0, '127.0.0.1', r));
    const { port } = slowChain.address() as AddressInfo;
    const w = new AlertWatcher({
      chainRpcUrl: `http://127.0.0.1:${port}/`,
      operatorAddress: REGISTERED,
      paymasterDepositAlertWei: 0n,
      operatorBalanceAlertWei: 0n,
      metrics: createGateMetrics(),
    });
    try {
      await Promise.all([w.tick(), w.tick(), w.tick()]);
      expect(maxConcurrent).toBeLessThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => slowChain.close(() => r()));
    }
  }, 10_000);
});

// ── CB-04: the gate accepts POST / as an alias for /rpc ─────────────
describe('CB-04 root path alias', () => {
  it('POST / behaves like POST /rpc', async () => {
    const gate = await startGate(makeConfig());
    try {
      const res = await fetch(`${gate.url}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const body = (await res.json()) as { result?: string };
      expect(body.result).toBe('0x9d0c');
    } finally {
      await gate.close();
    }
  });
});

// ── CB-06: API-key lifecycle — label metadata + per-key revocation ──
describe('CB-06 API-key lifecycle', () => {
  it('stores label metadata on mint and revokes exactly one key by label', async () => {
    const redis = new RedisMock();
    const keyA = await mintApiKey(redis as never, 'rp-alpha');
    const keyB = await mintApiKey(redis as never, 'rp-beta');

    expect(await validateApiKey(redis as never, keyA)).toBe(true);
    expect(await validateApiKey(redis as never, keyB)).toBe(true);

    const meta = await listApiKeys(redis as never);
    expect(meta[hashApiKey(keyA)]?.label).toBe('rp-alpha');

    const revoked = await revokeApiKeysByLabel(redis as never, 'rp-alpha');
    expect(revoked).toBe(1);

    // Neutralising one leaked key does NOT flush the other.
    expect(await validateApiKey(redis as never, keyA)).toBe(false);
    expect(await validateApiKey(redis as never, keyB)).toBe(true);
    expect(await listApiKeys(redis as never)).not.toHaveProperty(hashApiKey(keyA));
  });
});
