// Storage-backed rate limiting behind an interface (PH-T01): callers depend only on `RateLimiter`,
// never on how buckets are stored, so the backing store can change without touching call sites.

import { RateLimitedError } from "@backoffice/domain";
import type { Database } from "../db/types";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window when `allowed`; 0 otherwise. */
  remaining: number;
  /** Milliseconds until the caller may retry; 0 when `allowed`. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Consume one unit of `key`'s budget of `limit` per `windowMs` (a fixed window). */
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Postgres-backed fixed-window limiter: one row per bucket key. The `on conflict` upsert takes a
 * row lock, so concurrent requests for the same key still get a correct, serialized count instead
 * of a lost update. A fixed window can allow up to 2x `limit` right at a window boundary; that
 * trade-off is fine here because every limit below is a coarse abuse guard, not a billing meter.
 */
export function createPostgresRateLimiter(db: Database): RateLimiter {
  return {
    async consume(key, limit, windowMs) {
      const now = Date.now();
      const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
      const { rows } = await db.transaction((exec) =>
        exec.query<{ count: number; window_start: string }>(
          `insert into public.rate_limit_counters (bucket_key, window_start, count, updated_at)
           values ($1, $2, 1, now())
           on conflict (bucket_key) do update
             set count = case
                   when public.rate_limit_counters.window_start = excluded.window_start
                   then public.rate_limit_counters.count + 1
                   else 1
                 end,
                 window_start = excluded.window_start,
                 updated_at = now()
           returning count, window_start`,
          [key, windowStart.toISOString()],
        ),
      );
      const row = rows[0];
      const count = row ? Number(row.count) : 1;
      const bucketStart = row ? new Date(row.window_start).getTime() : windowStart.getTime();
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterMs: Math.max(0, bucketStart + windowMs - now),
      };
    },
  };
}

/** Consume from `limiter`, throwing `RateLimitedError` instead of returning a decision, for call
 *  sites that want limiting to short-circuit like any other domain error. */
export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const result = await limiter.consume(key, limit, windowMs);
  if (!result.allowed) throw new RateLimitedError(result.retryAfterMs);
}
