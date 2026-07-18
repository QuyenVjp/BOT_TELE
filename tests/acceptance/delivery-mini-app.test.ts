import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  createDeliveryNotificationHandoff,
  processDeliveryNotificationBatch,
} from "../../src/modules/digital-goods/delivery-notification.js";
import { registerDeliveryRoute } from "../../src/modules/digital-goods/delivery-route.js";
import { issueDeliveryBundle } from "../../src/modules/digital-goods/delivery.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const BOT_TOKEN = ["telegram", "mini", "app", "test"].join("-");
const SESSION_CONFIG = {
  key: "mini-app-delivery-session-key-material-123456789",
  keyVersion: 6,
  audience: "delivery-reveal",
};
let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);
afterAll(async () => ctx?.teardown());
beforeEach(async () => {
  await sql`
    truncate table delivery_miniapp_redemption, delivery_notification_handoff,
      delivery_session, delivery_bundle, channel_identity, digital_asset, outbox_event,
      "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

function signedInitData(userId: string, authDate = Math.floor(Date.now() / 1000)): string {
  const values = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: Number(userId), first_name: "Customer" }),
  });
  const check = [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN, "utf8").digest();
  values.set("hash", createHmac("sha256", secret).update(check, "utf8").digest("hex"));
  return values.toString();
}

async function seed() {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const vault = createInMemoryVault();
  const vaultRef = await vault.write("MINI-APP-SECRET");
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug) values (${categoryId}, 'C', ${slug})`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug) values (${productId}, ${categoryId}, 'P', ${slug})`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-MINI')
  `.execute(ctx.db);
  await sql`insert into customer (id) values (${customerId})`.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', '7788990011')
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'READY', ${orderId})
  `.execute(ctx.db);
  const bundle = await issueDeliveryBundle(ctx.db, {
    orderId,
    customerId,
    assetId,
    ttlSeconds: 900,
    correlationId: "mini-app",
  });
  if (!bundle.ok) throw new Error("bundle issue failed");
  const handoff = await createDeliveryNotificationHandoff(ctx.db, {
    vault,
    bundleId: bundle.bundleId,
    customerId,
    deliveryUrl: `https://shop.example/d/${bundle.token}`,
    sessionTtlSeconds: 300,
    sessionConfig: SESSION_CONFIG,
  });
  return { vault, bundle, handoff };
}

describe("Telegram Mini App delivery redemption (T184 RED)", () => {
  it("verifies initData and returns an audience-bound capability used by Mini App fetch", async () => {
    const f = await seed();
    let miniAppUrl = "";
    const notified = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: f.vault,
      sender: {
        async send(input) {
          miniAppUrl = input.miniAppUrl;
          expect(input).not.toHaveProperty("sessionToken");
        },
      },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "mini-app-notifier",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    expect(notified.sent).toBe(1);
    const handoffId = new URL(miniAppUrl).searchParams.get("handoff");
    expect(handoffId).toBe(f.handoff.id);
    const app = Fastify();
    await registerDeliveryRoute(app, {
      db: ctx.db,
      vault: f.vault,
      session: SESSION_CONFIG,
      miniApp: { botToken: BOT_TOKEN, path: "/delivery/redeem", maxAgeSeconds: 300 },
    });
    const redemption = await app.inject({
      method: "POST",
      url: "/delivery/redeem",
      payload: {
        initData: signedInitData("7788990011"),
        handoffId,
        audience: "delivery-reveal",
      },
    });
    expect(redemption.statusCode).toBe(200);
    const capability = redemption.json<{ deliveryUrl: string; sessionToken: string }>();
    expect(capability.sessionToken).toMatch(/^ds1\./);
    expect(JSON.stringify(capability)).not.toContain("MINI-APP-SECRET");
    const revealPath = new URL(capability.deliveryUrl).pathname;
    const revealed = await app.inject({
      method: "GET",
      url: revealPath,
      headers: { authorization: `Bearer ${capability.sessionToken}` },
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.body).toBe("MINI-APP-SECRET");
    await app.close();
  });

  it("rejects replay, a different numeric Telegram owner, and expired initData", async () => {
    const f = await seed();
    const app = Fastify();
    await registerDeliveryRoute(app, {
      db: ctx.db,
      vault: f.vault,
      session: SESSION_CONFIG,
      miniApp: { botToken: BOT_TOKEN, path: "/delivery/redeem", maxAgeSeconds: 300 },
    });
    const initData = signedInitData("7788990011");
    const request = { initData, handoffId: f.handoff.id, audience: "delivery-reveal" };
    expect(
      (await app.inject({ method: "POST", url: "/delivery/redeem", payload: request })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/delivery/redeem", payload: request })).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/delivery/redeem",
          payload: { ...request, initData: signedInitData("99887766") },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/delivery/redeem",
          payload: {
            ...request,
            initData: signedInitData("7788990011", Math.floor(Date.now() / 1000) - 301),
          },
        })
      ).statusCode,
    ).toBe(401);
    const capabilityRef = (
      await sql<{ capability_ref: string }>`
        select capability_ref from delivery_notification_handoff where id = ${f.handoff.id}
      `.execute(ctx.db)
    ).rows[0]!.capability_ref;
    const stored = JSON.parse(await f.vault.reveal(capabilityRef)) as { deliveryUrl: string };
    expect(
      (await app.inject({ method: "GET", url: new URL(stored.deliveryUrl).pathname })).statusCode,
    ).toBe(401);
    await app.close();
  });
});
