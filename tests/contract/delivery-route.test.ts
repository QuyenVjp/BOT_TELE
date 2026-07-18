import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { issueDeliveryBundle } from "../../src/modules/digital-goods/delivery.js";
import { registerDeliveryRoute } from "../../src/modules/digital-goods/delivery-route.js";
import { issueDeliverySession } from "../../src/modules/digital-goods/delivery-session.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T074 — No-cache authenticated delivery HTTP route (FR-017, delivery.md).
 *
 * The route reveals the secret once to the owning customer, applies anti-cache
 * / anti-referrer headers on every response, and returns a stable 410 for
 * replay / non-owner / unknown token (no existence oracle).
 */

let ctx: PgTestContext;
const SESSION_CONFIG = {
  key: "test-only-delivery-session-key-material-123456789",
  keyVersion: 3,
  audience: "delivery-reveal",
};

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
  secret: string;
  vault: ReturnType<typeof createInMemoryVault>;
}

async function seedReady(): Promise<Fixture> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const secret = "ROUTE-SECRET-" + newId().slice(-6);
  const vault = createInMemoryVault();
  const vaultRef = await vault.write(secret);
  const slug = categoryId.slice(-8);

  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
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
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'READY', ${orderId})
  `.execute(ctx.db);

  return { orderId, customerId, assetId, secret, vault };
}

beforeEach(async () => {
  await sql`
    truncate table delivery_bundle, digital_asset, order_transition, "order",
      product_variant, product, category, customer, outbox_event cascade
  `.execute(ctx.db);
});

describe("delivery HTTP route (T074)", () => {
  it("accepts the previous delivery-session key only during rotation grace", async () => {
    const f = await seedReady();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c-rotation",
    });
    if (!issued.ok) throw new Error("issue failed");
    const previous = {
      ...SESSION_CONFIG,
      key: "previous-delivery-session-key-material-123456789",
      keyVersion: 2,
    };
    const oldSession = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 300,
      config: previous,
    });
    const rotated = {
      ...SESSION_CONFIG,
      previousKey: previous.key,
      previousKeyVersion: previous.keyVersion,
      previousKeyGraceUntil: new Date("2100-01-01T00:00:00.000Z"),
    };
    const app = Fastify();
    await registerDeliveryRoute(app, { db: ctx.db, vault: f.vault, session: rotated });
    const grace = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { authorization: `Bearer ${oldSession.token}` },
    });
    expect(grace.statusCode).toBe(200);
    await app.close();
  });

  it("reveals the secret once with no-cache / no-referrer headers", async () => {
    const f = await seedReady();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const app = Fastify();
    const session = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 300,
      config: SESSION_CONFIG,
    });
    await registerDeliveryRoute(app, { db: ctx.db, vault: f.vault, session: SESSION_CONFIG });

    const res = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(f.secret);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);

    // Replay is 410, not 200.
    const replay = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain(f.secret);

    await app.close();
  });

  it("refuses a non-owner and an unauthenticated request without leaking the secret", async () => {
    const f = await seedReady();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c1",
    });
    if (!issued.ok) throw new Error("issue failed");

    const app = Fastify();
    await registerDeliveryRoute(app, { db: ctx.db, vault: f.vault, session: SESSION_CONFIG });

    const unauth = await app.inject({ method: "GET", url: `/d/${issued.token}` });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.body).not.toContain(f.secret);

    const headerSpoof = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { "x-customer-id": f.customerId },
    });
    expect(headerSpoof.statusCode).toBe(401);
    expect(headerSpoof.body).not.toContain(f.secret);

    const attackerCustomerId = newId();
    await sql`insert into customer (id) values (${attackerCustomerId})`.execute(ctx.db);
    const attackerSession = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: attackerCustomerId,
      telegramUserId: "987654321",
      ttlSeconds: 300,
      config: SESSION_CONFIG,
    });
    const attacker = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { authorization: `Bearer ${attackerSession.token}` },
    });
    expect(attacker.statusCode).toBe(410);
    expect(attacker.body).not.toContain(f.secret);

    // Owner can still reveal after the attacker failed (attacker must not burn the view).
    const ownerSession = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 300,
      config: SESSION_CONFIG,
    });
    const owner = await app.inject({
      method: "GET",
      url: `/d/${issued.token}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toBe(f.secret);

    await app.close();
  });

  it("rejects expired and wrong-audience sessions before vault access", async () => {
    const f = await seedReady();
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: f.orderId,
      customerId: f.customerId,
      assetId: f.assetId,
      ttlSeconds: 900,
      correlationId: "c-expired",
    });
    if (!issued.ok) throw new Error("issue failed");
    const expired = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 1,
      config: SESSION_CONFIG,
      now: new Date(Date.now() - 10_000),
    });
    const wrongAudience = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 300,
      config: { ...SESSION_CONFIG, audience: "another-audience" },
    });
    const wrongKeyVersion = await issueDeliverySession(ctx.db, {
      bundleId: issued.bundleId,
      customerId: f.customerId,
      telegramUserId: "123456789",
      ttlSeconds: 300,
      config: { ...SESSION_CONFIG, keyVersion: SESSION_CONFIG.keyVersion + 1 },
    });
    const app = Fastify();
    await registerDeliveryRoute(app, { db: ctx.db, vault: f.vault, session: SESSION_CONFIG });

    for (const token of [expired.token, wrongAudience.token, wrongKeyVersion.token]) {
      const response = await app.inject({
        method: "GET",
        url: `/d/${issued.token}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(f.secret);
    }
    expect(
      await f.vault.reveal(
        (
          await sql<{
            vault_ref: string;
          }>`select vault_ref from digital_asset where id = ${f.assetId}`.execute(ctx.db)
        ).rows[0]!.vault_ref,
      ),
    ).toBe(f.secret);
    await app.close();
  });
});
