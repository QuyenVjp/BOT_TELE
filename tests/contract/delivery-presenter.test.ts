import { describe, expect, it } from "vitest";
import {
  presentDeliveryCompleted,
  presentDeliveryReveal,
} from "../../src/bot/presenters/delivery.js";

const deliveryMessageValue = ["Tên đăng nhập: alice", "Mật khẩu: p@ss"].join("\n");
describe("automatic delivery presenter", () => {
  it("shows the credential and an acknowledged delete action without a one-time reveal warning", () => {
    const message = presentDeliveryReveal({
      secret: deliveryMessageValue,
      productName: "GPT Plus 1 tháng",
      orderNumber: "ORD-123",
      amountVnd: "100000",
      usageInstructionsVi: "Đăng nhập theo hướng dẫn.",
      warrantyVi: "Bảo hành 30 ngày.",
    });

    expect(message.text).toContain("Tên đăng nhập: alice");
    expect(message.text).toContain("Mật khẩu: p@ss");
    expect(message.text).toContain("Đơn: ORD-123");
    expect(message.text).toContain("100.000");
    expect(message.text).not.toContain("chỉ hiện một lần");
    expect(message.text).not.toContain("Nhấn nút");
    expect(message.buttons.flat().map((button) => button.text)).not.toContain("🔐 Nhận hàng ngay");
    expect(message.buttons.flat()).toContainEqual({
      text: "🗑 Đã lưu, xóa tin nhắn",
      callbackData: "delivery:delete",
    });
  });
  it("sets protectContent: true on credential-bearing delivery reveal", () => {
    const message = presentDeliveryReveal({
      secret: deliveryMessageValue,
      productName: "GPT Plus 1 tháng",
      orderNumber: "ORD-123",
      amountVnd: "100000",
      usageInstructionsVi: "Đăng nhập theo hướng dẫn.",
      warrantyVi: "Bảo hành 30 ngày.",
    });

    expect(message.protectContent).toBe(true);
  });

  it("protects legacy completed delivery messages and offers the same acknowledged deletion", () => {
    const message = presentDeliveryCompleted("ORD-123", "https://example.invalid/d/opaque", {
      code: "CODE-123",
      fields: [{ name: "login", label: "Tài khoản", value: "alice" }],
    });

    expect(message.protectContent).toBe(true);
    expect(message.buttons.flat()).toContainEqual({
      text: "🗑 Đã lưu, xóa tin nhắn",
      callbackData: "delivery:delete",
    });
  });
});
