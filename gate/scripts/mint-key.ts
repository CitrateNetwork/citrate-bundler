/**
 * Mint a `bk_` bundler API key (EW-S1 WP-4 slice B — sprint item 12).
 *
 * Run ON the droplet (or anywhere that reaches the gate's Redis):
 *
 *   GATE_REDIS_URL=redis://:pass@localhost:6379 npm run mint-key -- "label"
 *
 * Prints the PLAINTEXT key exactly once — only its SHA-256 hash is
 * stored. Hand the key to the integrating RP over a secure channel.
 * The auth.citrate.ai self-serve minting surface (IDP dashboard
 * follow-up) writes to the same `bundler:apikeys` Redis set.
 */

import { Redis } from 'ioredis';

import { mintApiKey } from '../src/apikeys.js';

async function main(): Promise<void> {
  const url = process.env.GATE_REDIS_URL;
  if (!url) {
    console.error('GATE_REDIS_URL is required');
    process.exit(1);
  }
  const label = process.argv[2] ?? '(unlabelled)';
  const redis = new Redis(url);
  try {
    const key = await mintApiKey(redis);
    console.log(`minted bundler API key for ${label}:`);
    console.log(key);
    console.log('(stored as SHA-256 only — this is the last time the plaintext exists)');
  } finally {
    redis.disconnect();
  }
}

void main();
