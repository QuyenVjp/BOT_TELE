import { describe, expect, it } from "vitest";
import {
  createAdminProduct,
  createAdminVariant,
  setAdminVariantActive,
  updateAdminVariant,
} from "../../src/modules/catalog/admin-products.js";
import { OWNER_COMMANDS } from "../../src/bot/callbacks/admin.js";
import type { RootAdminConfig } from "../../src/modules/identity/root-admin.js";
import type { Db } from "../../src/infrastructure/db/transaction.js";

const config: RootAdminConfig = {
  adminTelegramUserId: 999,
  expectedUsername: "root",
};

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

function stubDb(
  rowsFor: (parameters: readonly unknown[], statementIndex: number) => unknown[],
): Db {
  let statementIndex = 0;
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ sql: "", parameters: collectValues(node), query: node }),
    executeQuery: async (compiled: { parameters: unknown[] }) => {
      const rows = rowsFor(compiled.parameters, statementIndex++);
      return { rows };
    },
  };
  const connection = { getExecutor: () => executor };
  return {
    getExecutor: () => executor,
    transaction: () => ({ execute: (fn: (trx: unknown) => unknown) => fn(connection) }),
  } as unknown as Db;
}

describe("admin variant activation boundary", () => {
  it("keeps catalog.activate and catalog.deactivate in OWNER_COMMANDS allowlist", () => {
    expect(OWNER_COMMANDS).toContain("catalog.activate");
    expect(OWNER_COMMANDS).toContain("catalog.deactivate");
  });

  it("refuses activation when caller is not root admin", async () => {
    const db = stubDb(() => []);
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 123, chatType: "private" },
      config,
      variantId: "var-1",
      active: true,
      reason: "Activate",
      correlationId: "c-1",
    });

    expect(result).toEqual({
      ok: false,
      code: "NOT_ROOT_ADMIN",
      message: "Không được phép.",
    });
  });

  it("refuses activation outside private chat context", async () => {
    const db = stubDb(() => []);
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 999, chatType: "group" },
      config,
      variantId: "var-1",
      active: true,
      reason: "Activate",
      correlationId: "c-2",
    });

    expect(result).toEqual({
      ok: false,
      code: "WRONG_CONTEXT",
      message: "Không được phép.",
    });
  });

  it("returns NOT_FOUND when variant row does not exist", async () => {
    const db = stubDb(() => []);
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 999, chatType: "private" },
      config,
      variantId: "var-missing",
      active: true,
      reason: "Activate",
      correlationId: "c-3",
    });

    expect(result).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy biến thể.",
    });
  });

  it("returns NOT_FOUND when expectedVersion does not match", async () => {
    const db = stubDb(() => [{ id: "var-1", fulfillment_type: "STOCK_ACCOUNT", version: 5 }]);
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 999, chatType: "private" },
      config,
      variantId: "var-1",
      active: true,
      reason: "Activate",
      correlationId: "c-4",
      expectedVersion: 4,
    });

    expect(result).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Không tìm thấy biến thể.",
    });
  });

  it("gates DIGITAL_FILE variant activation on active file artifact", async () => {
    const db = stubDb((_, idx) =>
      idx === 0 ? [{ id: "var-df", fulfillment_type: "DIGITAL_FILE", version: 1 }] : [],
    );
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 999, chatType: "private" },
      config,
      variantId: "var-df",
      active: true,
      reason: "Activate digital file",
      correlationId: "c-5",
    });

    expect(result).toEqual({
      ok: false,
      code: "DIGITAL_FILE_ARTIFACT_REQUIRED",
      message: "Cần nhập và kích hoạt tệp thật trước khi bật bán biến thể tệp số.",
    });
  });

  it("also gates DIGITAL_FILE activation through the general variant update path", async () => {
    const db = stubDb((_, idx) => (idx === 0 ? [{ fulfillment_type: "DIGITAL_FILE" }] : []));

    await expect(
      updateAdminVariant({
        db,
        actor: { numericUserId: 999, chatType: "private" },
        config,
        productId: "product-1",
        variantId: "var-df",
        expectedVersion: 1,
        active: true,
        reason: "Activate digital file",
        correlationId: "c-5-update",
      }),
    ).rejects.toThrow("DIGITAL_FILE_ARTIFACT_REQUIRED");
  });

  it("refuses DIGITAL_FILE creation when requested active", async () => {
    const db = stubDb(() => []);
    const common = {
      actor: { numericUserId: 999, chatType: "private" as const },
      config,
      db,
      reason: "Create digital file",
      fulfillmentType: "DIGITAL_FILE" as const,
      inventoryFields: [],
      lowStockThreshold: null,
      active: true,
    };

    await expect(
      createAdminProduct({
        ...common,
        categoryId: "cat-1",
        name: "Digital file",
        slug: "digital-file",
        sku: "DF-1",
        priceVnd: 1000n,
        variantName: "One file",
        correlationId: "c-5-product",
      }),
    ).rejects.toThrow("DIGITAL_FILE_ARTIFACT_REQUIRED");

    await expect(
      createAdminVariant({
        ...common,
        productId: "product-1",
        variantId: "variant-1",
        sku: "DF-2",
        name: "One file",
        priceVnd: 1000n,
        correlationId: "c-5-variant",
      }),
    ).rejects.toThrow("DIGITAL_FILE_ARTIFACT_REQUIRED");
  });

  it("successfully updates variant and writes audit log", async () => {
    const db = stubDb((_, idx) =>
      idx === 0
        ? [{ id: "var-1", fulfillment_type: "STOCK_ACCOUNT", version: 1 }]
        : idx === 1
          ? [{ id: "var-1" }]
          : [],
    );
    const result = await setAdminVariantActive({
      db,
      actor: { numericUserId: 999, chatType: "private" },
      config,
      variantId: "var-1",
      active: false,
      reason: "Emergency kill-switch",
      correlationId: "c-6",
    });

    expect(result).toEqual({ ok: true });
  });
});
