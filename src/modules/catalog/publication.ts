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
  variants: VariantPublicationReadiness[];
  blockers: PublicationBlocker[];
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

function publicationVersion(
  productVersion: number,
  variants: Array<{ id: string; version: number; evidenceId: string | null }>,
): string {
  return `${productVersion}:${variants
    .map((v) => `${v.id}:${v.version}:${v.evidenceId ?? "-"}`)
    .sort()
    .join(",")}`;
}

function blockersFor(row: {
  product_active: boolean;
  product_archived: boolean;
  product_test: boolean;
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
  if (row.product_test) blockers.push("PRODUCT_TEST_ONLY");
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
                where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE')
             when v.fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE') then exists (
               select 1 from variant_service_fulfillment sf
                where sf.variant_id = v.id and sf.fulfillment_type = v.fulfillment_type and sf.is_active)
             else false
           end as ready,
           ((v.stock_policy in ('LOCAL_ONLY','LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
             or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API' and exists (
               select 1 from supplier_sku ss join supplier s on s.id = ss.supplier_id
                where ss.variant_id = v.id and ss.is_active and s.status = 'ACTIVE'))) as route_ready,
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
  const first = result.rows[0];
  if (!first) return null;
  const variants = result.rows
    .filter((row) => row.variant_id !== null)
    .map((row) => {
      const blockers = blockersFor({
        product_active: row.product_active,
        product_archived: row.product_archived,
        product_test: row.product_test,
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
      ...activeVariants.flatMap((variant) => variant.blockers),
    ]),
  );
  const version = publicationVersion(first.product_version, activeVariants);
  return {
    productId: first.product_id,
    productVersion: first.product_version,
    active: first.product_active,
    archived: first.product_archived,
    testOnly: first.product_test,
    variants,
    blockers,
    canPublish: blockers.length === 0,
    publicationVersion: version,
  };
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
  const evidenceText =
    source && reference && summary ? `${source}|${reference}|${summary}` : "";
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

export async function publishProductInTransaction(
  exec: Executor,
  input: PublishProductInput,
): Promise<PublishProductResult> {
  const readiness = await getProductPublicationReadiness(exec, input.productId);
  if (!readiness) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy sản phẩm." };
  if (!readiness.canPublish)
    return {
      ok: false,
      code: "NOT_READY",
      message: `Chưa đủ điều kiện: ${readiness.blockers.join(", ")}.`,
    };
  if (readiness.publicationVersion !== input.expectedPublicationVersion) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sản phẩm đã thay đổi. Vui lòng mở lại readiness.",
    };
  }
  const activeVariants = readiness.variants.filter((variant) => variant.active);
  if (activeVariants.every((variant) => variant.published)) {
    return {
      ok: true,
      kind: "REPLAYED",
      productId: input.productId,
      publicationVersion: input.expectedPublicationVersion,
    };
  }
  const product = await sql<{ version: number }>`
    select version from product where id = ${input.productId} for update
  `.execute(exec);
  if (product.rows[0]?.version !== readiness.productVersion) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Sản phẩm đã thay đổi. Vui lòng mở lại readiness.",
    };
  }
  const lockedVariants = await sql<{ id: string; version: number }>`
    select id, version
      from product_variant
     where product_id = ${input.productId} and is_active
     for update
  `.execute(exec);
  const lockedVersions = new Map(lockedVariants.rows.map((row) => [row.id, row.version]));
  if (
    lockedVariants.rows.length !== activeVariants.length ||
    activeVariants.some((variant) => lockedVersions.get(variant.id) !== variant.version)
  ) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Biến thể đã thay đổi. Vui lòng mở lại readiness.",
    };
  }
  const updated = await sql<{ id: string }>`
    update product_variant v
       set publication_evidence_id = v.resale_evidence_id,
           publication_product_version = p.version,
           publication_variant_version = v.version,
           published_at = now(),
           published_by = ${input.actorId}
      from product p
     where v.product_id = p.id and p.id = ${input.productId}
       and p.version = ${readiness.productVersion}
       and v.id in (${sql.join(
         activeVariants.map((variant) => sql`${variant.id}`),
         sql`, `,
       )})
     returning v.id
  `.execute(exec);
  if (updated.rows.length !== activeVariants.length) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      message: "Biến thể đã thay đổi. Vui lòng mở lại readiness.",
    };
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
      variants: readiness.variants.filter((variant) => variant.active).length,
    },
  });
  return {
    ok: true,
    kind: "PUBLISHED",
    productId: input.productId,
    publicationVersion: input.expectedPublicationVersion,
  };
}

export async function publishProduct(
  db: Db,
  input: PublishProductInput,
): Promise<PublishProductResult> {
  return withTransaction(db, (trx) => publishProductInTransaction(trx, input));
}
