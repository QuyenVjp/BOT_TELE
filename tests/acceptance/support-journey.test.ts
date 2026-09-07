import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createHistoryCallbacks } from "../../src/bot/callbacks/history.js";
import { createSupportCallbacks } from "../../src/bot/callbacks/support.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T083 — History-to-support acceptance journey (User Story 4).
 *
 * Alice and Bob each have Orders. Alice opens history (sees only hers), opens a
 * detail, and creates a structured support ticket linked to her Order. Bob's
 * Orders never surface. The ticket stores a safe summary without a secret.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Seeded {
  aliceId: string;
  bobId: string;
  aliceOrderNumber: string;
  aliceOrderId: string;
  bobOrderNumber: string;
}

async function seedTwoCustomers(): Promise<Seeded> {
  const aliceId = newId();
  const bobId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const aliceOrderId = newId();
  const bobOrderId = newId();
  const aliceOrderNumber = "ORD-ALICE-" + aliceOrderId.slice(-6);
  const bobOrderNumber = "ORD-BOB-" + bobOrderId.slice(-6);
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${aliceId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into customer (id, status, locale) values (${bobId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', 199000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${aliceOrderId}, ${aliceOrderNumber}, ${aliceId}, ${variantId}, 'Netflix', 'Premium 1 tháng',
      199000, 'P1M', 'CREDENTIAL', 'COMPLETED', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, delivered_order_id)
    values
      (${newId()}, ${variantId}, 'LOCAL', 'vault:alice-original', 'fp-alice-original', 'DELIVERED', ${aliceOrderId})
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status)
    values (${bobOrderId}, ${bobOrderNumber}, ${bobId}, ${variantId}, 'Netflix', 'Premium 1 tháng',
      199000, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT')
  `.execute(ctx.db);

  return { aliceId, bobId, aliceOrderNumber, aliceOrderId, bobOrderNumber };
}

beforeEach(async () => {
  await sql`
    truncate table support_ticket, delivery_bundle, digital_asset, order_transition, outbox_event,
      "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

describe("US4 history → support journey", () => {
  it("Alice sees only her orders and opens a structured ticket without a secret", async () => {
    const seed = await seedTwoCustomers();
    const history = createHistoryCallbacks({ db: ctx.db });
    const support = createSupportCallbacks({ db: ctx.db });

    // 1. History: Alice sees only her order.
    const list = await history.list(seed.aliceId);
    expect(list.text).toContain(seed.aliceOrderNumber);
    expect(list.text).not.toContain(seed.bobOrderNumber);

    // 2. Detail: Alice can open her own order.
    const detail = await history.detail(seed.aliceOrderNumber, seed.aliceId);
    expect(detail.text).toContain(seed.aliceOrderNumber);
    expect(detail.text).toContain("Hoàn tất");
    // Support affordance is present.
    expect(detail.buttons.flat().some((b) => b.callbackData.startsWith("sup:open:"))).toBe(true);

    // 3. BOLA: Alice cannot open Bob's order by number.
    const bobAsAlice = await history.detail(seed.bobOrderNumber, seed.aliceId);
    expect(bobAsAlice.text.toLowerCase()).toMatch(/không|sở hữu|tìm thấy/);

    // 4. Structured ticket open linked to Alice's order.
    const ticket = await support.open({
      customerId: seed.aliceId,
      reasonCode: "ASSET_NOT_WORKING",
      orderNumber: seed.aliceOrderNumber,
      description: "Tài khoản báo lỗi đăng nhập. user:pass-SHOULD-NOT-STORE",
      correlationId: "journey-1",
    });
    expect(ticket.text).toContain("ticket");
    expect(ticket.text).toContain(seed.aliceOrderNumber);
    // No secret in the confirmation message.
    expect(ticket.text).not.toContain("SHOULD-NOT-STORE");

    // 5. Ticket row is safe + owned.
    const rows = await sql<{
      customer_id: string;
      order_id: string | null;
      safe_summary: string;
      replacement_case_id: string | null;
    }>`
      select st.customer_id, st.order_id, st.safe_summary, rc.id as replacement_case_id
      from support_ticket st
      left join replacement_case rc on rc.order_id = st.order_id
    `.execute(ctx.db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.customer_id).toBe(seed.aliceId);
    expect(rows.rows[0]?.order_id).toBe(seed.aliceOrderId);
    expect(rows.rows[0]?.safe_summary).not.toContain("SHOULD-NOT-STORE");
    expect(rows.rows[0]?.replacement_case_id).toBeTruthy();
  });
});
