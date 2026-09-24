import { formatVnd, makeVnd } from "../../shared/money/index.js";
import type { PresentedMessage } from "./catalog.js";

export function presentReferralHome(input: {
  link: string;
  attributed: number;
  qualified: number;
  earnedVnd: bigint;
}): PresentedMessage {
  return {
    text: [
      "🤝 Giới thiệu bạn bè",
      "",
      "Chia sẻ link Telegram này. Chỉ đơn đã thanh toán và giao thành công mới được tính:",
      input.link,
      "",
      `Đã giới thiệu: ${input.attributed} · Đủ điều kiện: ${input.qualified}`,
      `Đã nhận: ${formatVnd(makeVnd(input.earnedVnd))}`,
    ].join("\n"),
    buttons: [
      [{ text: "📋 Sao chép link", callbackData: "", copyText: input.link }],
      [{ text: "🛒 Mở cửa hàng", callbackData: "shop:home" }],
    ],
  };
}

export function presentReferralAttributed(): PresentedMessage {
  return {
    text: "✅ Đã ghi nhận lời mời. Hãy chọn sản phẩm để bắt đầu.",
    buttons: [[{ text: "🛒 Mở cửa hàng", callbackData: "shop:home" }]],
  };
}
