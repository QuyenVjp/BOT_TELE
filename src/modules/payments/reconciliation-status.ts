import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

export const SEPAY_RECONCILIATION_STALE_AFTER_MS = 15 * 60_000;

export interface SePayReconciliationStatus {
  stale: boolean;
  lastSuccessAt: Date | null;
  minutesLate: number | null;
  lastErrorClass: string | null;
  lastProviderCursor: string | null;
  consecutiveFailures: number;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export async function getSePayReconciliationStatus(
  db: Executor,
  now: Date = new Date(),
): Promise<SePayReconciliationStatus> {
  const result = await sql<{
    last_success_at: Date | string | null;
    last_error_class: string | null;
    last_provider_cursor: string | null;
    consecutive_failures: number;
  }>`
    select last_success_at, last_error_class, last_provider_cursor, consecutive_failures
    from sepay_reconciliation_cursor
    where provider = 'sepay'
    limit 1
  `.execute(db);
  const row = result.rows[0];
  const lastSuccessAt = asDate(row?.last_success_at);
  const ageMs = lastSuccessAt ? Math.max(0, now.getTime() - lastSuccessAt.getTime()) : null;
  const stale =
    lastSuccessAt === null || (ageMs !== null && ageMs > SEPAY_RECONCILIATION_STALE_AFTER_MS);
  return {
    stale,
    lastSuccessAt,
    minutesLate: ageMs === null ? null : Math.floor(ageMs / 60_000),
    lastErrorClass: row?.last_error_class ?? null,
    lastProviderCursor: row?.last_provider_cursor ?? null,
    consecutiveFailures: row?.consecutive_failures ?? 0,
  };
}

export function formatSePayReconciliationAdminText(status: SePayReconciliationStatus): string {
  if (!status.stale) return "✅ Đối soát bình thường";
  if (status.lastSuccessAt === null) return "⚠️ Đối soát SePay đã trễ (chưa có lần thành công).";
  const minutes = Math.max(1, status.minutesLate ?? 1);
  return `⚠️ Đối soát SePay đã trễ ${minutes} phút.`;
}
