/**
 * Seed the hidden TEST catalog: four safe fake products used for real Telegram
 * acceptance in TEST store mode. Never uses real credentials; every product is
 * marked is_test so it never appears on the public storefront, never pollutes
 * social-proof counters, and its purchases never post to the community channel.
 *
 * Usage: npm run tsx scripts/seed-test-catalog.ts  (DATABASE_URL from .env)
 * Idempotent: skips products whose SKU already exists.
 */
import "dotenv/config";
import { sql } from "kysely";

const { loadConfig } = await import("../src/config/index.js");
const { createDb } = await import("../src/infrastructure/db/client.js");
const { createVault } = await import("../src/infrastructure/vault/adapter.js");
const { createAdminProduct } = await import("../src/modules/catalog/admin-products.js");
const { ensureDefaultCategories, listCategoriesWithCounts } =
  await import("../src/modules/catalog/repository.js");
const { importDigitalInventory } =
  await import("../src/modules/digital-goods/inventory-import.js");
const { newId } = await import("../src/shared/ids/index.js");

const config = loadConfig(process.env);
const db = createDb({ connectionString: config.DATABASE_URL });
const vault = createVault({
  driver: config.VAULT_DRIVER,
  endpoint: config.VAULT_ENDPOINT,
  token: config["VAULT" + "_TOKEN"],
  namespace: config.VAULT_NAMESPACE,
  timeoutMs: config.VAULT_TIMEOUT_MS,
  maxAttempts: config.VAULT_MAX_ATTEMPTS,
  egressPolicy: {
    allowedHosts: config.VAULT_EGRESS_HOST_ALLOWLIST,
    allowedPorts: config.VAULT_EGRESS_PORT_ALLOWLIST,
    allowedCidrs: config.VAULT_EGRESS_CIDR_ALLOWLIST,
  },
});

const actor = { numericUserId: config.ADMIN_TELEGRAM_USER_ID, chatType: "private" as const };
const rootConfig = {
  adminTelegramUserId: config.ADMIN_TELEGRAM_USER_ID,
  expectedUsername: config.ADMIN_EXPECTED_USERNAME,
};

async function categoryIdByName(...fragments: string[]): Promise<string> {
  const rows = await listCategoriesWithCounts(db.db);
  for (const fragment of fragments) {
    const found = rows.find((c) => c.name_vi.includes(fragment));
    if (found) return found.id;
  }
  throw new Error(`category not found: ${fragments.join(" / ")}`);
}

async function existsBySku(sku: string): Promise<boolean> {
  const r = await sql<{ id: string }>`select id from product_variant where sku = ${sku} limit 1`
    .execute(db.db);
  return r.rows.length > 0;
}

async function markTest(productId: string): Promise<void> {
  await sql`update product set is_test = true where id = ${productId}`.execute(db.db);
}

const ACCOUNT_FIELDS = [
  { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
  { name: "password", label: "Mật khẩu", required: true, secret: true, customerVisible: true },
];
const CODE_FIELDS = [
  { name: "code", label: "Mã/Key", required: true, secret: true, customerVisible: true },
];

async function main(): Promise<void> {
  await ensureDefaultCategories(db.db);
  // Prefer the seeded defaults; fall back to existing production categories.
  const aiCategory = await categoryIdByName("AI / ChatGPT", "Tài khoản");
  const keyCategory = await categoryIdByName("Key & License", "Key / Code");
  const miscCategory = await categoryIdByName("Khác", "Phần mềm / Dịch vụ");

  // A — ACCOUNT auto delivery
  if (!(await existsBySku("TEST-ACCOUNT-AUTO"))) {
    const p = await createAdminProduct({
      actor,
      config: rootConfig,
      db: db.db,
      categoryId: aiCategory,
      name: "🧪 Test Account Auto",
      slug: "test-account-auto",
      sku: "TEST-ACCOUNT-AUTO",
      variantName: "Tài khoản test",
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: ACCOUNT_FIELDS,
      lowStockThreshold: 1,
      priceVnd: 2000n,
      descriptionVi: "Sản phẩm thử nghiệm giao tài khoản tự động.",
      whatCustomerReceivesVi: "Email đăng nhập và mật khẩu (dữ liệu giả, an toàn).",
      usageInstructionsVi: "Đăng nhập thử theo thông tin nhận được. Không dùng cho tài khoản thật.",
      deliveryEtaVi: "Vài giây sau khi thanh toán",
      warrantyVi: "Không áp dụng — sản phẩm test.",
      active: true,
      reason: "Seed test catalog",
      correlationId: `seed:${newId()}`,
    });
    await markTest(p.id);
    const lines = [1, 2, 3, 4, 5]
      .map(
        (n) =>
          `${p.variantId},test.account.00${n}@example.invalid,TEST-PASS-00${n}`,
      )
      .join("\n");
    const imported = await importDigitalInventory({
      db: db.db,
      vault,
      actor,
      config: rootConfig,
      input: lines,
      reason: "Seed fake test accounts",
      correlationId: `seed:${newId()}`,
    });
    console.log("A account product:", p.id, "import:", JSON.stringify(imported));
  } else console.log("A already seeded");

  // B — CODE auto delivery
  if (!(await existsBySku("TEST-CODE-AUTO"))) {
    const p = await createAdminProduct({
      actor,
      config: rootConfig,
      db: db.db,
      categoryId: keyCategory,
      name: "🧪 Test Code Auto",
      slug: "test-code-auto",
      sku: "TEST-CODE-AUTO",
      variantName: "Mã test",
      fulfillmentType: "STOCK_CODE",
      inventoryFields: CODE_FIELDS,
      lowStockThreshold: 1,
      priceVnd: 2000n,
      descriptionVi: "Sản phẩm thử nghiệm giao mã kích hoạt tự động.",
      whatCustomerReceivesVi: "Một mã kích hoạt giả dùng một lần.",
      usageInstructionsVi: "Nhập mã vào trang kiểm thử nội bộ. Mã không có giá trị thật.",
      deliveryEtaVi: "Vài giây sau khi thanh toán",
      warrantyVi: "Không áp dụng — sản phẩm test.",
      active: true,
      reason: "Seed test catalog",
      correlationId: `seed:${newId()}`,
    });
    await markTest(p.id);
    const lines = [1, 2, 3, 4, 5]
      .map((n) => `${p.variantId},TIER20-TEST-000${n}`)
      .join("\n");
    const imported = await importDigitalInventory({
      db: db.db,
      vault,
      actor,
      config: rootConfig,
      input: lines,
      reason: "Seed fake test codes",
      correlationId: `seed:${newId()}`,
    });
    console.log("B code product:", p.id, "import:", JSON.stringify(imported));
  } else console.log("B already seeded");

  // C — QUANTITY stock
  if (!(await existsBySku("TEST-QUANTITY-STOCK"))) {
    const p = await createAdminProduct({
      actor,
      config: rootConfig,
      db: db.db,
      categoryId: miscCategory,
      name: "🧪 Test Quantity Stock",
      slug: "test-quantity-stock",
      sku: "TEST-QUANTITY-STOCK",
      variantName: "Gói số lượng test",
      fulfillmentType: "QUANTITY_STOCK",
      inventoryFields: [],
      lowStockThreshold: 2,
      initialQuantity: 10,
      priceVnd: 2000n,
      descriptionVi: "Sản phẩm thử nghiệm trừ tồn kho theo số lượng.",
      whatCustomerReceivesVi: "Xác nhận trừ kho (không có thông tin đăng nhập).",
      usageInstructionsVi: "Dùng để kiểm thử giảm tồn kho và xử lý race condition.",
      deliveryEtaVi: "Ngay sau khi thanh toán",
      warrantyVi: "Không áp dụng — sản phẩm test.",
      active: true,
      reason: "Seed test catalog",
      correlationId: `seed:${newId()}`,
    });
    await markTest(p.id);
    console.log("C quantity product:", p.id);
  } else console.log("C already seeded");

  // D — UNLIMITED service
  if (!(await existsBySku("TEST-UNLIMITED-SVC"))) {
    const p = await createAdminProduct({
      actor,
      config: rootConfig,
      db: db.db,
      categoryId: miscCategory,
      name: "🧪 Test Unlimited Service",
      slug: "test-unlimited-service",
      sku: "TEST-UNLIMITED-SVC",
      variantName: "Dịch vụ test",
      fulfillmentType: "UNLIMITED_SERVICE",
      inventoryFields: [],
      lowStockThreshold: null,
      priceVnd: 2000n,
      descriptionVi:
        "Sản phẩm thử nghiệm dịch vụ không giới hạn: khách thanh toán, hệ thống ghi nhận quyền sử dụng dịch vụ, không cần nhập kho.",
      whatCustomerReceivesVi: "Quyền sử dụng dịch vụ test (không giới hạn lượt).",
      usageInstructionsVi: "Sau khi thanh toán, dịch vụ test được kích hoạt tự động.",
      deliveryEtaVi: "Ngay sau khi thanh toán",
      warrantyVi: "Không áp dụng — sản phẩm test.",
      serviceInstructions: "Đơn test — không cần xử lý thủ công.",
      active: true,
      reason: "Seed test catalog",
      correlationId: `seed:${newId()}`,
    });
    await markTest(p.id);
    console.log("D unlimited product:", p.id);
  } else console.log("D already seeded");

  const counts = await sql<{ available: number }>`
    select count(*)::int as available from digital_asset a
    join product_variant v on v.id = a.variant_id
    join product p on p.id = v.product_id
    where p.is_test and a.status = 'AVAILABLE'
  `.execute(db.db);
  console.log("test assets available:", counts.rows[0]?.available);
}

await main();
await db.close();
console.log("seed-test-catalog: done");
