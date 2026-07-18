import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { listAuditEvents } from "../../src/modules/identity/audit.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const ROOT_ID = 123456789;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`drop trigger if exists reject_atomic_admin_audit on audit_event`.execute(ctx.db);
  await sql`drop function if exists reject_atomic_admin_audit()`.execute(ctx.db);
  await sql`
    truncate table admin_confirmation, audit_event, discrepancy, channel_identity, customer cascade
  `.execute(ctx.db);
});

async function seed(): Promise<{ rootChannelIdentityId: string; discrepancyId: string }> {
  const customerId = newId();
  const rootChannelIdentityId = newId();
  const discrepancyId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${customerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`
    insert into discrepancy (id, type, status, reason, owner)
    values (${discrepancyId}, 'UNDERPAYMENT', 'OPEN', 'short by 1000', 'ops')
  `.execute(ctx.db);
  return { rootChannelIdentityId, discrepancyId };
}

function callbacks(rootChannelIdentityId: string) {
  return createAdminCallbacks({
    db: ctx.db,
    rootConfig: { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" },
    rootChannelIdentityId,
    confirmation: createAdminConfirmation(ctx.db),
  });
}

const actor = {
  numericUserId: ROOT_ID,
  chatType: "private" as const,
  observedUsername: "Quyenvjp",
};

describe("durable AdminConfirmation (T163/T164)", () => {
  it("survives a process-composition restart with an allowlisted command and redacted payload", async () => {
    const seeded = await seed();
    const beforeRestart = callbacks(seeded.rootChannelIdentityId);
    const requested = await beforeRestart.handle({
      command: "discrepancy.resolve",
      actor,
      targetId: seeded.discrepancyId,
      reason: "Verified manual settlement",
      resolutionCode: "MANUAL_ACCEPT",
      correlationId: "restart-action",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    const persisted = await sql<{
      allowlisted_command_ref: string | null;
      payload_redacted: Record<string, unknown>;
    }>`
      select allowlisted_command_ref, payload_redacted
      from admin_confirmation where id = ${requested.confirmationId}
    `.execute(ctx.db);
    expect(persisted.rows[0]).toMatchObject({
      allowlisted_command_ref: "discrepancy.resolve",
      payload_redacted: {
        targetId: seeded.discrepancyId,
        reason: "Verified manual settlement",
        resolutionCode: "MANUAL_ACCEPT",
        actorId: String(ROOT_ID),
      },
    });

    const afterRestart = callbacks(seeded.rootChannelIdentityId);
    const competingRestart = callbacks(seeded.rootChannelIdentityId);
    const [confirmed, replayedConcurrently] = await Promise.all([
      afterRestart.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor,
        correlationId: "restart-confirm",
      }),
      competingRestart.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor,
        correlationId: "restart-concurrent-replay",
      }),
    ]);
    expect(confirmed).toEqual({ ok: true });
    expect(replayedConcurrently).toEqual({ ok: true });

    const discrepancy = await sql<{ status: string; resolution_code: string | null }>`
      select status, resolution_code from discrepancy where id = ${seeded.discrepancyId}
    `.execute(ctx.db);
    expect(discrepancy.rows[0]).toEqual({
      status: "RESOLVED",
      resolution_code: "MANUAL_ACCEPT",
    });

    const wrongChallenge = await afterRestart.confirm({
      confirmationId: requested.confirmationId,
      challenge: `${requested.challenge}x`,
      actor,
      correlationId: "restart-wrong-replay",
    });
    expect(wrongChallenge).toMatchObject({ ok: false, code: "CONFIRM_FAILED" });

    const replay = await afterRestart.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor,
      correlationId: "restart-replay",
    });
    expect(replay).toEqual({ ok: true });
    const audits = await listAuditEvents(ctx.db, {
      targetType: "Discrepancy",
      targetId: seeded.discrepancyId,
    });
    expect(audits.filter((event) => event.action === "discrepancy.resolve")).toHaveLength(1);
  });

  it("rolls back confirmation consume and domain mutation when the audit append fails", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded.rootChannelIdentityId);
    const requested = await admin.handle({
      command: "discrepancy.resolve",
      actor,
      targetId: seeded.discrepancyId,
      reason: "Atomic action",
      resolutionCode: "MANUAL_ACCEPT",
      correlationId: "atomic-action",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    await sql`
      create function reject_atomic_admin_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'discrepancy.resolve' then
          raise exception 'forced audit failure';
        end if;
        return new;
      end
      $$
    `.execute(ctx.db);
    await sql`
      create trigger reject_atomic_admin_audit before insert on audit_event
      for each row execute function reject_atomic_admin_audit()
    `.execute(ctx.db);

    await expect(
      admin.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor,
        correlationId: "atomic-confirm",
      }),
    ).rejects.toThrow(/forced audit failure/i);

    const afterFailure = await sql<{ status: string; confirmation_status: string }>`
      select d.status, c.status as confirmation_status
      from discrepancy d cross join admin_confirmation c
      where d.id = ${seeded.discrepancyId} and c.id = ${requested.confirmationId}
    `.execute(ctx.db);
    expect(afterFailure.rows[0]).toEqual({ status: "OPEN", confirmation_status: "CREATED" });

    await sql`drop trigger reject_atomic_admin_audit on audit_event`.execute(ctx.db);
    await sql`drop function reject_atomic_admin_audit()`.execute(ctx.db);

    const retry = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor,
      correlationId: "atomic-retry",
    });
    expect(retry).toEqual({ ok: true });

    const audits = await listAuditEvents(ctx.db, {
      targetType: "Discrepancy",
      targetId: seeded.discrepancyId,
    });
    expect(audits.filter((event) => event.action === "discrepancy.resolve")).toHaveLength(1);
  });

  it("fails closed when the persisted payload no longer matches its action fingerprint", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded.rootChannelIdentityId);
    const requested = await admin.handle({
      command: "discrepancy.resolve",
      actor,
      targetId: seeded.discrepancyId,
      reason: "Bound action",
      resolutionCode: "MANUAL_ACCEPT",
      correlationId: "binding-action",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    await sql`
      update admin_confirmation
      set payload_redacted = jsonb_set(payload_redacted, '{targetId}', ${JSON.stringify(newId())}::jsonb)
      where id = ${requested.confirmationId}
    `.execute(ctx.db);

    const confirmed = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor,
      correlationId: "binding-confirm",
    });
    expect(confirmed).toMatchObject({ ok: false, code: "CONFIRM_FAILED" });

    const unchanged = await sql<{ discrepancy_status: string; confirmation_status: string }>`
      select d.status as discrepancy_status, c.status as confirmation_status
      from discrepancy d cross join admin_confirmation c
      where d.id = ${seeded.discrepancyId} and c.id = ${requested.confirmationId}
    `.execute(ctx.db);
    expect(unchanged.rows[0]).toEqual({
      discrepancy_status: "OPEN",
      confirmation_status: "CREATED",
    });
  });
});
