import type { PresentedMessage } from "./catalog.js";
import type {
  AdminManualFulfillmentTask,
  AdminManualFulfillmentTaskPage,
} from "../../modules/digital-goods/manual-fulfillment.js";

const statusLabel = (status: AdminManualFulfillmentTask["status"]): string =>
  status === "OPEN" ? "Đang chờ" : "Đã hoàn tất";

function fulfillmentLabel(type: AdminManualFulfillmentTask["fulfillmentType"]): string {
  switch (type) {
    case "QUANTITY_STOCK":
      return "Tồn kho số lượng · đã giữ chỗ";
    case "UNLIMITED_SERVICE":
      return "Dịch vụ không giới hạn";
    default:
      return "Dịch vụ thủ công";
  }
}

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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength - 1;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return `${value.slice(0, end)}…`;
}

function boundedLabel(value: string, maxLength: number): string {
  return truncateText(value.replace(/\s+/gu, " ").trim(), maxLength);
}

function taskSummary(task: AdminManualFulfillmentTask): string {
  return `• ${boundedLabel(task.orderNumber, 24)} · ${boundedLabel(task.productName, 24)} — ${boundedLabel(task.variantName, 24)}\n  ${fulfillmentLabel(task.fulfillmentType)} · ${boundedLabel(task.customerName, 24)} · ${amountLabel(task.amountVnd)} · chờ ${ageLabel(task.createdAt)}`;
}

export function presentAdminManualTasks(page: AdminManualFulfillmentTaskPage): PresentedMessage {
  const { tasks, offset, hasMore } = page;
  const buttons = tasks.map((task) => [
    {
      text: `${statusLabel(task.status)} · ${boundedLabel(task.orderNumber, 24)}`,
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
      tasks.length === 0 ? "Không có đơn cần xử lý ở trang này." : "Ưu tiên đơn chờ lâu nhất.",
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
      `Đơn: ${boundedLabel(input.task.orderNumber, 32)}`,
      `Khách: ${boundedLabel(input.task.customerName, 96)}`,
      `Sản phẩm: ${boundedLabel(input.task.productName, 96)}`,
      `Gói: ${boundedLabel(input.task.variantName, 96)}`,
      `Số tiền: ${amountLabel(input.task.amountVnd)}`,
      `Loại xử lý: ${fulfillmentLabel(input.task.fulfillmentType)}`,
      `Hướng dẫn: ${truncateText(input.task.instructions, 2400)}`,
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
