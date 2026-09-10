/**
 * Goal §89 — owner operations on a single stock item: quarantine, restore, revoke.
 *
 * The vocabulary reuses the statuses the schema and the sale path already understand, so no
 * migration is required and the guarantee is structural: `claimAvailableAsset` only ever selects
 * `status = 'AVAILABLE'`, so an item moved to COMPROMISED or REVOKED cannot be sold, reserved or
 * delivered by any concurrent flow.
 *
 *   quarantine : AVAILABLE           → COMPROMISED   (suspect credential, reversible)
 *   restore    : COMPROMISED         → AVAILABLE
 *   revoke     : AVAILABLE|COMPROMISED → REVOKED      (terminal)
 *
 * An item the customer's money already touches (RESERVED / READY / DELIVERED) is never mutated
 * here: those transitions belong to the order and refund flows, not to inventory hygiene.
 *
 * Secrets never appear in a projection, an audit row or a screen: an item is addressed by a
 * derived display ref, and every write is audited with counts and status names only.
 */
import { sql } from "kysely";
import { withTransaction, type Db } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import {
  authorizeRootAction,
  type RootActor,
  type RootAdminConfig,
} from "../identity/root-admin.js";

export type InventoryItemAction = "QUARANTINE" | "RESTORE" | "REVOKE";

const TRANSITIONS: Record<
  InventoryItemAction,
  { from: readonly string[]; to: "AVAILABLE" | "COMPROMISED" | "REVOKED"; audit: string }
> = {
  QUARANTINE: { from: ["AVAILABLE"], to: "COMPROMISED", audit: "inventory.item_quarantined" },
  RESTORE: { from: ["COMPROMISED"], to: "AVAILABLE", audit: "inventory.item_restored" },
  REVOKE: { from: ["AVAILABLE", "COMPROMISED"], to: "REVOKED", audit: "inventory.item_revoked" },
};

/** Human label for a stored item status. Customer-facing surfaces never use these. */
export const ITEM_STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "khả dụng",
  RESERVED: "đang giữ",
  READY: "chờ giao",
  DELIVERED: "đã giao",
  COMPROMISED: "đã cách ly",
  REVOKED: "đã thu hồi",
  SUPPLIER_NEEDS_REVIEW: "chờ kiểm tra",
  FAILED: "lỗi",
  EXPIRED: "hết hạn",
  PROVISIONING: "đang tạo",
};

export const ITEM_ACTION_LABELS: Record<InventoryItemAction, string> = {
  QUARANTINE: "🛑 Cách ly",
  RESTORE: "♻️ Phục hồi",
  REVOKE: "🗑 Thu hồi",
};

export interface InventoryItemSummary {
  /** Derived display ref. Not the primary key: screens and callbacks address items by this. */
  ref: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  /** Actions that are legal from the current status. */
  actions: InventoryItemAction[];
}

/**
 * Opaque, stable display ref for an item. Derived from the id so it survives a re-open without
 * extra state, and short enough to fit a callback payload.
 */
export function inventoryItemRef(id: string): string {
  return id.slice(-8);
}

function actionsFor(status: string): InventoryItemAction[] {
  return (Object.keys(TRANSITIONS) as InventoryItemAction[]).filter((action) =>
    TRANSITIONS[action].from.includes(status),
  );
}

export async function listInventoryItems(
  db: Db,
  input: { variantId: string; limit?: number },
): Promise<InventoryItemSummary[]> {
  const rows = await sql<{ id: string; status: string; created_at: Date | string }>`
    select id, status, created_at
    from digital_asset
    where variant_id = ${input.variantId}
    order by created_at asc, id asc
    limit ${Math.min(Math.max(input.limit ?? 20, 1), 50)}
  `.execute(db);
  return rows.rows.map((row) => ({
    ref: inventoryItemRef(row.id),
    status: row.status,
    statusLabel: ITEM_STATUS_LABELS[row.status] ?? row.status.toLowerCase(),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    actions: actionsFor(row.status),
  }));
}

export type ApplyInventoryItemResult =
  | { ok: true; ref: string; status: string; previousStatus: string; idempotent: boolean }
  | {
      ok: false;
      code:
        "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" | "INVALID_REASON" | "NOT_FOUND" | "ILLEGAL_TRANSITION";
    };

export async function applyInventoryItemAction(input: {
  db: Db;
  actor: RootActor;
  config: RootAdminConfig;
  variantId: string;
  ref: string;
  action: InventoryItemAction;
  reason: string;
  correlationId: string;
}): Promise<ApplyInventoryItemResult> {
  const auth = authorizeRootAction(input.actor, input.config);
  if (!auth.ok) return { ok: false, code: auth.reason };
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) return { ok: false, code: "INVALID_REASON" };
  const transition = TRANSITIONS[input.action];
  if (!transition) return { ok: false, code: "ILLEGAL_TRANSITION" };

  return withTransaction(input.db, async (trx) => {
    // The ref is derived from the id, so match it in SQL rather than trusting a client-supplied key.
    const found = await sql<{ id: string; status: string }>`
      select id, status
      from digital_asset
      where variant_id = ${input.variantId}
        and right(id, 8) = ${input.ref}
      limit 1
      for update
    `.execute(trx);
    const item = found.rows[0];
    if (!item) return { ok: false, code: "NOT_FOUND" };
    if (!transition.from.includes(item.status)) return { ok: false, code: "ILLEGAL_TRANSITION" };

    if (item.status === transition.to) {
      return {
        ok: true,
        ref: input.ref,
        status: item.status,
        previousStatus: item.status,
        idempotent: true,
      };
    }

    const updated = await sql<{ id: string }>`
      update digital_asset
      set status = ${transition.to}, updated_at = now(), version = version + 1
      where id = ${item.id} and status = ${item.status}
      returning id
    `.execute(trx);
    if (!updated.rows[0]) return { ok: false, code: "ILLEGAL_TRANSITION" };

    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: String(input.actor.numericUserId),
      action: transition.audit,
      targetType: "DigitalAsset",
      targetId: item.id,
      reason,
      correlationId: input.correlationId,
      metadataRedacted: {
        variantId: input.variantId,
        ref: input.ref,
        previousStatus: item.status,
        status: transition.to,
      },
    });

    return {
      ok: true,
      ref: input.ref,
      status: transition.to,
      previousStatus: item.status,
      idempotent: false,
    };
  });
}

/** Sellable items for a variant. Read-only; used by the admin summary and by tests. */
export async function countOwnerSellableItems(db: Db, variantId: string): Promise<number> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n
    from digital_asset
    where variant_id = ${variantId} and status = 'AVAILABLE'
  `.execute(db);
  return rows.rows[0]?.n ?? 0;
}
