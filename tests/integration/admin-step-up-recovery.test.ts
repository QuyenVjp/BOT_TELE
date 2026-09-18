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

const hasDocker = await dockerAvailable();
const ADMIN_ID = "123456789";
const TEST_BINDING = {
  actionKey: "discrepancy.resolve",
  resourceType: "Discrepancy",
  resourceId: "discrepancy-test",
  resourceVersion: "1",
  payloadHash: "a".repeat(64),
};
const OPTIONS = { ttlSeconds: 60, lockoutMinutes: 15, maxAttempts: 5 };
const NOW = new Date("2026-03-01T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

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
  if (!hasDocker) return;
  await sql`
    truncate table admin_step_up_recovery_candidate, admin_step_up_attempt,
      admin_step_up_grant, admin_step_up_secret, audit_event
  `.execute(ctx.db);
  vault = createInMemoryVault();
  service = createStepUpService(ctx.db, vault, OPTIONS);
});

async function enroll(): Promise<{ seed: string; vaultRef: string }> {
  await service.enroll({
    adminTelegramUserId: ADMIN_ID,
    issuer: "TIER20 SHOP",
    accountLabel: ADMIN_ID,
  });
  const row = (
    await sql<{ vault_ref: string }>`
      select vault_ref from admin_step_up_secret where admin_telegram_user_id = ${ADMIN_ID}
    `.execute(ctx.db)
  ).rows[0]!;
  return { seed: await vault.reveal(row.vault_ref), vaultRef: row.vault_ref };
}

function wrongCode(seed: string): string {
  const good = generateTotp(seed, NOW_SECONDS);
  const candidate = `${good.slice(0, 5)}${(Number(good[5]) + 1) % 10}`;
  expect(verifyTotpCode({ secretBase32: seed, code: candidate, unixSeconds: NOW_SECONDS })).toBe(
    false,
  );
  return candidate;
}

describe.skipIf(!hasDocker)("secure lost-factor step-up recovery", () => {
  it("keeps the active factor until a valid candidate code verifies", async () => {
    const active = await enroll();
    const initiated = await service.initiateRecovery({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20 SHOP",
      accountLabel: ADMIN_ID,
      now: NOW,
    });
    expect(initiated.otpauthUri).toMatch(/^otpauth:\/\//u);

    const candidate = (
      await sql<{ vault_ref: string }>`
        select vault_ref
        from admin_step_up_recovery_candidate
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    const candidateSeed = await vault.reveal(candidate.vault_ref);

    await expect(
      service.confirmRecovery({
        adminTelegramUserId: ADMIN_ID,
        code: wrongCode(candidateSeed),
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_CODE" });

    const current = (
      await sql<{ vault_ref: string; factor_version: number }>`
        select vault_ref, factor_version
        from admin_step_up_secret
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    expect(current).toEqual({ vault_ref: active.vaultRef, factor_version: 1 });
    expect(initiated.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("serializes recovery failures so concurrent guesses cannot bypass lockout", async () => {
    await enroll();
    await service.initiateRecovery({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20 SHOP",
      accountLabel: ADMIN_ID,
      now: NOW,
    });
    const candidate = (
      await sql<{ vault_ref: string }>`
        select vault_ref
        from admin_step_up_recovery_candidate
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    const candidateSeed = await vault.reveal(candidate.vault_ref);
    const invalidCode = wrongCode(candidateSeed);

    const results = await Promise.all(
      Array.from({ length: OPTIONS.maxAttempts + 2 }, () =>
        service.confirmRecovery({
          adminTelegramUserId: ADMIN_ID,
          code: invalidCode,
          now: NOW,
        }),
      ),
    );
    expect(results.filter((result) => !result.ok && result.code === "INVALID_CODE")).toHaveLength(
      OPTIONS.maxAttempts,
    );
    expect(results.filter((result) => !result.ok && result.code === "LOCKED_OUT")).toHaveLength(2);
    const attempts = (
      await sql<{ count: number }>`
        select count(*)::int as count
        from admin_step_up_attempt
        where admin_telegram_user_id = ${ADMIN_ID}
          and purpose = 'RECOVERY'
      `.execute(ctx.db)
    ).rows[0]!;
    expect(attempts.count).toBe(OPTIONS.maxAttempts);
    const current = (
      await sql<{ vault_ref: string }>`
        select vault_ref
        from admin_step_up_secret
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    expect(current.vault_ref).not.toBe(candidate.vault_ref);
  });

  it("promotes the candidate atomically, revokes grants, and rejects the old factor", async () => {
    const active = await enroll();
    const activeCode = generateTotp(active.seed, NOW_SECONDS);
    await expect(
      service.verify({
        ...TEST_BINDING,
        adminTelegramUserId: ADMIN_ID,
        category: "PAYMENT_OVERRIDE",
        code: activeCode,
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: true });

    await service.initiateRecovery({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20 SHOP",
      accountLabel: ADMIN_ID,
      now: NOW,
    });
    const candidate = (
      await sql<{ vault_ref: string }>`
        select vault_ref
        from admin_step_up_recovery_candidate
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    const candidateSeed = await vault.reveal(candidate.vault_ref);
    const candidateCode = generateTotp(candidateSeed, NOW_SECONDS);

    await expect(
      service.confirmRecovery({ adminTelegramUserId: ADMIN_ID, code: candidateCode, now: NOW }),
    ).resolves.toMatchObject({ ok: true, revokedGrantCount: 1 });

    const current = (
      await sql<{ vault_ref: string; factor_version: number }>`
        select vault_ref, factor_version
        from admin_step_up_secret
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    expect(current.vault_ref).toBe(candidate.vault_ref);
    expect(current.factor_version).toBe(2);

    const revoked = (
      await sql<{ revoked_at: string | null }>`
        select revoked_at::text as revoked_at
        from admin_step_up_grant
        where admin_telegram_user_id = ${ADMIN_ID}
      `.execute(ctx.db)
    ).rows[0]!;
    expect(revoked.revoked_at).not.toBeNull();

    await expect(
      service.verify({
        ...TEST_BINDING,
        adminTelegramUserId: ADMIN_ID,
        category: "PAYMENT_OVERRIDE",
        code: activeCode,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_CODE" });

    await expect(
      service.verify({
        ...TEST_BINDING,
        adminTelegramUserId: ADMIN_ID,
        category: "PAYMENT_OVERRIDE",
        code: candidateCode,
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: true });

    const audit = (
      await sql<{ metadata_redacted: Record<string, unknown>; reason: string }>`
        select metadata_redacted, reason
        from audit_event
        where action = 'admin.step_up.recovered'
        order by occurred_at desc
        limit 1
      `.execute(ctx.db)
    ).rows[0]!;
    expect(audit.reason).toContain("lost authenticator");
    expect(JSON.stringify(audit.metadata_redacted)).not.toContain(active.seed);
    expect(JSON.stringify(audit.metadata_redacted)).not.toContain(candidateSeed);
    expect(JSON.stringify(audit.metadata_redacted)).not.toContain(candidateCode);
  });

  it("leaves the active factor usable when recovery is abandoned", async () => {
    const active = await enroll();
    await service.initiateRecovery({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20 SHOP",
      accountLabel: ADMIN_ID,
      now: NOW,
    });

    await expect(
      service.verify({
        ...TEST_BINDING,
        adminTelegramUserId: ADMIN_ID,
        category: "PAYMENT_OVERRIDE",
        code: generateTotp(active.seed, NOW_SECONDS),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps replace gated by the current factor", async () => {
    const active = await enroll();
    await expect(
      service.replace({
        adminTelegramUserId: ADMIN_ID,
        issuer: "TIER20 SHOP",
        accountLabel: ADMIN_ID,
        currentCode: wrongCode(active.seed),
        now: NOW,
      }),
    ).rejects.toThrow(/current step-up code/u);

    const replaced = await service.replace({
      adminTelegramUserId: ADMIN_ID,
      issuer: "TIER20 SHOP",
      accountLabel: ADMIN_ID,
      currentCode: generateTotp(active.seed, NOW_SECONDS),
      now: NOW,
    });
    const replacedSeed = new URL(replaced.otpauthUri).searchParams.get("secret");
    expect(replacedSeed).toBeTruthy();
    expect(replacedSeed).not.toBe(active.seed);
  });
});
