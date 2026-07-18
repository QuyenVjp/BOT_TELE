import type { Executor } from "../../infrastructure/db/transaction.js";
import { appendAuditEvent } from "../../modules/identity/audit.js";
import type { IdentityTelemetry } from "../../modules/identity/telemetry.js";
import {
  authorizeRootAction,
  type RootActor,
  type RootAdminConfig,
} from "../../modules/identity/root-admin.js";

/**
 * Private-context root-admin authorization middleware (T095, FR-021, SR-005).
 *
 * Wraps a root action: it authorizes the actor (configured numeric id + private
 * context), emits an immutable deny-audit + telemetry on refusal, and records
 * username drift as an alert without blocking a valid owner. On success it hands
 * the caller a typed `grant` so the action can proceed.
 */

export type RootDenyReason = "NOT_ROOT_ADMIN" | "WRONG_CONTEXT";

export interface RootGate {
  actor: RootActor;
  config: RootAdminConfig;
  correlationId: string;
  /** Human-readable action label for the deny-audit trail. */
  action: string;
  targetType?: string;
  targetId?: string;
}

export type RootGateResult =
  { ok: true; usernameDrift: boolean } | { ok: false; reason: RootDenyReason };

/**
 * Authorize + audit a root action attempt. On denial an audit event is appended
 * (actor is untrusted, so actorId is the presented numeric id as a string) and
 * telemetry is incremented; on success drift is surfaced for alerting.
 */
export async function guardRootAction(
  exec: Executor,
  gate: RootGate,
  telemetry?: IdentityTelemetry,
): Promise<RootGateResult> {
  const auth = authorizeRootAction(gate.actor, gate.config);

  if (!auth.ok) {
    // Record the denied attempt as attributable evidence (SR-005). A non-root
    // actor presenting the owner username is the impersonation case.
    if (auth.reason === "NOT_ROOT_ADMIN") {
      telemetry?.recordImpersonation({
        presentedUserId: gate.actor.numericUserId,
        ...(gate.actor.observedUsername !== undefined
          ? { observedUsername: gate.actor.observedUsername }
          : {}),
      });
    }
    await appendAuditEvent(exec, {
      actorType: "ROOT_ADMIN",
      actorId: String(gate.actor.numericUserId),
      action: `${gate.action}.denied`,
      targetType: gate.targetType ?? "RootAdmin",
      targetId: gate.targetId ?? "authorization",
      reason: `denied: ${auth.reason}`,
      correlationId: gate.correlationId,
      metadataRedacted: {
        reason: auth.reason,
        chatType: gate.actor.chatType,
        presentedUserId: gate.actor.numericUserId,
      },
    });
    return { ok: false, reason: auth.reason };
  }

  if (auth.usernameDrift) {
    telemetry?.recordUsernameDrift({
      numericUserId: gate.actor.numericUserId,
      ...(gate.actor.observedUsername !== undefined
        ? { observedUsername: gate.actor.observedUsername }
        : {}),
    });
  }

  return { ok: true, usernameDrift: auth.usernameDrift };
}
