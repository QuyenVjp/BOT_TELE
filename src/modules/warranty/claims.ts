/**
 * Warranty claims (goal: warranty / defect report / prorated refund).
 *
 * Owner policy, enforced structurally rather than by convention:
 *
 *  * The system CALCULATES. It recommends a prorated refund from remaining usable time and stores
 *    that recommendation in an immutable report-time snapshot. It never decides eligibility: an
 *    admin verifies the delivered resource and chooses the outcome.
 *  * The system NEVER MOVES MONEY. Approval creates a durable obligation in the existing
 *    `shop_refund_obligation` table and stops there — no bank call, no wallet credit, no claim that
 *    money left. Only an explicit admin action records that a manual transfer happened.
 *  * The report time is the only clock. `reported_at` is captured on first submission and every
 *    later step reads the stored snapshot, so a slow review cannot shrink the refund.
 *
 * Replacements are delegated to the existing `replacement_case` engine; a claim only links to it.
 */
import { sql } from "kysely";
import { newId } from "../../shared/ids/index.js";
import { withTransaction, type Db, type Executor } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../identity/audit.js";
import {
  authorizeRootAction,
  type RootActor,
  type RootAdminConfig,
} from "../identity/root-admin.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { computeProratedRefund, isWithinWarranty, type ProratedRefund } from "./proration.js";
import { approveReplacementCaseInTransaction } from "../digital-goods/replacement.js";

export type WarrantyIssueType =
  | "ACCOUNT_LOCKED"
  | "LOST_BENEFITS"
  | "CANNOT_SIGN_IN"
  | "TWO_FACTOR_PROBLEM"
  | "WRONG_DELIVERY"
  | "OTHER";

export const ISSUE_TYPE_LABELS: Record<WarrantyIssueType, string> = {
  ACCOUNT_LOCKED: "🔒 Tài khoản bị khóa",
  LOST_BENEFITS: "⭐ Mất gói / mất quyền lợi",
  CANNOT_SIGN_IN: "🔑 Không đăng nhập được",
  TWO_FACTOR_PROBLEM: "🔐 Lỗi 2FA / Recovery",
  WRONG_DELIVERY: "📦 Sai thông tin được giao",
  OTHER: "❓ Lỗi khác",
};

export type WarrantyClaimStatus =
  | "SUBMITTED"
  | "TRIAGE"
  | "WAITING_CUSTOMER"
  | "VERIFIED_DEFECT"
  | "REPLACEMENT_APPROVED"
  | "REFUND_APPROVED"
  | "REFUND_DUE"
  | "REFUND_PAID"
  | "REJECTED"
  | "RESOLVED"
  | "CANCELLED";

/** Fallback review window when a variant does not configure its own; used for the SLA counter. */
export const WARRANTY_REVIEW_SLA_HOURS = 12;

export interface OpenClaimInput {
  db: Db;
  customerId: string;
  orderId: string;
  assetId?: string | undefined;
  issueType: WarrantyIssueType;
  customerNote?: string | undefined;
  evidenceFileIds?: readonly string[] | undefined;
  correlationId: string;
  /** Injectable clock: tests pin `reported_at`, production uses the server time. */
  now?: Date | undefined;
}

export type OpenClaimResult =
  | {
      ok: true;
      claimId: string;
      claimNumber: string;
      status: WarrantyClaimStatus;
      snapshot: ProratedRefund;
      idempotent: boolean;
    }
  | {
      ok: false;
      code:
        | "ORDER_NOT_FOUND"
        | "ORDER_NOT_OWNED"
        | "NOT_FULFILLED"
        | "ASSET_NOT_DELIVERED"
        | "WARRANTY_EXPIRED"
        | "WARRANTY_NOT_ENABLED"
        | "INVALID_ISSUE";
    };

interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  variant_id: string;
  price_vnd: string;
  warranty_days: number;
  completed_at: Date | string | null;
}

/** The structured policy as it stands on the variant when a claim is opened. */
interface WarrantyPolicy {
  policyVersion: number;
  coverageVi: string | null;
  exclusionsVi: string | null;
  prorationEnabled: boolean;
  replacementAllowed: boolean;
  refundAllowed: boolean;
  replacementBehavior: "CONTINUE_ORIGINAL_END" | "RESET_FROM_REPLACEMENT";
  slaHours: number;
  enabled: boolean;
}

const ACTIVE_STATUSES = [
  "SUBMITTED",
  "TRIAGE",
  "WAITING_CUSTOMER",
  "VERIFIED_DEFECT",
  "REPLACEMENT_APPROVED",
  "REFUND_APPROVED",
  "REFUND_DUE",
  "REFUND_PAID",
];

function claimNumber(id: string): string {
  return `BH-${id.slice(-6).toUpperCase()}`;
}

/**
 * The warranty clock starts when usable goods were actually delivered — `completed_at` — never at
 * order creation or payment. An order that has not been fulfilled has no warranty running yet.
 */
function warrantyTermsOf(order: OrderRow): { warrantyDays: number; warrantyStart: Date } | null {
  if (!order.completed_at) return null;
  if (!Number.isFinite(order.warranty_days) || order.warranty_days <= 0) return null;
  return {
    warrantyDays: order.warranty_days,
    warrantyStart:
      order.completed_at instanceof Date ? order.completed_at : new Date(order.completed_at),
  };
}

export async function openWarrantyClaim(input: OpenClaimInput): Promise<OpenClaimResult> {
  const reportedAt = input.now ?? new Date();
  return withTransaction(input.db, async (trx) => {
    const orders = await sql<
      OrderRow & {
        warranty_enabled: boolean;
        warranty_proration_enabled: boolean;
        warranty_replacement_allowed: boolean;
        warranty_refund_allowed: boolean;
        warranty_replacement_behavior: string;
        warranty_coverage_vi: string | null;
        warranty_exclusions_vi: string | null;
        warranty_policy_version: number;
        warranty_sla_hours: number;
      }
    >`
      select o.id, o.order_number, o.customer_id, o.variant_id, o.price_vnd::text as price_vnd,
             o.warranty_days, o.completed_at,
             v.warranty_enabled, v.warranty_proration_enabled, v.warranty_replacement_allowed,
             v.warranty_refund_allowed, v.warranty_replacement_behavior, v.warranty_coverage_vi,
             v.warranty_exclusions_vi, v.warranty_policy_version, v.warranty_sla_hours
      from "order" o
      join product_variant v on v.id = o.variant_id
      where o.id = ${input.orderId}
      limit 1
    `.execute(trx);
    const order = orders.rows[0];
    if (!order) return { ok: false, code: "ORDER_NOT_FOUND" };
    // Ownership is checked before anything else: a claim is never opened for someone else's order.
    if (order.customer_id !== input.customerId) return { ok: false, code: "ORDER_NOT_OWNED" };

    // A variant without a warranty (or with the days set to zero) has no claim to open; the owner
    // can still handle the customer through ordinary support.
    if (!order.warranty_enabled || order.warranty_days <= 0)
      return { ok: false, code: "WARRANTY_NOT_ENABLED" };
    const terms = warrantyTermsOf(order);
    if (!terms) return { ok: false, code: "WARRANTY_NOT_ENABLED" };
    const policy: WarrantyPolicy = {
      enabled: order.warranty_enabled,
      policyVersion: order.warranty_policy_version,
      coverageVi: order.warranty_coverage_vi,
      exclusionsVi: order.warranty_exclusions_vi,
      prorationEnabled: order.warranty_proration_enabled,
      replacementAllowed: order.warranty_replacement_allowed,
      refundAllowed: order.warranty_refund_allowed,
      replacementBehavior:
        order.warranty_replacement_behavior === "RESET_FROM_REPLACEMENT"
          ? "RESET_FROM_REPLACEMENT"
          : "CONTINUE_ORIGINAL_END",
      slaHours: order.warranty_sla_hours,
    };

    if (input.assetId) {
      const asset = await sql<{ id: string; delivered_order_id: string | null }>`
        select id, delivered_order_id from digital_asset where id = ${input.assetId} limit 1
      `.execute(trx);
      const delivered = asset.rows[0];
      if (!delivered || delivered.delivered_order_id !== order.id)
        return { ok: false, code: "ASSET_NOT_DELIVERED" };
    }

    // Existing active case for the same asset/order: a double submit reuses it instead of opening
    // a second one (the partial unique index is the final backstop).
    const existing = await sql<{ id: string; status: WarrantyClaimStatus }>`
      select id, status from warranty_claim
      where order_id = ${order.id}
        and coalesce(original_asset_id, '') = ${input.assetId ?? ""}
        and status = any(${sql.val(ACTIVE_STATUSES)}::text[])
      limit 1
      for update
    `.execute(trx);
    if (existing.rows[0]) {
      const snap = await snapshotOf(trx, existing.rows[0].id);
      return snap
        ? {
            ok: true,
            claimId: existing.rows[0].id,
            claimNumber: claimNumber(existing.rows[0].id),
            status: existing.rows[0].status,
            snapshot: snap,
            idempotent: true,
          }
        : { ok: false, code: "ORDER_NOT_FOUND" };
    }

    // Past the end: this is not a covered claim. The customer sees the expiry screen and an admin
    // may still open an exceptional support case outside warranty (goal §38).
    if (!isWithinWarranty(terms, reportedAt)) return { ok: false, code: "WARRANTY_EXPIRED" };

    const paidAmountVnd = BigInt(order.price_vnd);
    // Proration off means the policy refunds the whole paid amount while the warranty is live.
    // The rule used is recorded on the claim, so a later policy edit cannot reinterpret it.
    const snapshot = policy.prorationEnabled
      ? computeProratedRefund({ ...terms, paidAmountVnd, reportedAt })
      : {
          ...computeProratedRefund({ ...terms, paidAmountVnd, reportedAt }),
          refundVnd: paidAmountVnd,
        };

    const id = newId();
    const slaHours = policy.slaHours > 0 ? policy.slaHours : WARRANTY_REVIEW_SLA_HOURS;
    const slaDueAt = new Date(reportedAt.getTime() + slaHours * 60 * 60 * 1000);
    await sql`
      insert into warranty_claim (
        id, claim_number, customer_id, order_id, variant_id, original_asset_id,
        issue_type, customer_note, evidence_file_ids,
        reported_at, warranty_start, warranty_end, warranty_days, used_days, remaining_days,
        paid_amount_vnd, calculated_refund_vnd, status, review_sla_due_at,
        policy_version, coverage_snapshot, exclusions_snapshot, proration_enabled,
        replacement_allowed, refund_allowed, replacement_warranty_behavior
      ) values (
        ${id}, ${claimNumber(id)}, ${input.customerId}, ${order.id}, ${order.variant_id},
        ${input.assetId ?? null}, ${input.issueType}, ${input.customerNote?.slice(0, 1000) ?? null},
        ${sql.val([...(input.evidenceFileIds ?? [])].slice(0, 5))}::text[],
        ${snapshot.reportedAt}, ${snapshot.warrantyStart}, ${snapshot.warrantyEnd},
        ${terms.warrantyDays}, ${snapshot.usedDays}, ${snapshot.remainingDays},
        ${snapshot.paidAmountVnd.toString()}, ${snapshot.refundVnd.toString()},
        'SUBMITTED', ${slaDueAt.toISOString()},
        ${policy.policyVersion}, ${policy.coverageVi}, ${policy.exclusionsVi},
        ${policy.prorationEnabled}, ${policy.replacementAllowed}, ${policy.refundAllowed},
        ${policy.replacementBehavior}
      )
    `.execute(trx);

    await appendClaimEvent(trx, id, "SUBMITTED", null);
    await appendAuditEvent(trx, {
      actorType: "CUSTOMER",
      actorId: input.customerId,
      action: "warranty.claim_submitted",
      targetType: "WarrantyClaim",
      targetId: id,
      reason: "Customer warranty report",
      correlationId: input.correlationId,
      metadataRedacted: {
        issueType: input.issueType,
        usedDays: snapshot.usedDays,
        remainingDays: snapshot.remainingDays,
        calculatedRefundVnd: snapshot.refundVnd.toString(),
        evidenceCount: input.evidenceFileIds?.length ?? 0,
      },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyClaimOpened",
      aggregateType: "WarrantyClaim",
      aggregateId: id,
      aggregateVersion: 1,
      payloadRedacted: {
        claimId: id,
        claimNumber: claimNumber(id),
        orderNumber: order.order_number,
        customerId: input.customerId,
        issueType: input.issueType,
        usedDays: snapshot.usedDays,
        remainingDays: snapshot.remainingDays,
        calculatedRefundVnd: snapshot.refundVnd.toString(),
        productName: null,
        correlationId: input.correlationId,
      },
    });

    return {
      ok: true,
      claimId: id,
      claimNumber: claimNumber(id),
      status: "SUBMITTED",
      snapshot,
      idempotent: false,
    };
  });
}

async function snapshotOf(exec: Executor, claimId: string): Promise<ProratedRefund | null> {
  const row = await sql<{
    reported_at: Date | string;
    warranty_start: Date | string;
    warranty_end: Date | string;
    warranty_days: number;
    used_days: number;
    remaining_days: number;
    paid_amount_vnd: string;
    calculated_refund_vnd: string;
  }>`
    select reported_at, warranty_start, warranty_end, warranty_days, used_days, remaining_days,
           paid_amount_vnd::text as paid_amount_vnd, calculated_refund_vnd::text as calculated_refund_vnd
    from warranty_claim where id = ${claimId} limit 1
  `.execute(exec);
  const row0 = row.rows[0];
  if (!row0) return null;
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    reportedAt: iso(row0.reported_at),
    warrantyStart: iso(row0.warranty_start),
    warrantyEnd: iso(row0.warranty_end),
    usedDays: row0.used_days,
    remainingDays: row0.remaining_days,
    paidAmountVnd: BigInt(row0.paid_amount_vnd),
    refundVnd: BigInt(row0.calculated_refund_vnd),
  };
}

async function appendClaimEvent(
  exec: Executor,
  claimId: string,
  kind: string,
  safeNote: string | null,
): Promise<void> {
  await sql`
    insert into warranty_claim_event (id, claim_id, kind, safe_note)
    values (${newId()}, ${claimId}, ${kind}, ${safeNote})
  `.execute(exec);
}

export interface AdminClaimActionInput {
  db: Db;
  actor: RootActor;
  config: RootAdminConfig;
  claimId: string;
  correlationId: string;
  now?: Date | undefined;
}

export type AdminClaimResult =
  | {
      ok: true;
      claimId: string;
      status: WarrantyClaimStatus;
      idempotent?: boolean;
      obligationId?: string;
      replacementCaseId?: string;
    }
  | {
      ok: false;
      code:
        | "NOT_ROOT_ADMIN"
        | "WRONG_CONTEXT"
        | "NOT_FOUND"
        | "ILLEGAL_STATE"
        | "INVALID_REASON"
        | "OUT_OF_STOCK"
        | "NOT_ALLOWED_BY_POLICY";
    };

async function loadClaimForUpdate(exec: Executor, claimId: string) {
  const rows = await sql<{
    id: string;
    status: WarrantyClaimStatus;
    customer_id: string;
    order_id: string;
    original_asset_id: string | null;
    calculated_refund_vnd: string;
    approved_refund_vnd: string | null;
    refund_obligation_id: string | null;
    replacement_case_id: string | null;
    refund_allowed: boolean;
    replacement_allowed: boolean;
    account_number: string | null;
    bank_name: string | null;
    account_holder: string | null;
  }>`
    select id, status, customer_id, order_id, original_asset_id,
           calculated_refund_vnd::text as calculated_refund_vnd,
           approved_refund_vnd::text as approved_refund_vnd,
           refund_obligation_id, replacement_case_id, refund_allowed, replacement_allowed,
           refund_account_number as account_number, refund_bank_name as bank_name,
           refund_account_holder as account_holder
    from warranty_claim where id = ${claimId} limit 1 for update
  `.execute(exec);
  return rows.rows[0] ?? null;
}

async function setStatus(
  exec: Executor,
  claimId: string,
  status: WarrantyClaimStatus,
  extra: { reviewedBy?: string; resolved?: boolean } = {},
): Promise<void> {
  // Postgres cannot infer a parameter's type inside `case when $1 is null`, so both are cast.
  await sql`
    update warranty_claim
    set status = ${status},
        reviewed_by = coalesce(${extra.reviewedBy ?? null}::text, reviewed_by),
        reviewed_at = case when ${extra.reviewedBy ?? null}::text is null then reviewed_at else now() end,
        resolved_at = case when ${extra.resolved === true}::boolean then now() else resolved_at end,
        updated_at = now(),
        version = version + 1
    where id = ${claimId}
  `.execute(exec);
}

function guard(
  input: AdminClaimActionInput,
): { ok: true; actorId: string } | { ok: false; code: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT" } {
  const auth = authorizeRootAction(input.actor, input.config);
  if (!auth.ok) return { ok: false, code: auth.reason };
  return { ok: true, actorId: String(input.actor.numericUserId) };
}

/** Request more information: the claim waits on the customer, no financial effect. */
export async function requestClaimInfo(
  input: AdminClaimActionInput & { note: string },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  const note = input.note.trim().slice(0, 500);
  if (!note) return { ok: false, code: "INVALID_REASON" };
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (!["SUBMITTED", "TRIAGE"].includes(claim.status))
      return { ok: false, code: "ILLEGAL_STATE" };
    await setStatus(trx, claim.id, "WAITING_CUSTOMER", { reviewedBy: gate.actorId });
    await appendClaimEvent(trx, claim.id, "WAITING_CUSTOMER", note);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.info_requested",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason: note,
      correlationId: input.correlationId,
      metadataRedacted: { previousStatus: claim.status },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyClaimNeedsInfo",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: { claimId: claim.id, customerId: claim.customer_id, note },
    });
    return { ok: true, claimId: claim.id, status: "WAITING_CUSTOMER" };
  });
}

/**
 * Admin confirms the delivered resource is defective. This is the ONLY place eligibility is
 * decided — the customer's issue selection never reaches this state on its own.
 */
export async function verifyClaimDefect(
  input: AdminClaimActionInput & { note?: string },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (claim.status === "VERIFIED_DEFECT")
      return { ok: true, claimId: claim.id, status: claim.status, idempotent: true };
    if (!["SUBMITTED", "TRIAGE", "WAITING_CUSTOMER"].includes(claim.status))
      return { ok: false, code: "ILLEGAL_STATE" };
    await setStatus(trx, claim.id, "VERIFIED_DEFECT", { reviewedBy: gate.actorId });
    await appendClaimEvent(trx, claim.id, "VERIFIED_DEFECT", input.note ?? null);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.defect_verified",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason: input.note ?? "Admin verified the delivered resource",
      correlationId: input.correlationId,
      metadataRedacted: { previousStatus: claim.status },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyClaimVerified",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: { claimId: claim.id, customerId: claim.customer_id },
    });
    return { ok: true, claimId: claim.id, status: "VERIFIED_DEFECT" };
  });
}

export async function rejectClaim(
  input: AdminClaimActionInput & { reason: string },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, code: "INVALID_REASON" };
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (claim.status === "REJECTED")
      return { ok: true, claimId: claim.id, status: "REJECTED", idempotent: true };
    if (["REFUND_PAID", "RESOLVED", "CANCELLED"].includes(claim.status))
      return { ok: false, code: "ILLEGAL_STATE" };
    await setStatus(trx, claim.id, "REJECTED", { reviewedBy: gate.actorId, resolved: true });
    await sql`update warranty_claim set rejection_reason = ${reason} where id = ${claim.id}`.execute(
      trx,
    );
    await appendClaimEvent(trx, claim.id, "REJECTED", reason);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.claim_rejected",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason,
      correlationId: input.correlationId,
      metadataRedacted: { previousStatus: claim.status },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyClaimRejected",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: { claimId: claim.id, customerId: claim.customer_id, reason },
    });
    return { ok: true, claimId: claim.id, status: "REJECTED" };
  });
}

/**
 * Approve the refund. Creates EXACTLY ONE durable obligation in the existing
 * `shop_refund_obligation` table and stops: nothing here can move money.
 */
export async function approveClaimRefund(
  input: AdminClaimActionInput & { amountVnd?: bigint; overrideReason?: string },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (claim.refund_obligation_id)
      return {
        ok: true,
        claimId: claim.id,
        status: claim.status,
        idempotent: true,
        obligationId: claim.refund_obligation_id,
      };
    if (!["VERIFIED_DEFECT", "REFUND_APPROVED", "REFUND_DUE"].includes(claim.status))
      return { ok: false, code: "ILLEGAL_STATE" };
    if (!claim.refund_allowed) return { ok: false, code: "NOT_ALLOWED_BY_POLICY" };

    const recommended = BigInt(claim.calculated_refund_vnd);
    const approved = input.amountVnd ?? recommended;
    if (approved < 0n) return { ok: false, code: "INVALID_REASON" };
    const overridden = approved !== recommended;
    const overrideReason = input.overrideReason?.trim().slice(0, 300) ?? null;
    // An adjustment always carries a reason: the audit trail must explain the difference.
    if (overridden && !overrideReason) return { ok: false, code: "INVALID_REASON" };

    const obligationId = newId();
    await sql`
      insert into shop_refund_obligation (
        id, customer_id, amount_vnd, status, reason, created_by, order_id, claim_id,
        recommended_amount_vnd, approved_amount_vnd, override_reason,
        bank_name, account_number, account_holder
      ) values (
        ${obligationId}, ${claim.customer_id}, ${approved.toString()}, 'OPEN', 'Warranty refund',
        ${gate.actorId}, ${claim.order_id}, ${claim.id},
        ${recommended.toString()}, ${approved.toString()}, ${overrideReason},
        ${claim.bank_name}, ${claim.account_number}, ${claim.account_holder}
      )
    `.execute(trx);

    await sql`
      update warranty_claim
      set status = 'REFUND_DUE',
          approved_refund_vnd = ${approved.toString()},
          override_reason = ${overrideReason},
          refund_obligation_id = ${obligationId},
          reviewed_by = ${gate.actorId},
          reviewed_at = now(),
          updated_at = now(),
          version = version + 1
      where id = ${claim.id}
    `.execute(trx);
    await appendClaimEvent(trx, claim.id, "REFUND_DUE", `Hoàn dự kiến ${approved.toString()} đ`);
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.refund_approved",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason: overrideReason ?? "Approved the calculated refund",
      correlationId: input.correlationId,
      metadataRedacted: {
        recommendedAmountVnd: recommended.toString(),
        approvedAmountVnd: approved.toString(),
        overridden,
        obligationId,
      },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyRefundDue",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: {
        claimId: claim.id,
        customerId: claim.customer_id,
        amountVnd: approved.toString(),
      },
    });
    return { ok: true, claimId: claim.id, status: "REFUND_DUE", obligationId };
  });
}

/**
 * Record that the admin personally transferred the money. The system never performs a transfer and
 * never claims one happened: this action exists solely to capture the admin's declaration.
 */
export async function markRefundPaid(
  input: AdminClaimActionInput & { payoutReference?: string },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (claim.status === "REFUND_PAID")
      return { ok: true, claimId: claim.id, status: "REFUND_PAID", idempotent: true };
    if (claim.status !== "REFUND_DUE" || !claim.refund_obligation_id)
      return { ok: false, code: "ILLEGAL_STATE" };

    const paid = await sql<{ id: string }>`
      update shop_refund_obligation
      set status = 'PAID',
          paid_at = now(),
          paid_by = ${gate.actorId},
          payout_reference = ${input.payoutReference?.trim().slice(0, 120) ?? null},
          updated_at = now()
      where id = ${claim.refund_obligation_id} and status = 'OPEN'
      returning id
    `.execute(trx);
    // Exactly-once: a replay finds the obligation already PAID and does not write a second record.
    if (!paid.rows[0])
      return { ok: true, claimId: claim.id, status: "REFUND_PAID", idempotent: true };

    await setStatus(trx, claim.id, "REFUND_PAID", { resolved: true });
    await appendClaimEvent(trx, claim.id, "REFUND_PAID", "Shop đã xác nhận chuyển khoản");
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.refund_marked_paid",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason: "Admin confirmed the manual transfer",
      correlationId: input.correlationId,
      metadataRedacted: {
        obligationId: claim.refund_obligation_id,
        hasReference: Boolean(input.payoutReference?.trim()),
      },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyRefundPaid",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: { claimId: claim.id, customerId: claim.customer_id },
    });
    return { ok: true, claimId: claim.id, status: "REFUND_PAID" };
  });
}

/**
 * Approve a replacement. The asset swap is the existing replacement engine's job; this wrapper
 * links its case to the claim and marks the defective asset unusable so it can never re-enter
 * sellable stock (goal §22).
 */
export async function approveClaimReplacement(
  input: AdminClaimActionInput & { deliveryBaseUrl: string; bundleTtlSeconds: number },
): Promise<AdminClaimResult> {
  const gate = guard(input);
  if (!gate.ok) return gate;
  return withTransaction(input.db, async (trx) => {
    const claim = await loadClaimForUpdate(trx, input.claimId);
    if (!claim) return { ok: false, code: "NOT_FOUND" };
    if (claim.status === "REPLACEMENT_APPROVED" && claim.replacement_case_id)
      return {
        ok: true,
        claimId: claim.id,
        status: claim.status,
        idempotent: true,
        replacementCaseId: claim.replacement_case_id,
      };
    if (!["VERIFIED_DEFECT", "REPLACEMENT_APPROVED"].includes(claim.status))
      return { ok: false, code: "ILLEGAL_STATE" };
    // The policy snapshotted at report time decides what the admin may resolve to; a product edit
    // afterwards must not change the options a past claim was judged by.
    if (!claim.replacement_allowed) return { ok: false, code: "NOT_ALLOWED_BY_POLICY" };

    const caseId = claim.replacement_case_id ?? newId();
    if (!claim.replacement_case_id) {
      await sql`
        insert into replacement_case (id, order_id, original_asset_id, reason_code, status, opened_at)
        values (${caseId}, ${claim.order_id}, ${claim.original_asset_id}, 'INVALID_CREDENTIAL', 'OPEN', now())
      `.execute(trx);
      await sql`update replacement_case set status = 'APPROVED' where id = ${caseId}`.execute(trx);
    }

    const approved = await approveReplacementCaseInTransaction(trx, {
      caseId,
      approvedBy: gate.actorId,
      correlationId: input.correlationId,
      deliveryBaseUrl: input.deliveryBaseUrl,
      bundleTtlSeconds: input.bundleTtlSeconds,
    });
    if (!approved.ok)
      return {
        ok: false,
        code: approved.code === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "ILLEGAL_STATE",
      };

    // The defective asset must never return to sellable stock. COMPROMISED is the existing status
    // the sale path already refuses to claim.
    if (claim.original_asset_id) {
      await sql`
        update digital_asset
        set status = 'COMPROMISED', updated_at = now(), version = version + 1
        where id = ${claim.original_asset_id} and status in ('DELIVERED', 'READY', 'RESERVED')
      `.execute(trx);
    }

    await sql`
      update warranty_claim
      set status = 'REPLACEMENT_APPROVED',
          replacement_case_id = ${caseId},
          reviewed_by = ${gate.actorId},
          reviewed_at = now(),
          updated_at = now(),
          version = version + 1
      where id = ${claim.id}
    `.execute(trx);
    await appendClaimEvent(trx, claim.id, "REPLACEMENT_APPROVED", "Đã duyệt đổi tài khoản");
    await appendAuditEvent(trx, {
      actorType: "ROOT_ADMIN",
      actorId: gate.actorId,
      action: "warranty.replacement_approved",
      targetType: "WarrantyClaim",
      targetId: claim.id,
      reason: "Approved a replacement for the defective asset",
      correlationId: input.correlationId,
      metadataRedacted: {
        replacementCaseId: approved.caseId,
        replacementAssetId: approved.replacementAssetId,
        originalAssetId: claim.original_asset_id,
      },
    });
    await enqueueOutboxEvent(trx, {
      id: newId(),
      eventType: "WarrantyReplacementApproved",
      aggregateType: "WarrantyClaim",
      aggregateId: claim.id,
      aggregateVersion: 1,
      payloadRedacted: {
        claimId: claim.id,
        customerId: claim.customer_id,
        bundleId: approved.bundleId,
      },
    });
    return {
      ok: true,
      claimId: claim.id,
      status: "REPLACEMENT_APPROVED",
      replacementCaseId: approved.caseId,
    };
  });
}

/** Customer-visible timeline: safe notes only, never internal states or ids. */
export async function listClaimTimeline(
  db: Db,
  claimId: string,
): Promise<Array<{ kind: string; safeNote: string | null; createdAt: string }>> {
  const rows = await sql<{ kind: string; safe_note: string | null; created_at: Date | string }>`
    select kind, safe_note, created_at from warranty_claim_event
    where claim_id = ${claimId} order by created_at asc, id asc limit 50
  `.execute(db);
  return rows.rows.map((row) => ({
    kind: row.kind,
    safeNote: row.safe_note,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
