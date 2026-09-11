import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { updateAdminVariant } from "../../src/modules/catalog/admin-products.js";
import { adjustQuantityStock } from "../../src/modules/catalog/quantity-stock.js";
import {
  createStepUpService,
  type StepUpActionCategory,
} from "../../src/modules/identity/step-up.js";
import type { SensitiveActionDeps } from "../../src/modules/identity/sensitive-action.js";
import { loadSensitiveAuthorizationBinding } from "../../src/modules/identity/authorization-binding.js";
import type { AuthorizationJsonValue } from "../../src/modules/identity/authorization-payload.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { newId } from "../../src/shared/ids/index.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";
import { createTotpCode } from "../helpers/totp.js";

/**
 * The price, deposit and stock fields are money.
 *
 * `authorizeVariant` / `authorizeRootAction` prove the ACTOR is the owner — one factor. This
 * suite drives the real module functions with step-up ON and asserts the second factor is
 * required, and that the load-bearing property holds: on a refusal the row is byte-for-byte
 * unchanged. A test that only asserted a thrown error would pass even if the UPDATE ran first
 * and threw afterwards, so every case compares the stored value before and after.
 */

const hasDocker = await dockerAvailable();
const ROOT_ID = 123456789;

const ROOT_CONFIG = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const STEP_UP_OPTIONS = { ttlSeconds: 60, lockoutMinutes: 15, maxAttempts: 5 };
const ROOT_ACTOR = { numericUserId: ROOT_ID, chatType: "private" as const };

let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  if (!hasDocker) return;
  await sql`
    truncate table admin_step_up_attempt, admin_step_up_grant, admin_step_up_secret,
      audit_event, outbox_event, quantity_stock_ledger, variant_quantity_stock,
      product_variant, product, category cascade
  `.execute(ctx.db);
});

interface Seeded {
  productId: string;
  variantId: string;
  vault: ReturnType<typeof createInMemoryVault>;
}

/** A variant with a known price, deposit and stock count. */
async function seedVariant(): Promise<Seeded> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, compare_at_price_vnd, deposit_amount_vnd,
       min_deposit_vnd, preorder_enabled, duration_code, delivery_type, warranty_days,
       stock_policy, resale_evidence_id, is_active, fulfillment_type)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 250000, 50000,
       50000, false, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true, 'QUANTITY_STOCK')
  `.execute(ctx.db);
  await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${variantId}, 100)`.execute(
    ctx.db,
  );
  return { productId, variantId, vault: createInMemoryVault() };
}

function deps(seeded: Seeded): SensitiveActionDeps {
  return {
    db: ctx.db,
    rootConfig: ROOT_CONFIG,
    vault: seeded.vault,
    stepUpEnabled: true,
    stepUpOptions: STEP_UP_OPTIONS,
  };
}

/** Enroll the owner and mint a live grant for `category` using a real TOTP code. */
async function grant(
  seeded: Seeded,
  category: StepUpActionCategory,
  binding: {
    actionKey: string;
    resourceType: string;
    resourceId: string;
    requestedData: AuthorizationJsonValue;
  },
): Promise<void> {
  const stepUp = createStepUpService(ctx.db, seeded.vault, STEP_UP_OPTIONS);
  await stepUp.enroll({
    adminTelegramUserId: String(ROOT_ID),
    issuer: "TIER20 SHOP",
    accountLabel: String(ROOT_ID),
  });
  const code = await createTotpCode(seeded.vault, String(ROOT_ID), ctx.db);
  const exact = await loadSensitiveAuthorizationBinding(ctx.db, binding);
  const verified = await stepUp.verify({
    adminTelegramUserId: String(ROOT_ID),
    category,
    code,
    actionKey: binding.actionKey,
    resourceType: binding.resourceType,
    resourceId: binding.resourceId,
    resourceVersion: exact.resourceVersion,
    payloadHash: exact.payloadHash,
  });
  if (!verified.ok) throw new Error(`grant failed: ${verified.code}`);
}

async function priceOf(variantId: string): Promise<string> {
  const row = await sql<{ price_vnd: string }>`
    select price_vnd::text from product_variant where id = ${variantId}
  `.execute(ctx.db);
  return row.rows[0]!.price_vnd;
}

async function stockOf(variantId: string): Promise<number> {
  const row = await sql<{ available_quantity: number }>`
    select available_quantity from variant_quantity_stock where variant_id = ${variantId}
  `.execute(ctx.db);
  return row.rows[0]!.available_quantity;
}

describe.skipIf(!hasDocker)("price and deposit changes require a second factor", () => {
  const base = (seeded: Seeded) => ({
    actor: ROOT_ACTOR,
    config: ROOT_CONFIG,
    db: ctx.db,
    productId: seeded.productId,
    variantId: seeded.variantId,
    expectedVersion: 1,
    reason: "test",
    correlationId: "corr-price",
  });

  it("refuses a price change with no grant and leaves the price untouched", async () => {
    const seeded = await seedVariant();
    const before = await priceOf(seeded.variantId);

    await expect(
      updateAdminVariant({ ...base(seeded), priceVnd: 1n, sensitiveDeps: deps(seeded) }),
    ).rejects.toThrow(/STEP_UP/);

    expect(await priceOf(seeded.variantId)).toBe(before);
  });

  it("refuses a deposit change with no grant and leaves it untouched", async () => {
    const seeded = await seedVariant();
    const before = await sql<{ deposit_amount_vnd: string }>`
      select deposit_amount_vnd::text from product_variant where id = ${seeded.variantId}
    `.execute(ctx.db);

    await expect(
      updateAdminVariant({ ...base(seeded), depositAmountVnd: 1, sensitiveDeps: deps(seeded) }),
    ).rejects.toThrow(/STEP_UP/);

    const after = await sql<{ deposit_amount_vnd: string }>`
      select deposit_amount_vnd::text from product_variant where id = ${seeded.variantId}
    `.execute(ctx.db);
    expect(after.rows[0]!.deposit_amount_vnd).toBe(before.rows[0]!.deposit_amount_vnd);
  });

  it("refuses a money change when the caller passes no step-up deps at all", async () => {
    const seeded = await seedVariant();
    const before = await priceOf(seeded.variantId);

    // Fail closed on a programming mistake too: omitting the deps must not silently
    // downgrade a price change to single-factor.
    await expect(updateAdminVariant({ ...base(seeded), priceVnd: 1n })).rejects.toThrow();

    expect(await priceOf(seeded.variantId)).toBe(before);
  });

  it("applies a price change exactly once with a live BULK_PRICE_CHANGE grant", async () => {
    const seeded = await seedVariant();
    await grant(seeded, "BULK_PRICE_CHANGE", {
      actionKey: "catalog.variant.price.change",
      resourceType: "ProductVariant",
      resourceId: seeded.variantId,
      requestedData: {
        productId: seeded.productId,
        variantId: seeded.variantId,
        expectedVersion: 1,
        priceVnd: "123456",
      },
    });

    await expect(
      updateAdminVariant({ ...base(seeded), priceVnd: 123_456n, sensitiveDeps: deps(seeded) }),
    ).resolves.toBe(true);
    expect(await priceOf(seeded.variantId)).toBe("123456");

    // The grant is single-use, so a second change needs a fresh authorization.
    await expect(
      updateAdminVariant({ ...base(seeded), priceVnd: 999n, sensitiveDeps: deps(seeded) }),
    ).rejects.toThrow(/STEP_UP/);
    expect(await priceOf(seeded.variantId)).toBe("123456");
  });

  it("still allows a content-only edit without a grant", async () => {
    const seeded = await seedVariant();
    const before = await priceOf(seeded.variantId);

    // A rename moves no money, so it stays a single-factor edit. Requiring step-up here
    // would train the owner to approve blindly.
    await expect(
      updateAdminVariant({ ...base(seeded), name: "Tên mới", sensitiveDeps: deps(seeded) }),
    ).resolves.toBe(true);
    expect(await priceOf(seeded.variantId)).toBe(before);
  });
  it("applies a combined price and deposit change with ONE grant", async () => {
    const seeded = await seedVariant();
    await grant(seeded, "BULK_PRICE_CHANGE", {
      actionKey: "catalog.variant.commercial.change",
      resourceType: "ProductVariant",
      resourceId: seeded.variantId,
      requestedData: {
        productId: seeded.productId,
        variantId: seeded.variantId,
        expectedVersion: 1,
        priceVnd: "321000",
        depositAmountVnd: 99000,
      },
    });

    // Both money keys share BULK_PRICE_CHANGE, and the owner approves a kind of change, not
    // a pair of keys. Consuming per key would demand two grants for one approval, so this
    // call could never succeed — the operation that just failed here is the regression.
    await expect(
      updateAdminVariant({
        ...base(seeded),
        priceVnd: 321_000n,
        depositAmountVnd: 99_000,
        sensitiveDeps: deps(seeded),
      }),
    ).resolves.toBe(true);

    const row = await sql<{ price_vnd: string; deposit_amount_vnd: string }>`
      select price_vnd::text, deposit_amount_vnd::text
      from product_variant where id = ${seeded.variantId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({ price_vnd: "321000", deposit_amount_vnd: "99000" });
  });

  it("treats an explicit null compare-at price as a price change", async () => {
    const seeded = await seedVariant();
    await grant(seeded, "BULK_PRICE_CHANGE", {
      actionKey: "catalog.variant.price.change",
      resourceType: "ProductVariant",
      resourceId: seeded.variantId,
      requestedData: {
        productId: seeded.productId,
        variantId: seeded.variantId,
        expectedVersion: 1,
        compareAtPriceVnd: null,
      },
    });

    // Clearing the strikethrough price changes what the customer sees beside the price, so
    // it must not slip past the detector as "no price fields present".
    await expect(
      updateAdminVariant({ ...base(seeded), compareAtPriceVnd: null, sensitiveDeps: deps(seeded) }),
    ).resolves.toBe(true);
    const row = await sql<{ compare_at_price_vnd: string | null }>`
      select compare_at_price_vnd::text from product_variant where id = ${seeded.variantId}
    `.execute(ctx.db);
    expect(row.rows[0]!.compare_at_price_vnd).toBeNull();

    // And it is gated: a second clear with the grant spent is refused.
    await expect(
      updateAdminVariant({
        ...base(seeded),
        compareAtPriceVnd: 111_000n,
        sensitiveDeps: deps(seeded),
      }),
    ).rejects.toThrow(/STEP_UP/);
  });
});

describe.skipIf(!hasDocker)("stock adjustment requires a second factor", () => {
  const base = (seeded: Seeded) => ({
    actor: ROOT_ACTOR,
    config: ROOT_CONFIG,
    db: ctx.db,
    variantId: seeded.variantId,
    expectedStockVersion: 1,
    idempotencyKey: "adjust-1",
    reason: "test",
    correlationId: "corr-stock",
  });

  it("refuses an adjustment with no grant and leaves the quantity untouched", async () => {
    const seeded = await seedVariant();
    const before = await stockOf(seeded.variantId);

    await expect(
      adjustQuantityStock({ ...base(seeded), delta: -100, sensitiveDeps: deps(seeded) }),
    ).rejects.toThrow(/STEP_UP/);

    expect(await stockOf(seeded.variantId)).toBe(before);
  });

  it("refuses an adjustment when no step-up deps are supplied", async () => {
    const seeded = await seedVariant();
    const before = await stockOf(seeded.variantId);

    await expect(adjustQuantityStock({ ...base(seeded), delta: -100 })).rejects.toThrow();

    expect(await stockOf(seeded.variantId)).toBe(before);
  });

  it("applies the adjustment once with a live STOCK_ADJUSTMENT grant", async () => {
    const seeded = await seedVariant();
    await grant(seeded, "STOCK_ADJUSTMENT", {
      actionKey: "inventory.stock.adjust",
      resourceType: "ProductVariant",
      resourceId: seeded.variantId,
      requestedData: {
        variantId: seeded.variantId,
        delta: -30,
        expectedStockVersion: 1,
        idempotencyKey: "adjust-1",
      },
    });

    const result = await adjustQuantityStock({
      ...base(seeded),
      delta: -30,
      sensitiveDeps: deps(seeded),
    });
    expect(result).toMatchObject({ ok: true });
    expect(await stockOf(seeded.variantId)).toBe(70);

    // Single use: the next adjustment is refused and the quantity stays put.
    await expect(
      adjustQuantityStock({
        ...base(seeded),
        expectedStockVersion: 2,
        idempotencyKey: "adjust-2",
        delta: -10,
        sensitiveDeps: deps(seeded),
      }),
    ).rejects.toThrow(/STEP_UP/);
    expect(await stockOf(seeded.variantId)).toBe(70);
  });

  it("refuses a grant minted for a different category", async () => {
    const seeded = await seedVariant();
    await grant(seeded, "BROADCAST", {
      actionKey: "inventory.stock.adjust",
      resourceType: "ProductVariant",
      resourceId: seeded.variantId,
      requestedData: {
        variantId: seeded.variantId,
        delta: -10,
        expectedStockVersion: 1,
        idempotencyKey: "adjust-1",
      },
    });
    const before = await stockOf(seeded.variantId);

    await expect(
      adjustQuantityStock({ ...base(seeded), delta: -10, sensitiveDeps: deps(seeded) }),
    ).rejects.toThrow(/STEP_UP/);

    expect(await stockOf(seeded.variantId)).toBe(before);
  });

  it("refuses to spend a grant that is bound to a different variant", async () => {
    const mine = await seedVariant();
    const other = await seedVariant();
    // Bound to `mine`, exactly as the operator CLI mints it from the refusal it reads back.
    await grant(mine, "BULK_PRICE_CHANGE", {
      actionKey: "catalog.variant.price.change",
      resourceType: "ProductVariant",
      resourceId: mine.variantId,
      requestedData: {
        productId: mine.productId,
        variantId: mine.variantId,
        expectedVersion: 1,
        priceVnd: "777000",
      },
    });

    // Spending it on a DIFFERENT variant must fail: a category check alone would let one
    // approval authorise a change to any variant in the catalogue.
    const otherBefore = await priceOf(other.variantId);
    await expect(
      updateAdminVariant({
        actor: ROOT_ACTOR,
        config: ROOT_CONFIG,
        db: ctx.db,
        productId: other.productId,
        variantId: other.variantId,
        expectedVersion: 1,
        priceVnd: 1n,
        reason: "spend a grant bound elsewhere",
        correlationId: "corr-cross",
        sensitiveDeps: deps(other),
      }),
    ).rejects.toThrow(/STEP_UP/);
    expect(await priceOf(other.variantId)).toBe(otherBefore);

    // And it still works on the variant it was minted for.
    await expect(
      updateAdminVariant({
        actor: ROOT_ACTOR,
        config: ROOT_CONFIG,
        db: ctx.db,
        productId: mine.productId,
        variantId: mine.variantId,
        expectedVersion: 1,
        priceVnd: 777_000n,
        reason: "spend it where it belongs",
        correlationId: "corr-same",
        sensitiveDeps: deps(mine),
      }),
    ).resolves.toBe(true);
    expect(await priceOf(mine.variantId)).toBe("777000");
  });
});
