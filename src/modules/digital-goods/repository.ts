import { sql } from "kysely";
import type { Db, Executor, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import type { AssetStatus } from "./domain.js";

/**
 * Atomic local asset reserve/claim/release (T066, FR-014, SC-006).
 *
 * Claim is the concurrency-critical write:
 *   1. short-circuit if this order already holds a reserved/ready asset
 *      (idempotent re-entry after a crash);
 *   2. lock one AVAILABLE asset of the requested variant with
 *      `FOR UPDATE SKIP LOCKED` so concurrent claims never block each other
 *      and never double-select the same row;
 *   3. flip the row to RESERVED under a version guard.
 *
 * Zero rows from step 2 → OUT_OF_STOCK. The unique active-fingerprint index is
 * the storage-layer backstop against any residual race.
 */

export type ClaimErrorCode = "OUT_OF_STOCK" | "ASSET_CONFLICT" | "NOT_FOUND";

export type ClaimResult =
  | { ok: true; assetId: string; orderId: string; vaultRef: string; fingerprintHash: string }
  | { ok: false; code: ClaimErrorCode; message: string };

export interface ClaimLocalAssetInput {
  orderId: string;
  variantId: string;
  correlationId: string;
  /** How long the reserve holds before an expiry worker may release it (default 15 min). */
  reserveTtlSeconds?: number;
}

interface AssetRow {
  id: string;
  variant_id: string;
  vault_ref: string;
  fingerprint_hash: string;
  status: AssetStatus;
  reserved_order_id: string | null;
  version: number;
}

/**
 * Atomically claim one AVAILABLE local asset for `orderId`. Concurrent callers
 * for the same variant serialize via SKIP LOCKED; exactly one wins when stock
 * is one. Safe under crash/replay: a second call for the same order returns
 * the already-held asset.
 */
export async function claimLocalAsset(db: Db, input: ClaimLocalAssetInput): Promise<ClaimResult> {
  return withTransaction(db, (trx) => claimLocalAssetInTransaction(trx, input));
}

/** Claim within an existing unit of work so callers can append the domain event atomically. */
export async function claimLocalAssetInTransaction(
  trx: Trx,
  input: ClaimLocalAssetInput,
): Promise<ClaimResult> {
  // 1. Idempotent re-entry: lock and return an asset already held by this order.
  const held = await findActiveAssetHoldByOrderForUpdate(trx, input.orderId);
  if (held) {
    return {
      ok: true,
      assetId: held.id,
      orderId: input.orderId,
      vaultRef: held.vault_ref,
      fingerprintHash: held.fingerprint_hash,
    };
  }

  // 2. Lock one AVAILABLE asset of the variant. SKIP LOCKED means a concurrent
  // claim that already holds the only row will see zero rows and lose cleanly.
  const candidate = await sql<AssetRow>`
    select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
    from digital_asset
    where variant_id = ${input.variantId}
      and status = 'AVAILABLE'
    order by created_at asc, id asc
    limit 1
    for update skip locked
  `.execute(trx);

  const row = candidate.rows[0];
  if (!row) {
    return {
      ok: false,
      code: "OUT_OF_STOCK",
      message: "Không còn tài khoản khả dụng cho sản phẩm này.",
    };
  }

  // 3. Reserve under the version we just locked.
  const ttl = input.reserveTtlSeconds ?? 900;
  const newVer = nextVersion(row.version);
  const updated = await sql`
    update digital_asset
    set status = 'RESERVED',
        reserved_order_id = ${input.orderId},
        reserved_until = now() + (${ttl} || ' seconds')::interval,
        version = ${newVer},
        updated_at = now()
    where id = ${row.id} and version = ${row.version} and status = 'AVAILABLE'
  `.execute(trx);

  if (Number(updated.numAffectedRows ?? 0) < 1) {
    return {
      ok: false,
      code: "ASSET_CONFLICT",
      message: "Tài khoản vừa được người khác nhận. Vui lòng thử lại.",
    };
  }

  return {
    ok: true,
    assetId: row.id,
    orderId: input.orderId,
    vaultRef: row.vault_ref,
    fingerprintHash: row.fingerprint_hash,
  };
}

/**
 * Typed reserve outcome (FR-006a / FR-006b). Callers MUST map each code to
 * honest copy — never collapse every failure into "someone else just took it".
 *
 * - RESERVED: this transaction holds the unit.
 * - NO_STOCK: zero AVAILABLE rows are visible (SKU was already empty, or every
 *   contender committed).
 * - CONTENTION_TIMEOUT: AVAILABLE rows existed but stayed locked by other
 *   in-flight winners for the full bounded recheck budget. The unit may free
 *   later; the customer should retry, not be told "someone just bought it".
 * - RESERVATION_LOST: a row was locked and the version-guarded UPDATE lost
 *   (should be rare under FOR UPDATE). Treated as a race loss.
 */
export type ReserveOutcome =
  | { ok: true; assetId: string; fingerprintHash: string }
  | { ok: false; reason: "NO_STOCK" | "CONTENTION_TIMEOUT" | "RESERVATION_LOST" };

export async function reserveAvailableAssetForOrder(
  exec: Executor,
  input: { variantId: string; orderId: string; reserveUntil: Date },
): Promise<ReserveOutcome> {
  // One probe per transaction. The BuyNow service retries the whole transaction
  // after rollback so backoff never occupies a connection while holding catalog
  // row locks.
  const candidate = await sql<AssetRow>`
    select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
    from digital_asset
    where variant_id = ${input.variantId}
      and status = 'AVAILABLE'
    order by created_at asc, id asc
    limit 1
    for update skip locked
  `.execute(exec);

  const row = candidate.rows[0];
  if (row) {
    const newVer = nextVersion(row.version);
    const updated = await sql`
      update digital_asset
      set status = 'RESERVED',
          reserved_order_id = ${input.orderId},
          reserved_until = ${input.reserveUntil.toISOString()},
          version = ${newVer},
          updated_at = now()
      where id = ${row.id} and version = ${row.version} and status = 'AVAILABLE'
    `.execute(exec);
    if (Number(updated.numAffectedRows ?? 0) >= 1) {
      return { ok: true, assetId: row.id, fingerprintHash: row.fingerprint_hash };
    }
    return { ok: false, reason: "RESERVATION_LOST" };
  }

  const remaining = await sql<{ n: number }>`
    select count(*)::int as n
    from digital_asset
    where variant_id = ${input.variantId} and status = 'AVAILABLE'
  `.execute(exec);
  return (remaining.rows[0]?.n ?? 0) > 0
    ? { ok: false, reason: "CONTENTION_TIMEOUT" }
    : { ok: false, reason: "NO_STOCK" };
}

/**
 * Whether `orderId` holds a VALID active pre-payment reservation for `variantId`
 * (T157 gate for Payment Intent presentation). Only a RESERVED row bound to this
 * order AND this variant AND not past `reserved_until` authorizes a fresh QR.
 * READY/DELIVERED are rejected (fulfillment already began), and an expired hold
 * is rejected so a stale reservation cannot back a QR before recovery sweeps it.
 */
export async function orderHasActiveReservation(
  exec: Executor,
  orderId: string,
  variantId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one
    from digital_asset
    where reserved_order_id = ${orderId}
      and variant_id = ${variantId}
      and status = 'RESERVED'
      and reserved_until is not null
      and reserved_until > ${now.toISOString()}
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

/** Find the deterministic active fulfillment hold for an Order. */
export async function findActiveAssetHoldByOrder(
  exec: Executor,
  orderId: string,
): Promise<AssetRow | null> {
  const result = await sql<AssetRow>`
    select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
    from digital_asset
    where reserved_order_id = ${orderId}
      and status in ('RESERVED','READY')
    order by created_at asc, id asc
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

/** Transaction-only variant used while claim state and its outbox event are committed together. */
export async function findActiveAssetHoldByOrderForUpdate(
  trx: Trx,
  orderId: string,
): Promise<AssetRow | null> {
  const result = await sql<AssetRow>`
    select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
    from digital_asset
    where reserved_order_id = ${orderId}
      and status in ('RESERVED','READY')
    order by created_at asc, id asc
    limit 1
    for update
  `.execute(trx);
  return result.rows[0] ?? null;
}

/** Find the original delivered asset history for replacement/refund review. */
export async function findDeliveredAssetHistoryForOrder(
  exec: Executor,
  orderId: string,
): Promise<AssetRow | null> {
  const result = await sql<AssetRow>`
    select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
    from digital_asset
    where delivered_order_id = ${orderId}
      and status in ('DELIVERED', 'COMPROMISED', 'REVOKED')
    order by updated_at asc, id asc
    limit 1
  `.execute(exec);
  return result.rows[0] ?? null;
}

/**
 * Release a reserved-but-not-delivered asset back to AVAILABLE (e.g. after a
 * failed delivery issuance, or a reserve TTL expiry). Version-guarded.
 */
export async function releaseReservedAsset(
  exec: Executor,
  assetId: string,
  expectedVersion: number,
): Promise<boolean> {
  const newVer = nextVersion(expectedVersion);
  const result = await sql`
    update digital_asset
    set status = 'AVAILABLE',
        reserved_order_id = null,
        reserved_until = null,
        version = ${newVer},
        updated_at = now()
    where id = ${assetId}
      and version = ${expectedVersion}
      and status = 'RESERVED'
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0) >= 1;
}

/**
 * Release any RESERVED asset currently held by `orderId` back to AVAILABLE.
 * Used by cancel/expiry so the unit re-enters the sellable pool in the same
 * transaction that voids the Payment Intent (FR-006c). Version-free: the
 * order-id ownership is the concurrency key.
 */
export async function releaseReservationForOrder(
  exec: Executor,
  orderId: string,
): Promise<boolean> {
  const result = await sql`
    update digital_asset
    set status = 'AVAILABLE',
        reserved_order_id = null,
        reserved_until = null,
        version = version + 1,
        updated_at = now()
    where reserved_order_id = ${orderId}
      and status = 'RESERVED'
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0) >= 1;
}

/**
 * Mark a held asset READY (validated, ready for Delivery Bundle issue).
 * Version-guarded; only RESERVED → READY is legal here.
 */
export async function markAssetReady(
  exec: Executor,
  assetId: string,
  expectedVersion: number,
): Promise<boolean> {
  const newVer = nextVersion(expectedVersion);
  const result = await sql`
    update digital_asset
    set status = 'READY', version = ${newVer}, updated_at = now()
    where id = ${assetId} and version = ${expectedVersion} and status = 'RESERVED'
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0) >= 1;
}

/**
 * Mark a held asset DELIVERED after the Delivery Bundle has been viewed/consumed.
 * Version-guarded.
 */
export async function markAssetDelivered(
  exec: Executor,
  assetId: string,
  orderId: string,
  expectedVersion: number,
): Promise<boolean> {
  const newVer = nextVersion(expectedVersion);
  const result = await sql`
    update digital_asset
    set status = 'DELIVERED',
        delivered_order_id = ${orderId},
        version = ${newVer},
        updated_at = now()
    where id = ${assetId}
      and version = ${expectedVersion}
      and status in ('RESERVED','READY')
  `.execute(exec);
  return Number(result.numAffectedRows ?? 0) >= 1;
}
