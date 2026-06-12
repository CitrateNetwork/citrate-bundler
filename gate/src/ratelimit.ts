/**
 * Per-IP + per-API-key rate limiting (EW-S1 WP-4 slice B — sprint
 * item 13). Fixed one-minute windows in Redis: INCR + EXPIRE on first
 * hit. Fail-CLOSED on Redis errors — a broken limiter must not turn
 * the bundler into an open relay (the paymaster's daily caps are the
 * second line, not the first).
 */

export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current window (0 when Redis errored). */
  used: number;
  limit: number;
}

const WINDOW_SECONDS = 60;

export async function checkRateLimit(
  redis: RateLimitRedis,
  bucket: string,
  id: string,
  limit: number,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(nowMs / (WINDOW_SECONDS * 1000));
  const key = `bundler:rl:${bucket}:${id}:${window}`;
  try {
    const used = await redis.incr(key);
    if (used === 1) {
      await redis.expire(key, WINDOW_SECONDS * 2);
    }
    return { allowed: used <= limit, used, limit };
  } catch {
    // Redis down → reject. /healthz exposes the outage; clients retry.
    return { allowed: false, used: 0, limit };
  }
}
