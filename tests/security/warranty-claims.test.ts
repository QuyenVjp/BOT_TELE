import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  approveClaimRefund,
  approveClaimReplacement,
  markRefundPaid,
  openWarrantyClaim,
  rejectClaim,
  verifyClaimDefect,
} from "../../src/modules/warranty/claims.js";
import { startPostgres, type StartedPg } from "../helpers/pg-container.js";
import type { RootActor, RootAdminConfig } from "../../src/modules/identity/root-admin.js";

const ROOT_ID = 123456789;
const rootActor: RootActor = { numericUserId: ROOT_ID, chatType: "private" };
const rootConfig: RootAdminConfig = { adminTelegramUserId: ROOT_ID, expectedUsername: "Quyenvjp" };
const DAY = 86_400_000;

/**
 * Warranty claims touch a customer's money, so this suite pins the properties that must never
 * regress: the report time is the only clock, ownership is decided before anything is written, a
 * replay cannot duplicate a claim, an obligation or a payout, and approving a refund never moves
 * money by itself.
 */
describe("warranty claims", () => {
  let ctx: StartedPg;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    // A claim and its refund obligation reference each other, so the cleanup truncates the whole
    // set with cascade rather than ordering deletes around the cycle.
    await sql`truncate table warranty_claim_event, warranty_claim, shop_refund_obligation, replacement_case, digital_asset, "order", product_variant, product, category, customer cascade`.execute(
      ctx.handle.db,
    );
  });

  interface Fixture {
    customerId: string;
    orderId: string;
    variantId: string;
    assetId: string;
    completedAt: Date;
  }

  async function seed(options?: {
    warrantyDays?: number;
    withReplacementStock?: number;
    warrantyEnabled?: boolean;
    prorationEnabled?: boolean;
    policyVersion?: number;
    replacementAllowed?: boolean;
    refundAllowed?: boolean;
  }): Promise<Fixture> {
    const warrantyDays = options?.warrantyDays ?? 30;
    const customerId = newId();
    const categoryId = newId();
    const productId = newId();
    const variantId = newId();
    const orderId = newId();
    const assetId = newId();
    const completedAt = new Date("2026-09-01T02:00:00.000Z");
    await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
      ctx.handle.db,
    );
    await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'AI', ${categoryId.slice(-8)}, true, 1)`.execute(
      ctx.handle.db,
    );
    await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'GPT Plus', ${"gpt-" + categoryId.slice(-8)}, true, 1)`.execute(
      ctx.handle.db,
    );
    await sql`
      insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, warranty_days, warranty_enabled, warranty_proration_enabled, warranty_coverage_vi, warranty_exclusions_vi, warranty_policy_version, warranty_replacement_allowed, warranty_refund_allowed)
      values (${variantId}, ${productId}, ${"SKU-" + variantId}, '1 tháng', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT', ${warrantyDays}, ${options?.warrantyEnabled ?? true}, ${options?.prorationEnabled ?? true}, 'Bảo hành theo thời gian sử dụng.', 'Khách đổi thông tin đăng nhập', ${options?.policyVersion ?? 1}, ${options?.replacementAllowed ?? true}, ${options?.refundAllowed ?? true})
    `.execute(ctx.handle.db);
    await sql`
      insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
        price_vnd, duration_code, delivery_type, supplier_policy_snapshot, fulfillment_type, status,
        warranty_days, completed_at)
      values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'GPT Plus', '1 tháng',
        100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'STOCK_ACCOUNT', 'COMPLETED', ${warrantyDays}, ${completedAt.toISOString()})
    `.execute(ctx.handle.db);
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status, delivered_order_id)
      values (${assetId}, ${variantId}, 'LOCAL', ${"vault:" + assetId}, ${"fp-" + assetId}, 'DELIVERED', ${orderId})
    `.execute(ctx.handle.db);
    for (let index = 0; index < (options?.withReplacementStock ?? 0); index += 1) {
      const spareId = newId();
      await sql`
        insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
        values (${spareId}, ${variantId}, 'LOCAL', ${"vault:" + spareId}, ${"fp-" + spareId}, 'AVAILABLE')
      `.execute(ctx.handle.db);
    }
    return { customerId, orderId, variantId, assetId, completedAt };
  }

  const admin = (claimId: string) => ({
    db: ctx.handle.db,
    actor: rootActor,
    config: rootConfig,
    claimId,
    correlationId: "warranty-test",
  });

  const walletTotal = async (customerId: string) => {
    const rows = await sql<{ balance: string | null }>`
      select balance_vnd::text as balance from wallet_account where customer_id = ${customerId}
    `.execute(ctx.handle.db);
    return rows.rows[0]?.balance ?? null;
  };

  it("refuses a claim on someone else's order, before writing anything", async () => {
    const fixture = await seed();
    const stranger = newId();
    const result = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: stranger,
      orderId: fixture.orderId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    // A foreign order is indistinguishable from a missing one: no existence oracle.
    expect(result).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND" });
    const count = await sql<{ n: string }>`select count(*)::text as n from warranty_claim`.execute(
      ctx.handle.db,
    );
    expect(count.rows[0]!.n).toBe("0");
  });

  it("refuses an asset that was not delivered to that order", async () => {
    const fixture = await seed();
    const otherAsset = newId();
    await sql`
      insert into digital_asset (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
      values (${otherAsset}, ${fixture.variantId}, 'LOCAL', 'vault:x', 'fp-x', 'AVAILABLE')
    `.execute(ctx.handle.db);
    const result = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: otherAsset,
      issueType: "ACCOUNT_LOCKED",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + DAY),
    });
    expect(result).toMatchObject({ ok: false, code: "ASSET_NOT_DELIVERED" });
  });

  it("snapshots the refund at report time: 100.000 ₫ / 30 ngày, báo lỗi sau 18 ngày → 40.000 ₫", async () => {
    const fixture = await seed();
    const reportedAt = new Date(fixture.completedAt.getTime() + 18 * DAY);
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: reportedAt,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot).toMatchObject({ usedDays: 18, remainingDays: 12 });
    expect(opened.snapshot.refundVnd).toBe(40000n);
    expect(opened.snapshot.reportedAt).toBe(reportedAt.toISOString());
  });

  // A slow review must not cost the customer a single đồng: the admin approves days later and the
  // amount is still the one computed from the report time.
  it("keeps the approved refund at the report-time value even when the review lands much later", async () => {
    const fixture = await seed();
    const reportedAt = new Date(fixture.completedAt.getTime() + 18 * DAY);
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: reportedAt,
    });
    if (!opened.ok) throw new Error("claim not opened");

    await verifyClaimDefect({
      ...admin(opened.claimId),
      now: new Date(reportedAt.getTime() + 25 * DAY),
    });
    const approved = await approveClaimRefund({
      ...admin(opened.claimId),
      now: new Date(reportedAt.getTime() + 25 * DAY),
    });
    expect(approved).toMatchObject({ ok: true, status: "REFUND_DUE" });

    const obligation = await sql<{ amount_vnd: string; status: string }>`
      select amount_vnd::text as amount_vnd, status from shop_refund_obligation
      where claim_id = ${opened.claimId}
    `.execute(ctx.handle.db);
    // day 43 of a 30-day warranty would prorate to zero if the approval time were the clock
    expect(obligation.rows[0]).toMatchObject({ amount_vnd: "40000", status: "OPEN" });
  });

  it("opens exactly one claim for a duplicate submit, and rejects a report after expiry", async () => {
    const fixture = await seed();
    const reportAt = new Date(fixture.completedAt.getTime() + 2 * DAY);
    const params = {
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "CANNOT_SIGN_IN" as const,
      correlationId: "t",
      now: reportAt,
    };
    const first = await openWarrantyClaim(params);
    const second = await openWarrantyClaim(params);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.claimId).toBe(first.claimId);
    expect(second.idempotent).toBe(true);

    const late = await seed();
    const expired = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: late.customerId,
      orderId: late.orderId,
      assetId: late.assetId,
      issueType: "OTHER",
      correlationId: "t",
      now: new Date(late.completedAt.getTime() + 31 * DAY),
    });
    expect(expired).toMatchObject({ ok: false, code: "WARRANTY_EXPIRED" });
  });

  it("approving a refund creates exactly one obligation and moves no money", async () => {
    const fixture = await seed();
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "ACCOUNT_LOCKED",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");
    const balanceBefore = await walletTotal(fixture.customerId);

    await verifyClaimDefect(admin(opened.claimId));
    await approveClaimRefund(admin(opened.claimId));
    const replay = await approveClaimRefund(admin(opened.claimId));

    const obligations = await sql<{ n: string }>`
      select count(*)::text as n from shop_refund_obligation where claim_id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(obligations.rows[0]!.n).toBe("1");
    expect(replay).toMatchObject({ ok: true, idempotent: true });

    // Nothing left the building: no wallet credit, no bank transaction, claim still awaiting payment.
    expect(await walletTotal(fixture.customerId)).toBe(balanceBefore);
    const bank = await sql<{ n: string }>`select count(*)::text as n from bank_transaction`.execute(
      ctx.handle.db,
    );
    expect(bank.rows[0]!.n).toBe("0");
    const claim = await sql<{ status: string }>`
      select status from warranty_claim where id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(claim.rows[0]!.status).toBe("REFUND_DUE");
  });

  it("marks a refund paid once, only from REFUND_DUE, and never twice", async () => {
    const fixture = await seed();
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");

    // Not yet due: marking paid before approval is refused.
    expect(await markRefundPaid(admin(opened.claimId))).toMatchObject({
      ok: false,
      code: "ILLEGAL_STATE",
    });

    await verifyClaimDefect(admin(opened.claimId));
    await approveClaimRefund(admin(opened.claimId));
    const paid = await markRefundPaid({ ...admin(opened.claimId), payoutReference: "FT-TEST-1" });
    const replay = await markRefundPaid(admin(opened.claimId));
    expect(paid).toMatchObject({ ok: true, status: "REFUND_PAID" });
    expect(replay).toMatchObject({ ok: true, idempotent: true });

    const obligations = await sql<{ status: string; n: string }>`
      select status, count(*)::text as n from shop_refund_obligation where claim_id = ${opened.claimId} group by status
    `.execute(ctx.handle.db);
    expect(obligations.rows[0]).toMatchObject({ status: "PAID", n: "1" });
  });

  it("adjusts the approved amount only with a reason, and audits both figures", async () => {
    const fixture = await seed();
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");
    await verifyClaimDefect(admin(opened.claimId));

    expect(await approveClaimRefund({ ...admin(opened.claimId), amountVnd: 50000n })).toMatchObject(
      {
        ok: false,
        code: "INVALID_REASON",
      },
    );

    const approved = await approveClaimRefund({
      ...admin(opened.claimId),
      amountVnd: 50000n,
      overrideReason: "Goodwill top-up",
    });
    expect(approved).toMatchObject({ ok: true });

    const row = await sql<{ recommended: string; approved: string; override_reason: string }>`
      select recommended_amount_vnd::text as recommended, approved_amount_vnd::text as approved, override_reason
      from shop_refund_obligation where claim_id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(row.rows[0]).toMatchObject({
      recommended: "40000",
      approved: "50000",
      override_reason: "Goodwill top-up",
    });
  });

  it("replaces a defective asset once and takes it out of sellable stock", async () => {
    const fixture = await seed({ withReplacementStock: 1 });
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "ACCOUNT_LOCKED",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 5 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");
    await verifyClaimDefect(admin(opened.claimId));

    const replaced = await approveClaimReplacement({
      ...admin(opened.claimId),
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });
    expect(replaced).toMatchObject({ ok: true, status: "REPLACEMENT_APPROVED" });

    // the defective asset is out of the sellable set for good
    const original = await sql<{ status: string }>`
      select status from digital_asset where id = ${fixture.assetId}
    `.execute(ctx.handle.db);
    expect(original.rows[0]!.status).toBe("COMPROMISED");

    // exactly one replacement was claimed, and a replay does not claim a second
    const claimed = await sql<{ n: string }>`
      select count(*)::text as n from digital_asset where variant_id = ${fixture.variantId} and status = 'RESERVED'
    `.execute(ctx.handle.db);
    expect(claimed.rows[0]!.n).toBe("1");
    const replay = await approveClaimReplacement({
      ...admin(opened.claimId),
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
    });
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    const stillOne = await sql<{ n: string }>`
      select count(*)::text as n from digital_asset where variant_id = ${fixture.variantId} and status = 'RESERVED'
    `.execute(ctx.handle.db);
    expect(stillOne.rows[0]!.n).toBe("1");
  });

  it("rejects a claim with a reason and no financial effect", async () => {
    const fixture = await seed();
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "OTHER",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 3 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");

    expect(await rejectClaim({ ...admin(opened.claimId), reason: "" })).toMatchObject({
      ok: false,
      code: "INVALID_REASON",
    });
    expect(
      await rejectClaim({ ...admin(opened.claimId), reason: "Khách đổi mật khẩu rồi quên" }),
    ).toMatchObject({
      ok: true,
      status: "REJECTED",
    });
    const obligations = await sql<{ n: string }>`
      select count(*)::text as n from shop_refund_obligation
    `.execute(ctx.handle.db);
    expect(obligations.rows[0]!.n).toBe("0");
  });

  it("snapshots the policy at report time and lets it gate the resolution", async () => {
    const fixture = await seed({
      prorationEnabled: false,
      replacementAllowed: false,
      policyVersion: 7,
    });
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "ACCOUNT_LOCKED",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const row = await sql<{
      policy_version: number;
      coverage_snapshot: string | null;
      exclusions_snapshot: string | null;
      proration_enabled: boolean;
      replacement_allowed: boolean;
      refund_allowed: boolean;
      calculated_refund_vnd: string;
    }>`
      select policy_version, coverage_snapshot, exclusions_snapshot, proration_enabled,
             replacement_allowed, refund_allowed, calculated_refund_vnd::text as calculated_refund_vnd
      from warranty_claim where id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(row.rows[0]).toMatchObject({
      policy_version: 7,
      coverage_snapshot: "Bảo hành theo thời gian sử dụng.",
      exclusions_snapshot: "Khách đổi thông tin đăng nhập",
      proration_enabled: false,
      replacement_allowed: false,
    });
    // proration off refunds the paid amount rather than the remaining-time share
    expect(row.rows[0]!.calculated_refund_vnd).toBe("100000");

    await verifyClaimDefect(admin(opened.claimId));
    expect(
      await approveClaimReplacement({
        ...admin(opened.claimId),
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
      }),
    ).toMatchObject({ ok: false, code: "NOT_ALLOWED_BY_POLICY" });
    // refusing on policy must not leave anything behind: no case, no claimed stock
    const cases = await sql<{
      n: string;
    }>`select count(*)::text as n from replacement_case`.execute(ctx.handle.db);
    expect(cases.rows[0]!.n).toBe("0");
    const reserved = await sql<{ n: string }>`
      select count(*)::text as n from digital_asset where status = 'RESERVED'
    `.execute(ctx.handle.db);
    expect(reserved.rows[0]!.n).toBe("0");

    // A later product edit must not change what this claim was judged by.
    await sql`update product_variant set warranty_proration_enabled = true, warranty_replacement_allowed = true, warranty_policy_version = 8 where id = ${fixture.variantId}`.execute(
      ctx.handle.db,
    );
    const after = await sql<{ policy_version: number; proration_enabled: boolean }>`
      select policy_version, proration_enabled from warranty_claim where id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(after.rows[0]).toMatchObject({ policy_version: 7, proration_enabled: false });
  });

  it("refuses a refund the policy disallows, creating no obligation", async () => {
    const fixture = await seed({ refundAllowed: false });
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "LOST_BENEFITS",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 18 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");
    const snapshot = await sql<{ refund_allowed: boolean }>`
      select refund_allowed from warranty_claim where id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(snapshot.rows[0]!.refund_allowed).toBe(false);

    await verifyClaimDefect(admin(opened.claimId));
    expect(await approveClaimRefund(admin(opened.claimId))).toMatchObject({
      ok: false,
      code: "NOT_ALLOWED_BY_POLICY",
    });
    const obligations = await sql<{ n: string }>`
      select count(*)::text as n from shop_refund_obligation
    `.execute(ctx.handle.db);
    expect(obligations.rows[0]!.n).toBe("0");
    const claim = await sql<{ status: string }>`
      select status from warranty_claim where id = ${opened.claimId}
    `.execute(ctx.handle.db);
    expect(claim.rows[0]!.status).toBe("VERIFIED_DEFECT");
  });

  it("refuses to open a claim on a variant that has no warranty", async () => {
    const fixture = await seed({ warrantyEnabled: false });
    const result = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "OTHER",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + DAY),
    });
    expect(result).toMatchObject({ ok: false, code: "WARRANTY_NOT_ENABLED" });
  });

  it("denies a non-root actor every resolution action", async () => {
    const fixture = await seed();
    const opened = await openWarrantyClaim({
      db: ctx.handle.db,
      customerId: fixture.customerId,
      orderId: fixture.orderId,
      assetId: fixture.assetId,
      issueType: "OTHER",
      correlationId: "t",
      now: new Date(fixture.completedAt.getTime() + 3 * DAY),
    });
    if (!opened.ok) throw new Error("claim not opened");
    const stranger = {
      db: ctx.handle.db,
      actor: { numericUserId: 999, chatType: "private" as const },
      config: rootConfig,
      claimId: opened.claimId,
      correlationId: "t",
    };
    expect(await verifyClaimDefect(stranger)).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(await approveClaimRefund(stranger)).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(await markRefundPaid(stranger)).toMatchObject({ ok: false, code: "NOT_ROOT_ADMIN" });
    expect(await rejectClaim({ ...stranger, reason: "no" })).toMatchObject({
      ok: false,
      code: "NOT_ROOT_ADMIN",
    });
  });
});
