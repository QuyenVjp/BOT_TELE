import { describe, expect, it } from "vitest";
import {
  presentAdminManualTaskDetail,
  presentAdminManualTasks,
} from "../../src/bot/presenters/manual-fulfillment.js";
import type { AdminManualFulfillmentTask } from "../../src/modules/digital-goods/manual-fulfillment.js";
const MAX_PRODUCT_NAME = "P".repeat(2000);
const MAX_VARIANT_NAME = "V".repeat(2000);
const MAX_CUSTOMER_NAME = "C".repeat(2000);
const INSTRUCTION_PREFIX = "SERVICE_INSTRUCTIONS_PREFIX:";
const MAX_SERVICE_INSTRUCTIONS = `${INSTRUCTION_PREFIX}${"I".repeat(2000 - INSTRUCTION_PREFIX.length)}`;

const sampleTask = (
  overrides: Partial<AdminManualFulfillmentTask> = {},
): AdminManualFulfillmentTask => ({
  taskId: "internal-task-id",
  orderId: "internal-order-id",
  orderNumber: "ORD-12345678",
  customerName: "Nguyễn An",
  productName: "Kling AI",
  variantName: "Gói Premier",
  amountVnd: "230000",
  createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  status: "OPEN",
  fulfillmentType: "MANUAL_FULFILLMENT",
  instructions: "Provision manually after checking customer account.",
  taskVersion: 2,
  orderVersion: 4,
  expectedVersion: "4:2",
  ...overrides,
});

describe("presentAdminManualTasks", () => {
  it("renders oldest-first page details and safe callback identifiers", () => {
    const message = presentAdminManualTasks({
      tasks: [
        sampleTask({ taskId: "t1", orderNumber: "ORD-00000001" }),
        sampleTask({ taskId: "t2", orderNumber: "ORD-00000002" }),
      ],
      offset: 0,
      hasMore: false,
    });

    expect(message.text).toContain("🛠 Hàng chờ xử lý thủ công");
    expect(message.text).toContain("ORD-00000001");
    expect(message.text).toContain("230.000 ₫");
    expect(message.buttons).toHaveLength(3);
    expect(message.buttons[0]).toEqual([
      { text: "Đang chờ · ORD-00000001", callbackData: "admin:manual:view:t1" },
    ]);
    expect(message.buttons[1]).toEqual([
      { text: "Đang chờ · ORD-00000002", callbackData: "admin:manual:view:t2" },
    ]);
    expect(message.buttons[2]).toEqual([{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]);
  });

  it("does not display database identifiers or internal fulfillment enums", () => {
    const task = sampleTask();
    const message = presentAdminManualTasks({ tasks: [task], offset: 0, hasMore: false });

    expect(message.text).not.toContain(task.taskId);
    expect(message.text).not.toContain(task.orderId);
    expect(message.text).not.toContain("MANUAL_FULFILLMENT");
  });

  it("communicates the stock-reservation action for quantity-stock work", () => {
    const task = sampleTask({ fulfillmentType: "QUANTITY_STOCK" });
    const message = presentAdminManualTasks({ tasks: [task], offset: 0, hasMore: false });

    expect(message.text).toMatch(/tồn kho số lượng.*giữ chỗ/iu);
    expect(message.text).not.toContain("tồn kho không áp dụng");
  });

  it("pages beyond the first twenty without hiding the oldest-work navigation", () => {
    const tasks = Array.from({ length: 20 }, (_, index) =>
      sampleTask({ taskId: `task-${index}`, orderNumber: `ORD-${index}` }),
    );
    const message = presentAdminManualTasks({ tasks, offset: 20, hasMore: true });

    expect(message.buttons[20]).toEqual([
      { text: "⬅️ Trước", callbackData: "admin:manual:page:0" },
      { text: "Tiếp ➡️", callbackData: "admin:manual:page:40" },
    ]);
  });

  it("keeps a full 20-task page within Telegram's 4096-character message limit", () => {
    const tasks = Array.from({ length: 20 }, (_, index) =>
      sampleTask({
        taskId: `task-${index}`,
        orderNumber: `ORD-${index}`,
        productName: MAX_PRODUCT_NAME,
        variantName: MAX_VARIANT_NAME,
        customerName: MAX_CUSTOMER_NAME,
      }),
    );
    const message = presentAdminManualTasks({ tasks, offset: 20, hasMore: true });

    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.buttons.slice(0, 20).map((row) => row[0]?.callbackData)).toEqual(
      tasks.map((task) => `admin:manual:view:${task.taskId}`),
    );
    expect(message.buttons[20]).toEqual([
      { text: "⬅️ Trước", callbackData: "admin:manual:page:0" },
      { text: "Tiếp ➡️", callbackData: "admin:manual:page:40" },
    ]);
  });
});

describe("presentAdminManualTaskDetail", () => {
  it("offers private contact and durable completion without showing internal IDs", () => {
    const task = sampleTask();
    const message = presentAdminManualTaskDetail({
      task,
      contactStateId: "contact-123",
      confirmationStateId: "confirm-123",
    });

    expect(message.text).toContain("🛠 Tác vụ xử lý thủ công");
    expect(message.text).toContain("ORD-12345678");
    expect(message.text).toContain("230.000 ₫");
    expect(message.text).not.toContain(task.taskId);
    expect(message.text).not.toContain(task.orderId);
    expect(message.text).not.toContain("MANUAL_FULFILLMENT");
    expect(message.buttons[0]).toEqual([
      {
        text: "✉️ Liên hệ khách qua Telegram",
        callbackData: "admin:orders:message:contact-123",
      },
    ]);
    expect(message.buttons[1]).toEqual([
      {
        text: "✅ Hoàn tất (cần xác nhận)",
        callbackData: "admin:manual:complete:confirm-123",
      },
    ]);
    expect(message.buttons[2]).toEqual([
      { text: "↩️ Danh sách", callbackData: "admin:manual" },
      { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
    ]);
  });

  it("displays configured operator instructions without exposing task or order IDs", () => {
    const task = sampleTask({
      instructions: "Provision manually after checking customer account.",
    });
    const message = presentAdminManualTaskDetail({ task });

    expect(message.text).toContain(task.instructions);
    expect(message.text).not.toContain(task.taskId);
    expect(message.text).not.toContain(task.orderId);
  });

  it("keeps maximum-sized task details within Telegram's limit and preserves instruction prefix", () => {
    const message = presentAdminManualTaskDetail({
      task: sampleTask({
        productName: MAX_PRODUCT_NAME,
        variantName: MAX_VARIANT_NAME,
        customerName: MAX_CUSTOMER_NAME,
        instructions: MAX_SERVICE_INSTRUCTIONS,
      }),
    });

    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.text).toContain(INSTRUCTION_PREFIX);
  });

  it("omits completion for completed tasks", () => {
    const message = presentAdminManualTaskDetail({
      task: sampleTask({ status: "COMPLETED" }),
    });

    expect(message.buttons).toEqual([
      [
        { text: "↩️ Danh sách", callbackData: "admin:manual" },
        { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
      ],
    ]);
  });
});
