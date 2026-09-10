import { describe, expect, it } from "vitest";
import { presentAdminProducts, type AdminProductView } from "../../src/bot/presenters/admin.js";

/**
 * The catalog list is how the owner reaches a product to edit it, so the filter and paging contract
 * is load-bearing: a label that maps to the wrong view, or a "Xem thêm" that loses the filter,
 * silently shows the wrong list. The dispatch side of this parse is pinned in
 * tests/integration/telegram-domain-dispatch.test.ts.
 */

const row = (
  overrides: Partial<{
    id: string;
    name: string;
    active: boolean;
    featured: boolean;
    test: boolean;
  }> = {},
) => ({
  id: "p1",
  name: "Claude Pro Chính Chủ",
  active: true,
  featured: false,
  test: false,
  ...overrides,
});

const viewButtons = (message: { buttons: Array<Array<{ callbackData: string }>> }) =>
  message.buttons.flat().filter((button) => button.callbackData.startsWith("admin:products:view:"));

describe("presentAdminProducts", () => {
  it("offers every other view as its own button, and never the one being shown", () => {
    const message = presentAdminProducts([row()], { view: "featured" });
    const callbacks = viewButtons(message).map((button) => button.callbackData);

    expect(callbacks).toContain("admin:products:view:all");
    expect(callbacks).toContain("admin:products:view:test");
    expect(callbacks).not.toContain("admin:products:view:featured");
  });

  it("keeps the active filter when offering the next page", () => {
    const message = presentAdminProducts([row()], { view: "test", page: 2, hasMore: true });
    const next = viewButtons(message).find((button) => button.callbackData.endsWith(":3"));

    expect(next?.callbackData).toBe("admin:products:view:test:3");
  });

  it("offers no next page when the page is not full", () => {
    const message = presentAdminProducts([row()], { view: "all", page: 1, hasMore: false });
    expect(viewButtons(message).some((button) => button.callbackData.endsWith(":2"))).toBe(false);
    expect(message.text).not.toContain("Xem thêm");
  });

  it("marks featured and test rows so the owner can tell them apart", () => {
    const message = presentAdminProducts([row({ featured: true, test: true })]);
    expect(message.text).toContain("⭐");
    expect(message.text).toContain("🧪");
  });

  it("says so plainly when a filter has no products", () => {
    const message = presentAdminProducts([], { view: "featured" });
    expect(message.text).toContain("Không có sản phẩm nào trong mục này.");
  });

  it("labels the view it is actually showing", () => {
    for (const view of ["all", "featured", "inactive", "archived", "test"] as AdminProductView[]) {
      expect(presentAdminProducts([row()], { view }).text).toContain("Đang xem:");
    }
  });
});
