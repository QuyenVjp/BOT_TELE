import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaymentEvidence } from "./domain.js";
import type { SePayReconciliationPort } from "./reconciliation.js";
import { brandVerifiedSePayApiEvidence } from "./sepay-ingress.js";

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
}): SePayReconciliationPort {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.hostname !== "userapi.sepay.vn") {
    throw new SePayApiError(
      "INVALID_CONFIG",
      "SePay API base URL must use the official HTTPS host",
    );
  }
  if (options.token.trim().length === 0) {
    throw new SePayApiError("INVALID_CONFIG", "SePay API token is required");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
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
        if (!/^[A-Za-z0-9:_-]{1,128}$/.test(listOptions.sinceId)) {
          throw new RangeError("SePay API since_id is invalid");
        }
        url.searchParams.set("since_id", listOptions.sinceId);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        await waitForOfficialRate();
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new SePayApiError("HTTP_ERROR", "SePay API request timed out");
        }
        throw new SePayApiError("HTTP_ERROR", "SePay API request failed");
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 429) {
        throw new SePayApiError(
          "RATE_LIMITED",
          "SePay API rate limited reconciliation",
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
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new SePayApiError("SCHEMA_INVALID", "SePay API response schema was invalid");
      }
      const parsed = ResponseSchema.safeParse(decoded);
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
  };
}
