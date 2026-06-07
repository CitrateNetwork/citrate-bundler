#!/usr/bin/env bash
# Bundler boot validation smoke test (WP-E of the EW-S1 re-roll bundle).
#
# Hits the bundler's JSON-RPC endpoint and asserts:
#   1. The server answers (TCP + HTTP 200 + valid JSON-RPC envelope).
#   2. `eth_chainId` returns `0x9d0c` (40204 in hex) — proves the
#      bundler is talking to the Citrate chain, not a leftover Anvil.
#   3. `eth_supportedEntryPoints` returns at least one entry that
#      matches the operator's expected EntryPoint.
#
# Usage:
#
#     # Default: hits the public droplet.
#     bash scripts/smoke.sh
#
#     # Override the target (local docker compose, staging, …):
#     BUNDLER_URL=http://localhost:3000 bash scripts/smoke.sh
#
#     # Optionally assert a specific EntryPoint is supported:
#     EXPECTED_ENTRYPOINT=0x25051e90A110fbE4569f124274ce387eB033bC9c \
#       bash scripts/smoke.sh
#
# Exit codes:
#   0 all checks passed
#   1 missing dependency / bad config
#   2 bundler unreachable
#   3 wrong chain id
#   4 EntryPoint mismatch
set -euo pipefail

BUNDLER_URL="${BUNDLER_URL:-https://bundler.citrate.ai/rpc}"
EXPECTED_CHAIN_ID_HEX="${EXPECTED_CHAIN_ID_HEX:-0x9d0c}"
EXPECTED_ENTRYPOINT="${EXPECTED_ENTRYPOINT:-}"

err() { echo "[smoke] ERROR: $*" >&2; }
log() { echo "[smoke] $*"; }

command -v curl >/dev/null || { err "curl is required"; exit 1; }
command -v jq   >/dev/null || { err "jq is required";   exit 1; }

log "target: $BUNDLER_URL"

# --- 1. liveness + eth_chainId ---------------------------------------

rpc_call() {
  local method="$1"
  curl -fsS -X POST "$BUNDLER_URL" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":[],\"id\":1}"
}

CHAIN_RESPONSE=$(rpc_call eth_chainId || true)
if [[ -z "$CHAIN_RESPONSE" ]]; then
  err "bundler did not respond to eth_chainId at $BUNDLER_URL"
  exit 2
fi
log "eth_chainId response: $CHAIN_RESPONSE"

CHAIN_ID_HEX=$(printf '%s' "$CHAIN_RESPONSE" | jq -r '.result // empty')
if [[ -z "$CHAIN_ID_HEX" ]]; then
  err "eth_chainId did not return a result - response: $CHAIN_RESPONSE"
  exit 2
fi
if [[ "$CHAIN_ID_HEX" != "$EXPECTED_CHAIN_ID_HEX" ]]; then
  err "wrong chain id: got $CHAIN_ID_HEX, expected $EXPECTED_CHAIN_ID_HEX (40204)"
  err "  the bundler is talking to a chain other than Citrate testnet - check BUNDLER_RPC env"
  exit 3
fi
log "chain id OK ($CHAIN_ID_HEX = 40204)"

# --- 2. eth_supportedEntryPoints ------------------------------------

EP_RESPONSE=$(rpc_call eth_supportedEntryPoints || true)
if [[ -z "$EP_RESPONSE" ]]; then
  err "bundler did not respond to eth_supportedEntryPoints"
  exit 2
fi
log "eth_supportedEntryPoints response: $EP_RESPONSE"

EP_LIST=$(printf '%s' "$EP_RESPONSE" | jq -r '.result // [] | .[]')
if [[ -z "$EP_LIST" ]]; then
  err "bundler advertises NO supported EntryPoints - check BUNDLER_ENTRYPOINT in /opt/citrate-bundler/.env"
  exit 4
fi
log "supported EntryPoints:"
echo "$EP_LIST" | sed 's/^/  /'

# --- 3. (optional) assert a specific EntryPoint is in the list -------

if [[ -n "$EXPECTED_ENTRYPOINT" ]]; then
  EXPECTED_LOWER=$(echo "$EXPECTED_ENTRYPOINT" | tr 'A-Z' 'a-z')
  FOUND=0
  while IFS= read -r ep; do
    if [[ "$(echo "$ep" | tr 'A-Z' 'a-z')" == "$EXPECTED_LOWER" ]]; then
      FOUND=1
    fi
  done <<< "$EP_LIST"
  if [[ "$FOUND" != "1" ]]; then
    err "EXPECTED_ENTRYPOINT=$EXPECTED_ENTRYPOINT not in advertised list"
    exit 4
  fi
  log "expected EntryPoint $EXPECTED_ENTRYPOINT advertised OK"
fi

log ""
log "bundler boot smoke passed"
