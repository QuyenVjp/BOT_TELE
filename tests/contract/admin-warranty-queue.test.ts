import { describe, expect, it } from "vitest";
import { presentAdminWarrantyQueue } from "../../src/bot/presenters/warranty-admin.js";
import type {
  WarrantyQueueRow,
  WarrantyQueueView,
} from "../../src/bot/presenters/warranty-admin.js";

const COUNTS: Record<WarrantyQueueView, number> = {
  new: 1,
  verifying: 0,
  waiting_customer: 0,
  refund_due: 0,
  replacement: 0,
  done: 0,
  rejected: 0,
  overdue: 0,
};

const row = (overrides: Partial<WarrantyQueueRow> = {}): WarrantyQueueRow => ({
  claimId: "claim-1",
  claimNumber: "BH-AAAAAA",
  customerLabel: "Khách 1234",
  productName: "Sản phẩm",
  amountVnd: 2000n,
  statusLabel: "Mới",
  ...overrides,
});

describe("presentAdminWarrantyQueue", () => {
  it("gives every listed claim its own button, so a claim can actually be opened", () => {
    const message = presentAdminWarrantyQueue({
      view: "new",
      counts: COUNTS,
      rows: [row(), row({ claimId: "claim-2", claimNumber: "BH-BBBBBB" })],
    });

    const claimButtons = message.buttons
      .flat()
      .filter((button) => button.callbackData.startsWith("admin:warranty:claim:"));
    expect(claimButtons.map((button) => button.callbackData)).toEqual([
      "admin:warranty:claim:claim-1",
      "admin:warranty:claim:claim-2",
    ]);
  });

  it("keeps a view button with its counter for every view", () => {
    const message = presentAdminWarrantyQueue({ view: "new", counts: COUNTS, rows: [row()] });
    const viewButtons = message.buttons
      .flat()
      .filter((button) => button.callbackData.startsWith("admin:warranty:view:"));

    expect(viewButtons).toHaveLength(Object.keys(COUNTS).length);
    expect(viewButtons.map((button) => button.callbackData)).toContain(
      "admin:warranty:view:refund_due",
    );
  });

  it("says so plainly when a view is empty", () => {
    const message = presentAdminWarrantyQueue({ view: "overdue", counts: COUNTS, rows: [] });
    expect(message.text).toContain("Không có yêu cầu nào trong mục này.");
    expect(message.buttons.flat().some((button) => button.callbackData.includes(":claim:"))).toBe(
      false,
    );
  });
});
