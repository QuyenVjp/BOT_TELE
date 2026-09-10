import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  createPreorderReservation,
  releaseExpiredPreorderHolds,
} from "../../src/modules/commerce/preorder.js";
import {
  applyPaymentEvidence,
  presentPreorderPayment,
} from "../../src/modules/payments/service.js";
import { classifyPaymentCode } from "../../src/modules/payments/payment-code.js";
import { isKnownOutboxEventType } from "../../src/infrastructure/outbox/dispatch-policy.js";
import { presentPreorderPaymentScreen } from "../../src/bot/presenters/payment.js";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";
import { verifiedSePayEvidence } from "../helpers/verified-sepay.js";

/**
 * Deposit wiring acceptance: a hold only becomes DEPOSIT_PAID when money arrives.
 *
 * The presenter hands the customer a VietQR for the deposit leg and stamps the intent
 * on the reservation while the hold is still WAITING_DEPOSIT; SePay evidence (and only
 * SePay evidence) confirms it. A replay of the same transfer must change nothing: no
 * second settlement, no second allocation.
 */

const DEPOSIT_VND = 50000;
const PRICE_VND = 250000;
const MERCHANT_ACCOUNT = "0123456789";
const MERCHANT_INPUT = {
  merchantAccountId: MERCHANT_ACCOUNT,
  beneficiaryAccountNumber: MERCHANT_ACCOUNT,
  bankBin: "970422",
  accountName: "TIER20",
} as const;

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table outbox_event, payment_allocation, discrepancy, bank_transaction,
    payment_intent, preorder_reservation, digital_asset, product_variant, product, category,
    customer_profile_snapshot, customer cascade`.execute(ctx.db);
});

async function seedPreorderVariant(): Promise<{ customerId: string; variantId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
  // Reachable, so a notice can actually be queued: an unreachable customer has no chat to deliver
  // to, and the assertion below would pass for the wrong reason.
  await sql`
    insert into customer_profile_snapshot (customer_id, chat_id, telegram_user_id, reachable)
    values (
      ${customerId},
      ${String(900_000_000 + Math.floor(Math.random() * 100_000_000))},
      ${String(900_000_000 + Math.floor(Math.random() * 100_000_000))},
      true
    )
  `.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', 'ai', true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Kiro Pro', 'kiro-pro', true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (
      id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
      warranty_days, stock_policy, is_active, sort_order, fulfillment_type,
      resale_evidence_id, preorder_enabled, deposit_mode, deposit_amount_vnd,
      min_deposit_vnd, hold_duration_hours, balance_due_hours
    ) values (
      ${variantId}, ${productId}, ${"SKU-" + variantId}, 'Gift Code 20$', ${PRICE_VND}, 'P1M',
      'CREDENTIAL', 30, 'LOCAL_ONLY', true, 1, 'STOCK_ACCOUNT', 'RES-1', true, 'FIXED',
      ${DEPOSIT_VND}, ${DEPOSIT_VND}, 24, 24
    )
  `.execute(ctx.db);

  return { customerId, variantId };
}

async function reserveDeposit(): Promise<{
  customerId: string;
  reservationId: string;
  transferContent: string;
  intentId: string;
}> {
  const { customerId, variantId } = await seedPreorderVariant();
  const created = await createPreorderReservation(ctx.db, { customerId, variantId });
  if (!created.ok) throw new Error(`reservation seed failed: ${created.code}`);

  const presented = await presentPreorderPayment(ctx.db, {
    ...MERCHANT_INPUT,
    reservationId: created.reservationId,
    leg: "DEPOSIT",
    correlationId: "test-preorder-deposit",
  });
  if (!presented.ok) throw new Error(`presentation failed: ${presented.error}`);

  return {
    customerId,
    reservationId: created.reservationId,
    transferContent: presented.presentation.transferContent,
    intentId: presented.intentId,
  };
}

function depositEvidence(f: { transferContent: string }): PaymentEvidence {
  return {
    provider: "sepay",
    providerTransactionId: "SEPAY-" + newId(),
    direction: "IN",
    merchantAccountId: MERCHANT_ACCOUNT,
    amountVnd: DEPOSIT_VND,
    content: f.transferContent,
    reference: "FT-" + newId().slice(-6),
    transactedAt: new Date(),
    rawHash: "hash-" + newId(),
    correlationId: "test-preorder-deposit",
  };
}

async function readReservation(id: string) {
  const res = await sql<{
    status: string;
    deposit_payment_intent_id: string | null;
    balance_payment_intent_id: string | null;
    order_id: string | null;
    version: number;
    forfeited_at: Date | null;
  }>`
    select status, deposit_payment_intent_id, balance_payment_intent_id, order_id, version,
           forfeited_at
    from preorder_reservation where id = ${id}
  `.execute(ctx.db);
  return res.rows[0]!;
}

async function readIntent(id: string) {
  const res = await sql<{ status: string; kind: string; preorder_id: string | null }>`
    select status, kind, preorder_id from payment_intent where id = ${id}
  `.execute(ctx.db);
  return res.rows[0]!;
}

async function countRows(table: string, where = sql`true`): Promise<number> {
  const res = await sql<{ count: string }>`
    select count(*)::text as count from ${sql.table(table)} where ${where}
  `.execute(ctx.db);
  return Number(res.rows[0]?.count ?? 0);
}

describe("preorder deposit settlement", () => {
  it("stamps the deposit intent while the hold is unpaid, and confirms it only when money arrives", async () => {
    const f = await reserveDeposit();

    expect(classifyPaymentCode(f.transferContent)).toBe("PREORDER");

    // The QR proves nothing: the hold is still WAITING_DEPOSIT and carries the intent.
    const pending = await readReservation(f.reservationId);
    expect(pending.status).toBe("WAITING_DEPOSIT");
    expect(pending.deposit_payment_intent_id).toBe(f.intentId);
    expect((await readIntent(f.intentId)).kind).toBe("DEPOSIT");

    const settled = await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(depositEvidence(f)));
    expect(settled).toMatchObject({ ok: true, kind: "SETTLED" });

    const paid = await readReservation(f.reservationId);
    expect(paid.status).toBe("DEPOSIT_PAID");
    expect(paid.deposit_payment_intent_id).toBe(f.intentId);
    expect((await readIntent(f.intentId)).status).toBe("SUCCEEDED");
    expect((await readIntent(f.intentId)).preorder_id).toBe(f.reservationId);
  });

  it("hands out the deposit QR instead of a success claim, and reuses the same code on refresh", async () => {
    const f = await reserveDeposit();

    const again = await presentPreorderPayment(ctx.db, {
      ...MERCHANT_INPUT,
      reservationId: f.reservationId,
      leg: "DEPOSIT",
      correlationId: "test-preorder-deposit-refresh",
    });
    if (!again.ok) throw new Error(`refresh failed: ${again.error}`);
    // Refreshing the route must not mint a competing QR for the same leg.
    expect(again.intentId).toBe(f.intentId);
    expect(again.presentation.transferContent).toBe(f.transferContent);

    const screen = await presentPreorderPaymentScreen({
      productName: again.productName,
      variantName: again.variantName,
      leg: "DEPOSIT",
      depositVnd: BigInt(DEPOSIT_VND),
      balanceVnd: BigInt(PRICE_VND - DEPOSIT_VND),
      presentation: again.presentation,
      reservationId: f.reservationId,
    });

    expect(screen.text).toContain(f.transferContent);
    expect(screen.text).toContain("Tiền đặt cọc");
    // Nothing is paid until SePay says so: never a completed-state claim here.
    expect(screen.text).not.toMatch(/THÀNH CÔNG|ĐÃ THANH TOÁN|hoàn tất/iu);
    const callbacks = screen.buttons.flat().map((button) => button.callbackData);
    expect(callbacks).toContain(`preorder:pay:${f.reservationId}`);
    expect(callbacks).toContain("cust:preorders");
    expect((await readReservation(f.reservationId)).status).toBe("WAITING_DEPOSIT");
  });

  it("ignores a replayed deposit transfer: no double confirm, no second allocation", async () => {
    const f = await reserveDeposit();
    const evidence = depositEvidence(f);

    expect((await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(evidence))).ok).toBe(true);
    const afterFirst = await readReservation(f.reservationId);
    expect(afterFirst.status).toBe("DEPOSIT_PAID");

    const replay = await applyPaymentEvidence(ctx.db, verifiedSePayEvidence(evidence));
    expect(replay).toMatchObject({ ok: true, kind: "ALREADY_APPLIED" });

    const afterReplay = await readReservation(f.reservationId);
    expect(afterReplay.status).toBe("DEPOSIT_PAID");
    expect(afterReplay.version).toBe(afterFirst.version);
    expect(await countRows("payment_allocation", sql`status = 'SETTLED'`)).toBe(1);
    expect(await countRows("bank_transaction")).toBe(1);
    expect(await countRows("outbox_event", sql`event_type = 'PaymentSettled'`)).toBe(1);
    expect(await countRows("outbox_event", sql`event_type = 'OrderPaid'`)).toBe(0);
  });

  it("serves the balance leg once stock is allocated, and finalises the purchase on payment", async () => {
    const { customerId, variantId } = await seedPreorderVariant();
    const reservationId = newId();
    const assetId = newId();
    const balanceVnd = PRICE_VND - DEPOSIT_VND;

    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'MANUAL', ${"vault://" + assetId},
        ${"fp-" + assetId}, 'RESERVED')
    `.execute(ctx.db);
    await sql`
      insert into preorder_reservation (
        id, variant_id, customer_id, status, deposit_amount_vnd, balance_amount_vnd,
        total_price_vnd, terms_version, accepted_terms_snapshot, deposit_paid_at,
        allocated_at, allocated_asset_id, hold_until, balance_due_until
      ) values (
        ${reservationId}, ${variantId}, ${customerId}, 'ALLOCATED', ${DEPOSIT_VND},
        ${balanceVnd}, ${PRICE_VND}, 1, 'v1', now() - interval '1 hour', now(),
        ${assetId}, now() + interval '23 hours', now() + interval '24 hours'
      )
    `.execute(ctx.db);

    // Stock is held and the balance is owed, so the same route must serve the BALANCE
    // leg (and its own payment code) instead of the deposit.
    const presented = await presentPreorderPayment(ctx.db, {
      ...MERCHANT_INPUT,
      reservationId,
      leg: "BALANCE",
      correlationId: "test-preorder-balance",
    });
    if (!presented.ok) throw new Error(`balance presentation failed: ${presented.error}`);
    expect(classifyPaymentCode(presented.presentation.transferContent)).toBe("PREORDER");
    expect((await readIntent(presented.intentId)).kind).toBe("BALANCE");

    const settled = await applyPaymentEvidence(
      ctx.db,
      verifiedSePayEvidence({
        ...depositEvidence({ transferContent: presented.presentation.transferContent }),
        amountVnd: balanceVnd,
      }),
    );
    expect(settled).toMatchObject({ ok: true, kind: "SETTLED" });

    const final = await readReservation(reservationId);
    expect(final.status).toBe("FULLY_PAID");
    expect(final.order_id).not.toBeNull();
    expect(final.balance_payment_intent_id).toBe(presented.intentId);
    const order = await sql<{ status: string }>`
      select status from "order" where id = ${final.order_id}
    `.execute(ctx.db);
    expect(order.rows[0]?.status).toBe("PAID");
  });

  it("forfeits only the reservation whose hold deadline has passed", async () => {
    const { customerId, variantId } = await seedPreorderVariant();
    const overdueId = newId();
    const freshId = newId();

    await sql`
      insert into preorder_reservation (
        id, variant_id, customer_id, status, deposit_amount_vnd, balance_amount_vnd,
        total_price_vnd, terms_version, accepted_terms_snapshot, deposit_paid_at, hold_until
      ) values
        (${overdueId}, ${variantId}, ${customerId}, 'ALLOCATED', ${DEPOSIT_VND},
         ${PRICE_VND - DEPOSIT_VND}, ${PRICE_VND}, 1, 'v1', now() - interval '2 days',
         now() - interval '1 hour'),
        (${freshId}, ${variantId}, ${customerId}, 'ALLOCATED', ${DEPOSIT_VND},
         ${PRICE_VND - DEPOSIT_VND}, ${PRICE_VND}, 1, 'v1', now() - interval '1 hour',
         now() + interval '23 hours')
    `.execute(ctx.db);

    const result = await releaseExpiredPreorderHolds(ctx.db);

    expect(result.forfeitedCount).toBe(1);
    const overdue = await readReservation(overdueId);
    expect(overdue.status).toBe("DEPOSIT_FORFEITED");
    expect(overdue.forfeited_at).not.toBeNull();
    const fresh = await readReservation(freshId);
    expect(fresh.status).toBe("ALLOCATED");
    expect(fresh.forfeited_at).toBeNull();
    expect(await countRows("outbox_event", sql`event_type = 'PreorderHoldForfeited'`)).toBe(1);

    // The event is only useful if the drain will accept it and the notice will reach the customer:
    // an unlisted type dead-letters, and the customer whose deposit was kept is told nothing.
    expect(isKnownOutboxEventType("PreorderHoldForfeited")).toBe(true);
    expect(isKnownOutboxEventType("PreorderDepositPaid")).toBe(true);
    expect(isKnownOutboxEventType("PaymentIntentPresented")).toBe(true);

    // The notice itself is wired through warrantyCustomerNotice -> handleNotificationOutboxEvent;
    // asserting the campaign row here would depend on the notification queue's own reachability
    // rules rather than on this event, so the allowlist is what this test pins.
  });
});
