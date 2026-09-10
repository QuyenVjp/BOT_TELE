import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createAdminProduct,
  updateAdminProduct,
  validateProductVisibilityInvariant,
} from "../../src/modules/catalog/admin-products.js";
import { startPostgres, type StartedPg } from "../helpers/pg-container.js";
import { newId } from "../../src/shared/ids/index.js";
import type { RootActor, RootAdminConfig } from "../../src/modules/identity/root-admin.js";

describe("product visibility invariant (security boundary)", () => {
  describe("validateProductVisibilityInvariant unit checks", () => {
    it("rejects isTest=true with PUBLIC visibility", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          isTest: true,
          active: true,
          visibility: "PUBLIC",
        }),
      ).toThrow(/INVALID_TEST_VISIBILITY/);
    });

    it("rejects isTest=true when active=true and visibility is not TEST_ONLY", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          isTest: true,
          active: true,
          visibility: "DRAFT",
        }),
      ).toThrow(/INVALID_TEST_VISIBILITY/);
    });

    it("rejects isArchived=true when active=true with PUBLIC visibility", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          isArchived: true,
          active: true,
          visibility: "PUBLIC",
        }),
      ).toThrow(/INVALID_ARCHIVED_VISIBILITY/);
    });

    it("rejects visibility=DRAFT when active=true", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          active: true,
          visibility: "DRAFT",
        }),
      ).toThrow(/INVALID_DRAFT_STATE/);
    });

    it("accepts test-only active product with TEST_ONLY visibility", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          isTest: true,
          active: true,
          visibility: "TEST_ONLY",
        }),
      ).not.toThrow();
    });

    it("accepts normal public product with PUBLIC visibility", () => {
      expect(() =>
        validateProductVisibilityInvariant({
          isTest: false,
          active: true,
          visibility: "PUBLIC",
        }),
      ).not.toThrow();
    });
  });

  describe("direct service caller security enforcement", () => {
    let pg: StartedPg;
    const ROOT_ID = 6659186592;
    const actor: RootActor = { numericUserId: ROOT_ID, chatType: "private" };
    const config: RootAdminConfig = {
      adminTelegramUserId: ROOT_ID,
      expectedUsername: "Quyenvjp",
    };
    let categoryId: string;

    beforeAll(async () => {
      pg = await startPostgres();
      categoryId = newId();
      await sql`
        insert into category (id, name_vi, slug, is_active, sort_order)
        values (${categoryId}, 'Test Category', 'test-cat', true, 1)
      `.execute(pg.handle.db);
    });

    afterAll(async () => {
      await pg?.stop();
    });

    it("rejects direct createAdminProduct attempting isTest=true, active=true, visibility=PUBLIC", async () => {
      await expect(
        createAdminProduct({
          actor,
          config,
          db: pg.handle.db,
          categoryId,
          name: "Direct Exploit Product",
          slug: "direct-exploit-product",
          sku: "DIRECT-EXPLOIT-001",
          variantName: "1 tháng",
          priceVnd: 2000n,
          fulfillmentType: "STOCK_ACCOUNT",
          inventoryFields: [
            { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
          ],
          lowStockThreshold: 3,
          isTest: true,
          active: true,
          visibility: "PUBLIC",
          reason: "Attempt direct public test product exploit",
          correlationId: "sec-test:direct-create-fail",
        }),
      ).rejects.toThrow(/INVALID_TEST_VISIBILITY/);
    });

    it("allows direct createAdminProduct with valid TEST_ONLY visibility", async () => {
      const created = await createAdminProduct({
        actor,
        config,
        db: pg.handle.db,
        categoryId,
        name: "Legit Test Product",
        slug: "legit-test-product",
        sku: "LEGIT-TEST-001",
        variantName: "1 tháng",
        priceVnd: 2000n,
        fulfillmentType: "STOCK_ACCOUNT",
        inventoryFields: [
          { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
        ],
        lowStockThreshold: 3,
        isTest: true,
        active: true,
        visibility: "TEST_ONLY",
        reason: "Legitimate test product creation",
        correlationId: "sec-test:direct-create-ok",
      });

      expect(created.sku).toBe("LEGIT-TEST-001");
      const row = (
        await sql<{ is_test: boolean; is_active: boolean }>`
          select is_test, is_active from product where id = ${created.id}
        `.execute(pg.handle.db)
      ).rows[0];

      expect(row?.is_test).toBe(true);
      expect(row?.is_active).toBe(true);

      // Verify direct update attempting isTest=true, active=true, visibility=PUBLIC is rejected
      await expect(
        updateAdminProduct({
          actor,
          config,
          db: pg.handle.db,
          productId: created.id,
          expectedVersion: 1,
          isTest: true,
          active: true,
          visibility: "PUBLIC",
          reason: "Attempt direct update exploit",
          correlationId: "sec-test:direct-update-fail",
        }),
      ).rejects.toThrow(/INVALID_TEST_VISIBILITY/);

      // Verify legitimate update with TEST_ONLY succeeds
      const updated = await updateAdminProduct({
        actor,
        config,
        db: pg.handle.db,
        productId: created.id,
        expectedVersion: 1,
        name: "Updated Legit Test Product",
        isTest: true,
        active: true,
        visibility: "TEST_ONLY",
        reason: "Legitimate test product update",
        correlationId: "sec-test:direct-update-ok",
      });
      expect(updated).toBe(true);
    });

    it("rejects partial update on existing test product attempting PUBLIC visibility without passing isTest", async () => {
      const created = await createAdminProduct({
        actor,
        config,
        db: pg.handle.db,
        categoryId,
        name: "Test Product For Partial Update",
        slug: "test-prod-partial-update",
        sku: "TEST-PARTIAL-001",
        variantName: "1 tháng",
        priceVnd: 2000n,
        fulfillmentType: "STOCK_ACCOUNT",
        inventoryFields: [
          { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
        ],
        lowStockThreshold: 3,
        isTest: true,
        active: true,
        visibility: "TEST_ONLY",
        reason: "Create test product for partial update check",
        correlationId: "sec-test:partial-test-setup",
      });

      // Attempt partial update with visibility=PUBLIC and active=true, but omitting isTest.
      // Merged validation must load existing is_test=true and reject the update.
      await expect(
        updateAdminProduct({
          actor,
          config,
          db: pg.handle.db,
          productId: created.id,
          expectedVersion: 1,
          active: true,
          visibility: "PUBLIC",
          reason: "Attempt partial update bypass",
          correlationId: "sec-test:partial-test-fail",
        }),
      ).rejects.toThrow(/INVALID_TEST_VISIBILITY/);
    });

    it("rejects partial update on existing archived product attempting active=true without unarchiving", async () => {
      const created = await createAdminProduct({
        actor,
        config,
        db: pg.handle.db,
        categoryId,
        name: "Archived Product For Partial Update",
        slug: "archived-prod-partial-update",
        sku: "ARCHIVED-PARTIAL-001",
        variantName: "1 tháng",
        priceVnd: 2000n,
        fulfillmentType: "STOCK_ACCOUNT",
        inventoryFields: [
          { name: "email", label: "Email", required: true, secret: false, customerVisible: true },
        ],
        lowStockThreshold: 3,
        isTest: false,
        active: false,
        isArchived: true,
        visibility: "DRAFT",
        reason: "Create archived product for partial update check",
        correlationId: "sec-test:archived-setup",
      });

      // Attempt partial update with active=true, omitting isArchived.
      // Merged validation must load existing is_archived=true and reject the update.
      await expect(
        updateAdminProduct({
          actor,
          config,
          db: pg.handle.db,
          productId: created.id,
          expectedVersion: 1,
          active: true,
          visibility: "PUBLIC",
          reason: "Attempt activating archived product",
          correlationId: "sec-test:archived-fail",
        }),
      ).rejects.toThrow(/INVALID_ARCHIVED_VISIBILITY/);
    });
  });
});
