import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  applyInventoryItemAction,
  inventoryItemRef,
  listInventoryItems,
} from "../../src/modules/digital-goods/inventory-item-ops.js";
import { claimLocalAsset } from "../../src/modules/digital-goods/repository.js";
import { startPostgres, type StartedPg } from "../helpers/pg-container.js";
import { newId } from "../../src/shared/ids/index.js";
import type { RootActor, RootAdminConfig } from "../../src/modules/identity/root-admin.js";

const ROOT_ID = 123456789;
const rootActor: RootActor = { numericUserId: ROOT_ID, chatType: "private" };
const rootConfig: RootAdminConfig = {
  adminTelegramUserId: ROOT_ID,
  expectedUsername: "Quyenvjp",
};

/**
 * Goal §89 — the owner can quarantine, restore and revoke a single stock item, and the guarantee
 * that matters is behavioural: an item moved out of AVAILABLE cannot be sold by the claim path,
 * even though the claim runs concurrently and independently of these screens.
 */
describe("inventory item operations (owner stock hygiene)", () => {
  let ctx: StartedPg;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  async function seedVariantWithAssets(
    count: number,
  ): Promise<{ variantId: string; assetIds: string[] }> {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Ops', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.handle.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Ops Pack', ${"ops-" + categoryId.slice(-8)}, true, 1)`.execute(
      ctx.handle.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Ops', 2000, 'P1M', 'ACTIVATION_KEY', 'LOCAL_ONLY', 'STOCK_CODE')
    `.execute(ctx.handle.db);
    const assetIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = newId();
      assetIds.push(id);
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${id}, ${variantId}, 'LOCAL', ${"vault-" + id}, ${"fp-" + id}, 'AVAILABLE')
      `.execute(ctx.handle.db);
    }
    return { variantId, assetIds };
  }

  /** The claim path is the sale path: nothing else decides what a customer can buy. */
  async function claim(variantId: string): Promise<string | null> {
    const orderId = newId();
    const customerId = newId();
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.handle.db,
    );
    await sql`
      insert into "order"
        (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type, status)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'Ops Pack', 'Ops', 2000, 'P1M', 'ACTIVATION_KEY', 'LOCAL_ONLY', 'STOCK_CODE', 'PAID')
    `.execute(ctx.handle.db);
    const result = await claimLocalAsset(ctx.handle.db, {
      orderId,
      variantId,
      correlationId: "ops-claim",
    });
    return result.ok ? result.assetId : null;
  }

  it("stops selling a quarantined item and sells it again after a restore", async () => {
    const { variantId, assetIds } = await seedVariantWithAssets(2);
    const [first, second] = assetIds as [string, string];

    const quarantined = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(first),
      action: "QUARANTINE",
      reason: "Credential reported bad",
      correlationId: "ops-quarantine",
    });
    expect(quarantined).toMatchObject({ ok: true, status: "COMPROMISED" });

    // The quarantined item is never handed to a customer; the claim takes the other one.
    expect(await claim(variantId)).toBe(second);
    expect(await claim(variantId)).toBe(null);

    const restored = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(first),
      action: "RESTORE",
      reason: "Credential verified again",
      correlationId: "ops-restore",
    });
    expect(restored).toMatchObject({ ok: true, status: "AVAILABLE" });

    expect(await claim(variantId)).toBe(first);
  });

  it("revokes terminally and refuses to restore a revoked item", async () => {
    const { variantId, assetIds } = await seedVariantWithAssets(1);
    const [only] = assetIds as [string];

    const revoked = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(only),
      action: "REVOKE",
      reason: "Leaked credential",
      correlationId: "ops-revoke",
    });
    expect(revoked).toMatchObject({ ok: true, status: "REVOKED" });
    expect(await claim(variantId)).toBe(null);

    const restore = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(only),
      action: "RESTORE",
      reason: "Trying to bring it back",
      correlationId: "ops-restore-revoked",
    });
    expect(restore).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("never touches an item a customer's money is already attached to", async () => {
    const { variantId, assetIds } = await seedVariantWithAssets(1);
    const [only] = assetIds as [string];
    expect(await claim(variantId)).toBe(only);

    const items = await listInventoryItems(ctx.handle.db, { variantId });
    const reserved = items.find((item) => item.ref === inventoryItemRef(only));
    expect(reserved?.status).toBe("RESERVED");
    expect(reserved?.actions).toEqual([]);

    const attempt = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(only),
      action: "QUARANTINE",
      reason: "Should not be possible",
      correlationId: "ops-reserved",
    });
    expect(attempt).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("denies a non-root actor and an unknown item ref", async () => {
    const { variantId, assetIds } = await seedVariantWithAssets(1);
    const [only] = assetIds as [string];

    const denied = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: { numericUserId: 999, chatType: "private" },
      config: rootConfig,
      variantId,
      ref: inventoryItemRef(only),
      action: "QUARANTINE",
      reason: "Not the owner",
      correlationId: "ops-denied",
    });
    expect(denied).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });

    const missing = await applyInventoryItemAction({
      db: ctx.handle.db,
      actor: rootActor,
      config: rootConfig,
      variantId,
      ref: "does-not-exist",
      action: "QUARANTINE",
      reason: "Unknown ref",
      correlationId: "ops-missing",
    });
    expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
