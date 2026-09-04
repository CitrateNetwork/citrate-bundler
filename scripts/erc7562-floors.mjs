// ERC-7562 reputation-floor constant table + a config checker.
//
// Single source of truth for the tripwire (BUN-B-001). The reference
// eth-infinitism bundler (releases/v0.7, packages/bundler/src/BundlerConfig.ts)
// defines:
//   MIN_UNSTAKE_DELAY = 86400
//   MIN_STAKE_VALUE   = 1e18.toString()
// An entity counts as "staked" (ReputationManager: stake >= minStake &&
// unstakeDelaySec >= minUnstakeDelay) only above these floors. Shipping a
// bundler.config.json with values below them silently disables the
// unstaked-entity mempool caps (UREP-010 / UREP-020 / GREP-020).

/** ERC-7562 constant-table floors the generated config must not go below. */
export const ERC7562_FLOORS = {
  // wei; 1e18 = 1 SALT
  minStake: 1000000000000000000n,
  // seconds; 86400 = 1 day
  minUnstakeDelay: 86400n,
};

/**
 * Check a parsed bundler.config.json object against the ERC-7562 floors.
 * @param {Record<string, unknown>} config
 * @returns {{field: string, got: string, floor: string}[]} violations (empty === ok)
 */
export function checkConfigFloors(config) {
  const violations = [];

  const minStake = toBigInt(config.minStake);
  if (minStake === null) {
    violations.push({ field: 'minStake', got: String(config.minStake), floor: ERC7562_FLOORS.minStake.toString() });
  } else if (minStake < ERC7562_FLOORS.minStake) {
    violations.push({ field: 'minStake', got: minStake.toString(), floor: ERC7562_FLOORS.minStake.toString() });
  }

  const minUnstakeDelay = toBigInt(config.minUnstakeDelay);
  if (minUnstakeDelay === null) {
    violations.push({ field: 'minUnstakeDelay', got: String(config.minUnstakeDelay), floor: ERC7562_FLOORS.minUnstakeDelay.toString() });
  } else if (minUnstakeDelay < ERC7562_FLOORS.minUnstakeDelay) {
    violations.push({ field: 'minUnstakeDelay', got: minUnstakeDelay.toString(), floor: ERC7562_FLOORS.minUnstakeDelay.toString() });
  }

  return violations;
}

function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      return BigInt(v.trim());
    } catch {
      return null;
    }
  }
  return null;
}
