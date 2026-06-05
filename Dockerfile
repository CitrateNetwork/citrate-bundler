# syntax=docker/dockerfile:1
#
# citrate-bundler — packages eth-infinitism's reference ERC-4337 v0.7
# bundler (Apache 2.0) into a runnable Citrate-flavoured image.
#
# v0.7-aligned bundler is shipped via the upstream account-abstraction
# monorepo (https://github.com/eth-infinitism/bundler) at the
# `releases/v0.7` branch. We pin to a specific commit via build arg
# so an upstream main-branch shift never silently changes our binary.
#
# Multi-stage:
#  1. builder — clone upstream + yarn install + tsc → dist/
#  2. runtime — node:22-alpine + dist + production deps only

ARG BUNDLER_REPO=https://github.com/eth-infinitism/bundler.git
# v0.7-tagged release. Override at build time with --build-arg if a
# newer fix lands and we want to take it.
ARG BUNDLER_REF=releases/v0.7

# ---- 1. builder ----
FROM node:22-alpine AS builder
WORKDIR /build
RUN apk add --no-cache git python3 make g++

# Clone the upstream bundler at the pinned ref.
ARG BUNDLER_REPO
ARG BUNDLER_REF
RUN git clone --depth 1 --branch ${BUNDLER_REF} ${BUNDLER_REPO} bundler

WORKDIR /build/bundler
# Yarn is the upstream's package manager.
RUN corepack enable && corepack prepare yarn@stable --activate
# `preinstall` runs hardhat compile across multiple packages; allow it
# to fail if a sample is broken, but the workspace install + compile of
# our runtime path (`packages/bundler`) must succeed.
RUN yarn install --immutable || yarn install
RUN yarn workspace @account-abstraction/bundler run hardhat-compile || true
RUN yarn workspace @account-abstraction/bundler run tsc

# ---- 2. runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as the unprivileged `node` user (uid/gid 1000) the base image ships.
COPY --from=builder --chown=node:node /build/bundler /app

USER node
EXPOSE 3000

# Liveness probe — eth-infinitism bundler exposes its own health endpoint
# at the bound port; we hit a trivial JSON-RPC call instead since /health
# isn't standard across upstream versions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', id: 1 }) }).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

# The upstream bundler accepts its config via env (BUNDLER_*) or
# CLI args; docker-compose.yml passes them in. Default entry point
# is the upstream `bundler` package's `runBundler` binary.
WORKDIR /app/packages/bundler
CMD ["node", "dist/src/runBundler.js"]
