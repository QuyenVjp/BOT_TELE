import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { listAuditEvents } from "../../src/modules/identity/audit.js";
import { newId } from "../../src/shared/ids/index.js";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import {
  clearVariantSupplierMapping,
  markSupplierSkuManuallyVerified,
  selectVariantSupplierMapping,
} from "../../src/modules/supplier/admin.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
const ROOT_ID = 123456789;
const IMPOSTOR_ID = 999000111;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table admin_confirmation, audit_event, supplier_sku, supplier,
      product_variant, product, category, channel_identity, customer cascade
  `.execute(ctx.db);
});

async function seed() {
  const customerId = newId();
  const rootChannelIdentityId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const supplierId = newId();
  const supplierSkuId = newId();
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${customerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, fulfillment_type, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', 199000, 'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY', 'RES-1', 'SUPPLIER_API', true)
  `.execute(ctx.db);
  await sql`
    insert into supplier (id, name, adapter_type, credential_vault_ref, status)
    values (${supplierId}, 'Primary', 'sandbox', 'vault:supplier', 'ACTIVE')
  `.execute(ctx.db);
  await sql`
    insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values (${supplierSkuId}, ${supplierId}, ${variantId}, 'NF-1M-VN', 120000, 'VN', 'CREDENTIAL', true)
  `.execute(ctx.db);

  return { rootChannelIdentityId, variantId, supplierId, supplierSkuId };
}

function config() {
  return { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
}

describe("supplier admin operations", () => {
  it("selects, manually verifies, and clears an existing variant supplier mapping with root audit", async () => {
    const seeded = await seed();
    const actor = {
      numericUserId: ROOT_ID,
      chatType: "private" as const,
      observedUsername: "Quyenvjp",
    };

    await expect(
      selectVariantSupplierMapping({
        db: ctx.db,
        actor,
        config: config(),
        variantId: seeded.variantId,
        supplierSkuId: seeded.supplierSkuId,
        reason: "Use primary supplier",
        correlationId: "supplier-admin-1",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      markSupplierSkuManuallyVerified({
        db: ctx.db,
        actor,
        config: config(),
        variantId: seeded.variantId,
        supplierSkuId: seeded.supplierSkuId,
        reason: "Checked in supplier portal",
        correlationId: "supplier-admin-2",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      clearVariantSupplierMapping({
        db: ctx.db,
        actor,
        config: config(),
        variantId: seeded.variantId,
        reason: "Pause supplier mapping",
        correlationId: "supplier-admin-3",
      }),
    ).resolves.toEqual({ ok: true });

    const state = await sql<{ supplier_sku_id: string | null; last_verified: boolean }>`
      select v.supplier_sku_id, (ss.last_verified_at is not null) as last_verified
      from product_variant v join supplier_sku ss on ss.id = ${seeded.supplierSkuId}
      where v.id = ${seeded.variantId}
    `.execute(ctx.db);
    expect(state.rows[0]).toEqual({ supplier_sku_id: null, last_verified: true });

    const events = await listAuditEvents(ctx.db, {
      targetType: "SupplierSku",
      targetId: seeded.supplierSkuId,
      limit: 10,
    });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["supplier.mapping.select", "supplier.mapping.verify"]),
    );
    expect(JSON.stringify(events)).not.toMatch(/vault:supplier/i);

    const clearEvents = await listAuditEvents(ctx.db, {
      targetType: "ProductVariant",
      targetId: seeded.variantId,
      limit: 10,
    });
    expect(clearEvents[0]?.action).toBe("supplier.mapping.clear");
    expect(clearEvents[0]?.metadataRedacted).toMatchObject({
      previousSupplierSkuId: seeded.supplierSkuId,
    });
  });

  it("denies non-root supplier mapping through the same root guard", async () => {
    const seeded = await seed();
    const result = await selectVariantSupplierMapping({
      db: ctx.db,
      actor: { numericUserId: IMPOSTOR_ID, chatType: "private", observedUsername: "Quyenvjp" },
      config: config(),
      variantId: seeded.variantId,
      supplierSkuId: seeded.supplierSkuId,
      reason: "bad actor",
      correlationId: "supplier-deny-1",
    });

    expect(result).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    const state = await sql<{
      supplier_sku_id: string | null;
    }>`select supplier_sku_id from product_variant where id = ${seeded.variantId}`.execute(ctx.db);
    expect(state.rows[0]?.supplier_sku_id).toBeNull();
    const denials = await listAuditEvents(ctx.db, {
      targetType: "SupplierSku",
      targetId: seeded.supplierSkuId,
      limit: 10,
    });
    expect(denials[0]?.action).toBe("supplier.mapping.select.denied");
  });

  it("exposes supplier commands through the fixed owner-command auth allowlist", async () => {
    const seeded = await seed();
    const callbacks = createAdminCallbacks({
      db: ctx.db,
      rootConfig: config(),
      rootChannelIdentityId: seeded.rootChannelIdentityId,
      confirmation: createAdminConfirmation(ctx.db),
    });
    const result = await callbacks.handle({
      command: "supplier.mapping.select",
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.variantId,
      input: seeded.supplierSkuId,
      reason: "Select supplier mapping from UI",
      correlationId: "supplier-callback-1",
    });

    expect(result).toEqual({ ok: true, needsConfirmation: false });
    const state = await sql<{
      supplier_sku_id: string | null;
    }>`select supplier_sku_id from product_variant where id = ${seeded.variantId}`.execute(ctx.db);
    expect(state.rows[0]?.supplier_sku_id).toBe(seeded.supplierSkuId);
  });
});
