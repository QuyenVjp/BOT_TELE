import { z } from "zod";

export const GOOGLE_SHEETS_SCHEMA_VERSION = 3;
export const SHEETS_API_SCOPE = "https://www.googleapis.com/auth/spreadsheets" as const;

export const GOOGLE_SHEETS_TABS = [
  "Dashboard",
  "Inventory",
  "Orders",
  "Payments",
  "Fulfillment",
  "Warranty_Support",
  "Suppliers",
  "Requests",
  "Audit",
] as const;

export type GoogleSheetsTab = (typeof GOOGLE_SHEETS_TABS)[number];

export const SHEET_HEADERS: Record<GoogleSheetsTab, readonly string[]> = {
  Dashboard: [
    "schema_version",
    "metric_key",
    "metric_value",
    "status",
    "owner_notice",
    "as_of",
    "details",
  ],
  Inventory: [
    "asset_id",
    "asset_code",
    "product",
    "variant",
    "status",
    "source_type",
    "region",
    "masked_login",
    "fingerprint",
    "vault_ref",
    "cost_price_vnd",
    "added_at",
    "reserved_at",
    "ready_at",
    "delivered_at",
    "warranty_until",
    "health",
    "safe_note",
  ],
  Orders: [
    "order_id",
    "order_number",
    "created_at",
    "customer_ref",
    "product",
    "variant",
    "amount_vnd",
    "payment_status",
    "order_status",
    "fulfillment_type",
    "paid_at",
    "completed_at",
    "warranty_until",
  ],
  Payments: [
    "payment_intent_id",
    "order_id",
    "order_number",
    "amount_vnd",
    "status",
    "allocated_amount_vnd",
    "discrepancy_status",
    "created_at",
    "settled_at",
  ],
  Fulfillment: [
    "order_id",
    "order_number",
    "fulfillment_type",
    "status",
    "asset_code",
    "supplier_order_id",
    "manual_task_id",
    "delivered_at",
    "review_reason",
  ],
  Warranty_Support: [
    "record_type",
    "record_id",
    "record_number",
    "order_id",
    "customer_ref",
    "status",
    "reason",
    "safe_summary",
    "sla_due_at",
    "created_at",
    "updated_at",
  ],
  Suppliers: [
    "supplier_id",
    "supplier_name",
    "status",
    "external_sku",
    "cost_vnd",
    "region",
    "supplier_order_id",
    "supplier_order_status",
    "credential_vault_ref",
    "updated_at",
  ],
  Requests: [
    "request_id",
    "requested_at",
    "requested_by",
    "action",
    "target_type",
    "target_ref",
    "expected_version",
    "payload",
    "status",
    "result_code",
    "result_note",
    "processed_at",
  ],
  Audit: [
    "audit_id",
    "occurred_at",
    "actor_type",
    "actor_ref",
    "action",
    "target_type",
    "target_ref",
    "reason",
    "metadata",
  ],
};
export type SheetColumnRole = "SYSTEM_AUTHORITATIVE" | "HUMAN_EDITABLE" | "FORMULA_VIEW";

const systemColumns = (tab: GoogleSheetsTab): readonly SheetColumnRole[] =>
  SHEET_HEADERS[tab].map(() => "SYSTEM_AUTHORITATIVE" as const);

/**
 * Only listed headers are managed. Columns after the canonical header range
 * are FORMULA_VIEW and are never written by reconciliation.
 */
export const SHEET_COLUMN_OWNERSHIP: Record<GoogleSheetsTab, readonly SheetColumnRole[]> = {
  Dashboard: systemColumns("Dashboard"),
  Inventory: systemColumns("Inventory"),
  Orders: systemColumns("Orders"),
  Payments: systemColumns("Payments"),
  Fulfillment: systemColumns("Fulfillment"),
  Warranty_Support: systemColumns("Warranty_Support"),
  Suppliers: systemColumns("Suppliers"),
  Requests: [
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "HUMAN_EDITABLE",
    "SYSTEM_AUTHORITATIVE",
    "SYSTEM_AUTHORITATIVE",
    "SYSTEM_AUTHORITATIVE",
    "SYSTEM_AUTHORITATIVE",
  ],
  Audit: systemColumns("Audit"),
};

export function sheetColumnRole(tab: GoogleSheetsTab, columnIndex: number): SheetColumnRole {
  return SHEET_COLUMN_OWNERSHIP[tab][columnIndex] ?? "FORMULA_VIEW";
}

export const GOOGLE_SHEETS_REQUEST_ACTIONS = [
  "ADD_INVENTORY_METADATA",
  "UPDATE_COST",
  "UPDATE_SAFE_NOTE",
  "DISABLE_ASSET",
  "ENABLE_ASSET",
  "MARK_ASSET_REVIEW",
  "REQUEST_SUPPORT_REVIEW",
] as const;

export type GoogleSheetsRequestAction = (typeof GOOGLE_SHEETS_REQUEST_ACTIONS)[number];

export const GOOGLE_SHEETS_FORBIDDEN_ACTIONS = [
  "MARK_PAID",
  "SETTLED",
  "DELIVERED",
  "ALLOCATE_ASSET",
  "RELEASE_READY",
  "MUTATE_LEDGER",
  "MUTATE_EVIDENCE",
  "REVEAL_SECRET",
  "DELETE_ASSET",
] as const;

const SAFE_TARGET_TYPES = [
  "DigitalAsset",
  "SupplierSku",
  "SupportTicket",
  "WarrantyClaim",
  "Order",
] as const;

const SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|token|cookie|session|authorization|private[_ -]?key|totp|otp|telegram[_ -]?(?:token|auth)|webhook[_ -]?secret)/i;
const SECRET_VALUE_PATTERN =
  /(?:-----BEGIN [^-]+ PRIVATE KEY-----|["']?\b(?:password|passwd|secret|cookie|session|authorization|private[_ -]?key|totp|otp)\b["']?\s*[:=]|["']?\b(?:refresh|access|id|bearer)[_-]token\b["']?\s*[:=])/i;

export class GoogleSheetsContractError extends Error {
  readonly code: "SHEET_SECRET_REJECTED" | "INVALID_SHEET_ACTION" | "INVALID_SHEET_REQUEST";

  constructor(code: GoogleSheetsContractError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "GoogleSheetsContractError";
    this.code = code;
  }
}

function assertSafeValue(value: unknown, path: string, depth: number): void {
  if (depth > 4) {
    throw new GoogleSheetsContractError("SHEET_SECRET_REJECTED", `${path} is too deeply nested`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", `${path} is not finite`);
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > 10_000 || SECRET_VALUE_PATTERN.test(value)) {
      throw new GoogleSheetsContractError(
        "SHEET_SECRET_REJECTED",
        `${path} contains secret-like data`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === "object") assertSafeValue(parsed, path, depth + 1);
      } catch (error) {
        if (error instanceof GoogleSheetsContractError) throw error;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeValue(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new GoogleSheetsContractError(
          "SHEET_SECRET_REJECTED",
          `${path}.${key} is not exportable`,
        );
      }
      assertSafeValue(entry, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", `${path} has an unsupported type`);
}

export function assertSafeSheetValue(
  value: unknown,
  path = "value",
): string | number | boolean | null | Record<string, unknown> | unknown[] {
  assertSafeValue(value, path, 0);
  return value as string | number | boolean | null | Record<string, unknown> | unknown[];
}

const requestSchema = z.object({
  request_id: z.string().trim().min(1).max(128),
  requested_at: z.string().trim().max(64).optional(),
  requested_by: z.string().trim().min(1).max(128),
  requested_action: z.string().trim().max(64),
  target_type: z.enum(SAFE_TARGET_TYPES),
  target_ref: z.string().trim().min(1).max(128),
  expected_version: z.coerce.number().int().positive(),
  safe_payload: z.record(z.string(), z.unknown()).default({}),
});

export interface ParsedSheetRequest {
  requestId: string;
  requestedAt: string | null;
  requestedBy: string;
  requestedAction: GoogleSheetsRequestAction;
  targetType: (typeof SAFE_TARGET_TYPES)[number];
  targetRef: string;
  expectedVersion: number;
  safePayload: Record<string, unknown>;
}

function assertRequestPayload(
  action: GoogleSheetsRequestAction,
  targetType: (typeof SAFE_TARGET_TYPES)[number],
  payload: Record<string, unknown>,
): void {
  const allowed =
    action === "ADD_INVENTORY_METADATA"
      ? ["safe_note", "cost_price_vnd"]
      : action === "UPDATE_COST"
        ? [targetType === "SupplierSku" ? "cost_vnd" : "cost_price_vnd"]
        : action === "UPDATE_SAFE_NOTE" || action === "MARK_ASSET_REVIEW"
          ? ["safe_note"]
          : [];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new GoogleSheetsContractError(
        "INVALID_SHEET_REQUEST",
        "payload field is not allowlisted",
      );
    }
  }
  if ("safe_note" in payload && payload.safe_note !== null) {
    if (typeof payload.safe_note !== "string" || payload.safe_note.trim().length > 500) {
      throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", "safe_note is bounded text");
    }
  }
}

export function parseSheetRequest(input: unknown): ParsedSheetRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", "request row is malformed");
  }
  const scalarFields = {
    request_id: parsed.data.request_id,
    requested_at: parsed.data.requested_at ?? null,
    requested_by: parsed.data.requested_by,
    requested_action: parsed.data.requested_action,
    target_type: parsed.data.target_type,
    target_ref: parsed.data.target_ref,
  };
  for (const [key, value] of Object.entries(scalarFields)) {
    assertSafeValue(value, key, 0);
  }
  if (
    !(GOOGLE_SHEETS_REQUEST_ACTIONS as readonly string[]).includes(parsed.data.requested_action)
  ) {
    throw new GoogleSheetsContractError("INVALID_SHEET_ACTION", "action is not allowlisted");
  }
  const safePayload = parsed.data.safe_payload;
  assertSafeValue(safePayload, "safe_payload", 0);
  const requestedAction = parsed.data.requested_action as GoogleSheetsRequestAction;
  assertRequestPayload(requestedAction, parsed.data.target_type, safePayload);
  return {
    requestId: parsed.data.request_id,
    requestedAt: parsed.data.requested_at ?? null,
    requestedBy: parsed.data.requested_by,
    requestedAction,
    targetType: parsed.data.target_type,
    targetRef: parsed.data.target_ref,
    expectedVersion: parsed.data.expected_version,
    safePayload,
  };
}

export function rowKey(tab: GoogleSheetsTab, row: Record<string, unknown>): string {
  const key =
    tab === "Inventory"
      ? row.asset_id
      : tab === "Orders"
        ? row.order_id
        : tab === "Payments"
          ? row.payment_intent_id
          : tab === "Fulfillment"
            ? row.order_id
            : tab === "Suppliers"
              ? row.supplier_id
              : tab === "Requests"
                ? row.request_id
                : tab === "Audit"
                  ? row.audit_id
                  : tab === "Warranty_Support"
                    ? row.record_id
                    : row.metric_key;
  if (typeof key !== "string" || key.length === 0) {
    throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", `missing stable key for ${tab}`);
  }
  return key;
}
