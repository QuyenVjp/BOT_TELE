import { describe, expect, it, vi } from "vitest";
import { processSePayInboxBatch, type SePayInbox } from "../../src/infrastructure/inbox/sepay.js";
import { isVerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";

describe("SePay durable inbox worker boundary", () => {
  it("applies evidence only after the HTTP-facing accept boundary and restores its trust brand", async () => {
    const claim = {
      id: "inbox-1",
      sourceEventId: "123",
      rawHash: "a".repeat(64),
      owner: "worker-1",
      generation: 1,
      attemptCount: 1,
      envelope: {
        evidence: {
          provider: "sepay" as const,
          providerTransactionId: "123",
          direction: "IN" as const,
          merchantAccountId: "0123456789",
          amountVnd: 150000,
          structuredCode: "ORD-1",
          content: "free form",
          reference: "FT-1",
          transactedAt: "2026-07-17T05:00:00.000Z",
          rawHash: "a".repeat(64),
          correlationId: "sepay:123",
        },
        payload: {
          id: 123,
          gateway: "MBBank",
          transactionDate: "2026-07-17 12:00:00",
          accountNumber: "0123456789",
          subAccount: null,
          code: "ORD-1",
          content: "free form",
          transferType: "in" as const,
          description: null,
          transferAmount: 150000,
          accumulated: 150000,
          referenceCode: "FT-1",
        },
        auth: {
          timestamp: "1752642000",
          signatureHash: "b".repeat(64),
          sourceIp: "172.236.138.20",
        },
      },
    };
    let released = false;
    const inbox: SePayInbox = {
      accept: vi.fn(),
      claimDue: vi.fn().mockResolvedValue([claim]),
      markProcessed: vi.fn().mockImplementation(async () => {
        released = true;
        return true;
      }),
      markFailed: vi.fn(),
    };
    const handler = vi.fn().mockImplementation(async (evidence) => {
      expect(released).toBe(false);
      expect(isVerifiedSePayEvidence(evidence)).toBe(true);
      expect(evidence.structuredCode).toBe("ORD-1");
      return { ok: true };
    });

    const result = await processSePayInboxBatch({
      inbox,
      handler,
      owner: "worker-1",
      batchSize: 1,
    });
    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0, stale: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inbox.markProcessed).toHaveBeenCalledTimes(1);
  });
});
