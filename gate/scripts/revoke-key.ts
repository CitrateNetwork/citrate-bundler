/**
 * Revoke `bk_` bundler API key(s) by label (CB-06).
 *
 * Run ON the droplet (or anywhere that reaches the gate's Redis):
 *
 *   GATE_REDIS_URL=redis://:pass@localhost:6379 npm run revoke-key -- "label"
 *
 * Removes every key minted under that label from both the membership set and
 * the metadata hash, so the revoked key stops validating immediately without
 * disturbing any other key. With no label, prints the current key inventory
 * (labels + creation times; never plaintext, which is not stored).
 */

import { Redis } from 'ioredis';

import { listApiKeys, revokeApiKeysByLabel } from '../src/apikeys.js';

async function main(): Promise<void> {
  const url = process.env.GATE_REDIS_URL;
  if (!url) {
    console.error('GATE_REDIS_URL is required');
    process.exit(1);
  }
  const label = process.argv[2];
  const redis = new Redis(url);
  try {
    if (!label) {
      const keys = await listApiKeys(redis);
      const entries = Object.entries(keys);
      if (entries.length === 0) {
        console.log('no API keys registered');
        return;
      }
      console.log('registered bundler API keys (digest → label, created):');
      for (const [digest, meta] of entries) {
        console.log(`  ${digest.slice(0, 12)}…  ${meta.label}  (${meta.createdAt})`);
      }
      console.log('\nrevoke with: npm run revoke-key -- "<label>"');
      return;
    }
    const revoked = await revokeApiKeysByLabel(redis, label);
    console.log(`revoked ${revoked} key(s) labelled "${label}"`);
    if (revoked === 0) {
      console.log('(no matching label — run with no argument to list current keys)');
    }
  } finally {
    redis.disconnect();
  }
}

void main();
