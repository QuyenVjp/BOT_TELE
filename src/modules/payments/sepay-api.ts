import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaymentEvidence } from "./domain.js";
import type { SePayReconciliationPort } from "./reconciliation.js";
import { brandVerifiedSePayApiEvidence } from "./sepay-ingress.js";
import { createPinnedFetch } from "../../infrastructure/net/pinned-fetch.js";
import { OutboundPolicyError } from "../../infrastructure/net/outbound-policy.js";

const MAX_RESPONSE_BYTES = 1_000_000;

const TransactionSchema = z.object({
  id: z.string().uuid(),
  transaction_date: z.string().datetime({ offset: true }),
  account_number: z.string().min(1).max(64),
  va: z.string().max(128).nullable(),
  transfer_type: z.enum(["in", "out"]),
  amount_in: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  amount_out: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  accumulated: z.number().max(Number.MAX_SAFE_INTEGER),
  transaction_content: z.string().max(1000).nullable(),
  reference_number: z.string().max(256).nullable(),
  code: z.string().max(256).nullable(),
  bank_brand_name: z.string().min(1).max(64),
  bank_account_id: z.string().uuid(),
  va_id: z.string().uuid().nullable(),
  webhook_success: z.union([z.literal(0), z.literal(1)]),
});
const SinceIdSchema = z.string().uuid();

const ResponseSchema = z.object({
  status: z.literal("success"),
  data: z.array(TransactionSchema).max(100),
  meta: z.object({
    pagination: z.object({
      total: z.number().int().nonnegative(),
      per_page: z.number().int().min(1).max(100),
      current_page: z.number().int().positive(),
      last_page: z.number().int().nonnegative(),
      has_more: z.boolean(),
    }),
  }),
});
const BankAccountSchema = z.object({
  id: z.string().uuid(),
  account_holder_name: z.string().min(1).max(256),
  account_number: z.string().min(1).max(64),
  accumulated: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  last_transaction: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  active: z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]),
  bank_short_name: z.string().min(1).max(64),
  bank_full_name: z.string().min(1).max(256),
  bank_code: z.string().min(1).max(64),
});

const BankAccountsResponseSchema = z.object({
  status: z.literal("success"),
  data: z.array(BankAccountSchema).max(100),
  meta: z.object({
    pagination: z.object({
      total: z.number().int().nonnegative(),
      per_page: z.number().int().min(1).max(100),
      current_page: z.number().int().positive(),
      last_page: z.number().int().nonnegative(),
      has_more: z.boolean(),
    }),
  }),
});

export class SePayApiError extends Error {
  readonly code: "INVALID_CONFIG" | "RATE_LIMITED" | "HTTP_ERROR" | "SCHEMA_INVALID";
  readonly retryAfterSeconds: number | null;

  constructor(
    code: SePayApiError["code"],
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "SePayApiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export interface SePayBankAccount {
  id: string;
  accountHolderName: string;
  accountNumber: string;
  accumulated: number;
  lastTransaction: string | null;
  label: string | null;
  active: boolean;
  bankShortName: string;
  bankFullName: string;
  bankCode: string;
}

export interface SePayApiPort extends SePayReconciliationPort {
  listBankAccounts(limit?: number, options?: { page?: number }): Promise<SePayBankAccount[]>;
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : null;
}

export function createSePayApiPort(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowSandbox?: boolean;
  /**
   * Test seam for the outbound-policy DNS lookup. Production omits it and the policy
   * resolves through `node:dns`. It cannot disable the policy: the resolved addresses
   * are still classified, so an injected resolver returning a private address is refused.
   */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}): SePayApiPort {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw new SePayApiError("INVALID_CONFIG", "SePay API base URL is invalid");
  }
  const allowedHosts = ["userapi.sepay.vn", "userapi-sandbox.sepay.vn"] as const;
  if (
    baseUrl.protocol !== "https:" ||
    !allowedHosts.includes(baseUrl.hostname as (typeof allowedHosts)[number]) ||
    (baseUrl.hostname === "userapi-sandbox.sepay.vn" && options.allowSandbox !== true)
  ) {
    throw new SePayApiError(
      "INVALID_CONFIG",
      "SePay API base URL must use an allowed official HTTPS host",
    );
  }
  // Same outbound policy as every other egress, and it BINDS the socket to the address it
  // approves — so a DNS answer pointing at loopback/metadata is refused, and an answer that
  // changes between validation and connect cannot reroute a request that carries our token.
  const guardedFetch = createPinnedFetch({
    allowedHosts: [baseUrl.hostname],
    timeoutMs: options.timeoutMs ?? 8_000,
    ...(options.resolveHost ? { resolve: options.resolveHost } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (options.token.trim().length === 0) {
    throw new SePayApiError("INVALID_CONFIG", "SePay API token is required");
  }
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new SePayApiError("INVALID_CONFIG", "SePay API timeout is outside the safe bound");
  }
  const requestTimes: number[] = [];
  const waitForOfficialRate = async (): Promise<void> => {
    const now = Date.now();
    while (requestTimes.length > 0 && now - requestTimes[0]! >= 1_000) requestTimes.shift();
    if (requestTimes.length >= 3) {
      const waitMs = Math.max(1, 1_000 - (now - requestTimes[0]!));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      return waitForOfficialRate();
    }
    requestTimes.push(Date.now());
  };
  const getJson = async (url: URL): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      await waitForOfficialRate();
      response = await guardedFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SePayApiError("HTTP_ERROR", "SePay API request timed out");
      }
      if (error instanceof OutboundPolicyError) {
        throw new SePayApiError("INVALID_CONFIG", "SePay API destination is not allowed");
      }
      throw new SePayApiError("HTTP_ERROR", "SePay API request failed");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 429) {
      throw new SePayApiError(
        "RATE_LIMITED",
        "SePay API rate limited request",
        retryAfter(response.headers),
      );
    }
    if (!response.ok) {
      throw new SePayApiError("HTTP_ERROR", `SePay API returned HTTP ${response.status}`);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new SePayApiError("SCHEMA_INVALID", "SePay API response exceeded the size bound");
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new SePayApiError("SCHEMA_INVALID", "SePay API response schema was invalid");
    }
  };

  return {
    async listTransactions(fromSec, toSec, limit = 100, listOptions = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("SePay API per_page must be between 1 and 100");
      }
      if (!Number.isInteger(fromSec) || !Number.isInteger(toSec) || fromSec > toSec) {
        throw new RangeError("SePay API reconciliation window is invalid");
      }
      const url = new URL(baseUrl.toString().replace(/\/$/, "") + "/transactions");
      url.searchParams.set("transaction_date_from", new Date(fromSec * 1000).toISOString());
      url.searchParams.set("transaction_date_to", new Date(toSec * 1000).toISOString());
      url.searchParams.set("transaction_date_sort", "asc");
      const page = listOptions.page ?? 1;
      if (!Number.isInteger(page) || page < 1)
        throw new RangeError("SePay API page must be positive");
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(limit));
      url.searchParams.set("timestamp_format", "iso8601");
      if (listOptions.sinceId !== undefined) {
        if (!SinceIdSchema.safeParse(listOptions.sinceId).success) {
          throw new RangeError("SePay API since_id must be a UUID");
        }
        url.searchParams.set("since_id", listOptions.sinceId);
      }

      const parsed = ResponseSchema.safeParse(await getJson(url));
      if (!parsed.success) {
        throw new SePayApiError("SCHEMA_INVALID", "SePay API response schema was invalid");
      }

      return parsed.data.data.map((row) => {
        const evidence: PaymentEvidence = {
          provider: "sepay",
          providerTransactionId: `api:${row.id}`,
          direction: row.transfer_type === "in" ? "IN" : "OUT",
          merchantAccountId: row.account_number,
          amountVnd: row.transfer_type === "in" ? row.amount_in : row.amount_out,
          structuredCode: row.code,
          content: row.transaction_content,
          reference: row.reference_number,
          transactedAt: new Date(row.transaction_date),
          rawHash: createHash("sha256").update(JSON.stringify(row), "utf8").digest("hex"),
          correlationId: `sepay-api:${row.id}`,
        };
        return brandVerifiedSePayApiEvidence(evidence);
      });
    },
    async listBankAccounts(limit = 100, listOptions = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("SePay API per_page must be between 1 and 100");
      }
      const page = listOptions.page ?? 1;
      if (!Number.isInteger(page) || page < 1) {
        throw new RangeError("SePay API page must be positive");
      }
      const url = new URL(baseUrl.toString().replace(/\/$/, "") + "/bank-accounts");
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(limit));

      const parsed = BankAccountsResponseSchema.safeParse(await getJson(url));
      if (!parsed.success) {
        throw new SePayApiError("SCHEMA_INVALID", "SePay API response schema was invalid");
      }
      return parsed.data.data.map((row) => ({
        id: row.id,
        accountHolderName: row.account_holder_name,
        accountNumber: row.account_number,
        accumulated: row.accumulated,
        lastTransaction: row.last_transaction ?? null,
        label: row.label ?? null,
        active: row.active === 1 || row.active === "1",
        bankShortName: row.bank_short_name,
        bankFullName: row.bank_full_name,
        bankCode: row.bank_code,
      }));
    },
  };
}
