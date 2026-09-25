import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { createSupplierCanaryService } from "../../src/modules/supplier/canary.js";
import { createSupplierProviderRegistry } from "../../src/modules/supplier/registry.js";
import { provisionFromSupplier } from "../../src/modules/supplier/service.js";
import {
  supplierCanaryPurchaseEnabled,
  supplierCommercePurchaseEnabled,
  type AppConfig,
} from "../../src/config/index.js";
import type {
  QueryOrderInput,
  QueryOrderResult,
  SupplierProvider,
} from "../../src/modules/supplier/port.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;
const ROOT_ID = 7788990011;

interface Fixture {
  rootChannelIdentityId: string;
  customerId: string;
  supplierId: string;
  supplierSkuId: string;
  variantId: string;
}

interface ProviderState {
  creates: number;
  queries: number;
  balance: number;
  queryInputs?: QueryOrderInput[];
  queryResult?: QueryOrderResult;
  queryError?: Error;
}

type PurchaseFlags = Pick<
  AppConfig,
  "SUPPLIER_PURCHASE_ENABLED" | "SUPPLIER_COMMERCE_PURCHASE_ENABLED" | "SUPPLIER_CANARY_ENABLED"
>;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table supplier_canary_run, admin_confirmation, audit_event, supplier_catalog_product,
      supplier_sku,
      supplier, channel_identity, product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seed(): Promise<Fixture> {
  const rootCustomerId = newId();
  const rootChannelIdentityId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const supplierId = `qcst-${newId()}`;
  const supplierSkuId = newId();
  const slug = `canary-${categoryId.slice(-8)}`;

  await sql`
    insert into customer (id, status, locale) values (${rootCustomerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${rootCustomerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'Canary', ${slug}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'Canary product', ${slug}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Canary variant', 99000,
      'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY')
  `.execute(ctx.db);
  await sql`
    insert into supplier
    values (${supplierId}, 'Canary provider', 'QCST', 'vault:canary-test', 'ACTIVE',
      '["CATALOG_LIST","ORDER_CREATE","ORDER_READ","BALANCE_READ","NATIVE_IDEMPOTENCY"]'::jsonb)
  `.execute(ctx.db);
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values (${supplierSkuId}, ${supplierId}, ${variantId}, 'CANARY-SKU', 23000, 'VN', 'CREDENTIAL', true)
  `.execute(ctx.db);
  await sql`
    update product_variant set supplier_sku_id = ${supplierSkuId} where id = ${variantId}
  `.execute(ctx.db);
  await sql`
    insert into supplier_catalog_product
      (id, supplier_id, external_product_id, external_variant_id, upstream_name_vi,
       customer_input_type, requires_customer_input, customer_inputs_per_item, fulfillment_mode,
       availability, domain_status, stock_type, stock_quantity, min_quantity, supplier_cost_vnd,
       currency, selection_status, is_enabled, is_missing, local_product_id, local_variant_id,
       supplier_sku_id)
    values
      (${newId()}, ${supplierId}, 'CANARY-SKU', '', 'Canary provider product', 'NONE', false, 0,
       'AUTOMATIC', 'AVAILABLE', 'SUPPORTED', 'FINITE', 4, 1, 23000, 'VND', 'SELECTED', true,
       false, ${productId}, ${variantId}, ${supplierSkuId})
  `.execute(ctx.db);

  return {
    rootChannelIdentityId,
    customerId: rootCustomerId,
    supplierId,
    supplierSkuId,
    variantId,
  };
}

function makeProvider(fixture: Fixture, state: ProviderState): SupplierProvider {
  return {
    providerKey: fixture.supplierId,
    displayName: "Canary provider",
    capabilities: new Set([
      "CATALOG_LIST",
      "ORDER_CREATE",
      "ORDER_READ",
      "BALANCE_READ",
      "NATIVE_IDEMPOTENCY",
    ]),
    getBalance: async () => ({ available: state.balance, currency: "VND" }),
    getAvailability: async () => ({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
    createOrder: async () => {
      state.creates += 1;
      return {
        kind: "ACCEPTED",
        externalOrderId: `qcst-order-${state.creates}`,
        status: "PENDING",
      };
    },
    queryOrder: async (input) => {
      state.queries += 1;
      state.queryInputs?.push(input);
      if (state.queryError) throw state.queryError;
      return state.queryResult ?? { status: "PENDING", externalOrderId: "qcst-order-1" };
    },
    cancelOrder: async () => ({ status: "UNSUPPORTED" }),
    requestRefund: async () => ({ status: "UNSUPPORTED" }),
    reconcile: async () => ({ observations: [], nextCursor: null }),
  };
}

function makeService(
  fixture: Fixture,
  state: ProviderState,
  flags: PurchaseFlags = {
    SUPPLIER_PURCHASE_ENABLED: true,
    SUPPLIER_COMMERCE_PURCHASE_ENABLED: false,
    SUPPLIER_CANARY_ENABLED: true,
  },
  registerProvider = true,
) {
  const provider = makeProvider(fixture, state);
  const confirmation = createAdminConfirmation(ctx.db);
  const rootConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
  const registry = createSupplierProviderRegistry(registerProvider ? [provider] : []);
  return createSupplierCanaryService({
    db: ctx.db,
    registry,
    confirmation,
    rootChannelIdentityId: fixture.rootChannelIdentityId,
    rootConfig,
    sensitiveDeps: {
      db: ctx.db,
      rootConfig,
      vault: createInMemoryVault(),
      stepUpEnabled: false,
      stepUpOptions: { ttlSeconds: 120, lockoutMinutes: 10, maxAttempts: 5 },
    },
    canaryEnabled: flags.SUPPLIER_CANARY_ENABLED,
    canaryPurchaseEnabled: (providerKey) =>
      supplierCanaryPurchaseEnabled(flags, providerKey === fixture.supplierId),
    maxCostVnd: 100000,
  });
}

async function seedPaidCommerceOrder(fixture: Fixture): Promise<string> {
  const orderId = newId();
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values
      (${orderId}, ${`ORD-${orderId}`}, ${fixture.customerId}, ${fixture.variantId},
       'Canary product', 'Canary variant', 99000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  return orderId;
}

async function provisionCommerceOrder(
  fixture: Fixture,
  state: ProviderState,
  orderId: string,
  purchaseEnabled: boolean,
) {
  return provisionFromSupplier(ctx.db, {
    orderId,
    supplierId: fixture.supplierId,
    supplierSkuId: fixture.supplierSkuId,
    externalSku: "CANARY-SKU",
    costCeilingVnd: 23000,
    salePriceVnd: 99000,
    expectedSku: "CANARY-SKU",
    deliveryType: "CREDENTIAL",
    durationCode: "P1M",
    region: "VN",
    correlationId: "supplier-lane-isolation",
    port: makeProvider(fixture, state),
    vault: createInMemoryVault(),
    purchaseEnabled,
  });
}

async function deliveryCounts() {
  const result = await sql<{ assets: string; bundles: string; notifications: string }>`
    select
      (select count(*)::text from digital_asset) as assets,
      (select count(*)::text from delivery_bundle) as bundles,
      (select count(*)::text from delivery_notification_handoff) as notifications
  `.execute(ctx.db);
  return result.rows[0]!;
}

async function seedSubmittedRun(fixture: Fixture, state: ProviderState) {
  const service = makeService(fixture, state);
  const preview = await service.prepare({
    actor: { numericUserId: ROOT_ID, chatType: "private" },
    supplierSkuId: fixture.supplierSkuId,
    correlationId: "submitted-recovery",
  });
  if (!preview.ok) throw new Error(preview.code);
  await sql`
    update supplier_canary_run
    set status = 'SUBMITTED', query_key = idempotency_key, submitted_at = now(),
        external_order_id = null
    where id = ${preview.runId}
  `.execute(ctx.db);
  return { runId: preview.runId, service };
}

async function commerceCounts() {
  const result = await sql<{ orders: string; payments: string; assets: string }>`
    select
      (select count(*)::text from "order") as orders,
      (select count(*)::text from payment_intent) as payments,
      (select count(*)::text from digital_asset) as assets
  `.execute(ctx.db);
  return result.rows[0]!;
}

describe("owner supplier canary", () => {
  it("recovers SUBMITTED query-only even after every purchase gate is off", async () => {
    const fixture = await seed();
    const state: ProviderState = {
      creates: 0,
      queries: 0,
      balance: 50000,
      queryInputs: [],
      queryError: new Error("provider query temporarily unavailable"),
    };
    const { runId } = await seedSubmittedRun(fixture, state);
    const service = makeService(fixture, state, {
      SUPPLIER_PURCHASE_ENABLED: false,
      SUPPLIER_COMMERCE_PURCHASE_ENABLED: false,
      SUPPLIER_CANARY_ENABLED: false,
    });

    await expect(service.executePending(runId)).rejects.toThrow(
      "provider query temporarily unavailable",
    );
    expect({ creates: state.creates, queries: state.queries }).toEqual({ creates: 0, queries: 1 });
    expect(state.queryInputs).toEqual([{ queryKey: `supplier-canary:${runId}` }]);
    const row = await sql<{ status: string; query_key: string | null }>`
      select status, query_key from supplier_canary_run where id = ${runId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({
      status: "SUBMITTED",
      query_key: `supplier-canary:${runId}`,
    });
  });
  it("keeps SUBMITTED recoverable when its provider is not registered", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const { runId } = await seedSubmittedRun(fixture, state);
    const service = makeService(fixture, state, undefined, false);

    const result = await service.executePending(runId);
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    expect({ creates: state.creates, queries: state.queries }).toEqual({ creates: 0, queries: 0 });
    const row = await sql<{ status: string }>`
      select status from supplier_canary_run where id = ${runId}
    `.execute(ctx.db);
    expect(row.rows[0]?.status).toBe("SUBMITTED");
  });

  it("adopts an upstream-accepted order on restart and then queries by external ID", async () => {
    const fixture = await seed();
    const acceptedOrderId = "qcst-order-already-accepted";
    const state: ProviderState = {
      creates: 0,
      queries: 0,
      balance: 50000,
      queryInputs: [],
      queryResult: { status: "PENDING", externalOrderId: acceptedOrderId },
    };
    const { runId } = await seedSubmittedRun(fixture, state);
    const restartedService = makeService(fixture, state);

    const first = await restartedService.executePending(runId);
    expect(first).toMatchObject({
      ok: true,
      status: "UNKNOWN",
      externalOrderId: acceptedOrderId,
    });
    const replay = await restartedService.executePending(runId);
    expect(replay).toMatchObject({
      ok: true,
      status: "UNKNOWN",
      externalOrderId: acceptedOrderId,
    });
    expect(state.queryInputs).toEqual([
      { queryKey: `supplier-canary:${runId}` },
      { externalOrderId: acceptedOrderId },
    ]);
    expect({ creates: state.creates, queries: state.queries }).toEqual({ creates: 0, queries: 2 });
    const row = await sql<{
      status: string;
      external_order_id: string | null;
      query_key: string | null;
    }>`
      select status, external_order_id, query_key from supplier_canary_run where id = ${runId}
    `.execute(ctx.db);
    expect(row.rows[0]).toEqual({
      status: "PENDING",
      external_order_id: acceptedOrderId,
      query_key: null,
    });
  });

  it("keeps repeated SUBMITTED resumes query-only when the provider stays ambiguous", async () => {
    const fixture = await seed();
    const state: ProviderState = {
      creates: 0,
      queries: 0,
      balance: 50000,
      queryError: new Error("query still ambiguous"),
    };
    const { runId, service } = await seedSubmittedRun(fixture, state);

    await expect(service.executePending(runId)).rejects.toThrow("query still ambiguous");
    await expect(service.executePending(runId)).rejects.toThrow("query still ambiguous");
    expect({ creates: state.creates, queries: state.queries }).toEqual({ creates: 0, queries: 2 });
  });

  it("resumes SUBMITTED query-only after recreating the service", async () => {
    const fixture = await seed();
    const state: ProviderState = {
      creates: 0,
      queries: 0,
      balance: 50000,
      queryError: new Error("query unavailable"),
    };
    const { runId, service } = await seedSubmittedRun(fixture, state);

    await expect(service.executePending(runId)).rejects.toThrow("query unavailable");
    await expect(makeService(fixture, state).executePending(runId)).rejects.toThrow(
      "query unavailable",
    );
    expect({ creates: state.creates, queries: state.queries }).toEqual({ creates: 0, queries: 2 });
  });

  it("keeps commerce closed while allowing one owner-confirmed canary and no customer delivery", async () => {
    const fixture = await seed();
    const orderId = await seedPaidCommerceOrder(fixture);
    const flags: PurchaseFlags = {
      SUPPLIER_PURCHASE_ENABLED: true,
      SUPPLIER_COMMERCE_PURCHASE_ENABLED: false,
      SUPPLIER_CANARY_ENABLED: true,
    };
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const beforeCommerce = await commerceCounts();
    const beforeDelivery = await deliveryCounts();

    const commerce = await provisionCommerceOrder(
      fixture,
      state,
      orderId,
      supplierCommercePurchaseEnabled(flags, true),
    );
    expect(commerce).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    expect(state.creates).toBe(0);

    const service = makeService(fixture, state, flags);
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const preview = await service.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "commerce-closed-preview",
    });
    if (!preview.ok) throw new Error(preview.code);
    const confirmed = await service.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "commerce-closed-confirm",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      execution: { ok: true, status: "PENDING" },
    });
    expect(state.creates).toBe(1);
    expect(await commerceCounts()).toEqual(beforeCommerce);
    expect(await deliveryCounts()).toEqual(beforeDelivery);
  });

  it("allows commerce without enabling the canary lane", async () => {
    const fixture = await seed();
    const orderId = await seedPaidCommerceOrder(fixture);
    const flags: PurchaseFlags = {
      SUPPLIER_PURCHASE_ENABLED: true,
      SUPPLIER_COMMERCE_PURCHASE_ENABLED: true,
      SUPPLIER_CANARY_ENABLED: false,
    };
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };

    const commerce = await provisionCommerceOrder(
      fixture,
      state,
      orderId,
      supplierCommercePurchaseEnabled(flags, true),
    );
    expect(commerce).toMatchObject({ ok: true, kind: "UNKNOWN" });
    expect(state.creates).toBe(1);

    const blockedPreview = await makeService(fixture, state, flags).prepare({
      actor: { numericUserId: ROOT_ID, chatType: "private" },
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "canary-disabled",
    });
    expect(blockedPreview).toMatchObject({ ok: false, code: "CANARY_DISABLED" });
    expect(state.creates).toBe(1);
  });

  it("keeps both supplier purchase lanes closed when the master gate is off", async () => {
    const fixture = await seed();
    const orderId = await seedPaidCommerceOrder(fixture);
    const flags: PurchaseFlags = {
      SUPPLIER_PURCHASE_ENABLED: false,
      SUPPLIER_COMMERCE_PURCHASE_ENABLED: true,
      SUPPLIER_CANARY_ENABLED: true,
    };
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };

    const commerce = await provisionCommerceOrder(
      fixture,
      state,
      orderId,
      supplierCommercePurchaseEnabled(flags, true),
    );
    expect(commerce).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    const canary = await makeService(fixture, state, flags).prepare({
      actor: { numericUserId: ROOT_ID, chatType: "private" },
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "master-disabled",
    });
    expect(canary).toMatchObject({ ok: false, code: "PURCHASE_GATE_DISABLED" });
    expect(state.creates).toBe(0);
  });
  it("previews without POST, then creates exactly one pending run without commerce delivery", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const service = makeService(fixture, state);
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };

    const preview = await service.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "canary-preview",
    });
    expect(preview.ok).toBe(true);
    expect(state.creates).toBe(0);
    const before = await commerceCounts();
    expect(before).toEqual({ orders: "0", payments: "0", assets: "0" });
    if (!preview.ok) return;

    const confirmed = await service.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "canary-confirm",
    });
    expect(confirmed).toMatchObject({
      ok: true,
      runId: preview.runId,
      execution: { ok: true, status: "PENDING" },
    });
    expect(state.creates).toBe(1);
    const run = await sql<{ status: string }>`
      select status from supplier_canary_run where id = ${preview.runId}
    `.execute(ctx.db);
    expect(run.rows[0]?.status).toBe("PENDING");
    const after = await commerceCounts();
    expect(after).toEqual(before);
    const resale = await sql<{ resale_evidence_id: string | null }>`
      select resale_evidence_id from product_variant where id = ${fixture.variantId}
    `.execute(ctx.db);
    expect(resale.rows[0]?.resale_evidence_id).toBeNull();
  });

  it("replays a confirmation through query-only recovery and never creates twice", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const service = makeService(fixture, state);
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const preview = await service.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "replay",
    });
    if (!preview.ok) throw new Error(preview.code);

    await service.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "replay-confirm",
    });
    const replay = await service.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "replay-again",
    });
    expect(replay).toMatchObject({ ok: true, execution: { ok: true, status: "UNKNOWN" } });
    expect(state.creates).toBe(1);
    expect(state.queries).toBe(1);
  });

  it("serializes concurrent owner confirmation to one upstream create", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const service = makeService(fixture, state);
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const preview = await service.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "concurrent",
    });
    if (!preview.ok) throw new Error(preview.code);

    const results = await Promise.all([
      service.confirmIfCanary({
        confirmationId: preview.confirmationId,
        challenge: preview.challenge,
        actor,
        correlationId: "concurrent-a",
      }),
      service.confirmIfCanary({
        confirmationId: preview.confirmationId,
        challenge: preview.challenge,
        actor,
        correlationId: "concurrent-b",
      }),
    ]);
    expect(results.every((result) => result?.ok === true)).toBe(true);
    expect(state.creates).toBe(1);
    expect(state.queries).toBeLessThanOrEqual(1);
  });

  it("blocks a stale cost before POST", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const service = makeService(fixture, state);
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const preview = await service.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "stale-cost",
    });
    if (!preview.ok) throw new Error(preview.code);
    await sql`update supplier_sku set cost_vnd = 24000 where id = ${fixture.supplierSkuId}`.execute(
      ctx.db,
    );

    const result = await service.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "stale-cost-confirm",
    });
    expect(result).toMatchObject({
      ok: true,
      execution: { ok: false, code: "CANARY_COST_CHANGED" },
    });
    expect(state.creates).toBe(0);
  });

  it("blocks over-budget and underfunded canaries before preview", async () => {
    const overBudgetFixture = await seed();
    const overBudgetState: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    await sql`
      update supplier_sku set cost_vnd = 100001 where id = ${overBudgetFixture.supplierSkuId}
    `.execute(ctx.db);
    const overBudget = await makeService(overBudgetFixture, overBudgetState).prepare({
      actor: { numericUserId: ROOT_ID, chatType: "private" },
      supplierSkuId: overBudgetFixture.supplierSkuId,
      correlationId: "over-budget",
    });
    expect(overBudget).toMatchObject({ ok: false, code: "COST_TOO_HIGH" });
    expect(overBudgetState.creates).toBe(0);

    const underfundedFixture = overBudgetFixture;
    await sql`
      update supplier_sku set cost_vnd = 23000 where id = ${underfundedFixture.supplierSkuId}
    `.execute(ctx.db);
    const underfundedState: ProviderState = { creates: 0, queries: 0, balance: 1000 };
    const underfunded = await makeService(underfundedFixture, underfundedState).prepare({
      actor: { numericUserId: ROOT_ID, chatType: "private" },
      supplierSkuId: underfundedFixture.supplierSkuId,
      correlationId: "underfunded",
    });
    expect(underfunded).toMatchObject({ ok: false, code: "INSUFFICIENT_BALANCE" });
    expect(underfundedState.creates).toBe(0);
  });

  it("requires automatic fulfillment with no customer inputs", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    await sql`
      update supplier_catalog_product
      set fulfillment_mode = 'MANUAL_REVIEW'
      where supplier_sku_id = ${fixture.supplierSkuId}
    `.execute(ctx.db);
    const manual = await makeService(fixture, state).prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "manual-delivery",
    });
    expect(manual).toMatchObject({ ok: false, code: "AUTOMATIC_DELIVERY_REQUIRED" });

    await sql`
      update supplier_catalog_product
      set fulfillment_mode = 'AUTOMATIC', requires_customer_input = true, customer_inputs_per_item = 1
      where supplier_sku_id = ${fixture.supplierSkuId}
    `.execute(ctx.db);
    const customerInput = await makeService(fixture, state).prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "customer-input",
    });
    expect(customerInput).toMatchObject({ ok: false, code: "AUTOMATIC_DELIVERY_REQUIRED" });
    expect(state.creates).toBe(0);
  });

  it("rejects disabled and expired confirmations without POST", async () => {
    const fixture = await seed();
    const state: ProviderState = { creates: 0, queries: 0, balance: 50000 };
    const disabled = makeService(fixture, state, {
      SUPPLIER_PURCHASE_ENABLED: true,
      SUPPLIER_COMMERCE_PURCHASE_ENABLED: false,
      SUPPLIER_CANARY_ENABLED: false,
    });
    const actor = { numericUserId: ROOT_ID, chatType: "private" as const };
    const blocked = await disabled.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "off",
    });
    expect(blocked).toMatchObject({ ok: false, code: "CANARY_DISABLED" });
    expect(state.creates).toBe(0);

    const enabled = makeService(fixture, state);
    const preview = await enabled.prepare({
      actor,
      supplierSkuId: fixture.supplierSkuId,
      correlationId: "expired",
    });
    if (!preview.ok) throw new Error(preview.code);
    await sql`
      update admin_confirmation set expires_at = now() - interval '1 second'
      where id = ${preview.confirmationId}
    `.execute(ctx.db);
    const expired = await enabled.confirmIfCanary({
      confirmationId: preview.confirmationId,
      challenge: preview.challenge,
      actor,
      correlationId: "expired-confirm",
    });
    expect(expired).toMatchObject({ ok: false, code: "CHALLENGE_EXPIRED" });
    expect(state.creates).toBe(0);
  });
});
