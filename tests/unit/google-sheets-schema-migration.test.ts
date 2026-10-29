import { describe, expect, it } from "vitest";
import type {
  GoogleSheetsApi,
  SheetsSpreadsheet,
} from "../../src/infrastructure/google-sheets/client.js";
import {
  ensureGoogleSheetsWorkbook,
  type SheetsProjectionConfig,
} from "../../src/modules/google-sheets/projection.js";
import {
  GOOGLE_SHEETS_SCHEMA_VERSION,
  GOOGLE_SHEETS_TABS,
  SHEET_HEADERS,
} from "../../src/modules/google-sheets/contracts.js";

const config: SheetsProjectionConfig = {
  spreadsheetId: "schema-migration-test",
  ownerId: "owner@example.test",
  appBaseUrl: "https://ops.example.test",
};

class FakeSheetsApi implements GoogleSheetsApi {
  schemaVersions = [GOOGLE_SHEETS_SCHEMA_VERSION];
  readonly structuralBatches: Parameters<GoogleSheetsApi["batchUpdate"]>[0][] = [];
  readonly headers = new Map<string, readonly string[]>(
    GOOGLE_SHEETS_TABS.map((tab) => [tab, [...SHEET_HEADERS[tab]]]),
  );

  async getSpreadsheet(
    _input: Parameters<GoogleSheetsApi["getSpreadsheet"]>[0],
  ): Promise<SheetsSpreadsheet> {
    return {
      sheets: GOOGLE_SHEETS_TABS.map((title, sheetId) => ({ title, sheetId, rowCount: 10_000 })),
      developerMetadata: this.schemaVersions.map((version) => ({
        metadataKey: "tier20_google_sheets_schema",
        metadataValue: String(version),
        locationType: "SPREADSHEET",
      })),
    };
  }

  async batchGet(input: Parameters<GoogleSheetsApi["batchGet"]>[0]) {
    return input.ranges.map((range) => {
      const tab = range.split("!")[0] ?? "";
      const values = this.headers.get(tab);
      return { range, values: values ? [values] : [] };
    });
  }

  async batchUpdateValues(
    _input: Parameters<GoogleSheetsApi["batchUpdateValues"]>[0],
  ): Promise<void> {}

  async batchUpdate(input: Parameters<GoogleSheetsApi["batchUpdate"]>[0]): Promise<void> {
    this.structuralBatches.push(input);
  }

  async append(_input: Parameters<GoogleSheetsApi["append"]>[0]): Promise<void> {}
}

function requestsFrom(api: FakeSheetsApi) {
  return api.structuralBatches.flatMap((batch) => batch.requests);
}

describe("Google Sheets schema migration", () => {
  it.each([
    { versions: [4], description: "v4" },
    { versions: [3, 4], description: "stale v3 and current v4 markers" },
  ])("removes legacy Vault columns from $description workbooks", async ({ versions }) => {
    const api = new FakeSheetsApi();
    api.schemaVersions = versions;
    for (const [tab, index] of [
      ["Inventory", 9],
      ["Suppliers", 8],
    ] as const) {
      const headers = [...SHEET_HEADERS[tab]];
      headers.splice(index, 0, "vault_ref");
      api.headers.set(tab, headers);
    }

    await ensureGoogleSheetsWorkbook({ api, config });

    const requests = requestsFrom(api);
    const deletedColumns = requests.flatMap((request) => {
      const range = request.deleteDimension?.range;
      return range ? [range] : [];
    });
    expect(
      deletedColumns.map(({ sheetId, dimension, startIndex, endIndex }) => ({
        sheetId,
        dimension,
        startIndex,
        endIndex,
      })),
    ).toEqual([
      { sheetId: 1, dimension: "COLUMNS", startIndex: 9, endIndex: 10 },
      { sheetId: 6, dimension: "COLUMNS", startIndex: 8, endIndex: 9 },
    ]);
    expect(requests.some((request) => request.insertDimension)).toBe(false);
    expect(
      requests[requests.length - 1]?.createDeveloperMetadata?.developerMetadata?.metadataValue,
    ).toBe(String(GOOGLE_SHEETS_SCHEMA_VERSION));
  });

  it("inserts the v3 supplier SKU column before removing Vault columns", async () => {
    const api = new FakeSheetsApi();
    api.schemaVersions = [3];
    const inventoryHeaders = [...SHEET_HEADERS.Inventory];
    inventoryHeaders.splice(9, 0, "vault_ref");
    const supplierHeaders = [
      ...SHEET_HEADERS.Suppliers.slice(0, 8),
      "vault_ref",
      SHEET_HEADERS.Suppliers[8]!,
    ];
    api.headers.set("Inventory", inventoryHeaders);
    api.headers.set("Suppliers", supplierHeaders);

    await ensureGoogleSheetsWorkbook({ api, config });

    const requests = requestsFrom(api);
    const supplierSkuInsert = requests.findIndex(
      (request) => request.insertDimension?.range?.sheetId === 6,
    );
    const supplierVaultColumnDelete = requests.findIndex(
      (request) => request.deleteDimension?.range?.sheetId === 6,
    );
    expect(requests[supplierSkuInsert]?.insertDimension?.range).toMatchObject({
      dimension: "COLUMNS",
      startIndex: 10,
      endIndex: 11,
    });
    expect(supplierSkuInsert).toBeLessThan(supplierVaultColumnDelete);
    expect(
      requests[requests.length - 1]?.createDeveloperMetadata?.developerMetadata?.metadataValue,
    ).toBe(String(GOOGLE_SHEETS_SCHEMA_VERSION));
  });
  it("does not delete current columns when the schema marker is stale", async () => {
    const api = new FakeSheetsApi();
    api.schemaVersions = [4];

    await ensureGoogleSheetsWorkbook({ api, config });

    const requests = requestsFrom(api);
    expect(requests.some((request) => request.deleteDimension)).toBe(false);
    expect(
      requests[requests.length - 1]?.createDeveloperMetadata?.developerMetadata?.metadataValue,
    ).toBe(String(GOOGLE_SHEETS_SCHEMA_VERSION));
  });

  it("deletes a legacy Vault column by its header location", async () => {
    const api = new FakeSheetsApi();
    api.schemaVersions = [4];
    const inventoryHeaders = [...SHEET_HEADERS.Inventory];
    inventoryHeaders.splice(3, 0, "vault_ref");
    const supplierHeaders = [...SHEET_HEADERS.Suppliers];
    supplierHeaders.splice(4, 0, "vault_ref");
    api.headers.set("Inventory", inventoryHeaders);
    api.headers.set("Suppliers", supplierHeaders);

    await ensureGoogleSheetsWorkbook({ api, config });

    const deletedColumns = requestsFrom(api).flatMap((request) => {
      const range = request.deleteDimension?.range;
      return range ? [{ sheetId: range.sheetId, startIndex: range.startIndex }] : [];
    });
    expect(deletedColumns).toEqual([
      { sheetId: 1, startIndex: 3 },
      { sheetId: 6, startIndex: 4 },
    ]);
  });

  it("detects a markerless legacy workbook from its exact headers", async () => {
    const api = new FakeSheetsApi();
    api.schemaVersions = [];
    const inventoryHeaders = [...SHEET_HEADERS.Inventory];
    inventoryHeaders.splice(9, 0, "vault_ref");
    const supplierHeaders = [...SHEET_HEADERS.Suppliers];
    supplierHeaders.splice(8, 0, "vault_ref");
    api.headers.set("Inventory", inventoryHeaders);
    api.headers.set("Suppliers", supplierHeaders);

    await ensureGoogleSheetsWorkbook({ api, config });

    expect(requestsFrom(api).filter((request) => request.deleteDimension)).toHaveLength(2);
  });

  it("refuses malformed legacy headers before structural updates", async () => {
    const api = new FakeSheetsApi();
    api.schemaVersions = [4];
    api.headers.set("Inventory", ["asset_id", "unrecognized_column"]);

    await expect(ensureGoogleSheetsWorkbook({ api, config })).rejects.toThrow(/header|schema/i);
    expect(requestsFrom(api)).toHaveLength(0);
  });
});
