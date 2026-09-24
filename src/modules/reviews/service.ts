import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import { generateCustomerAlias } from "../marketing/social-proof.js";
import { newId } from "../../shared/ids/index.js";

export type ReviewStatus = "VISIBLE" | "HIDDEN";

export interface ReviewEligibility {
  orderId: string;
  customerId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
}

export interface PublicReview {
  id: string;
  productId: string;
  variantId: string;
  rating: number;
  comment: string;
  customerAlias: string;
  createdAt: string;
}

export interface ProductReviewSummary {
  productId: string;
  averageRating: number;
  visibleCount: number;
}

export type ReviewWriteResult =
  | { ok: true; reviewId: string }
  | {
      ok: false;
      code:
        | "NOT_ELIGIBLE"
        | "ORDER_NOT_FOUND"
        | "NOT_OWNER"
        | "DUPLICATE"
        | "REVIEW_NOT_FOUND"
        | "INVALID_RATING"
        | "INVALID_COMMENT";
    };

async function findEligibility(
  exec: Executor,
  orderId: string,
  customerId: string,
): Promise<ReviewEligibility | null> {
  const result = await sql<{
    order_id: string;
    customer_id: string;
    product_id: string;
    variant_id: string;
    product_name: string;
    variant_name: string;
  }>`
    select
      o.id as order_id,
      o.customer_id,
      v.product_id,
      v.id as variant_id,
      p.name_vi as product_name,
      v.name_vi as variant_name
    from "order" o
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    where o.id = ${orderId}
      and o.customer_id = ${customerId}
      and o.status = 'COMPLETED'
      and not p.is_test
      and not p.is_archived
      and not exists (
        select 1
        from payment_intent refunded
        where refunded.order_id = o.id
          and refunded.status in ('PARTIALLY_REFUNDED', 'REFUNDED')
      )
      and exists (
        select 1 from payment_intent pi
        where pi.order_id = o.id and pi.status = 'SUCCEEDED'
      )
      and exists (
        select 1
        from payment_allocation pa
        join payment_intent pi on pi.id = pa.payment_intent_id
        where pi.order_id = o.id and pa.status = 'SETTLED'
      )
      and (
        exists (
          select 1 from digital_asset da
          where da.delivered_order_id = o.id
            and da.variant_id = o.variant_id
            and da.status = 'DELIVERED'
        )
        or exists (
          select 1 from manual_fulfillment_task mft
          where mft.order_id = o.id
            and mft.customer_id = o.customer_id
            and mft.status = 'COMPLETED'
        )
      )
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  return row
    ? {
        orderId: row.order_id,
        customerId: row.customer_id,
        productId: row.product_id,
        variantId: row.variant_id,
        productName: row.product_name,
        variantName: row.variant_name,
      }
    : null;
}

export async function getReviewEligibility(
  exec: Executor,
  input: { orderId: string; customerId: string },
): Promise<ReviewEligibility | null> {
  return findEligibility(exec, input.orderId, input.customerId);
}

export async function createReview(
  db: Db,
  input: {
    orderId: string;
    customerId: string;
    rating: number;
    comment?: string;
  },
): Promise<ReviewWriteResult> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
    return { ok: false, code: "INVALID_RATING" };
  const comment = input.comment?.trim() ?? "";
  if (comment.length > 1000) return { ok: false, code: "INVALID_COMMENT" };
  const eligibility = await findEligibility(db, input.orderId, input.customerId);
  if (!eligibility) return { ok: false, code: "NOT_ELIGIBLE" };
  const id = newId();
  try {
    await sql`
      insert into product_review
        (id, order_id, customer_id, product_id, variant_id, rating, comment)
      values
        (${id}, ${eligibility.orderId}, ${eligibility.customerId}, ${eligibility.productId},
         ${eligibility.variantId}, ${input.rating}, ${comment})
    `.execute(db);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "23505")
      return { ok: false, code: "DUPLICATE" };
    throw error;
  }
  return { ok: true, reviewId: id };
}

export async function updateReview(
  db: Db,
  input: { reviewId: string; customerId: string; rating: number; comment?: string },
): Promise<ReviewWriteResult> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
    return { ok: false, code: "INVALID_RATING" };
  const comment = input.comment?.trim() ?? "";
  if (comment.length > 1000) return { ok: false, code: "INVALID_COMMENT" };
  const eligibility = await sql<{ order_id: string }>`
    select r.order_id
    from product_review r
    where r.id = ${input.reviewId} and r.customer_id = ${input.customerId}
  `.execute(db);
  if (!eligibility.rows[0]) return { ok: false, code: "REVIEW_NOT_FOUND" };
  const eligible = await findEligibility(db, eligibility.rows[0].order_id, input.customerId);
  if (!eligible) return { ok: false, code: "NOT_ELIGIBLE" };
  await sql`
    update product_review
    set rating = ${input.rating}, comment = ${comment}, updated_at = now()
    where id = ${input.reviewId} and customer_id = ${input.customerId}
  `.execute(db);
  return { ok: true, reviewId: input.reviewId };
}

export async function listVisibleProductReviews(
  exec: Executor,
  input: { productId: string; limit?: number; aliasSalt: string },
): Promise<PublicReview[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const rows = await sql<{
    id: string;
    product_id: string;
    variant_id: string;
    rating: number;
    comment: string;
    customer_id: string;
    created_at: Date | string;
  }>`
    select id, product_id, variant_id, rating, comment, customer_id, created_at
    from product_review
    where product_id = ${input.productId} and status = 'VISIBLE'
    order by created_at desc, id desc
    limit ${limit}
  `.execute(exec);
  return rows.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    rating: row.rating,
    comment: row.comment,
    customerAlias: generateCustomerAlias(row.customer_id, input.aliasSalt),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  }));
}

export async function getProductReviewSummary(
  exec: Executor,
  productId: string,
): Promise<ProductReviewSummary> {
  const rows = await sql<{ average_rating: string | null; visible_count: number }>`
    select avg(rating)::text as average_rating, count(*)::int as visible_count
    from product_review
    where product_id = ${productId} and status = 'VISIBLE'
  `.execute(exec);
  const row = rows.rows[0];
  return {
    productId,
    averageRating: row?.average_rating ? Number(row.average_rating) : 0,
    visibleCount: row?.visible_count ?? 0,
  };
}

export interface ReviewModerationRow {
  id: string;
  productName: string;
  variantName: string;
  rating: number;
  comment: string;
  status: ReviewStatus;
  customerAlias: string;
  createdAt: string;
}

export async function listReviewModeration(
  exec: Executor,
  input: { status?: ReviewStatus; limit?: number; aliasSalt: string },
): Promise<ReviewModerationRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const rows = await sql<{
    id: string;
    product_name: string;
    variant_name: string;
    rating: number;
    comment: string;
    status: ReviewStatus;
    customer_id: string;
    created_at: Date | string;
  }>`
    select r.id, p.name_vi as product_name, v.name_vi as variant_name, r.rating, r.comment,
           r.status, r.customer_id, r.created_at
    from product_review r
    join product p on p.id = r.product_id
    join product_variant v on v.id = r.variant_id
    where (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
    order by r.created_at desc, r.id desc
    limit ${limit}
  `.execute(exec);
  return rows.rows.map((row) => ({
    id: row.id,
    productName: row.product_name,
    variantName: row.variant_name,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    customerAlias: generateCustomerAlias(row.customer_id, input.aliasSalt),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  }));
}

export async function moderateReview(
  db: Db,
  input: {
    reviewId: string;
    status: ReviewStatus;
    adminId: string;
    reason: string;
    correlationId: string;
  },
): Promise<{ ok: true } | { ok: false; code: "REVIEW_NOT_FOUND" }> {
  return withTransaction(db, async (trx) => {
    const current = await sql<{ status: ReviewStatus }>`
      select status from product_review where id = ${input.reviewId} for update
    `.execute(trx);
    if (!current.rows[0]) return { ok: false, code: "REVIEW_NOT_FOUND" } as const;
    await sql`
      update product_review set status = ${input.status}, updated_at = now()
      where id = ${input.reviewId}
    `.execute(trx);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: input.adminId,
      action: input.status === "HIDDEN" ? "review.hide" : "review.restore",
      targetType: "ProductReview",
      targetId: input.reviewId,
      reason: input.reason,
      correlationId: input.correlationId,
      metadataRedacted: { beforeStatus: current.rows[0].status, afterStatus: input.status },
    });
    return { ok: true } as const;
  });
}
