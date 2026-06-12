/**
 * Structured JSON logging (EW-S1 WP-4 slice B — sprint item 14).
 * One JSON object per line to stdout; `docker compose logs` and any
 * shipper (vector/loki) consume it without parsing config.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    service: 'bundler-gate',
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}
