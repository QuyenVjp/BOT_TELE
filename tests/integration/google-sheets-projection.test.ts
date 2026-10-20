import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type {
  GoogleSheetsApi,
  SheetValue,
  SheetsSpreadsheet,
} from "../../src/infrastructure/google-sheets/client.js";
import { processGoogleSheetsRequestsOnce } from "../../src/modules/google-sheets/requests.js";
import {
  reconcileGoogleSheetsOnce,
  type SheetsProjectionConfig,
} from "../../src/modules/google-sheets/projection.js";
import {
  GOOGLE_SHEETS_SCHEMA_VERSION,
  GOOGLE_SHEETS_TABS,
  SHEET_HEADERS,
} from "../../src/modules/google-sheets/contracts.js";
import { buyNow } from "../../src/modules/commerce/buy-now.js";
import { newId } from "../../src/shared/ids/index.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

let ctx: PgTestContext;
const SPREADSHEET_ID = "projection-boundary-test";
const projectionConfig: SheetsProjectionConfig = {
  spreadsheetId: SPREADSHEET_ID,
  ownerId: "owner@example.test",
  appBaseUrl: "https://ops.example.test",
};
const hasDocker = await dockerAvailable();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeSheetsApi implements GoogleSheetsApi {
  readonly principalEmail = "sheets@example.test";
  readonly storedValues = new Map<string, SheetValue[][]>();
  readonly writeStarted = deferred();
  readonly releaseWrites = deferred();
  failAfterFirstRange = false;
  stallWrites = false;
  requestRows: SheetValue[][] | null = null;

  async getSpreadsheet(
    _input: Parameters<GoogleSheetsApi["getSpreadsheet"]>[0],
  ): Promise<SheetsSpreadsheet> {
    return {
      sheets: GOOGLE_SHEETS_TABS.map((title, sheetId) => ({ title, sheetId, rowCount: 10_000 })),
      developerMetadata: [
        {
          metadataKey: "tier20_google_sheets_schema",
          metadataValue: String(GOOGLE_SHEETS_SCHEMA_VERSION),
        },
      ],
    };
  }

  async batchGet(input: Parameters<GoogleSheetsApi["batchGet"]>[0]) {
    return input.ranges.map((range) => ({
      range,
      values: range.startsWith("Requests!") && this.requestRows ? this.requestRows : [],
    }));
  }

  async batchUpdateValues(
    input: Parameters<GoogleSheetsApi["batchUpdateValues"]>[0],
  ): Promise<void> {
    this.writeStarted.resolve();
    if (this.stallWrites) await this.releaseWrites.promise;
    for (const [index, entry] of input.data.entries()) {
      this.storedValues.set(
        entry.range,
        entry.values.map((row) => [...row]),
      );
      if (this.failAfterFirstRange && index === 0) {
        this.failAfterFirstRange = false;
        throw new Error("synthetic partial Sheets write");
      }
    }
  }

  async batchUpdate(_input: Parameters<GoogleSheetsApi["batchUpdate"]>[0]): Promise<void> {}

  async append(_input: Parameters<GoogleSheetsApi["append"]>[0]): Promise<void> {}
}

async function readSyncState(): Promise<{
  last_outbox_event_id: string | null;
  last_success_at: string | null;
}> {
  const result = await sql<{
    last_outbox_event_id: string | null;
    last_success_at: string | null;
  }>`
    select last_outbox_event_id, last_success_at::text as last_success_at
    from google_sheets_sync_state
    where id = 'main'
  `.execute(ctx.db);
  return result.rows[0]!;
}

async function insertOutboxEvent(id: string, version: number, occurredAt?: string): Promise<void> {
  await sql`
    insert into outbox_event
      (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted, occurred_at)
    values
      (${id}, 'ProjectionTest', 'projection-test', ${version}, 'ProjectionChanged', '{}'::jsonb,
       coalesce(${occurredAt ?? null}::timestamptz, now()))
  `.execute(ctx.db);
}

async function seedCheckout(): Promise<{
  customerId: string;
  variantId: string;
  priceVnd: number;
}> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const priceVnd = 120_000;

  await sql`
    insert into customer (id, status, locale)
    values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'Projection test', ${`projection-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test)
    values (${productId}, ${categoryId}, 'Projection product', ${`projection-${productId}`}, true, 1, true)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, fulfillment_type, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${`PROJECTION-${variantId}`}, 'Projection variant', ${priceVnd},
       'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT', true, 1)
  `.execute(ctx.db);
  const assetId = newId();
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${`vault:${assetId}`}, ${`fingerprint:${assetId}`}, 'AVAILABLE')
  `.execute(ctx.db);

  return { customerId, variantId, priceVnd };
}

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table google_sheets_asset_metadata, google_sheets_request, audit_event, outbox_event,
      digital_asset, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
  await sql`
    update google_sheets_sync_state
       set last_attempt_at = null,
           last_success_at = null,
           last_outbox_event_id = null,
           last_error_code = null,
           last_error_note = null,
           last_rows_written = 0,
           last_orphan_count = 0,
           last_request_at = null,
           version = 1
     where id = 'main'
  `.execute(ctx.db);
});

describe.skipIf(!hasDocker)("Google Sheets projection boundaries", () => {
  it("keeps the durable cursor unchanged after a partial write and advances it on retry", async () => {
    await insertOutboxEvent("outbox-0001", 1);
    await insertOutboxEvent("outbox-0002", 2);
    await sql`
      update google_sheets_sync_state
         set last_outbox_event_id = 'outbox-0001',
             last_success_at = '2026-01-01T00:00:00Z'
       where id = 'main'
    `.execute(ctx.db);
    const before = await readSyncState();
    const api = new FakeSheetsApi();
    api.failAfterFirstRange = true;

    await expect(
      reconcileGoogleSheetsOnce(
        { db: ctx.db, api, config: projectionConfig },
        { structureReady: true },
      ),
    ).rejects.toThrow("synthetic partial Sheets write");

    expect(await readSyncState()).toEqual(before);
    expect(api.storedValues.size).toBe(1);

    await insertOutboxEvent("outbox-0003", 3);
    const retryApi = new FakeSheetsApi();
    const retried = await reconcileGoogleSheetsOnce(
      { db: ctx.db, api: retryApi, config: projectionConfig },
      { structureReady: true },
    );

    expect(retried.outboxEventId).toBe("outbox-0003");
    expect(retryApi.storedValues.size).toBe(GOOGLE_SHEETS_TABS.length);

    const after = await readSyncState();
    expect(after.last_outbox_event_id).toBe("outbox-0003");
    expect(after.last_success_at).not.toBe(before.last_success_at);
  });
  it("stores the latest outbox cursor by occurrence time", async () => {
    await insertOutboxEvent("zz-early", 1, "2026-01-01T00:00:00Z");
    await insertOutboxEvent("aa-late", 2, "2026-01-02T00:00:00Z");

    const result = await reconcileGoogleSheetsOnce(
      { db: ctx.db, api: new FakeSheetsApi(), config: projectionConfig },
      { structureReady: true },
    );

    expect(result.outboxEventId).toBe("aa-late");
    expect((await readSyncState()).last_outbox_event_id).toBe("aa-late");
  });

  it("completes checkout while a Sheets values write is stalled", async () => {
    const checkout = await seedCheckout();
    const api = new FakeSheetsApi();
    api.stallWrites = true;
    const projection = reconcileGoogleSheetsOnce(
      { db: ctx.db, api, config: projectionConfig },
      { structureReady: true },
    );
    await api.writeStarted.promise;

    const checkoutResult = buyNow(ctx.db, {
      customerId: checkout.customerId,
      variantId: checkout.variantId,
      expectedPriceVnd: checkout.priceVnd,
      idempotencyKey: "sheets-stall-checkout",
      correlationId: "sheets-stall-checkout",
      skipStoreStatusCheck: true,
    });
    const completedBeforeSheetsRelease = await Promise.race([
      checkoutResult.then(() => true),
      api.releaseWrites.promise.then(() => false),
    ]);
    expect(completedBeforeSheetsRelease).toBe(true);

    const result = await checkoutResult;
    expect(result).toMatchObject({ ok: true });
    api.releaseWrites.resolve();
    await projection;
    const order = await sql<{ status: string }>`
      select status from "order" where idempotency_key = 'sheets-stall-checkout'
    `.execute(ctx.db);
    expect(order.rows).toEqual([{ status: "PENDING_PAYMENT" }]);
  });
  it.each([
    "MARK_PAID",
    "SETTLED",
    "DELIVERED",
    "ALLOCATE_ASSET",
    "RELEASE_READY",
    "MUTATE_LEDGER",
    "MUTATE_EVIDENCE",
    "REVEAL_SECRET",
    "DELETE_ASSET",
  ])("rejects Sheets payment or fulfillment action %s", async (action) => {
    const checkout = await seedCheckout();
    const order = await buyNow(ctx.db, {
      customerId: checkout.customerId,
      variantId: checkout.variantId,
      expectedPriceVnd: checkout.priceVnd,
      idempotencyKey: `sheets-forbidden:${action}`,
      correlationId: `sheets-forbidden:${action}`,
      skipStoreStatusCheck: true,
    });
    expect(order).toMatchObject({ ok: true });
    if (!order.ok) return;

    const requestId = newId();
    const api = new FakeSheetsApi();
    api.requestRows = [
      [...SHEET_HEADERS.Requests],
      [
        requestId,
        "2026-01-01T00:00:00.000Z",
        projectionConfig.ownerId,
        action,
        "Order",
        order.order.id,
        "1",
        "{}",
        "",
        "",
        "",
        "",
      ],
    ];

    await expect(
      processGoogleSheetsRequestsOnce({ db: ctx.db, api, config: projectionConfig }),
    ).resolves.toEqual({ processed: 0, rejected: 1, stale: 0, failed: 0 });
    const paymentState = await sql<{
      status: string;
      intent_count: number;
      allocation_count: number;
    }>`
      select o.status,
        (select count(*)::int from payment_intent where order_id = o.id) as intent_count,
        (select count(*)::int from payment_allocation a
         join payment_intent p on p.id = a.payment_intent_id
         where p.order_id = o.id) as allocation_count
      from "order" o
      where o.id = ${order.order.id}
    `.execute(ctx.db);
    expect(paymentState.rows).toEqual([
      { status: "PENDING_PAYMENT", intent_count: 0, allocation_count: 0 },
    ]);

    const persistedRequest = await sql<{ status: string; result_code: string }>`
      select status, result_code
      from google_sheets_request
      where request_id = ${requestId}
    `.execute(ctx.db);
    expect(persistedRequest.rows).toEqual([
      { status: "REJECTED", result_code: "INVALID_SHEET_ACTION" },
    ]);
  });
});
