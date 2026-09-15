import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  DISCREPANCY_RESOLUTION_CODES,
  dispositionDiscrepancy,
  getAdminDiscrepancyDetail,
  isDiscrepancyResolutionCode,
  listAdminPaymentOps,
} from "../../src/modules/admin/payment-ops.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * Slice B — discrepancy evidence/disposition.
 *
 * What matters here: the operator sees masked evidence and never the raw bank
 * row; a disposition is allowlisted, version-guarded and idempotent; and the
 * canonical bank transaction is byte-for-byte unchanged by a resolution.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table discrepancy, bank_transaction, audit_event, payment_intent,
      "order", product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

const RAW_CONTENT = "NGUYEN VAN A CHUYEN TIEN MUA HANG ORD-999999999999";
const RAW_PROVIDER_TXN_ID = "webhook-92704-abcdef";
const RAW_REFERENCE = "FT24012345678";
const RAW_ACCOUNT = "merchant-account-778899";

interface Fixture {
  discrepancyId: string;
  bankTransactionId: string;
  orderId: string;
}

async function seedDiscrepancy(type = "LATE_PAYMENT"): Promise<Fixture> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const bankTransactionId = newId();
  const discrepancyId = newId();

  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${`c-${categoryId}`}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${`p-${productId}`}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${`SKU-${variantId}`}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status)
    values (${orderId}, ${`ORD-${orderId}`}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PENDING_PAYMENT')
  `.execute(ctx.db);
  await sql`
    insert into bank_transaction
      (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd,
       content, reference, transacted_at, raw_hash, signature_status, schema_version)
    values
      (${bankTransactionId}, 'sepay', ${`${RAW_PROVIDER_TXN_ID}-${bankTransactionId}`}, 'IN',
       ${RAW_ACCOUNT}, 100000,
       ${RAW_CONTENT}, ${RAW_REFERENCE}, now() - interval '2 hours', ${"a".repeat(64)},
       'VERIFIED', 'sepay.webhook.v1')
  `.execute(ctx.db);
  await sql`
    insert into discrepancy
      (id, type, bank_transaction_id, order_id, status, reason, owner)
    values
      (${discrepancyId}, ${type}, ${bankTransactionId}, ${orderId}, 'OPEN',
       'transfer after expiry', 'payments')
  `.execute(ctx.db);

  return { discrepancyId, bankTransactionId, orderId };
}

async function bankFingerprint(bankTransactionId: string): Promise<string | undefined> {
  const row = await sql<{ fingerprint: string }>`
    select md5(bt::text) as fingerprint from bank_transaction bt where bt.id = ${bankTransactionId}
  `.execute(ctx.db);
  return row.rows[0]?.fingerprint;
}

async function auditRows(targetId: string) {
  const rows = await sql<{
    action: string;
    reason: string;
    metadata_redacted: Record<string, unknown>;
  }>`
    select action, reason, metadata_redacted from audit_event
    where target_type = 'Discrepancy' and target_id = ${targetId}
    order by occurred_at asc
  `.execute(ctx.db);
  return rows.rows;
}

async function discrepancyStatus(id: string) {
  const row = await sql<{
    status: string;
    resolution_code: string | null;
    version: number;
    resolved_at: Date | null;
  }>`
    select status, resolution_code, version, resolved_at from discrepancy where id = ${id}
  `.execute(ctx.db);
  return row.rows[0]!;
}

describe("admin discrepancy detail", () => {
  it("masks bank identifiers and bounds the customer transfer text", async () => {
    const f = await seedDiscrepancy();
    const detail = await getAdminDiscrepancyDetail(ctx.db, f.discrepancyId);
    expect(detail).not.toBeNull();
    if (!detail) throw new Error("detail missing");

    expect(detail.classification).toBe("LATE_PAYMENT");
    expect(detail.classificationKnown).toBe(true);
    expect(detail.status).toBe("OPEN");
    expect(detail.version).toBe(1);

    const serialized = JSON.stringify(detail, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain(RAW_PROVIDER_TXN_ID);
    expect(serialized).not.toContain(RAW_REFERENCE);
    expect(serialized).not.toContain(RAW_ACCOUNT);
    expect(serialized).not.toContain(RAW_CONTENT);

    // Only the last four characters of an opaque id ever reach the screen, and
    // the masking is bounded regardless of how long the identifier is.
    const masked = detail.evidence!.providerTransactionIdMasked;
    expect(masked.startsWith("•")).toBe(true);
    expect(masked.length - masked.replace(/^•+/, "").length).toBeLessThanOrEqual(12);
    expect(detail.evidence!.referenceMasked?.endsWith("5678")).toBe(true);
    expect(detail.evidence!.merchantAccountMasked.endsWith("8899")).toBe(true);
    // Bounded: the raw content is longer than the summary window.
    expect(detail.evidence?.transferContentSummary?.length).toBe(41);
    expect(detail.evidence?.transferContentSummary?.endsWith("…")).toBe(true);
    // Evidence is reported as immutable; the canonical row is never rewritten.
    expect(detail.evidence?.immutable).toBe(true);
  });

  it("returns null for an unknown or malformed id", async () => {
    expect(await getAdminDiscrepancyDetail(ctx.db, newId())).toBeNull();
    expect(await getAdminDiscrepancyDetail(ctx.db, "not-an-id")).toBeNull();
  });

  it("masks the evidence id in the queue row as well as the detail", async () => {
    const f = await seedDiscrepancy();
    const page = await listAdminPaymentOps(ctx.db, "discrepancy");
    const row = page.rows.find((r) => r.id === f.discrepancyId);
    expect(row).toBeDefined();
    expect(row!.detail).not.toContain(f.bankTransactionId);
    expect(row!.detail).toContain("GD •");
  });
});

describe("discrepancy disposition", () => {
  it("accepts only allowlisted resolution codes", () => {
    for (const code of DISCREPANCY_RESOLUTION_CODES) {
      expect(isDiscrepancyResolutionCode(code)).toBe(true);
    }
    expect(isDiscrepancyResolutionCode("FREE_TEXT_EVERYTHING")).toBe(false);
    expect(isDiscrepancyResolutionCode("")).toBe(false);
  });

  it("rejects an unknown code and a blank note without touching the row", async () => {
    const f = await seedDiscrepancy();
    const base = {
      discrepancyId: f.discrepancyId,
      expectedVersion: 1,
      requestId: newId(),
      actorId: "1001",
      correlationId: newId(),
    };

    const badCode = await dispositionDiscrepancy(ctx.db, {
      ...base,
      // A stored code outside the allowlist is exactly what the operator
      // vocabulary exists to prevent.
      resolutionCode: "FREE_TEXT_EVERYTHING" as never,
      note: "ghi chu hop le",
    });
    expect(badCode).toMatchObject({ ok: false, code: "INVALID_RESOLUTION_CODE" });

    const blankNote = await dispositionDiscrepancy(ctx.db, {
      ...base,
      resolutionCode: "MANUAL_SETTLE",
      note: "   ",
    });
    expect(blankNote).toMatchObject({ ok: false, code: "INVALID_NOTE" });

    const longNote = await dispositionDiscrepancy(ctx.db, {
      ...base,
      resolutionCode: "MANUAL_SETTLE",
      note: "x".repeat(201),
    });
    expect(longNote).toMatchObject({ ok: false, code: "INVALID_NOTE" });

    expect(await discrepancyStatus(f.discrepancyId)).toMatchObject({
      status: "OPEN",
      version: 1,
      resolved_at: null,
    });
    expect(await auditRows(f.discrepancyId)).toHaveLength(0);
  });

  it("resolves OPEN → RESOLVED once, audits the decision, and leaves the bank evidence untouched", async () => {
    const f = await seedDiscrepancy();
    const before = await bankFingerprint(f.bankTransactionId);

    const result = await dispositionDiscrepancy(ctx.db, {
      discrepancyId: f.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "MANUAL_SETTLE",
      note: "Đã liên hệ khách và ghi nhận thanh toán thủ công",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-1",
    });

    expect(result).toMatchObject({ ok: true, kind: "RESOLVED", version: 2 });
    expect(await discrepancyStatus(f.discrepancyId)).toMatchObject({
      status: "RESOLVED",
      resolution_code: "MANUAL_SETTLE",
      version: 2,
    });

    const audits = await auditRows(f.discrepancyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("discrepancy.resolve");
    expect(audits[0]?.metadata_redacted).toMatchObject({ resolutionCode: "MANUAL_SETTLE" });

    // Resolution is a status transition only: the provider evidence row is
    // byte-for-byte what it was before.
    expect(await bankFingerprint(f.bankTransactionId)).toBe(before);
  });

  it("is idempotent for the same request id and rejects a conflicting repeat", async () => {
    const f = await seedDiscrepancy();
    const requestId = newId();
    const input = {
      discrepancyId: f.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "MANUAL_REFUND" as const,
      note: "Khách đã được hoàn tiền",
      requestId,
      actorId: "1001",
      correlationId: "corr-replay",
    };

    const first = await dispositionDiscrepancy(ctx.db, input);
    expect(first).toMatchObject({ ok: true, kind: "RESOLVED", version: 2 });

    // A replayed confirmation carries the stale version it was built from; the
    // request id proves it is the same decision, so it succeeds without writing.
    const replay = await dispositionDiscrepancy(ctx.db, input);
    expect(replay).toMatchObject({ ok: true, kind: "REPLAYED", version: 2, auditEventId: null });
    expect(await discrepancyStatus(f.discrepancyId)).toMatchObject({ version: 2 });
    expect(await auditRows(f.discrepancyId)).toHaveLength(1);

    const conflicting = await dispositionDiscrepancy(ctx.db, {
      ...input,
      resolutionCode: "NO_ACTION_REQUIRED",
      note: "Kết luận khác",
    });
    expect(conflicting).toMatchObject({ ok: false, code: "CONFLICTING_REPEAT" });
    expect(await discrepancyStatus(f.discrepancyId)).toMatchObject({
      resolution_code: "MANUAL_REFUND",
      version: 2,
    });
  });

  it("rejects a stale version and a second, different confirmation", async () => {
    const f = await seedDiscrepancy();
    await dispositionDiscrepancy(ctx.db, {
      discrepancyId: f.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "NO_ACTION_REQUIRED",
      note: "Bằng chứng đã được đối soát",
      requestId: newId(),
      actorId: "1001",
      correlationId: "corr-a",
    });

    const stale = await dispositionDiscrepancy(ctx.db, {
      discrepancyId: f.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "MANUAL_SETTLE",
      note: "Đối soát lần hai",
      requestId: newId(),
      actorId: "1002",
      correlationId: "corr-b",
    });
    expect(stale).toMatchObject({ ok: false, code: "ALREADY_RESOLVED" });

    const openOther = await seedDiscrepancy("UNMATCHED");
    const staleOnOpen = await dispositionDiscrepancy(ctx.db, {
      discrepancyId: openOther.discrepancyId,
      expectedVersion: 99,
      resolutionCode: "MANUAL_SETTLE",
      note: "Đối soát",
      requestId: newId(),
      actorId: "1002",
      correlationId: "corr-c",
    });
    expect(staleOnOpen).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await discrepancyStatus(openOther.discrepancyId)).toMatchObject({
      status: "OPEN",
      version: 1,
    });
  });

  it("rejects a request id already used on another discrepancy", async () => {
    const first = await seedDiscrepancy();
    const second = await seedDiscrepancy("UNMATCHED");
    const requestId = newId();

    const resolved = await dispositionDiscrepancy(ctx.db, {
      discrepancyId: first.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "ESCALATED",
      note: "Chuyển kỹ thuật kiểm tra",
      requestId,
      actorId: "1001",
      correlationId: "corr-d",
    });
    expect(resolved.ok).toBe(true);

    const reused = await dispositionDiscrepancy(ctx.db, {
      discrepancyId: second.discrepancyId,
      expectedVersion: 1,
      resolutionCode: "ESCALATED",
      note: "Chuyển kỹ thuật kiểm tra",
      requestId,
      actorId: "1001",
      correlationId: "corr-e",
    });
    expect(reused).toMatchObject({ ok: false, code: "CONFLICTING_REPEAT" });
    expect(await discrepancyStatus(second.discrepancyId)).toMatchObject({ status: "OPEN" });
  });
});
