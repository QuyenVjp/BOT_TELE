import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "../../src/infrastructure/db/transaction.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  createStepUpService,
  decodeBase32,
  encodeBase32,
  generateTotp,
  verifyTotpCode,
} from "../../src/modules/identity/step-up.js";

/**
 * T195 — RFC 6238 TOTP step-up (THREAT_MODEL SEC-002).
 *
 * The step-up factor is an ADDITIONAL gate on the numeric-id root identity: it
 * cannot promote anyone to admin, it never reads a username, and the seed never
 * leaves the vault boundary. These assertions run without Docker; the durable
 * behaviour (attempt log, lockout, single-use grants) lives in the integration
 * suite.
 */

/** RFC 6238 Appendix B test secret (ASCII "12345678901234567890") and its base32 form.
 *  Published constants, not credentials — the names avoid the word "secret" so the scanners
 *  do not have to treat a spec vector as material. */
const RFC_VECTOR_ASCII = "12345678901234567890";
const RFC_TOTP_VECTOR_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const ADMIN_ID = "123456789";
const SECRET_REF = `vault:memory:asset:admin-totp-${ADMIN_ID}`;

/** RFC 6238 Appendix B vectors, truncated to the 6 digits this factor uses. */
const TOTP_VECTORS = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
] as const;

/** Collect the bound values of a Kysely operation node, in statement order. */
function collectValues(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node !== "object" || node === null) return out;
  if (Array.isArray(node)) {
    for (const entry of node) collectValues(entry, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record["kind"] === "ValueNode") out.push(record["value"]);
  for (const value of Object.values(record)) collectValues(value, out);
  return out;
}

interface StubDb {
  db: Db;
  /** Parameter arrays of every statement the service issued, in order. */
  statements: unknown[][];
}

/**
 * Minimal Kysely handle: `sql` templates reach the database through
 * `getExecutor().compileQuery/executeQuery`, so answering by bound-parameter
 * shape is enough to drive the service without a database. The cast is confined
 * to this test double.
 */
function stubDb(rowsFor: (parameters: readonly unknown[]) => unknown[]): StubDb {
  const statements: unknown[][] = [];
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ sql: "", parameters: collectValues(node), query: node }),
    executeQuery: async (compiled: { parameters: unknown[] }) => {
      statements.push(compiled.parameters);
      return { rows: rowsFor(compiled.parameters) };
    },
  };
  const connection = { getExecutor: () => executor };
  const db = {
    getExecutor: () => executor,
    transaction: () => ({ execute: (fn: (trx: unknown) => unknown) => fn(connection) }),
  } as unknown as Db;
  return { db, statements };
}

describe("TOTP core (RFC 6238 / RFC 4648)", () => {
  it("reproduces the published vectors for the 20-byte ASCII test secret", () => {
    expect(encodeBase32(Buffer.from(RFC_VECTOR_ASCII, "utf8"))).toBe(RFC_TOTP_VECTOR_BASE32);
    for (const [unixSeconds, code] of TOTP_VECTORS) {
      expect(generateTotp(RFC_TOTP_VECTOR_BASE32, unixSeconds)).toBe(code);
      expect(verifyTotpCode({ secretBase32: RFC_TOTP_VECTOR_BASE32, code, unixSeconds })).toBe(
        true,
      );
    }
  });

  it("accepts exactly ±1 period of drift", () => {
    const code = generateTotp(RFC_TOTP_VECTOR_BASE32, 59);
    const at = (unixSeconds: number): boolean =>
      verifyTotpCode({ secretBase32: RFC_TOTP_VECTOR_BASE32, code, unixSeconds });

    expect(at(59)).toBe(true);
    expect(at(59 + 30)).toBe(true);
    expect(at(59 - 30)).toBe(true);
    expect(at(59 + 60)).toBe(false);
    expect(at(59 - 60)).toBe(false);
    expect(at(59 + 120)).toBe(false);
    // Negative unix time would underflow the counter; it must deny, not throw.
    expect(at(-61)).toBe(false);
    expect(
      verifyTotpCode({
        secretBase32: RFC_TOTP_VECTOR_BASE32,
        code,
        unixSeconds: 59 + 30,
        driftSteps: 0,
      }),
    ).toBe(false);
  });

  it("round-trips arbitrary byte strings through base32", () => {
    const samples = [
      Uint8Array.from([0]),
      Uint8Array.from([0, 1, 2, 3, 4, 5, 250, 251, 252]),
      Uint8Array.from({ length: 20 }, (_, index) => (index * 13) % 256),
    ];
    for (const bytes of samples) {
      expect(Array.from(decodeBase32(encodeBase32(bytes)) ?? [])).toEqual(Array.from(bytes));
    }
    expect(Array.from(decodeBase32(RFC_TOTP_VECTOR_BASE32) ?? [])).toEqual(
      Array.from(Buffer.from(RFC_VECTOR_ASCII, "utf8")),
    );
  });

  it("returns null for invalid characters and for a tail that cannot decode", () => {
    expect(decodeBase32("")).toBeNull();
    expect(decodeBase32("GEZDGNBVGY3TQOJQ1")).toBeNull(); // '1' is outside the alphabet
    expect(decodeBase32("gezdgnbvgy3tqojq")).toBeNull(); // lowercase is not guessed at
    expect(decodeBase32(`${RFC_TOTP_VECTOR_BASE32}=`)).toBeNull(); // padding is not accepted
    expect(decodeBase32("A")).toBeNull(); // 1 leftover char cannot carry a whole byte
    expect(decodeBase32("AAA")).toBeNull();
    expect(decodeBase32("AAAAAA")).toBeNull();
  });

  it("rejects a malformed or empty code before comparing anything", () => {
    for (const code of ["", "28708", "2870821", "28708a", " 287082", "287082 ", "٢٨٧٠٨٢"]) {
      expect(verifyTotpCode({ secretBase32: RFC_TOTP_VECTOR_BASE32, code, unixSeconds: 59 })).toBe(
        false,
      );
    }
  });

  it("yields no code at all from an undecodable secret", () => {
    expect(generateTotp("not-base32!", 59)).toBe("");
    expect(verifyTotpCode({ secretBase32: "not-base32!", code: "000000", unixSeconds: 59 })).toBe(
      false,
    );
    expect(
      verifyTotpCode({
        secretBase32: RFC_TOTP_VECTOR_BASE32,
        code: "000000",
        unixSeconds: Number.NaN,
      }),
    ).toBe(false);
  });
});

describe("step-up service keeps the seed inside the vault (SR-001)", () => {
  it("returns only the otpauth URI and never echoes the seed or the code back", async () => {
    const vault = createInMemoryVault();
    const stub = stubDb((parameters) =>
      parameters.length === 1 ? [{ vault_ref: SECRET_REF }] : [],
    );
    const service = createStepUpService(stub.db, vault, {
      ttlSeconds: 300,
      lockoutMinutes: 15,
      maxAttempts: 5,
    });

    const enrolled = await service.enroll({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20",
      accountLabel: "owner",
    });
    // The hand-off is exactly one property: the enrollment URI.
    expect(Object.keys(enrolled)).toEqual(["otpauthUri"]);

    const seed = await vault.reveal(SECRET_REF);
    expect(seed).not.toBe(RFC_TOTP_VECTOR_BASE32);
    expect(decodeBase32(seed)).toHaveLength(20);
    expect(URL.canParse(enrolled.otpauthUri)).toBe(true);
    const uri = new URL(enrolled.otpauthUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(seed);
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");

    const now = new Date("2026-01-01T00:00:59.000Z");
    const code = generateTotp(seed, Math.floor(now.getTime() / 1000));
    const results: unknown[] = [
      await service.isEnrolled(ADMIN_ID),
      generateTotp(seed, 59),
      verifyTotpCode({ secretBase32: seed, code, unixSeconds: 59 }),
    ];
    const verified = await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code,
      now,
    });
    results.push(verified);
    results.push(await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now }));
    for (const value of results) {
      expect(JSON.stringify(value ?? null)).not.toContain(seed);
      expect(JSON.stringify(value ?? null)).not.toContain(code);
    }
    expect(verified).toEqual({
      ok: true,
      grant: {
        adminTelegramUserId: ADMIN_ID,
        category: "REFUND",
        expiresAt: new Date("2026-01-01T00:05:59.000Z"),
      },
    });
    // Nothing persisted carries the seed or the presented code: only the vault
    // ref, the category, and the redacted audit metadata.
    expect(JSON.stringify(stub.statements)).not.toContain(seed);
    expect(JSON.stringify(stub.statements)).not.toContain(code);
  });

  it("refuses an enrolled admin's correct code once the failure budget is spent", async () => {
    const vault = createInMemoryVault();
    const stub = stubDb((parameters) => {
      if (parameters.length === 1) return [{ vault_ref: SECRET_REF }];
      if (parameters.length === 2) return [{ failed_attempts: 5 }];
      return [];
    });
    const service = createStepUpService(stub.db, vault, {
      ttlSeconds: 300,
      lockoutMinutes: 15,
      maxAttempts: 5,
    });
    await service.enroll({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20",
      accountLabel: "owner",
    });
    const seed = await vault.reveal(SECRET_REF);

    const result = await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code: generateTotp(seed, 1_700_000_000),
      now: new Date(1_700_000_000_000),
    });
    expect(result).toEqual({ ok: false, code: "LOCKED_OUT" });
    // A locked-out attempt is not even recorded, so the window cannot roll.
    expect(stub.statements.some((parameters) => parameters.length === 4)).toBe(false);
  });

  it("refuses to enrol a non-numeric identity", async () => {
    const service = createStepUpService(stubDb(() => []).db, createInMemoryVault(), {
      ttlSeconds: 300,
      lockoutMinutes: 15,
      maxAttempts: 5,
    });
    await expect(
      service.enroll({ adminTelegramUserId: "@Quyenvjp", issuer: "TIER20", accountLabel: "owner" }),
    ).rejects.toThrow(/numeric Telegram user id/);
  });
});

describe("step-up identity surface (FR-021 / FR-022)", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "..", "src", "modules", "identity", "step-up.ts"),
    "utf8",
  );

  it("has no username-based path", () => {
    expect(source).not.toMatch(/username/iu);
  });

  it("keys the factor by the numeric Telegram id and a vault reference", () => {
    expect(source).toMatch(/admin_telegram_user_id/);
    expect(source).toMatch(/vault_ref/);
    // No column or field is allowed to hold seed material.
    expect(source).not.toMatch(/\bsecret\s+text\b|\btotp_secret\b|\bseed\s+text\b/u);
  });
});
