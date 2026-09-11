import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  findOrderByIdForOwner,
  findOrderByIdForOwnerForUpdate,
  findOrderByNumberForOwner,
} from "../../src/modules/commerce/repository.js";
import {
  findIntentByIdForOwner,
  findLiveIntentByOrderForOwner,
  findLiveIntentByPreorderLegForOwner,
} from "../../src/modules/payments/repository.js";
import {
  findActiveAssetHoldByOrderForOwner,
  findActiveDeliveryBundleForOrderForOwner,
  findDeliveredAssetHistoryForOrderForOwner,
} from "../../src/modules/digital-goods/repository.js";
import { cancelUnpaidOrder } from "../../src/modules/commerce/buy-now.js";
import { getOrderDetailForCustomer } from "../../src/modules/commerce/history.js";
import { createSupportService } from "../../src/modules/support/service.js";
import { openReplacementCase } from "../../src/modules/digital-goods/replacement.js";
import { openWarrantyClaim } from "../../src/modules/warranty/claims.js";
import { presentPreorderPayment } from "../../src/modules/payments/service.js";
import { createWalletPurchaseService } from "../../src/modules/wallet/purchase.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * Cross-customer (BOLA/IDOR) reads: ownership must be enforced INSIDE the
 * query, and a non-owned resource must be indistinguishable from a missing one.
 *
 * The load-bearing assertions are against the returned row set, not the source
 * text — the one source-level check at the end guards the shape of the new
 * queries (an owner predicate interpolating the owner id) for functions the row
 * assertions cannot reach.
 */

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface SeededOrder {
  customerId: string;
  variantId: string;
  orderId: string;
  orderNumber: string;
  intentId: string;
  assetId: string;
  bundleId: string;
}

async function seedCustomerOrder(label: string): Promise<SeededOrder> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const orderNumber = `ORD-${label}-${orderId.slice(-8)}`;
  const intentId = newId();
  const assetId = newId();
  const bundleId = newId();

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, warranty_days, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status, expires_at)
    values (${orderId}, ${orderNumber}, ${customerId}, ${variantId}, 'P', 'V', 200000, 'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'PENDING_PAYMENT', now() + interval '15 minutes')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at, presented_at)
    values (${intentId}, ${orderId}, 'PRESENTED', 200000, 'merchant-1', ${"ORD-" + intentId.slice(-8)}, now() + interval '15 minutes', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id, reserved_until)
    values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId.slice(-8)}, ${"fp-" + assetId.slice(-8)}, 'RESERVED', ${orderId}, now() + interval '15 minutes')
  `.execute(ctx.db);
  await sql`
    insert into delivery_bundle (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
    values (${bundleId}, ${orderId}, ${customerId}, ${assetId}, ${"token-hash-" + bundleId.slice(-8)}, 'AVAILABLE', now() + interval '15 minutes')
  `.execute(ctx.db);

  return { customerId, variantId, orderId, orderNumber, intentId, assetId, bundleId };
}

/** A preorder deposit intent: owned through `preorder_reservation`, not an Order. */
async function seedPreorderDepositIntent(
  seeded: SeededOrder,
): Promise<{ preorderId: string; intentId: string }> {
  const preorderId = newId();
  const intentId = newId();
  await sql`
    insert into preorder_reservation
      (id, variant_id, customer_id, status, deposit_amount_vnd, balance_amount_vnd,
       total_price_vnd, accepted_terms_snapshot)
    values (${preorderId}, ${seeded.variantId}, ${seeded.customerId}, 'WAITING_DEPOSIT',
            50000, 150000, 200000, 'terms-v1')
  `.execute(ctx.db);
  await sql`
    insert into payment_intent
      (id, order_id, preorder_id, kind, status, amount_vnd, merchant_account_id,
       transfer_content, expires_at, presented_at)
    values (${intentId}, null, ${preorderId}, 'DEPOSIT', 'PRESENTED', 50000, 'merchant-1',
            ${"PRE-" + intentId.slice(-8)}, now() + interval '15 minutes', now())
  `.execute(ctx.db);
  return { preorderId, intentId };
}

describe.skipIf(!hasDocker)("cross-customer read isolation (BOLA/IDOR)", () => {
  beforeEach(async () => {
    await sql`
      truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
        bank_transaction, payment_intent, order_transition, "order", product_variant,
        product, category, customer cascade
    `.execute(ctx.db);
  });

  it("returns an order only to its owner and null to everyone else", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const mine = await findOrderByIdForOwner(ctx.db, alice.orderId, alice.customerId);
    expect(mine?.id).toBe(alice.orderId);
    expect(mine?.customerId).toBe(alice.customerId);

    expect(await findOrderByIdForOwner(ctx.db, bob.orderId, alice.customerId)).toBeNull();
    expect(await findOrderByNumberForOwner(ctx.db, bob.orderNumber, alice.customerId)).toBeNull();
    expect(await findOrderByIdForOwnerForUpdate(ctx.db, bob.orderId, alice.customerId)).toBeNull();

    const byNumber = await findOrderByNumberForOwner(ctx.db, alice.orderNumber, alice.customerId);
    expect(byNumber?.id).toBe(alice.orderId);
  });

  it("makes a non-owned order indistinguishable from a non-existent one", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");
    const missingOrderId = newId();

    // Same value, same absence of an error: no existence oracle.
    const foreign = await findOrderByIdForOwner(ctx.db, bob.orderId, alice.customerId);
    const absent = await findOrderByIdForOwner(ctx.db, missingOrderId, alice.customerId);
    expect(foreign).toBeNull();
    expect(absent).toBeNull();
    expect(foreign).toBe(absent);

    await expect(
      findOrderByIdForOwnerForUpdate(ctx.db, bob.orderId, alice.customerId),
    ).resolves.toBeNull();
    await expect(
      findOrderByNumberForOwner(ctx.db, bob.orderNumber, alice.customerId),
    ).resolves.toBeNull();
  });

  it("hides another customer's payment intent", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const own = await findIntentByIdForOwner(ctx.db, alice.intentId, alice.customerId);
    expect(own?.id).toBe(alice.intentId);

    expect(await findIntentByIdForOwner(ctx.db, bob.intentId, alice.customerId)).toBeNull();
    expect(await findLiveIntentByOrderForOwner(ctx.db, bob.orderId, alice.customerId)).toBeNull();
    expect(
      await findLiveIntentByOrderForOwner(ctx.db, alice.orderId, alice.customerId),
    ).not.toBeNull();

    // A preorder leg is owned through the reservation, so the order-scoped
    // lookup refuses it even for the owner while the leg lookup allows them.
    const deposit = await seedPreorderDepositIntent(alice);
    expect(await findIntentByIdForOwner(ctx.db, deposit.intentId, alice.customerId)).toBeNull();
    expect(
      await findLiveIntentByPreorderLegForOwner(
        ctx.db,
        deposit.preorderId,
        "DEPOSIT",
        alice.customerId,
      ),
    ).not.toBeNull();
    expect(
      await findLiveIntentByPreorderLegForOwner(
        ctx.db,
        deposit.preorderId,
        "DEPOSIT",
        bob.customerId,
      ),
    ).toBeNull();
  });

  it("hides another customer's digital asset and delivery bundle", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const ownAsset = await findActiveAssetHoldByOrderForOwner(
      ctx.db,
      alice.orderId,
      alice.customerId,
    );
    expect(ownAsset?.id).toBe(alice.assetId);
    expect(
      await findActiveAssetHoldByOrderForOwner(ctx.db, bob.orderId, alice.customerId),
    ).toBeNull();

    const ownBundle = await findActiveDeliveryBundleForOrderForOwner(
      ctx.db,
      alice.orderId,
      alice.customerId,
    );
    expect(ownBundle?.id).toBe(alice.bundleId);
    // The reveal token hash is never part of the ownership projection.
    expect(ownBundle && "token_hash" in ownBundle).toBe(false);
    expect(
      await findActiveDeliveryBundleForOrderForOwner(ctx.db, bob.orderId, alice.customerId),
    ).toBeNull();
  });

  it("hides another customer's delivered asset history", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");
    // Bob's delivered order: same shape, an asset that is no longer a live hold.
    await sql`
      update digital_asset
      set status = 'DELIVERED', reserved_order_id = null, reserved_until = null,
          delivered_order_id = ${bob.orderId}
      where id = ${bob.assetId}
    `.execute(ctx.db);

    expect(
      await findDeliveredAssetHistoryForOrderForOwner(ctx.db, bob.orderId, bob.customerId),
    ).not.toBeNull();
    expect(
      await findDeliveredAssetHistoryForOrderForOwner(ctx.db, bob.orderId, alice.customerId),
    ).toBeNull();
    expect(
      await findDeliveredAssetHistoryForOrderForOwner(ctx.db, newId(), alice.customerId),
    ).toBeNull();
  });
});

/**
 * The queries themselves must carry the owner predicate. A row-level assertion
 * cannot prove that (it would still pass with a caller-side check), so this
 * pins the shape: every owner-scoped function interpolates the owner id into a
 * `customer_id` predicate.
 */
describe("owner-scoped queries constrain ownership in SQL", () => {
  const ROOT = resolve(import.meta.dirname, "../..");

  function bodyOf(relativePath: string, functionName: string): string {
    const source = readFileSync(resolve(ROOT, relativePath), "utf8");
    const start = source.indexOf(`export async function ${functionName}(`);
    expect(start, `${functionName} missing from ${relativePath}`).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.indexOf("\nexport ", 1);
    return end === -1 ? rest : rest.slice(0, end);
  }

  const cases: Array<[string, string]> = [
    ["src/modules/commerce/repository.ts", "findOrderByIdForOwner"],
    ["src/modules/commerce/repository.ts", "findOrderByIdForOwnerForUpdate"],
    ["src/modules/commerce/repository.ts", "findOrderByNumberForOwner"],
    ["src/modules/payments/repository.ts", "findIntentByIdForOwner"],
    ["src/modules/payments/repository.ts", "findLiveIntentByOrderForOwner"],
    ["src/modules/payments/repository.ts", "findLiveIntentByPreorderLegForOwner"],
    ["src/modules/digital-goods/repository.ts", "findActiveAssetHoldByOrderForOwner"],
    ["src/modules/digital-goods/repository.ts", "findDeliveredAssetHistoryForOrderForOwner"],
    ["src/modules/digital-goods/repository.ts", "findActiveDeliveryBundleForOrderForOwner"],
  ];

  it.each(cases)("%s:%s filters on the owner inside the query", (file, fn) => {
    const body = bodyOf(file, fn);
    expect(body).toContain("customer_id");
    expect(body).toContain("${customerId}");
  });
});

/**
 * OWASP API1 (Broken Object Level Authorization) AT THE SERVICE BOUNDARY.
 *
 * The suites above prove the owner-scoped repository helpers behave correctly. That
 * is necessary but not sufficient: a correct helper that no handler calls protects
 * nothing. These cases drive the real service entry points a Telegram update reaches,
 * with customer B's identifiers presented by customer A, and assert both the refusal
 * and the absence of the side effect.
 *
 * Every refusal is the SAME shape a missing resource produces, so a guessed or
 * enumerated identifier yields no existence oracle.
 */
describe.skipIf(!hasDocker)("cross-customer isolation at the service boundary", () => {
  beforeEach(async () => {
    await sql`
      truncate table support_ticket, warranty_claim, preorder_reservation, wallet_ledger,
        wallet_account, audit_event, outbox_event, delivery_bundle, digital_asset,
        payment_allocation, discrepancy, bank_transaction, payment_intent, order_transition,
        "order", product_variant, product, category, customer cascade
    `.execute(ctx.db);
  });

  it("refuses to cancel another customer's order and leaves it untouched", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const result = await cancelUnpaidOrder(ctx.db, {
      orderId: bob.orderId,
      customerId: alice.customerId,
      correlationId: "bola-cancel",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const row = await sql<{ status: string }>`
      select status from "order" where id = ${bob.orderId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("PENDING_PAYMENT");

    // The owner can still cancel, so the refusal above is authorization, not breakage.
    const owner = await cancelUnpaidOrder(ctx.db, {
      orderId: bob.orderId,
      customerId: bob.customerId,
      correlationId: "bola-cancel-owner",
    });
    expect(owner.ok).toBe(true);
  });

  it("refuses to charge another customer's order to a wallet", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const result = await createWalletPurchaseService(ctx.db).purchase({
      customerId: alice.customerId,
      orderId: bob.orderId,
      idempotencyKey: "bola-wallet-purchase",
      correlationId: "bola-wallet-purchase",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses to link a support ticket to another customer's order", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const result = await createSupportService(ctx.db).openTicket({
      customerId: alice.customerId,
      orderId: bob.orderId,
      reasonCode: "OTHER",
      description: "not mine",
      correlationId: "bola-ticket",
    });
    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND" });

    const tickets = await sql<{ n: number }>`
      select count(*)::int as n from support_ticket
    `.execute(ctx.db);
    expect(tickets.rows[0]?.n).toBe(0);
  });

  it("cannot close another customer's support ticket", async () => {
    const alice = await seedCustomerOrder("A");
    const svc = createSupportService(ctx.db);
    const opened = await svc.openTicket({
      customerId: alice.customerId,
      reasonCode: "OTHER",
      description: "mine",
      correlationId: "bola-close-open",
    });
    if (!opened.ok) throw new Error("seed ticket failed");

    const stranger = newId();
    await sql`insert into customer (id, status, locale) values (${stranger}, 'ACTIVE', 'vi-VN')`.execute(
      ctx.db,
    );
    const closed = await svc.closeTicket({
      ticketId: opened.ticketId,
      customerId: stranger,
      correlationId: "bola-close",
    });
    expect(closed).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const row = await sql<{ status: string }>`
      select status from support_ticket where id = ${opened.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).not.toBe("CLOSED");
  });

  it("refuses a replacement case on another customer's order", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const result = await openReplacementCase(ctx.db, {
      orderId: bob.orderId,
      customerId: alice.customerId,
      reasonCode: "CUSTOMER_REQUEST",
      correlationId: "bola-replacement",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses a warranty claim on another customer's order", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    const result = await openWarrantyClaim({
      db: ctx.db,
      customerId: alice.customerId,
      orderId: bob.orderId,
      issueType: "LOST_BENEFITS",
      correlationId: "bola-warranty",
    });
    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND" });

    const claims = await sql<{ n: number }>`
      select count(*)::int as n from warranty_claim
    `.execute(ctx.db);
    expect(claims.rows[0]?.n).toBe(0);
  });

  it("refuses to mint a payment QR for another customer's preorder reservation", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");
    const deposit = await seedPreorderDepositIntent(bob);

    const merchant = {
      merchantAccountId: "merchant-1",
      beneficiaryAccountNumber: "merchant-1",
      bankBin: "970422",
      accountName: "SHOP",
    };

    const stolen = await presentPreorderPayment(ctx.db, {
      ...merchant,
      customerId: alice.customerId,
      reservationId: deposit.preorderId,
      leg: "DEPOSIT",
      correlationId: "bola-preorder",
    });
    expect(stolen).toMatchObject({ ok: false, error: "NOT_FOUND" });

    // No intent was minted for the foreign reservation.
    const intents = await sql<{ n: number }>`
      select count(*)::int as n from payment_intent where preorder_id = ${deposit.preorderId}
    `.execute(ctx.db);
    expect(intents.rows[0]?.n).toBe(1); // only the seed's own DEPOSIT intent
  });

  it("returns no order detail for another customer's order id", async () => {
    const alice = await seedCustomerOrder("A");
    const bob = await seedCustomerOrder("B");

    expect(
      await getOrderDetailForCustomer(ctx.db, {
        orderId: bob.orderId,
        customerId: alice.customerId,
      }),
    ).toBeNull();
    expect(
      await getOrderDetailForCustomer(ctx.db, {
        orderId: bob.orderId,
        customerId: bob.customerId,
      }),
    ).not.toBeNull();
  });
});
