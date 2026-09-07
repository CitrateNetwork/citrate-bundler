/**
 * Threshold alerting (EW-S1 WP-4 slice B + sprint item 9's
 * low-balance hook). Self-contained: every `intervalMs` the watcher
 * reads the paymaster's EntryPoint deposit + the operator EOA balance,
 * updates the gauges, and POSTs a JSON alert to GATE_ALERT_WEBHOOK_URL
 * when a threshold is crossed (once per breach episode, re-armed when
 * the value recovers — no webhook spam).
 */

import { log } from './log.js';
import { weiToSalt, type Metrics } from './metrics.js';
import { readAccountBalance, readPaymasterDeposit } from './precheck.js';

export interface AlertWatcherArgs {
  chainRpcUrl: string;
  paymaster?: string;
  entryPoint?: string;
  operatorAddress?: string;
  paymasterDepositAlertWei: bigint;
  operatorBalanceAlertWei: bigint;
  alertWebhookUrl?: string;
  metrics: Metrics;
  intervalMs?: number;
}

export class AlertWatcher {
  private timer?: NodeJS.Timeout;
  private breached = new Set<string>();
  private ticking = false;

  constructor(private readonly args: AlertWatcherArgs) {}

  start(): void {
    const interval = this.args.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sampling pass — exported for tests. */
  async tick(): Promise<void> {
    // BUN-B-014: a chain RPC read that takes longer than the interval must not
    // let the next timer fire overlap this one (unbounded concurrent reads +
    // duplicated webhook work). Skip if a tick is already in flight.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.sample();
    } finally {
      this.ticking = false;
    }
  }

  private async sample(): Promise<void> {
    const { args } = this;
    if (args.paymaster && args.entryPoint) {
      try {
        const deposit = await readPaymasterDeposit({
          chainRpcUrl: args.chainRpcUrl,
          paymaster: args.paymaster,
          entryPoint: args.entryPoint,
        });
        args.metrics.setGauge('bundler_gate_paymaster_deposit_salt', weiToSalt(deposit));
        await this.threshold(
          'paymaster-deposit',
          deposit,
          args.paymasterDepositAlertWei,
          `CitratePaymaster EntryPoint deposit is ${deposit} wei (threshold ${args.paymasterDepositAlertWei}) — sponsored UserOps will start failing with AA31. Run FundPaymaster.s.sol.`,
        );
      } catch (err) {
        log('warn', 'paymaster deposit read failed', { err: String(err) });
      }
    }
    if (args.operatorAddress) {
      try {
        const balance = await readAccountBalance(args.chainRpcUrl, args.operatorAddress);
        args.metrics.setGauge('bundler_gate_operator_balance_salt', weiToSalt(balance));
        await this.threshold(
          'operator-balance',
          balance,
          args.operatorBalanceAlertWei,
          `Bundler operator ${args.operatorAddress} balance is ${balance} wei (threshold ${args.operatorBalanceAlertWei}) — batches will stop landing. Refill from the treasury.`,
        );
      } catch (err) {
        log('warn', 'operator balance read failed', { err: String(err) });
      }
    }
  }

  private async threshold(
    name: string,
    value: bigint,
    limit: bigint,
    message: string,
  ): Promise<void> {
    if (value >= limit) {
      if (this.breached.delete(name)) {
        log('info', `alert recovered: ${name}`, { value: value.toString() });
      }
      return;
    }
    if (this.breached.has(name)) return; // already alerted this episode
    this.breached.add(name);
    log('error', `ALERT ${name}`, { value: value.toString(), limit: limit.toString() });
    if (!this.args.alertWebhookUrl) return;
    try {
      await fetch(this.args.alertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'citrate-bundler-gate',
          alert: name,
          value: value.toString(),
          threshold: limit.toString(),
          text: message,
        }),
      });
    } catch (err) {
      log('error', 'alert webhook delivery failed', { err: String(err) });
    }
  }
}
