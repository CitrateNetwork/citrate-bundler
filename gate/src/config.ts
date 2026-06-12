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
  /** Optional webhook for threshold alerts (Slack/Discord/ntfy-compatible JSON POST). */
  alertWebhookUrl?: string;
  /** Alert when the paymaster's EntryPoint deposit drops below this (wei). */
  paymasterDepositAlertWei: bigint;
  /** Alert when the operator EOA balance drops below this (wei). */
  operatorBalanceAlertWei: bigint;
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
    requireApiKey: (env.GATE_REQUIRE_API_KEY ?? 'false') === 'true',
    ipLimitPerMinute: intEnv(env.GATE_IP_LIMIT_PER_MINUTE, 60),
    keyLimitPerMinute: intEnv(env.GATE_KEY_LIMIT_PER_MINUTE, 600),
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
  };
}

function intEnv(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
