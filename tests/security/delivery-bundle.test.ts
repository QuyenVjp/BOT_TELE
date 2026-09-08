import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  issueDeliveryBundle,
  issueReplacementDeliveryBundleInTransaction,
  revealDeliveryBundle,
  reissueDeliveryBundle,
} from "../../src/modules/digital-goods/delivery.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T062 — Delivery Bundle ownership, atomic first-view, expiry, replay,
 * concurrent view, and reissue (FR-017, SR-003, contracts/delivery.md).
 *
 * A bundle binds one asset to one customer+order with a hashed reveal token,
 * an expiry, and view-once semantics. Only the owning customer+order can reveal;
 * the first reveal atomically consumes and returns the secret exactly once;
 * concurrent/replayed reveals get a stable safe error (no existence oracle);
 * an expired-before-view bundle may be reissued (prior revoked in-txn); a
 * consumed bundle is never silently reset.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Fixture {
  orderId: string;
  customerId: string;
  assetId: string;
  vaultRef: string;
  secret: string;
}

async function seedReadyAsset(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const secret = "USER:pass-" + newId().slice(-6);
  const vault = createInMemoryVault();
  const vaultRef = await vault.write(secret);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  // A READY asset reserved for this order.
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'READY', ${orderId})
  `.execute(ctx.db);

  return { orderId, customerId, assetId, vaultRef, secret };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

describe("delivery bundle security (FR-017 / SR-003)", () => {
  it("issues a bundle carrying a plaintext token only in the response, hash in the row", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.token.length).toBeGreaterThanOrEqual(32);

    // The stored row holds only a hash, never the plaintext token.
    const row = await sql<{ token_hash: string; status: string }>`
      select token_hash, status from delivery_bundle where id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(row.rows[0]?.token_hash).not.toBe(issued.token);
    expect(row.rows[0]?.status).toBe("AVAILABLE");
  });

  it("issuing twice for the same order returns the existing active bundle (no second token)", async () => {
    const f = await seedReadyAsset();
    const a = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    const b = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c2",
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.bundleId).toBe(a.bundleId);
    }
    const count = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("refreshes an expired unconsumed bundle on issue retry", async () => {
    const f = await seedReadyAsset();
    const first = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "issue-1",
    });
    if (!first.ok) throw new Error("issue failed");

    await sql`
      update delivery_bundle set expires_at = now() - interval '1 minute'
      where id = ${first.bundleId}
    `.execute(ctx.db);

    const retry = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "issue-2",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.reused).toBe(false);
    expect(retry.bundleId).not.toBe(first.bundleId);

    const vault = { reveal: async (ref: string) => (ref === f.vaultRef ? f.secret : "WRONG") };
    const oldReveal = await revealDeliveryBundle(ctx.db, {
      token: first.token,
      customerId: f.customerId,
      correlationId: "old-issue-token",
      vault,
    });
    expect(oldReveal.ok).toBe(false);

    const freshReveal = await revealDeliveryBundle(ctx.db, {
      token: retry.token,
      customerId: f.customerId,
      correlationId: "fresh-issue-token",
      vault,
    });
    expect(freshReveal.ok).toBe(true);
    if (freshReveal.ok) expect(freshReveal.secret).toBe(f.secret);

    const rows = await sql<{ expired_count: string; bundle_count: string; asset_count: string }>`
      select
        count(*) filter (where id = ${first.bundleId} and status = 'EXPIRED')::text as expired_count,
        count(*)::text as bundle_count,
        (select count(*)::text from digital_asset where reserved_order_id = ${f.orderId}) as asset_count
      from delivery_bundle
      where order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toMatchObject({
      expired_count: "1",
      bundle_count: "2",
      asset_count: "1",
    });
  });

  it("reveals the secret exactly once to the owning customer", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const vault = { reveal: async (ref: string) => (ref === f.vaultRef ? f.secret : "WRONG") };
    const first = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: f.customerId,
      correlationId: "r1",
      vault,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.secret).toBe(f.secret);

    // Second reveal is consumed → safe error, no secret.
    const second = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: f.customerId,
      correlationId: "r2",
      vault,
    });
    expect(second.ok).toBe(false);

    const row = await sql<{ status: string }>`
      select status from delivery_bundle where id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("CONSUMED");
  });

  it("keeps delivery retryable during a Vault outage and recovers after Vault returns", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "vault-outage-issue",
    });
    if (!issued.ok) throw new Error("issue failed");

    let revealAttempts = 0;
    const vault = {
      reveal: async (ref: string) => {
        revealAttempts += 1;
        if (revealAttempts === 1) throw new Error("vault unavailable");
        return ref === f.vaultRef ? f.secret : "WRONG";
      },
    };

    await expect(
      revealDeliveryBundle(ctx.db, {
        token: issued.token,
        customerId: f.customerId,
        correlationId: "vault-outage-first",
        vault,
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });

    const duringOutage = await sql<{ bundle_status: string; asset_status: string }>`
      select b.status as bundle_status, a.status as asset_status
      from delivery_bundle b
      join digital_asset a on a.id = b.asset_id
      where b.id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(duringOutage.rows[0]).toMatchObject({
      bundle_status: "VIEWED",
      asset_status: "READY",
    });

    const recovered = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: f.customerId,
      correlationId: "vault-outage-recovered",
      vault,
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.secret).toBe(f.secret);

    const afterRecovery = await sql<{ bundle_status: string; asset_status: string }>`
      select b.status as bundle_status, a.status as asset_status
      from delivery_bundle b
      join digital_asset a on a.id = b.asset_id
      where b.id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(afterRecovery.rows[0]).toMatchObject({
      bundle_status: "CONSUMED",
      asset_status: "DELIVERED",
    });
  });

  it("does not consume or complete when asset delivery loses its version guard", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c-asset-race",
    });
    if (!issued.ok) throw new Error("issue failed");

    const vault = {
      reveal: async () => {
        // Simulate a concurrent asset state change between vault reveal and the
        // guarded consume transaction.
        await sql`
          update digital_asset set status = 'COMPROMISED', version = version + 1 where id = ${f.assetId}
        `.execute(ctx.db);
        return f.secret;
      },
    };
    const result = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: f.customerId,
      correlationId: "r-asset-race",
      vault,
    });
    expect(result.ok).toBe(false);

    const rows = await sql<{ bundle_status: string; asset_status: string; order_status: string }>`
      select b.status as bundle_status, a.status as asset_status, o.status as order_status
      from delivery_bundle b
      join digital_asset a on a.id = b.asset_id
      join "order" o on o.id = b.order_id
      where b.id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toMatchObject({
      bundle_status: "VIEWED",
      asset_status: "COMPROMISED",
      order_status: "PAID",
    });
  });

  it("refuses a reveal by a non-owning customer (BOLA / SR-003)", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const vault = { reveal: async () => f.secret };
    const attacker = newId();
    const res = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: attacker,
      correlationId: "r1",
      vault,
    });
    expect(res.ok).toBe(false);
    // The bundle must remain unconsumed — an attacker cannot burn the view.
    const row = await sql<{ status: string }>`
      select status from delivery_bundle where id = ${issued.bundleId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("AVAILABLE");
  });

  it("returns a safe error for an unknown token without an existence oracle", async () => {
    const f = await seedReadyAsset();
    const vault = { reveal: async () => f.secret };
    const res = await revealDeliveryBundle(ctx.db, {
      token: "totally-bogus-token-value-1234567890",
      customerId: f.customerId,
      correlationId: "r1",
      vault,
    });
    expect(res.ok).toBe(false);
  });

  it("only ONE of many concurrent reveals wins; the rest get a safe error", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const vault = { reveal: async () => f.secret };
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        revealDeliveryBundle(ctx.db, {
          token: issued.token,
          customerId: f.customerId,
          correlationId: "r" + i,
          vault,
        }).then(
          (r) => r,
          () => ({ ok: false as const }),
        ),
      ),
    );
    const wins = attempts.filter((r) => r.ok === true);
    expect(wins).toHaveLength(1);
  });

  it("reissues a bundle that expired before first view, revoking the prior one", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    // Force the bundle to have expired before any view.
    await sql`
      update delivery_bundle set status = 'EXPIRED', expires_at = now() - interval '1 minute'
      where id = ${issued.bundleId}
    `.execute(ctx.db);

    const re = await reissueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "re1",
    });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.bundleId).not.toBe(issued.bundleId);
    expect(re.reissueOfId).toBe(issued.bundleId);

    // Exactly one active bundle for the order (the new one).
    const active = await sql<{ count: string }>`
      select count(*)::text as count from delivery_bundle
      where order_id = ${f.orderId} and status in ('CREATED','AVAILABLE','VIEWED')
    `.execute(ctx.db);
    expect(Number(active.rows[0]?.count)).toBe(1);
  });

  it("refreshes an expired unconsumed replacement bundle on retry without reusing the old token", async () => {
    const f = await seedReadyAsset();
    const first = await issueReplacementDeliveryBundleInTransaction(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "replacement-1",
    });
    if (!first.ok) throw new Error("replacement issue failed");

    await sql`
      update delivery_bundle set expires_at = now() - interval '1 minute'
      where id = ${first.bundleId}
    `.execute(ctx.db);

    const retry = await issueReplacementDeliveryBundleInTransaction(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "replacement-2",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.reused).toBe(false);
    expect(retry.bundleId).not.toBe(first.bundleId);
    expect(retry.token).not.toBe(first.token);

    const vault = { reveal: async (ref: string) => (ref === f.vaultRef ? f.secret : "WRONG") };
    const oldReveal = await revealDeliveryBundle(ctx.db, {
      token: first.token,
      customerId: f.customerId,
      correlationId: "old-token",
      vault,
    });
    expect(oldReveal.ok).toBe(false);

    const freshReveal = await revealDeliveryBundle(ctx.db, {
      token: retry.token,
      customerId: f.customerId,
      correlationId: "fresh-token",
      vault,
    });
    expect(freshReveal.ok).toBe(true);
    if (freshReveal.ok) expect(freshReveal.secret).toBe(f.secret);

    const rows = await sql<{
      expired_count: string;
      active_count: string;
      bundle_count: string;
      asset_count: string;
      outbox_count: string;
    }>`
      select
        count(*) filter (where b.id = ${first.bundleId} and b.status = 'EXPIRED')::text as expired_count,
        count(*) filter (where b.order_id = ${f.orderId} and b.status in ('CREATED','AVAILABLE','VIEWED','CONSUMED'))::text as active_count,
        count(*)::text as bundle_count,
        (select count(*)::text from digital_asset where reserved_order_id = ${f.orderId}) as asset_count,
        (select count(*)::text from outbox_event where aggregate_type = 'DeliveryBundle' and aggregate_id in (${first.bundleId}, ${retry.bundleId})) as outbox_count
      from delivery_bundle b
      where b.order_id = ${f.orderId}
    `.execute(ctx.db);
    expect(rows.rows[0]).toMatchObject({
      expired_count: "1",
      active_count: "1",
      bundle_count: "2",
      asset_count: "1",
      outbox_count: "3",
    });
  });

  it("refuses to reissue when a live bundle still exists (no silent second token)", async () => {
    const f = await seedReadyAsset();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const re = await reissueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "re1",
    });
    expect(re.ok).toBe(false);
  });
});
