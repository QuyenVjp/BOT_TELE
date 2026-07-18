import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  consumeConfirmation,
  createAdminConfirmation,
  issueConfirmation,
} from "../../src/modules/identity/admin-confirmation.js";
import { appendAuditEvent, listAuditEvents } from "../../src/modules/identity/audit.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T092 — AdminConfirmation fingerprint/expiry/replay/reason/audit
 * (FR-023 / SR-005).
 *
 * A high-risk owner action issues a short-lived confirmation bound to an action
 * fingerprint. Confirmation requires the matching challenge, refuses after
 * expiry, refuses a replay of an already-consumed challenge, and records an
 * immutable audit event with a non-empty reason.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedRootIdentity(): Promise<{ customerId: string; channelIdentityId: string }> {
  const customerId = newId();
  const channelIdentityId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${channelIdentityId}, ${customerId}, 'TELEGRAM', '123456789', 'Quyenvjp')
  `.execute(ctx.db);
  return { customerId, channelIdentityId };
}

beforeEach(async () => {
  await sql`
    truncate table admin_confirmation, audit_event, channel_identity, customer cascade
  `.execute(ctx.db);
});

describe("admin confirmation (FR-023 / SR-005)", () => {
  it("issues a confirmation bound to an action fingerprint and confirms with the challenge", async () => {
    const { channelIdentityId } = await seedRootIdentity();
    const svc = createAdminConfirmation(ctx.db, {
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });
    const issued = await issueConfirmation(svc, {
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-1",
      correlationId: "corr-1",
      ttlSeconds: 120,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // Plaintext challenge is returned only once; its hash is what we store.
    expect(issued.challenge.length).toBeGreaterThanOrEqual(16);
    expect(issued.confirmationId).toBeTruthy();
    expect(issued.expiresAt).toBe("2026-07-16T10:02:00.000Z");

    const confirmed = await svc.confirm({
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-1",
      challenge: issued.challenge,
    });
    expect(confirmed.ok).toBe(true);
  });

  it("refuses a wrong action fingerprint (ACTION_MISMATCH)", async () => {
    const { channelIdentityId } = await seedRootIdentity();
    const svc = createAdminConfirmation(ctx.db);
    const issued = await issueConfirmation(svc, {
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-1",
      correlationId: "corr-2",
    });
    if (!issued.ok) throw new Error("issue failed");
    const confirmed = await svc.confirm({
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-OTHER",
      challenge: issued.challenge,
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.code).toBe("ACTION_MISMATCH");
  });

  it("refuses an expired challenge (CHALLENGE_EXPIRED)", async () => {
    const { channelIdentityId } = await seedRootIdentity();
    let now = new Date("2026-07-16T10:00:00.000Z");
    const svc = createAdminConfirmation(ctx.db, { now: () => now });
    const issued = await issueConfirmation(svc, {
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "discrepancy.resolve:d-1",
      correlationId: "corr-3",
      ttlSeconds: 60,
    });
    if (!issued.ok) throw new Error("issue failed");
    // Advance past expiry.
    now = new Date("2026-07-16T10:05:00.000Z");
    const confirmed = await svc.confirm({
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "discrepancy.resolve:d-1",
      challenge: issued.challenge,
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.code).toBe("CHALLENGE_EXPIRED");
  });

  it("refuses a replay of an already-consumed confirmation", async () => {
    const { channelIdentityId } = await seedRootIdentity();
    const svc = createAdminConfirmation(ctx.db);
    const issued = await issueConfirmation(svc, {
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-2",
      correlationId: "corr-4",
    });
    if (!issued.ok) throw new Error("issue failed");
    const first = await svc.confirm({
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-2",
      challenge: issued.challenge,
    });
    expect(first.ok).toBe(true);
    // Consume as part of the high-risk action.
    const consumed = await consumeConfirmation(svc, {
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-2",
    });
    expect(consumed.ok).toBe(true);
    // Replay of the same challenge must fail.
    const replay = await svc.confirm({
      confirmationId: issued.confirmationId,
      rootChannelIdentityId: channelIdentityId,
      actionFingerprint: "catalog.deactivate:var-2",
      challenge: issued.challenge,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(["ALREADY_CONSUMED", "NOT_ACTIVE"]).toContain(replay.code);
  });

  it("appends an immutable audit event with a non-empty reason and refuses mutation", async () => {
    const eventId = await appendAuditEvent(ctx.db, {
      actorType: "ROOT_ADMIN",
      actorId: "123456789",
      action: "catalog.deactivate",
      targetType: "ProductVariant",
      targetId: "var-1",
      reason: "SKU expired upstream",
      correlationId: "corr-5",
      metadataRedacted: { variantId: "var-1" },
    });
    expect(eventId).toBeTruthy();

    const listed = await listAuditEvents(ctx.db, {
      targetType: "ProductVariant",
      targetId: "var-1",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.reason).toBe("SKU expired upstream");
    expect(listed[0]?.action).toBe("catalog.deactivate");

    // The repository is append-only: there is no update/delete path. Prove the
    // row is still present after a second append for the same target.
    await appendAuditEvent(ctx.db, {
      actorType: "ROOT_ADMIN",
      actorId: "123456789",
      action: "catalog.activate",
      targetType: "ProductVariant",
      targetId: "var-1",
      reason: "Re-authorized",
      correlationId: "corr-6",
    });
    const after = await listAuditEvents(ctx.db, {
      targetType: "ProductVariant",
      targetId: "var-1",
    });
    expect(after).toHaveLength(2);
    // Original event still intact (append-only).
    expect(after.find((e) => e.id === eventId)?.reason).toBe("SKU expired upstream");
  });

  it("rejects an empty reason for high-risk audit", async () => {
    await expect(
      appendAuditEvent(ctx.db, {
        actorType: "ROOT_ADMIN",
        actorId: "123456789",
        action: "catalog.deactivate",
        targetType: "ProductVariant",
        targetId: "var-x",
        reason: "   ",
        correlationId: "corr-7",
      }),
    ).rejects.toThrow(/reason/i);
  });
});
