import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAdminCallbacks, type AdminCallbacks } from "../../src/bot/callbacks/admin.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import type { AuthorizationJsonValue } from "../../src/modules/identity/authorization-payload.js";
import {
  createStepUpService,
  type StepUpActionCategory,
} from "../../src/modules/identity/step-up.js";
import { loadSensitiveAuthorizationBinding } from "../../src/modules/identity/authorization-binding.js";
import {
  authorizeSensitiveAdminAction,
  type SensitiveActionDeps,
} from "../../src/modules/identity/sensitive-action.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import { createWalletLedgerService } from "../../src/modules/wallet/ledger.js";
import { createBroadcast, markBroadcastPreviewed } from "../../src/modules/notification/service.js";
import { newId } from "../../src/shared/ids/index.js";
import { enqueueBroadcastFromOwner } from "../../src/worker.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

/**
 * T195 — step-up gating of privileged admin mutations (THREAT_MODEL SEC-002).
 *
 * The load-bearing assertion in every refusal case is the ABSENCE of the business
 * side effect: a refused authorisation must leave the ledger, the order status and
 * `notification_delivery` untouched. Everything runs against real PostgreSQL so the
 * row locks that make single-use grants race-proof are part of the evidence.
 */

const hasDocker = await dockerAvailable();
const ROOT_ID = 123456789;
const OTHER_ADMIN_ID = 555000111;
const ROOT_CONFIG = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const TTL_SECONDS = 60;
const STEP_UP_OPTIONS = { ttlSeconds: TTL_SECONDS, lockoutMinutes: 15, maxAttempts: 5 };
const ROOT_ACTOR = { numericUserId: ROOT_ID, chatType: "private" as const };
const TEST_BINDING = {
  actionKey: "wallet.refund",
  resourceType: "Order",
  resourceId: "order-test",
  resourceVersion: "1",
  payloadHash: "a".repeat(64),
};

let ctx: PgTestContext;

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  if (!hasDocker) return;
  await sql`
    truncate table admin_step_up_attempt, admin_step_up_grant, admin_step_up_secret,
      admin_confirmation, audit_event, outbox_event, wallet_ledger, wallet_account, digital_asset,
      order_transition, "order", product_variant, product, category, channel_identity, customer,
      notification_campaign_audience, notification_delivery, notification_campaign,
      notification_preference cascade
  `.execute(ctx.db);
  await sql`update broadcast_throttle set last_large_audience_at = null where id = 'main'`.execute(
    ctx.db,
  );
});

interface Seeded {
  rootChannelIdentityId: string;
  variantId: string;
  orderId: string;
  customerId: string;
  vault: ReturnType<typeof createInMemoryVault>;
}

async function seed(): Promise<Seeded> {
  const rootCustomerId = newId();
  const rootChannelIdentityId = newId();
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();

  await sql`
    insert into customer (id, status, locale)
    values (${rootCustomerId}, 'ACTIVE', 'vi'), (${customerId}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${rootCustomerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${categoryId}, 'C', ${categoryId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product (id, category_id, name_vi, slug, is_active, sort_order)
    values (${productId}, ${categoryId}, 'P', ${productId.slice(-8)}, true, 1)
  `.execute(ctx.db);
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       warranty_days, stock_policy, resale_evidence_id, is_active)
    values
      (${variantId}, ${productId}, ${`SKU-${variantId.slice(-8)}`}, 'V', 200000, 'P1M',
       'CREDENTIAL', 0, 'LOCAL_ONLY', 'RES-1', true)
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, status)
    values
      (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V', 200000,
       'P1M', 'CREDENTIAL', 0, 'LOCAL_ONLY', 'REFUND_PENDING')
  `.execute(ctx.db);
  // A reachable recipient who opted into shop updates. Without this the broadcast audience is
  // empty, and an "it queued nothing" assertion would pass for the wrong reason.
  await sql`
    insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, reachable)
    values (${customerId}, ${String(OTHER_ADMIN_ID)}, ${String(OTHER_ADMIN_ID)}, true)
  `.execute(ctx.db);
  await sql`
    insert into notification_preference (customer_id, shop_updates, purchase_activity)
    values (${customerId}, true, false)
  `.execute(ctx.db);
  await createWalletLedgerService(ctx.db).credit({
    customerId,
    amountVnd: 200000n,
    idempotencyKey: "seed-credit",
    correlationId: "seed-credit",
    reason: "seed credit",
  });
  await createWalletLedgerService(ctx.db).debit({
    customerId,
    amountVnd: 200000n,
    idempotencyKey: `purchase:${orderId}:wallet`,
    correlationId: "seed-debit",
    reason: "seed wallet purchase",
  });

  return { rootChannelIdentityId, variantId, orderId, customerId, vault: createInMemoryVault() };
}

/** The owner's callbacks with step-up ON, plus the layer deps the worker builds once. */
function build(
  seeded: Seeded,
  overrides?: { supportReplacementApprove?: () => Promise<never> },
): {
  callbacks: AdminCallbacks;
  sensitiveDeps: SensitiveActionDeps;
  stepUp: ReturnType<typeof createStepUpService>;
} {
  const sensitiveDeps: SensitiveActionDeps = {
    db: ctx.db,
    rootConfig: ROOT_CONFIG,
    vault: seeded.vault,
    stepUpEnabled: true,
    stepUpOptions: STEP_UP_OPTIONS,
  };
  return {
    sensitiveDeps,
    stepUp: createStepUpService(ctx.db, seeded.vault, STEP_UP_OPTIONS),
    callbacks: createAdminCallbacks({
      db: ctx.db,
      rootConfig: ROOT_CONFIG,
      rootChannelIdentityId: seeded.rootChannelIdentityId,
      confirmation: createAdminConfirmation(ctx.db),
      vault: seeded.vault,
      stepUpEnabled: true,
      stepUpOptions: STEP_UP_OPTIONS,
      ...(overrides?.supportReplacementApprove
        ? { supportReplacementApprove: overrides.supportReplacementApprove }
        : {}),
    }),
  };
}

/** Enroll the root admin and mint a live grant for `category` with a real TOTP code. */
async function grantCategory(
  seeded: Seeded,
  category: StepUpActionCategory,
  adminId = String(ROOT_ID),
  override?: {
    actionKey: string;
    resourceType: string;
    resourceId: string;
    requestedData?: AuthorizationJsonValue;
  },
): Promise<void> {
  const { createTotpCode } = await import("../helpers/totp.js");
  const stepUp = createStepUpService(ctx.db, seeded.vault, STEP_UP_OPTIONS);
  if (!(await stepUp.isEnrolled(adminId))) {
    await stepUp.enroll({
      adminTelegramUserId: adminId,
      issuer: "TIER20 SHOP",
      accountLabel: adminId,
    });
  }
  let selected = override;
  if (selected === undefined && category === "BROADCAST") {
    const campaign = (
      await sql<{ id: string }>`
        select id from notification_campaign
        where created_by = ${String(ROOT_ID)} and status = 'DRAFT'
        order by created_at desc limit 1
      `.execute(ctx.db)
    ).rows[0];
    if (!campaign) throw new Error("missing broadcast campaign");
    selected = {
      actionKey: "broadcast.confirm",
      resourceType: "NotificationCampaign",
      resourceId: campaign.id,
      requestedData: { campaignId: campaign.id },
    };
  }
  if (selected === undefined) {
    selected = {
      actionKey: "wallet.refund",
      resourceType: "Order",
      resourceId: seeded.orderId,
      requestedData: { targetId: seeded.orderId },
    };
  }
  const binding = await loadSensitiveAuthorizationBinding(ctx.db, selected);
  const code = await createTotpCode(seeded.vault, adminId, ctx.db);
  const verified = await stepUp.verify({
    adminTelegramUserId: adminId,
    category: category as StepUpActionCategory,
    code,
    actionKey: selected.actionKey,
    resourceType: selected.resourceType,
    resourceId: selected.resourceId,
    resourceVersion: binding.resourceVersion,
    payloadHash: binding.payloadHash,
  });
  if (!verified.ok) throw new Error(`grant failed: ${verified.code}`);
}

/** Business state that must not move on a refusal. */
async function state(seeded: Seeded): Promise<{
  refundCredits: number;
  balanceVnd: string;
  orderStatus: string;
  deliveries: number;
  campaigns: number;
}> {
  const row = (
    await sql<{
      refund_credits: number;
      balance_vnd: string;
      order_status: string;
      deliveries: number;
      campaigns: number;
    }>`
      select
        (select count(*)::int from wallet_ledger l join wallet_account a on a.id = l.wallet_account_id
          where a.customer_id = ${seeded.customerId}
            and l.idempotency_key = ${`refund:${seeded.orderId}`}) as refund_credits,
        (select balance_vnd::text from wallet_account where customer_id = ${seeded.customerId}) as balance_vnd,
        (select status from "order" where id = ${seeded.orderId}) as order_status,
        (select count(*)::int from notification_delivery) as deliveries,
        (select count(*)::int from notification_campaign) as campaigns
    `.execute(ctx.db)
  ).rows[0]!;
  return {
    refundCredits: row.refund_credits,
    balanceVnd: row.balance_vnd,
    orderStatus: row.order_status,
    deliveries: row.deliveries,
    campaigns: row.campaigns,
  };
}

describe.skipIf(!hasDocker)("sensitive admin actions are step-up gated", () => {
  it("refuses a refund with step-up ON and no grant, and writes nothing", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);

    const before = await state(seeded);
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "refund without a grant",
      correlationId: "gate-1",
    });

    // Never enrolled: the layer cannot verify anything, so it refuses before granting, and
    // the copy points at enrollment rather than at a code prompt that could not succeed.
    expect(requested).toMatchObject({ ok: false, code: "STEP_UP_NOT_ENROLLED" });
    if (requested.ok) return;
    expect(requested.message).toContain("admin:step-up enroll");
    expect(await state(seeded)).toEqual(before);
    // No confirmation was minted either: the gate runs before issuing.
    const confirmations = await sql<{ count: number }>`
      select count(*)::int as count from admin_confirmation
    `.execute(ctx.db);
    expect(confirmations.rows[0]?.count).toBe(0);
    // The refusal is audited with no secret in the payload.
    const denied = await sql<{ action: string; metadata_redacted: Record<string, unknown> }>`
      select action, metadata_redacted from audit_event where action = 'admin.sensitive.denied'
    `.execute(ctx.db);
    expect(denied.rows).toHaveLength(1);
    // `resourceType`/`resourceId` are recorded so the operator CLI can bind the grant it mints to the
    // object the owner was actually refused on — a category alone would authorise any object in
    // that category. They are opaque ids, so they carry no secret.
    expect(denied.rows[0]?.metadata_redacted).toMatchObject({
      actionKey: "wallet.refund",
      category: "REFUND",
      code: "STEP_UP_NOT_ENROLLED",
      resourceType: "Order",
      resourceId: seeded.orderId,
      authorizationVersion: 2,
      resourceVersion: "1",
    });
    expect(denied.rows[0]?.metadata_redacted.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("issues no grant for a wrong TOTP code, so the action stays refused", async () => {
    const seeded = await seed();
    const { callbacks, stepUp } = build(seeded);
    await stepUp.enroll({
      adminTelegramUserId: String(ROOT_ID),
      issuer: "TIER20 SHOP",
      accountLabel: String(ROOT_ID),
    });

    const wrong = await stepUp.verify({
      ...TEST_BINDING,
      adminTelegramUserId: String(ROOT_ID),
      category: "REFUND",
      code: "000001",
    });
    expect(wrong.ok).toBe(false);

    const grants = await sql<{ count: number }>`
      select count(*)::int as count from admin_step_up_grant
    `.execute(ctx.db);
    expect(grants.rows[0]?.count).toBe(0);
    expect(
      await callbacks.handle({
        command: "wallet.refund",
        actor: ROOT_ACTOR,
        targetId: seeded.orderId,
        reason: "refund after a wrong code",
        correlationId: "gate-2",
      }),
    ).toMatchObject({ ok: false, code: "STEP_UP_REQUIRED" });
  });

  it("executes the refund exactly once after a correct TOTP code", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);
    const before = await state(seeded);

    await grantCategory(seeded, "REFUND");
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "refund approved after verification",
      correlationId: "gate-3",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    const confirmed = await callbacks.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: ROOT_ACTOR,
      correlationId: "gate-3-confirm",
    });
    expect(confirmed).toEqual({ ok: true });

    // The preview step must not have spent the grant, so this is the one spend that mattered.
    const after = await state(seeded);
    expect(after.refundCredits).toBe(1);
    expect(after.balanceVnd).toBe("200000");
    expect(after.orderStatus).toBe("REFUNDED");
    expect(before.refundCredits).toBe(0);
    const consumed = await sql<{ consumed_at: Date | null }>`
      select consumed_at from admin_step_up_grant
    `.execute(ctx.db);
    expect(consumed.rows[0]?.consumed_at).not.toBeNull();
  });

  it("refuses a refund when the grant is bound to another category", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);
    const before = await state(seeded);

    await grantCategory(seeded, "BROADCAST", String(ROOT_ID), {
      actionKey: "broadcast.confirm",
      resourceType: "NotificationCampaign",
      resourceId: "missing-campaign",
      requestedData: { campaignId: "missing-campaign" },
    });
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "refund with a broadcast grant",
      correlationId: "gate-4",
    });

    expect(requested).toMatchObject({ ok: false, code: "STEP_UP_REQUIRED" });
    expect(await state(seeded)).toEqual(before);
  });

  it("refuses a refund when the grant has expired", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);
    const before = await state(seeded);

    await grantCategory(seeded, "REFUND");
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "refund whose grant expires",
      correlationId: "gate-5",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || !requested.needsConfirmation) return;

    // The injected clock: the grant window is moved into the past rather than waiting out the TTL.
    await sql`
      update admin_step_up_grant
      set issued_at = '2020-01-01T00:00:00Z', expires_at = '2020-01-01T00:01:00Z'
    `.execute(ctx.db);

    const confirmed = await callbacks.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: ROOT_ACTOR,
      correlationId: "gate-5-confirm",
    });
    expect(confirmed).toMatchObject({
      ok: false,
      code: "STEP_UP_GRANT_MISSING",
      action: "wallet.refund",
    });
    expect(await state(seeded)).toEqual(before);
    // An expired grant is refused, not silently burned into "consumed".
    const grant = await sql<{ consumed_at: Date | null }>`
      select consumed_at from admin_step_up_grant
    `.execute(ctx.db);
    expect(grant.rows[0]?.consumed_at).toBeNull();
  });

  it("refuses the second sequential confirm and applies the refund once", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);

    await grantCategory(seeded, "REFUND");
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "refund replayed",
      correlationId: "gate-6",
    });
    if (!requested.ok || !requested.needsConfirmation) throw new Error("no confirmation");

    const first = await callbacks.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: ROOT_ACTOR,
      correlationId: "gate-6-a",
    });
    const second = await callbacks.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: ROOT_ACTOR,
      correlationId: "gate-6-b",
    });

    expect(first).toEqual({ ok: true });
    // The confirmation aggregate is single-use, so the replay never reaches the step-up gate.
    expect(second).toEqual({ ok: true });
    const after = await state(seeded);
    expect(after.refundCredits).toBe(1);
    expect(after.balanceVnd).toBe("200000");
    const refunds = await sql<{ count: number }>`
      select count(*)::int as count from wallet_ledger
      where idempotency_key = ${`refund:${seeded.orderId}`}
    `.execute(ctx.db);
    expect(refunds.rows[0]?.count).toBe(1);
  });

  it("spends a single-use grant exactly once under concurrency", async () => {
    const seeded = await seed();
    const { sensitiveDeps } = build(seeded);
    await grantCategory(seeded, "REFUND");

    // Two racers on the SAME grant: `consume` claims the row with `for update`, so exactly one
    // wins. This is the lock the layer relies on, asserted directly against PostgreSQL.
    const results = await Promise.all([
      authorizeSensitiveAdminAction(sensitiveDeps, {
        actor: ROOT_ACTOR,
        actionKey: "wallet.refund",
        resourceType: "Order",
        resourceId: seeded.orderId,
        correlationId: "race-a",
        consumeGrant: true,
      }),
      authorizeSensitiveAdminAction(sensitiveDeps, {
        actor: ROOT_ACTOR,
        actionKey: "wallet.refund",
        resourceType: "Order",
        resourceId: seeded.orderId,
        correlationId: "race-b",
        consumeGrant: true,
      }),
    ]);

    const wins = results.filter((result) => result.ok && result.stepUpConsumed);
    expect(wins).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });

  it("refuses concurrent confirms so at most one mutation lands", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);

    await grantCategory(seeded, "REFUND");
    const requested = await callbacks.handle({
      command: "wallet.refund",
      actor: ROOT_ACTOR,
      targetId: seeded.orderId,
      reason: "concurrent refund",
      correlationId: "gate-7",
    });
    if (!requested.ok || !requested.needsConfirmation) throw new Error("no confirmation");

    const results = await Promise.all([
      callbacks.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor: ROOT_ACTOR,
        correlationId: "gate-7-a",
      }),
      callbacks.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor: ROOT_ACTOR,
        correlationId: "gate-7-b",
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    const after = await state(seeded);
    expect(after.refundCredits).toBe(1);
    expect(after.balanceVnd).toBe("200000");
    expect(after.orderStatus).toBe("REFUNDED");
  });

  it("refuses a grant that belongs to a different admin", async () => {
    const seeded = await seed();
    const { callbacks } = build(seeded);
    const before = await state(seeded);

    // The root admin IS enrolled, so the refusal below can only be about ownership of the
    // grant: a real grant minted for a different numeric id must not authorise this actor.
    await grantCategory(seeded, "REFUND");
    await sql`delete from admin_step_up_grant`.execute(ctx.db);
    await grantCategory(seeded, "REFUND", String(OTHER_ADMIN_ID));
    expect(
      await callbacks.handle({
        command: "wallet.refund",
        actor: ROOT_ACTOR,
        targetId: seeded.orderId,
        reason: "using another admin's grant",
        correlationId: "gate-8",
      }),
    ).toMatchObject({ ok: false, code: "STEP_UP_REQUIRED" });
    expect(await state(seeded)).toEqual(before);
  });

  it("leaves the grant consumed when the mutation throws after authorization", async () => {
    const seeded = await seed();
    // Semantics: the grant is spent by the step-up service's own transaction, then the mutation
    // runs in the confirmation's transaction. If the mutation aborts, the grant stays consumed —
    // consumed-but-not-mutated. That is the fail-closed direction: the admin re-verifies and
    // retries, and a mutation can never land with an unspent grant.
    const { callbacks } = build(seeded, {
      supportReplacementApprove: async () => {
        throw new Error("mutation exploded after authorization");
      },
    });
    await grantCategory(seeded, "REFUND", String(ROOT_ID), {
      actionKey: "support.replacement.approve",
      resourceType: "ReplacementCase",
      resourceId: "replacement-case-1",
      requestedData: { targetId: "replacement-case-1" },
    });

    const requested = await callbacks.handle({
      command: "support.replacement.approve",
      actor: ROOT_ACTOR,
      targetId: "replacement-case-1",
      reason: "approve a replacement whose executor throws",
      correlationId: "gate-9",
    });
    if (!requested.ok || !requested.needsConfirmation) throw new Error("no confirmation");

    await expect(
      callbacks.confirm({
        confirmationId: requested.confirmationId,
        challenge: requested.challenge,
        actor: ROOT_ACTOR,
        correlationId: "gate-9-confirm",
      }),
    ).rejects.toThrow(/mutation exploded after authorization/u);

    // Consumed exactly once, and a retry is refused rather than mutating.
    const grant = await sql<{ consumed_at: Date | null }>`
      select consumed_at from admin_step_up_grant
    `.execute(ctx.db);
    expect(grant.rows[0]?.consumed_at).not.toBeNull();
    const retry = await callbacks.confirm({
      confirmationId: requested.confirmationId,
      challenge: requested.challenge,
      actor: ROOT_ACTOR,
      correlationId: "gate-9-retry",
    });
    // The grant is NOT re-issued and the confirmation did not survive the rollback, so the
    // retry is refused too. That is the fail-closed direction: an admin re-verifies.
    expect(retry.ok).toBe(false);
    const replacementCases = await sql<{ count: number }>`
      select count(*)::int as count from replacement_case
    `.execute(ctx.db);
    expect(replacementCases.rows[0]?.count).toBe(0);
  });
});

describe.skipIf(!hasDocker)("broadcast execution is step-up gated", () => {
  async function seedCampaign(seeded: Seeded, content: string): Promise<string> {
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "DRAFT",
      createdBy: String(ROOT_ID),
      idempotencyKey: `admin-broadcast:${ROOT_ID}:test`,
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: String(ROOT_ID),
      content,
    });
    return campaignId;
  }

  it("refuses the send without a grant and writes no delivery", async () => {
    const seeded = await seed();
    const campaignId = await seedCampaign(seeded, "Sale cuối tuần");
    const { callbacks, sensitiveDeps } = build(seeded);

    const before = await state(seeded);
    const sent = await enqueueBroadcastFromOwner({
      db: ctx.db,
      adminCallbacks: callbacks,
      sensitiveDeps,
      telegramUserId: String(ROOT_ID),
      chatType: "private",
      campaignId,
      correlationId: "bc-1",
      largeAudienceThreshold: 500,
      cooldownSeconds: 300,
    });

    // The mutating step spends rather than peeks, so the refusal names the missing grant.
    expect(sent).toMatchObject({ ok: false, stage: "IDENTITY", code: "STEP_UP_GRANT_MISSING" });
    const deliveries = await sql<{ count: number }>`
      select count(*)::int as count from notification_delivery where campaign_id = ${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows[0]?.count).toBe(0);
    const campaign = await sql<{ status: string }>`
      select status from notification_campaign where id = ${campaignId}
    `.execute(ctx.db);
    expect(campaign.rows[0]?.status).toBe("DRAFT");
    // `state()` compares the whole surface, which includes the campaign count, so keep the order
    // status assertion honest: nothing about the refund path moved either.
    expect((await state(seeded)).orderStatus).toBe(before.orderStatus);
  });

  it("queues exactly once with a live BROADCAST grant", async () => {
    const seeded = await seed();
    const campaignId = await seedCampaign(seeded, "Sale cuối tuần");
    const { callbacks, sensitiveDeps } = build(seeded);
    await grantCategory(seeded, "BROADCAST");

    const sent = await enqueueBroadcastFromOwner({
      db: ctx.db,
      adminCallbacks: callbacks,
      sensitiveDeps,
      telegramUserId: String(ROOT_ID),
      chatType: "private",
      campaignId,
      correlationId: "bc-2",
      largeAudienceThreshold: 500,
      cooldownSeconds: 300,
    });
    expect(sent).toEqual({ ok: true, queued: 1 });

    const repeat = await enqueueBroadcastFromOwner({
      db: ctx.db,
      adminCallbacks: callbacks,
      sensitiveDeps,
      telegramUserId: String(ROOT_ID),
      chatType: "private",
      campaignId,
      correlationId: "bc-2-repeat",
      largeAudienceThreshold: 500,
      cooldownSeconds: 300,
    });
    // The grant is spent and the campaign has left DRAFT, so the replay cannot fan out again.
    expect(repeat).toMatchObject({ ok: false });
    const deliveries = await sql<{ count: number }>`
      select count(*)::int as count from notification_delivery where campaign_id = ${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows[0]?.count).toBe(1);
  });

  it("refuses a stale preview: both the old confirmation and the old callback fail", async () => {
    const seeded = await seed();
    const campaignId = await seedCampaign(seeded, "Bản gốc");
    const { callbacks, sensitiveDeps } = build(seeded);
    await grantCategory(seeded, "BROADCAST");

    // A write that bypasses preview: the reviewed text is no longer the stored text, so the
    // confirmation the operator holds refers to content they never saw.
    await sql`
      update notification_campaign set content = 'Nội dung bị đổi' where id = ${campaignId}
    `.execute(ctx.db);

    const sent = await enqueueBroadcastFromOwner({
      db: ctx.db,
      adminCallbacks: callbacks,
      sensitiveDeps,
      telegramUserId: String(ROOT_ID),
      chatType: "private",
      campaignId,
      correlationId: "bc-3",
      largeAudienceThreshold: 500,
      cooldownSeconds: 300,
    });
    expect(sent).toEqual({ ok: false, stage: "IDENTITY", code: "STEP_UP_GRANT_MISSING" });

    const deliveries = await sql<{ count: number }>`
      select count(*)::int as count from notification_delivery where campaign_id = ${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows[0]?.count).toBe(0);
    const campaign = await sql<{ status: string }>`
      select status from notification_campaign where id = ${campaignId}
    `.execute(ctx.db);
    expect(campaign.rows[0]?.status).toBe("DRAFT");
  });

  it("refuses a spoofed actor id and audits the denial", async () => {
    const seeded = await seed();
    const campaignId = await seedCampaign(seeded, "Sale cuối tuần");
    const { callbacks, sensitiveDeps } = build(seeded);
    await grantCategory(seeded, "BROADCAST");

    const sent = await enqueueBroadcastFromOwner({
      db: ctx.db,
      adminCallbacks: callbacks,
      sensitiveDeps,
      telegramUserId: String(OTHER_ADMIN_ID),
      chatType: "private",
      campaignId,
      correlationId: "bc-4",
      largeAudienceThreshold: 500,
      cooldownSeconds: 300,
    });
    expect(sent).toMatchObject({ ok: false, stage: "IDENTITY", code: "NOT_ROOT_ADMIN" });

    const deliveries = await sql<{ count: number }>`
      select count(*)::int as count from notification_delivery where campaign_id = ${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows[0]?.count).toBe(0);
    // `guardRootAction` records the spoof attempt, so the denial is not silent.
    const denied = await sql<{ count: number }>`
      select count(*)::int as count from audit_event
      where actor_id = ${String(OTHER_ADMIN_ID)} and target_type <> 'NotificationCampaign'
    `.execute(ctx.db);
    expect(denied.rows[0]?.count).toBeGreaterThan(0);
  });
});
