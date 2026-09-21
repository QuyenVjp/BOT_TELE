import { google, type sheets_v4 } from "googleapis";
import { z } from "zod";
import type { Vault } from "../vault/port.js";
import { SHEETS_API_SCOPE } from "../../modules/google-sheets/contracts.js";

export { SHEETS_API_SCOPE };

export type SheetValue = string | number | boolean | null;
export interface SheetValueRange {
  range: string;
  values: readonly (readonly SheetValue[])[];
}

export interface SheetsSpreadsheet {
  sheets: readonly { sheetId: number; title: string }[];
  developerMetadata: readonly { metadataKey: string; metadataValue: string | null }[];
}

export interface GoogleSheetsApi {
  readonly principalEmail?: string;
  getSpreadsheet(input: { spreadsheetId: string }): Promise<SheetsSpreadsheet>;
  batchGet(input: {
    spreadsheetId: string;
    ranges: readonly string[];
  }): Promise<readonly SheetValueRange[]>;
  batchUpdateValues(input: {
    spreadsheetId: string;
    data: readonly SheetValueRange[];
  }): Promise<void>;
  batchUpdate(input: {
    spreadsheetId: string;
    requests: readonly sheets_v4.Schema$Request[];
  }): Promise<void>;
  append(input: {
    spreadsheetId: string;
    range: string;
    values: readonly (readonly SheetValue[])[];
  }): Promise<void>;
}

export interface GoogleSheetsClientOptions {
  credentialVaultRef: string;
  timeoutMs: number;
  maxAttempts: number;
  vault: Vault;
  sleep?: (ms: number) => Promise<void>;
}

export type SheetsErrorCode =
  | "RATE_LIMITED"
  | "UPSTREAM_5XX"
  | "NETWORK"
  | "AUTH"
  | "PERMISSION_DENIED"
  | "INVALID_REQUEST"
  | "UNKNOWN";

export class GoogleSheetsError extends Error {
  readonly code: SheetsErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: SheetsErrorCode, retryable: boolean, status?: number) {
    super(`Google Sheets request failed (${code})`);
    this.name = "GoogleSheetsError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const credentialSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(64),
  project_id: z.string().min(1).optional(),
});

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("response" in error) {
    const response = error.response;
    if (
      response !== null &&
      typeof response === "object" &&
      "status" in response &&
      typeof response.status === "number"
    ) {
      return response.status;
    }
  }
  return "status" in error && typeof error.status === "number" ? error.status : undefined;
}

export function classifySheetsError(error: unknown): GoogleSheetsError {
  if (error instanceof GoogleSheetsError) return error;
  const status = statusOf(error);
  if (status === 401) return new GoogleSheetsError("AUTH", false, status);
  if (status === 403) return new GoogleSheetsError("PERMISSION_DENIED", false, status);
  if (status === 429) return new GoogleSheetsError("RATE_LIMITED", true, status);
  if (status !== undefined && status >= 500 && status <= 599) {
    return new GoogleSheetsError("UPSTREAM_5XX", true, status);
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    return new GoogleSheetsError("INVALID_REQUEST", false, status);
  }
  if (error instanceof TypeError) return new GoogleSheetsError("NETWORK", true);
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND")
  ) {
    return new GoogleSheetsError("NETWORK", true);
  }
  return new GoogleSheetsError("UNKNOWN", false);
}

export function backoffDelayMs(attempt: number, baseMs = 100, capMs = 5_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}

export async function withSheetsRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts: number;
    retryable: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep =
    options.sleep ??
    ((ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts, 5));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const classified = classifySheetsError(error);
      if (!options.retryable || !classified.retryable || attempt + 1 >= maxAttempts) {
        throw classified;
      }
      await sleep(backoffDelayMs(attempt));
    }
  }
}

export function buildBatchUpdateValuesPayload(data: readonly SheetValueRange[]): {
  valueInputOption: "RAW";
  data: readonly SheetValueRange[];
} {
  return { valueInputOption: "RAW", data };
}

function asRows(values: readonly (readonly SheetValue[])[] | undefined): readonly SheetValue[][] {
  return (values ?? []).map((row) => [...row]);
}
async function createSheetsClient(
  options: GoogleSheetsClientOptions,
): Promise<{ client: sheets_v4.Sheets; principalEmail: string }> {
  let material: string;
  try {
    material = await options.vault.reveal(options.credentialVaultRef);
  } catch {
    throw new GoogleSheetsError("AUTH", false);
  }
  try {
    const parsed = credentialSchema.parse(JSON.parse(material));
    const credentials = parsed.project_id
      ? {
          client_email: parsed.client_email,
          private_key: parsed.private_key,
          project_id: parsed.project_id,
        }
      : { client_email: parsed.client_email, private_key: parsed.private_key };
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [SHEETS_API_SCOPE],
    });
    const client = google.sheets({ version: "v4", auth });
    material = "";
    return { client, principalEmail: parsed.client_email };
  } catch {
    material = "";
    throw new GoogleSheetsError("AUTH", false);
  }
}

export async function createGoogleSheetsClient(
  options: GoogleSheetsClientOptions,
): Promise<GoogleSheetsApi> {
  if (!options.credentialVaultRef.startsWith("vault:")) {
    throw new GoogleSheetsError("AUTH", false);
  }
  const { client: sheets, principalEmail } = await createSheetsClient(options);
  const requestOptions = { timeout: options.timeoutMs };
  const retry = <T>(operation: () => Promise<T>, retryable = true) =>
    options.sleep
      ? withSheetsRetry(operation, {
          maxAttempts: options.maxAttempts,
          retryable,
          sleep: options.sleep,
        })
      : withSheetsRetry(operation, {
          maxAttempts: options.maxAttempts,
          retryable,
        });
  return {
    principalEmail,
    async getSpreadsheet({ spreadsheetId }) {
      const response = await retry(() =>
        sheets.spreadsheets.get(
          {
            spreadsheetId,
            fields:
              "sheets(properties(sheetId,title)),developerMetadata(metadataKey,metadataValue)",
          },
          requestOptions,
        ),
      );
      return {
        sheets: (response.data.sheets ?? []).flatMap((sheet) => {
          const properties = sheet.properties;
          return typeof properties?.sheetId === "number" && properties.title
            ? [{ sheetId: properties.sheetId, title: properties.title }]
            : [];
        }),
        developerMetadata: (response.data.developerMetadata ?? []).flatMap((entry) =>
          entry.metadataKey
            ? [{ metadataKey: entry.metadataKey, metadataValue: entry.metadataValue ?? null }]
            : [],
        ),
      };
    },

    async batchGet({ spreadsheetId, ranges }) {
      if (ranges.length === 0) throw new GoogleSheetsError("INVALID_REQUEST", false, 400);
      const response = await retry(() =>
        sheets.spreadsheets.values.batchGet(
          {
            spreadsheetId,
            ranges: [...ranges],
            majorDimension: "ROWS",
            valueRenderOption: "UNFORMATTED_VALUE",
            dateTimeRenderOption: "FORMATTED_STRING",
          },
          requestOptions,
        ),
      );
      return (response.data.valueRanges ?? []).map((range) => ({
        range: range.range ?? "",
        values: asRows(range.values ?? undefined),
      }));
    },

    async batchUpdateValues({ spreadsheetId, data }) {
      if (data.length === 0) return;
      await retry(() =>
        sheets.spreadsheets.values.batchUpdate(
          {
            spreadsheetId,
            requestBody: {
              valueInputOption: "RAW",
              data: data.map((entry) => ({
                range: entry.range,
                values: entry.values.map((row) => [...row]),
              })),
              includeValuesInResponse: false,
            },
          },
          requestOptions,
        ),
      );
    },

    async batchUpdate({ spreadsheetId, requests }) {
      if (requests.length === 0) return;
      await retry(
        () =>
          sheets.spreadsheets.batchUpdate(
            {
              spreadsheetId,
              requestBody: { requests: [...requests] },
            },
            requestOptions,
          ),
        false,
      );
    },

    async append({ spreadsheetId, range, values }) {
      if (values.length === 0) return;
      await retry(
        () =>
          sheets.spreadsheets.values.append(
            {
              spreadsheetId,
              range,
              valueInputOption: "RAW",
              insertDataOption: "INSERT_ROWS",
              includeValuesInResponse: false,
              requestBody: { values: values.map((row) => [...row]) },
            },
            requestOptions,
          ),
        false,
      );
    },
  };
}
