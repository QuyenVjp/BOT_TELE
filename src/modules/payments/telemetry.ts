/**
 * Payment telemetry + alerts (T057, FR-012, SR-001).
 *
 * In-process counters for signature failures, reference collisions,
 * paid-without-Order, mismatch backlog depth, and reconciliation lag. Alerts
 * fire when a threshold is crossed. Payloads are deliberately allowlisted —
 * secrets (HMAC keys, signatures, raw bodies) are never retained.
 *
 * Production can swap a metrics/exporter sink behind the same port; this
 * driver is the contract the domain and tests share.
 */

export type PaymentAlertCode =
  | "SIGNATURE_FAILURE_THRESHOLD"
  | "REFERENCE_COLLISION"
  | "PAID_WITHOUT_ORDER"
  | "MISMATCH_BACKLOG"
  | "RECONCILIATION_LAG";

export interface PaymentAlert {
  code: PaymentAlertCode;
  message: string;
  /** Allowlisted diagnostic fields only. */
  context: Record<string, string | number | boolean | null>;
  at: string;
}

export interface PaymentTelemetrySnapshot {
  signatureFailures: number;
  referenceCollisions: number;
  paidWithoutOrder: number;
  mismatchBacklog: number;
  lastReconLagSeconds: number | null;
  alerts: PaymentAlert[];
}

export interface PaymentTelemetryOptions {
  /** Raise SIGNATURE_FAILURE_THRESHOLD when cumulative failures reach this. */
  signatureFailureAlertAt?: number;
  /** Raise MISMATCH_BACKLOG when open discrepancies exceed this. */
  mismatchBacklogAlertAt?: number;
  /** Raise RECONCILIATION_LAG when lagSeconds exceeds this. */
  reconLagAlertSeconds?: number;
  /** Injectable clock (ISO). */
  now?: () => Date;
}

export interface PaymentTelemetry {
  recordSignatureFailure(input: { reason: string }): void;
  recordReferenceCollision(input: { content: string; intentIds: number }): void;
  recordPaidWithoutOrder(input: { bankTransactionId: string; amountVnd: number }): void;
  setMismatchBacklog(count: number): void;
  recordReconciliationLag(input: {
    lagSeconds: number;
    recovered: number;
    discrepancies: number;
  }): void;
  snapshot(): PaymentTelemetrySnapshot;
  /** Clear counters/alerts (tests / rotation). */
  reset(): void;
}

const DEFAULTS = {
  signatureFailureAlertAt: 10,
  mismatchBacklogAlertAt: 25,
  reconLagAlertSeconds: 900,
} as const;

export function createPaymentTelemetry(options: PaymentTelemetryOptions = {}): PaymentTelemetry {
  const signatureFailureAlertAt =
    options.signatureFailureAlertAt ?? DEFAULTS.signatureFailureAlertAt;
  const mismatchBacklogAlertAt = options.mismatchBacklogAlertAt ?? DEFAULTS.mismatchBacklogAlertAt;
  const reconLagAlertSeconds = options.reconLagAlertSeconds ?? DEFAULTS.reconLagAlertSeconds;
  const clock = options.now ?? (() => new Date());

  let signatureFailures = 0;
  let referenceCollisions = 0;
  let paidWithoutOrder = 0;
  let mismatchBacklog = 0;
  let lastReconLagSeconds: number | null = null;
  const alerts: PaymentAlert[] = [];

  function push(code: PaymentAlertCode, message: string, context: PaymentAlert["context"]): void {
    // De-dupe: one open alert per code (most recent wins).
    const idx = alerts.findIndex((a) => a.code === code);
    const alert: PaymentAlert = {
      code,
      message,
      context,
      at: clock().toISOString(),
    };
    if (idx >= 0) alerts[idx] = alert;
    else alerts.push(alert);
  }

  return {
    recordSignatureFailure(input) {
      signatureFailures += 1;
      if (signatureFailures >= signatureFailureAlertAt) {
        push("SIGNATURE_FAILURE_THRESHOLD", "SePay signature failures exceeded threshold", {
          count: signatureFailures,
          reason: input.reason,
        });
      }
    },

    recordReferenceCollision(input) {
      referenceCollisions += 1;
      // Content is transfer content (non-secret); still truncate for safety.
      const content = input.content.slice(0, 32);
      push("REFERENCE_COLLISION", "Transfer content resolved to multiple intents", {
        content,
        intentIds: input.intentIds,
      });
    },

    recordPaidWithoutOrder(input) {
      paidWithoutOrder += 1;
      push("PAID_WITHOUT_ORDER", "Settled bank transaction has no matching Order", {
        bankTransactionId: input.bankTransactionId,
        amountVnd: input.amountVnd,
      });
    },

    setMismatchBacklog(count) {
      mismatchBacklog = count;
      if (count >= mismatchBacklogAlertAt) {
        push("MISMATCH_BACKLOG", "Open payment discrepancies exceed backlog threshold", {
          count,
        });
      }
    },

    recordReconciliationLag(input) {
      lastReconLagSeconds = input.lagSeconds;
      if (input.lagSeconds >= reconLagAlertSeconds) {
        push("RECONCILIATION_LAG", "SePay reconciliation lag exceeds SLA window", {
          lagSeconds: input.lagSeconds,
          recovered: input.recovered,
          discrepancies: input.discrepancies,
        });
      }
    },

    snapshot() {
      return {
        signatureFailures,
        referenceCollisions,
        paidWithoutOrder,
        mismatchBacklog,
        lastReconLagSeconds,
        // Defensive copy so callers cannot mutate internal state.
        alerts: alerts.map((a) => ({ ...a, context: { ...a.context } })),
      };
    },

    reset() {
      signatureFailures = 0;
      referenceCollisions = 0;
      paidWithoutOrder = 0;
      mismatchBacklog = 0;
      lastReconLagSeconds = null;
      alerts.length = 0;
    },
  };
}
