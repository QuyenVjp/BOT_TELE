import { describe, expect, it } from "vitest";
import {
  presentAdminManualTaskDetail,
  presentAdminManualTasks,
} from "../../src/bot/presenters/manual-fulfillment.js";
import type { ManualFulfillmentTask } from "../../src/modules/digital-goods/manual-fulfillment.js";

const sampleTask = (overrides: Partial<ManualFulfillmentTask> = {}): ManualFulfillmentTask => ({
  id: "task-12345678",
  orderId: "ord-87654321",
  customerId: "cust-1",
  variantId: "var-1",
  fulfillmentType: "MANUAL_FULFILLMENT",
  status: "OPEN",
  instructions: "Provision manually for customer.",
  completedBy: null,
  completedAt: null,
  completionCorrelationId: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("presentAdminManualTasks", () => {
  it("renders natural Vietnamese home button and 1-per-row item list", () => {
    const message = presentAdminManualTasks([
      sampleTask({ id: "t1", orderId: "ord-00000001" }),
      sampleTask({ id: "t2", orderId: "ord-00000002" }),
    ]);

    expect(message.text).toContain("🛠 Xử lý thủ công");
    expect(message.buttons).toHaveLength(3);
    expect(message.buttons[0]).toHaveLength(1);
    expect(message.buttons[0]![0]).toMatchObject({
      callbackData: "admin:manual:view:t1",
    });
    expect(message.buttons[1]).toHaveLength(1);
    expect(message.buttons[1]![0]).toMatchObject({
      callbackData: "admin:manual:view:t2",
    });
    expect(message.buttons[2]).toEqual([{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]);
  });
});

describe("presentAdminManualTaskDetail", () => {
  it("keeps completion action full-width and pairs navigation in a single row", () => {
    const message = presentAdminManualTaskDetail({
      task: sampleTask(),
      confirmationStateId: "confirm-123",
    });

    expect(message.text).toContain("🛠 Tác vụ xử lý thủ công");
    // Row 0: Full-width complete action (high risk / mutation)
    expect(message.buttons[0]).toHaveLength(1);
    expect(message.buttons[0]![0]).toEqual({
      text: "✅ Hoàn tất (cần xác nhận)",
      callbackData: "admin:manual:complete:confirm-123",
    });
    // Row 1: Paired navigation
    expect(message.buttons[1]).toEqual([
      { text: "↩️ Danh sách", callbackData: "admin:manual" },
      { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
    ]);
  });

  it("omits completion button when task is completed and only renders paired navigation", () => {
    const message = presentAdminManualTaskDetail({
      task: sampleTask({ status: "COMPLETED" }),
    });

    expect(message.buttons).toHaveLength(1);
    expect(message.buttons[0]).toEqual([
      { text: "↩️ Danh sách", callbackData: "admin:manual" },
      { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
    ]);
  });
});
