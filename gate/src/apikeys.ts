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
/**
 * CB-06: a companion hash keyed by the same SHA-256 digest holding per-key
 * metadata (label / created / revoked). The SET remains the O(1) membership
 * check on the hot path; the hash gives operators owner/lifecycle data and a
 * per-key revocation target so neutralising one leaked key no longer means
 * flushing the whole set.
 */
export const API_KEY_META = 'bundler:apikeys:meta';
const KEY_PREFIX = 'bk_';

export interface ApiKeyMeta {
  label: string;
  createdAt: string; // ISO-8601
}

/** A minimal Redis surface so tests can drive ioredis-mock. */
export interface RedisLike {
  sismember(key: string, member: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, field: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
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

/**
 * Mint a fresh key, register its hash, and record its metadata (CB-06).
 * Returns the PLAINTEXT once. The label lets an operator later identify and
 * revoke exactly this key without touching any other.
 */
export async function mintApiKey(redis: RedisLike, label = '(unlabelled)'): Promise<string> {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  const digest = hashApiKey(key);
  await redis.sadd(API_KEY_SET, digest);
  const meta: ApiKeyMeta = { label, createdAt: new Date().toISOString() };
  await redis.hset(API_KEY_META, digest, JSON.stringify(meta));
  return key;
}

/**
 * Revoke a single key by its SHA-256 digest (CB-06): drop it from both the
 * membership set and the metadata hash. Returns true if the key existed.
 */
export async function revokeApiKeyByDigest(redis: RedisLike, digest: string): Promise<boolean> {
  const removed = await redis.srem(API_KEY_SET, digest);
  await redis.hdel(API_KEY_META, digest);
  return removed > 0;
}

/**
 * Revoke every key carrying the given label (CB-06). Returns the number of
 * keys revoked. Labels are not required to be unique; all matches are removed.
 */
export async function revokeApiKeysByLabel(redis: RedisLike, label: string): Promise<number> {
  const all = await redis.hgetall(API_KEY_META);
  let revoked = 0;
  for (const [digest, raw] of Object.entries(all ?? {})) {
    let meta: ApiKeyMeta | undefined;
    try {
      meta = JSON.parse(raw) as ApiKeyMeta;
    } catch {
      meta = undefined;
    }
    if (meta?.label === label) {
      if (await revokeApiKeyByDigest(redis, digest)) revoked += 1;
    }
  }
  return revoked;
}

/** List key metadata by digest (CB-06) — for an operator `list` view. */
export async function listApiKeys(redis: RedisLike): Promise<Record<string, ApiKeyMeta>> {
  const all = await redis.hgetall(API_KEY_META);
  const out: Record<string, ApiKeyMeta> = {};
  for (const [digest, raw] of Object.entries(all ?? {})) {
    try {
      out[digest] = JSON.parse(raw) as ApiKeyMeta;
    } catch {
      // skip corrupt metadata entries
    }
  }
  return out;
}

export type { Redis };
