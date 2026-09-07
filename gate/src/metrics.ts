/**
 * Prometheus-text metrics (EW-S1 WP-4 slice B — the R3 gate: metrics
 * BEFORE any RP integrates). Counter/gauge registry kept in-process;
 * `/metrics` renders the exposition format. The droplet's scraper (or
 * a curl in a cron) consumes it — no client library needed.
 */

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const emitHelp = (series: string, type: 'counter' | 'gauge'): void => {
      const name = series.split('{')[0] ?? series;
      if (emitted.has(name)) return;
      emitted.add(name);
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    for (const [series, value] of [...this.counters.entries()].sort()) {
      emitHelp(series, 'counter');
      lines.push(`${series} ${value}`);
    }
    for (const [series, value] of [...this.gauges.entries()].sort()) {
      emitHelp(series, 'gauge');
      lines.push(`${series} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const rendered = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `${name}{${rendered}}`;
}

/**
 * BUN-B-007: escape a Prometheus label VALUE per the exposition spec —
 * backslash first, then double-quote and newline. Without this a value
 * containing a newline (and, before the server's method allow-list, an
 * attacker-controlled `method`) could append forged series to `/metrics`
 * (e.g. a fake `bundler_gate_paymaster_deposit_wei`). The allow-list is the
 * primary fix; this is defense-in-depth for every label value.
 */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * BUN-B-013: Prometheus gauges are IEEE-754 doubles, so a raw `Number(wei)`
 * loses precision above 2^53 wei (~0.009 SALT) — every realistic paymaster /
 * operator balance renders wrong in its low-order digits, and any dashboard
 * arithmetic (burn rate, days-of-runway) inherits the error. Export the value
 * in SALT with milli-SALT resolution instead, which is lossless for any
 * balance below ~9e15 SALT. The in-process alert comparison stays in bigint
 * (alerts.ts) and is unaffected.
 */
export function weiToSalt(wei: bigint): number {
  const milliSalt = wei / 10n ** 15n; // integer milli-SALT, stays < 2^53
  return Number(milliSalt) / 1000;
}

/** The gate's metric registry, pre-described. */
export function createGateMetrics(): Metrics {
  const m = new Metrics();
  m.describe('bundler_gate_requests_total', 'RPC requests by method and outcome');
  m.describe('bundler_gate_rate_limited_total', 'Requests rejected by the rate limiter');
  m.describe('bundler_gate_unauthorized_total', 'Requests rejected for a missing/invalid API key');
  m.describe('bundler_gate_precheck_rejects_total', 'UserOps rejected by the paymaster pre-check');
  m.describe('bundler_gate_upstream_errors_total', 'Upstream bundler transport failures');
  m.describe('bundler_gate_paymaster_deposit_salt', "CitratePaymaster's EntryPoint deposit (SALT, milli-SALT resolution)");
  m.describe('bundler_gate_operator_balance_salt', "Bundler operator EOA's native balance (SALT, milli-SALT resolution)");
  m.describe('bundler_gate_up', '1 when the gate believes upstream+redis are healthy');
  return m;
}
