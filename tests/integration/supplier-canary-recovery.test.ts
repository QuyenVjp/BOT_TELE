import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import {
  createSupplierCanaryService,
  type SupplierCanaryExecutionResult,
} from "../../src/modules/supplier/canary.js";
import {
  createWorkerScheduler,
  runRecoveryJobsOnce,
  type RecoveryCycleResult,
  type WorkerSchedulerTimer,
} from "../../src/worker.js";
import {
  createSupplierProviderRegistry,
  type SupplierProviderRegistry,
} from "../../src/modules/supplier/registry.js";
import {
  SupplierPortError,
  type QueryOrderInput,
  type QueryOrderResult,
  type SupplierCapability,
  type SupplierProvider,
} from "../../src/modules/supplier/port.js";
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
    truncate table supplier_canary_run, supplier_order, supplier_sku, supplier,
      digital_asset, delivery_bundle, payment_allocation, payment_intent,
      order_transition, "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

type SeededRecoveryRun = {
  runId: string;
  supplierId: string;
  supplierSkuId: string;
  variantId: string;
  idempotencyKey: string;
  externalOrderId: string | null;
  confirmationId?: string;
  actionFingerprint?: string;
};

async function seedCanaryRun(
  status: "AUTHORIZED" | "SUBMITTED" | "PENDING" | "UNKNOWN",
  options: { submittedAgeSeconds?: number; nextReconcileInSeconds?: number } = {},
) {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const supplierId = `qcst-${newId()}`;
  const supplierSkuId = newId();
  const runId = newId();
  const idempotencyKey = `canary-client-${runId}`;
  const submittedAt = new Date(Date.now() - (options.submittedAgeSeconds ?? 300) * 1_000);
  const externalOrderId = status === "PENDING" ? `qcst-order-${runId}` : null;
  const lastQueriedAt = new Date(Date.now() - 120_000);
  const nextReconcileAt =
    options.nextReconcileInSeconds === undefined
      ? lastQueriedAt
      : new Date(Date.now() + options.nextReconcileInSeconds * 1_000);

  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'Recovery', ${`recovery-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'Recovery product', ${`recovery-${productId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'Recovery variant', 99000,
       'P1M', 'CREDENTIAL', 'SUPPLIER_ONLY')
  `.execute(ctx.db);
  await sql`
    insert into supplier
      (id, name, adapter_type, credential_vault_ref, status, provider_capabilities)
    values
      (${supplierId}, 'Recovery QCST', 'QCST', 'vault:recovery-test', 'ACTIVE',
       '["ORDER_CREATE","ORDER_READ"]'::jsonb)
  `.execute(ctx.db);
  await sql`
    insert into supplier_sku
      (id, supplier_id, variant_id, external_sku, cost_vnd, region, delivery_type, is_active)
    values
      (${supplierSkuId}, ${supplierId}, ${variantId}, 'RECOVERY-SKU', 23000, 'VN', 'CREDENTIAL', true)
  `.execute(ctx.db);
  await sql`
    insert into supplier_canary_run
      (id, supplier_id, supplier_sku_id, variant_id, provider_key, external_sku, region,
       idempotency_key, query_key, request_fingerprint, status, approved_cost_vnd,
       cost_vnd_snapshot, currency, external_order_id, submitted_at, last_queried_at,
       next_reconcile_at, created_by, correlation_id)
    values
      (${runId}, ${supplierId}, ${supplierSkuId}, ${variantId}, ${supplierId}, 'RECOVERY-SKU', 'VN',
       ${idempotencyKey}, ${status === "PENDING" ? null : idempotencyKey}, ${`fp-${runId}`},
       ${status}, 23000, 23000, 'VND', ${externalOrderId}, ${submittedAt.toISOString()},
       ${status === "SUBMITTED" ? null : lastQueriedAt.toISOString()},
       ${status === "SUBMITTED" ? null : nextReconcileAt.toISOString()}, 'test-owner', ${`recovery:${runId}`})
  `.execute(ctx.db);

  return { runId, supplierId, supplierSkuId, variantId, idempotencyKey, externalOrderId };
}
async function seedAuthorizedCanaryRun(withValidConfirmation = true): Promise<SeededRecoveryRun> {
  const run = await seedCanaryRun("AUTHORIZED");
  await sql`
    update supplier_canary_run
    set created_by = '1'
    where id = ${run.runId}
  `.execute(ctx.db);
  await sql`
    update product_variant
    set supplier_sku_id = ${run.supplierSkuId}
    where id = ${run.variantId}
  `.execute(ctx.db);
  await sql`
    insert into supplier_catalog_product
      (id, supplier_id, external_product_id, external_variant_id, upstream_name_vi,
       customer_input_type, requires_customer_input, customer_inputs_per_item, fulfillment_mode,
       availability, domain_status, stock_type, stock_quantity, min_quantity, supplier_cost_vnd,
       currency, selection_status, is_enabled, is_missing, local_product_id, local_variant_id,
       supplier_sku_id)
    values
      (${newId()}, ${run.supplierId}, 'RECOVERY-SKU', '', 'Recovery provider product', 'NONE',
       false, 0, 'AUTOMATIC', 'AVAILABLE', 'SUPPORTED', 'FINITE', 4, 1, 23000, 'VND',
       'SELECTED', true, false,
       (select product_id from product_variant where id = ${run.variantId}),
       ${run.variantId}, ${run.supplierSkuId})
  `.execute(ctx.db);
  if (!withValidConfirmation) return run;

  const customerId = newId();
  const rootChannelIdentityId = newId();
  await sql`
    insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity
      (id, customer_id, channel, channel_user_id, observed_username)
    values
      (${rootChannelIdentityId}, ${customerId}, 'TELEGRAM', ${`recovery-${rootChannelIdentityId}`},
       'test-owner')
  `.execute(ctx.db);
  const actionFingerprint = `supplier.canary.purchase:${run.runId}:fp-${run.runId}`;
  const confirmation = createAdminConfirmation(ctx.db);
  const issued = await confirmation.issue({
    rootChannelIdentityId,
    actionFingerprint,
    correlationId: `recovery-confirmation:${run.runId}`,
    allowlistedCommandRef: "supplier.canary.purchase",
    payloadRedacted: { runId: run.runId, actorId: "1" },
  });
  if (!issued.ok) throw new Error(issued.code);
  const confirmed = await confirmation.confirm({
    confirmationId: issued.confirmationId,
    rootChannelIdentityId,
    actionFingerprint,
    challenge: issued.challenge,
  });
  if (!confirmed.ok) throw new Error(confirmed.code);
  const consumed = await confirmation.consume({
    confirmationId: issued.confirmationId,
    rootChannelIdentityId,
    actionFingerprint,
  });
  if (!consumed.ok) throw new Error(consumed.code);
  await sql`
    update supplier_canary_run
    set confirmation_id = ${issued.confirmationId}
    where id = ${run.runId}
  `.execute(ctx.db);
  return { ...run, confirmationId: issued.confirmationId, actionFingerprint };
}

function makeProvider(input: {
  providerKey: string;
  capabilities?: readonly SupplierCapability[];
  balanceVnd?: number;
  createResult?: { kind: "ACCEPTED"; externalOrderId: string; status: "PENDING" };
  queryResult?: (query: QueryOrderInput, call: number) => QueryOrderResult;
  queryError?: Error;
}) {
  const queryInputs: QueryOrderInput[] = [];
  let createCalls = 0;
  const provider: SupplierProvider = {
    providerKey: input.providerKey,
    displayName: "Recovery provider",
    capabilities: new Set(input.capabilities ?? ["ORDER_CREATE", "ORDER_READ"]),
    getAvailability: async () => ({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
    getBalance: async () => ({ available: input.balanceVnd ?? 100_000, currency: "VND" }),
    createOrder: async () => {
      createCalls += 1;
      if (input.createResult) return input.createResult;
      throw new Error("recovery must never create an order");
    },
    queryOrder: async (query) => {
      queryInputs.push(query);
      if (input.queryError) throw input.queryError;
      return (
        input.queryResult?.(query, queryInputs.length) ?? {
          status: "PENDING",
          externalOrderId: query.externalOrderId ?? `qcst-existing-${queryInputs.length}`,
        }
      );
    },
    cancelOrder: async () => ({ status: "UNSUPPORTED" }),
    requestRefund: async () => ({ status: "UNSUPPORTED" }),
    reconcile: async () => ({ observations: [], nextCursor: null }),
  };
  return {
    provider,
    queryInputs,
    get createCalls() {
      return createCalls;
    },
  };
}

async function dispatchRecovery(
  registry: SupplierProviderRegistry,
  now = new Date(),
  batchSize = 20,
  resumeAuthorizedCanary?: (runId: string) => Promise<SupplierCanaryExecutionResult>,
): Promise<RecoveryCycleResult> {
  return runRecoveryJobsOnce({
    db: ctx.db,
    batchSize,
    now,
    sePayPort: null,
    supplierPort: null,
    supplierRegistry: registry,
    vault: createInMemoryVault(),
    ...(resumeAuthorizedCanary ? { resumeAuthorizedCanary } : {}),
  });
}

function makeRecoveryService(
  registry: SupplierProviderRegistry,
  options: {
    canaryEnabled?: boolean;
    canaryPurchaseEnabled?: (providerKey: string) => boolean;
  } = {},
) {
  const rootConfig = { adminTelegramUserId: 1, expectedUsername: "test-owner" };
  return createSupplierCanaryService({
    db: ctx.db,
    registry,
    confirmation: createAdminConfirmation(ctx.db),
    rootChannelIdentityId: "recovery-test-root-channel",
    rootConfig,
    sensitiveDeps: {
      db: ctx.db,
      rootConfig,
      vault: createInMemoryVault(),
      stepUpEnabled: false,
      stepUpOptions: { ttlSeconds: 120, lockoutMinutes: 10, maxAttempts: 5 },
    },
    canaryEnabled: options.canaryEnabled ?? false,
    canaryPurchaseEnabled: options.canaryPurchaseEnabled ?? (() => false),
    maxCostVnd: 100_000,
  });
}

async function canaryRun(runId: string) {
  const result = await sql<{
    status: string;
    external_order_id: string | null;
    last_error_code: string | null;
    retry_after_seconds: number | null;
    last_queried_at: Date | null;
    next_reconcile_at: Date | null;
    needs_review_at: Date | null;
  }>`
    select status, external_order_id, last_error_code, retry_after_seconds,
           last_queried_at, next_reconcile_at, needs_review_at
    from supplier_canary_run where id = ${runId}
  `.execute(ctx.db);
  return result.rows[0]!;
}

async function deliveryCounts() {
  const result = await sql<{ orders: string; assets: string; bundles: string }>`
    select
      (select count(*)::text from "order") as orders,
      (select count(*)::text from digital_asset) as assets,
      (select count(*)::text from delivery_bundle) as bundles
  `.execute(ctx.db);
  return result.rows[0]!;
}

describe("worker-dispatched supplier canary recovery", () => {
  it("resumes a confirmed AUTHORIZED canary through worker recovery and persists PENDING", async () => {
    const run = await seedAuthorizedCanaryRun();
    if (!run.confirmationId || !run.actionFingerprint)
      throw new Error("missing confirmation fixture");
    const confirmation = await sql<{
      status: string;
      consumed_at: Date | null;
      allowlisted_command_ref: string | null;
      action_fingerprint: string;
      payload_redacted: { runId?: string; actorId?: string };
    }>`
      select status, consumed_at, allowlisted_command_ref, action_fingerprint, payload_redacted
      from admin_confirmation
      where id = ${run.confirmationId}
    `.execute(ctx.db);
    expect(confirmation.rows[0]).toMatchObject({
      status: "CONSUMED",
      consumed_at: expect.any(Date),
      allowlisted_command_ref: "supplier.canary.purchase",
      action_fingerprint: run.actionFingerprint,
      payload_redacted: { runId: run.runId, actorId: "1" },
    });
    const provider = makeProvider({
      providerKey: run.supplierId,
      capabilities: ["ORDER_CREATE", "ORDER_READ", "BALANCE_READ", "CATALOG_LIST"],
      balanceVnd: 50_000,
      createResult: {
        kind: "ACCEPTED",
        externalOrderId: `qcst-created-${run.runId}`,
        status: "PENDING",
      },
    });
    const registry = createSupplierProviderRegistry([provider.provider]);
    const service = makeRecoveryService(registry, {
      canaryEnabled: true,
      canaryPurchaseEnabled: () => true,
    });

    const result = await dispatchRecovery(registry, new Date(), 20, service.executePending);

    const persisted = await canaryRun(run.runId);
    expect(persisted).toMatchObject({
      status: "PENDING",
      external_order_id: `qcst-created-${run.runId}`,
      last_error_code: null,
    });
    expect(result.supplierCanary).toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      backlog: 1,
    });
    expect(provider.createCalls).toBe(1);
    expect(await deliveryCounts()).toEqual({ orders: "0", assets: "0", bundles: "0" });
  });

  it("blocks a confirmed AUTHORIZED canary when gates are off and never revives it", async () => {
    const run = await seedAuthorizedCanaryRun();
    const provider = makeProvider({
      providerKey: run.supplierId,
      capabilities: ["ORDER_CREATE", "ORDER_READ", "BALANCE_READ", "CATALOG_LIST"],
      createResult: {
        kind: "ACCEPTED",
        externalOrderId: `qcst-created-${run.runId}`,
        status: "PENDING",
      },
    });
    const registry = createSupplierProviderRegistry([provider.provider]);
    const disabledService = makeRecoveryService(registry, {
      canaryEnabled: false,
      canaryPurchaseEnabled: () => true,
    });

    const disabled = await dispatchRecovery(
      registry,
      new Date(),
      20,
      disabledService.executePending,
    );

    expect(disabled.supplierCanary).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(provider.createCalls).toBe(0);
    expect(await canaryRun(run.runId)).toMatchObject({
      status: "BLOCKED",
      last_error_code: "PURCHASE_GATE_DISABLED",
    });

    const enabledService = makeRecoveryService(registry, {
      canaryEnabled: true,
      canaryPurchaseEnabled: () => true,
    });
    const enabled = await dispatchRecovery(registry, new Date(), 20, enabledService.executePending);
    expect(enabled.supplierCanary).toMatchObject({ claimed: 0, succeeded: 0, failed: 0 });
    expect(provider.createCalls).toBe(0);
    expect((await canaryRun(run.runId)).status).toBe("BLOCKED");
  });

  it("blocks an AUTHORIZED canary with missing confirmation before any create", async () => {
    const run = await seedAuthorizedCanaryRun(false);
    const provider = makeProvider({
      providerKey: run.supplierId,
      capabilities: ["ORDER_CREATE", "ORDER_READ", "BALANCE_READ", "CATALOG_LIST"],
      createResult: {
        kind: "ACCEPTED",
        externalOrderId: `qcst-created-${run.runId}`,
        status: "PENDING",
      },
    });
    const registry = createSupplierProviderRegistry([provider.provider]);
    const service = makeRecoveryService(registry, {
      canaryEnabled: true,
      canaryPurchaseEnabled: () => true,
    });

    const result = await service.executePending(run.runId);

    expect(result).toMatchObject({
      ok: false,
      runId: run.runId,
      code: "CONFIRMATION_FAILED",
    });
    expect(provider.createCalls).toBe(0);
    expect(await canaryRun(run.runId)).toMatchObject({
      status: "BLOCKED",
      last_error_code: "CONFIRMATION_FAILED",
    });
  });
  it("blocks an AUTHORIZED canary when consumed confirmation payload is mismatched", async () => {
    const run = await seedAuthorizedCanaryRun();
    if (!run.confirmationId) throw new Error("missing confirmation fixture");
    await sql`
      update admin_confirmation
      set payload_redacted = jsonb_build_object('runId', ${run.runId}::text, 'actorId', '999'::text)
      where id = ${run.confirmationId}
    `.execute(ctx.db);
    const provider = makeProvider({
      providerKey: run.supplierId,
      capabilities: ["ORDER_CREATE", "ORDER_READ", "BALANCE_READ", "CATALOG_LIST"],
      createResult: {
        kind: "ACCEPTED",
        externalOrderId: `qcst-created-${run.runId}`,
        status: "PENDING",
      },
    });
    const service = makeRecoveryService(createSupplierProviderRegistry([provider.provider]), {
      canaryEnabled: true,
      canaryPurchaseEnabled: () => true,
    });

    const result = await service.executePending(run.runId);

    expect(result).toMatchObject({
      ok: false,
      runId: run.runId,
      code: "CONFIRMATION_FAILED",
    });
    expect(provider.createCalls).toBe(0);
    expect(await canaryRun(run.runId)).toMatchObject({
      status: "BLOCKED",
      last_error_code: "CONFIRMATION_FAILED",
    });
  });

  it("preserves provider PENDING in the durable row and owner-facing recovery result", async () => {
    const run = await seedCanaryRun("SUBMITTED");
    const externalOrderId = `pending-${run.runId}`;
    const provider = makeProvider({
      providerKey: run.supplierId,
      queryResult: () => ({ status: "PENDING", externalOrderId }),
    });
    const service = makeRecoveryService(createSupplierProviderRegistry([provider.provider]));

    const result = await service.executePending(run.runId);

    expect(result).toMatchObject({
      ok: true,
      runId: run.runId,
      status: "PENDING",
      externalOrderId,
    });
    expect(await canaryRun(run.runId)).toMatchObject({
      status: "PENDING",
      external_order_id: externalOrderId,
    });
    expect(provider.queryInputs).toEqual([{ queryKey: run.idempotencyKey }]);
    expect(provider.createCalls).toBe(0);
  });

  it.each([false, true])(
    "queries SUBMITTED/PENDING/UNKNOWN without POST when purchase gates are %s",
    async (gatesEnabled) => {
      const gateNames = [
        "SUPPLIER_PURCHASE_ENABLED",
        "SUPPLIER_COMMERCE_PURCHASE_ENABLED",
        "SUPPLIER_CANARY_ENABLED",
        "QCST_PURCHASE_ENABLED",
      ];
      for (const name of gateNames) {
        vi.stubEnv(
          name,
          name === "SUPPLIER_COMMERCE_PURCHASE_ENABLED" ? "false" : String(gatesEnabled),
        );
      }
      try {
        const submitted = await seedCanaryRun("SUBMITTED");
        const pending = await seedCanaryRun("PENDING");
        const unknown = await seedCanaryRun("UNKNOWN");
        const providers = [submitted, pending, unknown].map((run) =>
          makeProvider({ providerKey: run.supplierId }),
        );
        const registry = createSupplierProviderRegistry(
          providers.map((provider) => provider.provider),
        );
        const before = new Date();

        const result = await dispatchRecovery(registry, before);

        expect(result).toHaveProperty("supplierCanary", {
          claimed: 3,
          succeeded: 3,
          failed: 0,
          backlog: 3,
          oldestAgeSeconds: expect.any(Number),
        });
        expect(providers.flatMap((provider) => provider.queryInputs)).toEqual(
          expect.arrayContaining([
            { queryKey: submitted.idempotencyKey },
            { externalOrderId: pending.externalOrderId },
            { queryKey: unknown.idempotencyKey },
          ]),
        );
        expect(providers.every((provider) => provider.createCalls === 0)).toBe(true);

        for (const run of [submitted, pending, unknown]) {
          const row = await canaryRun(run.runId);
          expect(row.status).toBe("PENDING");
          expect(row.external_order_id).toBeTruthy();
          expect(row.last_queried_at).toBeInstanceOf(Date);
          expect(row.retry_after_seconds).toBe(60);
          expect(row.next_reconcile_at?.getTime()).toBeGreaterThan(before.getTime());
        }
        expect(await deliveryCounts()).toEqual({ orders: "0", assets: "0", bundles: "0" });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("respects the submitted grace delay before the first read", async () => {
    const run = await seedCanaryRun("SUBMITTED", { submittedAgeSeconds: 5 });
    const provider = makeProvider({ providerKey: run.supplierId });
    const result = await dispatchRecovery(createSupplierProviderRegistry([provider.provider]));

    expect(result).toHaveProperty("supplierCanary.claimed", 0);
    expect(provider.queryInputs).toHaveLength(0);
    expect(provider.createCalls).toBe(0);
    expect((await canaryRun(run.runId)).status).toBe("SUBMITTED");
  });
  it("honors next_reconcile_at for PENDING and UNKNOWN rows", async () => {
    const pending = await seedCanaryRun("PENDING", { nextReconcileInSeconds: 30 });
    const unknown = await seedCanaryRun("UNKNOWN", { nextReconcileInSeconds: 30 });
    const providers = [pending, unknown].map((run) =>
      makeProvider({ providerKey: run.supplierId }),
    );
    const registry = createSupplierProviderRegistry(providers.map((provider) => provider.provider));
    const before = new Date();

    const result = await dispatchRecovery(registry, before);

    expect(result).toHaveProperty("supplierCanary", {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      backlog: 2,
      oldestAgeSeconds: expect.any(Number),
    });
    expect(providers.flatMap((provider) => provider.queryInputs)).toHaveLength(0);
    expect(providers.every((provider) => provider.createCalls === 0)).toBe(true);
    for (const [run, expectedStatus] of [
      [pending, "PENDING"],
      [unknown, "UNKNOWN"],
    ] as const) {
      const row = await canaryRun(run.runId);
      expect(row.status).toBe(expectedStatus);
      expect(row.last_queried_at?.getTime()).toBeLessThan(before.getTime());
      expect(row.next_reconcile_at?.getTime()).toBeGreaterThan(before.getTime());
    }
  });

  it("limits each recovery batch to its configured claim size", async () => {
    const runs = [
      await seedCanaryRun("UNKNOWN"),
      await seedCanaryRun("UNKNOWN"),
      await seedCanaryRun("UNKNOWN"),
    ];
    const providers = runs.map((run) => makeProvider({ providerKey: run.supplierId }));
    const registry = createSupplierProviderRegistry(providers.map((provider) => provider.provider));

    const result = await dispatchRecovery(registry, new Date(), 1);

    expect(result).toHaveProperty("supplierCanary", {
      claimed: 1,
      succeeded: 1,
      failed: 0,
      backlog: 3,
      oldestAgeSeconds: expect.any(Number),
    });
    expect(providers.flatMap((provider) => provider.queryInputs)).toHaveLength(1);
    expect(providers.every((provider) => provider.createCalls === 0)).toBe(true);
    const rows = await Promise.all(runs.map((run) => canaryRun(run.runId)));
    expect(rows.filter((row) => row.status === "PENDING")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "UNKNOWN")).toHaveLength(2);
  });

  it("claims one canary once across concurrent worker cycles", async () => {
    const run = await seedCanaryRun("UNKNOWN");
    const provider = makeProvider({ providerKey: run.supplierId });
    const registry = createSupplierProviderRegistry([provider.provider]);

    const cycles = await Promise.all([dispatchRecovery(registry), dispatchRecovery(registry)]);

    expect(cycles.reduce((total, cycle) => total + (cycle.supplierCanary?.claimed ?? 0), 0)).toBe(
      1,
    );
    expect(provider.queryInputs).toHaveLength(1);
    expect(provider.createCalls).toBe(0);
    expect((await canaryRun(run.runId)).status).toBe("PENDING");
  });

  it("keeps provider-unavailable rows nonterminal and schedules another read", async () => {
    const run = await seedCanaryRun("UNKNOWN");
    const before = new Date();
    const result = await dispatchRecovery(createSupplierProviderRegistry([]), before);
    const row = await canaryRun(run.runId);

    expect(result).toHaveProperty("supplierCanary", {
      claimed: 1,
      succeeded: 0,
      failed: 1,
      backlog: 1,
      oldestAgeSeconds: expect.any(Number),
    });
    expect(row).toMatchObject({
      status: "UNKNOWN",
      last_error_code: "PROVIDER_UNAVAILABLE",
      retry_after_seconds: 60,
    });
    expect(row.next_reconcile_at?.getTime()).toBeGreaterThan(before.getTime());
    expect(row.needs_review_at).toBeNull();
  });

  it("schedules temporary query failures without terminalizing the attempt", async () => {
    const run = await seedCanaryRun("UNKNOWN");
    const before = new Date();
    const provider = makeProvider({
      providerKey: run.supplierId,
      queryError: new SupplierPortError("TIMEOUT", "temporary supplier timeout"),
    });
    const result = await dispatchRecovery(
      createSupplierProviderRegistry([provider.provider]),
      before,
    );
    const row = await canaryRun(run.runId);

    expect(result).toHaveProperty("supplierCanary", {
      claimed: 1,
      succeeded: 0,
      failed: 1,
      backlog: 1,
      oldestAgeSeconds: expect.any(Number),
    });
    expect(row).toMatchObject({
      status: "UNKNOWN",
      last_error_code: "SUPPLIER_QUERY_FAILED",
      retry_after_seconds: 60,
    });
    expect(row.last_queried_at).toBeInstanceOf(Date);
    expect(row.next_reconcile_at?.getTime()).toBeGreaterThan(before.getTime());
    expect(provider.createCalls).toBe(0);
  });

  it("marks providers without ORDER_READ for review without querying or posting", async () => {
    const run = await seedCanaryRun("UNKNOWN");
    const provider = makeProvider({ providerKey: run.supplierId, capabilities: ["ORDER_CREATE"] });
    const result = await dispatchRecovery(createSupplierProviderRegistry([provider.provider]));
    const row = await canaryRun(run.runId);

    expect(result).toHaveProperty("supplierCanary.failed", 1);
    expect(row).toMatchObject({
      status: "BLOCKED",
      last_error_code: "ORDER_READ_UNSUPPORTED",
      retry_after_seconds: null,
      next_reconcile_at: null,
    });
    expect(row.needs_review_at).toBeInstanceOf(Date);
    expect(provider.queryInputs).toHaveLength(0);
    expect(provider.createCalls).toBe(0);
  });

  it("blocks undocumented delivery and creates no asset or customer delivery", async () => {
    const run = await seedCanaryRun("UNKNOWN");
    const provider = makeProvider({
      providerKey: run.supplierId,
      queryError: new SupplierPortError("DELIVERY_UNSUPPORTED", "untyped delivery"),
    });
    const result = await dispatchRecovery(createSupplierProviderRegistry([provider.provider]));
    const row = await canaryRun(run.runId);

    expect(result).toHaveProperty("supplierCanary.failed", 1);
    expect(row).toMatchObject({
      status: "BLOCKED",
      last_error_code: "DELIVERY_UNSUPPORTED",
      retry_after_seconds: null,
      next_reconcile_at: null,
    });
    expect(row.last_queried_at).toBeInstanceOf(Date);
    expect(row.needs_review_at).toBeInstanceOf(Date);
    expect(provider.queryInputs).toHaveLength(1);
    expect(provider.createCalls).toBe(0);
    expect(await deliveryCounts()).toEqual({ orders: "0", assets: "0", bundles: "0" });
  });

  it.each([
    { upstream: "FULFILLED", expected: "FULFILLED" },
    { upstream: "REJECTED", expected: "REJECTED" },
    { upstream: "CANCELLED", expected: "REJECTED" },
    { upstream: "REFUNDED", expected: "REJECTED" },
  ] as const)(
    "clears recovery scheduling after terminal $upstream",
    async ({ upstream, expected }) => {
      const run = await seedCanaryRun("UNKNOWN");
      const provider = makeProvider({
        providerKey: run.supplierId,
        queryResult: (_query, call) =>
          upstream === "FULFILLED"
            ? {
                status: "FULFILLED",
                externalOrderId: `terminal-${call}`,
                assetEnvelope: {
                  deliveryType: "CREDENTIAL",
                  expectedSku: "RECOVERY-SKU",
                  region: "VN",
                  durationCode: "P1M",
                  expiresAt: null,
                  supplierAssetId: `asset-${call}`,
                  fingerprint: `fingerprint-${call}`,
                  vaultRef: `vault:asset-${call}`,
                },
              }
            : { status: upstream, externalOrderId: `terminal-${call}` },
      });

      const result = await dispatchRecovery(createSupplierProviderRegistry([provider.provider]));
      const row = await canaryRun(run.runId);

      expect(result).toHaveProperty("supplierCanary.succeeded", 1);
      expect(row).toMatchObject({
        status: expected,
        retry_after_seconds: null,
        next_reconcile_at: null,
      });
      expect(provider.queryInputs).toHaveLength(1);
      expect(provider.createCalls).toBe(0);
      expect(await deliveryCounts()).toEqual({ orders: "0", assets: "0", bundles: "0" });
    },
  );

  it("runs the real recovery dispatcher from the scheduler's recovery lane", async () => {
    const run = await seedCanaryRun("SUBMITTED");
    const provider = makeProvider({ providerKey: run.supplierId });
    const registry = createSupplierProviderRegistry([provider.provider]);
    const intervals: number[] = [];
    let resolveCycle!: (result: RecoveryCycleResult) => void;
    let rejectCycle!: (error: unknown) => void;
    const cycle = new Promise<RecoveryCycleResult>((resolve, reject) => {
      resolveCycle = resolve;
      rejectCycle = reject;
    });
    const scheduler = createWorkerScheduler({
      lanes: {
        recovery: async () => {
          try {
            resolveCycle(await dispatchRecovery(registry));
          } catch (error) {
            rejectCycle(error);
          }
        },
      },
      pollIntervalMs: 1_000,
      recoveryIntervalMs: 60_000,
      logger: { info: vi.fn(), error: vi.fn() },
      setInterval: (_handler, timeout) => {
        intervals.push(timeout);
        return {} as WorkerSchedulerTimer;
      },
      clearInterval: () => undefined,
    });

    scheduler.start();
    try {
      const result = await cycle;
      expect(intervals).toEqual([60_000]);
      expect(result).toHaveProperty("supplierCanary.claimed", 1);
      expect(provider.queryInputs).toHaveLength(1);
      expect(provider.createCalls).toBe(0);
      expect((await canaryRun(run.runId)).status).toBe("PENDING");
    } finally {
      await scheduler.stop();
    }
  });
});
