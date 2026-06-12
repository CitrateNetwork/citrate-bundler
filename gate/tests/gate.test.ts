/**
 * EW-S1 WP-4 slice B — gate behaviour tests.
 *
 * Red-test-first per the SECREM WP protocol. No mocks of OUR logic:
 * the upstream bundler is a REAL local JSON-RPC HTTP server started by
 * the test (returning chain 40204 responses), and Redis is the
 * ioredis-mock engine (same precedent as citrate-identity's
 * session-bus tests). The chain RPC for prechecks is likewise a real
 * local server speaking eth_call.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';

import { createGateHandler } from '../src/server.js';
import { createGateMetrics } from '../src/metrics.js';
import { mintApiKey, validateApiKey, hashApiKey, API_KEY_SET } from '../src/apikeys.js';
import { checkRateLimit } from '../src/ratelimit.js';
import { precheckUserOp } from '../src/precheck.js';
import type { GateConfig } from '../src/config.js';

// ── real local upstream bundler fixture ──────────────────────────────

function startJsonRpcServer(
  respond: (method: string, params: unknown[]) => unknown,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = respond(body.method, body.params ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Registered-wallet fixture used by the precheck chain server.
const REGISTERED = '0x5ce327300221659b66323dc344c2275a7da756ff';
const PAYMASTER = '0x96bb6ca3b6a3e2e08a3557dfab6c7a29eb048373';
const ENTRY_POINT = '0x4a86659bdab24dc444c72fbbad4cd83491820e40';

let upstream: { server: Server; url: string };
let chain: { server: Server; url: string };
let gateUrl: string;
let gateServer: Server;
let redis: InstanceType<typeof RedisMock>;

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
    paymasterDepositAlertWei: 0n,
    operatorBalanceAlertWei: 0n,
    ...overrides,
  };
}

async function startGate(config: GateConfig): Promise<void> {
  const handler = createGateHandler({
    config,
    redis: redis as never,
    metrics: createGateMetrics(),
  });
  await new Promise<void>((resolve) => {
    gateServer = createServer((req, res) => {
      void handler(req, res);
    });
    gateServer.listen(0, '127.0.0.1', () => {
      const { port } = gateServer.address() as AddressInfo;
      gateUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  upstream = await startJsonRpcServer((method) => {
    if (method === 'eth_chainId') return '0x9d0c';
    if (method === 'eth_supportedEntryPoints') return [ENTRY_POINT];
    if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
    return null;
  });
  chain = await startJsonRpcServer((method, params) => {
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      if (call.data.startsWith('0xc3c5a547')) {
        // isRegistered(address): true only for REGISTERED.
        const queried = '0x' + call.data.slice(10 + 24);
        return queried.toLowerCase() === REGISTERED
          ? '0x' + '0'.repeat(63) + '1'
          : '0x' + '0'.repeat(64);
      }
      if (call.data.startsWith('0x70a08231')) {
        // balanceOf(paymaster): non-zero deposit.
        return '0x' + '0'.repeat(48) + 'de0b6b3a7640000'; // 1e18
      }
    }
    return '0x';
  });
  redis = new RedisMock();
});

afterAll(async () => {
  for (const s of [gateServer, upstream.server, chain.server]) {
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

async function rpc(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { result?: unknown; error?: { code: number; message: string } } }> {
  const res = await fetch(`${gateUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('API keys (item 12)', () => {
  it('mints bk_ keys, stores only the hash, validates round-trip', async () => {
    const key = await mintApiKey(redis as never);
    expect(key.startsWith('bk_')).toBe(true);
    expect(await validateApiKey(redis as never, key)).toBe(true);
    expect(await validateApiKey(redis as never, 'bk_' + 'x'.repeat(40))).toBe(false);
    // Plaintext never stored: the set holds the SHA-256 only.
    const members = await redis.smembers(API_KEY_SET);
    expect(members).toContain(hashApiKey(key));
    expect(members).not.toContain(key);
  });
});

describe('rate limiting (item 13)', () => {
  it('caps a bucket within the window and fails CLOSED on Redis errors', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(redis as never, 't', 'ip1', 3, 1_000_000);
      expect(r.allowed).toBe(true);
    }
    const fourth = await checkRateLimit(redis as never, 't', 'ip1', 3, 1_000_000);
    expect(fourth.allowed).toBe(false);

    const broken = {
      incr: async () => {
        throw new Error('redis down');
      },
      expire: async () => 1,
    };
    const closed = await checkRateLimit(broken, 't', 'ip2', 3);
    expect(closed.allowed).toBe(false);
  });
});

describe('paymaster precheck (item 14)', () => {
  it('passes self-paid ops, rejects unregistered senders + bad categories', async () => {
    const cfg = { chainRpcUrl: chain.url, paymaster: PAYMASTER, entryPoint: ENTRY_POINT };

    expect((await precheckUserOp(cfg, { sender: '0x1' })).ok).toBe(true); // no paymaster field

    const registered = await precheckUserOp(cfg, {
      sender: REGISTERED,
      paymaster: PAYMASTER,
      paymasterData: '0x00',
    });
    expect(registered.ok).toBe(true);

    const unregistered = await precheckUserOp(cfg, {
      sender: '0x' + '99'.repeat(20),
      paymaster: PAYMASTER,
      paymasterData: '0x00',
    });
    expect(unregistered.ok).toBe(false);
    expect(unregistered.reason).toContain('not a registered');

    const badCategory = await precheckUserOp(cfg, {
      sender: REGISTERED,
      paymaster: PAYMASTER,
      paymasterData: '0x07',
    });
    expect(badCategory.ok).toBe(false);

    const noTag = await precheckUserOp(cfg, {
      sender: REGISTERED,
      paymaster: PAYMASTER,
    });
    expect(noTag.ok).toBe(false);
  });
});

describe('the gate end-to-end (real upstream fixture)', () => {
  it('proxies allowed RPC to the upstream bundler', async () => {
    await startGate(makeConfig());
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('0x9d0c');
  });

  it('rejects eth_sendUserOperation for an unregistered sender at the edge', async () => {
    const r = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_sendUserOperation',
      params: [
        {
          sender: '0x' + '99'.repeat(20),
          paymaster: PAYMASTER,
          paymasterData: '0x00',
        },
        ENTRY_POINT,
      ],
    });
    expect(r.body.error?.code).toBe(-32002);
    expect(r.body.error?.message).toContain('precheck');
  });

  it('relays a precheck-passing sponsored op', async () => {
    const r = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_sendUserOperation',
      params: [
        { sender: REGISTERED, paymaster: PAYMASTER, paymasterData: '0x00' },
        ENTRY_POINT,
      ],
    });
    expect(r.body.result).toBe('0x' + 'ab'.repeat(32));
  });

  it('enforces requireApiKey and accepts a minted key', async () => {
    await new Promise<void>((r) => gateServer.close(() => r()));
    await startGate(makeConfig({ requireApiKey: true }));

    const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'eth_chainId' });
    expect(denied.body.error?.code).toBe(-32001);

    const key = await mintApiKey(redis as never);
    const allowed = await rpc(
      { jsonrpc: '2.0', id: 5, method: 'eth_chainId' },
      { authorization: `Bearer ${key}` },
    );
    expect(allowed.body.result).toBe('0x9d0c');

    const badKey = await rpc(
      { jsonrpc: '2.0', id: 6, method: 'eth_chainId' },
      { authorization: 'Bearer bk_not-a-real-key-aaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    expect(badKey.body.error?.code).toBe(-32001);
  });

  it('rate-limits per IP and reports /metrics + /healthz', async () => {
    await new Promise<void>((r) => gateServer.close(() => r()));
    // Clear the per-IP counters accumulated by the earlier requests in
    // this window so the limit boundary is exact.
    await redis.flushall();
    await startGate(makeConfig({ ipLimitPerMinute: 2 }));

    await rpc({ jsonrpc: '2.0', id: 7, method: 'eth_chainId' });
    await rpc({ jsonrpc: '2.0', id: 8, method: 'eth_chainId' });
    const limited = await rpc({ jsonrpc: '2.0', id: 9, method: 'eth_chainId' });
    expect(limited.body.error?.code).toBe(-32005);

    const metricsRes = await fetch(`${gateUrl}/metrics`);
    const text = await metricsRes.text();
    expect(metricsRes.status).toBe(200);
    expect(text).toContain('bundler_gate_rate_limited_total');
    expect(text).toContain('bundler_gate_requests_total');

    const health = await fetch(`${gateUrl}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; redis: boolean; upstream: boolean };
    expect(body.upstream).toBe(true);
  });
});
