/**
 * Guard pins at the real entry points.
 *
 * Each test below fails when one specific guard is removed from the
 * production code, and passes with it in place. The existing suites cover
 * most guards at the helper level; these cover the wiring: the loadConfig
 * defaults the gate actually boots with, the gate handler's use of the
 * pre-check and metrics, the X-Forwarded-For hop choice, the outbound fetch
 * deadlines, and the entrypoint's ownership hand-off and privilege drop.
 *
 * Same fixture precedent as gate.test.ts: real local HTTP servers on
 * 127.0.0.1 and ioredis-mock. The entrypoint runs in dry-run mode in a temp
 * dir, with PATH shims for `id` and `chown` so the root-only branch can be
 * driven unprivileged without touching any real file ownership.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';

import { createGateHandler } from '../src/server.js';
import { createGateMetrics } from '../src/metrics.js';
import { loadConfig, type GateConfig } from '../src/config.js';
import { isTrustedProxy } from '../src/netmatch.js';
import { readAccountBalance, readPaymasterDeposit } from '../src/precheck.js';
import { AlertWatcher } from '../src/alerts.js';

const REGISTERED = '0x5ce327300221659b66323dc344c2275a7da756ff';
const PAYMASTER = '0x96bb6ca3b6a3e2e08a3557dfab6c7a29eb048373';
const ENTRY_POINT = '0x4a86659bdab24dc444c72fbbad4cd83491820e40';
const ONE_SALT = '0x' + '0'.repeat(48) + 'de0b6b3a7640000';
const ZERO_WORD = '0x' + '0'.repeat(64);

// ── fixtures ─────────────────────────────────────────────────────────

interface Rpc {
  server: Server;
  url: string;
  count: () => number;
}

function startRpc(respond: (method: string, params: unknown[]) => unknown): Promise<Rpc> {
  let n = 0;
  return new Promise((resolveP) => {
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
      resolveP({ server, url: `http://127.0.0.1:${port}`, count: () => n });
    });
  });
}

/** A server that accepts connections and never answers. */
async function startBlackHole(): Promise<{ server: Server; url: string }> {
  const server = createServer(() => {
    /* never responds */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

function chainWith(depositWord: string): (method: string, params: unknown[]) => unknown {
  return (method, params) => {
    if (method === 'eth_call') {
      const call = (params as [{ to: string; data: string }])[0];
      if (call.data.startsWith('0xc3c5a547')) {
        const queried = '0x' + call.data.slice(10 + 24);
        return queried.toLowerCase() === REGISTERED ? '0x' + '0'.repeat(63) + '1' : ZERO_WORD;
      }
      if (call.data.startsWith('0x70a08231')) return depositWord;
    }
    if (method === 'eth_getBalance') return '0x0';
    return '0x';
  };
}

let upstream: Rpc;
let chain: Rpc;
let emptyChain: Rpc;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  upstream = await startRpc((method) => {
    if (method === 'eth_chainId') return '0x9d0c';
    if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
    return null;
  });
  chain = await startRpc(chainWith(ONE_SALT));
  emptyChain = await startRpc(chainWith(ZERO_WORD));
});

afterAll(async () => {
  for (const s of [upstream?.server, chain?.server, emptyChain?.server]) {
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length > 0) await closers.pop()?.();
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
    selfServeKeys: false,
    ipLimitPerMinute: 60,
    keyLimitPerMinute: 600,
    precheckFailOpen: false,
    paymasterDepositAlertWei: 0n,
    operatorBalanceAlertWei: 0n,
    trustedProxies: [],
    ...overrides,
  };
}

async function startGate(config: GateConfig): Promise<string> {
  const handler = createGateHandler({
    config,
    redis: new RedisMock() as never,
    metrics: createGateMetrics(),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return (await res.json()) as never;
}

function sponsoredOp(sender = REGISTERED) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'eth_sendUserOperation',
    params: [{ sender, paymaster: PAYMASTER, paymasterData: '0x00' }, ENTRY_POINT],
  };
}

const PROD_ENV = {
  NODE_ENV: 'production',
  GATE_REDIS_URL: 'redis://x',
  CITRATE_AA_PAYMASTER: PAYMASTER,
  BUNDLER_ENTRYPOINT: ENTRY_POINT,
} as NodeJS.ProcessEnv;

// ── loadConfig: the defaults the gate actually boots with ───────────

describe('loadConfig security defaults', () => {
  it('fails the paymaster pre-check closed unless GATE_PRECHECK_FAIL_OPEN=true', () => {
    expect(loadConfig({ ...PROD_ENV }).precheckFailOpen).toBe(false);
    expect(loadConfig({ ...PROD_ENV, GATE_PRECHECK_FAIL_OPEN: 'yes' }).precheckFailOpen).toBe(false);
    expect(loadConfig({ ...PROD_ENV, GATE_PRECHECK_FAIL_OPEN: 'true' }).precheckFailOpen).toBe(true);
  });

  it('trusts only loopback and private ranges as proxies by default', () => {
    const { trustedProxies } = loadConfig({ ...PROD_ENV });
    // The compose bridge hop (Caddy -> gate) is trusted...
    expect(isTrustedProxy('172.18.0.5', trustedProxies)).toBe(true);
    expect(isTrustedProxy('127.0.0.1', trustedProxies)).toBe(true);
    // ...a public peer is not, so its forwarded headers are ignored.
    for (const pub of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '::ffff:198.51.100.1']) {
      expect(isTrustedProxy(pub, trustedProxies)).toBe(false);
    }
  });
});

// ── the gate handler's use of the paymaster pre-check ───────────────

describe('gate /rpc paymaster pre-check wiring', () => {
  it('rejects a sponsored op when the chain RPC is down and does not relay it', async () => {
    const gate = await startGate(makeConfig({ chainRpcUrl: 'http://127.0.0.1:1/' }));
    const before = upstream.count();
    const r = await post(gate, sponsoredOp());
    expect(r.error?.code).toBe(-32002);
    expect(upstream.count()).toBe(before);
  });

  it('relays it only when the operator configured fail-open (control)', async () => {
    const gate = await startGate(
      makeConfig({ chainRpcUrl: 'http://127.0.0.1:1/', precheckFailOpen: true }),
    );
    const r = await post(gate, sponsoredOp());
    expect(r.result).toBe('0x' + 'ab'.repeat(32));
  });

  it('rejects a sponsored op when the paymaster has no EntryPoint deposit', async () => {
    const gate = await startGate(makeConfig({ chainRpcUrl: emptyChain.url }));
    const before = upstream.count();
    const r = await post(gate, sponsoredOp());
    expect(r.error?.code).toBe(-32002);
    expect(r.error?.message).toMatch(/deposit/i);
    expect(upstream.count()).toBe(before);
  });

  it('relays the same op when the deposit is non-zero (control)', async () => {
    const gate = await startGate(makeConfig());
    const r = await post(gate, sponsoredOp());
    expect(r.result).toBe('0x' + 'ab'.repeat(32));
  });
});

// ── /metrics stays valid, bounded exposition ────────────────────────

// One sample line of the Prometheus text format: name, optional {labels}
// with properly escaped values, then a number.
const LABEL = String.raw`[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*"`;
const SAMPLE = new RegExp(
  String.raw`^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{${LABEL}(?:,${LABEL})*\})? -?[0-9.eE+-]+$`,
);

function assertValidExposition(text: string): string[] {
  const samples = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
  for (const line of samples) expect(line).toMatch(SAMPLE);
  return samples;
}

const FORGE = 'x"} 1\nbundler_gate_paymaster_deposit_salt 999\n#{y="';

describe('/metrics exposition', () => {
  it('a label value with quote and newline renders as one valid sample line', () => {
    const m = createGateMetrics();
    m.inc('bundler_gate_requests_total', { method: FORGE, outcome: 'ok' });
    const samples = assertValidExposition(m.render());
    expect(samples).toHaveLength(1);
    expect(samples.some((l) => l.startsWith('bundler_gate_paymaster_deposit_salt'))).toBe(false);
  });

  it('caller-chosen method strings never reach /metrics, and series stay bounded', async () => {
    const gate = await startGate(makeConfig());
    await post(gate, { jsonrpc: '2.0', id: 1, method: FORGE });
    for (let i = 0; i < 40; i++) {
      await post(gate, { jsonrpc: '2.0', id: 1, method: `junk_${i}` });
    }
    const text = await (await fetch(`${gate}/metrics`)).text();
    const samples = assertValidExposition(text);
    expect(text).not.toContain('junk_');
    expect(text).not.toContain('paymaster_deposit_salt 999');
    const requestSeries = samples.filter((l) => l.startsWith('bundler_gate_requests_total'));
    expect(requestSeries.length).toBeLessThanOrEqual(2);
  });
});

// ── X-Forwarded-For: take the hop the trusted proxy appended ────────

describe('X-Forwarded-For hop selection', () => {
  it('rotating the client-supplied left-most hop does not mint new buckets', async () => {
    const gate = await startGate(
      makeConfig({ ipLimitPerMinute: 1, trustedProxies: ['127.0.0.0/8'] }),
    );
    let limited = 0;
    for (let i = 0; i < 4; i++) {
      const r = await post(
        gate,
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
        { 'x-forwarded-for': `9.9.9.${i}, 203.0.113.7` },
      );
      if (r.error?.code === -32005) limited += 1;
    }
    expect(limited).toBe(3);
  });
});

// ── outbound calls carry a deadline ─────────────────────────────────

function captureFetchSignals(): Map<string, AbortSignal | undefined> {
  const seen = new Map<string, AbortSignal | undefined>();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    const method = /"method":"([^"]+)"/.exec(body)?.[1] ?? '?';
    seen.set(`${url}|${method}`, init?.signal ?? undefined);
    return real(input, init);
  });
  return seen;
}

describe('outbound fetch deadlines', () => {
  it('the /rpc proxy call to the upstream bundler carries an abort signal', async () => {
    const gate = await startGate(makeConfig());
    const seen = captureFetchSignals();
    const r = await post(gate, { jsonrpc: '2.0', id: 1, method: 'eth_chainId' });
    expect(r.result).toBe('0x9d0c');
    const sig = seen.get(`${upstream.url}|eth_chainId`);
    expect(sig).toBeInstanceOf(AbortSignal);
  });

  it('/healthz answers 503 (does not hang) when the upstream never responds', async () => {
    const hole = await startBlackHole();
    closers.push(
      () =>
        new Promise<void>((r) => {
          hole.server.closeAllConnections?.();
          hole.server.close(() => r());
        }),
    );
    const gate = await startGate(makeConfig({ upstreamUrl: hole.url }));
    const outcome = await Promise.race([
      fetch(`${gate}/healthz`).then((r) => r.status),
      new Promise<string>((r) => setTimeout(() => r('hung'), 8_000)),
    ]);
    expect(outcome).toBe(503);
  }, 12_000);

  it('the alert watcher balance reads carry an abort signal', async () => {
    const seen = captureFetchSignals();
    await readAccountBalance(chain.url, REGISTERED);
    await readPaymasterDeposit({ chainRpcUrl: chain.url, paymaster: PAYMASTER, entryPoint: ENTRY_POINT });
    expect(seen.get(`${chain.url}|eth_getBalance`)).toBeInstanceOf(AbortSignal);
    expect(seen.get(`${chain.url}|eth_call`)).toBeInstanceOf(AbortSignal);
  });

  it('the gate server bounds how long a client may take to send a request', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'server.ts'), 'utf8');
    const main = src.slice(src.indexOf('export function main'));
    expect(main).toMatch(/server\.requestTimeout\s*=\s*[1-9][0-9_]*;/);
    expect(main).toMatch(/server\.headersTimeout\s*=\s*[1-9][0-9_]*;/);
  });
});

// ── entrypoint: ownership hand-off and privilege drop ───────────────

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'citrate-bundler-entrypoint.sh');

function runEntrypointAsFakeRoot(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bun-own-'));
  const shims = join(dir, 'bin');
  const cfgDir = join(dir, 'cfg');
  const chownLog = join(dir, 'chown.log');
  spawnSync('mkdir', ['-p', shims]);
  // `id -u` reports root so the entrypoint takes its root-only branch;
  // `chown` only records its arguments. Nothing real is re-owned.
  writeFileSync(join(shims, 'id'), '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n');
  writeFileSync(join(shims, 'chown'), `#!/bin/sh\necho "$*" >> '${chownLog}'\n`);
  chmodSync(join(shims, 'id'), 0o755);
  chmodSync(join(shims, 'chown'), 0o755);
  const res = spawnSync('sh', [ENTRYPOINT], {
    env: {
      PATH: `${shims}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: dir,
      MNEMONIC: 'test test test test test test test test test test test junk',
      NETWORK: 'http://127.0.0.1:1',
      ENTRYPOINT: '0x0000000000000000000000000000000000000000',
      CITRATE_ENTRYPOINT_DRY_RUN: '1',
      BUNDLER_UNSAFE: 'false',
      GATE_REQUIRE_API_KEY: 'false',
      CFG_DIR: cfgDir,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  let chowns: string[] = [];
  try {
    chowns = readFileSync(chownLog, 'utf8').trim().split('\n');
  } catch {
    chowns = [];
  }
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr, chowns, cfgDir };
}

describe('entrypoint ownership hand-off (root branch)', () => {
  it('hands mnemonic.txt and bundler.config.json to the runtime user', () => {
    const r = runEntrypointAsFakeRoot();
    expect(r.status).toBe(0);
    expect(r.chowns).toContain(`node:node ${r.cfgDir}/mnemonic.txt`);
    expect(r.chowns).toContain(`node:node ${r.cfgDir}/bundler.config.json`);
  });

  it('honours CITRATE_RUNTIME_USER for the hand-off', () => {
    const r = runEntrypointAsFakeRoot({ CITRATE_RUNTIME_USER: 'bundler' });
    expect(r.status).toBe(0);
    expect(r.chowns).toContain(`bundler:bundler ${r.cfgDir}/mnemonic.txt`);
  });
});

/** The launch line must exec the bundler as the unprivileged runtime user. */
function execLines(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^exec\s/.test(l));
}
const DROPS_PRIVILEGE = /^exec su -s \/bin\/sh node -c "\$\{LAUNCH\}"$/;

describe('entrypoint privilege drop', () => {
  it('its only exec runs the bundler through su as `node`', () => {
    const lines = execLines(readFileSync(ENTRYPOINT, 'utf8'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(DROPS_PRIVILEGE);
  });

  it('negative control: a launch that keeps root is rejected by the check', () => {
    const lines = execLines('cd /app\nexec sh -c "${LAUNCH}"\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(DROPS_PRIVILEGE);
  });
});
