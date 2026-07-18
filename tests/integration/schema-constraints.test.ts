import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { ulid } from "ulid";
import { startPostgres, dockerAvailable, type StartedPg } from "../helpers/pg-container.js";

/**
 * T015 — Migration constraint tests (data-model.md invariants).
 *
 * Proves the schema itself enforces business-effect cardinality, not just app
 * code:
 *  - a SePay bank transaction id is unique per provider (evidence dedupe);
 *  - a supplier create is idempotent on (supplier, idempotency_key);
 *  - a digital asset can be actively claimed by only one order at a time;
 *  - only one active delivery bundle can exist per order.
 *
 * Each test triggers the duplicate and asserts a unique-violation (SQLSTATE
 * 23505), so a future migration that drops a guard fails loudly here.
 */

let pg: StartedPg;
let hasDocker = false;

beforeAll(async () => {
  hasDocker = await dockerAvailable();
  if (!hasDocker) return;
  pg = await startPostgres();
}, 180_000);

afterAll(async () => {
  if (pg) await pg.stop();
});

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

describe("schema constraints (real PostgreSQL)", () => {
  it("bank_transaction is unique per (provider, provider_transaction_id)", async () => {
    if (!hasDocker) return;
    const db = pg.handle.db;
    const txn = {
      provider: "sepay",
      provider_transaction_id: `TXN-${ulid()}`,
    };

    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id,
         amount_vnd, transacted_at, raw_hash, signature_status, schema_version)
      values
        (${ulid()}, ${txn.provider}, ${txn.provider_transaction_id}, 'IN', 'ACC-1',
         100000, now(), ${ulid()}, 'VALID', 'v1')
    `.execute(db);

    let thrown: unknown;
    try {
      await sql`
        insert into bank_transaction
          (id, provider, provider_transaction_id, direction, merchant_account_id,
           amount_vnd, transacted_at, raw_hash, signature_status, schema_version)
        values
          (${ulid()}, ${txn.provider}, ${txn.provider_transaction_id}, 'IN', 'ACC-1',
           100000, now(), ${ulid()}, 'VALID', 'v1')
      `.execute(db);
    } catch (err) {
      thrown = err;
    }
    expect(isUniqueViolation(thrown)).toBe(true);
  });

  it("supplier_order is idempotent on (supplier_id, idempotency_key)", async () => {
    if (!hasDocker) return;
    const db = pg.handle.db;

    // Minimal referential scaffolding.
    const categoryId = ulid();
    const productId = ulid();
    const variantId = ulid();
    const customerId = ulid();
    const orderId = ulid();
    const supplierId = ulid();
    const supplierSkuId = ulid();
    const idemKey = `IDEM-${ulid()}`;

    await sql`insert into category (id, name_vi, slug) values (${categoryId}, 'Cat', ${"cat-" + categoryId})`.execute(
      db,
    );
    await sql`insert into product (id, category_id, name_vi, slug) values (${productId}, ${categoryId}, 'Prod', ${"p-" + productId})`.execute(
      db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Var', 100000, 'P1M', 'LICENSE', 'SUPPLIER_ONLY')
    `.execute(db);
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      db,
    );
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'Prod', 'Var',
        100000, 'P1M', 'LICENSE', 'PAID')
    `.execute(db);
    await sql`insert into supplier (id, name, adapter_type, credential_vault_ref, status) values (${supplierId}, 'Sup', 'http', 'vault://sup', 'ACTIVE')`.execute(
      db,
    );
    await sql`
      insert into supplier_sku (id, supplier_id, variant_id, external_sku, cost_vnd, delivery_type)
      values (${supplierSkuId}, ${supplierId}, ${variantId}, 'EXT-1', 80000, 'LICENSE')
    `.execute(db);

    const insertSupplierOrder = (soId: string) => sql`
      insert into supplier_order
        (id, supplier_id, supplier_sku_id, order_id, idempotency_key, request_fingerprint,
         status, cost_vnd_snapshot, sale_price_vnd_snapshot, margin_vnd_snapshot)
      values
        (${soId}, ${supplierId}, ${supplierSkuId}, ${orderId}, ${idemKey}, 'fp-1',
         'CREATED', 80000, 100000, 20000)
    `;

    await insertSupplierOrder(ulid()).execute(db);

    let thrown: unknown;
    try {
      await insertSupplierOrder(ulid()).execute(db);
    } catch (err) {
      thrown = err;
    }
    expect(isUniqueViolation(thrown)).toBe(true);
  });

  it("digital_asset allows only one active claim per fingerprint", async () => {
    if (!hasDocker) return;
    const db = pg.handle.db;

    const categoryId = ulid();
    const productId = ulid();
    const variantId = ulid();
    const fingerprint = `FP-${ulid()}`;

    await sql`insert into category (id, name_vi, slug) values (${categoryId}, 'Cat', ${"cat-" + categoryId})`.execute(
      db,
    );
    await sql`insert into product (id, category_id, name_vi, slug) values (${productId}, ${categoryId}, 'Prod', ${"p-" + productId})`.execute(
      db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Var', 100000, 'P1M', 'LICENSE', 'LOCAL_ONLY')
    `.execute(db);

    const insertAsset = (assetId: string, status: string) => sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault://" + assetId}, ${fingerprint}, ${status})
    `;

    // First RESERVED claim on the fingerprint succeeds.
    await insertAsset(ulid(), "RESERVED").execute(db);

    // A second active (READY) claim on the same fingerprint must be rejected.
    let thrown: unknown;
    try {
      await insertAsset(ulid(), "READY").execute(db);
    } catch (err) {
      thrown = err;
    }
    expect(isUniqueViolation(thrown)).toBe(true);

    // But an inactive (EXPIRED) row on the same fingerprint is allowed.
    await expect(insertAsset(ulid(), "EXPIRED").execute(db)).resolves.toBeDefined();
  });

  it("delivery_bundle allows only one active bundle per order", async () => {
    if (!hasDocker) return;
    const db = pg.handle.db;

    const categoryId = ulid();
    const productId = ulid();
    const variantId = ulid();
    const customerId = ulid();
    const orderId = ulid();
    const assetId = ulid();

    await sql`insert into category (id, name_vi, slug) values (${categoryId}, 'Cat', ${"cat-" + categoryId})`.execute(
      db,
    );
    await sql`insert into product (id, category_id, name_vi, slug) values (${productId}, ${categoryId}, 'Prod', ${"p-" + productId})`.execute(
      db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Var', 100000, 'P1M', 'LICENSE', 'LOCAL_ONLY')
    `.execute(db);
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      db,
    );
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, status)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'Prod', 'Var',
        100000, 'P1M', 'LICENSE', 'PAID')
    `.execute(db);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault://" + assetId}, ${"FP-" + assetId}, 'DELIVERED')
    `.execute(db);

    const insertBundle = (bundleId: string, status: string) => sql`
      insert into delivery_bundle (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
      values (${bundleId}, ${orderId}, ${customerId}, ${assetId}, ${"tok-" + bundleId}, ${status}, now() + interval '1 day')
    `;

    await insertBundle(ulid(), "AVAILABLE").execute(db);

    let thrown: unknown;
    try {
      await insertBundle(ulid(), "AVAILABLE").execute(db);
    } catch (err) {
      thrown = err;
    }
    expect(isUniqueViolation(thrown)).toBe(true);

    // A revoked bundle does not count as active, so a fresh one may be issued.
    await expect(insertBundle(ulid(), "REVOKED").execute(db)).resolves.toBeDefined();
  });
});
