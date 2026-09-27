import type { PresentedMessage } from "./catalog.js";
import type {
  AdminManualFulfillmentTask,
  AdminManualFulfillmentTaskPage,
} from "../../modules/digital-goods/manual-fulfillment.js";

const statusLabel = (status: AdminManualFulfillmentTask["status"]): string =>
  status === "OPEN" ? "Đang chờ" : "Đã hoàn tất";

function ageLabel(createdAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return "vừa tạo";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

function amountLabel(amountVnd: string): string {
  return `${BigInt(amountVnd).toLocaleString("vi-VN")} ₫`;
}

function taskSummary(task: AdminManualFulfillmentTask): string {
  return `• ${task.orderNumber} · ${task.productName} — ${task.variantName}\n  ${task.customerName} · ${amountLabel(task.amountVnd)} · chờ ${ageLabel(task.createdAt)}`;
}

export function presentAdminManualTasks(page: AdminManualFulfillmentTaskPage): PresentedMessage {
  const { tasks, offset, hasMore } = page;
  const buttons = tasks.map((task) => [
    {
      text: `${statusLabel(task.status)} · ${task.orderNumber}`,
      callbackData: `admin:manual:view:${task.taskId}`,
    },
  ]);
  const navigation = [
    ...(offset > 0
      ? [{ text: "⬅️ Trước", callbackData: `admin:manual:page:${Math.max(0, offset - 20)}` }]
      : []),
    ...(hasMore
      ? [{ text: "Tiếp ➡️", callbackData: `admin:manual:page:${offset + tasks.length}` }]
      : []),
  ];
  if (navigation.length > 0) buttons.push(navigation);
  buttons.push([{ text: "⌂ Trang quản trị", callbackData: "admin:menu" }]);
  return {
    text: [
      "🛠 Hàng chờ xử lý thủ công",
      tasks.length === 0
        ? "Không có đơn cần xử lý ở trang này."
        : "Ưu tiên đơn chờ lâu nhất; tồn kho không áp dụng.",
      ...tasks.map(taskSummary),
    ].join("\n"),
    buttons,
  };
}

export function presentAdminManualTaskDetail(input: {
  task: AdminManualFulfillmentTask;
  contactStateId?: string;
  confirmationStateId?: string;
}): PresentedMessage {
  return {
    text: [
      "🛠 Tác vụ xử lý thủ công",
      `Đơn: ${input.task.orderNumber}`,
      `Khách: ${input.task.customerName}`,
      `Sản phẩm: ${input.task.productName}`,
      `Gói: ${input.task.variantName}`,
      `Số tiền: ${amountLabel(input.task.amountVnd)}`,
      `Đã chờ: ${ageLabel(input.task.createdAt)}`,
      `Trạng thái: ${statusLabel(input.task.status)}`,
    ].join("\n"),
    buttons: [
      ...(input.contactStateId
        ? [
            [
              {
                text: "✉️ Liên hệ khách qua Telegram",
                callbackData: `admin:orders:message:${input.contactStateId}`,
              },
            ],
          ]
        : []),
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
      [
        { text: "↩️ Danh sách", callbackData: "admin:manual" },
        { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
      ],
    ],
  };
}
