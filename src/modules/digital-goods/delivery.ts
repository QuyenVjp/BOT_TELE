import { createHash, createHmac, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import {
  findOrderById,
  findOrderByIdForOwnerForUpdate,
  transitionOrder,
} from "../commerce/repository.js";
import { markAssetDelivered } from "./repository.js";
import { hashDeliverySessionNonce, type DeliverySessionClaims } from "./delivery-session.js";
import { INVENTORY_FIELDS_SCHEMA, type InventoryField } from "../catalog/fulfillment-type.js";

/**
 * Secure Delivery Bundle issue / reveal / reissue (T073, FR-017, SR-003,
 * contracts/delivery.md).
 *
 * A bundle binds one asset to one customer+order with a HASHED reveal token, an
 * expiry, and view-once semantics:
 *  - `issueDeliveryBundle` mints a high-entropy token, stores only its hash, and
 *    returns the plaintext once. Issuing twice for the same order returns the
 *    existing active bundle (the unique active-per-order index is the backstop).
 *  - `revealDeliveryBundle` atomically flips AVAILABLE → CONSUMED under a version
 *    guard, so exactly one concurrent/replayed reveal wins; the rest get a stable
 *    safe error with NO existence oracle. Ownership (customer + order) is checked
 *    before any state change so an attacker can never burn the view.
 *  - `reissueDeliveryBundle` is allowed only when no live bundle exists (e.g. the
 *    prior expired before first view); it revokes the prior bundle in the same
 *    transaction. A CONSUMED bundle is never silently reset.
 *
 * The secret plaintext is revealed from the vault at the boundary only and never
 * touches a domain row, a log, or an outbox payload (SR-001).
 */

/** Minimal vault surface the reveal path needs (injected for tests). */
export interface RevealVault {
  reveal(ref: string): Promise<string>;
}

export type IssueResult =
  | { ok: true; bundleId: string; token: string; expiresAt: string; reused: boolean }
  | { ok: false; code: "ASSET_NOT_READY" | "NOT_FOUND"; message: string };

export type RevealResult =
  | { ok: true; secret: string; bundleId: string }
  | { ok: false; code: "UNAVAILABLE"; message: string };

interface StoredInventorySecret {
  schemaVersion: "inventory-fields.v1";
  values: Array<{ name: string; value: string }>;
}

function inventoryFieldsFromSummary(value: unknown): InventoryField[] {
  if (value === null || typeof value !== "object") return [];
  const fields = (value as { inventoryFields?: unknown }).inventoryFields;
  const parsed = INVENTORY_FIELDS_SCHEMA.safeParse(fields);
  return parsed.success ? parsed.data : [];
}

function parseStructuredSecret(value: string): StoredInventorySecret | null | "LEGACY" {
  if (!value.trim().startsWith("{")) return "LEGACY";
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const secret = decoded as { schemaVersion?: unknown; values?: unknown };
  if (secret.schemaVersion !== "inventory-fields.v1" || !Array.isArray(secret.values)) return null;
  const values: StoredInventorySecret["values"] = [];
  for (const item of secret.values) {
    if (item === null || typeof item !== "object") return null;
    const entry = item as { name?: unknown; value?: unknown };
    if (typeof entry.name !== "string" || typeof entry.value !== "string") return null;
    values.push({ name: entry.name, value: entry.value });
  }
  return { schemaVersion: "inventory-fields.v1", values };
}

function renderVisibleSecret(raw: string, fields: InventoryField[]): string | null {
  const parsed = parseStructuredSecret(raw);
  if (parsed === "LEGACY") return fields.length === 0 ? raw : null;
  if (!parsed) return null;
  const values = new Map(parsed.values.map((value) => [value.name, value.value]));
  const visible = fields
    .filter((field) => field.customerVisible)
    .map((field) => ({ label: field.label, value: values.get(field.name) ?? "" }))
    .filter((field) => field.value.length > 0);
  if (visible.length === 0) return null;
  // A single-field schema (a stock code) stays as bare copy-friendly text. Anything with a
  // multi-field schema keeps its labels even when only one value is present, so a partially
  // filled record can never surface as an unlabelled blob the customer cannot interpret.
  if (visible.length === 1 && fields.length <= 1) return visible[0]!.value;
  return visible.map((field) => `${field.label}: ${field.value}`).join("\n");
}

export type ReissueResult =
  | { ok: true; bundleId: string; token: string; expiresAt: string; reissueOfId: string }
  | { ok: false; code: "LIVE_BUNDLE_EXISTS" | "NOT_FOUND"; message: string };

export interface IssueInput {
  orderId: string;
  customerId: string;
  assetId: string;
  ttlSeconds: number;
  correlationId: string;
  /** Domain-separated delivery keyring; current first, previous during grace. */
  deliveryTokenKeys?: readonly string[];
}

export interface RevealInput {
  token: string;
  /** Trusted internal seam retained for domain tests; public HTTP uses session. */
  customerId?: string;
  session?: DeliverySessionClaims;
  correlationId: string;
  vault: RevealVault;
}

export interface ReissueInput {
  orderId: string;
  customerId: string;
  assetId: string;
  ttlSeconds: number;
  correlationId: string;
}

/** Safe, generic reveal error — deliberately reveals nothing about existence. */
const SAFE_REVEAL_ERROR = "Liên kết không khả dụng hoặc đã được sử dụng.";

class AssetDeliveryConflict extends Error {}

/** Hash a plaintext token; only the hash is ever persisted. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a high-entropy opaque reveal token (URL-safe base64). */
function mintToken(bundleId: string, keys: readonly string[] | undefined): string {
  if (keys && keys.length > 0) {
    const key = keys[0]!;
    if (Buffer.byteLength(key, "utf8") < 32) throw new Error("Delivery token key too short");
    const subkey = createHmac("sha256", key)
      .update("telegram-shop:delivery-bundle-token-key:v1\0", "utf8")
      .digest();
    return createHmac("sha256", subkey).update(bundleId, "utf8").digest("base64url");
  }
  return randomBytes(32).toString("base64url");
}

function recoverToken(bundle: BundleRow, keys: readonly string[] | undefined): string {
  if (!keys) return "";
  for (const key of keys) {
    const candidate = mintToken(bundle.id, [key]);
    if (hashToken(candidate) === bundle.token_hash) return candidate;
  }
  return "";
}

interface BundleRow {
  id: string;
  order_id: string;
  customer_id: string;
  asset_id: string;
  status: string;
  expires_at: Date | string;
  token_hash: string;
  version: number;
}

function bundleExpiresAtMs(bundle: Pick<BundleRow, "expires_at">): number {
  return bundle.expires_at instanceof Date
    ? bundle.expires_at.getTime()
    : new Date(bundle.expires_at).getTime();
}

async function findActiveBundleByOrder(exec: Executor, orderId: string): Promise<BundleRow | null> {
  const result = await sql<BundleRow>`
    select id, order_id, customer_id, asset_id, status, expires_at, token_hash, version
    from delivery_bundle
    where order_id = ${orderId}
      and status in ('CREATED','AVAILABLE','VIEWED')
    limit 1
    for update
  `.execute(exec);
  return result.rows[0] ?? null;
}

async function findActiveBundleByOrderAndAsset(
  exec: Executor,
  orderId: string,
  assetId: string,
): Promise<BundleRow | null> {
  const result = await sql<BundleRow>`
    select id, order_id, customer_id, asset_id, status, expires_at, token_hash, version
    from delivery_bundle
    where order_id = ${orderId}
      and asset_id = ${assetId}
      and status in ('CREATED','AVAILABLE','VIEWED')
    limit 1
    for update
  `.execute(exec);
  return result.rows[0] ?? null;
}

export async function issueReplacementDeliveryBundleInTransaction(
  exec: Executor,
  input: IssueInput,
): Promise<IssueResult> {
  // Owner-scoped lock: a foreign order and a missing one are the same `null`.
  const order = await findOrderByIdForOwnerForUpdate(exec, input.orderId, input.customerId);
  if (!order) {
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
  }

  const existing = await findActiveBundleByOrderAndAsset(exec, input.orderId, input.assetId);
  if (existing && !(existing.status !== "VIEWED" && Date.now() > bundleExpiresAtMs(existing))) {
    return {
      ok: true,
      bundleId: existing.id,
      token: recoverToken(existing, input.deliveryTokenKeys),
      expiresAt: new Date(bundleExpiresAtMs(existing)).toISOString(),
      reused: true,
    };
  }
  if (existing) {
    await sql`
      update delivery_bundle
      set status = 'EXPIRED', version = version + 1
      where id = ${existing.id} and version = ${existing.version} and status in ('CREATED','AVAILABLE')
    `.execute(exec);
  }

  const asset = await sql<{ status: string; reserved_order_id: string | null }>`
    select status, reserved_order_id from digital_asset where id = ${input.assetId}
  `.execute(exec);
  const a = asset.rows[0];
  if (!a) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tài khoản." };
  if (a.reserved_order_id !== input.orderId || (a.status !== "READY" && a.status !== "RESERVED")) {
    return { ok: false, code: "ASSET_NOT_READY", message: "Tài khoản chưa sẵn sàng để giao." };
  }

  const bundleId = newId();
  const token = mintToken(bundleId, input.deliveryTokenKeys);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await sql`
    insert into delivery_bundle
      (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
    values
      (${bundleId}, ${input.orderId}, ${input.customerId}, ${input.assetId},
       ${tokenHash}, 'AVAILABLE', ${expiresAt.toISOString()})
  `.execute(exec);

  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "DeliveryBundle",
    aggregateId: bundleId,
    aggregateVersion: 1,
    eventType: "DeliveryBundleCreated",
    payloadRedacted: {
      bundleId,
      orderId: input.orderId,
      customerId: input.customerId,
      assetId: input.assetId,
      correlationId: input.correlationId,
    },
  });

  return { ok: true, bundleId, token, expiresAt: expiresAt.toISOString(), reused: false };
}

/**
 * Issue (or reuse) the active Delivery Bundle for a paid order's READY asset.
 * Returns the plaintext token exactly once; the row stores only its hash.
 */
export async function issueDeliveryBundle(db: Db, input: IssueInput): Promise<IssueResult> {
  return withTransaction(db, async (trx) => {
    const order = await findOrderByIdForOwnerForUpdate(trx, input.orderId, input.customerId);
    if (!order) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
    }

    // Reuse an existing active bundle unless it is an unviewed expired row.
    const existing = await findActiveBundleByOrder(trx, input.orderId);
    if (existing && !(existing.status !== "VIEWED" && Date.now() > bundleExpiresAtMs(existing))) {
      const expiresAt = new Date(bundleExpiresAtMs(existing)).toISOString();
      return {
        ok: true,
        bundleId: existing.id,
        token: recoverToken(existing, input.deliveryTokenKeys),
        expiresAt,
        reused: true,
      };
    }
    if (existing) {
      await sql`
        update delivery_bundle
        set status = 'EXPIRED', version = version + 1
        where id = ${existing.id} and version = ${existing.version} and status in ('CREATED','AVAILABLE')
      `.execute(trx);
    }

    // Confirm the asset is READY (or RESERVED) and bound to this order.
    const asset = await sql<{ status: string; reserved_order_id: string | null }>`
      select status, reserved_order_id from digital_asset where id = ${input.assetId}
    `.execute(trx);
    const a = asset.rows[0];
    if (!a) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tài khoản." };
    }
    if (
      a.reserved_order_id !== input.orderId ||
      (a.status !== "READY" && a.status !== "RESERVED")
    ) {
      return { ok: false, code: "ASSET_NOT_READY", message: "Tài khoản chưa sẵn sàng để giao." };
    }

    const bundleId = newId();
    const token = mintToken(bundleId, input.deliveryTokenKeys);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    await sql`
      insert into delivery_bundle
        (id, order_id, customer_id, asset_id, token_hash, status, expires_at)
      values
        (${bundleId}, ${input.orderId}, ${input.customerId}, ${input.assetId},
         ${tokenHash}, 'AVAILABLE', ${expiresAt.toISOString()})
    `.execute(trx);

    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "DeliveryBundle",
      aggregateId: bundleId,
      aggregateVersion: 1,
      eventType: "DeliveryBundleCreated",
      payloadRedacted: {
        bundleId,
        orderId: input.orderId,
        customerId: input.customerId,
        assetId: input.assetId,
        correlationId: input.correlationId,
      },
    });

    return { ok: true, bundleId, token, expiresAt: expiresAt.toISOString(), reused: false };
  });
}

/**
 * Atomically reveal a bundle's secret exactly once to its owner. The state
 * transition AVAILABLE → CONSUMED is version-guarded, so under concurrency
 * exactly one caller flips the row and reads the vault; the rest get the safe
 * error. Ownership is verified before the flip so a non-owner can never consume.
 */
export async function revealDeliveryBundle(db: Db, input: RevealInput): Promise<RevealResult> {
  const tokenHash = hashToken(input.token);
  const authorizedCustomerId = input.session?.customerId ?? input.customerId;
  if (!authorizedCustomerId) {
    return { ok: false, code: "UNAVAILABLE", message: SAFE_REVEAL_ERROR };
  }

  // Two-phase, crash-safe reveal (T146/T140):
  //   Phase 1 (read txn): verify ownership + liveness and read the vault ref.
  //   Vault reveal: fetch the plaintext BEFORE we consume the one-time link, so
  //     a vault timeout/error leaves the bundle AVAILABLE and retryable rather
  //     than burning the link without delivering the credential.
  //   Phase 2 (write txn): flip AVAILABLE → CONSUMED under a version guard and
  //     mark the asset DELIVERED. If someone else won the race in between, we
  //     return the safe error and do not double-deliver.
  const prepared = await withTransaction(db, async (trx) => {
    const result = await sql<BundleRow & { asset_id: string }>`
      select id, order_id, customer_id, asset_id, status, expires_at, version
      from delivery_bundle
      where token_hash = ${tokenHash}
      for update
    `.execute(trx);
    const bundle = result.rows[0];
    if (!bundle) return null;
    if (bundle.customer_id !== authorizedCustomerId) return null;

    if (input.session) {
      const session = await sql<{ one: number }>`
        select 1 as one
        from delivery_session
        where id = ${input.session.sessionId}
          and bundle_id = ${bundle.id}
          and customer_id = ${bundle.customer_id}
          and telegram_user_id = ${input.session.telegramUserId}
          and audience = ${input.session.audience}
          and nonce_hash = ${hashDeliverySessionNonce(input.session.nonce)}
          and key_version = ${input.session.keyVersion}
          and expires_at > now()
          and activated_at is not null
          and used_at is null
          and revoked_at is null
        for update
      `.execute(trx);
      if (!session.rows[0]) return null;
    }

    const expiresAtMs =
      bundle.expires_at instanceof Date
        ? bundle.expires_at.getTime()
        : new Date(bundle.expires_at).getTime();
    if (bundle.status !== "AVAILABLE" && bundle.status !== "VIEWED") return null;
    if (Date.now() > expiresAtMs) return null;

    // Mark VIEWED (not CONSUMED) so a repeat within TTL can still recover the
    // link if the vault reveal fails after this point. VIEWED remains revealable.
    if (bundle.status === "AVAILABLE") {
      await sql`
        update delivery_bundle
        set status = 'VIEWED', viewed_at = coalesce(viewed_at, now()), version = ${bundle.version + 1}
        where id = ${bundle.id} and version = ${bundle.version} and status = 'AVAILABLE'
      `.execute(trx);
    }

    const assetRow = await sql<{ vault_ref: string; validation_summary: unknown; version: number }>`
      select vault_ref, validation_summary, version from digital_asset where id = ${bundle.asset_id}
    `.execute(trx);
    const asset = assetRow.rows[0];
    if (!asset) return null;

    return {
      bundleId: bundle.id,
      orderId: bundle.order_id,
      customerId: bundle.customer_id,
      assetId: bundle.asset_id,
      vaultRef: asset.vault_ref,
      inventoryFields: inventoryFieldsFromSummary(asset.validation_summary),
    };
  });

  if (!prepared) {
    return { ok: false, code: "UNAVAILABLE", message: SAFE_REVEAL_ERROR };
  }

  // Reveal from the vault BEFORE consuming. A failure here leaves the bundle at
  // VIEWED (still revealable within TTL) — never a burned link with no secret.
  let secret: string;
  try {
    secret = await input.vault.reveal(prepared.vaultRef);
  } catch {
    return { ok: false, code: "UNAVAILABLE", message: SAFE_REVEAL_ERROR };
  }

  const visibleSecret = renderVisibleSecret(secret, prepared.inventoryFields);
  if (!visibleSecret) {
    return { ok: false, code: "UNAVAILABLE", message: SAFE_REVEAL_ERROR };
  }

  // Phase 2: consume the link + mark asset delivered atomically. If a concurrent
  // reveal already consumed it, the guarded update affects 0 rows and we return
  // the safe single-use error.
  // the secret we already fetched (the winning caller also returns it) — the
  // link is single-use and the customer who holds the token gets the secret.
  let consumed: boolean;
  try {
    consumed = await withTransaction(db, async (trx) => {
      const flip = await sql`
      update delivery_bundle
      set status = 'CONSUMED', consumed_at = now(), version = version + 1
      where token_hash = ${tokenHash} and status in ('AVAILABLE','VIEWED')
      returning id, order_id, customer_id, asset_id, version
    `.execute(trx);
      const row = flip.rows[0] as
        | { id: string; order_id: string; customer_id: string; asset_id: string; version: number }
        | undefined;
      if (!row) throw new AssetDeliveryConflict();

      if (input.session) {
        const sessionUse = await sql`
          update delivery_session
          set used_at = now()
          where id = ${input.session.sessionId}
            and activated_at is not null
            and used_at is null and revoked_at is null and expires_at > now()
          returning id
        `.execute(trx);
        if (!sessionUse.rows[0]) throw new AssetDeliveryConflict();
      }

      const assetRow = await sql<{ version: number }>`
      select version from digital_asset where id = ${row.asset_id}
    `.execute(trx);
      const assetVersion = assetRow.rows[0]?.version;
      if (assetVersion === undefined) throw new AssetDeliveryConflict();
      const delivered = await markAssetDelivered(trx, row.asset_id, row.order_id, assetVersion);
      if (!delivered) throw new AssetDeliveryConflict();

      await enqueueOutboxEvent(trx, {
        id: newId(),
        aggregateType: "DeliveryBundle",
        aggregateId: row.id,
        aggregateVersion: row.version,
        eventType: "DigitalAssetDelivered",
        payloadRedacted: {
          bundleId: row.id,
          orderId: row.order_id,
          customerId: row.customer_id,
          assetId: row.asset_id,
          correlationId: input.correlationId,
        },
      });

      // Order → COMPLETED atomically with the first successful reveal (T147).
      // Prior code left the Order at PROCESSING forever; tests incorrectly accepted
      // PROCESSING as success. Only PROCESSING → COMPLETED is legal here.
      const order = await findOrderById(trx, row.order_id);
      if (order && order.status === "PROCESSING") {
        await transitionOrder(trx, order, "COMPLETED", "DELIVERY_REVEALED", input.correlationId, {
          type: "SYSTEM",
          id: "delivery",
        });
      }

      return true;
    });
  } catch (error) {
    if (error instanceof AssetDeliveryConflict) {
      consumed = false;
    } else {
      throw error;
    }
  }

  if (!consumed) {
    // Someone else consumed between our read and write. The link is single-use;
    // return the safe error so we do not imply a second valid delivery.
    return { ok: false, code: "UNAVAILABLE", message: SAFE_REVEAL_ERROR };
  }

  return { ok: true, secret: visibleSecret, bundleId: prepared.bundleId };
}

/**
 * Reissue a Delivery Bundle. Permitted only when NO live bundle exists for the
 * order (e.g. the prior expired before first view). The most recent superseded
 * bundle is revoked in the same transaction and recorded as `reissue_of_id`.
 */
export async function reissueDeliveryBundle(db: Db, input: ReissueInput): Promise<ReissueResult> {
  return withTransaction(db, async (trx) => {
    // Refuse if a live bundle still exists (no silent second token).
    const live = await findActiveBundleByOrder(trx, input.orderId);
    if (live) {
      return {
        ok: false,
        code: "LIVE_BUNDLE_EXISTS",
        message: "Vẫn còn liên kết giao hàng đang hoạt động.",
      };
    }

    // Find the most recent prior bundle for this order to chain the reissue.
    const prior = await sql<{ id: string; status: string }>`
      select id, status from delivery_bundle
      where order_id = ${input.orderId}
      order by created_at desc
      limit 1
    `.execute(trx);
    const priorRow = prior.rows[0];
    if (!priorRow) {
      return { ok: false, code: "NOT_FOUND", message: "Không có liên kết trước đó để tạo lại." };
    }
    // A consumed bundle is never silently reset.
    if (priorRow.status === "CONSUMED") {
      return { ok: false, code: "LIVE_BUNDLE_EXISTS", message: "Đơn hàng đã được giao." };
    }

    // Revoke the prior bundle in-txn (idempotent; expired stays terminal).
    await sql`
      update delivery_bundle
      set status = 'REVOKED', revoked_at = now(), version = version + 1
      where id = ${priorRow.id} and status <> 'CONSUMED'
    `.execute(trx);

    const bundleId = newId();
    const token = mintToken(bundleId, undefined);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    await sql`
      insert into delivery_bundle
        (id, order_id, customer_id, asset_id, token_hash, status, expires_at, reissue_of_id)
      values
        (${bundleId}, ${input.orderId}, ${input.customerId}, ${input.assetId},
         ${tokenHash}, 'AVAILABLE', ${expiresAt.toISOString()}, ${priorRow.id})
    `.execute(trx);

    await enqueueOutboxEvent(trx, {
      id: newId(),
      aggregateType: "DeliveryBundle",
      aggregateId: bundleId,
      aggregateVersion: 1,
      eventType: "DeliveryBundleCreated",
      payloadRedacted: {
        bundleId,
        orderId: input.orderId,
        customerId: input.customerId,
        assetId: input.assetId,
        reissueOfId: priorRow.id,
        correlationId: input.correlationId,
      },
    });

    return {
      ok: true,
      bundleId,
      token,
      expiresAt: expiresAt.toISOString(),
      reissueOfId: priorRow.id,
    };
  });
}
