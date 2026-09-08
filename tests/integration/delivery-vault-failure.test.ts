import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createExternalVault } from "../../src/infrastructure/vault/external-adapter.js";
import {
  issueDeliveryBundle,
  revealDeliveryBundle,
} from "../../src/modules/digital-goods/delivery.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const VAULT_TOKEN = ["delivery", "vault", "outage", "test", "token"].join("-");
const stored = new Map<string, string>();
let ctx: PgTestContext;
let port = 0;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${VAULT_TOKEN}`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const url = request.url ?? "";
  if (request.method === "GET" && url === "/healthz") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (!url.startsWith("/v1/secrets/shop-staging/asset/")) {
    json(response, 404, { error: "not found" });
    return;
  }

  if (request.method === "PUT") {
    const parsed = JSON.parse(await readBody(request)) as { material?: unknown };
    if (typeof parsed.material !== "string") {
      json(response, 400, { error: "invalid" });
      return;
    }
    stored.set(url, parsed.material);
    json(response, 201, { ref: `vault:${url.slice("/v1/secrets/".length).replaceAll("/", ":")}` });
    return;
  }

  if (request.method === "GET") {
    const material = stored.get(url);
    if (material === undefined) {
      json(response, 404, { error: "not found" });
      return;
    }
    json(response, 200, { material });
    return;
  }

  if (request.method === "DELETE") {
    stored.delete(url);
    response.writeHead(204).end();
    return;
  }

  json(response, 405, { error: "method not allowed" });
});

async function listen(): Promise<void> {
  server.listen(port || 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("vault test server did not bind");
  port = address.port;
}

async function stopServer(): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

beforeAll(async () => {
  ctx = await startPostgresContainer();
  try {
    await listen();
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await Promise.all([ctx?.teardown(), stopServer()]);
});

beforeEach(async () => {
  stored.clear();
  await sql`
    truncate table delivery_bundle, digital_asset, payment_allocation, discrepancy,
      bank_transaction, payment_intent, order_transition, "order", product_variant,
      product, category, customer cascade
  `.execute(ctx.db);
});

async function seedReadyAsset(vaultRef: string) {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();

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
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values
      (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, 'READY', ${orderId})
  `.execute(ctx.db);

  return { orderId, customerId, assetId };
}

async function deliveryState(bundleId: string) {
  const row = await sql<{ bundle_status: string; asset_status: string }>`
    select b.status as bundle_status, a.status as asset_status
    from delivery_bundle b
    join digital_asset a on a.id = b.asset_id
    where b.id = ${bundleId}
  `.execute(ctx.db);
  return row.rows[0];
}

describe("delivery reveal with external Vault outage (T140)", () => {
  it("leaves the bundle retryable during a real adapter outage and recovers without reissuing", async () => {
    const vault = createExternalVault({
      endpoint: `http://127.0.0.1:${port}`,
      token: VAULT_TOKEN,
      namespace: "shop-staging",
      timeoutMs: 200,
      maxAttempts: 1,
      testTransport: { allowInsecureLoopback: true },
      egressPolicy: {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [port],
        allowedCidrs: ["127.0.0.0/8"],
      },
    });
    const secret = `USER:pass-${newId().slice(-6)}`;
    const vaultRef = await vault.write(secret, {
      namespace: "asset",
      idempotencyKey: `asset-${newId().slice(-12)}`,
    });
    const fixture = await seedReadyAsset(vaultRef);
    const issued = await issueDeliveryBundle(ctx.db, {
      orderId: fixture.orderId,
      customerId: fixture.customerId,
      assetId: fixture.assetId,
      ttlSeconds: 900,
      correlationId: "external-vault-outage-issue",
    });
    if (!issued.ok) throw new Error("issue failed");

    await stopServer();
    const outage = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: fixture.customerId,
      correlationId: "external-vault-outage",
      vault,
    });
    expect(outage).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(await deliveryState(issued.bundleId)).toMatchObject({
      bundle_status: "VIEWED",
      asset_status: "READY",
    });

    await listen();
    const recovered = await revealDeliveryBundle(ctx.db, {
      token: issued.token,
      customerId: fixture.customerId,
      correlationId: "external-vault-recovered",
      vault,
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.secret).toBe(secret);
    expect(await deliveryState(issued.bundleId)).toMatchObject({
      bundle_status: "CONSUMED",
      asset_status: "DELIVERED",
    });
  });
});
