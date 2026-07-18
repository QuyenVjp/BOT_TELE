/**
 * Abuse-control rate limiting (FR-024, SR-004).
 *
 * A per-key token bucket: each principal (Telegram user id, or user+action)
 * gets an independent budget, so one abuser cannot starve others, and an
 * authenticated recovery route can use a separate, more generous key. The
 * in-memory driver here is for tests and single-instance dev; production swaps a
 * Redis-backed driver behind the same `RateLimiter` port (ephemeral state only —
 * never authoritative business data).
 */

export interface RateLimiter {
  /** Attempt to consume one token for `key`; true if allowed, false if throttled. */
  tryConsume(key: string): boolean;
}

export interface RateLimiterOptions {
  /** Bucket size = max burst. */
  capacity: number;
  /** Tokens replenished per second (0 = no refill; fixed burst window). */
  refillPerSecond: number;
  /** Injectable clock for deterministic tests (ms epoch). */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export function createInMemoryRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond } = options;
  const clock = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  return {
    tryConsume(key: string): boolean {
      const nowMs = clock();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefillMs: nowMs };
        buckets.set(key, bucket);
      }

      if (refillPerSecond > 0) {
        const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
        if (elapsedSec > 0) {
          bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond);
          bucket.lastRefillMs = nowMs;
        }
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
      }
      return false;
    },
  };
}

import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";

export type TelegramRateLimitAction =
  | "CATALOG"
  | "BUY_NOW"
  | "PAYMENT_CHECK"
  | "CANCEL"
  | "SUPPORT"
  | "ADMIN"
  | "PAID_ORDER_RECOVERY"
  | "UNKNOWN";

export interface DistributedRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface DistributedRateLimiter {
  tryConsume(input: {
    principal: string;
    action: TelegramRateLimitAction;
  }): Promise<DistributedRateLimitResult>;
}

export type TelegramRateLimitPolicies = Partial<
  Record<TelegramRateLimitAction, { capacity: number; refillPerSecond: number }>
>;

export const DEFAULT_TELEGRAM_RATE_LIMIT_POLICIES = {
  CATALOG: { capacity: 60, refillPerSecond: 1 },
  BUY_NOW: { capacity: 5, refillPerSecond: 0.1 },
  PAYMENT_CHECK: { capacity: 20, refillPerSecond: 0.5 },
  CANCEL: { capacity: 5, refillPerSecond: 0.1 },
  SUPPORT: { capacity: 10, refillPerSecond: 0.1 },
  ADMIN: { capacity: 10, refillPerSecond: 0.1 },
  PAID_ORDER_RECOVERY: { capacity: 30, refillPerSecond: 0.5 },
  UNKNOWN: { capacity: 5, refillPerSecond: 0.1 },
} as const satisfies Record<TelegramRateLimitAction, { capacity: number; refillPerSecond: number }>;

const PRINCIPAL_PATTERN = /^(?:user:[1-9][0-9]{0,19}|anonymous)$/;

/** PostgreSQL fallback: row locking makes budgets atomic across app/worker instances. */
export function createPostgresRateLimiter(
  db: Db,
  policies: TelegramRateLimitPolicies,
): DistributedRateLimiter {
  return {
    async tryConsume(input) {
      if (!PRINCIPAL_PATTERN.test(input.principal)) throw new Error("Invalid rate-limit principal");
      const policy = policies[input.action];
      if (!policy) return { allowed: false, retryAfterSeconds: 60 };
      if (!Number.isInteger(policy.capacity) || policy.capacity < 1 || policy.capacity > 10_000) {
        throw new Error("Invalid rate-limit capacity");
      }
      if (
        !Number.isFinite(policy.refillPerSecond) ||
        policy.refillPerSecond <= 0 ||
        policy.refillPerSecond > 1000
      ) {
        throw new Error("Invalid rate-limit refill");
      }
      const bucketKey = `${input.principal}:${input.action}`;
      await sql`
        insert into telegram_rate_limit_bucket (bucket_key, tokens, updated_at)
        values (${bucketKey}, ${policy.capacity}, now())
        on conflict (bucket_key) do nothing
      `.execute(db);
      const result = await sql<{ allowed: boolean; retry_after_seconds: number }>`
        with locked as (
          select bucket_key,
                 least(${policy.capacity}::double precision,
                   tokens + greatest(0, extract(epoch from now() - updated_at)) *
                     ${policy.refillPerSecond}) as available
          from telegram_rate_limit_bucket
          where bucket_key = ${bucketKey}
          for update
        ), consumed as (
          update telegram_rate_limit_bucket b
          set tokens = case when l.available >= 1 then l.available - 1 else l.available end,
              updated_at = now()
          from locked l
          where b.bucket_key = l.bucket_key
          returning l.available >= 1 as allowed,
                    case when l.available >= 1 then 0
                         else ceil((1 - l.available) / ${policy.refillPerSecond})::int end
                      as retry_after_seconds
        )
        select allowed, retry_after_seconds from consumed
      `.execute(db);
      const row = result.rows[0];
      return row
        ? { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds }
        : { allowed: false, retryAfterSeconds: 1 };
    },
  };
}
