import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { shopCancelPreorder } from "../../src/modules/commerce/shop-cancel.js";
import { releaseExpiredPreorderHolds } from "../../src/modules/commerce/preorder.js";
import { handleNotificationOutboxEvent } from "../../src/modules/notification/service.js";
import { generateCustomerAlias } from "../../src/modules/marketing/social-proof.js";
import { presentAdminPreorders } from "../../src/bot/presenters/admin.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import type { OutboxEvent } from "../../src/infrastructure/outbox/repository.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table shop_refund_obligation, outbox_event, audit_event, notification_delivery,
      notification_campaign, digital_asset, preorder_reservation, product_variant, product,
      category, customer cascade
  `.execute(ctx.db);
});

async function seedVariant(): Promise<{ variantId: string; customerId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'GPT', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (
      id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
      warranty_days, stock_policy, is_active, sort_order, fulfillment_type,
      resale_evidence_id, preorder_enabled, deposit_mode, deposit_amount_vnd,
      min_deposit_vnd, hold_duration_hours, balance_due_hours
    ) values (
      ${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, '1 tháng', 250000, 'P1M', 'CREDENTIAL',
      30, 'LOCAL_ONLY', true, 1, 'STOCK_ACCOUNT', 'RES-1', true, 'FIXED', 50000, 50000, 24, 24
    )
  `.execute(ctx.db);
  return { variantId, customerId };
}

async function insertReservation(input: {
  variantId: string;
  customerId: string;
  status: string;
  deposit: number;
  balance: number;
  total: number;
  depositPaid?: boolean;
  assetId?: string | undefined;
  holdUntil?: Date | undefined;
}): Promise<string> {
  const id = newId();
  await sql`
    insert into preorder_reservation (
      id, variant_id, customer_id, status,
      deposit_amount_vnd, balance_amount_vnd, total_price_vnd,
      terms_version, accepted_terms_snapshot, deposit_paid_at, allocated_asset_id, hold_until
    ) values (
      ${id}, ${input.variantId}, ${input.customerId}, ${input.status}::text,
      ${input.deposit}::bigint, ${input.balance}::bigint, ${input.total}::bigint,
      1, 'v1', ${input.depositPaid ? new Date().toISOString() : null}::timestamptz,
      ${input.assetId ?? null}::text, ${input.holdUntil?.toISOString() ?? null}::timestamptz
    )
  `.execute(ctx.db);
  return id;
}

describe("shop-cancel refund-due writer", () => {
  it("A: unpaid reservation becomes SHOP_CANCELLED with no obligation", async () => {
    const seed = await seedVariant();
    const id = await insertReservation({
      ...seed,
      status: "WAITING_DEPOSIT",
      deposit: 50000,
      balance: 200000,
      total: 250000,
    });
    const result = await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Shop không thể cung cấp sản phẩm này.",
      correlationId: "c-a",
    });
    expect(result).toMatchObject({
      ok: true,
      status: "SHOP_CANCELLED",
      amountVnd: 0,
      obligationId: null,
    });
    const row = await sql<{ status: string; forfeited_at: Date | string | null }>`
      select status, forfeited_at from preorder_reservation where id = ${id}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("SHOP_CANCELLED");
    expect(row.rows[0]?.forfeited_at).toBeNull();
    const obligations = await sql<{
      n: number;
    }>`select count(*)::int as n from shop_refund_obligation`.execute(ctx.db);
    expect(obligations.rows[0]?.n).toBe(0);
  });

  it("B: deposit paid becomes REFUND_DUE for deposit only", async () => {
    const seed = await seedVariant();
    const id = await insertReservation({
      ...seed,
      status: "DEPOSIT_PAID",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
    });
    const result = await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Hết nguồn cung.",
      correlationId: "c-b",
    });
    expect(result).toMatchObject({ ok: true, status: "REFUND_DUE", amountVnd: 50000 });
    expect(result.ok && result.obligationId).toBeTruthy();
  });

  it("C: fully paid obligation is deposit plus balance, never unpaid catalog price", async () => {
    const seed = await seedVariant();
    const id = await insertReservation({
      ...seed,
      status: "FULLY_PAID",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
    });
    const result = await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Không giao được.",
      correlationId: "c-c",
    });
    expect(result).toMatchObject({ ok: true, status: "REFUND_DUE", amountVnd: 250000 });
  });

  it("D: releases a reserved asset to AVAILABLE once", async () => {
    const seed = await seedVariant();
    const assetId = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${seed.variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'RESERVED')
    `.execute(ctx.db);
    const id = await insertReservation({
      ...seed,
      status: "ALLOCATED",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
      assetId,
    });
    await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Hết hàng nguồn.",
      correlationId: "c-d",
    });
    const asset = await sql<{
      status: string;
    }>`select status from digital_asset where id = ${assetId}`.execute(ctx.db);
    expect(asset.rows[0]?.status).toBe("AVAILABLE");
  });

  it("E: second cancel is idempotent and keeps one obligation", async () => {
    const seed = await seedVariant();
    const id = await insertReservation({
      ...seed,
      status: "DEPOSIT_PAID",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
    });
    const first = await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Hết nguồn.",
      correlationId: "c-e1",
    });
    const second = await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Hết nguồn.",
      correlationId: "c-e2",
    });
    expect(first).toMatchObject({ ok: true, idempotent: false, status: "REFUND_DUE" });
    expect(second).toMatchObject({
      ok: true,
      idempotent: true,
      status: "REFUND_DUE",
      obligationId: first.ok ? first.obligationId : null,
    });
    const obligations = await sql<{
      n: number;
    }>`select count(*)::int as n from shop_refund_obligation`.execute(ctx.db);
    expect(obligations.rows[0]?.n).toBe(1);
  });

  it("F: does not reuse forfeit semantics; expiry still forfeits a different row", async () => {
    const seed = await seedVariant();
    const otherCustomer = newId();
    await sql`insert into customer (id, status, locale) values (${otherCustomer}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const paidId = await insertReservation({
      ...seed,
      status: "DEPOSIT_PAID",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
    });
    const expiredId = await insertReservation({
      variantId: seed.variantId,
      customerId: otherCustomer,
      status: "ALLOCATED",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
      holdUntil: new Date(Date.now() - 60_000),
    });
    await shopCancelPreorder(ctx.db, {
      preorderId: paidId,
      actorTelegramUserId: "1",
      reason: "Huỷ shop.",
      correlationId: "c-f",
    });
    const forfeited = await releaseExpiredPreorderHolds(ctx.db);
    expect(forfeited.forfeitedCount).toBe(1);
    const rows = await sql<{ id: string; status: string; forfeited_at: Date | string | null }>`
      select id, status, forfeited_at from preorder_reservation where id in (${paidId}, ${expiredId})
    `.execute(ctx.db);
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(paidId)?.status).toBe("REFUND_DUE");
    expect(byId.get(paidId)?.forfeited_at).toBeNull();
    expect(byId.get(expiredId)?.status).toBe("DEPOSIT_FORFEITED");
    expect(byId.get(expiredId)?.forfeited_at).not.toBeNull();
  });

  it("queues Vietnamese shop-cancel copy that never says already refunded", async () => {
    const seed = await seedVariant();
    const id = await insertReservation({
      ...seed,
      status: "DEPOSIT_PAID",
      deposit: 50000,
      balance: 200000,
      total: 250000,
      depositPaid: true,
    });
    await shopCancelPreorder(ctx.db, {
      preorderId: id,
      actorTelegramUserId: "1",
      reason: "Hết nguồn.",
      correlationId: "c-n",
    });
    const event = await sql<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      event_type: string;
      payload_redacted: Record<string, unknown>;
    }>`
      select id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
      from outbox_event where event_type = 'PreorderShopCancelled' limit 1
    `.execute(ctx.db);
    const row = event.rows[0]!;
    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id)
      values (${newId()}, ${seed.customerId}, 'TELEGRAM', '1001')
    `.execute(ctx.db);
    const outbox: OutboxEvent = {
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      eventType: row.event_type,
      payloadRedacted: row.payload_redacted,
      attemptCount: 0,
      claimedBy: "test",
      generation: 1,
    };
    const published = await handleNotificationOutboxEvent(ctx.db, outbox);
    expect(published).toEqual({ kind: "PUBLISHED" });
    const campaign = await sql<{ content: string }>`
      select content from notification_campaign where idempotency_key = ${"preorder-shop-cancelled:" + id}
    `.execute(ctx.db);
    expect(campaign.rows[0]?.content).toContain("Shop không thể cung cấp sản phẩm này.");
    expect(campaign.rows[0]?.content).toContain("Đang chờ hoàn tiền");
    expect(campaign.rows[0]?.content).not.toContain("đã hoàn tiền");
  });

  it("admin preorder list uses HMAC alias, never raw customer id", () => {
    const customerId = "01CUSTOMERIDEXAMPLE000001";
    const presented = presentAdminPreorders({
      filter: "refund_due",
      items: [
        {
          id: "01PREORDEREXAMPLE000000001",
          variantId: "v1",
          productName: "GPT",
          variantName: "1 tháng",
          status: "DEPOSIT_PAID",
          depositVnd: 50000,
          balanceVnd: 200000,
          customerName: generateCustomerAlias(customerId),
        },
      ],
    });
    expect(presented.text).toContain("Khách #");
    expect(presented.text).not.toContain(customerId);
    expect(presented.buttons.flat().some((button) => button.callbackData.includes("cancel:"))).toBe(
      true,
    );
  });
});
