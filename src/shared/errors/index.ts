/**
 * Stable, serializable error envelope (data-model.md Conventions).
 *
 * - `AppError` carries a machine-readable `code`, a safe human `message`, and
 *   optional structured `details` (must itself be free of secrets/internals).
 * - `errorEnvelope` produces a JSON-safe view with no stack trace and never
 *   promotes an unknown error's raw message into the code or the message.
 */

/** Closed set of stable error codes surfaced across boundaries. */
export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "PAYMENT"
  | "SUPPLIER"
  | "INTERNAL";

export interface ErrorEnvelope {
  code: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Convert any thrown value into a stable, serializable envelope.
 * Unknown errors collapse to a generic INTERNAL code with a fixed message so no
 * internal detail (stack, arbitrary message) crosses a trust boundary.
 */
export function errorEnvelope(value: unknown): ErrorEnvelope {
  if (isAppError(value)) {
    const envelope: ErrorEnvelope = { code: value.code, message: value.message };
    if (value.details !== undefined) envelope.details = value.details;
    return envelope;
  }
  return { code: "INTERNAL", message: "An internal error occurred" };
}
