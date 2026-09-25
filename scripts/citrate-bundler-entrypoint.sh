#!/bin/sh
# citrate-bundler entrypoint.
#
# Templates the upstream eth-infinitism bundler's
# localconfig/bundler.config.json + mnemonic.txt from compose env vars,
# enforces the BUN-B-001 boot guard, then execs the real bundler.
#
# The upstream bundler reads its config from disk (the only injection point
# is `--config <path>`); we write the file at boot rather than baking it in
# so secrets stay out of the image.
#
# Testable in isolation: set CITRATE_ENTRYPOINT_DRY_RUN=1 to write the
# config + run the boot guard and print (rather than exec) the launch
# command. CFG_DIR is overridable so tests can template into a temp dir.
set -eu

: "${MNEMONIC:?MNEMONIC env required (12-word BIP-39)}"
: "${NETWORK:?NETWORK env required (chain JSON-RPC URL)}"
: "${ENTRYPOINT:?ENTRYPOINT env required (chain EntryPoint address)}"
: "${PORT:=3000}"
: "${BENEFICIARY:=}"
: "${AUTO_BUNDLE_INTERVAL:=3}"
: "${CFG_DIR:=/app/packages/bundler/localconfig}"

# --unsafe skips the bundler's debug_traceCall full-validation step: NO
# ERC-7562 opcode/storage-access checking and NO entity stake checking.
# Default true because chain 40204 RPC does not yet expose debug_traceCall.
# When the Citrate node gains debug_traceCall, set BUNDLER_UNSAFE=false.
: "${BUNDLER_UNSAFE:=true}"

# Mirror of the gate sidecar's GATE_REQUIRE_API_KEY. When true, the /rpc
# front door mandates a bk_ API key, so the endpoint is not anonymous.
: "${GATE_REQUIRE_API_KEY:=false}"

# ---- BUN-B-001 boot guard ---------------------------------------------------
# Refuse to start in unsafe mode on an anonymous (open) RPC front door.
# --unsafe disables all ERC-7562 checking; without a mandatory API key any
# internet client can submit UserOps that pass off-chain simulation and then
# revert on-chain, burning the operator EOA's gas one transaction at a time
# (funds-loss DoS). Unsafe mode is only permissible when the gate makes the
# API key mandatory (GATE_REQUIRE_API_KEY=true) and egress is restricted.
if [ "${BUNDLER_UNSAFE}" = "true" ] && [ "${GATE_REQUIRE_API_KEY}" != "true" ]; then
  echo "FATAL [BUN-B-001]: refusing to start." >&2
  echo "  --unsafe (no ERC-7562 opcode/storage/stake checking) on an anonymous" >&2
  echo "  RPC front door is a funds-loss DoS: any client can feed the bundler" >&2
  echo "  UserOps that pass off-chain simulation and revert on-chain, burning" >&2
  echo "  the operator EOA's gas per op." >&2
  echo "  Fix ONE of:" >&2
  echo "    - GATE_REQUIRE_API_KEY=true   (mandate a bk_ key + restrict egress), or" >&2
  echo "    - BUNDLER_UNSAFE=false        (once chain 40204 exposes debug_traceCall)." >&2
  exit 1
fi

# ---- PBA-L3b-I04 boot guard ------------------------------------------------
# GATE_SELF_SERVE_KEYS declares that bk_ keys can be minted by anyone (the
# auth.citrate.ai self-serve surface) rather than only by the operator. A key
# anyone can mint for themselves is not a gate, so with --unsafe it reopens the
# BUN-B-001 funds-loss DoS above. Refuse that combination outright. Anything but
# an explicit "false" (or unset) counts as on, so a typo fails closed.
: "${GATE_SELF_SERVE_KEYS:=false}"
if [ "${BUNDLER_UNSAFE}" = "true" ] && [ "${GATE_SELF_SERVE_KEYS}" != "false" ]; then
  echo "FATAL [PBA-L3b-I04]: refusing to start." >&2
  echo "  GATE_SELF_SERVE_KEYS=${GATE_SELF_SERVE_KEYS} with --unsafe: a bk_ key anyone can" >&2
  echo "  mint is an anonymous front door, which BUN-B-001 forbids for --unsafe." >&2
  echo "  Fix ONE of:" >&2
  echo "    - GATE_SELF_SERVE_KEYS=false  (operator-issued keys only), or" >&2
  echo "    - BUNDLER_UNSAFE=false        (once chain 40204 exposes debug_traceCall)." >&2
  exit 1
fi

mkdir -p "${CFG_DIR}"

# The runtime user the bundler is exec'd as (see the `exec su` at the bottom).
RUNTIME_USER="${CITRATE_RUNTIME_USER:-node}"

printf '%s\n' "${MNEMONIC}" > "${CFG_DIR}/mnemonic.txt"
# BUN-B-011: this entrypoint runs as root but execs the bundler as `${RUNTIME_USER}`,
# and upstream Config.ts does a fatal `fs.readFileSync(mnemonic)`. A root-owned
# 0600 mnemonic.txt is UNREADABLE by that user, so the container would die on
# boot. Hand the file to the runtime user and lock it to owner-read-only (0400),
# which also fixes BUN-B-010's over-broad 0600. Only root can chown, so the
# chown is guarded (dry-run tests run unprivileged and simply skip it).
if [ "$(id -u)" = "0" ]; then
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${CFG_DIR}/mnemonic.txt"
fi
chmod 0400 "${CFG_DIR}/mnemonic.txt"

# ERC-7562 reputation floors (constant table): an entity is "staked" only
# when it locks >= MIN_STAKE_VALUE for >= MIN_UNSTAKE_DELAY. Shipping
# minStake:"1"/minUnstakeDelay:0 marks any 1-wei/zero-delay entity as staked,
# defeating the unstaked-entity mempool caps (UREP-010/UREP-020/GREP-020).
#   MIN_STAKE_VALUE   = 1e18 wei (1 SALT)
#   MIN_UNSTAKE_DELAY = 86400 s (1 day)
# If no beneficiary supplied, the bundler defaults to the operator EOA.
# Leave the field as an empty string to trigger that.
cat > "${CFG_DIR}/bundler.config.json" <<JSON
{
  "gasFactor": "1",
  "port": "${PORT}",
  "network": "${NETWORK}",
  "entryPoint": "${ENTRYPOINT}",
  "beneficiary": "${BENEFICIARY}",
  "minBalance": "1",
  "mnemonic": "./localconfig/mnemonic.txt",
  "maxBundleGas": 5000000,
  "minStake": "1000000000000000000",
  "minUnstakeDelay": 86400,
  "autoBundleInterval": ${AUTO_BUNDLE_INTERVAL},
  "autoBundleMempoolSize": 10
}
JSON

# BUN-B-010/011: the generated config is also read by the runtime user; hand it
# over and drop it from world-readable (0644) to owner+group (0640).
if [ "$(id -u)" = "0" ]; then
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${CFG_DIR}/bundler.config.json"
fi
chmod 0640 "${CFG_DIR}/bundler.config.json"

# Build the flag list. --unsafe is conditional (see boot guard above).
# `--auto` enables the autobundling loop (otherwise the bundler accepts
# UserOps but never submits batches; upstream treats --auto as the
# production default).
UNSAFE_FLAG=""
if [ "${BUNDLER_UNSAFE}" = "true" ]; then
  UNSAFE_FLAG="--unsafe"
fi

LAUNCH="node dist/src/exec.js --config ${CFG_DIR}/bundler.config.json ${UNSAFE_FLAG} --auto"

if [ "${CITRATE_ENTRYPOINT_DRY_RUN:-}" = "1" ]; then
  echo "DRY_RUN launch: ${LAUNCH}"
  exit 0
fi

cd /app/packages/bundler
# Drop privileges to `node` for the runtime.
exec su -s /bin/sh node -c "${LAUNCH}"
