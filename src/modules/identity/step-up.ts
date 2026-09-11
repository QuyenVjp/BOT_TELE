import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { withTransaction, type Db, type Executor } from "../../infrastructure/db/transaction.js";
import type { Vault } from "../../infrastructure/vault/port.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "./audit.js";

/**
 * RFC 6238 TOTP step-up for high-risk root-admin actions (THREAT_MODEL SEC-002).
 *
 * Step-up is an ADDITIONAL gate on top of the numeric-id root identity in
 * `root-admin.ts` — it never replaces it and never introduces another way to
 * become admin. A high-risk action demands a live grant bound to
 * (admin numeric id, action category); a grant is short-lived, single-use, and
 * authorises exactly one category.
 *
 * Secret handling (SR-001):
 *  - the TOTP seed is 20 random bytes, base32-encoded, and lives ONLY behind the
 *    vault boundary under the `admin-totp` namespace keyed by the numeric id;
 *  - `admin_step_up_secret` stores the opaque vault ref, never key material;
 *  - no function here returns the seed except `enroll`, whose whole purpose is
 *    to hand the operator an `otpauth://` URI for their authenticator app;
 *  - the seed never reaches an audit event, a failure code, or a log line.
 *
 * Brute-force resistance is durable: every code check appends to the
 * append-only `admin_step_up_attempt` table, so a restart cannot reset the
 * counter, and `maxAttempts` failures inside the window lock the admin out.
 */

export type StepUpActionCategory =
  | "WALLET_ADJUSTMENT"
  | "PAYMENT_OVERRIDE"
  | "REFUND"
  | "SUPPLIER_CONFIG"
  | "DELIVERY_REISSUE"
  | "BULK_PRICE_CHANGE"
  | "STOCK_ADJUSTMENT"
  | "PERMISSION_CHANGE"
  | "SECURITY_CONFIG"
  | "BROADCAST";

export type StepUpFailureCode =
  "NOT_ENROLLED" | "INVALID_CODE" | "LOCKED_OUT" | "NOT_GRANTED" | "GRANT_EXPIRED";

export interface StepUpGrant {
  adminTelegramUserId: string;
  category: StepUpActionCategory;
  expiresAt: Date;
}

export interface StepUpService {
  /** Generate a fresh seed and store it in the vault. Returns only the otpauth URI. */
  enroll(input: {
    adminTelegramUserId: string;
    issuer: string;
    accountLabel: string;
  }): Promise<{ otpauthUri: string }>;
  isEnrolled(adminTelegramUserId: string): Promise<boolean>;
  /**
   * Verifies the code, enforces lockout, and returns a grant on success.
   *
   * `resourceType`/`resourceId` bind the grant to the exact object the owner looked at.
   * They are optional so the development/test posture (step-up off) is unchanged, but when
   * supplied the grant can only be consumed for that same object — a category check alone
   * would let one approval authorise a change to a different variant.
   */
  verify(input: {
    adminTelegramUserId: string;
    category: StepUpActionCategory;
    code: string;
    resourceType?: string;
    resourceId?: string;
    now?: Date;
  }): Promise<{ ok: true; grant: StepUpGrant } | { ok: false; code: StepUpFailureCode }>;
  /**
   * Consumes a live grant for EXACTLY this admin + category, and for this object when the
   * grant carries a binding.
   */
  consume(input: {
    adminTelegramUserId: string;
    category: StepUpActionCategory;
    resourceType?: string;
    resourceId?: string;
    now?: Date;
  }): Promise<{ ok: true } | { ok: false; code: StepUpFailureCode }>;
}

export interface StepUpOptions {
  ttlSeconds: number;
  lockoutMinutes: number;
  maxAttempts: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_MODULUS = 10 ** TOTP_DIGITS;
const SEED_BYTES = 20;
/**
 * The vault port exposes only the `asset`/`capability` dimensions, so the
 * feature namespace is carried in the idempotency key: the ref is stable per
 * admin, contains no key material, and is the only thing the database sees.
 */
const SECRET_KEY_PREFIX = "admin-totp";
const BASE32_SHAPE = /^[A-Z2-7]+$/u;
const CODE_SHAPE = /^\d{6}$/u;
const TELEGRAM_ID_SHAPE = /^\d{1,19}$/u;
/** The nine high-risk categories a grant can be bound to (mirrors the DB CHECK). */
const STEP_UP_CATEGORY: Record<string, true> = {
  WALLET_ADJUSTMENT: true,
  PAYMENT_OVERRIDE: true,
  REFUND: true,
  SUPPLIER_CONFIG: true,
  DELIVERY_REISSUE: true,
  BULK_PRICE_CHANGE: true,
  STOCK_ADJUSTMENT: true,
  PERMISSION_CHANGE: true,
  SECURITY_CONFIG: true,
  BROADCAST: true,
};

/** Base32 encode (RFC 4648 alphabet, unpadded) — `bytes` are the raw seed. */
export function encodeBase32(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 decode (RFC 4648 alphabet, unpadded). Strict on purpose: padding,
 * separators and lowercase are rejected rather than guessed at, and a tail
 * length that cannot carry a whole byte (1, 3 or 6 leftover characters) is
 * rejected instead of silently truncated. Returns null for anything undecodable.
 */
export function decodeBase32(value: string): Uint8Array | null {
  if (!BASE32_SHAPE.test(value)) return null;
  const remainder = value.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 4226 truncation over an 8-byte big-endian counter. */
function hotp(key: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % TOTP_MODULUS).padStart(TOTP_DIGITS, "0");
}

/**
 * Pure RFC 6238 code generator: HMAC-SHA1, 6 digits, 30 s period. Returns an
 * empty string for an undecodable secret so a corrupt seed can never yield an
 * accepted code.
 */
export function generateTotp(secretBase32: string, unixSeconds: number): string {
  const key = decodeBase32(secretBase32);
  if (key === null || !Number.isFinite(unixSeconds)) return "";
  return hotp(key, Math.floor(unixSeconds / TOTP_PERIOD_SECONDS));
}

/**
 * Pure verifier. `driftSteps` defaults to 1 (±1 period of clock drift). Every
 * candidate is compared with `timingSafeEqual`; a malformed code is rejected
 * before any HMAC work.
 */
export function verifyTotpCode(input: {
  secretBase32: string;
  code: string;
  unixSeconds: number;
  driftSteps?: number;
}): boolean {
  if (!CODE_SHAPE.test(input.code)) return false;
  const key = decodeBase32(input.secretBase32);
  if (key === null || !Number.isFinite(input.unixSeconds)) return false;
  const drift = Math.max(0, Math.trunc(input.driftSteps ?? 1));
  const step = Math.floor(input.unixSeconds / TOTP_PERIOD_SECONDS);
  const presented = Buffer.from(input.code, "utf8");
  let matched = false;
  for (let delta = -drift; delta <= drift; delta += 1) {
    if (step + delta < 0) continue;
    const candidate = Buffer.from(hotp(key, step + delta), "utf8");
    // No early exit: a match must not be detectable from the work performed.
    if (timingSafeEqual(candidate, presented)) matched = true;
  }
  return matched;
}

interface StepUpAudit {
  adminTelegramUserId: string;
  action: string;
  reason: string;
  category?: StepUpActionCategory;
  code?: StepUpFailureCode;
}

/** Append step-up evidence. Only the category and the failure code are recorded. */
async function appendStepUpAudit(exec: Executor, input: StepUpAudit): Promise<void> {
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.adminTelegramUserId,
    action: input.action,
    targetType: "AdminStepUp",
    targetId: input.adminTelegramUserId,
    reason: input.reason,
    correlationId: `admin-step-up:${input.adminTelegramUserId}`,
    metadataRedacted: {
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.code === undefined ? {} : { code: input.code }),
    },
  });
}

/**
 * Bind the step-up gates to a database handle and a vault. The service holds no
 * secret in memory beyond the reveal needed for one verification.
 */
export function createStepUpService(db: Db, vault: Vault, options: StepUpOptions): StepUpService {
  const ttlSeconds = options.ttlSeconds;
  const lockoutMinutes = options.lockoutMinutes;
  const maxAttempts = options.maxAttempts;

  return {
    async enroll(input) {
      const adminId = input.adminTelegramUserId.trim();
      if (!TELEGRAM_ID_SHAPE.test(adminId)) {
        throw new Error("step-up enrollment requires a numeric Telegram user id");
      }
      const seed = encodeBase32(randomBytes(SEED_BYTES));
      const vaultRef = await vault.write(seed, {
        namespace: "asset",
        idempotencyKey: `${SECRET_KEY_PREFIX}-${adminId}`,
      });
      await sql`
        insert into admin_step_up_secret (admin_telegram_user_id, vault_ref)
        values (${adminId}, ${vaultRef})
        on conflict (admin_telegram_user_id) do update
          set vault_ref = excluded.vault_ref, rotated_at = now()
      `.execute(db);
      await appendStepUpAudit(db, {
        adminTelegramUserId: adminId,
        action: "admin.step_up.enrolled",
        reason: "TOTP factor enrolled",
      });
      const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountLabel)}`;
      const params = new URLSearchParams({
        secret: seed,
        issuer: input.issuer,
        algorithm: "SHA1",
        digits: String(TOTP_DIGITS),
        period: String(TOTP_PERIOD_SECONDS),
      });
      return { otpauthUri: `otpauth://totp/${label}?${params.toString()}` };
    },

    async isEnrolled(adminTelegramUserId) {
      const adminId = adminTelegramUserId.trim();
      if (!TELEGRAM_ID_SHAPE.test(adminId)) return false;
      const row = await sql<{ vault_ref: string }>`
        select vault_ref from admin_step_up_secret
        where admin_telegram_user_id = ${adminId}
        limit 1
      `.execute(db);
      return row.rows.length > 0;
    },

    async verify(input) {
      const now = input.now ?? new Date();
      const adminId = input.adminTelegramUserId.trim();
      if (!TELEGRAM_ID_SHAPE.test(adminId) || STEP_UP_CATEGORY[input.category] !== true) {
        await appendStepUpAudit(db, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.denied",
          reason: "denied: NOT_ENROLLED",
          category: input.category,
          code: "NOT_ENROLLED",
        });
        return { ok: false, code: "NOT_ENROLLED" };
      }

      // Durable rate limit: counted from the append-only attempt log, so a
      // process restart or a new instance cannot clear the counter. An attempt
      // made while locked out is refused without extending the lockout.
      const windowStart = new Date(now.getTime() - lockoutMinutes * 60_000);
      const failed = await sql<{ failed_attempts: number }>`
        select count(*)::int as failed_attempts
        from admin_step_up_attempt
        where admin_telegram_user_id = ${adminId}
          and succeeded = false
          and attempted_at >= ${windowStart.toISOString()}
      `.execute(db);
      if ((failed.rows[0]?.failed_attempts ?? 0) >= maxAttempts) {
        await appendStepUpAudit(db, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.denied",
          reason: "denied: LOCKED_OUT",
          category: input.category,
          code: "LOCKED_OUT",
        });
        return { ok: false, code: "LOCKED_OUT" };
      }

      const secret = await sql<{ vault_ref: string }>`
        select vault_ref from admin_step_up_secret
        where admin_telegram_user_id = ${adminId}
        limit 1
      `.execute(db);
      const vaultRef = secret.rows[0]?.vault_ref;
      let seed: string | null = null;
      if (vaultRef !== undefined) {
        // A vanished ref is indistinguishable from "never enrolled" by design:
        // both deny, and neither leaks whether a seed ever existed.
        seed = await vault.reveal(vaultRef).catch(() => null);
      }
      if (seed === null) {
        await appendStepUpAudit(db, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.denied",
          reason: "denied: NOT_ENROLLED",
          category: input.category,
          code: "NOT_ENROLLED",
        });
        return { ok: false, code: "NOT_ENROLLED" };
      }

      const accepted = verifyTotpCode({
        secretBase32: seed,
        code: input.code,
        unixSeconds: Math.floor(now.getTime() / 1000),
      });

      return withTransaction(db, async (trx) => {
        await sql`
          insert into admin_step_up_attempt (id, admin_telegram_user_id, attempted_at, succeeded)
          values (${newId()}, ${adminId}, ${now.toISOString()}, ${accepted})
        `.execute(trx);
        if (!accepted) {
          await appendStepUpAudit(trx, {
            adminTelegramUserId: adminId,
            action: "admin.step_up.denied",
            reason: "denied: INVALID_CODE",
            category: input.category,
            code: "INVALID_CODE",
          });
          return { ok: false, code: "INVALID_CODE" as const };
        }
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
        await sql`
          insert into admin_step_up_grant
            (id, admin_telegram_user_id, category, issued_at, expires_at,
             resource_type, resource_id)
          values
            (${newId()}, ${adminId}, ${input.category}, ${now.toISOString()},
             ${expiresAt.toISOString()}, ${input.resourceType ?? null},
             ${input.resourceId ?? null})
        `.execute(trx);
        await appendStepUpAudit(trx, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.verified",
          reason: "step-up verified",
          category: input.category,
        });
        return {
          ok: true as const,
          grant: { adminTelegramUserId: adminId, category: input.category, expiresAt },
        };
      });
    },

    async consume(input) {
      const now = input.now ?? new Date();
      const adminId = input.adminTelegramUserId.trim();
      // A malformed actor or an unknown category can never match a grant.
      if (!TELEGRAM_ID_SHAPE.test(adminId) || STEP_UP_CATEGORY[input.category] !== true) {
        await appendStepUpAudit(db, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.denied",
          reason: "denied: NOT_GRANTED",
          category: input.category,
          code: "NOT_GRANTED",
        });
        return { ok: false, code: "NOT_GRANTED" };
      }

      return withTransaction(db, async (trx) => {
        // `for update` makes the single-use rule race-proof: a concurrent
        // consumer blocks here until the row is already marked consumed.
        // A grant minted for an object can only be spent on that object. The predicate is
        // written so an UNBOUND grant (resource_id null, the dev/test posture) still
        // matches: the owner's approval of "a price change" is narrower when the grant says
        // which variant, never wider.
        const boundToCaller =
          input.resourceType !== undefined && input.resourceId !== undefined
            ? sql`(resource_id is null or (resource_type = ${input.resourceType} and resource_id = ${input.resourceId}))`
            : sql`resource_id is null`;
        const live = await sql<{ id: string }>`
          select id from admin_step_up_grant
          where admin_telegram_user_id = ${adminId}
            and category = ${input.category}
            and consumed_at is null
            and expires_at > ${now.toISOString()}
            and ${boundToCaller}
          order by expires_at desc
          limit 1
          for update
        `.execute(trx);
        const grantId = live.rows[0]?.id;
        if (grantId === undefined) {
          const stale = await sql<{ id: string }>`
            select id from admin_step_up_grant
            where admin_telegram_user_id = ${adminId}
              and category = ${input.category}
              and consumed_at is null
              and expires_at <= ${now.toISOString()}
            order by expires_at desc
            limit 1
          `.execute(trx);
          const code: StepUpFailureCode = stale.rows[0] ? "GRANT_EXPIRED" : "NOT_GRANTED";
          await appendStepUpAudit(trx, {
            adminTelegramUserId: adminId,
            action: "admin.step_up.denied",
            reason: `denied: ${code}`,
            category: input.category,
            code,
          });
          return { ok: false as const, code };
        }
        await sql`
          update admin_step_up_grant
          set consumed_at = ${now.toISOString()}
          where id = ${grantId}
        `.execute(trx);
        await appendStepUpAudit(trx, {
          adminTelegramUserId: adminId,
          action: "admin.step_up.consumed",
          reason: "step-up grant consumed",
          category: input.category,
        });
        return { ok: true as const };
      });
    },
  };
}
