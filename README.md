---
created: 2026-06-05T07:30:00Z
branch: main
author: Larry Klosowski (@SaulBuilds) + Claude Opus 4.7 (1M context)
status: active
---

# citrate-bundler

ERC-4337 v0.7 bundler service serving `bundler.citrate.ai`. Self-hosted
upstream eth-infinitism reference bundler (Apache 2.0) behind Caddy, with
a thin Citrate auth/pre-check sidecar landing in a follow-up commit.

Part of EW-S1 (the embedded-wallet sprint). Lives on its own DigitalOcean
droplet so a bundler outage cannot take down `auth.citrate.ai` or the
gateway.

## Quick links

- Sprint planset:
  `citrate-federation/.agentile/planset/2026-06-05-ew-s1-passkey-aa.md`
- Topology ADR:
  `citrate-federation/.agentile/adrs/ADR-2026-06-05-ew-bundler-topology.md`
- Paymaster policy ADR (informs the pre-check):
  `citrate-federation/.agentile/adrs/ADR-2026-06-05-ew-paymaster-policy.md`
- On-chain contracts:
  `citrate-chain/contracts/src/aa/`

## What runs here

```
client (browser / SDK / gui-native / wallet-extension)
   │  HTTPS  JSON-RPC POST
   ▼
Caddy on bundler.citrate.ai
   │ HTTP loopback, with per-IP and per-API-key rate limit
   ▼
citrate-bundler-auth (Node sidecar — WP-4 slice B)
   │ HTTP loopback, after Bearer auth + paymaster pre-check
   ▼
eth-infinitism bundler (Node service)
   │ JSON-RPC
   ▼
citrate-chain RPC at rpc.citrate.ai
```

## Public endpoints

```
POST  https://bundler.citrate.ai/        — JSON-RPC 2.0
GET   https://bundler.citrate.ai/health  — { "ok": true }
```

Standard ERC-4337 methods (`eth_sendUserOperation`, etc.) +
Citrate-specific:

- `citrate_getUserAddress(userId)` — predict the smart-wallet address
  for a Citrate user id (mirrors `citrate-wallet-aa::predict_address`
  in Rust + `CitrateWalletFactory.predictAddress` on-chain).

## Deploy

See [DEPLOY.md](DEPLOY.md). Initial droplet provisioned 2026-06-05:

| Thing | Value |
|---|---|
| Droplet | `citrate-bundler` |
| Region | nyc1 |
| Size | `s-2vcpu-4gb` ($24/mo) |
| Public IPv4 | `159.223.174.220` |
| SSH | `ssh -i ~/.ssh/citrate-do root@159.223.174.220` (same key as `citrate-rpc-1` + `citrate-identity`) |

## License

MIT. Upstream eth-infinitism bundler is Apache 2.0; we vendor it as a
Docker image without modification in this slice.
