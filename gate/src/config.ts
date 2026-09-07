/**
 * Gate configuration (EW-S1 WP-4 slice B).
 *
 * Same fail-closed posture as citrate-identity's
 * `assertProductionConfig`: in production (NODE_ENV=production) any
 * missing security-relevant value aborts boot with a named error; in
 * dev the gaps degrade to warnings with safe defaults.
 */

export interface GateConfig {
  /** Port the gate listens on inside the compose network. */
  port: number;
  /** Upstream eth-infinitism bundler JSON-RPC. */
  upstreamUrl: string;
  /** Chain JSON-RPC for paymaster pre-checks + balance gauges. */
  chainRpcUrl: string;
  /** Redis URL for API keys + rate-limit counters. */
  redisUrl: string;
  /** CitratePaymaster address (pre-check + deposit gauge). */
  paymaster?: string;
  /** EntryPoint v0.7 (deposit lookups). */
  entryPoint?: string;
  /** Bundler operator EOA (balance gauge + low-balance alert). */
  operatorAddress?: string;
  /**
   * Whether an API key is REQUIRED on /rpc. Keyless mode still
   * rate-limits per IP, at the anonymous (lower) limits.
   */
  requireApiKey: boolean;
  /** Per-IP requests per minute (anonymous callers). */
  ipLimitPerMinute: number;
  /** Per-key requests per minute (authenticated callers). */
  keyLimitPerMinute: number;
  /**
   * BUN-B-006: when the chain RPC is unreachable during the paymaster
   * pre-check, skip the check (true) or reject the op (false). Defaults to
   * false (fail closed) — the pre-check is a cost control.
   */
  precheckFailOpen: boolean;
  /** Optional webhook for threshold alerts (Slack/Discord/ntfy-compatible JSON POST). */
  alertWebhookUrl?: string;
  /** Alert when the paymaster's EntryPoint deposit drops below this (wei). */
  paymasterDepositAlertWei: bigint;
  /** Alert when the operator EOA balance drops below this (wei). */
  operatorBalanceAlertWei: bigint;
  /**
   * Socket peers (IPs / CIDRs) whose `X-Real-IP` / `X-Forwarded-For`
   * headers the rate limiter is allowed to trust (BUN-B-009). Any other
   * peer is counted by its raw socket address, so a header spoof from an
   * untrusted origin cannot mint a fresh rate-limit bucket.
   */
  trustedProxies: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const isProd = env.NODE_ENV === 'production';
  const problems: string[] = [];

  const redisUrl = env.GATE_REDIS_URL ?? '';
  if (!redisUrl) {
    problems.push('GATE_REDIS_URL is unset (API keys + rate limits need Redis)');
  }
  const paymaster = env.CITRATE_AA_PAYMASTER?.trim();
  if (!paymaster) {
    problems.push(
      'CITRATE_AA_PAYMASTER is unset (paymaster pre-check disabled — sponsored ops will hit the chain blind)',
    );
  }
  const entryPoint = env.BUNDLER_ENTRYPOINT?.trim();
  if (!entryPoint) {
    problems.push('BUNDLER_ENTRYPOINT is unset (deposit gauge disabled)');
  }

  // BUN-B-005: API-key enforcement must be a security-relevant value in the
  // production fail-closed guard, not a silent `?? 'false'` default. The
  // production template ships GATE_REQUIRE_API_KEY=true; but if an operator
  // omits it, the gate would otherwise boot ANONYMOUS on the money path (any
  // client ≤60 req/min into a bundler that may be running --unsafe). We now
  // default it to true and refuse to boot open in production unless the
  // operator has EXPLICITLY accepted the risk with GATE_ALLOW_ANONYMOUS=true
  // (e.g. a safe bundler behind a private ingress). Same shape as the
  // entrypoint's BUN-B-001 boot guard: refuse the dangerous combo, allow a
  // named opt-out.
  const requireApiKey = (env.GATE_REQUIRE_API_KEY ?? 'true') === 'true';
  const allowAnonymous = (env.GATE_ALLOW_ANONYMOUS ?? 'false') === 'true';
  if (isProd && !requireApiKey && !allowAnonymous) {
    problems.push(
      'GATE_REQUIRE_API_KEY=false in production without GATE_ALLOW_ANONYMOUS=true — ' +
        'the /rpc money path would accept anonymous callers. Set ' +
        'GATE_REQUIRE_API_KEY=true, or set GATE_ALLOW_ANONYMOUS=true to accept the risk.',
    );
  }

  if (isProd && problems.length > 0) {
    throw new Error(
      'Refusing to start the bundler gate in production with unsafe config:\n  - ' +
        problems.join('\n  - '),
    );
  }
  for (const p of problems) {
    // eslint-disable-next-line no-console
    console.warn(`[bundler-gate] config warning: ${p}`);
  }

  return {
    port: intEnv(env.GATE_PORT, 3001),
    upstreamUrl: env.GATE_UPSTREAM_URL ?? 'http://bundler:3000/rpc',
    chainRpcUrl: env.BUNDLER_NETWORK_RPC ?? 'https://rpc.citrate.ai',
    redisUrl: redisUrl || 'redis://localhost:6379',
    ...(paymaster ? { paymaster } : {}),
    ...(entryPoint ? { entryPoint } : {}),
    ...(env.BUNDLER_OPERATOR_ADDRESS
      ? { operatorAddress: env.BUNDLER_OPERATOR_ADDRESS.trim() }
      : {}),
    requireApiKey,
    ipLimitPerMinute: intEnv(env.GATE_IP_LIMIT_PER_MINUTE, 60),
    keyLimitPerMinute: intEnv(env.GATE_KEY_LIMIT_PER_MINUTE, 600),
    precheckFailOpen: (env.GATE_PRECHECK_FAIL_OPEN ?? 'false') === 'true',
    ...(env.GATE_ALERT_WEBHOOK_URL
      ? { alertWebhookUrl: env.GATE_ALERT_WEBHOOK_URL.trim() }
      : {}),
    paymasterDepositAlertWei: bigintEnv(
      env.GATE_PAYMASTER_DEPOSIT_ALERT_WEI,
      // 1 SALT — roughly 10k sponsored ops of headroom at testnet prices.
      10n ** 18n,
    ),
    operatorBalanceAlertWei: bigintEnv(
      env.GATE_OPERATOR_BALANCE_ALERT_WEI,
      10n * 10n ** 18n, // 10 SALT
    ),
    // BUN-B-009: default to the private/loopback ranges the compose network
    // uses, so the shipped Caddy→gate hop (a docker bridge IP) is trusted and
    // its X-Real-IP is honoured, while any non-private direct peer to :3001 is
    // counted by socket address (its forwarded headers are ignored).
    trustedProxies: listEnv(
      env.GATE_TRUSTED_PROXIES,
      ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    ),
  };
}

function intEnv(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function listEnv(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined || v.trim() === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function bigintEnv(v: string | undefined, fallback: bigint): bigint {
  if (v === undefined || v.trim() === '') return fallback;
  try {
    const n = BigInt(v.trim());
    return n >= 0n ? n : fallback;
  } catch {
    return fallback;
  }
}
