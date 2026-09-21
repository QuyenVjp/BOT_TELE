import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import {
  GOOGLE_SHEETS_REQUEST_ACTIONS,
  GoogleSheetsContractError,
  assertSafeSheetValue,
  parseSheetRequest,
  type GoogleSheetsRequestAction,
  type ParsedSheetRequest,
} from "./contracts.js";
import type { GoogleSheetsApi, SheetValue } from "../../infrastructure/google-sheets/client.js";
import {
  ensureGoogleSheetsWorkbook,
  reconcileGoogleSheetsOnce,
  type SheetsProjectionConfig,
} from "./projection.js";

export interface SheetsRequestProcessorConfig extends SheetsProjectionConfig {
  maxRows?: number;
}

type OutcomeStatus = "SUCCEEDED" | "REJECTED" | "STALE" | "FAILED";
type PersistedRequestStatus = OutcomeStatus | "PENDING" | "PROCESSING";
interface RequestOutcome {
  status: OutcomeStatus;
  resultCode: string;
  resultNote: string;
  auditEventId: string | null;
}

function valueAt(row: readonly SheetValue[], index: number): string {
  const value = row[index];
  return value === null || value === undefined ? "" : String(value).trim();
}

function parsePayload(value: string): Record<string, unknown> {
  if (!value) return {};
  if (value.length > 10_000) {
    throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", "payload is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", "payload must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GoogleSheetsContractError("INVALID_SHEET_REQUEST", "payload must be an object");
  }
  assertSafeSheetValue(parsed);
  return Object.fromEntries(Object.entries(parsed));
}

function payloadString(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

async function persistRejectedSheetRow(input: {
  db: Db;
  requestId: string;
  sourceRowRef: string;
  resultCode: "INVALID_SHEET_REQUEST" | "INVALID_SHEET_ACTION" | "SHEET_SECRET_REJECTED";
}): Promise<void> {
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 128) return;
  try {
    assertSafeSheetValue(requestId);
  } catch {
    return;
  }
  await withTransaction(input.db, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`.execute(trx);
    const existing =
      await sql`select request_id from google_sheets_request where request_id = ${requestId} for update`.execute(
        trx,
      );
    if (existing.rows[0]) return;
    const auditEventId = await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      actorId: "google-sheets",
      action: "google_sheets.request.rejected",
      targetType: "GoogleSheetsRequest",
      targetId: requestId,
      reason: "malformed Google Sheets request row",
      correlationId: requestId,
      metadataRedacted: { requestId, resultCode: input.resultCode },
    });
    await sql`
      insert into google_sheets_request
        (request_id, requested_by, requested_action, target_type, target_ref,
         expected_version, safe_payload, status, result_code, result_note,
         processed_at, source_row_ref, audit_event_id)
      values
        (${requestId}, 'unknown', 'INVALID', 'GoogleSheetsRequest', ${requestId},
         1, '{}'::jsonb, 'REJECTED', ${input.resultCode},
         'request row was rejected before execution', now(), ${input.sourceRowRef}, ${auditEventId})
    `.execute(trx);
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

/**
 * The Values API does not expose which collaborator edited a cell. requestedBy
 * is therefore a descriptive owner label, not proof of identity; the actual
 * policy boundary is the protected Requests input range and workbook sharing.
 */
export function isConfiguredSheetsOwner(requestedBy: string, ownerId: string): boolean {
  return ownerId.length > 0 && requestedBy === ownerId;
}

export function sameSheetRequest(
  prior: {
    requested_by: string;
    requested_action: string;
    target_type: string;
    target_ref: string;
    expected_version: number;
    safe_payload: unknown;
  },
  input: ParsedSheetRequest,
): boolean {
  return (
    prior.requested_by === input.requestedBy &&
    prior.requested_action === input.requestedAction &&
    prior.target_type === input.targetType &&
    prior.target_ref === input.targetRef &&
    prior.expected_version === input.expectedVersion &&
    stableJson(prior.safe_payload) === stableJson(input.safePayload)
  );
}
export function expectedVersionMatches(actual: number, expected: number): boolean {
  return Number.isSafeInteger(actual) && Number.isSafeInteger(expected) && actual === expected;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

function notePayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > 500) return null;
  assertSafeSheetValue(value);
  return value.trim();
}

const ACTION_TARGETS: Record<GoogleSheetsRequestAction, readonly string[]> = {
  ADD_INVENTORY_METADATA: ["DigitalAsset"],
  UPDATE_COST: ["DigitalAsset", "SupplierSku"],
  UPDATE_SAFE_NOTE: ["DigitalAsset"],
  DISABLE_ASSET: ["DigitalAsset"],
  ENABLE_ASSET: ["DigitalAsset"],
  MARK_ASSET_REVIEW: ["DigitalAsset"],
  REQUEST_SUPPORT_REVIEW: ["SupportTicket"],
};

function validTarget(input: ParsedSheetRequest): boolean {
  return ACTION_TARGETS[input.requestedAction].includes(input.targetType);
}

async function appendMissingRequestAudit(
  trx: Executor,
  input: ParsedSheetRequest,
  outcome: RequestOutcome,
): Promise<RequestOutcome> {
  if (outcome.auditEventId || outcome.status === "FAILED") return outcome;
  const auditEventId = await appendAuditEvent(trx, {
    actorType: "SYSTEM",
    actorId: "google-sheets",

    action: `google_sheets.request.${outcome.status.toLowerCase()}`,
    targetType: input.targetType,
    targetId: input.targetRef,
    reason: outcome.resultNote,
    correlationId: input.requestId,
    metadataRedacted: { requestId: input.requestId, resultCode: outcome.resultCode },
  });
  return { ...outcome, auditEventId };
}

async function writeRejected(
  trx: Executor,
  input: ParsedSheetRequest,
  resultCode: string,
  resultNote: string,
  sourceRowRef: string,
): Promise<RequestOutcome> {
  const auditEventId = await appendAuditEvent(trx, {
    actorType: "SYSTEM",
    actorId: "google-sheets",

    action: "google_sheets.request.rejected",
    targetType: input.targetType,
    targetId: input.targetRef,
    reason: resultNote,
    correlationId: input.requestId,
    metadataRedacted: { requestId: input.requestId, resultCode },
  });
  await sql`
    insert into google_sheets_request
      (request_id, requested_by, requested_action, target_type, target_ref,
       expected_version, safe_payload, status, result_code, result_note,
       processed_at, source_row_ref, audit_event_id)
    values
      (${input.requestId}, ${input.requestedBy}, ${input.requestedAction}, ${input.targetType}, ${input.targetRef},
       ${input.expectedVersion}, ${JSON.stringify(input.safePayload)}::jsonb, 'REJECTED', ${resultCode}, ${resultNote},
       now(), ${sourceRowRef}, ${auditEventId})
    on conflict (request_id) do nothing
  `.execute(trx);
  return { status: "REJECTED", resultCode, resultNote, auditEventId };
}

async function executeRequest(
  trx: Executor,
  input: ParsedSheetRequest,
  config: SheetsRequestProcessorConfig,
  sourceRowRef: string,
): Promise<RequestOutcome> {
  if (!isConfiguredSheetsOwner(input.requestedBy, config.ownerId)) {
    return writeRejected(
      trx,
      input,
      "UNAUTHORIZED_REQUESTER",
      "requester is not the configured Sheets owner",
      sourceRowRef,
    );
  }
  if (!validTarget(input)) {
    return writeRejected(
      trx,
      input,
      "INVALID_TARGET",
      "action and target type are not compatible",
      sourceRowRef,
    );
  }
  const action = input.requestedAction;
  if (action === "DISABLE_ASSET" || action === "ENABLE_ASSET") {
    const wanted = action === "DISABLE_ASSET" ? "COMPROMISED" : "AVAILABLE";
    const allowedFrom = action === "DISABLE_ASSET" ? ["AVAILABLE"] : ["COMPROMISED"];
    const asset = await sql<{ status: string; version: number }>`
      select status, version from digital_asset where id = ${input.targetRef} for update
    `.execute(trx);
    const row = asset.rows[0];
    if (!row)
      return {
        status: "REJECTED",
        resultCode: "TARGET_NOT_FOUND",
        resultNote: "asset not found",
        auditEventId: null,
      };
    if (!expectedVersionMatches(row.version, input.expectedVersion))
      return {
        status: "STALE",
        resultCode: "STALE_VERSION",
        resultNote: "asset version changed",
        auditEventId: null,
      };
    if (row.status === wanted)
      return {
        status: "SUCCEEDED",
        resultCode: "ALREADY_APPLIED",
        resultNote: "asset already has requested operational state",
        auditEventId: null,
      };
    if (!allowedFrom.includes(row.status))
      return {
        status: "REJECTED",
        resultCode: "ILLEGAL_TRANSITION",
        resultNote: "asset is already reserved, ready, delivered, or terminal",
        auditEventId: null,
      };
    await sql`
      update digital_asset set status = ${wanted}, updated_at = now(), version = version + 1
       where id = ${input.targetRef} and version = ${input.expectedVersion}
    `.execute(trx);
    await sql`
      insert into google_sheets_asset_metadata (asset_id, operational_status, updated_by)
      values (${input.targetRef}, ${action === "DISABLE_ASSET" ? "DISABLED" : "ACTIVE"}, ${input.requestedBy})
      on conflict (asset_id) do update set
        operational_status = excluded.operational_status,
        updated_by = excluded.updated_by,
        updated_at = now(),
        version = google_sheets_asset_metadata.version + 1
    `.execute(trx);
    const auditEventId = await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      actorId: "google-sheets",

      action: `google_sheets.${action.toLowerCase()}`,
      targetType: "DigitalAsset",
      targetId: input.targetRef,
      reason: `Google Sheets ${action}`,
      correlationId: input.requestId,
      metadataRedacted: { requestId: input.requestId, previousStatus: row.status, status: wanted },
    });
    return {
      status: "SUCCEEDED",
      resultCode: "APPLIED",
      resultNote: "asset state updated",
      auditEventId,
    };
  }

  if (action === "REQUEST_SUPPORT_REVIEW") {
    const ticket = await sql<{ status: string; version: number }>`
      select status, version from support_ticket where id = ${input.targetRef} for update
    `.execute(trx);
    const row = ticket.rows[0];
    if (!row)
      return {
        status: "REJECTED",
        resultCode: "TARGET_NOT_FOUND",
        resultNote: "support ticket not found",
        auditEventId: null,
      };
    if (!expectedVersionMatches(row.version, input.expectedVersion))
      return {
        status: "STALE",
        resultCode: "STALE_VERSION",
        resultNote: "support ticket version changed",
        auditEventId: null,
      };
    if (row.status === "MANUAL_REVIEW")
      return {
        status: "SUCCEEDED",
        resultCode: "ALREADY_APPLIED",
        resultNote: "support ticket is already under review",
        auditEventId: null,
      };
    if (["CLOSED", "RESOLVED"].includes(row.status))
      return {
        status: "REJECTED",
        resultCode: "ILLEGAL_TRANSITION",
        resultNote: "closed support ticket cannot be reopened by Sheets",
        auditEventId: null,
      };
    await sql`
      update support_ticket set status = 'MANUAL_REVIEW', updated_at = now(), version = version + 1
       where id = ${input.targetRef} and version = ${input.expectedVersion}
    `.execute(trx);
    const auditEventId = await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      actorId: "google-sheets",

      action: "google_sheets.request_support_review",
      targetType: "SupportTicket",
      targetId: input.targetRef,
      reason: "Google Sheets support review request",
      correlationId: input.requestId,
      metadataRedacted: {
        requestId: input.requestId,
        previousStatus: row.status,
        status: "MANUAL_REVIEW",
      },
    });
    return {
      status: "SUCCEEDED",
      resultCode: "APPLIED",
      resultNote: "support ticket moved to manual review",
      auditEventId,
    };
  }

  if (action === "UPDATE_COST" && input.targetType === "SupplierSku") {
    const cost = numberPayload(input.safePayload, "cost_vnd");
    if (cost === null)
      return {
        status: "REJECTED",
        resultCode: "INVALID_PAYLOAD",
        resultNote: "cost_vnd must be a non-negative integer",
        auditEventId: null,
      };
    const updated = await sql<{ id: string }>`
      update supplier_sku set cost_vnd = ${cost}, version = version + 1
       where id = ${input.targetRef} and version = ${input.expectedVersion}
       returning id
    `.execute(trx);
    if (!updated.rows[0]) {
      const exists = await sql<{
        version: number;
      }>`select version from supplier_sku where id = ${input.targetRef}`.execute(trx);
      return exists.rows[0]
        ? {
            status: "STALE",
            resultCode: "STALE_VERSION",
            resultNote: "supplier SKU version changed",
            auditEventId: null,
          }
        : {
            status: "REJECTED",
            resultCode: "TARGET_NOT_FOUND",
            resultNote: "supplier SKU not found",
            auditEventId: null,
          };
    }
    const auditEventId = await appendAuditEvent(trx, {
      actorType: "SYSTEM",
      actorId: "google-sheets",

      action: "google_sheets.update_cost",
      targetType: input.targetType,
      targetId: input.targetRef,
      reason: "Google Sheets cost update",
      correlationId: input.requestId,
      metadataRedacted: { requestId: input.requestId, costVnd: cost },
    });
    return {
      status: "SUCCEEDED",
      resultCode: "APPLIED",
      resultNote: "supplier cost updated",
      auditEventId,
    };
  }

  if (input.targetType !== "DigitalAsset") {
    return {
      status: "REJECTED",
      resultCode: "INVALID_TARGET",
      resultNote: "asset action requires a digital asset",
      auditEventId: null,
    };
  }
  const asset = await sql<{
    version: number;
  }>`select version from digital_asset where id = ${input.targetRef} for update`.execute(trx);
  if (!asset.rows[0])
    return {
      status: "REJECTED",
      resultCode: "TARGET_NOT_FOUND",
      resultNote: "asset not found",
      auditEventId: null,
    };
  if (!expectedVersionMatches(asset.rows[0].version, input.expectedVersion))
    return {
      status: "STALE",
      resultCode: "STALE_VERSION",
      resultNote: "asset version changed",
      auditEventId: null,
    };

  const note = notePayload(input.safePayload, "safe_note");
  const cost = numberPayload(input.safePayload, "cost_price_vnd");
  if ((action === "UPDATE_SAFE_NOTE" || action === "MARK_ASSET_REVIEW") && note === null) {
    return {
      status: "REJECTED",
      resultCode: "INVALID_PAYLOAD",
      resultNote: "safe_note is required and bounded",
      auditEventId: null,
    };
  }
  if (
    (action === "ADD_INVENTORY_METADATA" || action === "UPDATE_COST") &&
    note === null &&
    cost === null
  ) {
    return {
      status: "REJECTED",
      resultCode: "INVALID_PAYLOAD",
      resultNote: "safe_note or cost_price_vnd is required",
      auditEventId: null,
    };
  }
  const status = action === "MARK_ASSET_REVIEW" ? "REVIEW" : "ACTIVE";
  await sql`
    insert into google_sheets_asset_metadata (asset_id, cost_price_vnd, safe_note, operational_status, review_note, updated_by)
    values (${input.targetRef}, ${cost}, ${note ?? ""}, ${status}, ${action === "MARK_ASSET_REVIEW" ? (note ?? "") : ""}, ${input.requestedBy})
    on conflict (asset_id) do update set
      cost_price_vnd = coalesce(excluded.cost_price_vnd, google_sheets_asset_metadata.cost_price_vnd),
      safe_note = case when excluded.safe_note = '' then google_sheets_asset_metadata.safe_note else excluded.safe_note end,
      operational_status = case when ${action} = 'MARK_ASSET_REVIEW' then 'REVIEW' else google_sheets_asset_metadata.operational_status end,
      review_note = case when ${action} = 'MARK_ASSET_REVIEW' then excluded.review_note else google_sheets_asset_metadata.review_note end,
      updated_by = excluded.updated_by, updated_at = now(), version = google_sheets_asset_metadata.version + 1
  `.execute(trx);
  await sql`update digital_asset set updated_at = now(), version = version + 1 where id = ${input.targetRef} and version = ${input.expectedVersion}`.execute(
    trx,
  );
  const auditEventId = await appendAuditEvent(trx, {
    actorType: "SYSTEM",
    actorId: "google-sheets",
    action: `google_sheets.${action.toLowerCase()}`,
    targetType: "DigitalAsset",
    targetId: input.targetRef,
    reason: `Google Sheets ${action}`,
    correlationId: input.requestId,
    metadataRedacted: {
      requestId: input.requestId,
      hasCost: cost !== null,
      hasNote: note !== null,
    },
  });
  return {
    status: "SUCCEEDED",
    resultCode: "APPLIED",
    resultNote: "safe inventory metadata updated",
    auditEventId,
  };
}

async function processParsedRequest(
  db: Db,
  input: ParsedSheetRequest,
  config: SheetsRequestProcessorConfig,
  sourceRowRef: string,
): Promise<RequestOutcome> {
  return withTransaction(db, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`.execute(trx);
    const existing = await sql<{
      request_id: string;
      requested_by: string;
      requested_action: string;
      target_type: string;
      target_ref: string;
      expected_version: number;
      safe_payload: unknown;
      status: PersistedRequestStatus;
      result_code: string | null;
      result_note: string | null;
      audit_event_id: string | null;
    }>`select request_id, requested_by, requested_action, target_type, target_ref, expected_version, safe_payload, status, result_code, result_note, audit_event_id from google_sheets_request where request_id = ${input.requestId} for update`.execute(
      trx,
    );
    const prior = existing.rows[0];
    if (prior) {
      const same = sameSheetRequest(prior, input);
      if (!same) {
        const auditEventId = await appendAuditEvent(trx, {
          actorType: "SYSTEM",
          actorId: "google-sheets",
          action: "google_sheets.request.conflict",
          targetType: "GoogleSheetsRequest",
          targetId: input.requestId,
          reason: "request_id was already used with different content",
          correlationId: input.requestId,
          metadataRedacted: { requestId: input.requestId, resultCode: "REQUEST_ID_CONFLICT" },
        });
        return {
          status: "REJECTED",
          resultCode: "REQUEST_ID_CONFLICT",
          resultNote: "request_id was already used with different content",
          auditEventId,
        };
      }
      if (prior.status !== "PENDING" && prior.status !== "PROCESSING") {
        return {
          status: prior.status,
          resultCode: prior.result_code ?? "REPLAY",
          resultNote: prior.result_note ?? "request already processed",
          auditEventId: prior.audit_event_id,
        };
      }
    }
    if (!prior) {
      await sql`
        insert into google_sheets_request
          (request_id, requested_by, requested_action, target_type, target_ref, expected_version, safe_payload, status, source_row_ref)
        values
          (${input.requestId}, ${input.requestedBy}, ${input.requestedAction}, ${input.targetType}, ${input.targetRef}, ${input.expectedVersion}, ${payloadString(input.safePayload)}::jsonb, 'PROCESSING', ${sourceRowRef})
      `.execute(trx);
    }
    let outcome: RequestOutcome;
    try {
      outcome = await executeRequest(trx, input, config, sourceRowRef);
    } catch {
      outcome = {
        status: "FAILED",
        resultCode: "DOMAIN_ERROR",
        resultNote: "request could not be applied",
        auditEventId: null,
      };
    }
    outcome = await appendMissingRequestAudit(trx, input, outcome);
    await sql`
      update google_sheets_request
         set status = ${outcome.status}, result_code = ${outcome.resultCode}, result_note = ${outcome.resultNote},
             processed_at = now(), audit_event_id = ${outcome.auditEventId}, version = version + 1
       where request_id = ${input.requestId}
    `.execute(trx);
    return outcome;
  });
}

type RejectionCode = "INVALID_SHEET_REQUEST" | "INVALID_SHEET_ACTION" | "SHEET_SECRET_REJECTED";

interface ParsedSheetRow {
  input: unknown;
  requestId: string;
  sourceRowRef: string;
  rejectionCode?: RejectionCode;
}

function parseRows(values: readonly (readonly SheetValue[])[], maxRows: number): ParsedSheetRow[] {
  const headers = values[0]?.map((value) => String(value ?? "")) ?? [];
  const index = (name: string) => headers.indexOf(name);
  const rows: ParsedSheetRow[] = [];
  for (const [offset, row] of values.slice(1, maxRows + 1).entries()) {
    const requestId = valueAt(row, index("request_id"));
    if (!requestId) continue;
    const sourceRowRef = `Requests!A${offset + 2}`;
    const payloadRaw = valueAt(row, index("payload"));
    let payload: Record<string, unknown> = {};
    try {
      payload = parsePayload(payloadRaw);
    } catch (error) {
      rows.push({
        input: null,
        requestId,
        sourceRowRef,
        rejectionCode:
          error instanceof GoogleSheetsContractError ? error.code : "INVALID_SHEET_REQUEST",
      });
      continue;
    }
    rows.push({
      sourceRowRef,
      requestId,
      input: {
        request_id: requestId,
        requested_at: valueAt(row, index("requested_at")) || undefined,
        requested_by: valueAt(row, index("requested_by")),
        requested_action: valueAt(row, index("action")),
        target_type: valueAt(row, index("target_type")),
        target_ref: valueAt(row, index("target_ref")),
        expected_version: valueAt(row, index("expected_version")),
        safe_payload: payload,
      },
    });
  }
  return rows;
}

export async function processGoogleSheetsRequestsOnce(input: {
  db: Db;
  api: GoogleSheetsApi;
  config: SheetsRequestProcessorConfig;
}): Promise<{ processed: number; rejected: number; stale: number; failed: number }> {
  const result = await input.api.batchGet({
    spreadsheetId: input.config.spreadsheetId,
    ranges: ["Requests!A:Z"],
  });
  const rows = parseRows(result[0]?.values ?? [], input.config.maxRows ?? 500);
  const stats = { processed: 0, rejected: 0, stale: 0, failed: 0 };
  for (const row of rows) {
    if (row.input === null) {
      await persistRejectedSheetRow({
        db: input.db,
        requestId: row.requestId,
        sourceRowRef: row.sourceRowRef,
        resultCode: row.rejectionCode ?? "INVALID_SHEET_REQUEST",
      });
      stats.rejected += 1;
      continue;
    }
    try {
      const request = parseSheetRequest(row.input);
      const outcome = await processParsedRequest(input.db, request, input.config, row.sourceRowRef);
      stats.processed += 1;
      if (outcome.status === "REJECTED") stats.rejected += 1;
      if (outcome.status === "STALE") stats.stale += 1;
      if (outcome.status === "FAILED") stats.failed += 1;
    } catch (error) {
      await persistRejectedSheetRow({
        db: input.db,
        requestId: row.requestId,
        sourceRowRef: row.sourceRowRef,
        resultCode:
          error instanceof GoogleSheetsContractError ? error.code : "INVALID_SHEET_REQUEST",
      });
      stats.rejected += 1;
    }
  }
  if (rows.length > 0) {
    await sql`update google_sheets_sync_state set last_request_at = now(), version = version + 1 where id = 'main'`.execute(
      input.db,
    );
  }
  return stats;
}

export async function reconcileRequestsAndProjection(input: {
  db: Db;
  api: GoogleSheetsApi;
  config: SheetsRequestProcessorConfig;
}): Promise<{ processed: number; rowsWritten: number; orphanCount: number }> {
  await ensureGoogleSheetsWorkbook(input);
  const processed = await processGoogleSheetsRequestsOnce(input);
  const projection = await reconcileGoogleSheetsOnce(input, { structureReady: true });
  return {
    processed: processed.processed,
    rowsWritten: projection.rowsWritten,
    orphanCount: projection.orphanCount,
  };
}

export function isControlledAction(value: string): value is GoogleSheetsRequestAction {
  return (GOOGLE_SHEETS_REQUEST_ACTIONS as readonly string[]).includes(value);
}

export { recordSheetsSyncFailure } from "./projection.js";
