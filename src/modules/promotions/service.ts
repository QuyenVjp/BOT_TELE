import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export type PromotionKind = "FIXED_VND" | "PERCENT";
export type RedemptionStatus = "RESERVED" | "CONSUMED" | "RELEASED";

export interface PromotionRule {
  id: string;
  codeNormalized: string;
  kind: PromotionKind;
  valueVnd: bigint | null;
  valuePercent: number | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  maxTotalUses: number | null;
  maxUsesPerCustomer: number | null;
  minimumOrderValueVnd: bigint;
  productId: string | null;
  variantId: string | null;
  active: boolean;
}

export interface PromotionQuote {
  promotionId: string;
  codeNormalized: string;
  baseAmountVnd: bigint;
  discountVnd: bigint;
  finalAmountVnd: bigint;
  snapshot: Record<string, string | number | boolean | null>;
}

export type PromotionErrorCode =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "MINIMUM_NOT_MET"
  | "OUT_OF_SCOPE"
  | "TOTAL_LIMIT"
  | "CUSTOMER_LIMIT"
  | "REPLAY"
  | "INVALID_CODE"
  | "INVALID_AMOUNT";

export type PromotionResult =
  | { ok: true; quote: PromotionQuote; redemptionId?: string }
  | { ok: false; code: PromotionErrorCode; message: string };

export function normalizePromoCode(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized) ? normalized : null;
}

export function calculatePromotionDiscount(
  baseAmountVnd: bigint,
  kind: PromotionKind,
  valueVnd: bigint | null,
  valuePercent: number | null,
): bigint {
  if (baseAmountVnd <= 0n) throw new Error("base amount must be positive");
  const raw =
    kind === "FIXED_VND" ? (valueVnd ?? 0n) : (baseAmountVnd * BigInt(valuePercent ?? 0)) / 100n;
  const maximum = baseAmountVnd - 1n;
  return raw < 0n ? 0n : raw > maximum ? maximum : raw;
}

function dateValue(value: Date | string | null): number | null {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function promotionMessage(code: PromotionErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
      return "Mã ưu đãi không tồn tại.";
    case "INACTIVE":
      return "Mã ưu đãi hiện không còn áp dụng.";
    case "NOT_STARTED":
      return "Mã ưu đãi chưa bắt đầu.";
    case "EXPIRED":
      return "Mã ưu đãi đã hết hạn.";
    case "MINIMUM_NOT_MET":
      return "Đơn hàng chưa đạt giá trị tối thiểu của mã ưu đãi.";
    case "OUT_OF_SCOPE":
      return "Mã ưu đãi không áp dụng cho sản phẩm này.";
    case "TOTAL_LIMIT":
      return "Mã ưu đãi đã hết lượt sử dụng.";
    case "CUSTOMER_LIMIT":
      return "Bạn đã sử dụng hết lượt của mã ưu đãi này.";
    case "REPLAY":
      return "Mã ưu đãi đã được áp dụng cho đơn này.";
    case "INVALID_CODE":
      return "Mã ưu đãi không hợp lệ.";
    case "INVALID_AMOUNT":
      return "Giá trị đơn hàng không hợp lệ.";
  }
  return "Mã ưu đãi không áp dụng được.";
}

function failure(code: PromotionErrorCode): PromotionResult {
  return { ok: false, code, message: promotionMessage(code) };
}

function mapRule(row: {
  id: string;
  code_normalized: string;
  kind: PromotionKind;
  value_vnd: string | null;
  value_percent: number | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  max_total_uses: number | null;
  max_uses_per_customer: number | null;
  minimum_order_value_vnd: string;
  product_id: string | null;
  variant_id: string | null;
  active: boolean;
}): PromotionRule {
  return {
    id: row.id,
    codeNormalized: row.code_normalized,
    kind: row.kind,
    valueVnd: row.value_vnd === null ? null : BigInt(row.value_vnd),
    valuePercent: row.value_percent,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    maxTotalUses: row.max_total_uses,
    maxUsesPerCustomer: row.max_uses_per_customer,
    minimumOrderValueVnd: BigInt(row.minimum_order_value_vnd),
    productId: row.product_id,
    variantId: row.variant_id,
    active: row.active,
  };
}

async function findRule(
  exec: Executor,
  codeNormalized: string,
  lock = false,
): Promise<PromotionRule | null> {
  const result = await sql<Parameters<typeof mapRule>[0]>`
    select id, code_normalized, kind, value_vnd::text, value_percent, starts_at, ends_at,
           max_total_uses, max_uses_per_customer, minimum_order_value_vnd::text,
           product_id, variant_id, active
    from promotion
    where code_normalized = ${codeNormalized}
    limit 1
    ${lock ? sql`for update` : sql``}
  `.execute(exec);
  return result.rows[0] ? mapRule(result.rows[0]) : null;
}

function checkRule(
  rule: PromotionRule,
  input: { baseAmountVnd: bigint; productId: string; variantId: string; now: Date },
): PromotionErrorCode | null {
  if (!rule.active) return "INACTIVE";
  const nowMs = input.now.getTime();
  const starts = dateValue(rule.startsAt);
  const ends = dateValue(rule.endsAt);
  if (starts !== null && nowMs < starts) return "NOT_STARTED";
  if (ends !== null && nowMs >= ends) return "EXPIRED";
  if (input.baseAmountVnd < rule.minimumOrderValueVnd) return "MINIMUM_NOT_MET";
  if (rule.productId !== null && rule.productId !== input.productId) return "OUT_OF_SCOPE";
  if (rule.variantId !== null && rule.variantId !== input.variantId) return "OUT_OF_SCOPE";
  return null;
}

function makeQuote(
  rule: PromotionRule,
  baseAmountVnd: bigint,
  productId: string,
  variantId: string,
): PromotionQuote {
  const discountVnd = calculatePromotionDiscount(
    baseAmountVnd,
    rule.kind,
    rule.valueVnd,
    rule.valuePercent,
  );
  return {
    promotionId: rule.id,
    codeNormalized: rule.codeNormalized,
    baseAmountVnd,
    discountVnd,
    finalAmountVnd: baseAmountVnd - discountVnd,
    snapshot: {
      promotionId: rule.id,
      code: rule.codeNormalized,
      kind: rule.kind,
      valueVnd: rule.valueVnd?.toString() ?? null,
      valuePercent: rule.valuePercent,
      productId,
      variantId,
      baseAmountVnd: baseAmountVnd.toString(),
      discountVnd: discountVnd.toString(),
      finalAmountVnd: (baseAmountVnd - discountVnd).toString(),
    },
  };
}

export async function quotePromotion(
  exec: Executor,
  input: {
    code: string;
    baseAmountVnd: bigint;
    productId: string;
    variantId: string;
    now?: Date;
  },
): Promise<PromotionResult> {
  const codeNormalized = normalizePromoCode(input.code);
  if (!codeNormalized || input.baseAmountVnd <= 0n) return failure("INVALID_CODE");
  const rule = await findRule(exec, codeNormalized);
  if (!rule) return failure("NOT_FOUND");
  const invalid = checkRule(rule, {
    baseAmountVnd: input.baseAmountVnd,
    productId: input.productId,
    variantId: input.variantId,
    now: input.now ?? new Date(),
  });
  return invalid
    ? failure(invalid)
    : { ok: true, quote: makeQuote(rule, input.baseAmountVnd, input.productId, input.variantId) };
}

export async function reservePromotion(
  exec: Executor,
  input: {
    code: string;
    customerId: string;
    orderId: string;
    baseAmountVnd: bigint;
    productId: string;
    variantId: string;
    now?: Date;
  },
): Promise<PromotionResult> {
  const codeNormalized = normalizePromoCode(input.code);
  if (!codeNormalized || input.baseAmountVnd <= 0n) return failure("INVALID_CODE");
  const rule = await findRule(exec, codeNormalized, true);
  if (!rule) return failure("NOT_FOUND");
  const invalid = checkRule(rule, {
    baseAmountVnd: input.baseAmountVnd,
    productId: input.productId,
    variantId: input.variantId,
    now: input.now ?? new Date(),
  });
  if (invalid) return failure(invalid);
  const quote = makeQuote(rule, input.baseAmountVnd, input.productId, input.variantId);
  const totals = await sql<{ total: number; customer: number }>`
    select
      count(*) filter (where status in ('RESERVED','CONSUMED'))::int as total,
      count(*) filter (where status in ('RESERVED','CONSUMED') and customer_id = ${input.customerId})::int as customer
    from promotion_redemption
    where promotion_id = ${rule.id}
  `.execute(exec);
  const counts = totals.rows[0];
  if (rule.maxTotalUses !== null && (counts?.total ?? 0) >= rule.maxTotalUses)
    return failure("TOTAL_LIMIT");
  if (rule.maxUsesPerCustomer !== null && (counts?.customer ?? 0) >= rule.maxUsesPerCustomer)
    return failure("CUSTOMER_LIMIT");
  const redemptionId = newId();
  try {
    await sql`
      insert into promotion_redemption
        (id, promotion_id, order_id, customer_id, code_normalized, base_amount_vnd, discount_vnd, status)
      values
        (${redemptionId}, ${rule.id}, ${input.orderId}, ${input.customerId}, ${rule.codeNormalized},
         ${quote.baseAmountVnd}, ${quote.discountVnd}, 'RESERVED')
    `.execute(exec);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "23505")
      return failure("REPLAY");
    throw error;
  }
  return { ok: true, quote, redemptionId };
}

export async function consumePromotion(exec: Executor, orderId: string): Promise<void> {
  await sql`
    update promotion_redemption
    set status = 'CONSUMED', consumed_at = coalesce(consumed_at, now())
    where order_id = ${orderId} and status = 'RESERVED'
  `.execute(exec);
}

export async function releasePromotion(exec: Executor, orderId: string): Promise<void> {
  await sql`
    update promotion_redemption
    set status = 'RELEASED', released_at = coalesce(released_at, now())
    where order_id = ${orderId} and status = 'RESERVED'
  `.execute(exec);
}
export async function savePromotionDraft(
  db: Db,
  input: { customerId: string; code: string; ttlSeconds?: number },
): Promise<{ ok: true; codeNormalized: string } | { ok: false; code: "INVALID_CODE" }> {
  const codeNormalized = normalizePromoCode(input.code);
  if (!codeNormalized) return { ok: false, code: "INVALID_CODE" };
  const ttlSeconds = Math.min(3600, Math.max(60, Math.trunc(input.ttlSeconds ?? 900)));
  await sql`
    insert into customer_promotion_draft (customer_id, code_normalized, expires_at)
    values (${input.customerId}, ${codeNormalized}, now() + (${ttlSeconds} * interval '1 second'))
    on conflict (customer_id) do update
      set code_normalized = excluded.code_normalized,
          expires_at = excluded.expires_at,
          created_at = now()
  `.execute(db);
  return { ok: true, codeNormalized };
}

export async function getPromotionDraft(
  exec: Executor,
  customerId: string,
): Promise<string | null> {
  const result = await sql<{ code_normalized: string }>`
    select code_normalized
    from customer_promotion_draft
    where customer_id = ${customerId} and expires_at > now()
    limit 1
  `.execute(exec);
  return result.rows[0]?.code_normalized ?? null;
}

export async function clearPromotionDraft(
  db: Db,
  customerId: string,
  codeNormalized?: string,
): Promise<void> {
  await sql`
    delete from customer_promotion_draft
    where customer_id = ${customerId}
      and (${codeNormalized ?? null}::text is null or code_normalized = ${codeNormalized ?? null})
  `.execute(db);
}
