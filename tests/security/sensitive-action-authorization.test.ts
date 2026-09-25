import { describe, expect, it } from "vitest";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  authorizeSensitiveAdminAction,
  isStepUpActionCategory,
  isSensitiveActionKey,
  SENSITIVE_ACTION_POLICY,
  type SensitiveActionKey,
} from "../../src/modules/identity/sensitive-action.js";

/**
 * T195 — the central sensitive-action authorization layer (THREAT_MODEL SEC-002).
 *
 * These assertions run without Docker: the policy table is pure, and the identity
 * / dev-posture paths are driven through a stub handle. The durable step-up
 * behaviour (grant consumption, concurrency, rollback) lives in the integration
 * suite against real PostgreSQL.
 */

const ADMIN_ID = 123456789;
const ROOT_CONFIG = { adminTelegramUserId: ADMIN_ID, expectedUsername: "Quyenvjp" };

/** Collect the bound values of a Kysely operation node, in statement order. */
function collectValues(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node !== "object" || node === null) return out;
  if (Array.isArray(node)) {
    for (const entry of node) collectValues(entry, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record["kind"] === "ValueNode") out.push(record["value"]);
  for (const value of Object.values(record)) collectValues(value, out);
  return out;
}

/**
 * Minimal Kysely handle, mirroring the step-up unit suite: `sql` templates reach
 * the database through `getExecutor().compileQuery/executeQuery`, so answering by
 * bound-parameter shape is enough to drive the layer without a database.
 */
function stubDb(rowsFor: (parameters: readonly unknown[]) => unknown[]): {
  db: Db;
  statements: unknown[][];
  auditRows: unknown[][];
} {
  const statements: unknown[][] = [];
  const auditRows: unknown[][] = [];
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ sql: "", parameters: collectValues(node), query: node }),
    executeQuery: async (compiled: { parameters: unknown[] }) => {
      // `appendAuditEvent` inserts; everything the layer reads is a select.
      const isAuditInsert = compiled.parameters.some((value) => value === "ROOT_ADMIN");
      (isAuditInsert ? auditRows : statements).push(compiled.parameters);
      return { rows: isAuditInsert ? [] : rowsFor(compiled.parameters) };
    },
  };
  const connection = { getExecutor: () => executor };
  const db = {
    getExecutor: () => executor,
    transaction: () => ({ execute: (fn: (trx: unknown) => unknown) => fn(connection) }),
  } as unknown as Db;
  return { db, statements, auditRows };
}

const DEPS = {
  rootConfig: ROOT_CONFIG,
  vault: createInMemoryVault(),
  stepUpOptions: { ttlSeconds: 300, lockoutMinutes: 15, maxAttempts: 5 },
};

describe("sensitive action policy table", () => {
  it("maps every action key and gates only the intended verbs", () => {
    const keys = Object.keys(SENSITIVE_ACTION_POLICY) as SensitiveActionKey[];
    expect(keys.sort()).toEqual(
      [
        "wallet.refund",
        "manual_fulfillment.complete",
        "support.replacement.approve",
        "inventory.ready.release",
        "fulfillment.reconcile",
        "group.publication.disable",
        "discrepancy.resolve",
        "outbox.orphan.dispose",
        "store.open",
        "store.close",
        "store.test",
        "catalog.publish",
        "catalog.evidence.register",
        "catalog.evidence.revoke",
        "catalog.activate",
        "catalog.deactivate",
        "supplier.mapping.select",
        "supplier.mapping.clear",
        "supplier.mapping.verify",
        "supplier.catalog.curate",
        "broadcast.confirm",
        "warranty.refund.approve",
        "warranty.refund.adjust",
        "warranty.replacement.approve",
        "catalog.variant.price.change",
        "catalog.variant.deposit.change",
        "catalog.variant.commercial.change",
        "inventory.stock.adjust",
        "preorder.cancel",
      ].sort(),
    );
    // The money-bearing catalog and stock verbs must be gated: an ungated price, deposit
    // or stock edit is the "admin can move money with one factor" hole this table exists
    // to close.
    expect(SENSITIVE_ACTION_POLICY["catalog.variant.price.change"]).toBe("BULK_PRICE_CHANGE");
    expect(SENSITIVE_ACTION_POLICY["catalog.variant.deposit.change"]).toBe("BULK_PRICE_CHANGE");
    expect(SENSITIVE_ACTION_POLICY["inventory.stock.adjust"]).toBe("STOCK_ADJUSTMENT");

    expect(SENSITIVE_ACTION_POLICY).toEqual({
      "wallet.refund": "REFUND",
      "manual_fulfillment.complete": "REFUND",
      "support.replacement.approve": "REFUND",
      "inventory.ready.release": "STOCK_ADJUSTMENT",
      "fulfillment.reconcile": "DELIVERY_REISSUE",
      "group.publication.disable": "PERMISSION_CHANGE",
      "warranty.refund.approve": "REFUND",
      "warranty.refund.adjust": "REFUND",
      "warranty.replacement.approve": "DELIVERY_REISSUE",
      "discrepancy.resolve": "PAYMENT_OVERRIDE",
      "outbox.orphan.dispose": "PAYMENT_OVERRIDE",
      "store.open": "PERMISSION_CHANGE",
      "store.close": "PERMISSION_CHANGE",
      "store.test": "PERMISSION_CHANGE",
      "catalog.publish": "PERMISSION_CHANGE",
      "catalog.evidence.register": "PERMISSION_CHANGE",
      "catalog.evidence.revoke": "PERMISSION_CHANGE",
      "catalog.activate": "PERMISSION_CHANGE",
      "catalog.deactivate": "PERMISSION_CHANGE",
      "supplier.mapping.select": "SUPPLIER_CONFIG",
      "supplier.mapping.clear": "SUPPLIER_CONFIG",
      "supplier.mapping.verify": "SUPPLIER_CONFIG",
      "supplier.catalog.curate": "SUPPLIER_CONFIG",
      "broadcast.confirm": "BROADCAST",
      "catalog.variant.price.change": "BULK_PRICE_CHANGE",
      "catalog.variant.deposit.change": "BULK_PRICE_CHANGE",
      "catalog.variant.commercial.change": "BULK_PRICE_CHANGE",
      "inventory.stock.adjust": "STOCK_ADJUSTMENT",
      "preorder.cancel": "REFUND",
    });
  });

  it("never claims a category for a verb outside the policy", () => {
    // The read-only and ordinary-operations verbs must not be in the table at all.
    for (const command of ["order.inspect", "discrepancy.list", "inventory.import"]) {
      expect(isSensitiveActionKey(command)).toBe(false);
      expect(Object.hasOwn(SENSITIVE_ACTION_POLICY, command)).toBe(false);
    }
    // The category guard only accepts categories the policy can require.
    expect(isStepUpActionCategory("REFUND")).toBe(true);
    expect(isStepUpActionCategory("BROADCAST")).toBe(true);
    expect(isStepUpActionCategory("MONEY_PRINTING")).toBe(false);
    expect(isStepUpActionCategory("")).toBe(false);
  });
});

describe("authorizeSensitiveAdminAction identity and dev posture", () => {
  it("refuses an unauthorised numeric id before any step-up work", async () => {
    const { db, statements, auditRows } = stubDb(() => []);
    const result = await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: true },
      {
        actor: { numericUserId: 987654321, chatType: "private" },
        actionKey: "wallet.refund",
        resourceType: "Order",
        resourceId: "order-1",
        correlationId: "c-1",
        consumeGrant: true,
      },
    );

    expect(result).toEqual({ ok: false, code: "NOT_ROOT_ADMIN" });
    // No grant lookup, no attempt log: identity is decided first.
    expect(statements).toHaveLength(0);
    expect(auditRows).toHaveLength(1);
  });

  it("refuses a non-private context as NOT_ROOT_ADMIN rather than hinting at the id", async () => {
    const { db } = stubDb(() => []);
    const result = await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: true },
      {
        actor: { numericUserId: ADMIN_ID, chatType: "group" },
        actionKey: "wallet.refund",
        resourceType: "Order",
        resourceId: "order-1",
        correlationId: "c-2",
        consumeGrant: true,
      },
    );
    expect(result).toEqual({ ok: false, code: "NOT_ROOT_ADMIN" });
  });

  it("skips the step-up gate in the documented development posture", async () => {
    const { db, statements, auditRows } = stubDb(() => []);
    const result = await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: false },
      {
        actor: { numericUserId: ADMIN_ID, chatType: "private" },
        actionKey: "broadcast.confirm",
        resourceType: "NotificationCampaign",
        resourceId: "campaign-1",
        correlationId: "c-3",
        consumeGrant: true,
      },
    );

    expect(result).toEqual({ ok: true, stepUpConsumed: false });
    // Identity and audit still ran; the grant table was never touched.
    expect(statements).toHaveLength(0);
    expect(auditRows).toHaveLength(1);
  });

  it("keeps supplier curation identity and audit protected when step-up is disabled", async () => {
    const { db, statements, auditRows } = stubDb(() => []);
    const result = await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: false },
      {
        actor: { numericUserId: ADMIN_ID, chatType: "private" },
        actionKey: "supplier.catalog.curate",
        resourceType: "SupplierCatalogProduct",
        resourceId: "qcst-catalog-1",
        requestedData: {
          supplierId: "qcst",
          catalogId: "qcst-catalog-1",
          enabled: true,
        },
        correlationId: "supplier-disabled",
        consumeGrant: true,
      },
    );

    expect(result).toEqual({ ok: true, stepUpConsumed: false });
    expect(statements).toHaveLength(0);
    expect(auditRows).toHaveLength(1);
  });

  it("keeps supplier curation behind the existing step-up flow when required", async () => {
    const { db, statements, auditRows } = stubDb(() => []);
    const result = await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: true },
      {
        actor: { numericUserId: ADMIN_ID, chatType: "private" },
        actionKey: "supplier.catalog.curate",
        resourceType: "SupplierCatalogProduct",
        resourceId: "qcst-catalog-1",
        requestedData: {
          supplierId: "qcst",
          catalogId: "qcst-catalog-1",
          enabled: true,
        },
        correlationId: "supplier-required",
        consumeGrant: false,
      },
    );

    expect(result).toEqual({ ok: false, code: "STEP_UP_NOT_ENROLLED" });
    expect(statements.length).toBeGreaterThan(0);
    expect(auditRows).toHaveLength(1);
  });

  it("audits the refusal, changing nothing else", async () => {
    const { db, auditRows } = stubDb(() => []);
    await authorizeSensitiveAdminAction(
      { ...DEPS, db, stepUpEnabled: false },
      {
        actor: { numericUserId: 987654321, chatType: "private" },
        actionKey: "store.open",
        resourceType: "StoreControl",
        resourceId: "main",
        correlationId: "c-4",
        consumeGrant: true,
      },
    );

    // One append: actorType ROOT_ADMIN plus the numeric actor id string.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toContain("ROOT_ADMIN");
    expect(auditRows[0]).toContain(String(987654321));
    expect(auditRows[0]).toContain("admin.sensitive.denied");
  });
});
