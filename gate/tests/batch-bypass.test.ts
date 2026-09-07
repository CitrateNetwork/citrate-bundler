/**
 * BUN-B-002 tripwire (RC-8, red-first) — JSON-RPC batch policy bypass.
 *
 * A JSON-RPC *batch* (top-level array) makes `rpc.method` undefined at the
 * gate, so the method allow-list + paymaster pre-check are skipped and the
 * gate proxies the raw array verbatim to an upstream that loops over every
 * element (`BundlerServer.rpc()` → `if (Array.isArray(req.body)) …`). The
 * effect is (1) sponsored UserOperations that the paymaster pre-check would
 * reject are relayed, and (2) one rate-limit tick becomes N upstream ops —
 * up to ~3400 per 256 KiB request.
 *
 * The upstream fixture below reproduces `BundlerServer.rpc()`'s array branch
 * verbatim and COUNTS the operations it executes. The invariant asserted is
 * the one named in the finding: `rate-limit debits == operations forwarded`.
 *
 * On the UNFIXED gate this file is RED: the batch is forwarded, the upstream
 * executes both ops (incl. the unregistered sponsored op), and 1 debit != 2
 * forwarded. On the FIXED gate the batch is refused with -32600, nothing is
 * forwarded, and the invariant holds at 0 == 0.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';

import { createGateHandler } from '../src/server.js';
import { createGateMetrics } from '../src/metrics.js';
import type { GateConfig } from '../src/config.js';

const REGISTERED = '0x5ce327300221659b66323dc344c2275a7da756ff';
const PAYMASTER = '0x96bb6ca3b6a3e2e08a3557dfab6c7a29eb048373';
const ENTRY_POINT = '0x4a86659bdab24dc444c72fbbad4cd83491820e40';
const ATTACKER = '0x' + '99'.repeat(20);

// ── upstream bundler fixture that mirrors BundlerServer.rpc() ─────────
// Counts every JSON-RPC operation it is asked to execute — including each
// element of an array body — so the test can measure amplification.
let opsExecuted = 0;
let sponsoredOpsExecuted = 0;

function handleOne(item: { method?: string; id?: unknown }): unknown {
  opsExecuted += 1;
  if (item.method === 'eth_sendUserOperation') sponsoredOpsExecuted += 1;
  const result =
    item.method === 'eth_chainId'
      ? '0x9d0c'
      : item.method === 'eth_sendUserOperation'
        ? '0x' + 'ab'.repeat(32)
        : null;
  return { jsonrpc: '2.0', id: item.id ?? null, result };
}

let upstream: { server: Server; url: string };
let chain: { server: Server; url: string };
let gateServer: Server;
let gateUrl: string;
let redis: InstanceType<typeof RedisMock>;

function startServer(handler: (req: unknown) => unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(handler(body)));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function ipDebits(): Promise<number> {
  const keys = await redis.keys('bundler:rl:ip:*');
  let sum = 0;
  for (const k of keys) sum += Number(await redis.get(k)) || 0;
  return sum;
}

beforeAll(async () => {
  upstream = await startServer((body) => {
    // Verbatim upstream behaviour: array bodies are handled element-by-element.
    if (Array.isArray(body)) return body.map(handleOne);
    return handleOne(body as { method?: string; id?: unknown });
  });
  chain = await startServer((body) => {
    const b = body as { method?: string; params?: unknown[]; id?: unknown };
    let result: unknown = '0x';
    if (b.method === 'eth_call') {
      const call = (b.params?.[0] ?? {}) as { data?: string };
      if (call.data?.startsWith('0xc3c5a547')) {
        // isRegistered(address): only REGISTERED is registered.
        const queried = '0x' + call.data.slice(10 + 24);
        result =
          queried.toLowerCase() === REGISTERED
            ? '0x' + '0'.repeat(63) + '1'
            : '0x' + '0'.repeat(64);
      } else if (call.data?.startsWith('0x70a08231')) {
        result = '0x' + '0'.repeat(48) + 'de0b6b3a7640000';
      }
    }
    return { jsonrpc: '2.0', id: b.id ?? null, result };
  });
  redis = new RedisMock();
  await redis.flushall();

  const config: GateConfig = {
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
  };
  const handler = createGateHandler({
    config,
    redis: redis as never,
    metrics: createGateMetrics(),
  });
  await new Promise<void>((resolve) => {
    gateServer = createServer((req, res) => void handler(req, res));
    gateServer.listen(0, '127.0.0.1', () => {
      const { port } = gateServer.address() as AddressInfo;
      gateUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const s of [gateServer, upstream.server, chain.server]) {
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

it('refuses a JSON-RPC batch so policy cannot be bypassed and one tick cannot amplify', async () => {
  opsExecuted = 0;
  sponsoredOpsExecuted = 0;

  // A 2-element batch: one policy-violating sponsored op from an UNREGISTERED
  // sender (the pre-check would reject it alone) + one innocuous read.
  const batch = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendUserOperation',
      params: [{ sender: ATTACKER, paymaster: PAYMASTER, paymasterData: '0x00' }, ENTRY_POINT],
    },
    { jsonrpc: '2.0', id: 2, method: 'eth_chainId' },
  ];

  const res = await fetch(`${gateUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  const body = (await res.json()) as { error?: { code: number } };

  // (a) The batch is rejected at the edge.
  expect(body.error?.code).toBe(-32600);
  // (b) Nothing was forwarded upstream — no amplification, no money-path relay.
  expect(opsExecuted).toBe(0);
  // (c) The unregistered sponsored op never reached the upstream bundler.
  expect(sponsoredOpsExecuted).toBe(0);
  // (d) Invariant: rate-limit debits == operations forwarded (0 == 0 here;
  //     the unfixed gate debits 1 while forwarding 2 — a 1 != 2 violation).
  expect(await ipDebits()).toBe(opsExecuted);
});

it('still proxies a single non-batch operation normally', async () => {
  opsExecuted = 0;
  const res = await fetch(`${gateUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_chainId' }),
  });
  const body = (await res.json()) as { result?: unknown };
  expect(body.result).toBe('0x9d0c');
  expect(opsExecuted).toBe(1);
});
