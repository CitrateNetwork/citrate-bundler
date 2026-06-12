/**
 * The bundler gate HTTP server (EW-S1 WP-4 slice B).
 *
 * Sits between Caddy and the eth-infinitism bundler:
 *
 *   POST /rpc      → API-key check (item 12) → per-IP/per-key rate
 *                    limit (item 13) → paymaster pre-check on
 *                    eth_sendUserOperation (item 14) → proxy upstream.
 *   GET  /metrics  → Prometheus exposition (R3 gate).
 *   GET  /healthz  → composite health: upstream bundler + Redis.
 *
 * Every request emits one structured-JSON log line.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Redis } from 'ioredis';

import { loadConfig, type GateConfig } from './config.js';
import { validateApiKey, type RedisLike } from './apikeys.js';
import { checkRateLimit, type RateLimitRedis } from './ratelimit.js';
import { precheckUserOp, type RpcUserOpLike } from './precheck.js';
import { createGateMetrics, type Metrics } from './metrics.js';
import { AlertWatcher } from './alerts.js';
import { log } from './log.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown[];
}

export interface GateDeps {
  config: GateConfig;
  redis: RedisLike & RateLimitRedis & { ping(): Promise<string> };
  metrics: Metrics;
}

const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function rpcError(
  res: ServerResponse,
  id: number | string | null,
  code: number,
  message: string,
): void {
  respondJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

function clientIp(req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m?.[1]?.trim();
}

/** Build the request handler (exported so tests drive it without sockets). */
export function createGateHandler(deps: GateDeps) {
  const { config, redis, metrics } = deps;

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const started = Date.now();

    if (req.method === 'GET' && req.url === '/healthz') {
      let redisOk = false;
      let upstreamOk = false;
      try {
        redisOk = (await redis.ping()) === 'PONG';
      } catch {
        redisOk = false;
      }
      try {
        const r = await fetch(config.upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
        });
        upstreamOk = r.ok;
      } catch {
        upstreamOk = false;
      }
      metrics.setGauge('bundler_gate_up', redisOk && upstreamOk ? 1 : 0);
      respondJson(res, redisOk && upstreamOk ? 200 : 503, {
        status: redisOk && upstreamOk ? 'ok' : 'degraded',
        redis: redisOk,
        upstream: upstreamOk,
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      respondJson(res, 404, { error: 'not_found' });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      rpcError(res, null, -32600, 'payload too large');
      return;
    }
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      rpcError(res, null, -32700, 'parse error');
      return;
    }
    const id = rpc.id ?? null;
    const method = rpc.method ?? 'unknown';
    const ip = clientIp(req);

    // ── API key (item 12) ──────────────────────────────────────────
    const key = bearerToken(req);
    let keyValid = false;
    if (key !== undefined) {
      keyValid = await validateApiKey(redis, key);
      if (!keyValid) {
        metrics.inc('bundler_gate_unauthorized_total');
        log('warn', 'invalid api key', { ip, method });
        rpcError(res, id, -32001, 'invalid API key');
        return;
      }
    } else if (config.requireApiKey) {
      metrics.inc('bundler_gate_unauthorized_total');
      log('warn', 'missing api key', { ip, method });
      rpcError(res, id, -32001, 'API key required (Authorization: Bearer bk_…)');
      return;
    }

    // ── Rate limits (item 13) ──────────────────────────────────────
    const ipLimit = await checkRateLimit(redis, 'ip', ip, config.ipLimitPerMinute);
    if (!ipLimit.allowed) {
      metrics.inc('bundler_gate_rate_limited_total', { bucket: 'ip' });
      log('warn', 'rate limited', { ip, method, bucket: 'ip', used: ipLimit.used });
      rpcError(res, id, -32005, 'rate limit exceeded (per-IP)');
      return;
    }
    if (keyValid && key !== undefined) {
      const keyLimit = await checkRateLimit(
        redis,
        'key',
        key.slice(0, 16), // bucket by key prefix; full key never indexes Redis
        config.keyLimitPerMinute,
      );
      if (!keyLimit.allowed) {
        metrics.inc('bundler_gate_rate_limited_total', { bucket: 'key' });
        log('warn', 'rate limited', { ip, method, bucket: 'key', used: keyLimit.used });
        rpcError(res, id, -32005, 'rate limit exceeded (per-key)');
        return;
      }
    }

    // ── Paymaster pre-check (item 14) ──────────────────────────────
    if (method === 'eth_sendUserOperation' && config.paymaster) {
      const op = (rpc.params?.[0] ?? {}) as RpcUserOpLike;
      const check = await precheckUserOp(
        {
          chainRpcUrl: config.chainRpcUrl,
          paymaster: config.paymaster,
          ...(config.entryPoint ? { entryPoint: config.entryPoint } : {}),
        },
        op,
      );
      if (!check.ok) {
        metrics.inc('bundler_gate_precheck_rejects_total');
        log('warn', 'paymaster precheck reject', { ip, sender: op.sender, reason: check.reason });
        rpcError(res, id, -32002, `paymaster precheck: ${check.reason}`);
        return;
      }
      if (check.reason) {
        log('warn', 'paymaster precheck degraded', { reason: check.reason });
      }
    }

    // ── Proxy upstream ─────────────────────────────────────────────
    try {
      const upstream = await fetch(config.upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      const body = await upstream.text();
      metrics.inc('bundler_gate_requests_total', {
        method,
        outcome: upstream.ok ? 'ok' : `http_${upstream.status}`,
      });
      log('info', 'rpc', {
        ip,
        method,
        status: upstream.status,
        ms: Date.now() - started,
        authed: keyValid,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(body);
    } catch (err) {
      metrics.inc('bundler_gate_upstream_errors_total');
      log('error', 'upstream unreachable', { method, err: String(err) });
      rpcError(res, id, -32003, 'bundler upstream unreachable');
    }
  };
}

// ── boot ────────────────────────────────────────────────────────────

export function main(): void {
  const config = loadConfig();
  const redis = new Redis(config.redisUrl);
  const metrics = createGateMetrics();

  const watcher = new AlertWatcher({
    chainRpcUrl: config.chainRpcUrl,
    ...(config.paymaster ? { paymaster: config.paymaster } : {}),
    ...(config.entryPoint ? { entryPoint: config.entryPoint } : {}),
    ...(config.operatorAddress ? { operatorAddress: config.operatorAddress } : {}),
    paymasterDepositAlertWei: config.paymasterDepositAlertWei,
    operatorBalanceAlertWei: config.operatorBalanceAlertWei,
    ...(config.alertWebhookUrl ? { alertWebhookUrl: config.alertWebhookUrl } : {}),
    metrics,
  });
  watcher.start();

  const handler = createGateHandler({ config, redis, metrics });
  const server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      log('error', 'handler crash', { err: String(err) });
      if (!res.headersSent) respondJson(res, 500, { error: 'internal' });
    });
  });
  server.listen(config.port, () => {
    log('info', 'bundler gate listening', {
      port: config.port,
      upstream: config.upstreamUrl,
      requireApiKey: config.requireApiKey,
    });
  });
}

// ESM entry check.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
