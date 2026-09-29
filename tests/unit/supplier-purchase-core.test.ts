import { describe, expect, it, vi } from "vitest";
import {
  SUPPLIER_SUBMITTED_GRACE_SECONDS,
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
        submittedAt: null,
        attemptCount: 0,
        costVndSnapshot: input.costCeilingVnd,
        version: 1,
      };
      rows.set(record.id, record);
      byKey.set(key, record.id);
      return { inserted: true, record };
    },
    async markAttempt(id, input) {
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
        submittedAt: new Date(),
        costVndSnapshot: input.costCeilingVnd,
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
    const immediateRetry = await recoverSupplierPurchase({
      store,
      recordId: row.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port,
    });
    expect(immediateRetry).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect(queries).toBe(0);

    row.submittedAt = new Date(Date.now() - (SUPPLIER_SUBMITTED_GRACE_SECONDS + 1) * 1_000);
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
    row.submittedAt = new Date(Date.now() - (SUPPLIER_SUBMITTED_GRACE_SECONDS + 1) * 1_000);

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

  it("persists the winning preflight cost when concurrent callers race to claim", async () => {
    const store = makeStore();
    let creates = 0;
    let postedCost: number | undefined;
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
      createOrder: async ({ costCeilingVnd }) => {
        creates += 1;
        postedCost = costCeilingVnd;
        return { kind: "ACCEPTED", externalOrderId: "ext-concurrent", status: "PENDING" };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "REJECTED", externalOrderId: "never-created" };
      },
    });
    const beforeCreate = async (pause: boolean, costCeilingVnd: number) => {
      if (pause) {
        preflightStarted();
        await preflightGate;
      }
      return { ok: true as const, costCeilingVnd };
    };

    const first = executeSupplierPurchase(
      input(store, { port, beforeCreate: () => beforeCreate(true, 24000) }),
    );
    await started;
    const winner = await executeSupplierPurchase(
      input(store, { port, beforeCreate: () => beforeCreate(false, 23000) }),
    );
    releasePreflight();
    const loser = await first;

    expect(winner).toMatchObject({ kind: "ACCEPTED", externalOrderId: "ext-concurrent" });
    expect(loser).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect([...store.rows.values()]).toHaveLength(1);
    expect([...store.rows.values()][0]).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      externalOrderId: "ext-concurrent",
      costVndSnapshot: 23000,
    });
    expect({ creates, queries, postedCost }).toEqual({
      creates: 1,
      queries: 0,
      postedCost: 23000,
    });
  });
  it("does not query a fresh attempted SUBMITTED record during the post-claim grace", async () => {
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
    seeded.record.submittedAt = new Date();
    let queries = 0;
    const result = await recoverSupplierPurchase({
      store,
      recordId: seeded.record.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port: makePort({
        queryOrder: async () => {
          queries += 1;
          return { status: "REJECTED", externalOrderId: "must-not-query" };
        },
      }),
    });

    expect(result).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect(queries).toBe(0);
  });
  it("queries at the exact post-claim grace boundary", async () => {
    const now = new Date("2026-09-27T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
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
      seeded.record.status = "SUBMITTED";
      seeded.record.submittedAt = new Date(
        now.getTime() - SUPPLIER_SUBMITTED_GRACE_SECONDS * 1_000,
      );
      let queries = 0;

      const result = await recoverSupplierPurchase({
        store,
        recordId: seeded.record.id,
        queryKey: "canary-1",
        expectedSku: "SKU-1",
        port: makePort({
          queryOrder: async () => {
            queries += 1;
            return { status: "PENDING", externalOrderId: "grace-boundary-order" };
          },
        }),
      });

      expect(result).toMatchObject({
        kind: "UNKNOWN",
        queryKey: "grace-boundary-order",
        record: { status: "PENDING", externalOrderId: "grace-boundary-order" },
      });
      expect(queries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed without querying an attempted SUBMITTED record with no timestamp", async () => {
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
    seeded.record.submittedAt = null;
    let queries = 0;
    const result = await recoverSupplierPurchase({
      store,
      recordId: seeded.record.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port: makePort({
        queryOrder: async () => {
          queries += 1;
          return { status: "REJECTED", externalOrderId: "must-not-query" };
        },
      }),
    });

    expect(result).toMatchObject({
      kind: "BLOCKED",
      code: "SUPPLIER_ORDER_NOT_QUERYABLE",
    });
    expect(queries).toBe(0);
    expect(store.reviewCodes).toEqual(["SUPPLIER_ORDER_NOT_QUERYABLE"]);
  });

  it("does not query a SUBMITTED/0 create intent during recovery", async () => {
    const store = makeStore();
    const seeded = await store.insertIntent({
      supplierId: "supplier-1",
      supplierSkuId: "sku-1",
      requestReference: "run-1",
      idempotencyKey: "canary-1",
      requestFingerprint: "fingerprint",
      costCeilingVnd: 23000,
    });
    let queries = 0;
    const result = await recoverSupplierPurchase({
      store,
      recordId: seeded.record.id,
      queryKey: "canary-1",
      expectedSku: "SKU-1",
      port: makePort({
        queryOrder: async () => {
          queries += 1;
          return { status: "REJECTED", externalOrderId: "must-not-query" };
        },
      }),
    });

    expect(result).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect(queries).toBe(0);
  });

  it("returns the latest terminal state when the create claim CAS loses", async () => {
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
    store.markAttempt = async () => {
      seeded.record.status = "REJECTED";
      return false;
    };

    const result = await executeSupplierPurchase(input(store));

    expect(result).toMatchObject({ kind: "REJECTED", record: { status: "REJECTED" } });
  });
  it("fails closed when the create claim loses to a non-queryable supplier state", async () => {
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
    store.markAttempt = async () => {
      seeded.record.status = "CANCELLED";
      return false;
    };

    const result = await executeSupplierPurchase(input(store));

    expect(result).toMatchObject({
      kind: "BLOCKED",
      code: "SUPPLIER_ORDER_NOT_ELIGIBLE",
      record: { status: "CANCELLED" },
    });
  });

  it("returns the durable query key when the create claim CAS loses to a queryable state", async () => {
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
    store.markAttempt = async () => {
      seeded.record.status = "UNKNOWN";
      seeded.record.queryKey = "provider-query-key";
      return false;
    };

    const result = await executeSupplierPurchase(input(store));

    expect(result).toMatchObject({
      kind: "UNKNOWN",
      queryKey: "provider-query-key",
      record: { status: "UNKNOWN", queryKey: "provider-query-key" },
    });
  });

  it("returns the duplicate as pending while the first POST is in flight and ingests fulfillment once", async () => {
    const store = makeStore();
    let createStarted!: () => void;
    let releaseCreate!: () => void;
    const firstPost = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let queries = 0;
    let ingested = 0;
    const port = makePort({
      createOrder: async () => {
        createStarted();
        await release;
        return { kind: "FULFILLED", externalOrderId: "ext-in-flight", assetEnvelope: envelope };
      },
      queryOrder: async () => {
        queries += 1;
        return { status: "REJECTED", externalOrderId: "must-not-query" };
      },
    });
    const first = executeSupplierPurchase(
      input(store, { port, onFulfilled: async () => void (ingested += 1) }),
    );
    await firstPost;

    const duplicate = await executeSupplierPurchase(
      input(store, { port, onFulfilled: async () => void (ingested += 1) }),
    );
    expect(duplicate).toMatchObject({ kind: "UNKNOWN", queryKey: "canary-1" });
    expect(queries).toBe(0);

    releaseCreate();
    expect(await first).toMatchObject({ kind: "FULFILLED", externalOrderId: "ext-in-flight" });
    expect(ingested).toBe(1);
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
    seeded.record.submittedAt = new Date(Date.now() - 120_000);
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
    store.markAttempt = async (id, input) => {
      const claimed = await markAttempt(id, input);
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
    seeded.record.submittedAt = new Date(
      Date.now() - (SUPPLIER_SUBMITTED_GRACE_SECONDS + 1) * 1_000,
    );

    const resumed = await executeSupplierPurchase(input(store, { purchaseEnabled: false, port }));
    expect(resumed).toMatchObject({ kind: "UNKNOWN", queryKey: "ext-crash-1" });
    expect({ creates, queries }).toEqual({ creates: 0, queries: 1 });
  });
  it("recovers an accepted create after response persistence fails without creating again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
    try {
      const store = makeStore();
      const markResponse = store.markResponse.bind(store);
      let failResponsePersistence = true;
      store.markResponse = async (id, fingerprint) => {
        if (failResponsePersistence) {
          failResponsePersistence = false;
          throw new Error("simulated response persistence failure");
        }
        await markResponse(id, fingerprint);
      };
      let creates = 0;
      let queries = 0;
      const port = makePort({
        createOrder: async () => {
          creates += 1;
          return { kind: "ACCEPTED", externalOrderId: "ext-post-crash", status: "PENDING" };
        },
        queryOrder: async ({ queryKey, externalOrderId, expectedSku }) => {
          queries += 1;
          expect({ queryKey, externalOrderId, expectedSku }).toEqual({
            queryKey: "canary-1",
            externalOrderId: undefined,
            expectedSku: "SKU-1",
          });
          return {
            status: "FULFILLED",
            externalOrderId: "ext-post-crash",
            assetEnvelope: envelope,
          };
        },
      });

      await expect(executeSupplierPurchase(input(store, { port }))).rejects.toThrow(
        "simulated response persistence failure",
      );
      const row = [...store.rows.values()][0]!;
      expect(row).toMatchObject({
        status: "SUBMITTED",
        attemptCount: 1,
        queryKey: "canary-1",
        externalOrderId: null,
        submittedAt: new Date("2026-09-27T00:00:00.000Z"),
      });

      row.submittedAt = new Date("2026-09-26T23:58:00.000Z");
      const recovered = await recoverSupplierPurchase({
        store,
        recordId: row.id,
        queryKey: "canary-1",
        expectedSku: "SKU-1",
        port,
      });

      expect(recovered).toMatchObject({
        kind: "FULFILLED",
        externalOrderId: "ext-post-crash",
        record: {
          status: "FULFILLED",
          externalOrderId: "ext-post-crash",
        },
      });
      expect(store.rows.get(row.id)).toMatchObject({
        status: "FULFILLED",
        externalOrderId: "ext-post-crash",
        responseFingerprint: expect.any(String),
      });
      expect({ creates, queries }).toEqual({ creates: 1, queries: 1 });
    } finally {
      vi.useRealTimers();
    }
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
