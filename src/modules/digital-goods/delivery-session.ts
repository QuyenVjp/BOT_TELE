import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";

export interface DeliverySessionCodecConfig {
  key: string;
  keyVersion: number;
  audience: string;
  /** Optional previous key accepted only during a bounded rotation grace window. */
  previousKey?: string;
  previousKeyVersion?: number;
  previousKeyGraceUntil?: Date;
}

export interface DeliverySessionClaims {
  sessionId: string;
  bundleId: string;
  customerId: string;
  telegramUserId: string;
  audience: string;
  nonce: string;
  expiresAt: number;
  keyVersion: number;
}

export async function issueDeliverySession(
  db: Executor,
  input: {
    bundleId: string;
    customerId: string;
    telegramUserId: string;
    ttlSeconds: number;
    config: DeliverySessionCodecConfig;
    now?: Date;
    idempotencyKey?: string;
    expiresAt?: Date;
    activate?: boolean;
  },
): Promise<{ token: string; claims: DeliverySessionClaims }> {
  validateConfig(input.config);
  if (!/^[1-9][0-9]{0,19}$/.test(input.telegramUserId)) {
    throw new Error("Invalid Telegram user id");
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 86_400) {
    throw new Error("Invalid delivery session TTL");
  }
  const now = input.now ?? new Date();
  const deterministicFields = [input.idempotencyKey !== undefined, input.expiresAt !== undefined];
  if (deterministicFields.some(Boolean) && !deterministicFields.every(Boolean)) {
    throw new Error("Deterministic delivery session configuration is incomplete");
  }
  if (
    input.idempotencyKey !== undefined &&
    (input.idempotencyKey.length < 1 || Buffer.byteLength(input.idempotencyKey, "utf8") > 256)
  ) {
    throw new Error("Invalid delivery session idempotency key");
  }
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + input.ttlSeconds * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new Error("Invalid delivery session expiry");
  }
  const deterministic = input.idempotencyKey
    ? deriveDeterministicSessionMaterial(input.config.key, input.idempotencyKey)
    : undefined;
  const claims: DeliverySessionClaims = {
    sessionId: deterministic?.sessionId ?? newId(),
    bundleId: input.bundleId,
    customerId: input.customerId,
    telegramUserId: input.telegramUserId,
    audience: input.config.audience,
    nonce: deterministic?.nonce ?? randomBytes(24).toString("base64url"),
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    keyVersion: input.config.keyVersion,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(payload, input.config.key);
  await sql`
    insert into delivery_session
      (id, bundle_id, customer_id, telegram_user_id, audience, nonce_hash,
       key_version, expires_at, activated_at)
    values
      (${claims.sessionId}, ${claims.bundleId}, ${claims.customerId}, ${claims.telegramUserId},
       ${claims.audience}, ${hashNonce(claims.nonce)}, ${claims.keyVersion},
       ${new Date(claims.expiresAt * 1000).toISOString()},
       ${input.activate === false ? null : now.toISOString()})
    on conflict (id) do nothing
  `.execute(db);
  const persisted = await sql<{
    bundle_id: string;
    customer_id: string;
    telegram_user_id: string;
    audience: string;
    nonce_hash: string;
    key_version: number;
    expires_at: Date | string;
    activated_at: Date | string | null;
    used_at: Date | string | null;
    revoked_at: Date | string | null;
  }>`
    select bundle_id, customer_id, telegram_user_id, audience, nonce_hash,
      key_version, expires_at, activated_at, used_at, revoked_at
    from delivery_session where id = ${claims.sessionId}
  `.execute(db);
  const row = persisted.rows[0];
  if (
    !row ||
    row.bundle_id !== claims.bundleId ||
    row.customer_id !== claims.customerId ||
    row.telegram_user_id !== claims.telegramUserId ||
    row.audience !== claims.audience ||
    row.nonce_hash !== hashNonce(claims.nonce) ||
    row.key_version !== claims.keyVersion ||
    new Date(row.expires_at).getTime() !== claims.expiresAt * 1000 ||
    (input.activate === false ? row.activated_at !== null : row.activated_at === null) ||
    row.used_at !== null ||
    row.revoked_at !== null
  ) {
    throw new Error("Delivery session idempotency conflict");
  }
  return { token: `ds1.${payload}.${signature}`, claims };
}

export function verifyDeliverySessionToken(
  token: string,
  config: DeliverySessionCodecConfig,
  now: Date = new Date(),
): DeliverySessionClaims | null {
  try {
    validateConfig(config);
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "ds1") return null;
    const payload = parts[1]!;
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isClaims(value)) return null;
    if (value.audience !== config.audience) return null;
    const presented = Buffer.from(parts[2]!, "base64url");
    const previousKeyIsInGrace =
      config.previousKey !== undefined &&
      config.previousKeyVersion !== undefined &&
      config.previousKeyGraceUntil !== undefined &&
      now.getTime() < config.previousKeyGraceUntil.getTime();
    const accepted = [
      { key: config.key, version: config.keyVersion },
      ...(previousKeyIsInGrace
        ? [{ key: config.previousKey!, version: config.previousKeyVersion! }]
        : []),
    ];
    const signedBy = accepted.find(({ key, version }) => {
      if (value.keyVersion !== version) return false;
      const expected = Buffer.from(sign(payload, key), "base64url");
      return presented.length === expected.length && timingSafeEqual(presented, expected);
    });
    if (!signedBy) return null;
    if (value.expiresAt <= Math.floor(now.getTime() / 1000)) return null;
    return value;
  } catch {
    return null;
  }
}

export function hashDeliverySessionNonce(nonce: string): string {
  return hashNonce(nonce);
}

export function deliverySessionIssueConfigForVersion(
  config: DeliverySessionCodecConfig,
  keyVersion: number,
  now: Date = new Date(),
): DeliverySessionCodecConfig {
  validateConfig(config);
  if (keyVersion === config.keyVersion) {
    return { key: config.key, keyVersion, audience: config.audience };
  }
  if (
    keyVersion === config.previousKeyVersion &&
    config.previousKey !== undefined &&
    config.previousKeyGraceUntil !== undefined &&
    now.getTime() < config.previousKeyGraceUntil.getTime()
  ) {
    return { key: config.previousKey, keyVersion, audience: config.audience };
  }
  throw new Error("Delivery session signing key version is outside the rotation grace window");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key)
    .update("telegram-shop:delivery-session:v1\0", "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function deriveDeterministicSessionMaterial(
  key: string,
  idempotencyKey: string,
): { sessionId: string; nonce: string } {
  const digest = createHmac("sha256", key)
    .update("telegram-shop:delivery-session:idempotency:v1\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
  return {
    sessionId: `dsi_${digest.subarray(0, 16).toString("hex")}`,
    nonce: digest.subarray(8, 32).toString("base64url"),
  };
}

function validateConfig(config: DeliverySessionCodecConfig): void {
  if (Buffer.byteLength(config.key, "utf8") < 32) throw new Error("Delivery session key too short");
  if (!Number.isInteger(config.keyVersion) || config.keyVersion < 0 || config.keyVersion > 255) {
    throw new Error("Invalid delivery session key version");
  }
  const previousFields = [
    config.previousKey !== undefined,
    config.previousKeyVersion !== undefined,
    config.previousKeyGraceUntil !== undefined,
  ];
  if (previousFields.some(Boolean) && !previousFields.every(Boolean)) {
    throw new Error("Previous delivery session key grace configuration is incomplete");
  }
  if (config.previousKey !== undefined) {
    const previousVersion = config.previousKeyVersion;
    if (Buffer.byteLength(config.previousKey, "utf8") < 32) {
      throw new Error("Previous delivery session key too short");
    }
    if (
      !Number.isInteger(previousVersion) ||
      previousVersion! < 0 ||
      previousVersion! > 255 ||
      previousVersion! === config.keyVersion
    ) {
      throw new Error("Invalid previous delivery session key version");
    }
    if (
      !(config.previousKeyGraceUntil instanceof Date) ||
      !Number.isFinite(config.previousKeyGraceUntil.getTime())
    ) {
      throw new Error("Invalid previous delivery session key grace deadline");
    }
  }
  if (!/^[a-z0-9:_-]{3,64}$/i.test(config.audience)) {
    throw new Error("Invalid delivery session audience");
  }
}

function isClaims(value: unknown): value is DeliverySessionClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    "audience",
    "bundleId",
    "customerId",
    "expiresAt",
    "keyVersion",
    "nonce",
    "sessionId",
    "telegramUserId",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.bundleId === "string" &&
    typeof v.customerId === "string" &&
    typeof v.telegramUserId === "string" &&
    /^[1-9][0-9]{0,19}$/.test(v.telegramUserId) &&
    typeof v.audience === "string" &&
    typeof v.nonce === "string" &&
    /^[A-Za-z0-9_-]{32}$/.test(v.nonce) &&
    Number.isSafeInteger(v.expiresAt) &&
    Number.isSafeInteger(v.keyVersion)
  );
}
