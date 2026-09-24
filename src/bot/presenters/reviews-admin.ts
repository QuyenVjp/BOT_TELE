import type { ReviewModerationRow } from "../../modules/reviews/service.js";
import type { PresentedMessage } from "./catalog.js";

export function presentReviewModeration(rows: ReviewModerationRow[]): PresentedMessage {
  if (rows.length === 0) {
    return {
      text: "⭐ Chưa có đánh giá nào.",
      buttons: [[{ text: "⬅️ Vận hành", callbackData: "admin:operations" }]],
    };
  }
  const text = [
    "⭐ Kiểm duyệt đánh giá",
    "",
    ...rows.map((row) => {
      const comment = row.comment.replace(/[\r\n]+/gu, " ").slice(0, 160);
      return `${row.status === "VISIBLE" ? "✅" : "⏸"} ${row.customerAlias} · ${row.rating}⭐ · ${row.productName} — ${row.variantName}${comment ? `\n${comment}` : ""}`;
    }),
  ].join("\n");
  const buttons = rows.map((row) => [
    {
      text: row.status === "VISIBLE" ? `Ẩn ${row.customerAlias}` : `Hiện ${row.customerAlias}`,
      callbackData: `admin:reviews:${row.status === "VISIBLE" ? "hide" : "restore"}:${row.id}`,
    },
  ]);
  buttons.push([{ text: "⬅️ Vận hành", callbackData: "admin:operations" }]);
  return { text, buttons };
}

export function presentReviewModerated(status: "VISIBLE" | "HIDDEN"): PresentedMessage {
  return {
    text: status === "HIDDEN" ? "✅ Đã ẩn đánh giá." : "✅ Đã khôi phục đánh giá.",
    buttons: [[{ text: "⭐ Xem đánh giá", callbackData: "admin:reviews" }]],
  };
}
