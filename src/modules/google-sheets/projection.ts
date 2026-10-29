import { sql } from "kysely";
import type { sheets_v4 } from "googleapis";
import type { Db } from "../../infrastructure/db/transaction.js";
import type {
  GoogleSheetsApi,
  SheetValue,
  SheetValueRange,
} from "../../infrastructure/google-sheets/client.js";
import {
  GOOGLE_SHEETS_SCHEMA_VERSION,
  GOOGLE_SHEETS_TABS,
  SHEET_COLUMN_OWNERSHIP,
  SHEET_HEADERS,
  assertSafeSheetValue,
  rowKey,
  type GoogleSheetsTab,
} from "./contracts.js";

export interface SheetsProjectionConfig {
  spreadsheetId: string;
  ownerId: string;
  appBaseUrl: string;
  serviceAccountEmail?: string;
}

interface InventoryProjection {
  asset_id: string;
  asset_code: string;
  product: string;
  variant: string;
  status: string;
  source_type: string;
  region: string;
  masked_login: string;
  fingerprint: string;
  cost_price_vnd: string | null;
  added_at: string;
  reserved_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  warranty_until: string | null;
  health: string;
  safe_note: string;
}

interface OrderProjection {
  order_id: string;
  order_number: string;
  created_at: string;
  customer_id: string;
  customer_ref: string;
  product: string;
  variant: string;
  amount_vnd: string;
  payment_status: string;
  order_status: string;
  fulfillment_type: string;
  paid_at: string | null;
  completed_at: string | null;
  warranty_until: string | null;
}

interface PaymentProjection {
  payment_intent_id: string;
  order_id: string;
  order_number: string;
  amount_vnd: string;
  status: string;
  allocated_amount_vnd: string;
  discrepancy_status: string;
  created_at: string;
  settled_at: string | null;
}

interface FulfillmentProjection {
  order_id: string;
  order_number: string;
  fulfillment_type: string;
  status: string;
  asset_code: string;
  supplier_order_id: string;
  manual_task_id: string;
  delivered_at: string | null;
  review_reason: string;
}

interface SupportProjection {
  record_type: "WarrantyClaim" | "SupportTicket";
  record_id: string;
  record_number: string;
  order_id: string;
  customer_id: string;
  customer_ref: string;
  status: string;
  reason: string;
  safe_summary: string;
  sla_due_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SupplierProjection {
  supplier_id: string;
  supplier_name: string;
  status: string;
  external_sku: string;
  cost_vnd: string;
  region: string;
  supplier_order_id: string;
  supplier_order_status: string;
  updated_at: string;
  supplier_sku_id: string | null;
}

interface RequestProjection {
  request_id: string;
  requested_at: string;
  requested_by: string;
  action: string;
  target_type: string;
  target_ref: string;
  expected_version: number;
  payload: string;
  status: string;
  result_code: string;
  result_note: string;
  processed_at: string | null;
}

interface AuditProjection {
  audit_id: string;
  occurred_at: string;
  actor_type: string;
  actor_ref: string;
  action: string;
  target_type: string;
  target_ref: string;
  reason: string;
  metadata: string;
}

interface DashboardProjection {
  schema_version: number;
  metric_key: string;
  metric_value: string;
  status: string;
  owner_notice: string;
  as_of: string;
  details: string;
}

interface Snapshot {
  inventory: InventoryProjection[];
  orders: OrderProjection[];
  payments: PaymentProjection[];
  fulfillment: FulfillmentProjection[];
  warrantySupport: SupportProjection[];
  suppliers: SupplierProjection[];
  requests: RequestProjection[];
  audit: AuditProjection[];
  dashboard: DashboardProjection[];
  outboxEventId: string | null;
}

interface DateLike {
  toISOString?: () => string;
}

function iso(value: DateLike | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return new Date(value).toISOString();
  return value.toISOString ? value.toISOString() : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function safeCell(value: unknown): SheetValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    try {
      assertSafeSheetValue(value);
      return value;
    } catch {
      return "[redacted]";
    }
  }
  try {
    const safe = assertSafeSheetValue(value);
    return JSON.stringify(safe) ?? "";
  } catch {
    return "[redacted]";
  }
}

function customerRef(id: unknown): string {
  const value = text(id);
  return value ? `CUS-${value.slice(-8).toUpperCase()}` : "";
}

export function operationalLink(baseUrl: string, kind: string, id: string): string {
  const base = baseUrl.replace(/\/$/u, "");
  return `${base}/health?ops=${encodeURIComponent(`${kind}:${id}`)}`;
}

function columnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function managedColumnCount(tab: GoogleSheetsTab): number {
  return SHEET_HEADERS[tab].length;
}

function tabRange(tab: GoogleSheetsTab): string {
  return `${tab}!A:Z`;
}

function rowFromObject(tab: GoogleSheetsTab, row: object): SheetValue[] {
  return SHEET_HEADERS[tab].map((header) => safeCell((row as Record<string, unknown>)[header]));
}

function blankManagedRow(tab: GoogleSheetsTab): SheetValue[] {
  return new Array<SheetValue>(managedColumnCount(tab)).fill(null);
}

function stableKeyAt(tab: GoogleSheetsTab, row: readonly SheetValue[] | undefined): string | null {
  if (tab === "Suppliers") {
    const supplierSkuIndex = SHEET_HEADERS.Suppliers.indexOf("supplier_sku_id");
    const supplierIdIndex = SHEET_HEADERS.Suppliers.indexOf("supplier_id");
    const supplierSkuId = row?.[supplierSkuIndex];
    if (typeof supplierSkuId === "string" && supplierSkuId.trim()) {
      return `sku:${supplierSkuId.trim()}`;
    }
    const supplierId = row?.[supplierIdIndex];
    return typeof supplierId === "string" && supplierId.trim()
      ? `supplier:${supplierId.trim()}`
      : null;
  }
  const value = row?.[SHEET_HEADERS[tab].indexOf(rowKeyHeader(tab))];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalRows<T extends Record<string, unknown>>(
  tab: GoogleSheetsTab,
  rows: readonly T[],
  oldCount: number,
): SheetValue[][] {
  const result = [
    SHEET_HEADERS[tab].map((header) => safeCell(header)),
    ...rows.map((row) => rowFromObject(tab, row)),
  ];
  while (result.length < oldCount + 1) result.push(blankManagedRow(tab));
  return result;
}

interface ProjectionWritePlan {
  writes: SheetValueRange[];
  orphanCount: number;
}

function desiredRowsByKey<T extends object>(
  tab: GoogleSheetsTab,
  rows: readonly T[],
): Map<string, T> {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = rowKey(tab, row as Record<string, unknown>);
    if (byKey.has(key)) throw new Error(`duplicate ${tab} stable key`);
    byKey.set(key, row);
  }
  return byKey;
}

function buildSystemProjectionPlan<T extends object>(
  tab: GoogleSheetsTab,
  desiredRows: readonly T[],
  present: readonly (readonly SheetValue[])[],
): ProjectionWritePlan {
  const byKey = desiredRowsByKey(tab, desiredRows);
  const used = new Set<string>();
  const values = [SHEET_HEADERS[tab].map((header) => safeCell(header))];
  let orphanCount = 0;

  for (const existing of present.slice(1)) {
    const key = stableKeyAt(tab, existing);
    const desired = key ? byKey.get(key) : undefined;
    if (key && desired && !used.has(key)) {
      values.push(rowFromObject(tab, desired));
      used.add(key);
      continue;
    }
    if (key) orphanCount += 1;
    values.push(blankManagedRow(tab));
  }
  for (const row of desiredRows) {
    const key = rowKey(tab, row as Record<string, unknown>);
    if (!used.has(key)) {
      values.push(rowFromObject(tab, row));
      used.add(key);
    }
  }

  return {
    writes: [
      {
        range: `${tab}!A1:${columnLabel(managedColumnCount(tab) - 1)}${values.length}`,
        values,
      },
    ],
    orphanCount,
  };
}

function buildRequestsProjectionPlan(
  desiredRows: readonly RequestProjection[],
  present: readonly (readonly SheetValue[])[],
): ProjectionWritePlan {
  const tab = "Requests" as const;
  const byKey = desiredRowsByKey(tab, desiredRows);
  const used = new Set<string>();
  const existingCount = Math.max(0, present.length - 1);
  const systemValues: SheetValue[][] = [];
  let orphanCount = 0;

  for (const existing of present.slice(1)) {
    const key = stableKeyAt(tab, existing);
    const desired = key ? byKey.get(key) : undefined;
    if (key && desired && !used.has(key)) {
      systemValues.push(rowFromObject(tab, desired).slice(8));
      used.add(key);
      continue;
    }
    if (key) orphanCount += 1;
    systemValues.push(
      Array.from(
        { length: managedColumnCount(tab) - 8 },
        (_, index) => existing[8 + index] ?? null,
      ),
    );
  }

  const appended = desiredRows
    .filter((row) => !used.has(row.request_id))
    .map((row) => rowFromObject(tab, row));
  const writes: SheetValueRange[] = [
    {
      range: "Requests!A1:L1",
      values: [SHEET_HEADERS.Requests.map((header) => safeCell(header))],
    },
  ];
  if (existingCount > 0) {
    writes.push({ range: `Requests!I2:L${existingCount + 1}`, values: systemValues });
  }
  if (appended.length > 0) {
    const firstRow = existingCount + 2;
    writes.push({
      range: `Requests!A${firstRow}:L${firstRow + appended.length - 1}`,
      values: appended,
    });
  }
  return { writes, orphanCount };
}

export function buildProjectionWritePlan<T extends object>(
  tab: GoogleSheetsTab,
  desiredRows: readonly T[],
  present: readonly (readonly SheetValue[])[],
): ProjectionWritePlan {
  return tab === "Requests"
    ? buildRequestsProjectionPlan(desiredRows as unknown as readonly RequestProjection[], present)
    : buildSystemProjectionPlan(tab, desiredRows, present);
}

interface StructuralOptions {
  ownerEmail?: string;
  serviceAccountEmail?: string;
  migrateSuppliersV3?: boolean;
  removeLegacyVaultColumns?: boolean;
  legacyTabs?: readonly GoogleSheetsTab[];
  legacyVaultColumnIndices?: Partial<Record<GoogleSheetsTab, number>>;
}

function columnRangesForRole(
  tab: GoogleSheetsTab,
  role: "SYSTEM_AUTHORITATIVE" | "HUMAN_EDITABLE",
): Array<{ startColumnIndex: number; endColumnIndex: number }> {
  const roles = SHEET_COLUMN_OWNERSHIP[tab];
  const ranges: Array<{ startColumnIndex: number; endColumnIndex: number }> = [];
  let start: number | null = null;
  for (let index = 0; index <= roles.length; index += 1) {
    if (index < roles.length && roles[index] === role) {
      start ??= index;
      continue;
    }
    if (start !== null) {
      ranges.push({ startColumnIndex: start, endColumnIndex: index });
      start = null;
    }
  }
  return ranges;
}

function structuralRequests(
  sheets: readonly { sheetId: number; title: string; rowCount?: number }[],
  tabsToCreate: readonly GoogleSheetsTab[],
  includeMarker = false,
  options?: StructuralOptions,
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = tabsToCreate.map((title) => ({
    addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } },
  }));
  for (const sheet of sheets) {
    if (!(GOOGLE_SHEETS_TABS as readonly string[]).includes(sheet.title)) continue;
    const tab = sheet.title as GoogleSheetsTab;
    const columnCount = managedColumnCount(tab);
    const isLegacyTab = !options?.legacyTabs || options.legacyTabs.includes(tab);
    if (tab === "Suppliers" && options?.migrateSuppliersV3 && isLegacyTab) {
      requests.push({
        insertDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: "COLUMNS",
            startIndex: columnCount,
            endIndex: columnCount + 1,
          },
          inheritFromBefore: false,
        },
      });
    }
    if (options?.removeLegacyVaultColumns && isLegacyTab) {
      const startIndex = options.legacyVaultColumnIndices?.[tab];
      if (startIndex === undefined) {
        throw new Error(`Google Sheets workbook is missing the legacy vault column for ${tab}`);
      }
      requests.push({
        deleteDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: "COLUMNS",
            startIndex,
            endIndex: startIndex + 1,
          },
        },
      });
    }
    const systemEditors = options?.serviceAccountEmail ? [options.serviceAccountEmail] : [];
    const ownerEditors = [
      ...new Set(
        [options?.serviceAccountEmail, options?.ownerEmail].filter((email): email is string =>
          Boolean(email),
        ),
      ),
    ];
    requests.push(
      {
        updateSheetProperties: {
          properties: { sheetId: sheet.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: sheet.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: columnCount,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.9, green: 0.94, blue: 1 },
            },
          },
          fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor",
        },
      },
    );

    for (const range of columnRangesForRole(tab, "SYSTEM_AUTHORITATIVE")) {
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId: sheet.sheetId, startRowIndex: 0, ...range },
            description:
              tab === "Requests"
                ? "Request status and result columns are server-authoritative"
                : "PostgreSQL-authoritative projection; direct edits are overwritten",
            warningOnly: systemEditors.length === 0,
            ...(systemEditors.length > 0 ? { editors: { users: systemEditors } } : {}),
          },
        },
      });
    }

    if (tab === "Requests" && ownerEditors.length > 0) {
      for (const range of columnRangesForRole(tab, "HUMAN_EDITABLE")) {
        requests.push({
          addProtectedRange: {
            protectedRange: {
              range: { sheetId: sheet.sheetId, startRowIndex: 1, ...range },
              description:
                "Request input columns are editable only by the configured owner and service account",
              warningOnly: false,
              editors: { users: ownerEditors },
            },
          },
        });
      }
    }

    requests.push({
      setBasicFilter: {
        filter: {
          range: { sheetId: sheet.sheetId, startRowIndex: 0, endColumnIndex: columnCount },
        },
      },
    });
    if (tab === "Requests") {
      requests.push({
        setDataValidation: {
          range: {
            sheetId: sheet.sheetId,
            startRowIndex: 1,
            startColumnIndex: 3,
            endRowIndex: 10_000,
            endColumnIndex: 4,
          },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: [
                "ADD_INVENTORY_METADATA",
                "UPDATE_COST",
                "UPDATE_SAFE_NOTE",
                "DISABLE_ASSET",
                "ENABLE_ASSET",
                "MARK_ASSET_REVIEW",
                "REQUEST_SUPPORT_REVIEW",
              ].map((userEnteredValue) => ({ userEnteredValue })),
            },
            strict: true,
            showCustomUi: true,
          },
        },
      });
    }
  }
  if (includeMarker) {
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: "tier20_google_sheets_schema",
          metadataValue: String(GOOGLE_SHEETS_SCHEMA_VERSION),
          visibility: "DOCUMENT",
          location: { spreadsheet: true },
        },
      },
    });
  }
  return requests;
}

export const buildCanonicalSheetRows = canonicalRows;
export const buildWorkbookStructureRequests = structuralRequests;

const PROJECTION_PAGE_SIZE = 500;

async function readProjectionPages<T, C>(
  readPage: (cursor: C | null) => Promise<readonly T[]>,
  nextCursor: (row: T) => C,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: C | null = null;
  while (true) {
    const page = await readPage(cursor);
    rows.push(...page);
    if (page.length < PROJECTION_PAGE_SIZE) return rows;
    cursor = nextCursor(page[page.length - 1]!);
  }
}

async function readSnapshot(db: Db, config: SheetsProjectionConfig, now: Date): Promise<Snapshot> {
  const inventoryRows = await readProjectionPages<InventoryProjection, { at: string; id: string }>(
    (cursor) => {
      const after = cursor ? sql`where (a.created_at, a.id) > (${cursor.at}, ${cursor.id})` : sql``;
      return sql<InventoryProjection>`
        select a.id as asset_id,
               right(a.id, 8) as asset_code,
               p.name_vi as product,
               v.name_vi as variant,
               a.status,
               a.source_type,
               coalesce(a.region, '') as region,
               coalesce(a.masked_login, '') as masked_login,
               a.fingerprint_hash as fingerprint,
               coalesce(m.cost_price_vnd, ss.cost_vnd)::text as cost_price_vnd,
               a.created_at as added_at,
               case when a.status = 'RESERVED' then a.updated_at end as reserved_at,
               case when a.status = 'READY' then a.updated_at end as ready_at,
               case when a.status = 'DELIVERED' then a.updated_at end as delivered_at,
               case when ro.completed_at is not null and ro.warranty_days > 0
                 then ro.completed_at + (ro.warranty_days || ' days')::interval end as warranty_until,
               case when a.status in ('COMPROMISED','REVOKED','FAILED','SUPPLIER_NEEDS_REVIEW')
                         or coalesce(m.operational_status, 'ACTIVE') = 'REVIEW'
                    then 'REVIEW' else 'OK' end as health,
               coalesce(m.safe_note, '') as safe_note
          from digital_asset a
          join product_variant v on v.id = a.variant_id
          join product p on p.id = v.product_id
          left join supplier_sku ss on ss.id = v.supplier_sku_id
          left join google_sheets_asset_metadata m on m.asset_id = a.id
          left join "order" ro on ro.id = a.delivered_order_id or ro.id = a.reserved_order_id
          ${after}
         order by a.created_at, a.id
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.added_at, id: row.asset_id }),
  );
  const inventory = inventoryRows.map((row) => ({
    ...row,
    added_at: iso(row.added_at) ?? now.toISOString(),
    reserved_at: iso(row.reserved_at),
    ready_at: iso(row.ready_at),
    delivered_at: iso(row.delivered_at),
    warranty_until: iso(row.warranty_until),
    masked_login: row.masked_login,
    fingerprint: row.fingerprint.slice(0, 16),
  }));

  const orderRows = await readProjectionPages<OrderProjection, { at: string; id: string }>(
    (cursor) => {
      const before = cursor
        ? sql`where (o.created_at, o.id) < (${cursor.at}, ${cursor.id})`
        : sql``;
      return sql<OrderProjection>`
        select o.id as order_id, o.order_number, o.created_at,
               o.customer_id, o.product_name_vi as product, o.variant_name_vi as variant,
               o.price_vnd::text as amount_vnd,
               coalesce((select pi.status from payment_intent pi where pi.order_id = o.id order by pi.created_at desc, pi.id desc limit 1), 'NONE') as payment_status,
               o.status as order_status, o.fulfillment_type, o.paid_at, o.completed_at,
               case when o.completed_at is not null and o.warranty_days > 0
                 then o.completed_at + (o.warranty_days || ' days')::interval end as warranty_until
          from "order" o
          ${before}
         order by o.created_at desc, o.id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.created_at, id: row.order_id }),
  );
  const orders = orderRows.map((row) => ({
    ...row,
    customer_ref: customerRef(row.customer_id),
    created_at: iso(row.created_at) ?? now.toISOString(),
    paid_at: iso(row.paid_at),
    completed_at: iso(row.completed_at),
    warranty_until: iso(row.warranty_until),
  }));

  const paymentRows = await readProjectionPages<PaymentProjection, { at: string; id: string }>(
    (cursor) => {
      const before = cursor
        ? sql`where (i.created_at, i.id) < (${cursor.at}, ${cursor.id})`
        : sql``;
      return sql<PaymentProjection>`
        select i.id as payment_intent_id, i.order_id, o.order_number, i.amount_vnd::text,
               i.status,
               coalesce((select sum(a.allocated_amount_vnd) from payment_allocation a where a.payment_intent_id = i.id and a.status = 'SETTLED'), 0)::text as allocated_amount_vnd,
               coalesce((select d.status from discrepancy d where d.payment_intent_id = i.id and d.resolved_at is null order by d.id desc limit 1), '') as discrepancy_status,
               i.created_at, i.settled_at
          from payment_intent i join "order" o on o.id = i.order_id
          ${before}
         order by i.created_at desc, i.id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.created_at, id: row.payment_intent_id }),
  );
  const payments = paymentRows.map((row) => ({
    ...row,
    created_at: iso(row.created_at) ?? now.toISOString(),
    settled_at: iso(row.settled_at),
  }));

  const fulfillmentRows = await readProjectionPages<
    FulfillmentProjection & { cursor_at: string },
    { at: string; id: string }
  >(
    (cursor) => {
      const before = cursor
        ? sql`where (o.created_at, o.id) < (${cursor.at}, ${cursor.id})`
        : sql``;
      return sql<FulfillmentProjection & { cursor_at: string }>`
        select o.id as order_id, o.order_number, o.fulfillment_type, o.created_at as cursor_at,
               coalesce(db.status, mft.status, so.status, o.status) as status,
               coalesce(right(da.id, 8), '') as asset_code,
               coalesce(so.id, '') as supplier_order_id,
               coalesce(mft.id, '') as manual_task_id,
               coalesce(db.consumed_at, mft.completed_at, o.completed_at) as delivered_at,
               case when o.status in ('FULFILLMENT_NEEDS_REVIEW','PAYMENT_NEEDS_REVIEW') then o.status else '' end as review_reason
          from "order" o
          left join lateral (select status, consumed_at, asset_id from delivery_bundle where order_id = o.id order by created_at desc, id desc limit 1) db on true
          left join digital_asset da on da.id = db.asset_id
          left join lateral (select id, status, completed_at from manual_fulfillment_task where order_id = o.id order by created_at desc, id desc limit 1) mft on true
          left join lateral (select id, status from supplier_order where order_id = o.id order by id desc limit 1) so on true
          ${before}
         order by o.created_at desc, o.id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.cursor_at, id: row.order_id }),
  );
  const fulfillment = fulfillmentRows.map((row) => ({
    order_id: row.order_id,
    order_number: row.order_number,
    fulfillment_type: row.fulfillment_type,
    status: row.status,
    asset_code: row.asset_code,
    supplier_order_id: row.supplier_order_id,
    manual_task_id: row.manual_task_id,
    delivered_at: iso(row.delivered_at),
    review_reason: row.review_reason,
  }));

  const supportRows = await readProjectionPages<SupportProjection, { at: string; id: string }>(
    (cursor) => {
      const before = cursor
        ? sql`where (created_at, record_id) < (${cursor.at}, ${cursor.id})`
        : sql``;
      return sql<SupportProjection>`
        select *
          from (
            select 'WarrantyClaim'::text as record_type, c.id as record_id, c.claim_number as record_number,
                   c.order_id, c.customer_id, c.status, c.issue_type as reason,
                   coalesce(c.customer_note, '') as safe_summary, c.review_sla_due_at as sla_due_at,
                   c.created_at, c.updated_at
              from warranty_claim c
            union all
            select 'SupportTicket'::text, t.id, '', coalesce(t.order_id, ''), t.customer_id, t.status,
                   t.reason_code, t.safe_summary, t.due_at, t.created_at, t.updated_at
              from support_ticket t
          ) support_rows
          ${before}
         order by created_at desc, record_id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.created_at, id: row.record_id }),
  );
  const warrantySupport = supportRows.map((row) => ({
    ...row,
    customer_ref: customerRef(row.customer_id),
    sla_due_at: iso(row.sla_due_at),
    created_at: iso(row.created_at) ?? now.toISOString(),
    updated_at: iso(row.updated_at) ?? now.toISOString(),
  }));

  const supplierRows = await readProjectionPages<
    SupplierProjection & { cursor_supplier_id: string; cursor_sku_id: string },
    { supplierId: string; skuId: string }
  >(
    (cursor) => {
      const after = cursor
        ? sql`where (s.id, coalesce(ss.id, '')) > (${cursor.supplierId}, ${cursor.skuId})`
        : sql``;
      return sql<SupplierProjection & { cursor_supplier_id: string; cursor_sku_id: string }>`
        select s.id as supplier_id, s.name as supplier_name, s.status,
               ss.external_sku, ss.cost_vnd::text, coalesce(ss.region, '') as region,
               ss.id as supplier_sku_id,
               s.id as cursor_supplier_id, coalesce(ss.id, '') as cursor_sku_id,
               coalesce(so.id, '') as supplier_order_id, coalesce(so.status, '') as supplier_order_status,
               coalesce(so.last_queried_at, ss.last_verified_at, s.created_at) as updated_at
          from supplier s
          left join supplier_sku ss on ss.supplier_id = s.id
          left join lateral (select id, status, last_queried_at from supplier_order where supplier_sku_id = ss.id order by id desc limit 1) so on true
          ${after}
         order by s.id, coalesce(ss.id, '')
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ supplierId: row.cursor_supplier_id, skuId: row.cursor_sku_id }),
  );
  const suppliers = supplierRows.map((row) => ({
    ...row,
    updated_at: iso(row.updated_at) ?? now.toISOString(),
  }));

  const requestRows = await readProjectionPages<RequestProjection, { at: string; id: string }>(
    (cursor) => {
      const before = cursor
        ? sql`where (requested_at, request_id) < (${cursor.at}, ${cursor.id})`
        : sql``;
      return sql<RequestProjection>`
        select request_id, requested_at, requested_by, requested_action as action, target_type,
               target_ref, expected_version, safe_payload::text as payload, status,
               coalesce(result_code, '') as result_code, coalesce(result_note, '') as result_note, processed_at
          from google_sheets_request
          ${before}
         order by requested_at desc, request_id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.requested_at, id: row.request_id }),
  );
  const requests = requestRows.map((row) => ({
    ...row,
    requested_at: iso(row.requested_at) ?? now.toISOString(),
    processed_at: iso(row.processed_at),
  }));

  const auditRows = await readProjectionPages<AuditProjection, { at: string; id: string }>(
    (cursor) => {
      const before = cursor ? sql`where (occurred_at, id) < (${cursor.at}, ${cursor.id})` : sql``;
      return sql<AuditProjection>`
        select id as audit_id, occurred_at, actor_type,
               case when actor_id is null then '' else 'actor-' || right(actor_id, 4) end as actor_ref,
               action, target_type, target_id as target_ref, reason, metadata_redacted::text as metadata
          from audit_event
          ${before}
         order by occurred_at desc, id desc
         limit ${PROJECTION_PAGE_SIZE}
      `
        .execute(db)
        .then((result) => result.rows);
    },
    (row) => ({ at: row.occurred_at, id: row.audit_id }),
  );
  const audit = auditRows.map((row) => ({
    ...row,
    occurred_at: iso(row.occurred_at) ?? now.toISOString(),
  }));

  const dashboardMetrics = await sql<{
    metric_key: string;
    metric_value: string;
    status: string;
    details: string;
  }>`
    select metric_key, metric_value, status, details
      from (
        select 'orders_pending_payment' as metric_key,
               count(*) filter (where status = 'PENDING_PAYMENT')::text as metric_value,
               case when count(*) filter (where status = 'PENDING_PAYMENT') > 50 then 'ATTENTION' else 'OK' end as status,
               'Orders awaiting VietQR payment' as details
          from "order"
        union all
        select 'orders_payment_stuck', count(*) filter (where status = 'PENDING_PAYMENT' and created_at < now() - interval '15 minutes')::text,
               case when count(*) filter (where status = 'PENDING_PAYMENT' and created_at < now() - interval '15 minutes') > 0 then 'ATTENTION' else 'OK' end,
               'Orders awaiting payment beyond the operational threshold' from "order"
        union all
        select 'orders_fulfillment_stuck', count(*) filter (where status in ('PROCESSING','FULFILLMENT_NEEDS_REVIEW','PAYMENT_NEEDS_REVIEW') and updated_at < now() - interval '15 minutes')::text,
               case when count(*) filter (where status in ('PROCESSING','FULFILLMENT_NEEDS_REVIEW','PAYMENT_NEEDS_REVIEW') and updated_at < now() - interval '15 minutes') > 0 then 'ATTENTION' else 'OK' end,
               'Orders in a fulfillment or payment review state beyond the operational threshold' from "order"
        union all
        select 'assets_reserved_stuck', count(*) filter (where status = 'RESERVED' and updated_at < now() - interval '30 minutes')::text,
               case when count(*) filter (where status = 'RESERVED' and updated_at < now() - interval '30 minutes') > 0 then 'ATTENTION' else 'OK' end,
               'Reserved assets held beyond the operational threshold' from digital_asset
        union all
        select 'payments_needs_review', count(*) filter (where status = 'NEEDS_REVIEW')::text,
               case when count(*) filter (where status = 'NEEDS_REVIEW') > 0 then 'ATTENTION' else 'OK' end,
               'Payment evidence requiring owner review' from payment_intent
        union all
        select 'open_discrepancies', count(*) filter (where resolved_at is null)::text,
               case when count(*) filter (where resolved_at is null) > 0 then 'ATTENTION' else 'OK' end,
               'Unresolved payment discrepancies' from discrepancy
        union all
        select 'inventory_review', count(*) filter (where status in ('COMPROMISED','REVOKED','FAILED','SUPPLIER_NEEDS_REVIEW'))::text,
               case when count(*) filter (where status in ('COMPROMISED','REVOKED','FAILED','SUPPLIER_NEEDS_REVIEW')) > 0 then 'ATTENTION' else 'OK' end,
               'Assets not safe for normal sale' from digital_asset
        union all
        select 'support_open', count(*) filter (where status not in ('CLOSED','RESOLVED'))::text,
               case when count(*) filter (where status not in ('CLOSED','RESOLVED')) > 0 then 'ATTENTION' else 'OK' end,
               'Open support tickets' from support_ticket
        union all
        select 'warranty_open', count(*) filter (where status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID'))::text,
               case when count(*) filter (where status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID')) > 0 then 'ATTENTION' else 'OK' end,
               'Open warranty claims' from warranty_claim
        union all
        select 'outbox_dead', count(*) filter (where dead_lettered_at is not null and published_at is null)::text,
               case when count(*) filter (where dead_lettered_at is not null and published_at is null) > 0 then 'ATTENTION' else 'OK' end,
               'Dead-lettered asynchronous events' from outbox_event
      ) metrics
  `.execute(db);

  const state = await sql<{
    last_outbox_event_id: string | null;
    last_success_at: Date | string | null;
    last_error_code: string | null;
    last_error_note: string | null;
    last_rows_written: number;
    last_orphan_count: number;
  }>`
    select last_outbox_event_id, last_success_at, last_error_code, last_error_note,
           last_rows_written, last_orphan_count
      from google_sheets_sync_state
     where id = 'main'
  `.execute(db);
  const syncState = state.rows[0];
  const cursorId = syncState?.last_outbox_event_id ?? null;
  const outbox = await sql<{ id: string }>`
    with cursor_event as (
      select id as cursor_id, occurred_at as cursor_occurred_at
        from outbox_event
       where id = ${cursorId}
    )
    select e.id
      from outbox_event e
      left join cursor_event c on true
     where ${cursorId}::text is null
        or c.cursor_id is null
        or (e.occurred_at, e.id) > (c.cursor_occurred_at, c.cursor_id)
     order by e.occurred_at desc, e.id desc
     limit 1
  `.execute(db);

  const asOf = now.toISOString();
  const syncStatus = syncState?.last_error_code
    ? "ATTENTION"
    : syncState?.last_success_at
      ? "OK"
      : "STALE";
  const dashboard: DashboardProjection[] = [
    {
      schema_version: GOOGLE_SHEETS_SCHEMA_VERSION,
      metric_key: "workbook_status",
      metric_value: "POSTGRESQL_AUTHORITATIVE",
      status: "OK",
      owner_notice: `Only configured Sheets owner ${config.ownerId} may submit Requests; direct edits are overwritten.`,
      as_of: asOf,
      details: operationalLink(config.appBaseUrl, "dashboard", "main"),
    },
    {
      schema_version: GOOGLE_SHEETS_SCHEMA_VERSION,
      metric_key: "sheets_sync_status",
      metric_value: syncStatus,
      status: syncStatus,
      owner_notice: `Only configured Sheets owner ${config.ownerId} may submit Requests; direct edits are overwritten.`,
      as_of: asOf,
      details: syncState
        ? `last_success=${iso(syncState.last_success_at) ?? "never"}; rows=${syncState.last_rows_written}; orphans=${syncState.last_orphan_count}; error=${syncState.last_error_code ?? "none"}${syncState.last_error_note ? ` (${syncState.last_error_note})` : ""}`
        : "sync state unavailable",
    },
    ...dashboardMetrics.rows.map((row) => ({
      schema_version: GOOGLE_SHEETS_SCHEMA_VERSION,
      metric_key: row.metric_key,
      metric_value: row.metric_value,
      status: row.status,
      owner_notice: `Only configured Sheets owner ${config.ownerId} may submit Requests; direct edits are overwritten.`,
      as_of: asOf,
      details: row.details,
    })),
  ];

  return {
    inventory,
    orders,
    payments,
    fulfillment,
    warrantySupport,
    suppliers,
    requests,
    audit,
    dashboard,
    outboxEventId: outbox.rows[0]?.id ?? state.rows[0]?.last_outbox_event_id ?? null,
  };
}

function rowsForSnapshot(
  snapshot: Snapshot,
): Record<GoogleSheetsTab, readonly Record<string, unknown>[]> {
  return {
    Dashboard: snapshot.dashboard.map((row) => ({ ...row })),
    Inventory: snapshot.inventory.map((row) => ({ ...row })),
    Orders: snapshot.orders.map((row) => ({ ...row })),
    Payments: snapshot.payments.map((row) => ({ ...row })),
    Fulfillment: snapshot.fulfillment.map((row) => ({ ...row })),
    Warranty_Support: snapshot.warrantySupport.map((row) => ({ ...row })),
    Suppliers: snapshot.suppliers.map((row) => ({ ...row })),
    Requests: snapshot.requests.map((row) => ({ ...row })),
    Audit: snapshot.audit.map((row) => ({ ...row })),
  };
}

function existingValuesByTab(
  values: readonly SheetValueRange[],
): Map<GoogleSheetsTab, readonly (readonly SheetValue[])[]> {
  const map = new Map<GoogleSheetsTab, readonly (readonly SheetValue[])[]>();
  for (const entry of values) {
    const tab = entry.range.split("!")[0] as GoogleSheetsTab;
    if ((GOOGLE_SHEETS_TABS as readonly string[]).includes(tab)) map.set(tab, entry.values);
  }
  return map;
}

type HeaderMigration = {
  legacyVaultColumnIndex?: number;
  migrateSuppliersV3: boolean;
};

const LEGACY_VAULT_HEADERS: Record<string, true> = {
  vault_ref: true,
  credential_vault_ref: true,
};

function sameHeaders(actual: readonly SheetValue[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((header, index) => actual[index] === header)
  );
}

function headerWithoutColumn(headers: readonly SheetValue[], columnIndex: number): SheetValue[] {
  return [...headers.slice(0, columnIndex), ...headers.slice(columnIndex + 1)];
}

function findLegacyVaultColumn(
  headers: readonly SheetValue[],
  expectedWithoutVault: readonly string[],
): number | null {
  let match: number | null = null;
  for (const [index, value] of headers.entries()) {
    if (typeof value !== "string" || !LEGACY_VAULT_HEADERS[value]) continue;
    if (!sameHeaders(headerWithoutColumn(headers, index), expectedWithoutVault)) continue;
    if (match !== null) return null;
    match = index;
  }
  return match;
}

function recognizeHeaderShape(
  tab: GoogleSheetsTab,
  headers: readonly SheetValue[],
): HeaderMigration | null {
  if (sameHeaders(headers, SHEET_HEADERS[tab])) {
    return { migrateSuppliersV3: false };
  }
  if (tab === "Inventory") {
    const legacyVaultColumnIndex = findLegacyVaultColumn(headers, SHEET_HEADERS.Inventory);
    return legacyVaultColumnIndex === null
      ? null
      : { legacyVaultColumnIndex, migrateSuppliersV3: false };
  }
  if (tab === "Suppliers") {
    const legacyVaultColumnIndex = findLegacyVaultColumn(headers, SHEET_HEADERS.Suppliers);
    if (legacyVaultColumnIndex !== null) {
      return { legacyVaultColumnIndex, migrateSuppliersV3: false };
    }
    const legacyV3Headers = SHEET_HEADERS.Suppliers.slice(0, -1);
    const legacyV3VaultColumnIndex = findLegacyVaultColumn(headers, legacyV3Headers);
    return legacyV3VaultColumnIndex === null
      ? null
      : { legacyVaultColumnIndex: legacyV3VaultColumnIndex, migrateSuppliersV3: true };
  }
  return null;
}

function inspectManagedHeaders(
  tabs: readonly GoogleSheetsTab[],
  values: readonly SheetValueRange[],
): {
  legacyTabs: GoogleSheetsTab[];
  legacyVaultColumnIndices: Partial<Record<GoogleSheetsTab, number>>;
  migrateSuppliersV3: boolean;
} {
  const rowsByTab = new Map<GoogleSheetsTab, readonly SheetValue[]>();
  for (const entry of values) {
    const separator = entry.range.indexOf("!");
    if (separator < 0) continue;
    const tab = entry.range.slice(0, separator);
    if (!(GOOGLE_SHEETS_TABS as readonly string[]).includes(tab)) continue;
    const row = entry.values[0];
    rowsByTab.set(tab as GoogleSheetsTab, row ?? []);
  }

  const legacyTabs: GoogleSheetsTab[] = [];
  const legacyVaultColumnIndices: Partial<Record<GoogleSheetsTab, number>> = {};
  let migrateSuppliersV3 = false;
  for (const tab of tabs) {
    const migration = recognizeHeaderShape(tab, rowsByTab.get(tab) ?? []);
    if (!migration) {
      throw new Error(`Google Sheets ${tab} header schema is not recognized`);
    }
    if (migration.legacyVaultColumnIndex !== undefined) {
      legacyTabs.push(tab);
      legacyVaultColumnIndices[tab] = migration.legacyVaultColumnIndex;
      migrateSuppliersV3 ||= migration.migrateSuppliersV3;
    }
  }
  return { legacyTabs, legacyVaultColumnIndices, migrateSuppliersV3 };
}

export function buildGridExpansionRequests(
  sheets: readonly { sheetId: number; title: string; rowCount?: number }[],
  desiredRowCounts: Readonly<Partial<Record<GoogleSheetsTab, number>>>,
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  for (const tab of GOOGLE_SHEETS_TABS) {
    const desiredRowCount = desiredRowCounts[tab];
    if (desiredRowCount === undefined) continue;
    const sheet = sheets.find((candidate) => candidate.title === tab);
    if (!sheet) throw new Error(`Google Sheets workbook is missing managed tab ${tab}`);
    if (sheet.rowCount === undefined) {
      throw new Error(`Google Sheets workbook is missing rowCount metadata for ${tab}`);
    }
    if (sheet.rowCount >= desiredRowCount) continue;
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheet.sheetId,
          gridProperties: { rowCount: desiredRowCount },
        },
        fields: "gridProperties.rowCount",
      },
    });
  }
  return requests;
}

export async function ensureGoogleSheetsWorkbook(input: {
  api: GoogleSheetsApi;
  config: SheetsProjectionConfig;
}): Promise<void> {
  const before = await input.api.getSpreadsheet({ spreadsheetId: input.config.spreadsheetId });
  const existingTitles = new Set(before.sheets.map((sheet) => sheet.title));
  const existingManagedTabs = GOOGLE_SHEETS_TABS.filter((tab) => existingTitles.has(tab));
  const missing = GOOGLE_SHEETS_TABS.filter((tab) => !existingTitles.has(tab));
  const observedSchemaVersions = before.developerMetadata
    .filter(
      (entry) =>
        entry.locationType === "SPREADSHEET" && entry.metadataKey === "tier20_google_sheets_schema",
    )
    .map((entry) => Number(entry.metadataValue))
    .filter((version) => Number.isInteger(version));
  if (observedSchemaVersions.some((version) => version > GOOGLE_SHEETS_SCHEMA_VERSION)) {
    throw new Error("Google Sheets workbook schema is newer than this worker");
  }
  const knownSchemaVersions = observedSchemaVersions.filter(
    (version): version is 3 | 4 | 5 => version === 3 || version === 4 || version === 5,
  );
  const highestKnownSchemaVersion = Math.max(0, ...knownSchemaVersions);
  const schemaReady = highestKnownSchemaVersion === GOOGLE_SHEETS_SCHEMA_VERSION;
  const headerValues =
    existingManagedTabs.length > 0
      ? await input.api.batchGet({
          spreadsheetId: input.config.spreadsheetId,
          ranges: existingManagedTabs.map((tab) => `${tab}!1:1`),
        })
      : [];
  const headerMigration = inspectManagedHeaders(existingManagedTabs, headerValues);
  const needsStructuralUpdate =
    missing.length > 0 || !schemaReady || headerMigration.legacyTabs.length > 0;
  if (missing.length > 0) {
    await input.api.batchUpdate({
      spreadsheetId: input.config.spreadsheetId,
      requests: structuralRequests([], missing),
    });
  }
  const workbook = await input.api.getSpreadsheet({ spreadsheetId: input.config.spreadsheetId });
  if (needsStructuralUpdate) {
    const structural = structuralRequests(workbook.sheets, [], !schemaReady, {
      ownerEmail: input.config.ownerId,
      migrateSuppliersV3: headerMigration.migrateSuppliersV3,
      removeLegacyVaultColumns: headerMigration.legacyTabs.length > 0,
      legacyTabs: headerMigration.legacyTabs,
      legacyVaultColumnIndices: headerMigration.legacyVaultColumnIndices,
      ...(input.config.serviceAccountEmail
        ? { serviceAccountEmail: input.config.serviceAccountEmail }
        : {}),
    });
    if (structural.length > 0) {
      await input.api.batchUpdate({
        spreadsheetId: input.config.spreadsheetId,
        requests: structural,
      });
    }
  }
}

interface ReconcileOptions {
  structureReady?: boolean;
}

export async function reconcileGoogleSheetsOnce(
  input: {
    db: Db;
    api: GoogleSheetsApi;
    config: SheetsProjectionConfig;
    now?: Date;
  },
  options: ReconcileOptions = {},
): Promise<{ rowsWritten: number; orphanCount: number; outboxEventId: string | null }> {
  if (!options.structureReady) await ensureGoogleSheetsWorkbook(input);
  const now = input.now ?? new Date();

  const snapshot = await readSnapshot(input.db, input.config, now);
  const current = await input.api.batchGet({
    spreadsheetId: input.config.spreadsheetId,
    ranges: GOOGLE_SHEETS_TABS.map(tabRange),
  });
  const existing = existingValuesByTab(current);
  const rows = rowsForSnapshot(snapshot);
  const writes: SheetValueRange[] = [];
  const desiredRowCounts: Partial<Record<GoogleSheetsTab, number>> = {};
  let rowsWritten = 0;
  let orphanCount = 0;
  for (const tab of GOOGLE_SHEETS_TABS) {
    const desired = rows[tab];
    const present = existing.get(tab) ?? [];
    const plan = buildProjectionWritePlan(tab, desired, present);
    writes.push(...plan.writes);
    desiredRowCounts[tab] = desired.length + 1;
    rowsWritten += desired.length;
    orphanCount += plan.orphanCount;
  }
  const workbook = await input.api.getSpreadsheet({ spreadsheetId: input.config.spreadsheetId });
  const gridExpansion = buildGridExpansionRequests(workbook.sheets, desiredRowCounts);
  if (gridExpansion.length > 0) {
    await input.api.batchUpdate({
      spreadsheetId: input.config.spreadsheetId,
      requests: gridExpansion,
    });
  }
  await input.api.batchUpdateValues({ spreadsheetId: input.config.spreadsheetId, data: writes });
  await sql`
    update google_sheets_sync_state
       set last_attempt_at = now(), last_success_at = now(),
           last_outbox_event_id = ${snapshot.outboxEventId},
           last_error_code = null, last_error_note = null,
           last_rows_written = ${rowsWritten}, last_orphan_count = ${orphanCount},
           version = version + 1
     where id = 'main'
  `.execute(input.db);
  return { rowsWritten, orphanCount, outboxEventId: snapshot.outboxEventId };
}

function rowKeyHeader(tab: GoogleSheetsTab): string {
  switch (tab) {
    case "Inventory":
      return "asset_id";
    case "Orders":
    case "Fulfillment":
      return "order_id";
    case "Payments":
      return "payment_intent_id";
    case "Suppliers":
      return "supplier_sku_id";
    case "Requests":
      return "request_id";
    case "Audit":
      return "audit_id";
    case "Warranty_Support":
      return "record_id";
    default:
      return "metric_key";
  }
}

const SHEETS_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "NETWORK",
  "AUTH",
  "PERMISSION_DENIED",
  "INVALID_REQUEST",
  "UNKNOWN",
  "CONFIGURATION",
]);

export async function recordSheetsSyncFailure(db: Db, errorCode: string): Promise<void> {
  const safeCode = SHEETS_ERROR_CODES.has(errorCode) ? errorCode : "UNKNOWN";
  await sql`
    update google_sheets_sync_state
       set last_attempt_at = now(), last_error_code = ${safeCode},
           last_error_note = 'unavailable', version = version + 1
     where id = 'main'
  `.execute(db);
}
