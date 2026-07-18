import { createHmac } from "node:crypto";
import type { PaymentEvidence } from "../../src/modules/payments/domain.js";
import {
  verifySePayIngress,
  type VerifiedSePayEvidence,
} from "../../src/modules/payments/sepay-ingress.js";

const TEST_HMAC_KEY = "test-only-verified-sepay-key-material-123456";
const TEST_SOURCE_IP = "172.236.138.20";

/** Test-only fixture builder that still crosses the real signature/schema verifier. */
export function verifiedSePayEvidence(input: PaymentEvidence): VerifiedSePayEvidence {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const transactionDate = new Date(input.transactedAt.getTime() + 7 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const rawBody = JSON.stringify({
    id: Number(input.providerTransactionId.replace(/\D/g, "").slice(-12)) || 1,
    gateway: "TEST",
    transactionDate,
    accountNumber: input.merchantAccountId,
    code: input.structuredCode ?? null,
    content: input.content,
    transferType: input.direction === "IN" ? "in" : "out",
    transferAmount: input.amountVnd,
    accumulated: input.amountVnd,
    subAccount: null,
    referenceCode: input.reference,
    description: input.content,
  });
  const signature = `sha256=${createHmac("sha256", TEST_HMAC_KEY)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
  const verified = verifySePayIngress(
    {
      rawBody,
      headers: {
        "x-sepay-timestamp": timestamp,
        "x-sepay-signature": signature,
      },
      remoteAddress: TEST_SOURCE_IP,
    },
    {
      hmacSecret: TEST_HMAC_KEY,
      replayWindowSeconds: 300,
      ipAllowlist: [TEST_SOURCE_IP],
      trustedProxyIps: [],
    },
  );
  if (!verified.ok) throw new Error(`Invalid verified SePay test fixture: ${verified.code}`);
  return Object.assign(verified.evidence, {
    providerTransactionId: input.providerTransactionId,
    rawHash: input.rawHash,
    correlationId: input.correlationId,
  });
}
