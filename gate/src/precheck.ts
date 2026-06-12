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
}

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
 * unreachability fails OPEN with a logged reason — the on-chain
 * validation is still authoritative; the pre-check is an optimization,
 * not a security boundary.
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
  const category = op.paymasterData && op.paymasterData.length >= 4
    ? parseInt(op.paymasterData.slice(2, 4), 16)
    : undefined;
  if (category === undefined || Number.isNaN(category)) {
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
    // Fail open: the EntryPoint re-validates everything on-chain.
    return {
      ok: true,
      reason: `precheck skipped (chain unreachable: ${(err as Error).message})`,
    };
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
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return BigInt(body.result ?? '0x0');
}
