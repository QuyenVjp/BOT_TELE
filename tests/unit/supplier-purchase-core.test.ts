import { describe, expect, it } from "vitest";
import {
  executeSupplierPurchase,
  recoverSupplierPurchase,
  type SupplierPurchaseRecord,
  type SupplierPurchaseRecordStore,
} from "../../src/modules/supplier/purchase-core.js";
import { SupplierPortError, type SupplierPort } from "../../src/modules/supplier/port.js";

const envelope = {
  deliveryType: "CREDENTIAL" as const,
  expectedSku: "SKU-1",
  region: "VN",
  durationCode: "P1M",
  expiresAt: null,
  supplierAssetId: "asset-1",
  fingerprint: "fp-asset-1",
  vaultRef: "vault:asset-1",
};

function makePort(overrides: Partial<SupplierPort> = {}): SupplierPort {
  return {
    getAvailability: async () => ({ status: "AVAILABLE", observedAt: new Date().toISOString() }),
    createOrder: async () => ({
      kind: "FULFILLED",
      externalOrderId: "ext-1",
      assetEnvelope: envelope,
    }),
    queryOrder: async () => ({ status: "PENDING", externalOrderId: "ext-1" }),
    cancelOrder: async () => ({ status: "UNSUPPORTED" }),
    requestRefund: async () => ({ status: "UNSUPPORTED" }),
    reconcile: async () => ({ observations: [], nextCursor: null }),
    ...overrides,
  };
}

function makeStore(): SupplierPurchaseRecordStore & {
  rows: Map<string, SupplierPurchaseRecord>;
  reviewCodes: string[];
} {
  const rows = new Map<string, SupplierPurchaseRecord>();
  const reviewCodes: string[] = [];
  const byKey = new Map<string, string>();
  let next = 0;
  const claimed = new Set<string>();
  const patch = async (id: string, values: Partial<SupplierPurchaseRecord>) => {
    const current = rows.get(id);
    if (!current) throw new Error(`missing row ${id}`);
    Object.assign(current, values, { version: current.version + 1 });
  };
  return {
    rows,
    reviewCodes,
    async findByIdempotency(input) {
      const id = byKey.get(`${input.supplierId}:${input.idempotencyKey}`);
      return id ? (rows.get(id) ?? null) : null;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async insertIntent(input) {
      const key = `${input.supplierId}:${input.idempotencyKey}`;
      const existingId = byKey.get(key);
      if (existingId) return { inserted: false, record: rows.get(existingId)! };
      const record: SupplierPurchaseRecord = {
        id: `run-${++next}`,
        supplierId: input.supplierId,
        supplierSkuId: input.supplierSkuId,
        requestReference: input.requestReference,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        status: "SUBMITTED",
        externalOrderId: null,
        attemptCount: 0,
        costVndSnapshot: input.costCeilingVnd,
        version: 1,
      };
      rows.set(record.id, record);
      byKey.set(key, record.id);
      return { inserted: true, record };
    },
    async refreshIntent(id, input) {
      await patch(id, {
        ...(input.costCeilingVnd === undefined ? {} : { costVndSnapshot: input.costCeilingVnd }),
      });
    },
    async markAttempt(id) {
      const record = rows.get(id);
      if (
        claimed.has(id) ||
        !record ||
        (record.status !== "AUTHORIZED" && record.status !== "SUBMITTED") ||
        record.attemptCount !== 0
      ) {
        return false;
      }
      claimed.add(id);
      await patch(id, {
        status: "SUBMITTED",
        attemptCount: 1,
        queryKey: record.idempotencyKey,
      });
      return true;
    },
    async markTransportFailure(id) {
      await patch(id, {});
    },
    async markResponse(id, fingerprint) {
      await patch(id, { responseFingerprint: fingerprint });
    },
    async markUnknown(id, input) {
      await patch(id, { status: "UNKNOWN", queryKey: input.queryKey });
    },
    async markPending(id, externalOrderId) {
      await patch(id, { status: "PENDING", externalOrderId, queryKey: null });
    },
    async markFulfilled(id, externalOrderId) {
      const current = rows.get(id);
      if (current && ["AUTHORIZED", "SUBMITTED", "PENDING", "UNKNOWN"].includes(current.status)) {
        await patch(id, { status: "FULFILLED", externalOrderId });
      }
    },
    async markRejected(id) {
      const current = rows.get(id);
      if (current && current.status !== "FULFILLED" && current.status !== "REJECTED") {
        await patch(id, { status: "REJECTED" });
      }
    },
    async markNeedsReview(_id, code) {
      reviewCodes.push(code);
      await patch(_id, {});
    },
    async markBlocked(id, code) {
      const current = rows.get(id);
      if (
        current &&
        ["AUTHORIZED", "SUBMITTED"].includes(current.status) &&
        current.attemptCount === 0
      ) {
        await patch(id, { status: "REJECTED", blockCode: code });
      }
    },
  };
}

const input = (store: SupplierPurchaseRecordStore, overrides: Record<string, unknown> = {}) => ({
  supplierId: "supplier-1",
  supplierSkuId: "sku-1",
  requestReference: "run-1",
  externalSku: "SKU-1",
  costCeilingVnd: 23000,
  idempotencyKey: "canary-1",
  correlationId: "corr-1",
  region: "VN",
  port: makePort(),
  store,
  purchaseEnabled: true,
  ...overrides,
});

describe("durable supplier purchase core", () => {
  it("blocks before insert and upstream I/O when the gate is off", async () => {
    const store = makeStore();
    let creates = 0;
    const result = await executeSupplierPurchase(
      input(store, {
        purchaseEnabled: false,
        port: makePort({
          createOrder: async () => {
            creates += 1;
            return { kind: "REJECTED", code: "unexpected", retryable: false };
          },
        }),
      }),
    );
    expect(result).toMatchObject({ kind: "BLOCKED", code: "PURCHASE_DISABLED" });
    expect(creates).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("does not POST when the last pre-submit safety check rejects a cost change", async () => {
    const store = makeStore();
    let creates = 0;
    const result = await executeSupplierPurchase(
      input(store, {
        port: makePort({
          createOrder: async () => {
            creates += 1;
            return { kind: "REJECTED", code: "unexpected", retryable: false };
          },
        }),
        beforeCreate: async () => ({ ok: false as const, code: "CANARY_COST_CHANGED" }),
      }),
    );
    expect(result).toMatchObject({ kind: "BLOCKED", code: "CANARY_COST_CHANGED" });
    expect(creates).toBe(0);
    expect([...store.rows.values()][0]?.status).toBe("REJECTED");
  });

  it("maps a transport timeout to UNKNOWN and recovery queries without creating again", async () => {
    const store = makeStore();
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        throw new SupplierPortError("TRANSPORT_TIMEOUT", "timeout");
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "FULFILLED", externalOrderId: "ext-1", assetEnvelope: envelope };
      },
    });
    const first = await executeSupplierPurchase(input(store, { port }));
    expect(first).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    const row = [...store.rows.values()][0]!;
    const recovered = await recoverSupplierPurchase({
      store,
      recordId: row.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port,
    });
    expect(recovered).toMatchObject({ kind: "FULFILLED", externalOrderId: "ext-1" });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 1 });
  });

  it("parks a mismatched provider identity for review without retrying or ingesting", async () => {
    const store = makeStore();
    let creates = 0;
    let queries = 0;
    let ingested = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        throw new SupplierPortError("TRANSPORT_TIMEOUT", "timeout");
      },
      queryOrder: async ({ expectedSku }) => {
        queries += 1;
        expect(expectedSku).toBe("SKU-1");
        throw new SupplierPortError("IDENTITY_MISMATCH", "QCST order identity mismatch");
      },
    });

    const first = await executeSupplierPurchase(input(store, { port }));
    const row = [...store.rows.values()][0]!;
    expect(first).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });

    const recovered = await recoverSupplierPurchase({
      store,
      recordId: row.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port,
      onFulfilled: async () => {
        ingested += 1;
      },
    });

    expect(recovered).toMatchObject({ kind: "BLOCKED", code: "IDENTITY_MISMATCH" });
    expect(store.reviewCodes).toEqual(["IDENTITY_MISMATCH"]);
    expect(store.rows.get(row.id)).toMatchObject({ status: "UNKNOWN" });
    expect({ creates, queries, ingested }).toEqual({ creates: 1, queries: 1, ingested: 0 });
  });

  it("claims an unattempted SUBMITTED intent instead of querying it", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "ACCEPTED", externalOrderId: "ext-first-post", status: "PENDING" };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "REJECTED", externalOrderId: "never-created" };
      },
    });

    const result = await executeSupplierPurchase(input(store, { port }));

    expect(result).toMatchObject({ kind: "ACCEPTED", externalOrderId: "ext-first-post" });
    expect(store.rows.get(seeded.record.id)).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      externalOrderId: "ext-first-post",
    });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });
  });

  it("lets one concurrent caller claim an unattempted SUBMITTED intent", async () => {
    const store = makeStore();
    let creates = 0;
    let queries = 0;
    let preflightStarted!: () => void;
    let releasePreflight!: () => void;
    const started = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "ACCEPTED", externalOrderId: "ext-concurrent", status: "PENDING" };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "REJECTED", externalOrderId: "never-created" };
      },
    });
    const beforeCreate = async (pause: boolean) => {
      if (pause) {
        preflightStarted();
        await preflightGate;
      }
      return { ok: true as const, costCeilingVnd: 23000 };
    };

    const first = executeSupplierPurchase(
      input(store, { port, beforeCreate: () => beforeCreate(true) }),
    );
    await started;
    const winner = await executeSupplierPurchase(
      input(store, { port, beforeCreate: () => beforeCreate(false) }),
    );
    releasePreflight();
    const loser = await first;

    expect(winner).toMatchObject({ kind: "ACCEPTED", externalOrderId: "ext-concurrent" });
    expect(loser).toMatchObject({ kind: "UNKNOWN", queryKey: "ext-concurrent" });
    expect([...store.rows.values()]).toHaveLength(1);
    expect([...store.rows.values()][0]).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      externalOrderId: "ext-concurrent",
    });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });
  });
  it("does not block a submitted intent after another caller claims it", async () => {
    const store = makeStore();
    let preflightStarted!: () => void;
    let releasePreflight!: () => void;
    let createStarted!: () => void;
    let releaseCreate!: () => void;
    const preflight = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const create = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        createStarted();
        await createGate;
        return { kind: "FULFILLED", externalOrderId: "ext-race", assetEnvelope: envelope };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "REJECTED", externalOrderId: "never-created" };
      },
    });
    const stale = executeSupplierPurchase(
      input(store, {
        port,
        beforeCreate: async () => {
          preflightStarted();
          await preflightGate;
          return { ok: false as const, code: "SUPPLIER_UNAVAILABLE" };
        },
      }),
    );
    await preflight;
    const active = executeSupplierPurchase(
      input(store, { port, beforeCreate: async () => ({ ok: true, costCeilingVnd: 23000 }) }),
    );
    await create;
    releasePreflight();
    const staleResult = await stale;
    expect(staleResult).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect([...store.rows.values()][0]).toMatchObject({ status: "SUBMITTED", attemptCount: 1 });
    releaseCreate();
    const activeResult = await active;

    expect(activeResult).toMatchObject({ kind: "FULFILLED", externalOrderId: "ext-race" });
    expect([...store.rows.values()][0]).toMatchObject({
      status: "FULFILLED",
      attemptCount: 1,
      externalOrderId: "ext-race",
    });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });
  });

  it("recovers a SUBMITTED record by stable query key even with spending disabled", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    seeded.record.attemptCount = 1;
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "REJECTED", code: "unexpected", retryable: false };
      },
      queryOrder: async ({ queryKey, externalOrderId, expectedSku }) => {
        queries += 1;
        expect({ queryKey, externalOrderId, expectedSku }).toEqual({
          queryKey: "canary-1",
          externalOrderId: undefined,
          expectedSku: "SKU-1",
        });
        return { status: "PENDING", externalOrderId: "ext-submitted-1" };
      },
    });

    const result = await executeSupplierPurchase(input(store, { purchaseEnabled: false, port }));

    expect(result).toMatchObject({ kind: "UNKNOWN", queryKey: "ext-submitted-1" });
    expect(store.rows.get(seeded.record.id)).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      externalOrderId: "ext-submitted-1",
    });
    expect({ creates, queries }).toEqual({ creates: 0, queries: 1 });
  });

  it("does not POST after a crash leaves the durable record SUBMITTED", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    seeded.record.status = "AUTHORIZED";
    const markAttempt = store.markAttempt.bind(store);
    store.markAttempt = async (id) => {
      const claimed = await markAttempt(id);
      if (claimed) throw new Error("simulated crash after durable claim");
      return claimed;
    };
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "REJECTED", code: "unexpected", retryable: false };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "PENDING", externalOrderId: "ext-crash-1" };
      },
    });

    await expect(executeSupplierPurchase(input(store, { port }))).rejects.toThrow(
      "simulated crash after durable claim",
    );
    expect(creates).toBe(0);
    expect(store.rows.get(seeded.record.id)).toMatchObject({
      status: "SUBMITTED",
      queryKey: "canary-1",
    });

    const resumed = await executeSupplierPurchase(input(store, { purchaseEnabled: false, port }));
    expect(resumed).toMatchObject({ kind: "UNKNOWN", queryKey: "ext-crash-1" });
    expect({ creates, queries }).toEqual({ creates: 0, queries: 1 });
  });

  it("blocks a concurrent idempotency-key claim for another supplier SKU", async () => {
    const store = makeStore();
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "ACCEPTED", externalOrderId: "ext-claim-1", status: "PENDING" };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "PENDING", externalOrderId: "ext-claim-1" };
      },
    });

    const [purchase, conflict] = await Promise.all([
      executeSupplierPurchase(input(store, { port })),
      executeSupplierPurchase(input(store, { supplierSkuId: "sku-2", port })),
    ]);

    expect(purchase.kind).toBe("ACCEPTED");
    expect(conflict).toMatchObject({
      kind: "BLOCKED",
      code: "SUPPLIER_ORDER_NOT_ELIGIBLE",
    });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 0 });
  });

  it("returns the durable fulfillment when a create rejection loses the race", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    seeded.record.status = "AUTHORIZED";
    const port = makePort({
      createOrder: async () => {
        seeded.record.status = "FULFILLED";
        return { kind: "REJECTED", code: "OUT_OF_STOCK", retryable: false };
      },
    });

    const result = await executeSupplierPurchase(input(store, { port }));

    expect(result).toMatchObject({ kind: "REPLAY", record: { status: "FULFILLED" } });
  });

  it("claims an authorized canary exactly once under concurrent execution", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    seeded.record.status = "AUTHORIZED";
    let creates = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        await Promise.resolve();
        return { kind: "ACCEPTED", externalOrderId: "ext-1", status: "PENDING" };
      },
    });
    const [first, second] = await Promise.all([
      executeSupplierPurchase(input(store, { port })),
      executeSupplierPurchase(input(store, { port })),
    ]);
    expect(creates).toBe(1);
    expect(new Set([first.kind, second.kind])).toEqual(new Set(["ACCEPTED", "UNKNOWN"]));
  });
});
