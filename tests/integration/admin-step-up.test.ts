import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  createStepUpService,
  generateTotp,
  verifyTotpCode,
  type StepUpService,
} from "../../src/modules/identity/step-up.js";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T195 — durable step-up state (THREAT_MODEL SEC-002).
 *
 * The seed stays behind the vault port; the database holds a reference, the
 * append-only attempt log, and single-use category-bound grants. Everything here
 * runs against a real PostgreSQL so the trigger and CHECK constraints are part of
 * the evidence, not just the TypeScript shape.
 */

const hasDocker = await dockerAvailable();
const ADMIN_ID = "123456789";
const TTL_SECONDS = 60;
const MIGRATION_FILE = "064_admin_step_up.sql";
let ctx: PgTestContext;
let vault: Vault;
let service: StepUpService;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`truncate table admin_step_up_attempt, admin_step_up_grant, admin_step_up_secret, audit_event`.execute(
    ctx.db,
  );
  vault = createInMemoryVault();
  service = createStepUpService(ctx.db, vault, {
    ttlSeconds: TTL_SECONDS,
    lockoutMinutes: 15,
    maxAttempts: 5,
  });
});

async function enroll(): Promise<{ seed: string; vaultRef: string; otpauthUri: string }> {
  const { otpauthUri } = await service.enroll({
    adminTelegramUserId: ADMIN_ID,
    issuer: "TIER20 SHOP",
    accountLabel: ADMIN_ID,
  });
  const rows = await sql<{ vault_ref: string }>`
    select vault_ref from admin_step_up_secret where admin_telegram_user_id = ${ADMIN_ID}
  `.execute(ctx.db);
  const vaultRef = rows.rows[0]!.vault_ref;
  return { seed: await vault.reveal(vaultRef), vaultRef, otpauthUri };
}

function codeAt(seed: string, unixSeconds: number): string {
  const code = generateTotp(seed, unixSeconds);
  expect(code).toHaveLength(6);
  return code;
}

/** A code that is guaranteed not to verify at `unixSeconds`. */
function wrongCodeAt(seed: string, unixSeconds: number): string {
  const good = codeAt(seed, unixSeconds);
  const flipped = `${good.slice(0, 5)}${(Number(good[5]) + 1) % 10}`;
  expect(verifyTotpCode({ secretBase32: seed, code: flipped, unixSeconds })).toBe(false);
  return flipped;
}

const NOW = new Date("2026-03-01T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

describe.skipIf(!hasDocker)("admin step-up service", () => {
  it("enrolls into the vault and persists only a reference", async () => {
    const { seed, vaultRef, otpauthUri } = await enroll();

    expect(await service.isEnrolled(ADMIN_ID)).toBe(true);
    expect(await service.isEnrolled("999")).toBe(false);
    expect(vaultRef.startsWith("vault:")).toBe(true);
    expect(vaultRef).not.toContain(seed);
    expect(otpauthUri).toContain(encodeURIComponent(seed));
    expect(seed).toHaveLength(32); // 20 bytes → 32 unpadded base32 characters

    const stored = await sql<{ secret_text: string }>`
      select concat_ws('|', admin_telegram_user_id, vault_ref) as secret_text
      from admin_step_up_secret
    `.execute(ctx.db);
    for (const row of stored.rows) {
      expect(row.secret_text).not.toContain(seed);
      expect(row.secret_text).not.toContain(seed.toLowerCase());
    }
    // Rotating replaces the reference; the old seed is unreachable.
    const rotated = await enroll();
    expect(rotated.vaultRef).toBe(vaultRef); // stable per-admin key, no accumulation
    expect(rotated.seed).not.toBe(seed);
  });

  it("issues a single-use grant and refuses the second consume", async () => {
    const { seed } = await enroll();
    const code = codeAt(seed, NOW_SECONDS);

    const verified = await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code,
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.grant.adminTelegramUserId).toBe(ADMIN_ID);
    expect(verified.grant.category).toBe("REFUND");
    expect(verified.grant.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1000));

    expect(
      await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now: NOW }),
    ).toEqual({ ok: true });
    expect(
      await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now: NOW }),
    ).toEqual({ ok: false, code: "NOT_GRANTED" });

    const consumed = await sql<{ consumed_at: string | null }>`
      select consumed_at from admin_step_up_grant where admin_telegram_user_id = ${ADMIN_ID}
    `.execute(ctx.db);
    expect(consumed.rows).toHaveLength(1);
    expect(consumed.rows[0]!.consumed_at).not.toBeNull();
  });

  it("binds a grant to exactly one category", async () => {
    const { seed } = await enroll();
    const granted = await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code: codeAt(seed, NOW_SECONDS),
      now: NOW,
    });
    expect(granted.ok).toBe(true);

    expect(
      await service.consume({ adminTelegramUserId: ADMIN_ID, category: "BROADCAST", now: NOW }),
    ).toEqual({ ok: false, code: "NOT_GRANTED" });
    // The REFUND grant survived the cross-category attempt.
    expect(
      await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now: NOW }),
    ).toEqual({ ok: true });
  });

  it("refuses a grant once its TTL has elapsed", async () => {
    const { seed } = await enroll();
    const issued = await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "WALLET_ADJUSTMENT",
      code: codeAt(seed, NOW_SECONDS),
      now: NOW,
    });
    expect(issued.ok).toBe(true);

    const afterExpiry = new Date(NOW.getTime() + TTL_SECONDS * 1000 + 1);
    expect(
      await service.consume({
        adminTelegramUserId: ADMIN_ID,
        category: "WALLET_ADJUSTMENT",
        now: afterExpiry,
      }),
    ).toEqual({ ok: false, code: "GRANT_EXPIRED" });
    // A refused-but-unexpired grant at an earlier instant is a different
    // question; the row stays unconsumed so the audit trail keeps the reason.
    const rows = await sql<{ consumed_at: string | null }>`
      select consumed_at from admin_step_up_grant where admin_telegram_user_id = ${ADMIN_ID}
    `.execute(ctx.db);
    expect(rows.rows[0]!.consumed_at).toBeNull();
  });

  it("locks out after five failed attempts even with a correct code", async () => {
    const { seed } = await enroll();
    const correct = codeAt(seed, NOW_SECONDS);
    const wrong = wrongCodeAt(seed, NOW_SECONDS);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await service.verify({
        adminTelegramUserId: ADMIN_ID,
        category: "REFUND",
        code: wrong,
        now: NOW,
      });
      expect(result).toEqual({ ok: false, code: "INVALID_CODE" });
    }

    expect(
      await service.verify({
        adminTelegramUserId: ADMIN_ID,
        category: "REFUND",
        code: correct,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "LOCKED_OUT" });
    expect(
      await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now: NOW }),
    ).toEqual({ ok: false, code: "NOT_GRANTED" });

    // The counter is durable: a brand-new service instance sees the same lockout.
    const restarted = createStepUpService(ctx.db, vault, {
      ttlSeconds: TTL_SECONDS,
      lockoutMinutes: 15,
      maxAttempts: 5,
    });
    expect(
      await restarted.verify({
        adminTelegramUserId: ADMIN_ID,
        category: "REFUND",
        code: correct,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "LOCKED_OUT" });

    // Past the lockout window the admin may try again.
    const afterWindow = new Date(NOW.getTime() + 16 * 60_000);
    expect(
      await restarted
        .verify({
          adminTelegramUserId: ADMIN_ID,
          category: "REFUND",
          code: codeAt(seed, Math.floor(afterWindow.getTime() / 1000)),
          now: afterWindow,
        })
        .then((result) => result.ok),
    ).toBe(true);
  });

  it("rejects a correct code from an admin who never enrolled", async () => {
    const { seed } = await enroll();
    expect(
      await service.verify({
        adminTelegramUserId: "987654321",
        category: "BROADCAST",
        code: codeAt(seed, NOW_SECONDS),
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "NOT_ENROLLED" });
    expect(await service.isEnrolled("987654321")).toBe(false);
  });

  it("audits every attempt with only the category and the outcome", async () => {
    const { seed } = await enroll();
    const code = codeAt(seed, NOW_SECONDS);
    await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code: wrongCodeAt(seed, NOW_SECONDS),
      now: NOW,
    });
    await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code,
      now: NOW,
    });
    await service.consume({ adminTelegramUserId: ADMIN_ID, category: "BROADCAST", now: NOW });
    await service.consume({ adminTelegramUserId: ADMIN_ID, category: "REFUND", now: NOW });

    const events = await sql<{
      action: string;
      actor_type: string;
      actor_id: string;
      metadata_redacted: Record<string, unknown>;
      reason: string;
    }>`
      select action, actor_type, actor_id, metadata_redacted, reason
      from audit_event
      where target_type = 'AdminStepUp' and target_id = ${ADMIN_ID}
      order by occurred_at asc, id asc
    `.execute(ctx.db);

    expect(events.rows.map((row) => row.action)).toEqual([
      "admin.step_up.enrolled",
      "admin.step_up.denied",
      "admin.step_up.verified",
      "admin.step_up.denied",
      "admin.step_up.consumed",
    ]);
    for (const row of events.rows) {
      expect(row.actor_type).toBe("ROOT_ADMIN");
      expect(row.actor_id).toBe(ADMIN_ID);
      // Only the category and the failure code are recorded — never the seed or the code.
      const keys = Object.keys(row.metadata_redacted).sort();
      expect(keys.every((key) => key === "category" || key === "code")).toBe(true);
    }
    expect(events.rows[1]!.metadata_redacted).toEqual({ category: "REFUND", code: "INVALID_CODE" });
    expect(events.rows[3]!.metadata_redacted).toEqual({
      category: "BROADCAST",
      code: "NOT_GRANTED",
    });

    const blob = JSON.stringify(events.rows);
    expect(blob).not.toContain(seed);
    expect(blob).not.toContain(code);
  });

  it("keeps the attempt log append-only", async () => {
    const { seed } = await enroll();
    await service.verify({
      adminTelegramUserId: ADMIN_ID,
      category: "REFUND",
      code: wrongCodeAt(seed, NOW_SECONDS),
      now: NOW,
    });

    const attempts = await sql<{ id: string }>`select id from admin_step_up_attempt`.execute(
      ctx.db,
    );
    expect(attempts.rows).toHaveLength(1);
    const attemptId = attempts.rows[0]!.id;

    await expect(
      sql`update admin_step_up_attempt set succeeded = true where id = ${attemptId}`.execute(
        ctx.db,
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      sql`delete from admin_step_up_attempt where id = ${attemptId}`.execute(ctx.db),
    ).rejects.toThrow(/append-only/u);

    // A grant window can never be inverted, and the category CHECK is enforced.
    await expect(
      sql`
        insert into admin_step_up_grant
          (id, admin_telegram_user_id, category, issued_at, expires_at)
        values ('bad-window', ${ADMIN_ID}, 'REFUND', ${NOW.toISOString()}, ${NOW.toISOString()})
      `.execute(ctx.db),
    ).rejects.toThrow(/admin_step_up_grant_window_ck/u);
    await expect(
      sql`
        insert into admin_step_up_grant
          (id, admin_telegram_user_id, category, expires_at)
        values ('bad-category', ${ADMIN_ID}, 'MONEY_PRINTING', now() + interval '5 minutes')
      `.execute(ctx.db),
    ).rejects.toThrow(/category/u);
  });

  it("re-applies the migration as a no-op and keeps the guard armed", async () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "infrastructure",
        "db",
        "migrations",
        MIGRATION_FILE,
      ),
      "utf8",
    );
    await sql.raw(migration).execute(ctx.db);
    await sql.raw(migration).execute(ctx.db);

    const guard = await sql<{ count: number }>`
      select count(*)::int as count from pg_trigger
      where tgname = 'admin_step_up_attempt_append_only' and not tgisinternal
    `.execute(ctx.db);
    expect(guard.rows[0]!.count).toBe(1);

    await sql`
      insert into admin_step_up_attempt (id, admin_telegram_user_id, succeeded)
      values ('guard-probe', ${ADMIN_ID}, false)
    `.execute(ctx.db);
    await expect(
      sql`delete from admin_step_up_attempt where id = 'guard-probe'`.execute(ctx.db),
    ).rejects.toThrow(/append-only/u);
  });
});
