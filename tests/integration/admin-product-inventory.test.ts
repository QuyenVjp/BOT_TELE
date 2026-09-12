import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createHash } from "node:crypto";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { drainOutboxOnce } from "../../src/infrastructure/outbox/worker.js";
import {
  claimNotificationDeliveries,
  handleNotificationOutboxEvent,
  processNotificationDeliveryClaim,
} from "../../src/modules/notification/service.js";
import { subscribeRestock } from "../../src/modules/catalog/restock.js";
import {
  createAdminProduct,
  createAdminVariant,
  updateAdminVariant,
} from "../../src/modules/catalog/admin-products.js";
import {
  createDurableProductDraftWorkflow,
  createProductDraftRepository,
} from "../../src/modules/catalog/product-draft.js";
import {
  confirmInventoryImportSession,
  createInventoryImportTemplate,
  stageInventoryImportDocument,
  stageInventoryImportInput,
  startInventoryImportSession,
} from "../../src/modules/digital-goods/inventory-import-session.js";
import { importDigitalInventory } from "../../src/modules/digital-goods/inventory-import.js";
import { listVariantInventoryHistory } from "../../src/modules/catalog/quantity-stock.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const ROOT_ID = 123456789;
const rootConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };

/**
 * These cases exercise the product/inventory plumbing, not authorization, so step-up is
 * explicitly OFF — the documented development/test posture (identity and audit still run, no
 * second factor is demanded). The second factor over the money fields is covered by
 * tests/security/admin-money-mutation-gating.test.ts with step-up ON.
 */
const variantStepUpDeps = {
  get db() {
    return ctx.db;
  },
  rootConfig,
  vault: createInMemoryVault(),
  stepUpEnabled: false,
  stepUpOptions: { ttlSeconds: 300, lockoutMinutes: 15, maxAttempts: 5 },
};
const rootActor = {
  numericUserId: ROOT_ID,
  chatType: "private" as const,
  observedUsername: "Quyenvjp",
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table admin_inventory_import, admin_workflow, audit_event, digital_asset,
      variant_file_artifact, quantity_stock_ledger, variant_quantity_stock, supplier_sku, supplier, product_variant, product, category cascade
  `.execute(ctx.db);
});

describe("admin product creation and selected-variant inventory import", () => {
  it("persists the product wizard config, creates the variant, and imports secrets through a bound session", async () => {
    const categoryId = newId();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Streaming', 'streaming', true, 1)`.execute(
      ctx.db,
    );

    const workflow = createDurableProductDraftWorkflow(createProductDraftRepository(ctx.db));
    await workflow.start(String(ROOT_ID));
    for (const value of [
      "Netflix",
      "NF_PREM",
      categoryId,
      "STOCK_ACCOUNT",
      "Tài khoản Netflix Premium",
      "Premium|120000",
      "ok",
      "PUBLIC",
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }

    const draft = await workflow.get(String(ROOT_ID));
    expect(draft).toMatchObject({
      step: "confirm",
      variantName: "Premium",
      fulfillmentType: "STOCK_ACCOUNT",
    });
    expect(draft?.inventoryFields?.map((field) => field.name)).toEqual([
      "email",
      "username",
      "password",
    ]);

    const created = await createAdminProduct({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      categoryId,
      name: draft!.name!,
      slug: draft!.slug!,
      sku: draft!.sku!,
      variantName: draft!.variantName!,
      fulfillmentType: draft!.fulfillmentType!,
      inventoryFields: draft!.inventoryFields!,
      lowStockThreshold: 2,
      priceVnd: draft!.priceVnd!,
      reason: "integration product create",
      correlationId: "admin-product-inventory:create",
    });

    expect(created).toMatchObject({
      name: "Netflix",
      sku: "NF_PREM",
      fulfillmentType: "STOCK_ACCOUNT",
      lowStockThreshold: 2,
    });
    const variant = (
      await sql<{
        name_vi: string;
        fulfillment_type: string;
        inventory_fields: unknown;
        low_stock_threshold: number | null;
      }>`
      select name_vi, fulfillment_type, inventory_fields, low_stock_threshold
      from product_variant where id = ${created.variantId}
    `.execute(ctx.db)
    ).rows[0]!;
    expect(variant).toMatchObject({
      name_vi: "Premium",
      fulfillment_type: "STOCK_ACCOUNT",
      low_stock_threshold: 2,
    });
    expect(
      (variant.inventory_fields as Array<{ name: string }>).map((field) => field.name),
    ).toEqual(["email", "username", "password"]);

    const vault = createInMemoryVault();
    await expect(
      startInventoryImportSession(ctx.db, {
        actor: { numericUserId: ROOT_ID, chatType: "group" },
        config: rootConfig,
        correlationId: "admin-product-inventory:wrong-context",
        variantId: created.variantId,
      }),
    ).resolves.toMatchObject({ ok: false, code: "WRONG_CONTEXT" });
    await expect(
      startInventoryImportSession(ctx.db, {
        actor: { numericUserId: ROOT_ID + 1, chatType: "private" },
        config: rootConfig,
        correlationId: "admin-product-inventory:not-root",
        variantId: created.variantId,
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });

    const started = await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:start-import",
      variantId: created.variantId,
    });
    expect(started).toMatchObject({ ok: true, session: { previewVariants: [created.variantId] } });

    const staged = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:stage-import",
      // The variant's schema is [email, username, password]: a row that fills only two of them
      // leaves a required field empty and the import refuses it, so the fixture fills all three.
      rawInput: "user1@example.invalid:user1:pass1\nuser2@example.invalid:user2:pass2",
    });
    expect(staged).toMatchObject({ ok: true, preview: { ready: 2, invalid: 0, duplicates: 0 } });
    if (!staged.ok) return;
    expect(staged.preview.lines.map((line) => line.variantId)).toEqual([
      created.variantId,
      created.variantId,
    ]);

    const subscribedCustomerId = newId();
    const unsubscribedCustomerId = newId();
    await sql`
      insert into customer (id, status, locale)
      values (${subscribedCustomerId}, 'ACTIVE', 'vi'), (${unsubscribedCustomerId}, 'ACTIVE', 'vi')
    `.execute(ctx.db);
    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id)
      values (${newId()}, ${subscribedCustomerId}, 'TELEGRAM', '111111'), (${newId()}, ${unsubscribedCustomerId}, 'TELEGRAM', '222222')
    `.execute(ctx.db);
    await subscribeRestock(ctx.db, subscribedCustomerId, created.variantId);
    await sql`
      insert into notification_preference(customer_id, shop_updates, purchase_activity)
      values (${subscribedCustomerId}, false, false), (${unsubscribedCustomerId}, false, false)
    `.execute(ctx.db);
    const confirmed = await confirmInventoryImportSession(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:confirm-import",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      summary: { imported: 2, duplicates: 0, invalid: 0 },
    });

    const stock = await sql<{
      count: string;
    }>`select count(*)::text from digital_asset where variant_id = ${created.variantId} and status = 'AVAILABLE'`.execute(
      ctx.db,
    );
    expect(stock.rows[0]?.count).toBe("2");

    const drain = await drainOutboxOnce(ctx.db, {
      batchSize: 5,
      maxAttempts: 5,
      handler: (event) => handleNotificationOutboxEvent(ctx.db, event),
    });
    expect(drain).toMatchObject({ published: 2, failed: 0 });
    const deliveries = await sql<{ customer_id: string; chat_id: string; class: string }>`
      select d.customer_id, d.chat_id, c.class
      from notification_delivery d
      join notification_campaign c on c.id = d.campaign_id
      order by d.customer_id
    `.execute(ctx.db);
    expect(deliveries.rows).toEqual([
      {
        customer_id: subscribedCustomerId,
        chat_id: "111111",
        class: "SHOP_UPDATE",
      },
    ]);

    const [claim] = await claimNotificationDeliveries(ctx.db, 1);
    let sent = 0;
    const result = await processNotificationDeliveryClaim(ctx.db, claim!, {
      send: async () => {
        sent += 1;
      },
    });
    expect(result).toBe("SENT");
    expect(sent).toBe(1);

    await workflow.start(String(ROOT_ID));
    for (const value of [
      "Manual",
      "MANUAL_1",
      categoryId,
      "MANUAL_FULFILLMENT",
      "Xử lý thủ công",
      "Setup|120000",
      "Activate account manually",
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }
    const manualDraft = await workflow.get(String(ROOT_ID));
    const manual = await createAdminProduct({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      categoryId,
      name: manualDraft!.name!,
      slug: manualDraft!.slug!,
      sku: manualDraft!.sku!,
      variantName: manualDraft!.variantName!,
      fulfillmentType: manualDraft!.fulfillmentType!,
      inventoryFields: manualDraft!.inventoryFields!,
      lowStockThreshold: null,
      serviceInstructions: manualDraft!.serviceInstructions!,
      priceVnd: manualDraft!.priceVnd!,
      reason: "integration manual product create",
      correlationId: "admin-product-inventory:create-manual",
    });
    await expect(
      sql<{
        instructions: string;
      }>`select instructions from variant_service_fulfillment where variant_id = ${manual.variantId} and fulfillment_type = 'MANUAL_FULFILLMENT'`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ instructions: "Activate account manually" }] });

    await workflow.start(String(ROOT_ID));
    for (const value of [
      "Quantity",
      "QTY_1",
      categoryId,
      "QUANTITY_STOCK",
      "Voucher số lượng",
      "Voucher|120000",
      "5",
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }
    const quantityDraft = await workflow.get(String(ROOT_ID));
    const quantity = await createAdminProduct({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      categoryId,
      name: quantityDraft!.name!,
      slug: quantityDraft!.slug!,
      sku: quantityDraft!.sku!,
      variantName: quantityDraft!.variantName!,
      fulfillmentType: quantityDraft!.fulfillmentType!,
      inventoryFields: quantityDraft!.inventoryFields!,
      lowStockThreshold: null,
      serviceInstructions: "Hand over voucher",
      initialQuantity: quantityDraft!.initialQuantity!,
      priceVnd: quantityDraft!.priceVnd!,
      reason: "integration quantity product create",
      correlationId: "admin-product-inventory:create-quantity",
    });
    await expect(
      sql<{
        available_quantity: number;
      }>`select available_quantity::int from variant_quantity_stock where variant_id = ${quantity.variantId}`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({ rows: [{ available_quantity: 5 }] });
    await expect(
      sql<{
        entry_type: string;
        quantity_delta: number;
        quantity_after: number;
      }>`select entry_type, quantity_delta::int, quantity_after::int from quantity_stock_ledger where variant_id = ${quantity.variantId}`.execute(
        ctx.db,
      ),
    ).resolves.toMatchObject({
      rows: [{ entry_type: "ADJUST", quantity_delta: 5, quantity_after: 5 }],
    });

    await workflow.start(String(ROOT_ID));
    for (const value of [
      "File",
      "FILE_1",
      categoryId,
      "DIGITAL_FILE",
      "Tệp tải xuống",
      "Download|120000",
      "ok",
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }
    const fileDraft = await workflow.get(String(ROOT_ID));
    const file = await createAdminProduct({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      categoryId,
      name: fileDraft!.name!,
      slug: fileDraft!.slug!,
      sku: fileDraft!.sku!,
      variantName: fileDraft!.variantName!,
      fulfillmentType: fileDraft!.fulfillmentType!,
      inventoryFields: fileDraft!.inventoryFields!,
      lowStockThreshold: null,
      active: false,
      priceVnd: fileDraft!.priceVnd!,
      reason: "integration file product create",
      correlationId: "admin-product-inventory:create-file",
    });
    expect(file.active).toBe(false);
    await expect(
      sql<{
        is_active: boolean;
        artifact_count: number;
      }>`
        select v.is_active, count(a.id)::int as artifact_count
        from product_variant v
        left join variant_file_artifact a on a.variant_id = v.id
        where v.id = ${file.variantId}
        group by v.id
      `.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ is_active: false, artifact_count: 0 }] });
    const supplierId = newId();
    await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${supplierId}, 'Supplier', 'fixture', 'vault:supplier', 'ACTIVE')`.execute(
      ctx.db,
    );
    await workflow.start(String(ROOT_ID));
    for (const value of [
      "Supplier",
      "SUP_1",
      categoryId,
      "SUPPLIER_API",
      "Nhà cung cấp",
      "Remote|120000",
      `${supplierId}|EXT-SKU|80000|VN`,
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }
    const supplierDraft = await workflow.get(String(ROOT_ID));
    const supplier = await createAdminProduct({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      categoryId,
      name: supplierDraft!.name!,
      slug: supplierDraft!.slug!,
      sku: supplierDraft!.sku!,
      variantName: supplierDraft!.variantName!,
      fulfillmentType: supplierDraft!.fulfillmentType!,
      inventoryFields: supplierDraft!.inventoryFields!,
      lowStockThreshold: null,
      supplierConfig: {
        supplierId: supplierDraft!.supplierConfig!.supplierId,
        externalSku: supplierDraft!.supplierConfig!.externalSku,
        costVnd: supplierDraft!.supplierConfig!.costVnd,
        region: supplierDraft!.supplierConfig!.region ?? "VN",
      },
      priceVnd: supplierDraft!.priceVnd!,
      reason: "integration supplier product create",
      correlationId: "admin-product-inventory:create-supplier",
    });
    const supplierSku = await sql<{
      external_sku: string;
      cost_vnd: string;
      region: string;
      selected: boolean;
    }>`
      select ss.external_sku, ss.cost_vnd::text as cost_vnd, ss.region, pv.supplier_sku_id = ss.id as selected
      from supplier_sku ss join product_variant pv on pv.id = ss.variant_id
      where ss.variant_id = ${supplier.variantId}
    `.execute(ctx.db);
    expect(supplierSku.rows).toEqual([
      { external_sku: "EXT-SKU", cost_vnd: "80000", region: "VN", selected: true },
    ]);

    const extraVariant = await createAdminVariant({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      productId: created.id,
      variantId: newId(),
      sku: "NF_EXTRA",
      name: "Extra",
      priceVnd: 99000n,
      durationCode: "MONTHLY",
      warrantyDays: 7,
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [
        {
          name: "username",
          label: "Tên đăng nhập",
          required: true,
          secret: false,
          customerVisible: true,
        },
      ],
      lowStockThreshold: 1,
      reason: "integration variant create",
      correlationId: "admin-product-inventory:create-variant",
    });
    const beforeUpdate = (
      await sql<{
        version: number;
      }>`select version from product_variant where id=${extraVariant.variantId}`.execute(ctx.db)
    ).rows[0]!;
    await expect(
      updateAdminVariant({
        actor: rootActor,
        config: rootConfig,
        db: ctx.db,
        productId: created.id,
        variantId: extraVariant.variantId,
        expectedVersion: beforeUpdate.version,
        name: "Extra Plus",
        priceVnd: 109000n,
        sensitiveDeps: variantStepUpDeps,
        durationCode: "YEARLY",
        warrantyDays: 14,
        lowStockThreshold: null,
        reason: "integration variant update",
        correlationId: "admin-product-inventory:update-variant",
      }),
    ).resolves.toBe(true);
    await expect(
      updateAdminVariant({
        actor: rootActor,
        config: rootConfig,
        db: ctx.db,
        productId: created.id,
        variantId: extraVariant.variantId,
        expectedVersion: beforeUpdate.version,
        priceVnd: 110000n,
        sensitiveDeps: variantStepUpDeps,
        reason: "stale variant update",
        correlationId: "admin-product-inventory:update-variant-stale",
      }),
    ).resolves.toBe(false);
    await expect(
      sql<{
        product_name: string;
        variant_name: string;
        price_vnd: string;
        duration_code: string;
        warranty_days: number;
        low_stock_threshold: number | null;
        version: number;
      }>`
        select p.name_vi as product_name, v.name_vi as variant_name, v.price_vnd::text as price_vnd, v.duration_code, v.warranty_days, v.low_stock_threshold, v.version
        from product_variant v join product p on p.id=v.product_id
        where v.id=${extraVariant.variantId}
      `.execute(ctx.db),
    ).resolves.toMatchObject({
      rows: [
        {
          product_name: "Netflix",
          variant_name: "Extra Plus",
          price_vnd: "109000",
          duration_code: "YEARLY",
          warranty_days: 14,
          low_stock_threshold: null,
          version: beforeUpdate.version + 1,
        },
      ],
    });

    const productCountBeforeVariantDraft = (
      await sql<{ count: string }>`select count(*)::text as count from product`.execute(ctx.db)
    ).rows[0]!.count;
    await workflow.startVariant(String(ROOT_ID), created.id);
    for (const value of [
      "NF_STREAM",
      "UNLIMITED_SERVICE",
      "Dịch vụ không giới hạn",
      "Streaming|150000",
      "Provision recurring access",
      "PUBLIC",
    ]) {
      const result = await workflow.advance(String(ROOT_ID), value);
      expect(result.ok).toBe(true);
    }
    const variantDraft = await createProductDraftRepository(ctx.db).load(String(ROOT_ID));
    expect(variantDraft).toMatchObject({
      step: "confirm",
      existingProductId: created.id,
      sku: "NF_STREAM",
      variantName: "Streaming",
      fulfillmentType: "UNLIMITED_SERVICE",
    });
    await createAdminVariant({
      actor: rootActor,
      config: rootConfig,
      db: ctx.db,
      productId: variantDraft!.existingProductId!,
      variantId: newId(),
      sku: variantDraft!.sku!,
      name: variantDraft!.variantName!,
      fulfillmentType: variantDraft!.fulfillmentType!,
      inventoryFields: variantDraft!.inventoryFields!,
      lowStockThreshold: null,
      serviceInstructions: variantDraft!.serviceInstructions!,
      priceVnd: variantDraft!.priceVnd!,
      reason: "integration restarted variant draft",
      correlationId: "admin-product-inventory:variant-draft-create",
    });
    await expect(
      sql<{ count: string }>`select count(*)::text as count from product`.execute(ctx.db),
    ).resolves.toMatchObject({ rows: [{ count: productCountBeforeVariantDraft }] });
  });

  it("generates selected-variant CSV templates and imports only filled valid rows", async () => {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const otherVariantId = newId();
    const vault = createInMemoryVault();
    const inventoryFields = [
      {
        name: "email",
        label: "Email",
        required: true,
        secret: false,
        customerVisible: true,
      },
      { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
      {
        name: "note",
        label: "Ghi chú nội bộ",
        required: false,
        secret: false,
        customerVisible: false,
      },
    ];

    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Streaming', ${"tpl-" + categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Template Product', ${"tpl-product-" + productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, inventory_fields)
      values
        (${variantId}, ${productId}, 'TPL_MAIN', 'Main', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT', ${JSON.stringify(inventoryFields)}::jsonb),
        (${otherVariantId}, ${productId}, 'TPL_OTHER', 'Other', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT', ${JSON.stringify(inventoryFields)}::jsonb)
    `.execute(ctx.db);
    await sql`update product_variant set is_active = false where id = ${variantId}`.execute(ctx.db);

    const template = await createInventoryImportTemplate(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:template",
      variantId,
    });
    expect(template).toMatchObject({
      ok: true,
      template: {
        csv: `email,password,note
<email:required>,<password:required>,<note:optional>
`,
      },
    });
    const inactiveTemplate = await createInventoryImportTemplate(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:inactive-template",
      variantId,
    });
    expect(inactiveTemplate).toMatchObject({ ok: true });

    if (!template.ok) return;

    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:template-start",
      variantId,
    });
    expect(
      await startInventoryImportSession(ctx.db, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:inactive-template-start",
        variantId,
      }),
    ).toMatchObject({ ok: true });
    const staged = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:template-stage",
      rawInput: `password,email,note\n"NOT,A-REAL-CREDENTIAL",canary@example.invalid,"CANARY\nNOT-FOR-SALE"\n`,
    });
    expect(staged).toMatchObject({ ok: true, preview: { ready: 1, invalid: 0, duplicates: 0 } });
    if (!staged.ok) return;
    expect(staged.preview.lines).toHaveLength(1);
    expect(staged.preview.lines[0]).toMatchObject({ variantId, code: "READY" });

    const restaged = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:template-restage",
      rawInput: `email,password,note\ncanary2@example.invalid,SECOND-SAFE-VALUE,SECOND-NOTE\n`,
    });
    expect(restaged).toMatchObject({ ok: true, preview: { ready: 1, invalid: 0, duplicates: 0 } });
    if (!restaged.ok) return;
    expect(restaged.preview.lines).toHaveLength(1);
    expect(restaged.preview.lines[0]).toMatchObject({ variantId, code: "READY" });

    const confirmed = await confirmInventoryImportSession(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:template-confirm",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      summary: { imported: 1, invalid: 0, duplicates: 0 },
    });

    const stored = await sql<{
      vault_ref: string;
    }>`select vault_ref from digital_asset where variant_id = ${variantId}`.execute(ctx.db);
    expect(stored.rows).toHaveLength(1);
    const material = JSON.parse(await vault.reveal(stored.rows[0]!.vault_ref)) as {
      values: Array<{ name: string; value: string }>;
    };
    expect(material.values).toEqual([
      { name: "email", value: "canary2@example.invalid" },
      { name: "password", value: "SECOND-SAFE-VALUE" },
      { name: "note", value: "SECOND-NOTE" },
    ]);

    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:missing-start",
      variantId,
    });
    const missing = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:missing-stage",
      rawInput: `variantId,username,password,note\n${variantId},secret-user,,hidden-note\n`,
    });
    expect(missing).toMatchObject({ ok: true, preview: { ready: 0, invalid: 1, duplicates: 0 } });
    if (!missing.ok) return;
    expect(missing.preview.lines[0]).toMatchObject({
      line: 1,
      variantId,
      code: "MISSING_REQUIRED_FIELD",
    });
    expect(JSON.stringify(missing.preview)).not.toContain("secret-user");
    expect(JSON.stringify(missing.preview)).not.toContain("hidden-note");

    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:cross-start",
      variantId,
    });
    const cross = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:cross-stage",
      rawInput: `variantId,username,password,note\n${otherVariantId},bob,pw,wrong-variant\n`,
    });
    expect(cross).toMatchObject({ ok: true, preview: { ready: 0, invalid: 1, duplicates: 0 } });
    if (!cross.ok) return;
    expect(cross.preview.lines[0]).toMatchObject({ variantId: null, code: "INVALID" });
    const crossConfirm = await confirmInventoryImportSession(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:cross-confirm",
    });
    expect(crossConfirm).toMatchObject({
      ok: true,
      summary: { imported: 0, invalid: 1, duplicates: 0 },
    });
  });

  it("rejects selected-variant credential sessions, templates, and text uploads for non-secret types", async () => {
    const categoryId = newId();
    const productId = newId();
    const fileVariantId = newId();
    const quantityVariantId = newId();
    const vault = createInMemoryVault();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Typed', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Typed Product', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
      values
        (${fileVariantId}, ${productId}, 'FILE_TYPED', 'File', 100000, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY', 'DIGITAL_FILE'),
        (${quantityVariantId}, ${productId}, 'QTY_TYPED', 'Qty', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'QUANTITY_STOCK')
    `.execute(ctx.db);
    await sql`insert into variant_quantity_stock (variant_id, available_quantity) values (${quantityVariantId}, 3)`.execute(
      ctx.db,
    );

    await expect(
      createInventoryImportTemplate(ctx.db, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:file-template-denied",
        variantId: fileVariantId,
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
    await expect(
      startInventoryImportSession(ctx.db, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:qty-import-denied",
        variantId: quantityVariantId,
      }),
    ).resolves.toMatchObject({ ok: false });

    await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:secret-start",
      variantId: fileVariantId,
    });
    const staged = await stageInventoryImportInput(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:file-stage-denied",
      rawInput: "secret-one",
    });
    expect(staged).toMatchObject({ ok: false });
    const stored = await sql<{
      count: string;
    }>`select count(*)::text as count from digital_asset`.execute(ctx.db);
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("stages bounded csv and txt document uploads through the selected variant session", async () => {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const vault = createInMemoryVault();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Docs', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Doc Product', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type)
      values (${variantId}, ${productId}, 'DOC_MAIN', 'Main', 100000, 'P1M', 'ACTIVATION_KEY', 'LOCAL_ONLY', 'STOCK_CODE')
    `.execute(ctx.db);
    const started = await startInventoryImportSession(ctx.db, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:doc-start",
      variantId,
    });
    expect(started).toMatchObject({ ok: true });
    const staged = await stageInventoryImportDocument(ctx.db, vault, {
      actor: rootActor,
      config: rootConfig,
      correlationId: "admin-product-inventory:doc-stage",
      document: { fileId: "file-1", filename: "codes.txt", mimeType: "text/plain", fileSize: 9 },
      downloader: { downloadText: async () => "CODE-ONE\nCODE-TWO" },
    });
    expect(staged).toMatchObject({ ok: true, preview: { ready: 2, invalid: 0, duplicates: 0 } });
    if (!staged.ok) return;
    expect(staged.preview.lines.map((line) => line.variantId)).toEqual([variantId, variantId]);
    await expect(
      stageInventoryImportDocument(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:doc-large",
        document: {
          fileId: "file-2",
          filename: "codes.csv",
          mimeType: "text/csv",
          fileSize: 64 * 1024 + 1,
        },
        downloader: { downloadText: async () => "SHOULD_NOT_DOWNLOAD" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("generates STOCK_CODE CSV templates and rejects non-text upload MIME types", async () => {
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const vault = createInMemoryVault();
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Codes', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Code Product', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, inventory_fields)
      values (${variantId}, ${productId}, 'CODE_MAIN', 'Main', 100000, 'P1M', 'ACTIVATION_KEY', 'LOCAL_ONLY', 'STOCK_CODE', ${JSON.stringify([{ name: "code", label: "Mã kích hoạt", required: true, secret: true, customerVisible: true }])}::jsonb)
    `.execute(ctx.db);
    await expect(
      startInventoryImportSession(ctx.db, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:code-start",
        variantId,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      createInventoryImportTemplate(ctx.db, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:code-template",
        variantId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      template: {
        csv: `code
<code:required>
`,
      },
    });
    await expect(
      stageInventoryImportDocument(ctx.db, vault, {
        actor: rootActor,
        config: rootConfig,
        correlationId: "admin-product-inventory:code-invalid-mime",
        document: {
          fileId: "file-3",
          filename: "codes.pdf",
          mimeType: "application/pdf",
          fileSize: 9,
        },
        downloader: { downloadText: async () => "SHOULD_NOT_DOWNLOAD" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED_DOCUMENT" });
  });

  it("records per-variant import audit counts for multi-variant imports", async () => {
    const categoryId = newId();
    const productId = newId();
    const firstVariantId = newId();
    const secondVariantId = newId();
    const vault = createInMemoryVault();
    const duplicateSecret = "existing-secret";
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Audit', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Audit Product', ${productId.slice(-8)}, true, 1)`.execute(
      ctx.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
      values (${firstVariantId}, ${productId}, 'AUDIT_FIRST', 'First', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY'),
             (${secondVariantId}, ${productId}, 'AUDIT_SECOND', 'Second', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY')
    `.execute(ctx.db);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${newId()}, ${firstVariantId}, 'LOCAL', 'vault-existing', ${createHash("sha256").update(duplicateSecret, "utf8").digest("hex")}, 'AVAILABLE')
    `.execute(ctx.db);

    const result = await importDigitalInventory({
      actor: rootActor,
      config: rootConfig,
      vault,
      db: ctx.db,
      input: `${firstVariantId},alpha\n${firstVariantId},${duplicateSecret}\n${firstVariantId},\n${secondVariantId},bravo\n${secondVariantId},charlie`,
      reason: "multi variant import audit",
      correlationId: "admin-product-inventory:multi-audit",
    });

    expect(result).toMatchObject({ ok: true, summary: { imported: 3, duplicates: 1, invalid: 1 } });
    expect(
      JSON.stringify(await sql`select metadata_redacted from audit_event`.execute(ctx.db)),
    ).not.toContain(duplicateSecret);
    expect(
      await listVariantInventoryHistory({
        db: ctx.db,
        actor: rootActor,
        config: rootConfig,
        variantId: firstVariantId,
        correlationId: "admin-product-inventory:first-history",
      }),
    ).toMatchObject({ ok: true, rows: [{ detail: "mới 1, trùng 1, lỗi 1" }] });
    expect(
      await listVariantInventoryHistory({
        db: ctx.db,
        actor: rootActor,
        config: rootConfig,
        variantId: secondVariantId,
        correlationId: "admin-product-inventory:second-history",
      }),
    ).toMatchObject({ ok: true, rows: [{ detail: "mới 2, trùng 0, lỗi 0" }] });
  });
});
