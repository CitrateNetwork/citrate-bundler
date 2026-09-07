/**
 * Off-chain paymaster pre-check (EW-S1 WP-4 slice B — sprint item 14).
 *
 * Before relaying an `eth_sendUserOperation` that names the
 * CitratePaymaster, ask the chain whether the op has any chance of
 * passing `_validatePaymasterUserOp`, so doomed ops are rejected at
 * the edge with a precise reason instead of burning a bundler slot:
 *
 *   - sender must be `isRegistered` on the paymaster
 *   - the paymaster must hold a non-zero EntryPoint deposit
 *   - the category byte must be a known category
 *
 * Data sources: `CitratePaymaster.isRegistered(address)` +
 * `EntryPoint.balanceOf(address)` via eth_call on BUNDLER_NETWORK_RPC.
 */

// Selectors computed from the canonical signatures (cast sig):
//   isRegistered(address)  → 0xc3c5a547
//   balanceOf(address)     → 0x70a08231
const SEL_IS_REGISTERED = '0xc3c5a547';
const SEL_BALANCE_OF = '0x70a08231';

export interface PrecheckArgs {
  chainRpcUrl: string;
  paymaster: string;
  entryPoint?: string;
  /**
   * BUN-B-006: whether a chain-RPC error should skip the pre-check (fail OPEN)
   * or reject the op (fail CLOSED). The pre-check is a COST control — with a
   * bundler that submits one on-chain `handleOps` per op, a skipped check means
   * the operator EOA pays gas for ops that on-chain validation will reject.
   * Defaults to fail CLOSED; set true only as a deliberate, recorded risk
   * acceptance (availability over cost).
   */
  failOpen?: boolean;
}

/** BUN-B-014: bound each chain read so a slow/wedged RPC cannot pin the handler. */
const CHAIN_CALL_TIMEOUT_MS = 5_000;

export interface RpcUserOpLike {
  sender?: string;
  paymaster?: string;
  paymasterData?: string;
}

export interface PrecheckResult {
  ok: boolean;
  reason?: string;
}

async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(CHAIN_CALL_TIMEOUT_MS),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result ?? '0x';
}

function pad32(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

/**
 * Pre-check a UserOperation that names OUR paymaster. Ops paying their
 * own gas (no paymaster field) pass through untouched. Chain
 * unreachability fails CLOSED by default (BUN-B-006) — the pre-check is a
 * cost control on a bundler that submits one on-chain tx per op, so a
 * skipped check is a paid-for revert; set `failOpen` to trade that cost
 * risk for availability.
 */
export async function precheckUserOp(
  cfg: PrecheckArgs,
  op: RpcUserOpLike,
): Promise<PrecheckResult> {
  if (!op.paymaster || op.paymaster.toLowerCase() !== cfg.paymaster.toLowerCase()) {
    return { ok: true };
  }
  if (!op.sender) {
    return { ok: false, reason: 'userOp.sender missing' };
  }
  // BUN-B-006: validate the whole field is 0x-prefixed hex with at least one
  // byte BEFORE parsing the category — `parseInt('0z', 16)` silently yields 0,
  // so a malformed category byte would otherwise pass the `category > 2` guard.
  if (!op.paymasterData || !/^0x[0-9a-fA-F]{2,}$/.test(op.paymasterData)) {
    return {
      ok: false,
      reason: 'paymasterData must be 0x-prefixed hex carrying the CitratePaymaster category byte',
    };
  }
  const category = parseInt(op.paymasterData.slice(2, 4), 16);
  if (Number.isNaN(category)) {
    return {
      ok: false,
      reason: 'paymasterData must carry the CitratePaymaster category byte',
    };
  }
  if (category > 2) {
    return { ok: false, reason: `unknown paymaster category ${category}` };
  }

  try {
    const registered = await ethCall(
      cfg.chainRpcUrl,
      cfg.paymaster,
      SEL_IS_REGISTERED + pad32(op.sender),
    );
    if (BigInt(registered === '0x' ? '0x0' : registered) === 0n) {
      return {
        ok: false,
        reason: `sender ${op.sender} is not a registered Citrate wallet on the paymaster`,
      };
    }
    if (cfg.entryPoint) {
      const deposit = await ethCall(
        cfg.chainRpcUrl,
        cfg.entryPoint,
        SEL_BALANCE_OF + pad32(cfg.paymaster),
      );
      if (BigInt(deposit === '0x' ? '0x0' : deposit) === 0n) {
        return {
          ok: false,
          reason: 'paymaster has no EntryPoint deposit (AA31 would follow)',
        };
      }
    }
    return { ok: true };
  } catch (err) {
    // BUN-B-006: default fail CLOSED. Correctness is not the concern (the
    // EntryPoint re-validates on-chain); COST is — a skipped pre-check on a
    // one-op-per-tx bundler burns operator gas on ops the chain will reject,
    // and an attacker can force the RPC error by hammering the same chain RPC
    // the pre-check calls. Only skip (fail open) when explicitly configured.
    const reason = `precheck unavailable (chain unreachable: ${(err as Error).message})`;
    if (cfg.failOpen) {
      return { ok: true, reason: `${reason} — failing open per config` };
    }
    return { ok: false, reason };
  }
}

/** Read the paymaster's EntryPoint deposit (metrics gauge + alerts). */
export async function readPaymasterDeposit(cfg: {
  chainRpcUrl: string;
  paymaster: string;
  entryPoint: string;
}): Promise<bigint> {
  const deposit = await ethCall(
    cfg.chainRpcUrl,
    cfg.entryPoint,
    SEL_BALANCE_OF + pad32(cfg.paymaster),
  );
  return BigInt(deposit === '0x' ? '0x0' : deposit);
}

/** Read a plain account balance (operator gauge + alerts). */
export async function readAccountBalance(
  chainRpcUrl: string,
  address: string,
): Promise<bigint> {
  const res = await fetch(chainRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
    signal: AbortSignal.timeout(CHAIN_CALL_TIMEOUT_MS),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return BigInt(body.result ?? '0x0');
}
