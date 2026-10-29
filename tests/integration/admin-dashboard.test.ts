import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { getAdminDashboardMetrics } from "../../src/modules/admin/dashboard.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

let ctx: PgTestContext;

const DASHBOARD_NOW = new Date("2026-09-10T18:00:00.000Z");
const VN_DAY_START = new Date("2026-09-10T17:00:00.000Z");
const VN_NEXT_DAY_START = new Date("2026-09-11T17:00:00.000Z");

type FulfillmentType =
  | "STOCK_ACCOUNT"
  | "STOCK_CODE"
  | "QUANTITY_STOCK"
  | "DIGITAL_FILE"
  | "MANUAL_FULFILLMENT"
  | "UNLIMITED_SERVICE"
  | "SUPPLIER_API";

type ProductFixture = { productId: string; variantId: string };

type OrderInput = {
  customerId: string;
  variantId: string;
  status: string;
  priceVnd?: number;
  createdAt?: Date;
  paidAt?: Date | null;
};

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table
      test_customer_allowlist,
      shop_refund_obligation,
      warranty_claim_event,
      warranty_claim,
      manual_fulfillment_task,
      delivery_notification_handoff,
      delivery_bundle,
      delivery_session,
      digital_asset,
      variant_file_artifact,
      variant_quantity_stock,
      quantity_stock_ledger,
      variant_service_fulfillment,
      preorder_reservation,
      support_ticket,
      channel_identity,
      outbox_event,
      "order",
      product_variant,
      product,
      category,
      customer
    cascade
  `.execute(ctx.db);
});

async function insertCategory(isActive = true): Promise<string> {
  const id = newId();
  await sql`
    insert into category (id, name_vi, slug, is_active, sort_order)
    values (${id}, 'Dashboard fixture', ${`dashboard-${id}`}, ${isActive}, 1)
  `.execute(ctx.db);
  return id;
}

async function insertCustomer(): Promise<string> {
  const id = newId();
  await sql`
    insert into customer (id, status, locale)
    values (${id}, 'ACTIVE', 'vi')
  `.execute(ctx.db);
  return id;
}

async function insertProduct(
  categoryId: string,
  fulfillmentType: FulfillmentType,
  options: {
    isActive?: boolean;
    isTest?: boolean;
    isArchived?: boolean;
    lowStockThreshold?: number | null;
    nameVi?: string;
  } = {},
): Promise<ProductFixture> {
  const productId = newId();
  const variantId = newId();
  const deliveryType =
    fulfillmentType === "STOCK_ACCOUNT"
      ? "CREDENTIAL"
      : fulfillmentType === "STOCK_CODE" || fulfillmentType === "DIGITAL_FILE"
        ? "LICENSE"
        : "MANUAL_REVIEW";
  const stockPolicy = fulfillmentType === "SUPPLIER_API" ? "SUPPLIER_ONLY" : "LOCAL_ONLY";

  await sql`
    insert into product (
      id, category_id, name_vi, slug, is_active, sort_order, is_test, is_archived
    ) values (
      ${productId}, ${categoryId}, ${options.nameVi ?? "Dashboard product"}, ${`product-${productId}`},
      ${options.isActive ?? true}, 1, ${options.isTest ?? false}, ${options.isArchived ?? false}
    )
  `.execute(ctx.db);
  await sql`
    insert into product_variant (
      id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
      stock_policy, resale_evidence_id, fulfillment_type, low_stock_threshold
    ) values (
      ${variantId}, ${productId}, ${`SKU-${variantId}`}, 'Dashboard variant', 1000, 'P1M',
      ${deliveryType}, ${stockPolicy}, 'fixture-evidence', ${fulfillmentType},
      ${options.lowStockThreshold ?? null}
    )
  `.execute(ctx.db);
  return { productId, variantId };
}

async function insertDigitalAsset(variantId: string): Promise<string> {
  const id = newId();
  await sql`
    insert into digital_asset (
      id, variant_id, source_type, vault_ref, fingerprint_hash, status
    ) values (
      ${id}, ${variantId}, 'FIXTURE', ${`vault-${id}`}, ${`fingerprint-${id}`}, 'AVAILABLE'
    )
  `.execute(ctx.db);
  return id;
}

async function insertDigitalAssets(variantId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push(await insertDigitalAsset(variantId));
  return ids;
}

async function insertQuantityStock(variantId: string, availableQuantity: number): Promise<void> {
  await sql`
    insert into variant_quantity_stock (variant_id, available_quantity)
    values (${variantId}, ${availableQuantity})
  `.execute(ctx.db);
}

async function insertFileArtifacts(variantId: string): Promise<void> {
  await sql`
    insert into variant_file_artifact (
      id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference, is_active
    ) values (
      ${newId()}, ${variantId}, 1, 'fixture.bin', 'application/octet-stream', 1,
      ${"a".repeat(64)}, 'fixture://active', true
    ), (
      ${newId()}, ${variantId}, 2, 'old-fixture.bin', 'application/octet-stream', 1,
      ${"b".repeat(64)}, 'fixture://inactive', false
    )
  `.execute(ctx.db);
}

async function insertOrder(input: OrderInput): Promise<string> {
  const id = newId();
  const createdAt = input.createdAt ?? new Date("2026-09-10T18:30:00.000Z");
  await sql`
    insert into "order" (
      id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, supplier_policy_snapshot, status,
      created_at, paid_at
    ) values (
      ${id}, ${`ORD-${id}`}, ${input.customerId}, ${input.variantId}, 'Dashboard product',
      'Dashboard variant', ${input.priceVnd ?? 1000}, 'P1M', 'MANUAL_REVIEW', 'LOCAL_ONLY',
      ${input.status}, ${createdAt.toISOString()}, ${input.paidAt ? input.paidAt.toISOString() : null}
    )
  `.execute(ctx.db);
  return id;
}

async function insertManualTask(
  orderId: string,
  customerId: string,
  variantId: string,
): Promise<void> {
  await sql`
    insert into manual_fulfillment_task (
      id, order_id, customer_id, variant_id, fulfillment_type, instructions, status
    ) values (
      ${newId()}, ${orderId}, ${customerId}, ${variantId}, 'MANUAL_FULFILLMENT',
      'Fixture task', 'OPEN'
    )
  `.execute(ctx.db);
}

async function insertWarrantyClaim(
  orderId: string,
  customerId: string,
  variantId: string,
  status: string,
): Promise<void> {
  const id = newId();
  await sql`
    insert into warranty_claim (
      id, claim_number, customer_id, order_id, variant_id, issue_type,
      reported_at, warranty_start, warranty_end, warranty_days, used_days, remaining_days,
      paid_amount_vnd, calculated_refund_vnd, status, review_sla_due_at
    ) values (
      ${id}, ${`BH-${id}`}, ${customerId}, ${orderId}, ${variantId}, 'OTHER',
      ${DASHBOARD_NOW.toISOString()}, ${DASHBOARD_NOW.toISOString()},
      ${VN_NEXT_DAY_START.toISOString()}, 1, 0, 1, 1000, 1000, ${status},
      ${VN_NEXT_DAY_START.toISOString()}
    )
  `.execute(ctx.db);
}

async function insertRefund(orderId: string, customerId: string): Promise<void> {
  await sql`
    insert into shop_refund_obligation (
      id, customer_id, amount_vnd, status, reason, created_by, order_id
    ) values (
      ${newId()}, ${customerId}, 1000, 'OPEN', 'Fixture refund', 'fixture', ${orderId}
    )
  `.execute(ctx.db);
}

async function insertSupportTicket(
  customerId: string,
  status: string,
  orderId: string | null,
): Promise<void> {
  await sql`
    insert into support_ticket (
      id, customer_id, order_id, reason_code, status, safe_summary, due_at
    ) values (
      ${newId()}, ${customerId}, ${orderId}, 'OTHER', ${status}, 'Fixture ticket', ${DASHBOARD_NOW.toISOString()}
    )
  `.execute(ctx.db);
}

async function allowlistCustomer(customerId: string, telegramUserId: string): Promise<void> {
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', ${telegramUserId})
  `.execute(ctx.db);
  await sql`
    insert into test_customer_allowlist (id, telegram_user_id, note, added_by)
    values (${newId()}, ${telegramUserId}, 'Dashboard fixture', 'fixture')
  `.execute(ctx.db);
}

async function insertUncertainDelivery(
  orderId: string,
  customerId: string,
  variantId: string,
  errorCode = "DELIVERY_UNCERTAIN",
): Promise<void> {
  const assetId = await insertDigitalAsset(variantId);
  const bundleId = newId();
  await sql`
    insert into delivery_bundle (
      id, order_id, customer_id, asset_id, token_hash, status, expires_at
    ) values (
      ${bundleId}, ${orderId}, ${customerId}, ${assetId}, ${`token-${bundleId}`},
      'EXPIRED', ${DASHBOARD_NOW.toISOString()}
    )
  `.execute(ctx.db);
  await sql`
    insert into delivery_notification_handoff (
      id, bundle_id, customer_id, telegram_chat_id, capability_key,
      payload_redacted, status, last_error_code
    ) values (
      ${newId()}, ${bundleId}, ${customerId}, ${`chat-${customerId}`}, ${`capability-${bundleId}`},
      '{}'::jsonb, 'DEAD', ${errorCode}
    )
  `.execute(ctx.db);
}

describe("admin dashboard read model", () => {
  it("filters test/archive trade and counts local stock at the Vietnam day boundary", async () => {
    const categoryId = await insertCategory();
    const inactiveCategoryId = await insertCategory(false);
    await insertProduct(inactiveCategoryId, "UNLIMITED_SERVICE");
    const realAccount = await insertProduct(categoryId, "STOCK_ACCOUNT", { lowStockThreshold: 3 });
    await insertProduct(categoryId, "STOCK_CODE");
    const realQuantity = await insertProduct(categoryId, "QUANTITY_STOCK", {
      lowStockThreshold: 5,
    });
    const realFile = await insertProduct(categoryId, "DIGITAL_FILE", { lowStockThreshold: 1 });
    const realManual = await insertProduct(categoryId, "MANUAL_FULFILLMENT");
    const realUnlimited = await insertProduct(categoryId, "UNLIMITED_SERVICE");
    const realSupplier = await insertProduct(categoryId, "SUPPLIER_API");
    await insertProduct(categoryId, "MANUAL_FULFILLMENT", { isActive: false });
    const testAccount = await insertProduct(categoryId, "STOCK_ACCOUNT", { isTest: true });
    const archivedAccount = await insertProduct(categoryId, "STOCK_ACCOUNT", { isArchived: true });
    const canaryProduct = await insertProduct(categoryId, "MANUAL_FULFILLMENT", {
      nameVi: "Canary dashboard service",
    });

    await insertDigitalAssets(realAccount.variantId, 2);
    await insertDigitalAssets(realManual.variantId, 3);
    await insertDigitalAssets(realUnlimited.variantId, 2);
    await insertDigitalAssets(realSupplier.variantId, 4);
    await insertDigitalAssets(testAccount.variantId, 9);
    await insertDigitalAssets(archivedAccount.variantId, 9);
    await insertQuantityStock(realQuantity.variantId, 4);
    await insertFileArtifacts(realFile.variantId);

    const realCustomerId = await insertCustomer();
    const testCustomerId = await insertCustomer();
    const archivedCustomerId = await insertCustomer();
    const yesterday = new Date("2026-09-10T16:59:59.000Z");
    const today = new Date("2026-09-10T18:30:00.000Z");

    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "COMPLETED",
      priceVnd: 50_000,
      createdAt: VN_DAY_START,
      paidAt: VN_DAY_START,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "COMPLETED",
      priceVnd: 100_000,
      createdAt: today,
      paidAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "PAID",
      priceVnd: 200_000,
      createdAt: today,
      paidAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "PROCESSING",
      priceVnd: 600_000,
      createdAt: today,
      paidAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "PENDING_PAYMENT",
      priceVnd: 300_000,
      createdAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "PAYMENT_NEEDS_REVIEW",
      priceVnd: 400_000,
      createdAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      priceVnd: 500_000,
      createdAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "COMPLETED",
      priceVnd: 900_000,
      createdAt: yesterday,
      paidAt: yesterday,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: realAccount.variantId,
      status: "COMPLETED",
      priceVnd: 1_000_000,
      createdAt: VN_NEXT_DAY_START,
      paidAt: VN_NEXT_DAY_START,
    });
    await insertOrder({
      customerId: testCustomerId,
      variantId: testAccount.variantId,
      status: "COMPLETED",
      priceVnd: 10_000_000,
      createdAt: today,
      paidAt: today,
    });
    await insertOrder({
      customerId: archivedCustomerId,
      variantId: archivedAccount.variantId,
      status: "COMPLETED",
      priceVnd: 20_000_000,
      createdAt: today,
      paidAt: today,
    });
    await insertOrder({
      customerId: realCustomerId,
      variantId: canaryProduct.variantId,
      status: "COMPLETED",
      priceVnd: 50_000_000,
      createdAt: today,
      paidAt: today,
    });

    const metrics = await getAdminDashboardMetrics(ctx.db, DASHBOARD_NOW);

    expect(metrics).toMatchObject({
      activeProducts: 7,
      outOfStock: 1,
      lowStock: 3,
      availableInventory: 7,
      ordersToday: 7,
      paidToday: 4,
      pendingPayment: 1,
      paymentReview: 1,
      fulfillmentFailures: 1,
      manualOpenTasks: 0,
      notificationSendUncertain: 0,
      warrantyNew: 0,
      refundDue: 0,
      supportOpenTickets: 0,
    });
    expect(metrics.revenueTodayVnd).toBe(950_000n);
  });

  it("keeps operator queues tied to real orders and excludes allowlisted uncertain sends", async () => {
    const categoryId = await insertCategory();
    const realProduct = await insertProduct(categoryId, "MANUAL_FULFILLMENT");
    const testProduct = await insertProduct(categoryId, "MANUAL_FULFILLMENT", { isTest: true });
    const archivedProduct = await insertProduct(categoryId, "MANUAL_FULFILLMENT", {
      isArchived: true,
    });
    const canaryProduct = await insertProduct(categoryId, "MANUAL_FULFILLMENT", {
      nameVi: "Canary dashboard service",
    });
    const realCustomerId = await insertCustomer();
    const testCustomerId = await insertCustomer();
    const archivedCustomerId = await insertCustomer();
    const allowlistedCustomerId = await insertCustomer();
    const orderlessCustomerId = await insertCustomer();
    const allowlistedOrderlessCustomerId = await insertCustomer();
    const canaryCustomerId = await insertCustomer();
    await allowlistCustomer(allowlistedCustomerId, "dashboard-allowlisted-order");
    await allowlistCustomer(allowlistedOrderlessCustomerId, "dashboard-allowlisted-ticket");

    const old = new Date("2026-09-01T12:00:00.000Z");
    const realOrderId = await insertOrder({
      customerId: realCustomerId,
      variantId: realProduct.variantId,
      status: "PROCESSING",
      createdAt: old,
    });
    const testOrderId = await insertOrder({
      customerId: testCustomerId,
      variantId: testProduct.variantId,
      status: "PROCESSING",
      createdAt: old,
    });
    const archivedOrderId = await insertOrder({
      customerId: archivedCustomerId,
      variantId: archivedProduct.variantId,
      status: "PROCESSING",
      createdAt: old,
    });
    const uncertainOrderId = await insertOrder({
      customerId: realCustomerId,
      variantId: realProduct.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      createdAt: old,
    });
    const allowlistedUncertainOrderId = await insertOrder({
      customerId: allowlistedCustomerId,
      variantId: realProduct.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      createdAt: old,
    });
    const testUncertainOrderId = await insertOrder({
      customerId: testCustomerId,
      variantId: testProduct.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      createdAt: old,
    });
    const archivedUncertainOrderId = await insertOrder({
      customerId: archivedCustomerId,
      variantId: archivedProduct.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      createdAt: old,
    });
    const canaryFulfillmentOrderId = await insertOrder({
      customerId: canaryCustomerId,
      variantId: canaryProduct.variantId,
      status: "FULFILLMENT_NEEDS_REVIEW",
      createdAt: old,
    });
    const canaryProcessingOrderId = await insertOrder({
      customerId: canaryCustomerId,
      variantId: canaryProduct.variantId,
      status: "PROCESSING",
      createdAt: old,
    });

    await insertManualTask(realOrderId, realCustomerId, realProduct.variantId);
    await insertManualTask(testOrderId, testCustomerId, testProduct.variantId);
    await insertManualTask(archivedOrderId, archivedCustomerId, archivedProduct.variantId);
    await insertManualTask(canaryProcessingOrderId, canaryCustomerId, canaryProduct.variantId);

    await insertWarrantyClaim(realOrderId, realCustomerId, realProduct.variantId, "SUBMITTED");
    await insertWarrantyClaim(realOrderId, realCustomerId, realProduct.variantId, "TRIAGE");
    await insertWarrantyClaim(testOrderId, testCustomerId, testProduct.variantId, "SUBMITTED");
    await insertWarrantyClaim(
      archivedOrderId,
      archivedCustomerId,
      archivedProduct.variantId,
      "SUBMITTED",
    );
    await insertWarrantyClaim(
      canaryFulfillmentOrderId,
      canaryCustomerId,
      canaryProduct.variantId,
      "SUBMITTED",
    );

    await insertRefund(realOrderId, realCustomerId);
    await insertRefund(testOrderId, testCustomerId);
    await insertRefund(archivedOrderId, archivedCustomerId);
    await insertRefund(canaryProcessingOrderId, canaryCustomerId);

    await insertSupportTicket(realCustomerId, "OPEN", realOrderId);
    await insertSupportTicket(realCustomerId, "MANUAL_REVIEW", realOrderId);
    await insertSupportTicket(realCustomerId, "WAITING_SHOP", realOrderId);
    await insertSupportTicket(realCustomerId, "WAITING_CUSTOMER", realOrderId);
    await insertSupportTicket(testCustomerId, "OPEN", testOrderId);
    await insertSupportTicket(archivedCustomerId, "OPEN", archivedOrderId);
    await insertSupportTicket(orderlessCustomerId, "OPEN", null);
    await insertSupportTicket(allowlistedOrderlessCustomerId, "OPEN", null);
    await insertSupportTicket(realCustomerId, "RESOLVED", realOrderId);
    await insertSupportTicket(allowlistedCustomerId, "OPEN", allowlistedUncertainOrderId);
    await insertSupportTicket(canaryCustomerId, "OPEN", canaryFulfillmentOrderId);

    await insertUncertainDelivery(uncertainOrderId, realCustomerId, realProduct.variantId);
    await insertUncertainDelivery(
      allowlistedUncertainOrderId,
      allowlistedCustomerId,
      realProduct.variantId,
    );
    await insertUncertainDelivery(testUncertainOrderId, testCustomerId, testProduct.variantId);
    await insertUncertainDelivery(
      archivedUncertainOrderId,
      archivedCustomerId,
      archivedProduct.variantId,
    );
    await insertUncertainDelivery(
      canaryFulfillmentOrderId,
      canaryCustomerId,
      canaryProduct.variantId,
    );
    const fileProduct = await insertProduct(categoryId, "DIGITAL_FILE", { isActive: false });
    const fileOrderId = await insertOrder({
      customerId: realCustomerId,
      variantId: fileProduct.variantId,
      status: "PROCESSING",
      createdAt: old,
    });
    const fileArtifactId = newId();
    const fileArtifactHash = "c".repeat(64);
    await sql`
      insert into variant_file_artifact
        (id, variant_id, version, filename, mime_type, size_bytes, sha256, storage_reference)
      values
        (${fileArtifactId}, ${fileProduct.variantId}, 1, 'uncertain.bin',
         'application/octet-stream', 1, ${fileArtifactHash}, 'fixture://uncertain')
    `.execute(ctx.db);
    await sql`
      insert into file_delivery_job
        (order_id, customer_id, variant_id, artifact_id, artifact_version, artifact_sha256,
         telegram_chat_id, status, last_error)
      values
        (${fileOrderId}, ${realCustomerId}, ${fileProduct.variantId}, ${fileArtifactId}, 1,
         ${fileArtifactHash}, '123456', 'FAILED', 'SEND_UNCERTAIN')
    `.execute(ctx.db);


    const metrics = await getAdminDashboardMetrics(ctx.db, DASHBOARD_NOW);

    expect(metrics).toMatchObject({
      activeProducts: 1,
      outOfStock: 0,
      lowStock: 0,
      availableInventory: 0,
      ordersToday: 0,
      paidToday: 0,
      pendingPayment: 0,
      paymentReview: 0,
      fulfillmentFailures: 3,
      manualOpenTasks: 2,
      notificationSendUncertain: 3,
      warrantyNew: 2,
      refundDue: 2,
      supportOpenTickets: 6,
    });
    expect(metrics.revenueTodayVnd).toBe(0n);
  });

  it("returns a bounded zero summary on an empty database", async () => {
    await expect(getAdminDashboardMetrics(ctx.db, DASHBOARD_NOW)).resolves.toEqual({
      activeProducts: 0,
      outOfStock: 0,
      lowStock: 0,
      availableInventory: 0,
      ordersToday: 0,
      paidToday: 0,
      revenueTodayVnd: 0n,
      pendingPayment: 0,
      paymentReview: 0,
      fulfillmentFailures: 0,
      manualOpenTasks: 0,
      notificationSendUncertain: 0,
      warrantyNew: 0,
      refundDue: 0,
      supportOpenTickets: 0,
    });
  });
});
