---
created: 2026-06-05T07:35:00Z
branch: main
author: Larry Klosowski (@SaulBuilds) + Claude Opus 4.7 (1M context)
status: active
---

# Deploy — `bundler.citrate.ai`

Stand the bundler up on its dedicated droplet. Same pattern as the
auth.citrate.ai deploy: Caddy terminates TLS at the edge, Docker
Compose orchestrates the service stack, secrets live in a 0600 `.env`
on the host only.

## What you're deploying

- **eth-infinitism v0.7 reference bundler** (Apache 2.0) packaged
  into a runnable Docker image by this repo's Dockerfile.
- **Redis** (state for the Citrate auth sidecar landing in WP-4
  slice B — not yet wired in this commit).
- **Caddy** terminating TLS for `bundler.citrate.ai`.

## Prereqs

1. **Droplet** — already provisioned 2026-06-05 at `159.223.174.220`
   (nyc1, `s-2vcpu-4gb` $24/mo, Docker on Ubuntu 22.04 marketplace
   image). SSH key: `~/.ssh/citrate-do`.
2. **DNS** — A record `bundler.citrate.ai → 159.223.174.220` at
   Cloudflare, **DNS-only (gray cloud)** so ACME HTTP-01 reaches the
   droplet. Same pattern as auth/infer/rpc.
3. **EntryPoint v0.7 on chain 40204** — must be deployed *before* the
   bundler boots (the bundler refuses to start with no EntryPoint at
   the configured address). One-time deploy via
   `eth-infinitism/account-abstraction`'s own forge script targeting
   our chain RPC.
4. **Operator wallet mnemonic** — a BIP-39 mnemonic for an EOA the
   bundler uses to submit batched UserOps. Must hold native SALT
   for gas; refilled from treasury when low.

## Runbook (≈10 min after DNS propagates)

```bash
# 0) SSH in as the deploy user.
ssh -i ~/.ssh/citrate-do root@159.223.174.220

# 1) Clone the repo + env template.
git clone https://github.com/CitrateNetwork/citrate-bundler.git /opt/citrate-bundler
cd /opt/citrate-bundler
cp .env.production.example .env
chmod 0600 .env

# 2) Fill in .env:
#    BUNDLER_HOST=bundler.citrate.ai
#    BUNDLER_NETWORK_RPC=https://rpc.citrate.ai
#    BUNDLER_ENTRYPOINT=0x...               # from the EntryPoint deploy
#    BUNDLER_MNEMONIC=<bip39-12-words>      # operator wallet
#    REDIS_PASSWORD=$(openssl rand -hex 32)
$EDITOR .env

# 3) Bring it up.
docker compose up -d --build

# 4) Watch the boot.
docker compose ps
docker compose logs -f bundler caddy
```

Caddy will pull a Let's Encrypt certificate on first boot once DNS
resolves. If the cert is staging-fallback'd (LE prod intermittent),
clear `caddy_data` + `caddy_config` volumes and restart Caddy (same
gotcha + fix as `auth.citrate.ai`'s deploy; see
`citrate-labs/handoffs/IDENTITY_DEPLOY_HANDOFF.md` §"Known operational
gotcha").

## Verify

```bash
# Health (Caddy-handled — no upstream call).
curl -s https://bundler.citrate.ai/health
# → ok

# JSON-RPC chainId (proves bundler ↔ chain RPC works).
curl -s -X POST https://bundler.citrate.ai/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# → {"jsonrpc":"2.0","id":1,"result":"0x9d0c"}   (40204 in hex)

# Supported EntryPoints.
curl -s -X POST https://bundler.citrate.ai/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_supportedEntryPoints","params":[],"id":1}'
# → {"jsonrpc":"2.0","id":1,"result":["0x..."]}  ← matches BUNDLER_ENTRYPOINT
```

## Persistence + backups

| Volume | What's in it | Backup |
|---|---|---|
| `redis_data` | rate-limit + cache state for the auth sidecar (when it lands) | Optional — ephemeral; rebuilds on restart |
| `caddy_data` | TLS cert + ACME state | `tar -cz` then off-host |
| `caddy_config` | Caddy auto-generated config | Together with caddy_data |

The bundler holds no durable state in v1 (its operator wallet's nonce
is read off-chain; in-flight UserOps queue in memory). Persistence
will become a concern when slice B (Redis-backed mempool) lands.

## Updating

```bash
ssh -i ~/.ssh/citrate-do root@159.223.174.220 \
  'cd /opt/citrate-bundler && git pull && docker compose up -d --build'
```

To bump the upstream eth-infinitism bundler version, override
`BUNDLER_REF` at build time:

```bash
docker compose build --build-arg BUNDLER_REF=<new tag or commit>
docker compose up -d
```

## Rollback

```bash
# Pin to a previous git SHA and rebuild.
git reset --hard <PREVIOUS_SHA>
docker compose up -d --build
```

Full take-down (only for incident response — kills every UserOp in
flight):

```bash
docker compose down
```

## Follow-up (WP-4 slice B)

A small Node sidecar (`citrate-bundler-auth/`) will land between Caddy
and the bundler to:

- Validate `Authorization: Bearer bk_…` against a Redis-backed key set
  minted by `auth.citrate.ai`.
- Pre-check paymaster budget via `CitratePaymaster.remainingStandard(account)`
  so the bundler doesn't waste cycles on already-over-budget UserOps.
- Surface structured rate-limit / budget rejections to clients with
  the exact JSON-RPC shape the SDK expects.

Until slice B lands, the bundler accepts any JSON-RPC client that can
reach `bundler.citrate.ai` — Caddy edge rate-limit is the only check.
Do not list the URL in any public documentation that a non-Citrate
client could find before slice B.

## WP-4 slice B — the gate (2026-06-11)

`gate/` is the Citrate sidecar between Caddy and the bundler:
`bk_` API keys (mint with `cd gate && GATE_REDIS_URL=… npm run mint-key -- "<label>"`),
Redis-backed per-IP + per-key rate limits, the CitratePaymaster
pre-check on `eth_sendUserOperation`, structured JSON logs, `/metrics`
(droplet-internal) and threshold alerts (low paymaster deposit / low
operator balance → `GATE_ALERT_WEBHOOK_URL`).

Deploy delta on the droplet:

```bash
cd /opt/citrate-bundler
git pull                       # or rsync
nano .env                      # fill the new "Gate" block from .env.production.example
docker compose up -d --build   # builds the gate image, reroutes Caddy /rpc through it
curl -s https://bundler.citrate.ai/healthz   # {"status":"ok","redis":true,"upstream":true}
docker compose exec gate wget -qO- http://localhost:3001/metrics | head
```

R3 gate satisfied: metrics + alerts exist BEFORE any RP integrates.
