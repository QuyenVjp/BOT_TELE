import type { PresentedMessage } from "./catalog.js";

export function presentReviewRating(input: {
  productName: string;
  variantName: string;
  orderReference: string;
}): PresentedMessage {
  return {
    text: [
      "⭐ Đánh giá sản phẩm",
      "",
      `${input.productName} — ${input.variantName}`,
      "Bạn đã mua sản phẩm này. Chọn số sao để gửi đánh giá đã xác minh:",
    ].join("\n"),
    buttons: [
      [1, 2, 3, 4, 5].map((rating) => ({
        text: `${rating}⭐`,
        callbackData: `review:rate:${input.orderReference}:${rating}`,
      })),
      [{ text: "⬅️ Quay lại đơn hàng", callbackData: `ord:view:${input.orderReference}` }],
    ],
  };
}

export function presentReviewSaved(): PresentedMessage {
  return {
    text: "✅ Cảm ơn bạn. Đánh giá đã được ghi nhận là giao dịch đã xác minh.",
    buttons: [[{ text: "🧾 Xem đơn hàng", callbackData: "ord:list" }]],
  };
}

export function presentReviewUnavailable(): PresentedMessage {
  return {
    text: "Đánh giá chỉ khả dụng sau khi đơn đã thanh toán và giao thành công.",
    buttons: [[{ text: "🧾 Đơn hàng của tôi", callbackData: "ord:list" }]],
  };
}
