import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createPostgresRateLimiter,
  type TelegramRateLimitAction,
} from "../../src/modules/risk/service.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * Coverage for the EXISTING durable limiter (`createPostgresRateLimiter`,
 * backed by `telegram_rate_limit_bucket` from migration 004) against real
 * PostgreSQL — the same limiter the Telegram inbox consumes before dispatching
 * a handler.
 *
 * The load-bearing case is concurrency: 3×capacity simultaneous `tryConsume`
 * calls on one principal+action must admit exactly `capacity`. That is only
 * meaningful against a real database — the `for update` row lock, not the test
 * harness, is what serialises the contenders.
 */

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

const PRINCIPAL = "user:1001";
const ACTION: TelegramRateLimitAction = "CATALOG";

/** Deterministic policy: 4 tokens, one refilled every 4 seconds. */
const TEST_POLICIES = { CATALOG: { capacity: 4, refillPerSecond: 0.25 } } as const;

async function bucketRow(): Promise<{ tokens: number; updated_at: Date } | undefined> {
  const rows = await sql<{ tokens: number; updated_at: Date }>`
    select tokens, updated_at from telegram_rate_limit_bucket
    where bucket_key = ${`${PRINCIPAL}:${ACTION}`}
  `.execute(ctx.db);
  return rows.rows[0];
}

describe.skipIf(!hasDocker)("durable token-bucket limiter (existing mechanism)", () => {
  beforeEach(async () => {
    await sql`delete from telegram_rate_limit_bucket`.execute(ctx.db);
  });

  it("admits a burst up to capacity and then refuses with a whole-second delay", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, TEST_POLICIES);

    for (let i = 0; i < 4; i += 1) {
      const budget = await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION });
      expect(budget.allowed).toBe(true);
    }

    const refused = await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION });
    expect(refused.allowed).toBe(false);
    // 1 token / 0.25 per second = 4s, reported as a positive whole number.
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(refused.retryAfterSeconds)).toBe(true);

    const row = await bucketRow();
    // Drained: refill accumulated during the test (milliseconds of wall clock)
    // is far below the one token needed for another spend.
    expect(row?.tokens).toBeGreaterThanOrEqual(0);
    expect(row?.tokens).toBeLessThan(1);
  });

  it("admits exactly `capacity` of 3×capacity concurrent calls on one bucket", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, TEST_POLICIES);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.tryConsume({ principal: PRINCIPAL, action: ACTION }),
      ),
    );
    expect(results.filter((budget) => budget.allowed)).toHaveLength(4);

    const refused = results.filter((budget) => !budget.allowed);
    expect(refused).toHaveLength(8);
    for (const budget of refused) expect(budget.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // No double spend: the stored balance never goes negative and stays below
    // the one token needed for a further spend.
    const row = await bucketRow();
    expect(row?.tokens).toBeGreaterThanOrEqual(0);
    expect(row?.tokens).toBeLessThan(1);
  });

  it("keeps a separate budget per principal and per action", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, TEST_POLICIES);

    for (let i = 0; i < 4; i += 1) {
      expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
        true,
      );
    }
    expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
      false,
    );

    // Another user is untouched by this user's exhausted bucket.
    expect((await limiter.tryConsume({ principal: "user:2002", action: ACTION })).allowed).toBe(
      true,
    );

    // A different action has its own bucket for the same user.
    const otherAction = createPostgresRateLimiter(ctx.db, {
      ...TEST_POLICIES,
      BUY_NOW: { capacity: 2, refillPerSecond: 0.1 },
    });
    expect(
      (await otherAction.tryConsume({ principal: PRINCIPAL, action: "BUY_NOW" })).allowed,
    ).toBe(true);
  });

  it("refuses fail-closed when no policy exists for the action", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, {});
    const budget = await limiter.tryConsume({ principal: PRINCIPAL, action: "UNKNOWN" });
    expect(budget.allowed).toBe(false);
    expect(budget.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Fail-closed means no bucket was even created.
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from telegram_rate_limit_bucket
    `.execute(ctx.db);
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("rejects a principal that is not a server-derived identity", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, TEST_POLICIES);

    // An IP address alone, a zero user id, and free text are all refused: the
    // bucket key must come from a numeric Telegram id / group id, never from a
    // client-supplied value.
    await expect(
      limiter.tryConsume({ principal: "ip:203.0.113.7", action: ACTION }),
    ).rejects.toThrow(/Invalid rate-limit principal/);
    await expect(limiter.tryConsume({ principal: "user:0", action: ACTION })).rejects.toThrow(
      /Invalid rate-limit principal/,
    );
    await expect(
      limiter.tryConsume({ principal: "user:1001:search", action: ACTION }),
    ).rejects.toThrow(/Invalid rate-limit principal/);
    // A group principal is valid and gets its own budget.
    expect(
      (await limiter.tryConsume({ principal: "group:-1003906082671", action: ACTION })).allowed,
    ).toBe(true);
    expect((await limiter.tryConsume({ principal: "anonymous", action: ACTION })).allowed).toBe(
      true,
    );
  });

  it("refills the bucket as time passes", async () => {
    const limiter = createPostgresRateLimiter(ctx.db, TEST_POLICIES);

    for (let i = 0; i < 4; i += 1) {
      await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION });
    }
    expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
      false,
    );

    // Rewind the bucket clock: 40s at 0.25 tokens/s refills 10 tokens, capped
    // at capacity, so the next burst is admitted again.
    await sql`
      update telegram_rate_limit_bucket
      set updated_at = now() - interval '40 seconds'
      where bucket_key = ${`${PRINCIPAL}:${ACTION}`}
    `.execute(ctx.db);

    for (let i = 0; i < 4; i += 1) {
      expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
        true,
      );
    }
    expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
      false,
    );

    // Refill is capped at capacity: an hour of idle time does not bank more
    // than capacity, so exactly a full burst is admitted and the next is out.
    await sql`
      update telegram_rate_limit_bucket
      set updated_at = now() - interval '1 hour'
      where bucket_key = ${`${PRINCIPAL}:${ACTION}`}
    `.execute(ctx.db);
    for (let i = 0; i < 4; i += 1) {
      expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
        true,
      );
    }
    expect((await limiter.tryConsume({ principal: PRINCIPAL, action: ACTION })).allowed).toBe(
      false,
    );
  });
});
