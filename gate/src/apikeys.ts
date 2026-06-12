/**
 * `bk_`-prefixed API keys (EW-S1 WP-4 slice B — sprint item 12).
 *
 * Storage: Redis set `bundler:apikeys` holding SHA-256 hex digests of
 * the full key string — the plaintext key is never stored, so a Redis
 * dump cannot be replayed as a credential. Keys are minted with
 * `npm run mint-key` (scripts/mint-key.ts) on the droplet; the
 * auth.citrate.ai self-serve minting surface consumes the same Redis
 * contract when it lands (IDP dashboard follow-up).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';

export const API_KEY_SET = 'bundler:apikeys';
const KEY_PREFIX = 'bk_';

/** A minimal Redis surface so tests can drive ioredis-mock. */
export interface RedisLike {
  sismember(key: string, member: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Shape check without touching Redis — rejects junk cheaply. */
export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && /^bk_[A-Za-z0-9_-]{32,}$/.test(key);
}

/** Constant-time-ish validation: hash, then set membership. */
export async function validateApiKey(
  redis: RedisLike,
  key: string,
): Promise<boolean> {
  if (!looksLikeApiKey(key)) {
    // Burn the same hash work for non-keys so the reject path doesn't
    // reveal the shape check via timing.
    const a = Buffer.from(hashApiKey(key));
    timingSafeEqual(a, a);
    return false;
  }
  return (await redis.sismember(API_KEY_SET, hashApiKey(key))) === 1;
}

/** Mint a fresh key and register its hash. Returns the PLAINTEXT once. */
export async function mintApiKey(redis: RedisLike): Promise<string> {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  await redis.sadd(API_KEY_SET, hashApiKey(key));
  return key;
}

export type { Redis };
