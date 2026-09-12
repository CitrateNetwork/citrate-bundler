# citrate-bundler

*Part of the **[Citrate Network](https://citrate.ai)** — own the means of computation. · [Docs](https://docs.citrate.ai) · [Run a node](https://citrate.ai/download) · [Contribute → free membership](https://github.com/CitrateNetwork/.github/blob/main/CONTRIBUTING.md)*

> The ERC-4337 v0.7 bundler for the Citrate Network — a self-hosted eth-infinitism
> bundler behind a Citrate auth/rate-limit/paymaster-pre-check gate, submitting
> UserOperations to the chain's EntryPoint so passkey/AA wallets transact without
> holding gas.

## What it is

`citrate-bundler` is a Docker-compose stack of four services: the upstream
**eth-infinitism** bundler (Apache-2.0, vendored unmodified), a thin Citrate
**gate** sidecar (`bk_` API keys, per-IP + per-key rate limits, a paymaster
pre-check, `/metrics`), **Redis** (the gate's counters + pre-check cache), and
**Caddy** (public TLS + edge rate limit). It submits batched UserOps to the
ERC-4337 v0.7 **EntryPoint** deployed on chain **40204**, paying gas from a funded
operator EOA that users' paymaster/UserOp reimburses.

- Concept docs: https://docs.citrate.ai/account-abstraction
- Depends on a [citrate-chain](https://github.com/CitrateNetwork/citrate-chain) RPC
  plus the deployed AA stack (EntryPoint v0.7 + `CitratePaymaster`).

## Prerequisites

```bash
# Docker + Compose v2
# https://docs.docker.com/engine/install/  (then `docker compose version`)

# For local gate development only (optional): Node 20 + npm
#   node --version   # v20.x

# Tools for the smoke test
sudo apt-get install -y curl jq
```

## Build from source

The bundler and gate images build from this repo's Dockerfiles (the bundler
Dockerfile vendors the eth-infinitism reference bundler; the gate is a TypeScript
service):

```bash
git clone https://github.com/CitrateNetwork/citrate-bundler
cd citrate-bundler

docker compose build           # builds the bundler + gate images

# Iterate on the gate alone:
cd gate && npm install && npm run dev    # tsx dev server on GATE_PORT (3001)
```

## Run locally

1. Copy the env template and fill it for a **local** chain:

```bash
cp .env.production.example .env
```

Set, at minimum:

```dotenv
BUNDLER_HOST=localhost
BUNDLER_NETWORK_RPC=http://host.docker.internal:8545   # your local citrate-chain devnet RPC
BUNDLER_ENTRYPOINT=<EntryPoint v0.7 address deployed on chain 40204>
BUNDLER_MNEMONIC=<BIP-39 mnemonic of a funded operator EOA>   # openssl rand -hex 32 -> BIP-39
REDIS_PASSWORD=<openssl rand -hex 32>
CITRATE_AA_PAYMASTER=<CitratePaymaster address on chain 40204>
GATE_REQUIRE_API_KEY=true         # see the boot guard below
BUNDLER_UNSAFE=true               # chain 40204 has no debug_traceCall yet
```

2. Bring the stack up:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f bundler gate caddy
```

3. Verify — the smoke test asserts the bundler answers, is on chain `0x9d0c`
   (40204), and supports your EntryPoint. Point it at the running stack (publish
   the bundler port for a direct local check, or run it from inside the network):

```bash
# From inside the compose network:
docker compose exec bundler sh -c \
  'wget -qO- --post-data="{\"jsonrpc\":\"2.0\",\"method\":\"eth_supportedEntryPoints\",\"params\":[],\"id\":1}" \
   --header="Content-Type: application/json" http://localhost:3000/rpc'

# Or run the bundled smoke script against a locally-exposed bundler:
BUNDLER_URL=http://localhost:3000 EXPECTED_CHAIN_ID_HEX=0x9d0c bash scripts/smoke.sh
```

Public endpoints (through Caddy → gate → bundler): `POST /rpc` (JSON-RPC 2.0),
`GET /health` (Caddy liveness "ok"), `GET /healthz` (composite). The gate enforces
a strict ERC-4337 method allow-list; `debug_bundler_*` and everything else are
rejected at the edge with `-32601`.

> **Boot guard (BUN-B-001):** an `--unsafe` bundler on an anonymous `/rpc` door is
> a funds-loss DoS. The stack **refuses to boot** when `BUNDLER_UNSAFE=true` AND
> `GATE_REQUIRE_API_KEY!=true`. For local dev keep `GATE_REQUIRE_API_KEY=true`
> (mint a `bk_` key) — or bypass the gate entirely by hitting the bundler on
> `:3000` directly.

## Connect it locally  ← the differentiator

The bundler's upstream is the **local chain RPC + its deployed EntryPoint**. Order:

1. Start a devnet node from
   [citrate-chain](https://github.com/CitrateNetwork/citrate-chain):
   `./target/release/citrate devnet` → `http://localhost:8545`.
2. Deploy the AA stack to that chain (from citrate-chain: the
   `contracts/script/aa/` scripts / `DeployAA`). Record the printed **EntryPoint
   v0.7** and **CitratePaymaster** addresses.
3. Put those in `.env` (`BUNDLER_ENTRYPOINT`, `CITRATE_AA_PAYMASTER`) and set
   `BUNDLER_NETWORK_RPC` to the chain RPC as reachable from the container
   (`http://host.docker.internal:8545`, or the host IP on Linux).
4. Fund the operator EOA (from `BUNDLER_MNEMONIC`) with native SALT on the devnet
   so it can pay batch gas — e.g. a transfer from the pre-funded Hardhat account #0.
5. `docker compose up -d --build`, then run the smoke check above.

See the full multi-repo bring-up: https://docs.citrate.ai/local-stack

## Configuration

Everything is env-driven via `.env` (template: `.env.production.example`):

- `BUNDLER_NETWORK_RPC` — chain-40204 JSON-RPC the bundler submits to.
- `BUNDLER_ENTRYPOINT` — EntryPoint v0.7 address on chain 40204.
- `BUNDLER_MNEMONIC` / `BUNDLER_OPERATOR_ADDRESS` — the funded operator EOA.
- `CITRATE_AA_PAYMASTER` — `CitratePaymaster` address (enables the pre-check + deposit gauge).
- `GATE_REQUIRE_API_KEY`, `BUNDLER_UNSAFE` — must agree per the boot guard.
- `GATE_IP_LIMIT_PER_MINUTE` (60), `GATE_KEY_LIMIT_PER_MINUTE` (600), `REDIS_PASSWORD`.
- Ports (internal to the compose network): bundler `3000`, gate `3001`, Caddy `80/443`.

Deploy/ops runbook: [DEPLOY.md](DEPLOY.md).

## Links

- Docs: https://docs.citrate.ai/account-abstraction
- Depends on: [citrate-chain](https://github.com/CitrateNetwork/citrate-chain) (RPC + AA stack) ·
  Consumed by: passkey/AA wallets, SDKs, gui-native
- Contributing (DCO): CONTRIBUTING.md · Security: SECURITY.md · License: LICENSE

## License

Source-available (BUSL-1.1) — free for personal/non-commercial use;
commercial/hosted use requires a membership license. This is not an open-source
license. (The vendored eth-infinitism reference bundler is upstream Apache-2.0 and
is used unmodified.)
