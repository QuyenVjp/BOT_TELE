import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SePayRouteRequest, SePayRouteResult } from "../../app.js";
import type { PaymentEvidence } from "./domain.js";
import type { SePayInbox, SePayInboxEnvelope } from "../../infrastructure/inbox/sepay.js";
import {
  isTimestampFresh,
  parseSePayPayload,
  SEPAY_SIGNATURE_HEADER,
  SEPAY_TIMESTAMP_HEADER,
  verifySePaySignature,
} from "./sepay-webhook.js";

const verifiedSePayEvidenceBrand = Symbol("verified-sepay-evidence");

export type VerifiedSePayEvidence = PaymentEvidence & {
  readonly [verifiedSePayEvidenceBrand]: true;
};

/** Runtime guard for the trust boundary (TypeScript brands alone erase). */
export function isVerifiedSePayEvidence(value: unknown): value is VerifiedSePayEvidence {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[verifiedSePayEvidenceBrand] === true
  );
}

/**
 * Internal trust-boundary helper for authenticated SePay read adapters.
 * Callers must complete transport and response-schema verification first; raw
 * application/user input must continue through `verifySePayIngress` instead.
 */
export function brandVerifiedSePayApiEvidence(evidence: PaymentEvidence): VerifiedSePayEvidence {
  Object.defineProperty(evidence, verifiedSePayEvidenceBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return evidence as VerifiedSePayEvidence;
}

/** Restore the runtime trust brand after loading an immutable inbox envelope. */
export function brandVerifiedSePayIngressEvidence(
  evidence: PaymentEvidence,
): VerifiedSePayEvidence {
  Object.defineProperty(evidence, verifiedSePayEvidenceBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return evidence as VerifiedSePayEvidence;
}

export interface SePayIngressConfig {
  hmacSecret: string;
  replayWindowSeconds: number;
  ipAllowlist: readonly string[];
  trustedProxyIps: readonly string[];
  nowSeconds?: () => number;
}

export type SePayIngressVerification =
  | { ok: true; evidence: VerifiedSePayEvidence }
  | {
      ok: false;
      code: "IP_NOT_ALLOWED" | "INVALID_TIMESTAMP" | "INVALID_SIGNATURE" | "INVALID_SCHEMA";
    };

export function verifySePayIngress(
  request: SePayRouteRequest,
  config: SePayIngressConfig,
): SePayIngressVerification {
  validateConfig(config);
  const sourceIp = resolveSourceIp(request, config.trustedProxyIps);
  if (!sourceIp || !config.ipAllowlist.map(normalizeIp).includes(sourceIp)) {
    return { ok: false, code: "IP_NOT_ALLOWED" };
  }

  const timestamp = request.headers[SEPAY_TIMESTAMP_HEADER] ?? "";
  const signature = request.headers[SEPAY_SIGNATURE_HEADER] ?? "";
  const nowSeconds = config.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  if (!isTimestampFresh(timestamp, config.replayWindowSeconds, nowSeconds)) {
    return { ok: false, code: "INVALID_TIMESTAMP" };
  }
  if (
    !verifySePaySignature({
      timestamp,
      rawBody: request.rawBody,
      signature,
      secret: config.hmacSecret,
    })
  ) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }

  try {
    const payload = parseSePayPayload(request.rawBody);
    const transactedAt = parseProviderDate(payload.transactionDate);
    const evidence = {
      provider: "sepay",
      providerTransactionId: String(payload.id),
      direction: payload.transferType === "in" ? "IN" : "OUT",
      merchantAccountId: payload.accountNumber,
      amountVnd: payload.transferAmount,
      // Keep structured code separate from free-form content. The matcher may
      // use content/reference only as a bounded fallback when code is absent.
      structuredCode: payload.code ?? null,
      content: payload.content ?? null,
      reference: payload.referenceCode ?? null,
      transactedAt,
      rawHash: createHash("sha256").update(request.rawBody, "utf8").digest("hex"),
      correlationId: `sepay:${payload.id}`,
    } as PaymentEvidence;
    return { ok: true, evidence: brandVerifiedSePayIngressEvidence(evidence) };
  } catch {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
}

export function createSePayIngressHandler(
  config: SePayIngressConfig & { inbox: SePayInbox },
): (request: SePayRouteRequest) => Promise<SePayRouteResult> {
  // Fail startup/composition for unsafe trust material instead of discovering
  // it on the first provider request.
  validateConfig(config);
  return async (request) => {
    const verified = verifySePayIngress(request, config);
    if (!verified.ok) {
      const status =
        verified.code === "IP_NOT_ALLOWED" ? 403 : verified.code === "INVALID_SCHEMA" ? 400 : 401;
      return { status, body: { success: false } };
    }
    const timestamp = request.headers[SEPAY_TIMESTAMP_HEADER] ?? "";
    const signature = request.headers[SEPAY_SIGNATURE_HEADER] ?? "";
    const sourceIp = resolveSourceIp(request, config.trustedProxyIps) ?? "unknown";
    const payload = parseSePayPayload(request.rawBody);
    const envelope: SePayInboxEnvelope = {
      evidence: {
        provider: "sepay",
        providerTransactionId: verified.evidence.providerTransactionId,
        direction: verified.evidence.direction,
        merchantAccountId: verified.evidence.merchantAccountId,
        amountVnd: verified.evidence.amountVnd,
        structuredCode: verified.evidence.structuredCode ?? null,
        content: verified.evidence.content,
        reference: verified.evidence.reference,
        transactedAt: verified.evidence.transactedAt.toISOString(),
        rawHash: verified.evidence.rawHash,
        correlationId: verified.evidence.correlationId,
      },
      payload: {
        id: payload.id,
        gateway: payload.gateway,
        transactionDate: payload.transactionDate,
        accountNumber: payload.accountNumber,
        subAccount: payload.subAccount ?? null,
        code: payload.code ?? null,
        content: payload.content ?? null,
        transferType: payload.transferType,
        description: payload.description ?? null,
        transferAmount: payload.transferAmount,
        accumulated: payload.accumulated ?? null,
        referenceCode: payload.referenceCode ?? null,
      },
      auth: {
        timestamp,
        signatureHash: signature.slice(7),
        sourceIp,
      },
    };
    try {
      await config.inbox.accept({
        sourceEventId: verified.evidence.providerTransactionId,
        rawHash: verified.evidence.rawHash,
        envelope,
      });
      // Deliberately do not call settlement here. The durable inbox commit is
      // the acknowledgement boundary; the worker owns business processing.
      return { status: 200, body: { success: true } };
    } catch {
      return { status: 500, body: { success: false } };
    }
  };
}

function validateConfig(config: SePayIngressConfig): void {
  if (Buffer.byteLength(config.hmacSecret, "utf8") < 32) {
    throw new Error("SEPAY_WEBHOOK_HMAC_SECRET must contain at least 32 bytes");
  }
  if (
    !Number.isInteger(config.replayWindowSeconds) ||
    config.replayWindowSeconds < 1 ||
    config.replayWindowSeconds > 900
  ) {
    throw new Error("SEPAY_REPLAY_WINDOW_SECONDS must be between 1 and 900");
  }
  if (config.ipAllowlist.length === 0 || config.ipAllowlist.some((ip) => !normalizeIp(ip))) {
    throw new Error("SEPAY_IP_ALLOWLIST must contain valid IP addresses");
  }
  if (config.trustedProxyIps.some((ip) => !normalizeIp(ip))) {
    throw new Error("SEPAY_TRUSTED_PROXY_IPS must contain valid IP addresses");
  }
}

function resolveSourceIp(
  request: SePayRouteRequest,
  trustedProxyIps: readonly string[],
): string | null {
  const peer = normalizeIp(request.remoteAddress);
  if (!peer) return null;
  const trusted = trustedProxyIps.map(normalizeIp).includes(peer);
  if (!trusted) return peer;
  const forwarded = request.headers["x-forwarded-for"]?.split(",", 1)[0]?.trim() ?? "";
  return normalizeIp(forwarded);
}

function normalizeIp(value: string): string | null {
  const unwrapped = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(unwrapped) ? unwrapped.toLowerCase() : null;
}

function parseProviderDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Invalid SePay transactionDate");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day, hour - 7, minute, second));
  const localRoundTrip = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
  if (
    !Number.isFinite(parsed.getTime()) ||
    localRoundTrip.getUTCFullYear() !== year ||
    localRoundTrip.getUTCMonth() + 1 !== month ||
    localRoundTrip.getUTCDate() !== day ||
    localRoundTrip.getUTCHours() !== hour ||
    localRoundTrip.getUTCMinutes() !== minute ||
    localRoundTrip.getUTCSeconds() !== second
  ) {
    throw new Error("Invalid SePay transactionDate");
  }
  return parsed;
}
