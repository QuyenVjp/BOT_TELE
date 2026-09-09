import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import {
  addTestCustomer,
  canPurchase,
  getStoreMode,
  setStoreMode,
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

  it("TEST mode denies public SKUs and non-allowlisted buyers of test SKUs", async () => {
    await setStoreMode(ctx.db, "TEST", "admin");
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
    await setStoreMode(ctx.db, "OPEN", "admin");
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
