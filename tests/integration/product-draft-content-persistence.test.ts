import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createProductDraftRepository,
  advanceProductDraft,
} from "../../src/modules/catalog/product-draft.js";
import { createAdminProduct } from "../../src/modules/catalog/admin-products.js";
import { startPostgres, type StartedPg } from "../helpers/pg-container.js";

/**
 * The wizard's per-field content editor (goal §76) writes into the draft, and later steps must
 * carry those values to the create call. A step that rebuilds the draft instead of spreading it
 * silently drops the owner's content: the product is created with NULL description/instructions/
 * warranty, and nothing errors.
 */
describe("product draft content survives every later step", () => {
  let ctx: StartedPg;
  const ADMIN = "6659186592";

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await sql`delete from admin_workflow where admin_telegram_user_id = ${ADMIN}`.execute(
      ctx.handle.db,
    );
  });

  it("keeps every content field through the remaining wizard transitions", async () => {
    const repo = createProductDraftRepository(ctx.handle.db);
    const draft = {
      adminTelegramUserId: ADMIN,
      step: "description" as const,
      name: "San pham",
      slug: "san-pham",
      sku: "SKU-1",
      categoryId: "01M25ZS118M24RG8V3JJAD0J1W",
      fulfillmentType: "STOCK_ACCOUNT" as const,
      inventoryFields: [
        { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
      ],
      deliveryConfig: { selectedOptionalFields: [], customFields: [] },
      shortDescriptionVi: "Mo ta ngan",
      descriptionVi: "Mo ta day du",
      whatCustomerReceivesVi: "Email va mat khau",
      usageInstructionsVi: "Dang nhap roi doi mat khau",
      warrantyVi: "Bao hanh 24 gio",
      deliveryEtaVi: "Vai giay",
      expiresAt: Date.now() + 15 * 60_000,
    };
    await repo.save(draft);

    const reloaded = await repo.load(ADMIN);
    expect(reloaded).toMatchObject({
      shortDescriptionVi: "Mo ta ngan",
      descriptionVi: "Mo ta day du",
      whatCustomerReceivesVi: "Email va mat khau",
      usageInstructionsVi: "Dang nhap roi doi mat khau",
      warrantyVi: "Bao hanh 24 gio",
      deliveryEtaVi: "Vai giay",
    });

    // Step 5 → 6: the field menu's "continue" keeps the content and moves on.
    const atVariant = { ...(await repo.load(ADMIN))!, step: "variant" as const };
    await repo.save(atVariant);

    // Step 6 → 7: the variant line carries the price.
    const variantStep = advanceProductDraft((await repo.load(ADMIN))!, "1 thang | 2000");
    expect(variantStep.ok).toBe(true);
    if (variantStep.ok) await repo.save(variantStep.draft);

    // Step 7 → 8: continuing the delivery configuration keeps every content field.
    const deliveryStep = advanceProductDraft((await repo.load(ADMIN))!, "Tiếp tục");
    expect(deliveryStep.ok).toBe(true);
    if (deliveryStep.ok) await repo.save(deliveryStep.draft);

    const afterDelivery = await repo.load(ADMIN);
    expect(afterDelivery).toMatchObject({
      shortDescriptionVi: "Mo ta ngan",
      descriptionVi: "Mo ta day du",
      whatCustomerReceivesVi: "Email va mat khau",
      usageInstructionsVi: "Dang nhap roi doi mat khau",
      warrantyVi: "Bao hanh 24 gio",
      deliveryEtaVi: "Vai giay",
      step: "visibilityFlags",
    });

    // Step 8 → confirm, then the create call itself: what the owner typed must reach the row.
    const atConfirm = { ...(await repo.load(ADMIN))!, step: "confirm" as const };
    await repo.save(atConfirm);
    const finalDraft = (await repo.load(ADMIN))!;
    expect(finalDraft.step).toBe("confirm");

    const categoryId = "01M25ZS118M24RG8V3JJAD0J1W";
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'Demo', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.handle.db,
    );
    const product = await createAdminProduct({
      actor: { numericUserId: Number(ADMIN), chatType: "private" },
      config: { adminTelegramUserId: Number(ADMIN), expectedUsername: "Quyenvjp" },
      db: ctx.handle.db,
      categoryId: finalDraft.categoryId!,
      name: finalDraft.name!,
      slug: finalDraft.slug!,
      sku: finalDraft.sku!,
      variantName: finalDraft.variantName!,
      fulfillmentType: finalDraft.fulfillmentType!,
      inventoryFields: finalDraft.inventoryFields!,
      shortDescriptionVi: finalDraft.shortDescriptionVi,
      descriptionVi: finalDraft.descriptionVi,
      whatCustomerReceivesVi: finalDraft.whatCustomerReceivesVi,
      usageInstructionsVi: finalDraft.usageInstructionsVi,
      warrantyVi: finalDraft.warrantyVi,
      deliveryEtaVi: finalDraft.deliveryEtaVi,
      isTest: true,
      active: true,
      lowStockThreshold: null,
      priceVnd: finalDraft.priceVnd!,
      reason: "draft content persistence",
      correlationId: "draft-content",
    });

    const row = await sql<{
      short_description_vi: string | null;
      description_vi: string | null;
      what_customer_receives_vi: string | null;
      usage_instructions_vi: string | null;
      warranty_vi: string | null;
      delivery_eta_vi: string | null;
    }>`select short_description_vi, description_vi, what_customer_receives_vi, usage_instructions_vi, warranty_vi, delivery_eta_vi
       from product where id = ${product.id}`.execute(ctx.handle.db);
    expect(row.rows[0]).toEqual({
      short_description_vi: "Mo ta ngan",
      description_vi: "Mo ta day du",
      what_customer_receives_vi: "Email va mat khau",
      usage_instructions_vi: "Dang nhap roi doi mat khau",
      warranty_vi: "Bao hanh 24 gio",
      delivery_eta_vi: "Vai giay",
    });
  });
});
