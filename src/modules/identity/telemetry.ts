/**
 * Identity / owner-ops telemetry and alerts (T099, FR-021, FR-023, SC-009).
 *
 * In-process counters for impersonation attempts, failed confirmations, high-risk
 * actions, and username drift. Payloads are allowlisted: only numeric ids,
 * action names, and correlation ids — never secrets or free-form challenge
 * values.
 */

export type IdentityAlertCode =
  "IMPERSONATION" | "FAILED_CONFIRMATION" | "HIGH_RISK_ACTION" | "USERNAME_DRIFT";

export interface IdentityAlert {
  code: IdentityAlertCode;
  message: string;
  context: Record<string, string | number | boolean | null>;
  at: string;
}

export interface IdentityTelemetrySnapshot {
  impersonationAttempts: number;
  failedConfirmations: number;
  highRiskActions: number;
  usernameDriftEvents: number;
  alerts: IdentityAlert[];
}

export interface IdentityTelemetryOptions {
  now?: () => Date;
}

export interface IdentityTelemetry {
  recordImpersonation(input: { presentedUserId: number; observedUsername?: string | null }): void;
  recordFailedConfirmation(input: { code: string; actionFingerprint?: string }): void;
  recordHighRiskAction(input: { action: string; targetId: string }): void;
  recordUsernameDrift(input: { numericUserId: number; observedUsername?: string | null }): void;
  snapshot(): IdentityTelemetrySnapshot;
  reset(): void;
}

export function createIdentityTelemetry(options: IdentityTelemetryOptions = {}): IdentityTelemetry {
  const clock = options.now ?? (() => new Date());
  let impersonationAttempts = 0;
  let failedConfirmations = 0;
  let highRiskActions = 0;
  let usernameDriftEvents = 0;
  const alerts: IdentityAlert[] = [];

  function push(code: IdentityAlertCode, message: string, context: IdentityAlert["context"]): void {
    // Keep the latest alert per code so the snapshot stays bounded.
    const idx = alerts.findIndex((a) => a.code === code);
    const alert: IdentityAlert = {
      code,
      message,
      context,
      at: clock().toISOString(),
    };
    if (idx >= 0) alerts[idx] = alert;
    else alerts.push(alert);
  }

  return {
    recordImpersonation(input) {
      impersonationAttempts += 1;
      push("IMPERSONATION", "Non-root identity attempted a root action", {
        presentedUserId: input.presentedUserId,
        observedUsername: input.observedUsername ?? null,
        count: impersonationAttempts,
      });
    },

    recordFailedConfirmation(input) {
      failedConfirmations += 1;
      push("FAILED_CONFIRMATION", "Owner confirmation failed", {
        code: input.code,
        actionFingerprint: input.actionFingerprint ?? null,
        count: failedConfirmations,
      });
    },

    recordHighRiskAction(input) {
      highRiskActions += 1;
      push("HIGH_RISK_ACTION", "High-risk owner action executed", {
        action: input.action,
        targetId: input.targetId,
        count: highRiskActions,
      });
    },

    recordUsernameDrift(input) {
      usernameDriftEvents += 1;
      push("USERNAME_DRIFT", "Root identity presented an unexpected username", {
        numericUserId: input.numericUserId,
        observedUsername: input.observedUsername ?? null,
        count: usernameDriftEvents,
      });
    },

    snapshot() {
      return {
        impersonationAttempts,
        failedConfirmations,
        highRiskActions,
        usernameDriftEvents,
        alerts: alerts.map((a) => ({ ...a, context: { ...a.context } })),
      };
    },

    reset() {
      impersonationAttempts = 0;
      failedConfirmations = 0;
      highRiskActions = 0;
      usernameDriftEvents = 0;
      alerts.length = 0;
    },
  };
}
