import type { PresentedMessage } from "./catalog.js";
import type { ManualFulfillmentTask } from "../../modules/digital-goods/manual-fulfillment.js";

const statusLabel = (status: ManualFulfillmentTask["status"]): string =>
  status === "OPEN" ? "Đang chờ" : "Đã hoàn tất";

export function presentAdminManualTasks(tasks: ManualFulfillmentTask[]): PresentedMessage {
  const visible = tasks.slice(0, 20);
  return {
    text: [
      "🛠 Xử lý thủ công",
      visible.length === 0 ? "Không có tác vụ đang chờ." : "Chọn tác vụ để xem chi tiết.",
      ...visible.map(
        (task) => `• ${statusLabel(task.status)} — ${task.fulfillmentType} — ${task.orderId}`,
      ),
    ].join("\n"),
    buttons: [
      ...visible.map((task) => [
        {
          text: `${statusLabel(task.status)} ${task.orderId.slice(-8)}`,
          callbackData: `admin:manual:view:${task.id}`,
        },
      ]),
      [{ text: "Admin", callbackData: "admin:menu" }],
    ],
  };
}

export function presentAdminManualTaskDetail(input: {
  task: ManualFulfillmentTask;
  confirmationStateId?: string;
}): PresentedMessage {
  return {
    text: [
      "🛠 Tác vụ xử lý thủ công",
      `Mã tác vụ: ${input.task.id}`,
      `Đơn hàng: ${input.task.orderId}`,
      `Khách hàng: ${input.task.customerId}`,
      `Loại: ${input.task.fulfillmentType}`,
      `Trạng thái: ${statusLabel(input.task.status)}`,
      "",
      input.task.instructions,
    ].join("\n"),
    buttons: [
      ...(input.task.status === "OPEN" && input.confirmationStateId
        ? [
            [
              {
                text: "✅ Hoàn tất (cần xác nhận)",
                callbackData: `admin:manual:complete:${input.confirmationStateId}`,
              },
            ],
          ]
        : []),
      [{ text: "↩️ Danh sách", callbackData: "admin:manual" }],
      [{ text: "Admin", callbackData: "admin:menu" }],
    ],
  };
}
