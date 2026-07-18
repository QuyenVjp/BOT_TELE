export interface RecoveryTelemetry {
  claimed: number;
  succeeded: number;
  failed: number;
  backlog: number;
  oldestAgeSeconds: number | null;
}

export function validateRecoveryBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError("recovery batchSize must be an integer between 1 and 100");
  }
}

export function ageSeconds(now: Date, oldest: Date | string | null | undefined): number | null {
  if (oldest === null || oldest === undefined) return null;
  const timestamp = oldest instanceof Date ? oldest.getTime() : new Date(oldest).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}
