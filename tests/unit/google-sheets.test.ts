import { describe, expect, it } from "vitest";
import {
  GOOGLE_SHEETS_REQUEST_ACTIONS,
  GOOGLE_SHEETS_TABS,
  SHEET_HEADERS,
  assertSafeSheetValue,
  parseSheetRequest,
} from "../../src/modules/google-sheets/contracts.js";
import {
  SHEETS_API_SCOPE,
  backoffDelayMs,
  buildBatchUpdateValuesPayload,
  classifySheetsError,
  withSheetsRetry,
} from "../../src/infrastructure/google-sheets/client.js";
import {
  expectedVersionMatches,
  isConfiguredSheetsOwner,
  sameSheetRequest,
} from "../../src/modules/google-sheets/requests.js";

describe("Google Sheets contracts", () => {
  it("keeps the managed workbook tabs and safe inventory headers stable", () => {
    expect(GOOGLE_SHEETS_TABS).toEqual([
      "Dashboard",
      "Inventory",
      "Orders",
      "Payments",
      "Fulfillment",
      "Warranty_Support",
      "Suppliers",
      "Requests",
      "Audit",
    ]);
    expect(SHEET_HEADERS.Inventory).toContain("asset_code");
    expect(SHEET_HEADERS.Inventory).toContain("vault_ref");
    expect(SHEET_HEADERS.Inventory).not.toContain("secret_value");
    expect(SHEET_HEADERS.Inventory).not.toContain("password");
  });

  it("rejects secret-like values before they reach a spreadsheet payload", () => {
    expect(() => assertSafeSheetValue("password=hunter2")).toThrow("SHEET_SECRET_REJECTED");
    expect(() => assertSafeSheetValue("refresh_token=abc")).toThrow("SHEET_SECRET_REJECTED");
    const privateKeyField = ["private", "key"].join("_");
    expect(() => assertSafeSheetValue({ [privateKeyField]: "blocked-value" })).toThrow(
      "SHEET_SECRET_REJECTED",
    );
    expect(() => assertSafeSheetValue('{"private_key":"blocked-value"}')).toThrow(
      "SHEET_SECRET_REJECTED",
    );
    expect(assertSafeSheetValue("q***@gmail.com")).toBe("q***@gmail.com");
  });

  it("accepts only the controlled request actions and rejects payment mutation", () => {
    expect(GOOGLE_SHEETS_REQUEST_ACTIONS).toContain("UPDATE_SAFE_NOTE");
    expect(
      parseSheetRequest({
        request_id: "REQ-1",
        requested_action: "UPDATE_SAFE_NOTE",
        target_type: "DigitalAsset",
        target_ref: "asset-1",
        expected_version: 2,
        safe_payload: { safe_note: "owner note" },
        requested_by: "owner",
      }).requestedAction,
    ).toBe("UPDATE_SAFE_NOTE");
    expect(() =>
      parseSheetRequest({
        request_id: "REQ-2",
        requested_action: "MARK_PAID",
        target_type: "Order",
        target_ref: "order-1",
        expected_version: 1,
        safe_payload: {},
        requested_by: "owner",
      }),
    ).toThrow("INVALID_SHEET_ACTION");
  });
  it("rejects unallowlisted request fields and secret-like request identifiers", () => {
    expect(() =>
      parseSheetRequest({
        request_id: "REQ-3",
        requested_action: "UPDATE_SAFE_NOTE",
        target_type: "DigitalAsset",
        target_ref: "asset-1",
        expected_version: 2,
        safe_payload: { note: "not the controlled field" },
        requested_by: "owner",
      }),
    ).toThrow("INVALID_SHEET_REQUEST");
    expect(() =>
      parseSheetRequest({
        request_id: "refresh_token=should-not-persist",
        requested_action: "UPDATE_SAFE_NOTE",
        target_type: "DigitalAsset",
        target_ref: "asset-1",
        expected_version: 2,
        safe_payload: { safe_note: "owner note" },
        requested_by: "owner",
      }),
    ).toThrow("SHEET_SECRET_REJECTED");
  });

  it("keeps owner authorization and request replay comparisons deterministic", () => {
    const request = parseSheetRequest({
      request_id: "REQ-4",
      requested_action: "ADD_INVENTORY_METADATA",
      target_type: "DigitalAsset",
      target_ref: "asset-1",
      expected_version: 2,
      safe_payload: { safe_note: "owner note", cost_price_vnd: 100 },
      requested_by: "owner",
    });
    expect(isConfiguredSheetsOwner("owner", "owner")).toBe(true);
    expect(isConfiguredSheetsOwner("attacker", "owner")).toBe(false);
    expect(
      sameSheetRequest(
        {
          requested_by: "owner",
          requested_action: "ADD_INVENTORY_METADATA",
          target_type: "DigitalAsset",
          target_ref: "asset-1",
          expected_version: 2,
          safe_payload: { cost_price_vnd: 100, safe_note: "owner note" },
        },
        request,
      ),
    ).toBe(true);
    expect(
      sameSheetRequest(
        {
          requested_by: "owner",
          requested_action: "ADD_INVENTORY_METADATA",
          target_type: "DigitalAsset",
          target_ref: "asset-1",
          expected_version: 3,
          safe_payload: { cost_price_vnd: 100, safe_note: "owner note" },
        },
        request,
      ),
    ).toBe(false);
  });

  it("uses an exact optimistic version match for stale requests", () => {
    expect(expectedVersionMatches(2, 2)).toBe(true);
    expect(expectedVersionMatches(2, 3)).toBe(false);
    expect(expectedVersionMatches(Number.NaN, 2)).toBe(false);
  });
});

describe("Google Sheets client helpers", () => {
  it("uses the narrow Sheets scope and composes one multi-range batch", () => {
    expect(SHEETS_API_SCOPE).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(
      buildBatchUpdateValuesPayload([
        { range: "Inventory!A1:B2", values: [["asset-1", "AVAILABLE"]] },
        { range: "Dashboard!A1:B2", values: [["metric", "1"]] },
      ]),
    ).toEqual({
      valueInputOption: "RAW",
      data: [
        { range: "Inventory!A1:B2", values: [["asset-1", "AVAILABLE"]] },
        { range: "Dashboard!A1:B2", values: [["metric", "1"]] },
      ],
    });
  });

  it("classifies quota, upstream, and network failures without exposing raw errors", () => {
    expect(classifySheetsError({ response: { status: 429 } }).code).toBe("RATE_LIMITED");
    expect(classifySheetsError({ response: { status: 503 } }).retryable).toBe(true);
    expect(classifySheetsError(new TypeError("fetch failed")).code).toBe("NETWORK");
    expect(classifySheetsError({ response: { status: 403 } }).code).toBe("PERMISSION_DENIED");
  });

  it("uses bounded exponential backoff", () => {
    expect(backoffDelayMs(0, 100, 5000)).toBe(100);
    expect(backoffDelayMs(3, 100, 5000)).toBe(800);
    expect(backoffDelayMs(99, 100, 5000)).toBe(5000);
  });

  it("retries transient Sheets failures with bounded sleeps", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    await expect(
      withSheetsRetry(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new TypeError("temporary network failure");
          return "ok";
        },
        {
          maxAttempts: 3,
          retryable: true,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).resolves.toBe("ok");

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });
  it("does not retry non-idempotent operations", async () => {
    let attempts = 0;
    await expect(
      withSheetsRetry(
        async () => {
          attempts += 1;
          throw { response: { status: 503 } };
        },
        { maxAttempts: 3, retryable: false, sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_5XX" });
    expect(attempts).toBe(1);
  });
});
