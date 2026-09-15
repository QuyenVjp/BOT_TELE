import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import {
  addTestCustomer,
  canPurchase,
  getStoreMode,
  setStoreModeForTest,
  transitionStoreMode,
} from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table test_customer_allowlist, store_control cascade`.execute(ctx.db);
  await sql`
    insert into store_control (id, status, updated_at, updated_by)
    values ('main', 'CLOSED', now(), 'system')
  `.execute(ctx.db);
});

describe("store-mode safety", () => {
  it("041-style insert on conflict does not reopen a CLOSED store", async () => {
    await sql`
      insert into store_control (id, status, updated_at, updated_by)
      values ('main', 'OPEN', now(), 'system')
      on conflict (id) do nothing
    `.execute(ctx.db);
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
    const gate = await canPurchase(ctx.db, {
      telegramUserId: "1",
      isRootAdmin: false,
      variantIsTest: false,
    });
    expect(gate).toEqual({ ok: false, code: "STORE_CLOSED" });
  });

  it("refuses OPEN when no published in-stock product is ready", async () => {
    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "OPEN",
        expectedVersion: 1,
        requestId: "store-open-not-ready",
        actorId: "admin",
        reason: "must have a sellable product",
        correlationId: "store-open-not-ready",
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_READY" });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
  });

  it("requires CLOSED-mediated transitions, optimistic versions, and idempotent replay", async () => {
    const first = await transitionStoreMode(ctx.db, {
      targetMode: "TEST",
      expectedVersion: 1,
      requestId: "store-test-1",
      actorId: "admin",
      reason: "pre-production test",
      correlationId: "store-test-1",
    });
    expect(first).toMatchObject({
      ok: true,
      kind: "CHANGED",
      control: { status: "TEST", version: 2 },
    });

    const replay = await transitionStoreMode(ctx.db, {
      targetMode: "TEST",
      expectedVersion: 1,
      requestId: "store-test-1",
      actorId: "admin",
      reason: "pre-production test",
      correlationId: "store-test-1-replay",
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "REPLAYED",
      control: { status: "TEST", version: 2 },
    });

    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "OPEN",
        expectedVersion: 2,
        requestId: "store-open-invalid",
        actorId: "admin",
        reason: "must close first",
        correlationId: "store-open-invalid",
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "CLOSED",
        expectedVersion: 1,
        requestId: "store-close-stale",
        actorId: "admin",
        reason: "stale snapshot",
        correlationId: "store-close-stale",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("TEST mode denies public SKUs and non-allowlisted buyers of test SKUs", async () => {
    await setStoreModeForTest(ctx.db, "TEST", "admin");
    expect(await getStoreMode(ctx.db)).toBe("TEST");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: false,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    await addTestCustomer(ctx.db, "99", "admin");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: true,
        variantIsTest: true,
      }),
    ).toEqual({ ok: true });
  });

  it("OPEN mode denies test SKUs", async () => {
    await setStoreModeForTest(ctx.db, "OPEN", "admin");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: false,
        variantIsTest: false,
      }),
    ).toEqual({ ok: true });
  });

  it("seed-test-catalog does not mutate store_control", () => {
    const src = readFileSync("scripts/seed-test-catalog.ts", "utf8");
    expect(src).not.toMatch(/setStoreMode|setStoreStatus|store_control/);
  });
});
