import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId, isId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";

export const RESALE_EVIDENCE_SOURCES = [
  "SUPPLIER_AUTHORIZATION",
  "OWNER_ATTESTATION",
  "CONTRACT_REFERENCE",
] as const;
export type ResaleEvidenceSource = (typeof RESALE_EVIDENCE_SOURCES)[number];

export type PublicationBlocker =
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_INACTIVE"
  | "PRODUCT_ARCHIVED"
  | "PRODUCT_TEST_ONLY"
  | "STORE_TEST_MODE"
  | "CATEGORY_INACTIVE"
  | "NO_ACTIVE_VARIANTS"
  | "VARIANT_INACTIVE"
  | "VARIANT_PRICE_INVALID"
  | "FULFILLMENT_NOT_READY"
  | "SELLABLE_ROUTE_MISSING"
  | "RESALE_EVIDENCE_MISSING";

export interface VariantPublicationReadiness {
  id: string;
  version: number;
  active: boolean;
  priceVnd: string;
  fulfillmentType: string | null;
  ready: boolean;
  routeReady: boolean;
  evidenceId: string | null;
  evidenceActive: boolean;
  published: boolean;
  blockers: PublicationBlocker[];
}

export interface ProductPublicationReadiness {
  productId: string;
  productVersion: number;
  active: boolean;
  archived: boolean;
  testOnly: boolean;
  /** Visibility-only blockers; TEST_ONLY is promotable after technical checks and outside TEST mode. */
  visibilityBlockers: PublicationBlocker[];
  /** Commerce/evidence blockers that prevent a protected publication. */
  blockers: PublicationBlocker[];
  variants: VariantPublicationReadiness[];
  canPublish: boolean;
  publicationVersion: string;
}

export interface RegisterResaleEvidenceInput {
  variantId: string;
  source: ResaleEvidenceSource;
  reference: string;
  summary: string;
  metadataRedacted?: Record<string, string | number | boolean | null>;
  requestId: string;
  actorId: string;
  reason: string;
  correlationId: string;
}

export type RegisterResaleEvidenceResult =
  | { ok: true; evidenceId: string; variantVersion: number; replayed: boolean }
  | {
      ok: false;
      code: "INVALID_INPUT" | "NOT_FOUND" | "ACTIVE_EVIDENCE_EXISTS" | "CONFLICT";
      message: string;
    };

export interface RevokeResaleEvidenceInput {
  evidenceId: string;
  variantId: string;
  /** Optimistic guard: the `product_variant.version` the operator last saw. */
  expectedVariantVersion: number;
  requestId: string;
  actorId: string;
  reason: string;
  correlationId: string;
}

export type RevokeResaleEvidenceResult =
  | {
      ok: true;
      kind: "REVOKED" | "REPLAYED";
      evidenceId: string;
      variantId: string;
      variantVersion: number;
    }
  | {
      ok: false;
      code: "INVALID_INPUT" | "NOT_FOUND" | "NOT_ACTIVE" | "VERSION_CONFLICT" | "CONFLICT";
      message: string;
    };

export interface PublishProductInput {
  productId: string;
  expectedPublicationVersion: string;
  actorId: string;
  reason: string;
  correlationId: string;
}

export type PublishProductResult =
  | { ok: true; kind: "PUBLISHED" | "REPLAYED"; productId: string; publicationVersion: string }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_READY" | "VERSION_CONFLICT" | "CONFLICT";
      message: string;
    };

const MAX_METADATA_BYTES = 1_024;
const SECRET_KEY = /(secret|token|password|passwd|credential|vault|private|raw|payload|account)/i;
const SENSITIVE_TEXT =
  /(secret|token|password|passwd|credential|vault|private\s+key|api\s*key|otp|seed|cookie|session|mật khẩu|khóa\s+(?:api|bí mật))/iu;
const CODE_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
export function isSafeResaleEvidenceInput(value: string): boolean {
  const fields = value.split("|");
  if (fields.length !== 3) return false;
  const source = fields[0]?.trim() ?? "";
  const reference = fields[1]?.trim() ?? "";
  const summary = fields[2]?.trim() ?? "";
  return (
    (RESALE_EVIDENCE_SOURCES as readonly string[]).includes(source) &&
    CODE_RE.test(reference) &&
    reference.length <= 200 &&
    summary.length > 0 &&
    summary.length <= 500 &&
    !SENSITIVE_TEXT.test(reference) &&
    !SENSITIVE_TEXT.test(summary)
  );
}

function validMetadata(
  value: Record<string, string | number | boolean | null> | undefined,
): boolean {
  if (!value) return true;
  if (Object.keys(value).some((key) => SECRET_KEY.test(key))) return false;
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized, "utf8") <= MAX_METADATA_BYTES &&
      !SENSITIVE_TEXT.test(serialized)
    );
  } catch {
    return false;
  }
}

function normalize(input: string, max: number): string | null {
  const value = input.trim();
  return value.length > 0 && value.length <= max ? value : null;
}

function publicationVersion(input: {
  productVersion: number;
  productActive: boolean;
  productArchived: boolean;
  productTest: boolean;
  categoryActive: boolean;
  variants: Array<{
    id: string;
    version: number;
    priceVnd: string;
    fulfillmentType: string | null;
    ready: boolean;
    routeReady: boolean;
    evidenceId: string | null;
    evidenceActive: boolean;
  }>;
}): string {
  const snapshot = JSON.stringify({
    productVersion: input.productVersion,
    productActive: input.productActive,
    productArchived: input.productArchived,
    productTest: input.productTest,
    categoryActive: input.categoryActive,
    variants: [...input.variants].sort((a, b) => a.id.localeCompare(b.id)),
  });
  return `${input.productVersion}:${createHash("sha256").update(snapshot, "utf8").digest("hex")}`;
}

function blockersFor(row: {
  product_active: boolean;
  product_archived: boolean;
  category_active: boolean;
  variant_count: number;
  active: boolean;
  price_vnd: string;
  ready: boolean;
  route_ready: boolean;
  evidence_id: string | null;
  evidence_active: boolean;
}): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];
  if (!row.product_active) blockers.push("PRODUCT_INACTIVE");
  if (row.product_archived) blockers.push("PRODUCT_ARCHIVED");
  // TEST_ONLY is a visibility state, not a technical publication failure. It is
  // reported separately by getProductPublicationReadiness.
  if (row.category_active === false) blockers.push("CATEGORY_INACTIVE");
  if (row.variant_count === 0) blockers.push("NO_ACTIVE_VARIANTS");
  if (!row.active) blockers.push("VARIANT_INACTIVE");
  if (BigInt(row.price_vnd) <= 0n) blockers.push("VARIANT_PRICE_INVALID");
  if (!row.ready) blockers.push("FULFILLMENT_NOT_READY");
  if (!row.route_ready) blockers.push("SELLABLE_ROUTE_MISSING");
  if (!row.evidence_id || !row.evidence_active) blockers.push("RESALE_EVIDENCE_MISSING");
  return blockers;
}

export async function getProductPublicationReadiness(
  exec: Executor,
  productId: string,
): Promise<ProductPublicationReadiness | null> {
  if (!isId(productId)) return null;
  const result = await sql<{
    product_id: string;
    product_version: number;
    product_active: boolean;
    product_archived: boolean;
    product_test: boolean;
    category_active: boolean;
    variant_count: number;
    variant_id: string | null;
    variant_version: number | null;
    active: boolean | null;
    price_vnd: string | null;
    fulfillment_type: string | null;
    ready: boolean | null;
    route_ready: boolean | null;
    evidence_id: string | null;
    evidence_active: boolean | null;
    publication_evidence_id: string | null;
    publication_product_version: number | null;
    publication_variant_version: number | null;
    published_at: Date | string | null;
  }>`
    select p.id as product_id, p.version as product_version, p.is_active as product_active,
           p.is_archived as product_archived, p.is_test as product_test,
           c.is_active as category_active,
           count(v.id) filter (where v.is_active)::int as variant_count,
           v.id as variant_id, v.version as variant_version, v.is_active as active,
           v.price_vnd::text as price_vnd, v.fulfillment_type,
           case
             when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then exists (
               select 1 from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE')
             when v.fulfillment_type = 'QUANTITY_STOCK' then coalesce(q.available_quantity, 0) > 0
             when v.fulfillment_type = 'DIGITAL_FILE' then exists (
               select 1 from variant_file_artifact f where f.variant_id = v.id and f.is_active)
             when v.fulfillment_type = 'SUPPLIER_API' then exists (
               select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
                where ss.variant_id = v.id and ss.id = v.supplier_sku_id
                  and ss.is_active and s.status = 'ACTIVE'
                  and (
                    not exists (select 1 from supplier_catalog_product cp where cp.supplier_sku_id = ss.id)
                    or exists (
                      select 1 from supplier_catalog_product cp
                      where cp.supplier_id = s.id and cp.supplier_sku_id = ss.id
                        and cp.selection_status = 'SELECTED' and cp.is_enabled
                        and not cp.is_missing and cp.availability in ('AVAILABLE', 'LOW')
                    )
                  ))
             when v.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then exists (
               select 1 from variant_service_fulfillment sf where sf.variant_id = v.id
                 and sf.fulfillment_type = v.fulfillment_type and sf.is_active)
             else false
           end as ready,
           ((v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
             or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
               select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
                where ss.variant_id = v.id and ss.id = v.supplier_sku_id
                  and ss.is_active and s.status = 'ACTIVE'
                  and (
                    not exists (select 1 from supplier_catalog_product cp where cp.supplier_sku_id = ss.id)
                    or exists (
                      select 1 from supplier_catalog_product cp
                      where cp.supplier_id = s.id and cp.supplier_sku_id = ss.id
                        and cp.selection_status = 'SELECTED' and cp.is_enabled and not cp.is_missing
                    )
                  )))) as route_ready,
           v.resale_evidence_id as evidence_id,
           exists (select 1 from resale_evidence re where re.id = v.resale_evidence_id and re.variant_id = v.id and re.status = 'ACTIVE') as evidence_active,
           v.publication_evidence_id,
           v.publication_product_version,
           v.publication_variant_version,
           v.published_at
      from product p
      join category c on c.id = p.category_id
      left join product_variant v on v.product_id = p.id
      left join variant_quantity_stock q on q.variant_id = v.id
     where p.id = ${productId}
     group by p.id, p.version, p.is_active, p.is_archived, p.is_test, c.is_active, v.id, v.version,
              v.is_active, v.price_vnd, v.fulfillment_type, q.available_quantity,
              v.stock_policy, v.resale_evidence_id, v.publication_evidence_id,
              v.publication_product_version, v.publication_variant_version, v.published_at
     order by v.sort_order nulls last, v.id nulls last
  `.execute(exec);
  const storeMode =
    (
      await sql<{
        status: string;
      }>`select status from store_control where id = 'main' limit 1`.execute(exec)
    ).rows[0]?.status ?? "CLOSED";
  const first = result.rows[0];
  if (!first) return null;
  const variants = result.rows
    .filter((row) => row.variant_id !== null)
    .map((row) => {
      const blockers = blockersFor({
        product_active: row.product_active,
        product_archived: row.product_archived,
        category_active: row.category_active,
        variant_count: row.variant_count,
        active: row.active ?? false,
        price_vnd: row.price_vnd ?? "0",
        ready: row.ready ?? false,
        route_ready: row.route_ready ?? false,
        evidence_id: row.evidence_id,
        evidence_active: row.evidence_active ?? false,
      });
      return {
        id: row.variant_id!,
        version: row.variant_version ?? 0,
        active: row.active ?? false,
        priceVnd: row.price_vnd ?? "0",
        fulfillmentType: row.fulfillment_type,
        ready: row.ready ?? false,
        routeReady: row.route_ready ?? false,
        evidenceId: row.evidence_id,
        evidenceActive: row.evidence_active ?? false,
        published:
          row.publication_evidence_id === row.evidence_id &&
          row.publication_product_version === row.product_version &&
          row.publication_variant_version === row.variant_version &&
          row.published_at !== null,
        blockers,
      } satisfies VariantPublicationReadiness;
    });
  const activeVariants = variants.filter((variant) => variant.active);
  const blockers = Array.from(
    new Set([
      ...(activeVariants.length === 0 ? ["NO_ACTIVE_VARIANTS" as PublicationBlocker] : []),
      ...(storeMode === "TEST" ? (["STORE_TEST_MODE"] as PublicationBlocker[]) : []),
      ...activeVariants.flatMap((variant) => variant.blockers),
    ]),
  );
  const visibilityBlockers: PublicationBlocker[] = first.product_test ? ["PRODUCT_TEST_ONLY"] : [];
  const version = publicationVersion({
    productVersion: first.product_version,
    productActive: first.product_active,
    productArchived: first.product_archived,
    productTest: first.product_test,
    categoryActive: first.category_active,
    variants: activeVariants.map((variant) => ({
      id: variant.id,
      version: variant.version,
      priceVnd: variant.priceVnd,
      fulfillmentType: variant.fulfillmentType,
      ready: variant.ready,
      routeReady: variant.routeReady,
      evidenceId: variant.evidenceId,
      evidenceActive: variant.evidenceActive,
    })),
  });
  return {
    productId: first.product_id,
    productVersion: first.product_version,
    active: first.product_active,
    archived: first.product_archived,
    testOnly: first.product_test,
    visibilityBlockers,
    variants,
    blockers,
    canPublish: blockers.length === 0,
    publicationVersion: version,
  };
}

export async function countAdminPublicationBlockers(exec: Executor): Promise<number> {
  const products = await sql<{ id: string }>`
    select id from product where is_active and not is_archived
  `.execute(exec);
  const readiness = await Promise.all(
    products.rows.map((row) => getProductPublicationReadiness(exec, row.id)),
  );
  return readiness.filter((item) => item !== null && !item.canPublish).length;
}

export async function registerResaleEvidenceInTransaction(
  exec: Executor,
  input: RegisterResaleEvidenceInput,
): Promise<RegisterResaleEvidenceResult> {
  const source = (RESALE_EVIDENCE_SOURCES as readonly string[]).includes(input.source)
    ? input.source
    : null;
  const reference = normalize(input.reference, 200);
  const summary = normalize(input.summary, 500);
  const reason = normalize(input.reason, 500);
  const requestId = normalize(input.requestId, 128);
  const evidenceText = source && reference && summary ? `${source}|${reference}|${summary}` : "";
  if (
    !source ||
    !reference ||
    !summary ||
    !reason ||
    !requestId ||
    !validMetadata(input.metadataRedacted) ||
    !isSafeResaleEvidenceInput(evidenceText)
  ) {
    return { ok: false, code: "INVALID_INPUT", message: "Bằng chứng hoặc lý do không hợp lệ." };
  }
  if (!isId(input.variantId))
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy biến thể." };
  // Serialize the request key before checking the unique idempotency row. This
  // covers concurrent retries even when the same key is submitted for another variant.
  await sql`select pg_advisory_xact_lock(hashtext(${requestId}))`.execute(exec);
  const existingRequest = await sql<{ id: string; variant_id: string; variant_version: number }>`
    select re.id, re.variant_id, v.version as variant_version
      from resale_evidence re
      join product_variant v on v.id = re.variant_id
     where re.registration_request_id = ${requestId}
     limit 1
  `.execute(exec);
  if (existingRequest.rows[0]) {
    return existingRequest.rows[0].variant_id === input.variantId
      ? {
          ok: true,
          evidenceId: existingRequest.rows[0].id,
          variantVersion: existingRequest.rows[0].variant_version,
          replayed: true,
        }
      : { ok: false, code: "CONFLICT", message: "Mã yêu cầu đã dùng cho biến thể khác." };
  }
  const variant = await sql<{ version: number; is_active: boolean }>`
    select version, is_active from product_variant where id = ${input.variantId} for update
  `.execute(exec);
  if (!variant.rows[0])
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy biến thể." };
  const active = await sql<{ id: string }>`
    select id from resale_evidence where variant_id = ${input.variantId} and status = 'ACTIVE' limit 1
  `.execute(exec);
  if (active.rows[0])
    return {
      ok: false,
      code: "ACTIVE_EVIDENCE_EXISTS",
      message: "Biến thể đã có bằng chứng ACTIVE.",
    };
  const evidenceId = newId();
  await sql`
    insert into resale_evidence
      (id, variant_id, source, reference, summary, metadata_redacted, status, created_by, registration_request_id)
    values
      (${evidenceId}, ${input.variantId}, ${source}, ${reference}, ${summary}, ${JSON.stringify(input.metadataRedacted ?? {})}::jsonb,
       'ACTIVE', ${input.actorId}, ${requestId})
  `.execute(exec);
  await sql`
    update product_variant
       set resale_evidence_id = ${evidenceId}, updated_at = now(), version = version + 1
     where id = ${input.variantId}
  `.execute(exec);
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "catalog.evidence.register",
    targetType: "ProductVariant",
    targetId: input.variantId,
    reason,
    correlationId: input.correlationId,
    metadataRedacted: { evidenceId, source, requestId },
  });
  return { ok: true, evidenceId, variantVersion: variant.rows[0].version + 1, replayed: false };
}

export async function registerResaleEvidence(
  db: Db,
  input: RegisterResaleEvidenceInput,
): Promise<RegisterResaleEvidenceResult> {
  return withTransaction(db, (trx) => registerResaleEvidenceInTransaction(trx, input));
}

/**
 * Owner-initiated revocation of an ACTIVE resale evidence record.
 *
 * Revocation is lifecycle-only, never a rewrite:
 * - 072's trigger still refuses every change to the facts (source, reference,
 *   summary, metadata, created_by, registration request, created_at), so the only
 *   columns this path writes are status/revoked_at/revoked_by/revocation_request_id.
 * - `product_variant.resale_evidence_id` keeps pointing at the revoked record, so a
 *   revoked history is never silently swapped for another record. Callers that want
 *   fresh evidence register a new one explicitly.
 * - The variant version bump makes every existing publication snapshot stale
 *   (`publication_variant_version <> version`) and public visibility additionally
 *   fails on the now non-ACTIVE evidence status.
 *
 * Idempotency: `revocation_request_id` is the durable key, so replaying the same
 * request is a no-op success while reusing it for another record is refused.
 */
export async function revokeResaleEvidenceInTransaction(
  exec: Executor,
  input: RevokeResaleEvidenceInput,
): Promise<RevokeResaleEvidenceResult> {
  const reason = normalize(input.reason, 500);
  const requestId = normalize(input.requestId, 128);
  if (
    !reason ||
    !requestId ||
    !Number.isSafeInteger(input.expectedVariantVersion) ||
    input.expectedVariantVersion < 1
  ) {
    return { ok: false, code: "INVALID_INPUT", message: "Yêu cầu thu hồi không hợp lệ." };
  }
  if (!isId(input.evidenceId) || !isId(input.variantId))
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy bằng chứng." };

  // Lock first: concurrent revocations of the same record serialize here, so the
  // replay/status decisions below cannot race the partial unique index.
  const evidence = await sql<{
    id: string;
    variant_id: string;
    status: string;
    revocation_request_id: string | null;
  }>`
    select id, variant_id, status, revocation_request_id
      from resale_evidence
     where id = ${input.evidenceId}
     for update
  `.execute(exec);
  const row = evidence.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy bằng chứng." };
  if (row.variant_id !== input.variantId)
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy bằng chứng." };

  // Replay is checked before the version guard: a retry of an already-applied
  // request resends the pre-revocation version, which is stale by design.
  if (row.status === "REVOKED") {
    if (row.revocation_request_id !== requestId)
      return {
        ok: false,
        code: "NOT_ACTIVE",
        message: "Bằng chứng đã bị thu hồi bởi yêu cầu khác.",
      };
    const current = await sql<{ version: number }>`
      select version from product_variant where id = ${row.variant_id}
    `.execute(exec);
    return {
      ok: true,
      kind: "REPLAYED",
      evidenceId: row.id,
      variantId: row.variant_id,
      variantVersion: current.rows[0]?.version ?? input.expectedVariantVersion,
    };
  }

  const reused = await sql<{ id: string }>`
    select id from resale_evidence
     where revocation_request_id = ${requestId} and id <> ${row.id}
     limit 1
  `.execute(exec);
  if (reused.rows[0])
    return { ok: false, code: "CONFLICT", message: "Mã yêu cầu đã dùng cho bằng chứng khác." };

  const variant = await sql<{ version: number }>`
    select version from product_variant where id = ${row.variant_id} for update
  `.execute(exec);
  if (!variant.rows[0])
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy biến thể." };
  if (variant.rows[0].version !== input.expectedVariantVersion)
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Biến thể đã thay đổi. Vui lòng mở lại bằng chứng.",
    };

  const revoked = await sql<{ id: string }>`
    update resale_evidence
       set status = 'REVOKED',
           revoked_at = now(),
           revoked_by = ${input.actorId},
           revocation_request_id = ${requestId}
     where id = ${row.id} and variant_id = ${row.variant_id} and status = 'ACTIVE'
    returning id
  `.execute(exec);
  if (!revoked.rows[0])
    return { ok: false, code: "NOT_ACTIVE", message: "Bằng chứng không còn ACTIVE." };

  // Only the version moves. resale_evidence_id, the publication_* snapshot columns
  // and every evidence fact are left untouched: the snapshot goes stale instead of
  // being rewritten to look current.
  const bumped = await sql<{ version: number }>`
    update product_variant
       set version = version + 1, updated_at = now()
     where id = ${row.variant_id} and version = ${input.expectedVariantVersion}
    returning version
  `.execute(exec);
  if (!bumped.rows[0]) {
    // The evidence and variant rows are locked above; reaching this branch means the
    // storage invariant itself was broken. Do not commit a revoked evidence row without
    // its version bump.
    throw new Error("resale evidence revocation lost its variant lock");
  }

  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "catalog.evidence.revoke",
    targetType: "ProductVariant",
    targetId: row.variant_id,
    reason,
    correlationId: input.correlationId,
    metadataRedacted: { evidenceId: row.id, requestId },
  });
  return {
    ok: true,
    kind: "REVOKED",
    evidenceId: row.id,
    variantId: row.variant_id,
    variantVersion: bumped.rows[0].version,
  };
}

export async function revokeResaleEvidence(
  db: Db,
  input: RevokeResaleEvidenceInput,
): Promise<RevokeResaleEvidenceResult> {
  return withTransaction(db, (trx) => revokeResaleEvidenceInTransaction(trx, input));
}

export async function publishProductInTransaction(
  exec: Executor,
  input: PublishProductInput,
): Promise<PublishProductResult> {
  // Serialize publication with CLOSED↔TEST transitions. A shared row lock is
  // held until this transaction commits, so TEST cannot slip between readiness
  // validation and the visibility mutation.
  await sql`select id from store_control where id = 'main' for share`.execute(exec);
  const initial = await getProductPublicationReadiness(exec, input.productId);
  if (!initial) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sản phẩm." };
  if (!initial.canPublish)
    return {
      ok: false,
      code: "NOT_READY",
      message: `Chưa đủ điều kiện: ${initial.blockers.join(", ")}.`,
    };

  const product = await sql<{ version: number; is_test: boolean }>`
    select version, is_test
      from product
     where id = ${input.productId}
     for update
  `.execute(exec);
  if (!product.rows[0])
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sản phẩm." };

  const lockedVariants = await sql<{ id: string; version: number }>`
    select id, version
      from product_variant
     where product_id = ${input.productId} and is_active
     for update
  `.execute(exec);
  const lockedReadiness = await getProductPublicationReadiness(exec, input.productId);
  if (!lockedReadiness)
    return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sản phẩm." };
  if (!lockedReadiness.canPublish)
    return {
      ok: false,
      code: "NOT_READY",
      message: `Chưa đủ điều kiện: ${lockedReadiness.blockers.join(", ")}.`,
    };

  const activeVariants = lockedReadiness.variants.filter((variant) => variant.active);
  const lockedVersions = new Map(lockedVariants.rows.map((row) => [row.id, row.version]));
  if (
    product.rows[0].version !== initial.productVersion ||
    lockedVariants.rows.length !== activeVariants.length ||
    activeVariants.some((variant) => lockedVersions.get(variant.id) !== variant.version)
  ) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sản phẩm hoặc biến thể đã thay đổi. Vui lòng mở lại readiness.",
    };
  }

  // A retried confirmation is safe once every current variant is already bound. This
  // check intentionally precedes the snapshot comparison: the first successful
  // publish may have bumped product.version while completing TEST_ONLY -> PUBLIC.
  if (!product.rows[0].is_test && activeVariants.every((variant) => variant.published)) {
    return {
      ok: true,
      kind: "REPLAYED",
      productId: input.productId,
      publicationVersion: lockedReadiness.publicationVersion,
    };
  }
  if (lockedReadiness.publicationVersion !== input.expectedPublicationVersion) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sản phẩm đã thay đổi. Vui lòng mở lại readiness.",
    };
  }

  let publicationProductVersion = product.rows[0].version;
  if (product.rows[0].is_test) {
    const promoted = await sql<{ version: number }>`
      update product
         set is_test = false, version = version + 1, updated_at = now()
       where id = ${input.productId} and version = ${product.rows[0].version} and is_test
      returning version
    `.execute(exec);
    if (!promoted.rows[0]) throw new Error("catalog publication lost its product lock");
    publicationProductVersion = promoted.rows[0].version;
  }

  const updated = await sql<{ id: string }>`
    update product_variant
       set publication_evidence_id = resale_evidence_id,
           publication_product_version = ${publicationProductVersion},
           publication_variant_version = version,
           published_at = now(),
           published_by = ${input.actorId}
     where product_id = ${input.productId}
       and is_active
       and id in (${sql.join(
         activeVariants.map((variant) => sql`${variant.id}`),
         sql`, `,
       )})
     returning id
  `.execute(exec);
  if (updated.rows.length !== activeVariants.length) {
    throw new Error("catalog publication lost its variant lock");
  }
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "catalog.publish",
    targetType: "Product",
    targetId: input.productId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      publicationVersion: input.expectedPublicationVersion,
      variants: activeVariants.length,
      visibilityChanged: initial.testOnly,
      productVersion: publicationProductVersion,
    },
  });
  const published = await getProductPublicationReadiness(exec, input.productId);
  return {
    ok: true,
    kind: "PUBLISHED",
    productId: input.productId,
    publicationVersion: published?.publicationVersion ?? input.expectedPublicationVersion,
  };
}

export async function publishProduct(
  db: Db,
  input: PublishProductInput,
): Promise<PublishProductResult> {
  return withTransaction(db, (trx) => publishProductInTransaction(trx, input));
}
