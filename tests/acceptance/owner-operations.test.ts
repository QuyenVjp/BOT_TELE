import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createAdminCallbacks } from "../../src/bot/callbacks/admin.js";
import { createAdminConfirmation } from "../../src/modules/identity/admin-confirmation.js";
import { listAuditEvents } from "../../src/modules/identity/audit.js";
import { createIdentityTelemetry } from "../../src/modules/identity/telemetry.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T093 — Owner catalog kill-switch and discrepancy review acceptance
 * (User Story 5 / FR-021–FR-023).
 *
 * The configured numeric owner, in private chat, deactivates a sellable variant
 * (low-risk, audited) and resolves a payment discrepancy after an explicit
 * confirmation (high-risk). Impersonation by username and group-chat attempts
 * are denied. An /add-admin attempt creates nothing.
 */

let ctx: PgTestContext;

const ROOT_ID = 123456789;
const IMPOSTOR_ID = 999000111;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

interface Seeded {
  rootChannelIdentityId: string;
  variantId: string;
  discrepancyId: string;
}

async function seed(): Promise<Seeded> {
  const customerId = newId();
  const rootChannelIdentityId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const discrepancyId = newId();
  const slug = categoryId.slice(-8);

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
    values (${rootChannelIdentityId}, ${customerId}, 'TELEGRAM', ${String(ROOT_ID)}, 'Quyenvjp')
  `.execute(ctx.db);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'Netflix', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id, is_active)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'Premium 1 tháng', 199000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1', true)
  `.execute(ctx.db);
  await sql`
    insert into discrepancy (id, type, status, reason, owner)
    values (${discrepancyId}, 'UNDERPAYMENT', 'OPEN', 'short by 1000', 'ops')
  `.execute(ctx.db);

  return { rootChannelIdentityId, variantId, discrepancyId };
}

beforeEach(async () => {
  await sql`
    truncate table admin_confirmation, audit_event, discrepancy, product_variant, product,
      category, channel_identity, customer cascade
  `.execute(ctx.db);
});

function buildCallbacks(seeded: Seeded) {
  const telemetry = createIdentityTelemetry();
  const confirmation = createAdminConfirmation(ctx.db);
  return {
    telemetry,
    confirmation,
    callbacks: createAdminCallbacks({
      db: ctx.db,
      rootConfig: { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" },
      rootChannelIdentityId: seeded.rootChannelIdentityId,
      confirmation,
      telemetry,
    }),
  };
}

describe("owner operations acceptance (US5)", () => {
  it("owner deactivates a variant (kill-switch) and resolves a discrepancy with confirmation", async () => {
    const seeded = await seed();
    const { callbacks, telemetry } = buildCallbacks(seeded);

    // 1. Low-risk kill-switch: deactivate variant as the real root in private chat.
    const kill = await callbacks.handle({
      command: "catalog.deactivate",
      actor: {
        numericUserId: ROOT_ID,
        chatType: "private",
        observedUsername: "Quyenvjp",
      },
      targetId: seeded.variantId,
      reason: "SKU no longer authorized",
      correlationId: "own-1",
    });
    expect(kill.ok).toBe(true);

    const variant = await sql<{ is_active: boolean }>`
      select is_active from product_variant where id = ${seeded.variantId}
    `.execute(ctx.db);
    expect(variant.rows[0]?.is_active).toBe(false);

    const killAudit = await listAuditEvents(ctx.db, {
      targetType: "ProductVariant",
      targetId: seeded.variantId,
    });
    expect(killAudit.some((e) => e.action === "catalog.deactivate")).toBe(true);

    // 2. High-risk discrepancy resolve requires a confirmation challenge.
    const request = await callbacks.handle({
      command: "discrepancy.resolve",
      actor: {
        numericUserId: ROOT_ID,
        chatType: "private",
        observedUsername: "Quyenvjp",
      },
      targetId: seeded.discrepancyId,
      reason: "Customer topped up the shortfall offline",
      resolutionCode: "MANUAL_ACCEPT",
      correlationId: "own-2",
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.needsConfirmation).toBe(true);
    if (!request.needsConfirmation) return;
    expect(request.challenge).toBeTruthy();
    expect(request.confirmationId).toBeTruthy();

    // Confirm with the challenge.
    const confirmed = await callbacks.confirm({
      confirmationId: request.confirmationId,
      challenge: request.challenge,
      actor: {
        numericUserId: ROOT_ID,
        chatType: "private",
        observedUsername: "Quyenvjp",
      },
      correlationId: "own-2",
    });
    expect(confirmed.ok).toBe(true);

    const disc = await sql<{ status: string; resolution_code: string | null }>`
      select status, resolution_code from discrepancy where id = ${seeded.discrepancyId}
    `.execute(ctx.db);
    expect(disc.rows[0]?.status).toBe("RESOLVED");
    expect(disc.rows[0]?.resolution_code).toBe("MANUAL_ACCEPT");

    const discAudit = await listAuditEvents(ctx.db, {
      targetType: "Discrepancy",
      targetId: seeded.discrepancyId,
    });
    expect(discAudit.some((e) => e.action === "discrepancy.resolve")).toBe(true);

    // 3. Username impersonation is denied and recorded.
    const imp = await callbacks.handle({
      command: "catalog.activate",
      actor: {
        numericUserId: IMPOSTOR_ID,
        chatType: "private",
        observedUsername: "Quyenvjp",
      },
      targetId: seeded.variantId,
      reason: "impersonation attempt",
      correlationId: "own-3",
    });
    expect(imp.ok).toBe(false);
    if (!imp.ok) expect(imp.code).toBe("NOT_ROOT_ADMIN");
    expect(telemetry.snapshot().impersonationAttempts).toBeGreaterThanOrEqual(1);

    // 4. Group chat is denied even for the real root.
    const group = await callbacks.handle({
      command: "catalog.activate",
      actor: {
        numericUserId: ROOT_ID,
        chatType: "group",
        observedUsername: "Quyenvjp",
      },
      targetId: seeded.variantId,
      reason: "group attempt",
      correlationId: "own-4",
    });
    expect(group.ok).toBe(false);
    if (!group.ok) expect(group.code).toBe("WRONG_CONTEXT");

    // 5. /add-admin creates nothing and is not an owner command.
    const addAdmin = await callbacks.handle({
      command: "add-admin",
      actor: {
        numericUserId: ROOT_ID,
        chatType: "private",
        observedUsername: "Quyenvjp",
      },
      targetId: String(IMPOSTOR_ID),
      reason: "please",
      correlationId: "own-5",
    });
    expect(addAdmin.ok).toBe(false);
    if (!addAdmin.ok) expect(addAdmin.code).toBe("UNKNOWN_COMMAND");
  });
});
