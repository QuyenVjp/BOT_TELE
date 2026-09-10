import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  ADMIN_PRODUCT_CONTENT_FIELDS,
  updateAdminProductContent,
} from "../../src/modules/catalog/admin-products.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Goal §81 — editing a product's commercial content in place.
 *
 * The update is a whitelisted single field, so an unknown field name must be rejected rather than
 * reaching SQL, the version guard must refuse a stale edit, and clearing a field must store NULL.
 */

let ctx: PgTestContext;
const ROOT_ID = 6659186592;
const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
const config = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedProduct(): Promise<{ productId: string; version: number }> {
  const categoryId = newId();
  const productId = newId();
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'Claude Pro', ${productId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  const row = await sql<{
    version: number;
  }>`select version from product where id = ${productId}`.execute(ctx.db);
  return { productId, version: row.rows[0]!.version };
}

const update = (productId: string, version: number, field: string, value: string) =>
  updateAdminProductContent({
    actor,
    config,
    db: ctx.db,
    productId,
    expectedVersion: version,
    field,
    value,
    reason: "test content edit",
    correlationId: "t-content",
  });

describe("admin product content edit", () => {
  it("writes each whitelisted field into its own column", async () => {
    const { productId, version } = await seedProduct();

    expect(await update(productId, version, "warranty", "Bảo hành 12 tháng")).toBe(true);
    expect(await update(productId, version + 1, "whatCustomerReceives", "Email và mật khẩu")).toBe(
      true,
    );

    const row = await sql<{ warranty_vi: string | null; what_customer_receives_vi: string | null }>`
      select warranty_vi, what_customer_receives_vi from product where id = ${productId}
    `.execute(ctx.db);
    expect(row.rows[0]?.warranty_vi).toBe("Bảo hành 12 tháng");
    expect(row.rows[0]?.what_customer_receives_vi).toBe("Email và mật khẩu");
  });

  it("clears a field instead of storing an empty string", async () => {
    const { productId, version } = await seedProduct();
    await update(productId, version, "usageInstructions", "abc");
    await update(productId, version + 1, "usageInstructions", "");

    const row = await sql<{ usage_instructions_vi: string | null }>`
      select usage_instructions_vi from product where id = ${productId}
    `.execute(ctx.db);
    expect(row.rows[0]?.usage_instructions_vi).toBeNull();
  });

  it("refuses an unknown field name before it can reach SQL", async () => {
    const { productId, version } = await seedProduct();
    await expect(update(productId, version, "is_active", "false")).rejects.toThrow(
      /INVALID_CONTENT_FIELD/,
    );
    await expect(update(productId, version, "name_vi; drop table product", "x")).rejects.toThrow(
      /INVALID_CONTENT_FIELD/,
    );
  });

  it("refuses a stale version and never blanks the name", async () => {
    const { productId, version } = await seedProduct();
    expect(await update(productId, version + 99, "warranty", "x")).toBe(false);
    await expect(update(productId, version, "name", "   ")).rejects.toThrow(/INVALID_NAME/);
  });

  it("covers exactly the commercial content fields, search tags included", () => {
    expect(Object.keys(ADMIN_PRODUCT_CONTENT_FIELDS)).toEqual([
      "name",
      "shortDescription",
      "description",
      "whatCustomerReceives",
      "usageInstructions",
      "warranty",
      "deliveryEta",
      "terms",
      "support",
      // Goal §27/§28: the searchable tags the owner sets here are the terms search reads.
      "tags",
    ]);
  });
});
