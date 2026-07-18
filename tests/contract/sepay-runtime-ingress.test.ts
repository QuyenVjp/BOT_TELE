import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createSePayIngressHandler,
  verifySePayIngress,
} from "../../src/modules/payments/sepay-ingress.js";
import type { SePayInbox } from "../../src/infrastructure/inbox/sepay.js";

const HMAC_FIXTURE_VALUE = "test-only-sepay-hmac-key-material-123456789";
const NOW_SECONDS = 1_752_643_200;

function fakeInbox(overrides: Partial<SePayInbox> = {}): SePayInbox {
  return {
    accept: vi.fn().mockResolvedValue({ kind: "ACCEPTED", id: "inbox-1" }),
    claimDue: vi.fn(),
    markProcessed: vi.fn(),
    markFailed: vi.fn(),
    ...overrides,
  } as unknown as SePayInbox;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: 123456,
    gateway: "MBBank",
    transactionDate: "2025-07-16 12:00:00",
    accountNumber: "0123456789",
    code: null,
    content: "ORD20250716A1B2C3D4",
    transferType: "in",
    transferAmount: 150000,
    accumulated: 150000,
    subAccount: null,
    referenceCode: "FT123456",
    description: "ORD20250716A1B2C3D4",
    ...overrides,
  };
}

function signed(rawBody: string, timestamp = String(NOW_SECONDS)) {
  const digest = createHmac("sha256", HMAC_FIXTURE_VALUE)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return {
    "x-sepay-timestamp": timestamp,
    "x-sepay-signature": `sha256=${digest}`,
  };
}

describe("verified SePay runtime boundary T122/T127", () => {
  it("rejects unsafe ingress configuration during composition, before accepting traffic", () => {
    expect(() =>
      createSePayIngressHandler({
        hmacSecret: HMAC_FIXTURE_VALUE,
        replayWindowSeconds: 300,
        ipAllowlist: ["not-an-ip"],
        trustedProxyIps: [],
        inbox: fakeInbox(),
      }),
    ).toThrow(/SEPAY_IP_ALLOWLIST/);
  });

  it("mints branded evidence only after prefixed raw-body HMAC, freshness, IP, and schema pass", () => {
    const rawBody = JSON.stringify(payload());
    const result = verifySePayIngress(
      {
        rawBody,
        headers: signed(rawBody),
        remoteAddress: "172.236.138.20",
      },
      {
        hmacSecret: HMAC_FIXTURE_VALUE,
        replayWindowSeconds: 300,
        ipAllowlist: ["172.236.138.20"],
        trustedProxyIps: [],
        nowSeconds: () => NOW_SECONDS,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({
      provider: "sepay",
      providerTransactionId: "123456",
      direction: "IN",
      merchantAccountId: "0123456789",
      amountVnd: 150000,
      structuredCode: null,
      content: "ORD20250716A1B2C3D4",
      reference: "FT123456",
    });
    expect(result.evidence.rawHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the structured provider code as the exact intent key when present", () => {
    const rawBody = JSON.stringify(
      payload({ code: "ORD-STRUCTURED-1", content: "noise ORD-OTHER-2" }),
    );
    const result = verifySePayIngress(
      { rawBody, headers: signed(rawBody), remoteAddress: "172.236.138.20" },
      {
        hmacSecret: HMAC_FIXTURE_VALUE,
        replayWindowSeconds: 300,
        ipAllowlist: ["172.236.138.20"],
        trustedProxyIps: [],
        nowSeconds: () => NOW_SECONDS,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.structuredCode).toBe("ORD-STRUCTURED-1");
      expect(result.evidence.content).toBe("noise ORD-OTHER-2");
    }
  });

  it("rejects bare hex, body reserialization/tampering, stale/future timestamp, and malformed schema", () => {
    const rawBody = JSON.stringify(payload());
    const validHeaders = signed(rawBody);
    const cases = [
      {
        rawBody,
        headers: {
          ...validHeaders,
          "x-sepay-signature": validHeaders["x-sepay-signature"].slice(7),
        },
      },
      { rawBody: `${rawBody} `, headers: validHeaders },
      { rawBody, headers: signed(rawBody, String(NOW_SECONDS - 301)) },
      { rawBody, headers: signed(rawBody, String(NOW_SECONDS + 301)) },
      (() => {
        const malformed = JSON.stringify(payload({ transferAmount: 1.5 }));
        return { rawBody: malformed, headers: signed(malformed) };
      })(),
      (() => {
        const impossibleDate = JSON.stringify(payload({ transactionDate: "2025-02-30 12:00:00" }));
        return { rawBody: impossibleDate, headers: signed(impossibleDate) };
      })(),
      (() => {
        const impossibleTime = JSON.stringify(payload({ transactionDate: "2025-07-16 25:00:00" }));
        return { rawBody: impossibleTime, headers: signed(impossibleTime) };
      })(),
    ];
    for (const candidate of cases) {
      const result = verifySePayIngress(
        { ...candidate, remoteAddress: "172.236.138.20" },
        {
          hmacSecret: HMAC_FIXTURE_VALUE,
          replayWindowSeconds: 300,
          ipAllowlist: ["172.236.138.20"],
          trustedProxyIps: [],
          nowSeconds: () => NOW_SECONDS,
        },
      );
      expect(result.ok).toBe(false);
    }
  });

  it("ignores spoofed forwarded IP from an untrusted peer and honors it only from a trusted proxy", () => {
    const rawBody = JSON.stringify(payload());
    const request = {
      rawBody,
      headers: { ...signed(rawBody), "x-forwarded-for": "172.236.138.20" },
      remoteAddress: "203.0.113.9",
    };
    const base = {
      hmacSecret: HMAC_FIXTURE_VALUE,
      replayWindowSeconds: 300,
      ipAllowlist: ["172.236.138.20"],
      nowSeconds: () => NOW_SECONDS,
    };
    expect(verifySePayIngress(request, { ...base, trustedProxyIps: [] })).toMatchObject({
      ok: false,
      code: "IP_NOT_ALLOWED",
    });
    expect(verifySePayIngress(request, { ...base, trustedProxyIps: ["203.0.113.9"] }).ok).toBe(
      true,
    );
  });

  it("returns the exact provider success response after durable inbox acceptance", async () => {
    const rawBody = JSON.stringify(payload());
    const inbox = fakeInbox();
    const handler = createSePayIngressHandler({
      hmacSecret: HMAC_FIXTURE_VALUE,
      replayWindowSeconds: 300,
      ipAllowlist: ["172.236.138.20"],
      trustedProxyIps: [],
      nowSeconds: () => NOW_SECONDS,
      inbox,
    });
    const response = await handler({
      rawBody,
      headers: signed(rawBody),
      remoteAddress: "172.236.138.20",
    });
    expect(response).toEqual({ status: 200, body: { success: true } });
    expect(inbox.accept).toHaveBeenCalledTimes(1);
  });

  it("fails closed without leaking signature/body when verification or durable acceptance fails", async () => {
    const rawBody = JSON.stringify(payload());
    const inbox = fakeInbox({
      accept: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    const handler = createSePayIngressHandler({
      hmacSecret: HMAC_FIXTURE_VALUE,
      replayWindowSeconds: 300,
      ipAllowlist: ["172.236.138.20"],
      trustedProxyIps: [],
      nowSeconds: () => NOW_SECONDS,
      inbox,
    });
    const invalid = await handler({
      rawBody,
      headers: { ...signed(rawBody), "x-sepay-signature": "sha256=" + "0".repeat(64) },
      remoteAddress: "172.236.138.20",
    });
    expect(invalid.status).toBe(401);
    expect(JSON.stringify(invalid.body)).not.toContain(rawBody);
    const retryable = await handler({
      rawBody,
      headers: signed(rawBody),
      remoteAddress: "172.236.138.20",
    });
    expect(retryable).toEqual({ status: 500, body: { success: false } });
  });

  it("acknowledges duplicate-identical and mutation events without running business settlement", async () => {
    const rawBody = JSON.stringify(payload());
    const inbox = fakeInbox({
      accept: vi
        .fn()
        .mockResolvedValueOnce({ kind: "DUPLICATE", id: "inbox-1" })
        .mockResolvedValueOnce({ kind: "MUTATION", id: "inbox-1", alertId: "alert-1" }),
    });
    const handler = createSePayIngressHandler({
      hmacSecret: HMAC_FIXTURE_VALUE,
      replayWindowSeconds: 300,
      ipAllowlist: ["172.236.138.20"],
      trustedProxyIps: [],
      nowSeconds: () => NOW_SECONDS,
      inbox,
    });

    const response = await handler({
      rawBody,
      headers: signed(rawBody),
      remoteAddress: "172.236.138.20",
    });

    expect(response).toEqual({ status: 200, body: { success: true } });
    const mutated = await handler({
      rawBody: `${rawBody.slice(0, -1)},"x":1}`,
      headers: signed(`${rawBody.slice(0, -1)},"x":1}`),
      remoteAddress: "172.236.138.20",
    });
    expect(mutated).toEqual({ status: 200, body: { success: true } });
    expect(inbox.accept).toHaveBeenCalledTimes(2);
  });
});
