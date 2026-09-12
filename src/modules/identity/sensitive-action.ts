import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { appendAuditEvent } from "./audit.js";
import { authorizeRootAction, type RootActor, type RootAdminConfig } from "./root-admin.js";
import { createStepUpService, type StepUpActionCategory } from "./step-up.js";
import type { AuthorizationJsonValue } from "./authorization-payload.js";
import { loadSensitiveAuthorizationBinding } from "./authorization-binding.js";
import type { IdentityTelemetry } from "./telemetry.js";

/**
 * The single authorisation point for sensitive admin mutations (THREAT_MODEL SEC-002).
 *
 * Every owner verb that changes money, permissions, supplier routing or the
 * broadcast audience passes through `authorizeSensitiveAdminAction` BEFORE it
 * mutates anything. The layer composes the two existing gates — the numeric-id
 * root identity (`root-admin.ts`) and the RFC 6238 step-up factor
 * (`step-up.ts`) — and appends audit evidence for the success and for every
 * refusal.
 *
 * Why a table instead of a flag per call site: the policy is one declarative
 * map from an action key to the step-up category it requires, so "which verbs
 * need a second factor" is reviewable in one place and a new verb cannot be
 * gated by accident or left ungated by omission.
 *
 * Fail-closed rules:
 *  - identity is checked first and refuses `NOT_ROOT_ADMIN` for a wrong id AND
 *    for a wrong chat context (the layer never leaks which one failed);
 *  - a required category with step-up running but no live, unconsumed,
 *    unexpired, same-admin, same-category grant is refused;
 *  - a missing vault while step-up is enabled is refused rather than skipped:
 *    nothing can be verified, so nothing may proceed;
 *  - a refusal never touches the business mutation; the caller must return the
 *    refusal instead of executing.
 */

export type SensitiveActionKey =
  | "wallet.refund"
  | "manual_fulfillment.complete"
  | "support.replacement.approve"
  | "discrepancy.resolve"
  | "store.open"
  | "store.close"
  | "catalog.activate"
  | "catalog.deactivate"
  | "catalog.variant.price.change"
  | "catalog.variant.deposit.change"
  | "catalog.variant.commercial.change"
  | "inventory.stock.adjust"
  | "preorder.cancel"
  | "supplier.mapping.select"
  | "supplier.mapping.clear"
  | "supplier.mapping.verify"
  | "broadcast.confirm"
  | "warranty.refund.approve"
  | "warranty.refund.adjust"
  | "warranty.replacement.approve";

/** Which step-up category (if any) an action requires. `null` = no step-up. */
export const SENSITIVE_ACTION_POLICY: Record<SensitiveActionKey, StepUpActionCategory | null> = {
  "wallet.refund": "REFUND",
  "manual_fulfillment.complete": "REFUND",
  "support.replacement.approve": "REFUND",
  "warranty.refund.approve": "REFUND",
  "warranty.refund.adjust": "REFUND",
  "warranty.replacement.approve": "DELIVERY_REISSUE",
  "discrepancy.resolve": "PAYMENT_OVERRIDE",
  "store.open": "PERMISSION_CHANGE",
  "store.close": "PERMISSION_CHANGE",
  "catalog.activate": "PERMISSION_CHANGE",
  "catalog.deactivate": "PERMISSION_CHANGE",
  // A price or a deposit is the number the shop charges, so it takes a second
  // factor. The fields are separated because they fail differently: a wrong price
  // overcharges, a wrong deposit mis-collects a preorder.
  "catalog.variant.price.change": "BULK_PRICE_CHANGE",
  "catalog.variant.deposit.change": "BULK_PRICE_CHANGE",
  "catalog.variant.commercial.change": "BULK_PRICE_CHANGE",
  // Stock is inventory value: a wrong adjustment either sells what does not exist
  // or hides what does.
  "inventory.stock.adjust": "STOCK_ADJUSTMENT",
  // Cancelling a reservation releases the held asset and creates a refund obligation for
  // money the customer already paid, so it is a financial action.
  "preorder.cancel": "REFUND",
  "supplier.mapping.select": "SUPPLIER_CONFIG",
  "supplier.mapping.clear": "SUPPLIER_CONFIG",
  "supplier.mapping.verify": "SUPPLIER_CONFIG",
  "broadcast.confirm": "BROADCAST",
};

/** Runtime membership test for the policy table (callers hold a plain command string). */
export function isSensitiveActionKey(value: string): value is SensitiveActionKey {
  return Object.hasOwn(SENSITIVE_ACTION_POLICY, value);
}

/**
 * The categories this policy can actually require, derived from the table above so
 * the two can never drift. Used to check a category that arrives from outside
 * (the audit trail) before it is handed to the step-up service.
 */
const GATED_CATEGORIES = new Set<StepUpActionCategory>(
  Object.values(SENSITIVE_ACTION_POLICY).filter((c): c is StepUpActionCategory => c !== null),
);

export function isStepUpActionCategory(value: string): value is StepUpActionCategory {
  return GATED_CATEGORIES.has(value as StepUpActionCategory);
}

export type SensitiveAuthorizationRefusal =
  | "NOT_ROOT_ADMIN"
  | "STEP_UP_REQUIRED"
  | "STEP_UP_GRANT_MISSING"
  | "STEP_UP_NOT_ENROLLED"
  | "STEP_UP_LOCKED_OUT";

export type SensitiveAuthorization =
  { ok: true; stepUpConsumed: boolean } | { ok: false; code: SensitiveAuthorizationRefusal };

/**
 * Thrown by a module that must refuse before it writes, when its own signature has no
 * room to return the refusal. Throwing is the fail-closed choice: the caller cannot
 * accidentally proceed past a refused authorization, and the code carries which refusal
 * it was so the surface can render the challenge instead of a generic error.
 */
export class SensitiveAuthorizationRefusedError extends Error {
  readonly code: SensitiveAuthorizationRefusal;

  constructor(code: SensitiveAuthorizationRefusal) {
    super(`sensitive action refused: ${code}`);
    this.name = "SensitiveAuthorizationRefusedError";
    this.code = code;
  }
}

export interface SensitiveActionDeps {
  db: Db;
  rootConfig: RootAdminConfig;
  /**
   * Undefined is only legitimate while step-up is off (development/test). With
   * step-up enabled and no vault the layer refuses: nothing could be verified.
   */
  vault: Vault | undefined;
  /** Development/test posture when false: identity and audit still run, no step-up. */
  stepUpEnabled: boolean;
  stepUpOptions: { ttlSeconds: number; lockoutMinutes: number; maxAttempts: number };
  telemetry?: IdentityTelemetry;
}

export interface SensitiveActionInput {
  actor: RootActor;
  actionKey: SensitiveActionKey;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  /** Server-derived requested values (never raw client callback data). */
  requestedData?: AuthorizationJsonValue;
  /** false for the issue/preview step, true for the step that actually mutates. */
  consumeGrant: boolean;
}

/**
 * Live = unconsumed and unexpired for this admin and this category: exactly the
 * predicate `stepUp.consume` claims on, asked without spending the grant so the
 * preview step can tell "verified, waiting for confirmation" from "verify
 * first".
 */
async function hasLiveStepUpGrant(
  db: Db,
  adminTelegramUserId: string,
  category: StepUpActionCategory,
  input: SensitiveActionInput,
  binding: { resourceVersion: string; payloadHash: string },
): Promise<boolean> {
  // Mirrors `consume` exactly: legacy/unbound grants never satisfy preview.
  const row = await sql`
    select 1 as live from admin_step_up_grant
    where admin_telegram_user_id = ${adminTelegramUserId}
      and category = ${category}
      and authorization_version = 2
      and action_key = ${input.actionKey}
      and resource_type = ${input.resourceType}
      and resource_id = ${input.resourceId}
      and resource_version = ${binding.resourceVersion}
      and payload_hash = ${binding.payloadHash}
      and consumed_at is null
      and revoked_at is null
      and expires_at > now()
    limit 1
  `.execute(db);
  return row.rows.length > 0;
}

/** The durable lockout `stepUp.verify` enforces: N failures inside the window. */
async function isStepUpLockedOut(
  db: Db,
  adminTelegramUserId: string,
  lockoutMinutes: number,
  maxAttempts: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - lockoutMinutes * 60_000).toISOString();
  const row = await sql<{ failed_attempts: number }>`
    select count(*)::int as failed_attempts from admin_step_up_attempt
    where admin_telegram_user_id = ${adminTelegramUserId}
      and succeeded = false
      and attempted_at >= ${windowStart}
  `.execute(db);
  return (row.rows[0]?.failed_attempts ?? 0) >= maxAttempts;
}

/**
 * Append the authorization evidence. Only the action key, the required category
 * and (on refusal) the refusal code are recorded — never a TOTP code, an OTP or
 * a seed.
 */
async function appendSensitiveAudit(
  db: Db,
  input: SensitiveActionInput,
  actorId: string,
  category: StepUpActionCategory | null,
  code: SensitiveAuthorizationRefusal | null,
  binding: { resourceVersion: string; payloadHash: string } | null,
): Promise<void> {
  await appendAuditEvent(db, {
    actorType: "ROOT_ADMIN",
    actorId,
    action: code === null ? "admin.sensitive.authorized" : "admin.sensitive.denied",
    targetType: input.resourceType,
    targetId: input.resourceId,
    reason: code === null ? "sensitive admin action authorized" : `denied: ${code}`,
    correlationId: input.correlationId,
    metadataRedacted: {
      actionKey: input.actionKey,
      ...(category === null ? {} : { category }),
      ...(code === null ? {} : { code }),
      // The object the owner was refused on. The operator CLI reads this back so the grant it
      // mints is bound to exactly that object; the fields are opaque ids, never secrets.
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(binding === null
        ? {}
        : {
            authorizationVersion: 2,
            resourceVersion: binding.resourceVersion,
            payloadHash: binding.payloadHash,
          }),
    },
  });
}

/**
 * The single place a sensitive admin action is authorised.
 *
 * Order is mandatory and fail-closed:
 *  1. numeric root identity through the existing authoritative mechanism;
 *  2. resolve the required step-up category for this action key;
 *  3. when a category is required and step-up is enabled, CONSUME a live grant
 *     bound to this admin, action, resource, current resource version, and
 *     canonical requested-data hash (atomic, single-use) for the mutating step,
 *     or prove one exists for the preview step;
 *  4. append an audit event for success and for every refusal.
 *
 * MUST be called BEFORE the business mutation. Never after.
 */
export async function authorizeSensitiveAdminAction(
  deps: SensitiveActionDeps,
  input: SensitiveActionInput,
): Promise<SensitiveAuthorization> {
  const actorId = String(input.actor.numericUserId);

  let binding: { resourceVersion: string; payloadHash: string } | null = null;
  const refuse = async (
    code: SensitiveAuthorizationRefusal,
    category: StepUpActionCategory | null,
  ): Promise<SensitiveAuthorization> => {
    await appendSensitiveAudit(deps.db, input, actorId, category, code, binding);
    deps.telemetry?.recordFailedConfirmation({
      code,
      actionFingerprint: `${input.actionKey}:${input.resourceId}`,
    });
    return { ok: false, code };
  };

  // 1. Identity. A wrong context is reported as NOT_ROOT_ADMIN on purpose: the
  // refusal must not say whether the id was right.
  if (!authorizeRootAction(input.actor, deps.rootConfig).ok) {
    return refuse("NOT_ROOT_ADMIN", null);
  }

  // 2. Policy. No category (or step-up switched off) means identity + audit only.
  const category = SENSITIVE_ACTION_POLICY[input.actionKey];
  if (category === null || !deps.stepUpEnabled) {
    await appendSensitiveAudit(deps.db, input, actorId, category, null, null);
    return { ok: true, stepUpConsumed: false };
  }

  binding = await loadSensitiveAuthorizationBinding(deps.db, {
    ...input,
    requestedData: input.requestedData ?? { targetId: input.resourceId },
  });
  if (deps.vault === undefined) return refuse("STEP_UP_NOT_ENROLLED", category);
  const stepUp = createStepUpService(deps.db, deps.vault, deps.stepUpOptions);

  if (!input.consumeGrant) {
    // 3a. Preview: prove a usable grant EXISTS without spending it, so the
    // mutating step can still claim it exactly once.
    if (!(await stepUp.isEnrolled(actorId))) return refuse("STEP_UP_NOT_ENROLLED", category);
    if (
      await isStepUpLockedOut(
        deps.db,
        actorId,
        deps.stepUpOptions.lockoutMinutes,
        deps.stepUpOptions.maxAttempts,
      )
    ) {
      return refuse("STEP_UP_LOCKED_OUT", category);
    }
    if (!(await hasLiveStepUpGrant(deps.db, actorId, category, input, binding))) {
      return refuse("STEP_UP_REQUIRED", category);
    }
    await appendSensitiveAudit(deps.db, input, actorId, category, null, binding);
    return { ok: true, stepUpConsumed: false };
  }

  // 3b. Mutation: spend the grant. `consume` claims the row with `for update`,
  // so two concurrent mutating steps cannot both win the same grant.
  const consumed = await stepUp.consume({
    adminTelegramUserId: actorId,
    category,
    actionKey: input.actionKey,
    // The binding: this grant may only be spent on THIS object.
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceVersion: binding.resourceVersion,
    payloadHash: binding.payloadHash,
  });
  if (!consumed.ok) {
    return refuse(
      consumed.code === "NOT_ENROLLED" ? "STEP_UP_NOT_ENROLLED" : "STEP_UP_GRANT_MISSING",
      category,
    );
  }

  // 4. Success evidence: the grant is already spent at this point, which is the
  // fail-closed direction — a crash right here costs the admin a re-verification
  // and can never let an unverified mutation through.
  await appendSensitiveAudit(deps.db, input, actorId, category, null, binding);
  return { ok: true, stepUpConsumed: true };
}
