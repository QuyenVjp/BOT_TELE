import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  fulfillPaidOrder,
  type FulfillmentDeps,
} from "../../src/modules/digital-goods/fulfillment.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
let vault: ReturnType<typeof createInMemoryVault>;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  vault = createInMemoryVault();
  await sql`drop trigger if exists reject_asset_claim_event on outbox_event`.execute(ctx.db);
  await sql`drop function if exists reject_asset_claim_event()`.execute(ctx.db);
  await sql`
    truncate table delivery_bundle, digital_asset, outbox_event, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

async function seed(initialStatus: "AVAILABLE" | "RESERVED") {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vaultRef = await vault.write(`SECRET-${newId()}`);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M',
       'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values
      (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
       100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status,
       reserved_order_id, reserved_until, version)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${`fp-${newId()}`}, ${initialStatus},
       ${initialStatus === "RESERVED" ? orderId : null},
       ${initialStatus === "RESERVED" ? new Date(Date.now() + 900_000).toISOString() : null},
       ${initialStatus === "RESERVED" ? 1 : 0})
  `.execute(ctx.db);
  return { orderId, assetId };
}

function deps(): FulfillmentDeps {
  return {
    vault,
    supplier: null,
    deliveryBaseUrl: "https://shop.example/d",
    bundleTtlSeconds: 900,
  };
}

async function rejectAssetClaimEvent(): Promise<void> {
  await sql`
    create function reject_asset_claim_event() returns trigger language plpgsql as $$
    begin
      if new.event_type = 'DigitalAssetClaimed' then
        raise exception 'forced DigitalAssetClaimed failure';
      end if;
      return new;
    end
    $$
  `.execute(ctx.db);
  await sql`
    create trigger reject_asset_claim_event before insert on outbox_event
    for each row execute function reject_asset_claim_event()
  `.execute(ctx.db);
}

describe("fulfillment claim + outbox atomicity (T165/T166)", () => {
  it.each(["AVAILABLE", "RESERVED"] as const)(
    "rolls back the %s asset state when DigitalAssetClaimed cannot be appended",
    async (initialStatus) => {
      const fixture = await seed(initialStatus);
      await rejectAssetClaimEvent();

      await expect(
        fulfillPaidOrder(ctx.db, {
          orderId: fixture.orderId,
          correlationId: `atomic-${initialStatus}`,
          deps: deps(),
        }),
      ).rejects.toThrow(/forced DigitalAssetClaimed failure/i);

      const afterFailure = await sql<{
        status: string;
        reserved_order_id: string | null;
        event_count: number;
      }>`
        select a.status, a.reserved_order_id,
               (select count(*)::int from outbox_event
                where aggregate_id = a.id and event_type = 'DigitalAssetClaimed') as event_count
        from digital_asset a where a.id = ${fixture.assetId}
      `.execute(ctx.db);
      expect(afterFailure.rows[0]).toEqual({
        status: initialStatus,
        reserved_order_id: initialStatus === "RESERVED" ? fixture.orderId : null,
        event_count: 0,
      });

      await sql`drop trigger reject_asset_claim_event on outbox_event`.execute(ctx.db);
      await sql`drop function reject_asset_claim_event()`.execute(ctx.db);

      const retry = await fulfillPaidOrder(ctx.db, {
        orderId: fixture.orderId,
        correlationId: `atomic-${initialStatus}`,
        deps: deps(),
      });
      expect(retry.ok).toBe(true);

      const committed = await sql<{
        status: string;
        asset_version: number;
        event_count: number;
        event_version: number | null;
      }>`
        select a.status, a.version as asset_version,
               (select count(*)::int from outbox_event
                where aggregate_id = a.id and event_type = 'DigitalAssetClaimed') as event_count,
               (select aggregate_version from outbox_event
                where aggregate_id = a.id and event_type = 'DigitalAssetClaimed'
                limit 1) as event_version
        from digital_asset a where a.id = ${fixture.assetId}
      `.execute(ctx.db);
      expect(committed.rows[0]).toEqual({
        status: "READY",
        asset_version: 2,
        event_count: 1,
        event_version: 2,
      });

      await fulfillPaidOrder(ctx.db, {
        orderId: fixture.orderId,
        correlationId: `atomic-${initialStatus}`,
        deps: deps(),
      });
      const replayCount = await sql<{ count: number }>`
        select count(*)::int as count from outbox_event
        where aggregate_id = ${fixture.assetId} and event_type = 'DigitalAssetClaimed'
      `.execute(ctx.db);
      expect(replayCount.rows[0]?.count).toBe(1);
    },
  );
});
