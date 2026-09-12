import { describe, expect, it, vi } from "vitest";
import { createSePayApiPort, SePayApiError } from "../../src/modules/payments/sepay-api.js";
import { isVerifiedSePayEvidence } from "../../src/modules/payments/sepay-ingress.js";

const API_CREDENTIAL_FIXTURE = "test-only-sepay-api-credential";

/** The adapter resolves DNS through the outbound policy; stub it at a public address so the
 *  tests exercise the adapter contract rather than the network. */
const PUBLIC_RESOLVER = async (): Promise<readonly string[]> => ["93.184.216.34"];

describe("official SePay API v2 reconciliation adapter", () => {
  it("uses bounded official query parameters and mints verified API evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              transaction_date: "2026-07-17T10:30:00+07:00",
              account_number: "0123456789",
              va: null,
              transfer_type: "in",
              amount_in: 150000,
              amount_out: 0,
              accumulated: 500000,
              transaction_content: "ORDABC123",
              reference_number: "FT26069ABC",
              code: "ORDABC123",
              bank_brand_name: "ACB",
              bank_account_id: "f9e8d7c6-b5a4-4210-8edc-ba0987654321",
              va_id: null,
              webhook_success: 1,
            },
          ],
          meta: {
            pagination: {
              total: 1,
              per_page: 1,
              current_page: 1,
              last_page: 1,
              has_more: false,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const port = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl,
      resolveHost: PUBLIC_RESOLVER,
    });

    const rows = await port.listTransactions(1_768_500_000, 1_768_503_600, 1);

    expect(rows).toHaveLength(1);
    expect(isVerifiedSePayEvidence(rows[0])).toBe(true);
    expect(rows[0]).toMatchObject({
      provider: "sepay",
      providerTransactionId: "api:00000000-0000-4000-8000-000000000001",
      direction: "IN",
      merchantAccountId: "0123456789",
      amountVnd: 150000,
      content: "ORDABC123",
      reference: "FT26069ABC",
    });
    const [request, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe("https://userapi.sepay.vn/v2/transactions");
    expect(url.searchParams.get("per_page")).toBe("1");
    expect(url.searchParams.get("transaction_date_sort")).toBe("asc");
    expect(url.searchParams.get("timestamp_format")).toBe("iso8601");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${API_CREDENTIAL_FIXTURE}`,
    );
  });
  it("lists official bank accounts through the same client and parses the envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              account_holder_name: "TEST ACCOUNT",
              account_number: "0123456789",
              accumulated: 1000000,
              last_transaction: null,
              label: "sandbox",
              active: "1",
              bank_short_name: "ACB",
              bank_full_name: "ACB",
              bank_code: "ACB",
            },
          ],
          meta: {
            pagination: {
              total: 1,
              per_page: 1,
              current_page: 1,
              last_page: 1,
              has_more: false,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const port = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl,
      resolveHost: PUBLIC_RESOLVER,
    });

    const rows = await port.listBankAccounts(1, { page: 1 });

    expect(rows).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        accountHolderName: "TEST ACCOUNT",
        accountNumber: "0123456789",
        accumulated: 1000000,
        lastTransaction: null,
        label: "sandbox",
        active: true,
        bankShortName: "ACB",
        bankFullName: "ACB",
        bankCode: "ACB",
      },
    ]);
    const [request, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe("https://userapi.sepay.vn/v2/bank-accounts");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("1");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${API_CREDENTIAL_FIXTURE}`,
    );
  });

  it("allows the official sandbox only when explicitly enabled", () => {
    expect(() =>
      createSePayApiPort({
        baseUrl: "https://userapi-sandbox.sepay.vn/v2",
        token: API_CREDENTIAL_FIXTURE,
      }),
    ).toThrow(/official HTTPS host/i);

    expect(() =>
      createSePayApiPort({
        baseUrl: "https://userapi-sandbox.sepay.vn/v2",
        token: API_CREDENTIAL_FIXTURE,
        allowSandbox: true,
      }),
    ).not.toThrow();
  });

  it("fails closed on malformed responses and reports 429 without echoing the token", async () => {
    const malformed = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl: () => Promise.resolve(new Response('{"status":"success","data":[{}]}')),
      resolveHost: PUBLIC_RESOLVER,
    });
    await expect(malformed.listTransactions(1, 2, 10)).rejects.toThrow("schema");

    const throttled = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl: () =>
        Promise.resolve(
          new Response("rate limited", { status: 429, headers: { "retry-after": "17" } }),
        ),
      resolveHost: PUBLIC_RESOLVER,
    });
    const error = await throttled.listTransactions(1, 2, 10).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SePayApiError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 17 });
    expect(String(error)).not.toContain(API_CREDENTIAL_FIXTURE);
  });

  it("supports official pagination and UUID since_id cursors without changing the evidence namespace", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: [],
          meta: {
            pagination: { total: 0, per_page: 100, current_page: 3, last_page: 3, has_more: false },
          },
        }),
        { status: 200 },
      ),
    );
    const port = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl,
      resolveHost: PUBLIC_RESOLVER,
    });
    const sinceId = "00000000-0000-4000-8000-000000000001";
    await port.listTransactions(1, 2, 100, { page: 3, sinceId });
    const [request] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("transaction_date_sort")).toBe("asc");
    expect(url.searchParams.get("since_id")).toBe(sinceId);
    await expect(port.listTransactions(1, 2, 100, { sinceId: "api:cursor-1" })).rejects.toThrow(
      "UUID",
    );
  });

  it("normalizes provider timeout as a redacted retryable API error", async () => {
    const port = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      timeoutMs: 100,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });
    const error = await port.listTransactions(1, 2, 10).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SePayApiError);
    expect(error).toMatchObject({ code: "HTTP_ERROR" });
    expect(String(error)).not.toContain(API_CREDENTIAL_FIXTURE);
  });

  it("refuses a DNS answer that points at a non-public address, and says so", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const port = createSePayApiPort({
      baseUrl: "https://userapi.sepay.vn/v2",
      token: API_CREDENTIAL_FIXTURE,
      fetchImpl,
      // The official hostname resolving to a loopback/metadata address is the DNS-rebinding
      // case: the hostname check at construction cannot catch it, the address check must.
      resolveHost: async (): Promise<readonly string[]> => ["169.254.169.254"],
    });

    const error = await port.listTransactions(1, 2, 10).catch((value: unknown) => value);
    // A blocked destination must be distinguishable from provider downtime, so the refusal
    // is INVALID_CONFIG and never retried as HTTP_ERROR.
    expect(error).toBeInstanceOf(SePayApiError);
    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    // Nothing was sent, so the bearer token never left the process.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
