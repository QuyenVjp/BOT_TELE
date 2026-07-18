import type { InlineButton, PresentedMessage } from "./catalog.js";
import type { AuditEvent } from "../../modules/identity/audit.js";

/**
 * Owner-safe Vietnamese admin presenters (T098, FR-021–FR-023).
 *
 * Surfaces for the sole owner: authorization denials, kill-switch confirmation,
 * high-risk confirmation challenge, and a redacted audit list. No presenter ever
 * invites an add-admin action or exposes a raw secret.
 */

export const ADMIN_COPY = {
  deniedTitle: "⛔ Không được phép",
  deniedBody: "Hành động quản trị chỉ dành cho chủ sở hữu trong chat riêng.",
  killSwitchDone: "✅ Đã cập nhật trạng thái bán hàng",
  confirmTitle: "⚠️ Xác nhận hành động rủi ro cao",
  confirmBody:
    "Hành động này cần xác nhận. Nhập (hoặc dán) mã xác nhận trong thời hạn, kèm lý do đã nêu.",
  confirmOk: "✅ Đã thực hiện hành động",
  confirmFail: "❌ Xác nhận thất bại hoặc đã hết hạn",
  auditTitle: "📜 Nhật ký kiểm toán",
  auditEmpty: "Chưa có sự kiện kiểm toán cho mục này.",
  unknownCommand: "Lệnh không được hỗ trợ.",
  mainMenu: "Menu chính",
} as const;

export function presentAdminDenied(reason: "NOT_ROOT_ADMIN" | "WRONG_CONTEXT"): PresentedMessage {
  const hint =
    reason === "WRONG_CONTEXT"
      ? "Chỉ dùng trong chat riêng với bot."
      : "Tài khoản này không phải chủ sở hữu.";
  return {
    text: [ADMIN_COPY.deniedTitle, "", ADMIN_COPY.deniedBody, hint].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentKillSwitchDone(input: {
  command: "catalog.activate" | "catalog.deactivate";
  targetId: string;
}): PresentedMessage {
  const verb = input.command === "catalog.activate" ? "bật bán" : "tạm dừng bán";
  return {
    text: [
      ADMIN_COPY.killSwitchDone,
      "",
      `Hành động: ${verb}`,
      `Mã biến thể: ${input.targetId}`,
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentHighRiskChallenge(input: {
  confirmationId: string;
  challenge: string;
  expiresAt: string;
  action: string;
}): PresentedMessage {
  return {
    text: [
      ADMIN_COPY.confirmTitle,
      "",
      ADMIN_COPY.confirmBody,
      `Hành động: ${input.action}`,
      `Mã xác nhận: ${input.challenge}`,
      `Hết hạn: ${input.expiresAt}`,
      `ID: ${input.confirmationId}`,
    ].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentHighRiskDone(action: string): PresentedMessage {
  return {
    text: [ADMIN_COPY.confirmOk, "", `Hành động: ${action}`].join("\n"),
    buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function presentAuditList(events: AuditEvent[]): PresentedMessage {
  if (events.length === 0) {
    return {
      text: [ADMIN_COPY.auditTitle, "", ADMIN_COPY.auditEmpty].join("\n"),
      buttons: [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]],
    };
  }
  const lines: string[] = [ADMIN_COPY.auditTitle, ""];
  for (const e of events.slice(0, 10)) {
    lines.push(`• ${e.occurredAt} — ${e.action}`);
    lines.push(`  lý do: ${e.reason}`);
  }
  const buttons: InlineButton[][] = [[{ text: ADMIN_COPY.mainMenu, callbackData: "menu:main" }]];
  return { text: lines.join("\n"), buttons };
}
