import { describe, expect, it } from "vitest";
import {
  buildCanonicalSheetRows,
  buildGridExpansionRequests,
  buildProjectionWritePlan,
  buildWorkbookStructureRequests,
  operationalLink,
} from "../../src/modules/google-sheets/projection.js";
import {
  SHEET_COLUMN_OWNERSHIP,
  SHEET_HEADERS,
  rowKey,
  sheetColumnRole,
} from "../../src/modules/google-sheets/contracts.js";

describe("Google Sheets projection invariants", () => {
  it("rewrites mirrored cells from PostgreSQL rows and restores missing rows", () => {
    const rows = buildCanonicalSheetRows(
      "Inventory",
      [
        {
          asset_id: "asset-b",
          asset_code: "ASSET-B",
          product: "Claude",
          variant: "Pro",
          status: "AVAILABLE",
          source_type: "LOCAL",
          region: "",
          masked_login: "",
          fingerprint: "fingerprint-b",
          vault_ref: "vault:asset-b",
          cost_price_vnd: "100",
          added_at: "2026-01-02T00:00:00.000Z",
          reserved_at: null,
          ready_at: null,
          delivered_at: null,
          warranty_until: null,
          health: "OK",
          safe_note: "DB note",
        },
        {
          asset_id: "asset-a",
          asset_code: "ASSET-A",
          product: "ChatGPT",
          variant: "Plus",
          status: "COMPROMISED",
          source_type: "LOCAL",
          region: "",
          masked_login: "",
          fingerprint: "fingerprint-a",
          vault_ref: "vault:asset-a",
          cost_price_vnd: "200",
          added_at: "2026-01-01T00:00:00.000Z",
          reserved_at: null,
          ready_at: null,
          delivered_at: null,
          warranty_until: null,
          health: "REVIEW",
          safe_note: "review",
        },
      ],
      3,
    );

    expect(rows[0]).toEqual(SHEET_HEADERS.Inventory);
    expect(rows[1]?.[0]).toBe("asset-b");
    expect(rows[2]?.[0]).toBe("asset-a");
    expect(rows[3]).toEqual(new Array(SHEET_HEADERS.Inventory.length).fill(null));
    expect(rows.flat()).not.toContain("vault:asset-a");
  });
  it("preserves human Requests inputs while restoring system columns", () => {
    const desired = [
      {
        request_id: "req-1",
        requested_at: "2026-01-01T00:00:00.000Z",
        requested_by: "owner@example.test",
        action: "UPDATE_SAFE_NOTE",
        target_type: "DigitalAsset",
        target_ref: "asset-1",
        expected_version: 1,
        payload: '{"safe_note":"DB note"}',
        status: "PENDING",
        result_code: "",
        result_note: "",
        processed_at: null,
      },
    ];
    const plan = buildProjectionWritePlan("Requests", desired, [
      SHEET_HEADERS.Requests,
      [
        "req-1",
        "2026-01-01T00:00:00.000Z",
        "owner@example.test",
        "UPDATE_SAFE_NOTE",
        "DigitalAsset",
        "asset-1",
        "1",
        '{"safe_note":"human note"}',
        "HACKED",
        "OLD",
        "OLD",
        "",
        '=M2&" view"',
      ],
    ]);

    expect(plan.writes.map((write) => write.range)).toEqual(["Requests!A1:L1", "Requests!I2:L2"]);
    expect(plan.writes[1]?.values).toEqual([["PENDING", "", "", null]]);
    expect(plan.writes.map((write) => write.range).join(",")).not.toContain("M");
  });

  it("keeps stable row ownership and collapses duplicate audit ids", () => {
    const row = (audit_id: string, action: string) => ({
      audit_id,
      occurred_at: "2026-01-01T00:00:00.000Z",
      actor_type: "SYSTEM",
      actor_ref: "google-sheets",
      action,
      target_type: "DigitalAsset",
      target_ref: "asset-1",
      reason: "test",
      metadata: "{}",
    });
    const plan = buildProjectionWritePlan(
      "Audit",
      [row("event-a", "a"), row("event-b", "b")],
      [
        SHEET_HEADERS.Audit,
        Object.values(row("event-b", "old-b")),
        Object.values(row("event-a", "old-a")),
        Object.values(row("event-a", "duplicate")),
      ],
    );
    const values = plan.writes[0]?.values ?? [];

    expect(values[1]?.[0]).toBe("event-b");
    expect(values[1]?.[4]).toBe("b");
    expect(values[2]?.[0]).toBe("event-a");
    expect(values[2]?.[4]).toBe("a");
    expect(values[3]).toEqual(new Array(SHEET_HEADERS.Audit.length).fill(null));
    expect(plan.orphanCount).toBe(1);
    const restored = buildProjectionWritePlan(
      "Audit",
      [row("event-a", "a")],
      [SHEET_HEADERS.Audit],
    );
    expect(restored.writes[0]?.values[1]?.[0]).toBe("event-a");
  });
  it("uses raw supplier SKU ids and keeps multiple SKUs under one supplier distinct", () => {
    const supplierRow = (supplier_sku_id: string) => ({
      supplier_id: "supplier-1",
      supplier_name: "Supplier",
      status: "ACTIVE",
      external_sku: supplier_sku_id,
      cost_vnd: "100",
      region: "VN",
      supplier_order_id: "",
      supplier_order_status: "",
      credential_vault_ref: "vault:supplier",
      updated_at: "2026-01-01T00:00:00.000Z",
      supplier_sku_id,
    });
    const plan = buildProjectionWritePlan(
      "Suppliers",
      [supplierRow("sku-1"), supplierRow("sku-2")],
      [SHEET_HEADERS.Suppliers],
    );
    const skuColumn = SHEET_HEADERS.Suppliers.indexOf("supplier_sku_id");
    expect(plan.writes[0]?.values.slice(1).map((row) => row[skuColumn])).toEqual([
      "sku-1",
      "sku-2",
    ]);
    expect(plan.writes.flatMap((write) => write.values.flat())).not.toContain("vault:supplier");
    expect(plan.orphanCount).toBe(0);
  });

  it("uses a disjoint supplier-id fallback when a supplier has no SKU", () => {
    expect(rowKey("Suppliers", { supplier_id: "supplier-1", supplier_sku_id: "sku-1" })).toBe(
      "sku:sku-1",
    );
    expect(rowKey("Suppliers", { supplier_id: "supplier-1", supplier_sku_id: null })).toBe(
      "supplier:supplier-1",
    );
    expect(
      rowKey("Suppliers", { supplier_id: "supplier-1", supplier_sku_id: "supplier-1" }),
    ).not.toBe(rowKey("Suppliers", { supplier_id: "supplier-1", supplier_sku_id: null }));
  });

  it("retains every audit event beyond the former 1,000-row cap", () => {
    const auditRows = Array.from({ length: 1_001 }, (_, index) => ({
      audit_id: `event-${index}`,
      occurred_at: "2026-01-01T00:00:00.000Z",
      actor_type: "SYSTEM",
      actor_ref: "",
      action: "TEST",
      target_type: "DigitalAsset",
      target_ref: "asset-1",
      reason: "",
      metadata: "{}",
    }));
    const plan = buildProjectionWritePlan("Audit", auditRows, [SHEET_HEADERS.Audit]);
    expect(plan.writes[0]?.values).toHaveLength(1_002);
  });

  it("keeps the v3 supplier SKU insertion boundary after Vault column removal", () => {
    const requests = buildWorkbookStructureRequests(
      [{ sheetId: 42, title: "Suppliers" }],
      [],
      true,
      { migrateSuppliersV3: true },
    );
    expect(requests.find((request) => request.insertDimension)?.insertDimension).toEqual({
      range: {
        sheetId: 42,
        dimension: "COLUMNS",
        startIndex: 10,
        endIndex: 11,
      },
      inheritFromBefore: false,
    });
    const plan = buildProjectionWritePlan(
      "Suppliers",
      [{ supplier_id: "supplier-1", supplier_sku_id: null }],
      [SHEET_HEADERS.Suppliers, ["supplier-1", "", "", "", "", "", "", "", "", "", "", "=A2"]],
    );
    expect(plan.writes[0]?.range).toBe("Suppliers!A1:J2");
    expect(plan.writes.map((write) => write.range).join(",")).not.toContain("L");
  });

  it("expands only undersized managed grids", () => {
    expect(
      buildGridExpansionRequests(
        [
          { sheetId: 10, title: "Audit", rowCount: 2 },
          { sheetId: 11, title: "Suppliers", rowCount: 10 },
        ],
        { Audit: 5, Suppliers: 10 },
      ),
    ).toEqual([
      {
        updateSheetProperties: {
          properties: { sheetId: 10, gridProperties: { rowCount: 5 } },
          fields: "gridProperties.rowCount",
        },
      },
    ]);
  });

  it("fails closed before values writes when grid capacity metadata is missing", () => {
    const attemptedWrites: string[] = [];
    expect(() => {
      const requests = buildGridExpansionRequests([{ sheetId: 10, title: "Audit" }], {
        Audit: 5,
      });
      if (requests.length === 0) attemptedWrites.push("values");
    }).toThrow("rowCount metadata");
    expect(attemptedWrites).toEqual([]);
  });

  it("classifies human, system, and formula/view columns structurally", () => {
    expect(
      SHEET_COLUMN_OWNERSHIP.Requests.slice(0, 8).every((role) => role === "HUMAN_EDITABLE"),
    ).toBe(true);
    expect(
      SHEET_COLUMN_OWNERSHIP.Requests.slice(8).every((role) => role === "SYSTEM_AUTHORITATIVE"),
    ).toBe(true);
    expect(sheetColumnRole("Requests", 20)).toBe("FORMULA_VIEW");
    expect(sheetColumnRole("Inventory", SHEET_HEADERS.Inventory.length - 1)).toBe(
      "SYSTEM_AUTHORITATIVE",
    );
  });

  it("creates only additive workbook requests and never deletes a sheet", () => {
    const requests = buildWorkbookStructureRequests([], ["Dashboard", "Requests"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.deleteSheet)).toBe(true);
    expect(requests).toEqual([
      { addSheet: { properties: { title: "Dashboard", gridProperties: { frozenRowCount: 1 } } } },
      { addSheet: { properties: { title: "Requests", gridProperties: { frozenRowCount: 1 } } } },
    ]);
  });

  it("leaves unmanaged workbook tabs unchanged", () => {
    expect(buildWorkbookStructureRequests([{ sheetId: 10, title: "Notes" }], [])).toEqual([]);
  });

  it("restricts workbook writes to the service account and owner input range", () => {
    const requests = buildWorkbookStructureRequests(
      [{ sheetId: 9, title: "Requests" }],
      [],
      false,
      { ownerEmail: "owner@example.test", serviceAccountEmail: "sheets@example.test" },
    );
    const protections = requests.filter((request) => request.addProtectedRange);
    expect(protections).toHaveLength(2);
    const inputProtection = protections.find(
      (request) => request.addProtectedRange?.protectedRange?.range?.endColumnIndex === 8,
    );
    expect(inputProtection?.addProtectedRange?.protectedRange?.warningOnly).toBe(false);
    expect(inputProtection?.addProtectedRange?.protectedRange?.range?.startRowIndex).toBe(1);
    expect(inputProtection?.addProtectedRange?.protectedRange?.editors?.users).toEqual([
      "sheets@example.test",
      "owner@example.test",
    ]);
    const systemProtection = protections.find(
      (request) => request.addProtectedRange?.protectedRange?.range?.startColumnIndex === 8,
    );
    expect(systemProtection?.addProtectedRange?.protectedRange?.editors?.users).toEqual([
      "sheets@example.test",
    ]);
    expect(systemProtection?.addProtectedRange?.protectedRange?.range?.endColumnIndex).toBe(12);
  });

  it("builds links from stable identifiers without delivery tokens", () => {
    const url = operationalLink("https://ops.example.test/", "asset", "asset-1");
    expect(url).toBe("https://ops.example.test/health?ops=asset%3Aasset-1");
    expect(url).not.toContain("token");
  });

  it("initializes an empty managed sheet with its header row", () => {
    const plan = buildProjectionWritePlan("Inventory", [], []);

    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.range).toMatch(/^Inventory!A1:/);
    expect(plan.writes[0]?.values).toEqual([SHEET_HEADERS.Inventory]);
    expect(plan.orphanCount).toBe(0);
  });
});
