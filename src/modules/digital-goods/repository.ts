import { sql } from "kysely";
import type { Db, Executor, Trx } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { newId } from "../../shared/ids/index.js";
import type { AssetStatus } from "./domain.js";
import { emitQuantityStockDeltaEvents } from "../catalog/quantity-stock.js";

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
export type TypedStockKind =
  | "STOCK_ACCOUNT"
  | "STOCK_CODE"
  | "DIGITAL_FILE"
  | "SUPPLIER_API"
  | "MANUAL_FULFILLMENT"
  | "QUANTITY_STOCK"
  | "UNLIMITED_SERVICE";

export type TypedReserveResult =
  | { ok: true; kind: "DISCRETE"; assetId: string; fingerprintHash: string }
  | { ok: true; kind: "QUANTITY"; ledgerId: string; remainingQuantity: number }
  | { ok: true; kind: "UNLIMITED" }
  | { ok: true; kind: "DEFERRED" }
  | { ok: false; reason: "NO_STOCK" | "CONTENTION_TIMEOUT" | "RESERVATION_LOST" };

export interface ReserveTypedStockInput {
  variantId: string;
  orderId: string;
  fulfillmentType: TypedStockKind;
  reserveUntil: Date;
  quantity?: number;
}

export async function reserveTypedStockForOrder(
  exec: Executor,
  input: ReserveTypedStockInput,
): Promise<TypedReserveResult> {
  switch (input.fulfillmentType) {
    case "STOCK_ACCOUNT":
    case "STOCK_CODE":
      return reserveAvailableAssetForOrder(exec, input).then((result) =>
        result.ok
          ? {
              ok: true,
              kind: "DISCRETE",
              assetId: result.assetId,
              fingerprintHash: result.fingerprintHash,
            }
          : result,
      );
    case "QUANTITY_STOCK":
      return reserveQuantityStockForOrder(exec, input);
    case "DIGITAL_FILE":
      return hasActiveFileArtifact(exec, input.variantId).then((ok) =>
        ok ? { ok: true, kind: "DEFERRED" as const } : { ok: false, reason: "NO_STOCK" as const },
      );
    case "SUPPLIER_API":
      return hasConfiguredSupplier(exec, input.variantId).then((ok) =>
        ok ? { ok: true, kind: "DEFERRED" as const } : { ok: false, reason: "NO_STOCK" as const },
      );
    case "MANUAL_FULFILLMENT":
      return hasServiceDefinition(exec, input.variantId, "MANUAL_FULFILLMENT").then((ok) =>
        ok ? { ok: true, kind: "DEFERRED" as const } : { ok: false, reason: "NO_STOCK" as const },
      );
    case "UNLIMITED_SERVICE":
      return hasServiceDefinition(exec, input.variantId, "UNLIMITED_SERVICE").then((ok) =>
        ok ? { ok: true, kind: "UNLIMITED" as const } : { ok: false, reason: "NO_STOCK" as const },
      );
  }
}

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
  const variant = await sql<{ fulfillment_type: TypedStockKind }>`
    select fulfillment_type from product_variant where id = ${variantId}
  `.execute(exec);
  switch (variant.rows[0]?.fulfillment_type) {
    case "STOCK_ACCOUNT":
    case "STOCK_CODE":
      return orderHasActiveAssetReservation(exec, orderId, variantId, now);
    case "QUANTITY_STOCK":
      return orderHasActiveQuantityReservation(exec, orderId, variantId, now);
    case "DIGITAL_FILE":
      return hasActiveFileArtifact(exec, variantId);
    case "SUPPLIER_API":
      return hasConfiguredSupplier(exec, variantId);
    case "MANUAL_FULFILLMENT":
      return hasServiceDefinition(exec, variantId, "MANUAL_FULFILLMENT");
    case "UNLIMITED_SERVICE":
      return hasServiceDefinition(exec, variantId, "UNLIMITED_SERVICE");
    default:
      return false;
  }
}

async function orderHasActiveAssetReservation(
  exec: Executor,
  orderId: string,
  variantId: string,
  now: Date,
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

async function orderHasActiveQuantityReservation(
  exec: Executor,
  orderId: string,
  variantId: string,
  now: Date,
): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one
    from quantity_stock_ledger
    where order_id = ${orderId}
      and variant_id = ${variantId}
      and entry_type = 'RESERVE'
      and released_at is null
      and expires_at is not null
      and expires_at > ${now.toISOString()}
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

async function hasActiveFileArtifact(exec: Executor, variantId: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one
    from variant_file_artifact
    where variant_id = ${variantId} and is_active
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

async function hasConfiguredSupplier(exec: Executor, variantId: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one
    from supplier_sku ss
    join supplier s on s.id = ss.supplier_id
    where ss.variant_id = ${variantId}
      and ss.is_active
      and s.status = 'ACTIVE'
    limit 1
  `.execute(exec);
  return result.rows.length > 0;
}

async function hasServiceDefinition(
  exec: Executor,
  variantId: string,
  fulfillmentType: "MANUAL_FULFILLMENT" | "UNLIMITED_SERVICE",
): Promise<boolean> {
  const result = await sql<{ one: number }>`
    select 1 as one
    from variant_service_fulfillment
    where variant_id = ${variantId}
      and fulfillment_type = ${fulfillmentType}
      and is_active
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

async function reserveQuantityStockForOrder(
  exec: Executor,
  input: ReserveTypedStockInput,
): Promise<TypedReserveResult> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError("quantity reserve must be a positive integer");
  }

  const activeOrHistorical = await sql<{
    id: string;
    variant_id: string;
    remaining_quantity: number;
    released_at: Date | string | null;
    expires_at: Date | string | null;
  }>`
    select l.id, l.variant_id, s.available_quantity::int as remaining_quantity,
           l.released_at, l.expires_at
    from quantity_stock_ledger l
    join variant_quantity_stock s on s.variant_id = l.variant_id
    where l.order_id = ${input.orderId}
      and l.entry_type = 'RESERVE'
    order by l.created_at asc, l.id asc
    limit 1
    for update of l, s
  `.execute(exec);
  const existing = activeOrHistorical.rows[0];
  if (existing) {
    const active =
      existing.variant_id === input.variantId &&
      existing.released_at === null &&
      existing.expires_at !== null &&
      new Date(existing.expires_at).getTime() > Date.now();
    if (active) {
      return {
        ok: true,
        kind: "QUANTITY",
        ledgerId: existing.id,
        remainingQuantity: existing.remaining_quantity,
      };
    }
    return { ok: false, reason: "NO_STOCK" };
  }

  const stock = await sql<{ available_quantity: number; version: number }>`
    select available_quantity::int, version
    from variant_quantity_stock
    where variant_id = ${input.variantId}
    limit 1
    for update skip locked
  `.execute(exec);
  const row = stock.rows[0];
  if (!row) {
    const contention = await sql<{ n: number }>`
      select count(*)::int as n
      from variant_quantity_stock
      where variant_id = ${input.variantId}
        and available_quantity >= ${quantity}
    `.execute(exec);
    return (contention.rows[0]?.n ?? 0) > 0
      ? { ok: false, reason: "CONTENTION_TIMEOUT" }
      : { ok: false, reason: "NO_STOCK" };
  }
  if (row.available_quantity < quantity) return { ok: false, reason: "NO_STOCK" };

  const confirmed = await sql<{
    id: string;
    variant_id: string;
    remaining_quantity: number;
    released_at: Date | string | null;
    expires_at: Date | string | null;
  }>`
    select l.id, l.variant_id, s.available_quantity::int as remaining_quantity,
           l.released_at, l.expires_at
    from quantity_stock_ledger l
    join variant_quantity_stock s on s.variant_id = l.variant_id
    where l.order_id = ${input.orderId}
      and l.entry_type = 'RESERVE'
    order by l.created_at asc, l.id asc
    limit 1
    for update of l, s
  `.execute(exec);
  if (confirmed.rows[0]) {
    const held = confirmed.rows[0];
    const active =
      held.variant_id === input.variantId &&
      held.released_at === null &&
      held.expires_at !== null &&
      new Date(held.expires_at).getTime() > Date.now();
    if (active) {
      return {
        ok: true,
        kind: "QUANTITY",
        ledgerId: held.id,
        remainingQuantity: held.remaining_quantity,
      };
    }
    return { ok: false, reason: "NO_STOCK" };
  }

  const nextQuantity = row.available_quantity - quantity;
  const nextVersion = row.version + 1;
  const updated = await sql`
    update variant_quantity_stock
    set available_quantity = ${nextQuantity}, version = ${nextVersion}, updated_at = now()
    where variant_id = ${input.variantId}
      and version = ${row.version}
      and available_quantity >= ${quantity}
  `.execute(exec);
  if (Number(updated.numAffectedRows ?? 0) < 1) {
    return { ok: false, reason: "RESERVATION_LOST" };
  }

  const ledgerId = newId();
  await sql`
    insert into quantity_stock_ledger
      (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, expires_at)
    values
      (${ledgerId}, ${input.variantId}, ${input.orderId}, 'RESERVE', ${-quantity}, ${nextQuantity}, ${input.reserveUntil.toISOString()})
  `.execute(exec);
  await emitQuantityStockDeltaEvents(exec, {
    variantId: input.variantId,
    delta: -quantity,
    stockBefore: row.available_quantity,
    stockAfter: nextQuantity,
    version: nextVersion,
    correlationId: `quantity-reserve:${input.orderId}`,
  });
  return { ok: true, kind: "QUANTITY", ledgerId, remainingQuantity: nextQuantity };
}

export async function releaseTypedStockForOrder(exec: Executor, orderId: string): Promise<boolean> {
  const releasedAsset = await releaseReservationForOrder(exec, orderId);
  const reserved = await sql<{ id: string; variant_id: string; quantity_delta: number }>`
    select id, variant_id, quantity_delta::int
    from quantity_stock_ledger
    where order_id = ${orderId} and entry_type = 'RESERVE' and released_at is null
      and not exists (select 1 from quantity_stock_ledger d where d.parent_ledger_id = quantity_stock_ledger.id and d.entry_type = 'DELIVER')
    for update
  `.execute(exec);
  const row = reserved.rows[0];
  if (!row) return releasedAsset;
  const quantity = Math.abs(row.quantity_delta);
  const stock = await sql<{ available_quantity: number; version: number }>`
    select available_quantity::int, version
    from variant_quantity_stock
    where variant_id = ${row.variant_id}
    limit 1
    for update
  `.execute(exec);
  const live = stock.rows[0];
  if (!live) return releasedAsset;
  const nextQuantity = live.available_quantity + quantity;
  const nextVersion = live.version + 1;
  await sql`
    update variant_quantity_stock
    set available_quantity = ${nextQuantity}, version = ${nextVersion}, updated_at = now()
    where variant_id = ${row.variant_id} and version = ${live.version}
  `.execute(exec);
  await sql`
    update quantity_stock_ledger set released_at = now() where id = ${row.id}
  `.execute(exec);
  const ledgerId = newId();
  await sql`
    insert into quantity_stock_ledger
      (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, parent_ledger_id)
    values
      (${ledgerId}, ${row.variant_id}, ${orderId}, 'RELEASE', ${quantity}, ${nextQuantity}, ${row.id})
  `.execute(exec);
  await emitQuantityStockDeltaEvents(exec, {
    variantId: row.variant_id,
    delta: quantity,
    stockBefore: live.available_quantity,
    stockAfter: nextQuantity,
    version: nextVersion,
    correlationId: `quantity-release:${orderId}`,
  });
  return true;
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
