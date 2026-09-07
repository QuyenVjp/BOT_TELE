import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import { importDigitalInventory } from "../../src/modules/digital-goods/inventory-import.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { listAuditEvents } from "../../src/modules/identity/audit.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const ROOT_ID = 123456789;
const IMPOSTOR_ID = 987654321;
const ROOT_CONFIG = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table admin_confirmation, audit_event, outbox_event, wallet_ledger, wallet_account,
      digital_asset, order_transition, "order", product_variant, product, category,
      channel_identity, customer cascade
  `.execute(ctx.db);
});

interface Seeded {
  rootChannelIdentityId: string;
  variantId: string;
  orderId: string;
  customerId: string;
}

async function seed(): Promise<Seeded> {
  const rootCustomerId = newId();
  const rootChannelIdentityId = newId();
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();

  await sql`
    insert into customer (id, status, locale)
    values (${rootCustomerId}, 'ACTIVE', 'vi'), (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${rootCustomerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       warranty_days, stock_policy, resale_evidence_id, is_active)
    values
      (${variantId}, ${productId}, ${"SKU-" + variantId.slice(-8)}, 'V', 200000, 'P1M',
       'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status)
    values
      (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V', 200000,
       'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'REFUND_PENDING')
  `.execute(ctx.db);
  await createWalletLedgerService(ctx.db).credit({
    customerId,
    amountVnd: 200000n,
    idempotencyKey: "seed-credit",
    correlationId: "seed-credit",
    reason: "seed credit",
  });
  await createWalletLedgerService(ctx.db).debit({
    customerId,
    amountVnd: 200000n,
    idempotencyKey: `purchase:${orderId}:wallet`,
    correlationId: "seed-debit",
    reason: "seed wallet purchase",
  });

  return { rootChannelIdentityId, variantId, orderId, customerId };
}

function callbacks(seeded: Seeded) {
  const vault = createInMemoryVault();
  return createAdminCallbacks({
    db: ctx.db,
    rootConfig: ROOT_CONFIG,
    rootChannelIdentityId: seeded.rootChannelIdentityId,
    confirmation: createAdminConfirmation(ctx.db),
    inventoryImport: async (input) => {
      const imported = await importDigitalInventory({
        db: ctx.db,
        vault,
        config: ROOT_CONFIG,
        actor: input.actor,
        input: input.input,
        reason: input.reason,
        correlationId: input.correlationId,
      });
      if (!imported.ok) throw new Error(imported.code);
      return imported.summary;
    },
  });
}

async function counts(seeded: Seeded): Promise<{
  assets: number;
  confirmations: number;
  refundCredits: number;
  balanceVnd: string;
  orderStatus: string;
}> {
  const result = await sql<{
    assets: number;
    confirmations: number;
    refund_credits: number;
    balance_vnd: string;
    order_status: string;
  }>`
    select
      (select count(*)::int from digital_asset where variant_id = ${seeded.variantId}) as assets,
      (select count(*)::int from admin_confirmation) as confirmations,
      (select count(*)::int from wallet_ledger l join wallet_account a on a.id = l.wallet_account_id where a.customer_id = ${seeded.customerId} and l.idempotency_key = ${`refund:${seeded.orderId}`}) as refund_credits,
      (select balance_vnd::text from wallet_account where customer_id = ${seeded.customerId}) as balance_vnd,
      (select status from "order" where id = ${seeded.orderId}) as order_status
  `.execute(ctx.db);
  const row = result.rows[0];
  expect(row).toBeTruthy();
  return {
    assets: row!.assets,
    confirmations: row!.confirmations,
    refundCredits: row!.refund_credits,
    balanceVnd: row!.balance_vnd,
    orderStatus: row!.order_status,
  };
}

describe("admin sensitive callback audit acceptance", () => {
  it("imports inventory atomically with audit and rejects non-root without inventory mutation", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded);
    const input = `${seeded.variantId},credential-one`;

    const denied = await admin.handle({
      command: "inventory.import",
      actor: { numericUserId: IMPOSTOR_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.variantId,
      reason: "impostor import",
      correlationId: "inventory-denied",
      input,
    });
    expect(denied).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect((await counts(seeded)).assets).toBe(0);

    const imported = await admin.handle({
      command: "inventory.import",
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.variantId,
      reason: "approved import",
      correlationId: "inventory-import",
      input,
    });
    expect(imported).toMatchObject({
      ok: true,
      needsConfirmation: false,
      inventorySummary: { imported: 1, duplicates: 0, invalid: 0 },
    });
    expect((await counts(seeded)).assets).toBe(1);
    expect(
      (
        await listAuditEvents(ctx.db, { targetType: "DigitalAsset", targetId: seeded.variantId })
      ).some(
        (event) =>
          event.action === "inventory.import" && event.correlationId === "inventory-import",
      ),
    ).toBe(true);
  });

  it("audits order inspection without business mutation and denies non-root inspection", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded);

    const denied = await admin.handle({
      command: "order.inspect",
      actor: { numericUserId: IMPOSTOR_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.orderId,
      reason: "impostor inspect",
      correlationId: "inspect-denied",
    });
    expect(denied).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(await counts(seeded)).toMatchObject({
      assets: 0,
      confirmations: 0,
      refundCredits: 0,
      orderStatus: "REFUND_PENDING",
    });

    const inspected = await admin.handle({
      command: "order.inspect",
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.orderId,
      reason: "support review",
      correlationId: "inspect-allowed",
    });
    expect(inspected).toEqual({ ok: true, needsConfirmation: false });
    expect(await counts(seeded)).toMatchObject({
      assets: 0,
      confirmations: 0,
      refundCredits: 0,
      orderStatus: "REFUND_PENDING",
    });
    expect(
      (await listAuditEvents(ctx.db, { targetType: "Order", targetId: seeded.orderId })).some(
        (event) => event.action === "order.inspect" && event.correlationId === "inspect-allowed",
      ),
    ).toBe(true);
  });

  it("confirms wallet refund atomically with audit and replay does not duplicate credit", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded);

    const denied = await admin.handle({
      command: "wallet.refund",
      actor: { numericUserId: IMPOSTOR_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.orderId,
      reason: "impostor refund",
      correlationId: "wallet-refund-denied",
    });
    expect(denied).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(await counts(seeded)).toMatchObject({
      confirmations: 0,
      refundCredits: 0,
      balanceVnd: "0",
      orderStatus: "REFUND_PENDING",
    });

    const requested = await admin.handle({
      command: "wallet.refund",
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      targetId: seeded.orderId,
      reason: "refund approved after support review",
      correlationId: "wallet-refund-request",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    const confirmed = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      correlationId: "wallet-refund-confirm-a",
    });
    expect(confirmed).toEqual({ ok: true });

    const replayed = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: { numericUserId: ROOT_ID, chatType: "private", observedUsername: "Quyenvjp" },
      correlationId: "wallet-refund-confirm-b",
    });
    expect(replayed).toEqual({ ok: true });
    expect(await counts(seeded)).toMatchObject({
      refundCredits: 1,
      balanceVnd: "200000",
      orderStatus: "REFUNDED",
    });
    expect(
      (await listAuditEvents(ctx.db, { targetType: "Order", targetId: seeded.orderId })).filter(
        (event) => event.action === "wallet.refund",
      ),
    ).toHaveLength(1);
  });
});
