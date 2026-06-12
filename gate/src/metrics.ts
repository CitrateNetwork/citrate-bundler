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
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
  return `${name}{${rendered}}`;
}

/** The gate's metric registry, pre-described. */
export function createGateMetrics(): Metrics {
  const m = new Metrics();
  m.describe('bundler_gate_requests_total', 'RPC requests by method and outcome');
  m.describe('bundler_gate_rate_limited_total', 'Requests rejected by the rate limiter');
  m.describe('bundler_gate_unauthorized_total', 'Requests rejected for a missing/invalid API key');
  m.describe('bundler_gate_precheck_rejects_total', 'UserOps rejected by the paymaster pre-check');
  m.describe('bundler_gate_upstream_errors_total', 'Upstream bundler transport failures');
  m.describe('bundler_gate_paymaster_deposit_wei', "CitratePaymaster's EntryPoint deposit");
  m.describe('bundler_gate_operator_balance_wei', "Bundler operator EOA's native balance");
  m.describe('bundler_gate_up', '1 when the gate believes upstream+redis are healthy');
  return m;
}
