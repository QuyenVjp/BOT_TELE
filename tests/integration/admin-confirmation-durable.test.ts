import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import {
  createAdminConfirmation,
  DURABLE_ADMIN_COMMAND_REFS,
  isGenericDurableAdminCommandRef,
} from "../../src/modules/identity/admin-confirmation.js";
import {
  getProductPublicationReadiness,
  registerResaleEvidence,
} from "../../src/modules/catalog/publication.js";
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
    truncate table admin_confirmation, audit_event, discrepancy, channel_identity, customer,
      product_variant, product, category, resale_evidence, group_commerce_settings cascade
  `.execute(ctx.db);
  await sql`insert into group_commerce_settings (id) values ('main')`.execute(ctx.db);
});

/**
 * A variant carrying one ACTIVE evidence row: the two opaque facts the revocation route
 * travels on. The fixture registers evidence through the real path so it cannot drift from
 * what the adapter binds.
 */
async function seedEvidence(): Promise<{
  productId: string;
  variantId: string;
  evidenceId: string;
  variantVersion: number;
}> {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'AI', ${`ai-${categoryId}`}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived)
    values (${productId}, ${categoryId}, 'GPT Plus', ${`gpt-${productId}`}, true, 1, false, false)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       fulfillment_type, warranty_days, stock_policy, is_active, sort_order)
    values
      (${variantId}, ${productId}, ${`GPT-${variantId}`}, '1 tháng', 250000, 'P1M', 'CREDENTIAL',
       'STOCK_ACCOUNT', 30, 'LOCAL_ONLY', true, 1)
  `.execute(ctx.db);
  const registration = await registerResaleEvidence(ctx.db, {
    variantId,
    source: "OWNER_ATTESTATION",
    reference: `owner-${variantId}`,
    summary: "Owner verified the supplier resale authorization.",
    requestId: newId(),
    actorId: String(ROOT_ID),
    reason: "Fixture evidence for the revocation adapter test",
    correlationId: "fixture-evidence",
  });
  if (!registration.ok) throw new Error(registration.message);
  return {
    productId,
    variantId,
    evidenceId: registration.evidenceId,
    variantVersion: registration.variantVersion,
  };
}

/** The per-verb fixture a durable command needs before it can issue a challenge. */
function durableCommandFixture(command: string): {
  input?: string;
  expectedVersion?: number | string;
} {
  if (command === "catalog.evidence.register") {
    return { input: "OWNER_ATTESTATION|owner-reference-probe|Synthetic evidence probe" };
  }
  if (command === "catalog.evidence.revoke") return { input: newId(), expectedVersion: 1 };
  if (command === "fulfillment.reconcile") return { expectedVersion: 1 };
  if (command === "group.publication.disable") {
    return { expectedVersion: "synthetic-group-publication-version" };
  }
  return {};
}

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
      expectedVersion: 1,
      reason: "Verified manual settlement",
      resolutionCode: "MANUAL_SETTLE",
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
        resolutionCode: "MANUAL_SETTLE",
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
      resolution_code: "MANUAL_SETTLE",
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
      expectedVersion: 1,
      reason: "Atomic action",
      resolutionCode: "MANUAL_SETTLE",
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
      expectedVersion: 1,
      reason: "Bound action",
      resolutionCode: "MANUAL_SETTLE",
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

  it("issues a confirmation for every durable command ref the database allows", async () => {
    const seeded = await seed();
    const admin = callbacks(seeded.rootChannelIdentityId);

    for (const command of DURABLE_ADMIN_COMMAND_REFS.filter(isGenericDurableAdminCommandRef)) {
      const issued = await admin.handle({
        command,
        actor,
        targetId: command === "group.publication.disable" ? "main" : newId(),
        reason: `Synthetic vocabulary probe for ${command}`,
        correlationId: `vocabulary-${command}`,
        ...durableCommandFixture(command),
      });
      expect(issued, command).toMatchObject({ ok: true, needsConfirmation: true });
      if (!issued.ok || !issued.needsConfirmation) return;

      const persisted = await sql<{ allowlisted_command_ref: string | null }>`
        select allowlisted_command_ref from admin_confirmation where id = ${issued.confirmationId}
      `.execute(ctx.db);
      expect(persisted.rows[0]?.allowlisted_command_ref, command).toBe(command);
    }
  });
  it("uses a fresh confirmation id for each transition from one edited screen", async () => {
    const seeded = await seed();
    await sql`delete from store_mode_transition`.execute(ctx.db);
    await sql`
      insert into store_control (id, status, updated_at, updated_by, version)
      values ('main', 'CLOSED', now(), 'test', 1)
      on conflict (id) do update
        set status = 'CLOSED', updated_at = now(), updated_by = 'test',
            version = 1, last_request_id = null
    `.execute(ctx.db);
    const admin = callbacks(seeded.rootChannelIdentityId);
    const first = await admin.handle({
      command: "store.test",
      actor,
      targetId: "main",
      expectedVersion: 1,
      reason: "Enter TEST from the same admin screen",
      correlationId: "telegram:edited-screen",
    });
    expect(first).toMatchObject({ ok: true, needsConfirmation: true });
    if (!first.ok || !first.needsConfirmation) return;
    await expect(
      admin.confirm({
        confirmationId: first.confirmationId,
        challenge: first.challenge,
        actor,
        correlationId: "telegram:edited-screen",
      }),
    ).resolves.toEqual({ ok: true });

    const second = await admin.handle({
      command: "store.close",
      actor,
      targetId: "main",
      expectedVersion: 2,
      reason: "Close TEST from the same edited screen",
      correlationId: "telegram:edited-screen",
    });
    expect(second).toMatchObject({ ok: true, needsConfirmation: true });
    if (!second.ok || !second.needsConfirmation) return;
    expect(second.confirmationId).not.toBe(first.confirmationId);
    await expect(
      admin.confirm({
        confirmationId: second.confirmationId,
        challenge: second.challenge,
        actor,
        correlationId: "telegram:edited-screen",
      }),
    ).resolves.toEqual({ ok: true });

    const control = await sql<{ status: string; version: number }>`
      select status, version from store_control where id = 'main'
    `.execute(ctx.db);
    expect(control.rows[0]).toEqual({ status: "CLOSED", version: 3 });
  });

  it("preserves a publication readiness refusal through durable confirmation", async () => {
    const seeded = await seed();
    const fixture = await seedEvidence();
    const admin = callbacks(seeded.rootChannelIdentityId);
    await sql`
      insert into digital_asset
        (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values
        (${newId()}, ${fixture.variantId}, 'OWNER_IMPORT', 'vault:fixture',
         ${newId()}, 'AVAILABLE')
    `.execute(ctx.db);
    await sql`
      update store_control
         set status = 'CLOSED', version = 1, updated_at = now(), updated_by = 'test',
             last_request_id = null
       where id = 'main'
    `.execute(ctx.db);

    const readiness = await getProductPublicationReadiness(ctx.db, fixture.productId);
    expect(readiness?.canPublish).toBe(true);
    const requested = await admin.handle({
      command: "catalog.publish",
      actor,
      targetId: fixture.productId,
      expectedVersion: readiness!.publicationVersion,
      reason: "Publish verified GPT Plus",
      correlationId: "publish-readiness-refusal",
    });
    expect(requested).toMatchObject({ ok: true, needsConfirmation: true });
    if (!requested.ok || !requested.needsConfirmation) return;

    await sql`
      update store_control
         set status = 'TEST', version = version + 1, updated_at = now(), updated_by = 'test'
       where id = 'main'
    `.execute(ctx.db);
    const refused = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor,
      correlationId: "publish-readiness-refusal-confirm",
    });
    expect(refused).toMatchObject({ ok: false, code: "NOT_READY" });
    expect(
      await sql<{ is_test: boolean }>`
        select is_test from product where id = ${fixture.productId}
      `.execute(ctx.db),
    ).toEqual({ rows: [{ is_test: false }] });
  });

  it("revokes evidence through the durable confirmation without rewriting the evidence facts", async () => {
    const seeded = await seed();
    const fixture = await seedEvidence();
    const admin = callbacks(seeded.rootChannelIdentityId);

    // The verb can never be issued without the evidence id and a numeric variant version.
    const unfixed = await admin.handle({
      command: "catalog.evidence.revoke",
      actor,
      targetId: fixture.variantId,
      expectedVersion: fixture.variantVersion,
      reason: "Thiếu bằng chứng",
      correlationId: "revoke-invalid",
    });
    expect(unfixed).toMatchObject({ ok: false, code: "INVALID_REASON" });

    const requested = await admin.handle({
      command: "catalog.evidence.revoke",
      actor,
      targetId: fixture.variantId,
      input: fixture.evidenceId,
      expectedVersion: fixture.variantVersion,
      reason: "Nhà cung cấp rút uỷ quyền bán lại",
      correlationId: "telegram:revoke",
    });
    expect(requested).toMatchObject({ ok: true, needsConfirmation: true });
    if (!requested.ok || !requested.needsConfirmation) return;

    // The variant moving under the challenge must refuse, not revoke a stale snapshot.
    // The durable action preserves the domain refusal instead of collapsing it to
    // the generic missing-target response.
    await sql`
      update product_variant set version = version + 1 where id = ${fixture.variantId}
    `.execute(ctx.db);
    const stale = await admin.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor,
      correlationId: "telegram:revoke-stale",
    });
    expect(stale).toMatchObject({ ok: false, code: "ACTION_REFUSED" });
    const refused = await sql<{ status: string; revoked_at: string | null }>`
      select status, revoked_at::text as revoked_at
        from resale_evidence where id = ${fixture.evidenceId}
    `.execute(ctx.db);
    expect(refused.rows[0]).toEqual({ status: "ACTIVE", revoked_at: null });

    await sql`
      update product_variant set version = ${fixture.variantVersion} where id = ${fixture.variantId}
    `.execute(ctx.db);
    const retried = await admin.handle({
      command: "catalog.evidence.revoke",
      actor,
      targetId: fixture.variantId,
      input: fixture.evidenceId,
      expectedVersion: fixture.variantVersion,
      reason: "Nhà cung cấp rút uỷ quyền bán lại",
      correlationId: "telegram:revoke-retry",
    });
    expect(retried).toMatchObject({ ok: true, needsConfirmation: true });
    if (!retried.ok || !retried.needsConfirmation) return;

    await expect(
      admin.confirm({
        confirmationId: retried.confirmationId,
        challenge: retried.challenge,
        actor,
        correlationId: "telegram:revoke-confirm",
      }),
    ).resolves.toEqual({ ok: true });

    const revoked = await sql<{
      status: string;
      reference: string;
      summary: string;
      created_by: string;
      revoked_at: string | null;
      variant_version: number;
    }>`
      select re.status, re.reference, re.summary, re.created_by, re.revoked_at::text as revoked_at,
             v.version as variant_version
        from resale_evidence re
        join product_variant v on v.id = re.variant_id
       where re.id = ${fixture.evidenceId}
    `.execute(ctx.db);
    expect(revoked.rows[0]).toMatchObject({
      status: "REVOKED",
      // The facts the owner confirmed against are exactly the facts that survive.
      reference: `owner-${fixture.variantId}`,
      summary: "Owner verified the supplier resale authorization.",
      created_by: String(ROOT_ID),
      // The variant moved, so any snapshot published against the old version is stale.
      variant_version: fixture.variantVersion + 1,
    });
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();

    const readiness = await getProductPublicationReadiness(ctx.db, fixture.productId);
    expect(readiness?.variants[0]).toMatchObject({
      evidenceActive: false,
      // The legacy pointer the contract requires to survive revocation.
      evidenceId: fixture.evidenceId,
    });

    // A replay of the same confirmation is a no-op success with exactly one audit row.
    await expect(
      admin.confirm({
        confirmationId: retried.confirmationId,
        challenge: retried.challenge,
        actor,
        correlationId: "telegram:revoke-replay",
      }),
    ).resolves.toEqual({ ok: true });
    const audits = await listAuditEvents(ctx.db, {
      targetType: "ProductVariant",
      targetId: fixture.variantId,
    });
    expect(audits.filter((event) => event.action === "catalog.evidence.revoke")).toHaveLength(1);
  });

  it("rejects a command ref outside the durable vocabulary", async () => {
    const seeded = await seed();
    await expect(
      sql`
        insert into admin_confirmation
          (id, root_channel_identity_id, action_fingerprint, challenge_hash, status,
           expires_at, correlation_id, allowlisted_command_ref)
        values
          (${newId()}, ${seeded.rootChannelIdentityId}, 'vocabulary-probe', 'vocabulary-probe',
           'CREATED', now(), 'vocabulary-probe', 'wallet.withdraw')
      `.execute(ctx.db),
    ).rejects.toThrow(/admin_confirmation_command_ref_ck/);
  });
});
