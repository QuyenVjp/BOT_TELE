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

function makeStore(): SupplierPurchaseRecordStore & { rows: Map<string, SupplierPurchaseRecord> } {
  const rows = new Map<string, SupplierPurchaseRecord>();
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
      if (claimed.has(id)) return false;
      claimed.add(id);
      const record = rows.get(id);
      await patch(id, { status: "SUBMITTED", queryKey: record?.idempotencyKey ?? null });
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
      await patch(id, { status: "FULFILLED", externalOrderId });
    },
    async markRejected(id) {
      await patch(id, { status: "REJECTED" });
    },
    async markNeedsReview(id) {
      await patch(id, {});
    },
    async markBlocked(id, code) {
      await patch(id, { status: "REJECTED", blockCode: code });
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
      port,
    });
    expect(recovered).toMatchObject({ kind: "FULFILLED", externalOrderId: "ext-1" });
    expect({ creates, queries }).toEqual({ creates: 1, queries: 1 });
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
    let creates = 0;
    let queries = 0;
    const port = makePort({
      createOrder: async () => {
        creates += 1;
        return { kind: "REJECTED", code: "unexpected", retryable: false };
      },
      queryOrder: async ({ queryKey, externalOrderId }) => {
        queries += 1;
        expect({ queryKey, externalOrderId }).toEqual({
          queryKey: "canary-1",
          externalOrderId: undefined,
        });
        return { status: "PENDING", externalOrderId: "ext-submitted-1" };
      },
    });

    const result = await executeSupplierPurchase(input(store, { purchaseEnabled: false, port }));

    expect(result).toMatchObject({ kind: "UNKNOWN", queryKey: "ext-submitted-1" });
    expect(store.rows.get(seeded.record.id)).toMatchObject({
      status: "PENDING",
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
