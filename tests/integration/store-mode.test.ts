import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  getProductPublicationReadiness,
  publishProduct,
  registerResaleEvidence,
} from "../../src/modules/catalog/publication.js";
import { listTerminalOutboxOrphans } from "../../src/infrastructure/outbox/disposition.js";
import {
  addTestCustomer,
  canPurchase,
  getStoreMode,
  getStoreOpenReadiness,
  setStoreModeForTest,
  transitionStoreMode,
} from "../../src/modules/commerce/store-mode.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table test_customer_allowlist, store_control, product_variant, product, category,
      discrepancy, outbox_event, support_ticket, customer cascade
  `.execute(ctx.db);
  await sql`
    insert into store_control (id, status, updated_at, updated_by)
    values ('main', 'CLOSED', now(), 'system')
  `.execute(ctx.db);
});

/** Publishes one product with one available credential, so only the gate can block OPEN. */
async function seedReadyStore(): Promise<void> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'AI', ${`ai-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (${productId}, ${categoryId}, 'GPT Plus', ${`gpt-${productId}`}, true, 1, false, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       fulfillment_type, warranty_days, stock_policy, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${`GPT-${variantId}`}, '1 tháng', 250000, 'P1M', 'CREDENTIAL',
       'STOCK_ACCOUNT', 30, 'LOCAL_ONLY', true, 1)
  `.execute(ctx.db);
  await sql`
    insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values (${newId()}, ${variantId}, 'TEST_FIXTURE', 'test-vault-ref', ${newId()}, 'AVAILABLE')
  `.execute(ctx.db);
  const evidence = await registerResaleEvidence(ctx.db, {
    variantId,
    source: "OWNER_ATTESTATION",
    reference: `owner-ticket-${variantId}`,
    summary: "Owner verified supplier resale authorization.",
    requestId: `evidence-${variantId}`,
    actorId: "admin",
    reason: "Seed resale evidence",
    correlationId: `evidence-${variantId}`,
  });
  if (!evidence.ok) throw new Error(evidence.message);
  const readiness = await getProductPublicationReadiness(ctx.db, productId);
  const published = await publishProduct(ctx.db, {
    productId,
    expectedPublicationVersion: readiness!.publicationVersion,
    actorId: "admin",
    reason: "Seed publication",
    correlationId: `publish-${variantId}`,
  });
  if (!published.ok) throw new Error(published.message);
}

async function openStore(requestId: string) {
  return transitionStoreMode(ctx.db, {
    targetMode: "OPEN",
    expectedVersion: 1,
    requestId,
    actorId: "admin",
    reason: "open only when every actionable queue is clear",
    correlationId: requestId,
  });
}

async function seedTicket(input: {
  customerId: string;
  status: string;
  telegramUserId?: string;
}): Promise<void> {
  await sql`
    insert into customer (id, status) values (${input.customerId}, 'ACTIVE')
    on conflict (id) do nothing
  `.execute(ctx.db);
  if (input.telegramUserId) {
    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id)
      values (${newId()}, ${input.customerId}, 'TELEGRAM', ${input.telegramUserId})
    `.execute(ctx.db);
  }
  await sql`
    insert into support_ticket (id, customer_id, reason_code, status, safe_summary)
    values (${newId()}, ${input.customerId}, 'ASSET_NOT_WORKING', ${input.status}, 'safe summary')
  `.execute(ctx.db);
}

describe("store-mode safety", () => {
  it("041-style insert on conflict does not reopen a CLOSED store", async () => {
    await sql`
      insert into store_control (id, status, updated_at, updated_by)
      values ('main', 'OPEN', now(), 'system')
      on conflict (id) do nothing
    `.execute(ctx.db);
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
    const gate = await canPurchase(ctx.db, {
      telegramUserId: "1",
      isRootAdmin: false,
      variantIsTest: false,
    });
    expect(gate).toEqual({ ok: false, code: "STORE_CLOSED" });
  });

  it("refuses OPEN when no published in-stock product is ready", async () => {
    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "OPEN",
        expectedVersion: 1,
        requestId: "store-open-not-ready",
        actorId: "admin",
        reason: "must have a sellable product",
        correlationId: "store-open-not-ready",
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_READY" });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
  });

  it("requires CLOSED-mediated transitions, optimistic versions, and idempotent replay", async () => {
    const first = await transitionStoreMode(ctx.db, {
      targetMode: "TEST",
      expectedVersion: 1,
      requestId: "store-test-1",
      actorId: "admin",
      reason: "pre-production test",
      correlationId: "store-test-1",
    });
    expect(first).toMatchObject({
      ok: true,
      kind: "CHANGED",
      control: { status: "TEST", version: 2 },
    });

    const replay = await transitionStoreMode(ctx.db, {
      targetMode: "TEST",
      expectedVersion: 1,
      requestId: "store-test-1",
      actorId: "admin",
      reason: "pre-production test",
      correlationId: "store-test-1-replay",
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "REPLAYED",
      control: { status: "TEST", version: 2 },
    });

    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "OPEN",
        expectedVersion: 2,
        requestId: "store-open-invalid",
        actorId: "admin",
        reason: "must close first",
        correlationId: "store-open-invalid",
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "CLOSED",
        expectedVersion: 1,
        requestId: "store-close-stale",
        actorId: "admin",
        reason: "stale snapshot",
        correlationId: "store-close-stale",
      }),
    ).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });
  it("returns the current control state when an old transition is replayed", async () => {
    await transitionStoreMode(ctx.db, {
      targetMode: "TEST",
      expectedVersion: 1,
      requestId: "store-test-replay-state",
      actorId: "admin",
      reason: "pre-production test",
      correlationId: "store-test-replay-state",
    });
    await transitionStoreMode(ctx.db, {
      targetMode: "CLOSED",
      expectedVersion: 2,
      requestId: "store-close-after-test",
      actorId: "admin",
      reason: "close after test",
      correlationId: "store-close-after-test",
    });

    await expect(
      transitionStoreMode(ctx.db, {
        targetMode: "TEST",
        expectedVersion: 1,
        requestId: "store-test-replay-state",
        actorId: "admin",
        reason: "pre-production test",
        correlationId: "store-test-replay-state-replay",
      }),
    ).resolves.toMatchObject({
      ok: true,
      kind: "REPLAYED",
      control: {
        status: "CLOSED",
        version: 3,
        lastRequestId: "store-close-after-test",
      },
    });
  });

  it("TEST mode denies public SKUs and non-allowlisted buyers of test SKUs", async () => {
    await setStoreModeForTest(ctx.db, "TEST", "admin");
    expect(await getStoreMode(ctx.db)).toBe("TEST");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: false,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    await addTestCustomer(ctx.db, "99", "admin");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "99",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: true,
        variantIsTest: true,
      }),
    ).toEqual({ ok: true });
  });

  it("OPEN mode denies test SKUs", async () => {
    await setStoreModeForTest(ctx.db, "OPEN", "admin");
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: false,
        variantIsTest: true,
      }),
    ).toEqual({ ok: false, code: "STORE_TEST_ONLY" });
    expect(
      await canPurchase(ctx.db, {
        telegramUserId: "1",
        isRootAdmin: false,
        variantIsTest: false,
      }),
    ).toEqual({ ok: true });
  });

  it("seed-test-catalog does not mutate store_control", () => {
    const src = readFileSync("scripts/seed-test-catalog.ts", "utf8");
    expect(src).not.toMatch(/setStoreMode|setStoreStatus|store_control/);
  });
});

describe("store OPEN readiness gate", () => {
  it("opens once every actionable queue is clear", async () => {
    await seedReadyStore();
    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 1,
      inStockVariants: 1,
      openDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      criticalSupportTickets: 0,
    });
    await expect(openStore("gate-open-clear")).resolves.toMatchObject({
      ok: true,
      kind: "CHANGED",
      control: { status: "OPEN", version: 2 },
    });
  });

  it("keeps the store CLOSED while an unresolved discrepancy exists", async () => {
    await seedReadyStore();
    const discrepancyId = newId();
    await sql`
      insert into discrepancy (id, type, status, reason, owner)
      values (${discrepancyId}, 'UNMATCHED', 'OPEN', 'unmatched transfer', 'ops')
    `.execute(ctx.db);

    await expect(getStoreOpenReadiness(ctx.db)).resolves.toMatchObject({
      activeProducts: 1,
      inStockVariants: 1,
      openDiscrepancies: 1,
    });
    await expect(openStore("gate-open-discrepancy")).resolves.toMatchObject({
      ok: false,
      code: "NOT_READY",
    });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");

    await sql`
      update discrepancy
         set status = 'RESOLVED', resolution_code = 'REVIEWED', resolved_at = now()
       where id = ${discrepancyId}
    `.execute(ctx.db);
    await expect(openStore("gate-open-discrepancy-cleared")).resolves.toMatchObject({ ok: true });
  });

  it("keeps the store CLOSED while an actionable outbox orphan remains", async () => {
    await seedReadyStore();
    const orderId = newId();
    const actionable = newId();
    const published = newId();
    const disposed = newId();
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
         occurred_at, dead_lettered_at, published_at)
      values
        (${actionable}, 'Order', ${orderId}, 1, 'OrderPaid', '{}'::jsonb, now(), now(), null),
        (${published}, 'Order', ${orderId}, 2, 'OrderPaid', '{}'::jsonb, now(), now(), now())
    `.execute(ctx.db);
    // Closed by a real disposition: retained evidence, not work.
    await sql`
      insert into outbox_event
        (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted,
         occurred_at, dead_lettered_at, disposition_status, disposition_code, dispositioned_at,
         dispositioned_by)
      values
        (${disposed}, 'Order', ${orderId}, 3, 'OrderPaid', '{}'::jsonb, now(), now(), 'RESOLVED',
         'HANDLED_MANUALLY', now(), 'admin')
    `.execute(ctx.db);

    const readiness = await getStoreOpenReadiness(ctx.db);
    expect(readiness).toMatchObject({
      activeProducts: 1,
      inStockVariants: 1,
      openDiscrepancies: 0,
      terminalOutboxOrphans: 1,
      criticalSupportTickets: 0,
    });
    // Parity with the queue the disposition command acts on.
    expect((await listTerminalOutboxOrphans(ctx.db, 10)).map((row) => row.id)).toEqual([
      actionable,
    ]);

    await expect(openStore("gate-open-outbox")).resolves.toMatchObject({
      ok: false,
      code: "NOT_READY",
    });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");

    await sql`
      update outbox_event
         set disposition_status = 'RESOLVED', disposition_code = 'HANDLED_MANUALLY',
             disposition_note = 'handled outside the queue', dispositioned_at = now(),
             dispositioned_by = 'admin', disposition_version = disposition_version + 1
       where id = ${actionable}
    `.execute(ctx.db);
    await expect(openStore("gate-open-outbox-cleared")).resolves.toMatchObject({ ok: true });
  });

  it("keeps the store CLOSED while a real customer ticket needs operator review", async () => {
    await seedReadyStore();
    await seedTicket({
      customerId: newId(),
      status: "MANUAL_REVIEW",
      telegramUserId: "555",
    });

    await expect(getStoreOpenReadiness(ctx.db)).resolves.toMatchObject({
      activeProducts: 1,
      inStockVariants: 1,
      criticalSupportTickets: 1,
    });
    await expect(openStore("gate-open-ticket")).resolves.toMatchObject({
      ok: false,
      code: "NOT_READY",
    });
    expect(await getStoreMode(ctx.db)).toBe("CLOSED");
  });

  it("does not block on ordinary tickets or allowlisted test-customer review tickets", async () => {
    await seedReadyStore();
    for (const status of ["OPEN", "WAITING_SHOP", "WAITING_CUSTOMER"]) {
      await seedTicket({ customerId: newId(), status, telegramUserId: newId() });
    }
    await addTestCustomer(ctx.db, "777", "admin");
    await seedTicket({
      customerId: newId(),
      status: "MANUAL_REVIEW",
      telegramUserId: "777",
    });

    await expect(getStoreOpenReadiness(ctx.db)).resolves.toEqual({
      activeProducts: 1,
      inStockVariants: 1,
      openDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      criticalSupportTickets: 0,
    });
    await expect(openStore("gate-open-informational")).resolves.toMatchObject({
      ok: true,
      kind: "CHANGED",
      control: { status: "OPEN", version: 2 },
    });
  });
});
