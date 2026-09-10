import { describe, expect, it } from "vitest";
import {
  presentAdminSupportQueue,
  presentAdminSupportTicket,
  presentAdminSupportTickets,
  SUPPORT_STATUS_LABELS,
} from "../../src/bot/presenters/admin.js";
import type { PresentedMessage } from "../../src/bot/presenters/catalog.js";
import type { SupportTicketStatus } from "../../src/modules/support/domain.js";
import type { AdminSupportTicketRow } from "../../src/modules/support/service.js";

/**
 * Owner ticket management presenter.
 *
 * The owner walks a ticket list into a detail screen whose only actions are the
 * transitions the customer-facing state machine allows. An illegal button is a
 * dead end for the owner, so the legal set is pinned per status here instead of
 * being derived from the same guard the presenter calls.
 */

const TICKET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_TICKET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBW";

function ticket(overrides: Partial<AdminSupportTicketRow> = {}): AdminSupportTicketRow {
  return {
    id: TICKET_ID,
    customerLabel: "Khách AB12",
    reasonCode: "DELIVERY_NOT_RECEIVED",
    status: "OPEN",
    safeSummary: "Chưa nhận được tài khoản.",
    orderNumber: "ORD-0001",
    dueAt: "2026-09-11T03:00:00.000Z",
    ...overrides,
  };
}

const flat = (msg: PresentedMessage) => msg.buttons.flat();
const callbacks = (msg: PresentedMessage) => flat(msg).map((button) => button.callbackData);
const statusCallbacks = (msg: PresentedMessage) =>
  callbacks(msg).filter((data) => data.startsWith("admin:support:status:"));

/** Internal codes never reach the owner's screen. */
const INTERNAL_CODES =
  /OPEN|WAITING_SHOP|WAITING_CUSTOMER|RESOLVED|CLOSED|MANUAL_REVIEW|DELIVERY_NOT_RECEIVED/;

/** ALLOWED in modules/support/domain.ts, read as the contract the owner sees. */
const LEGAL_TARGETS: Record<SupportTicketStatus, string[]> = {
  OPEN: ["WAITING_SHOP", "WAITING_CUSTOMER", "RESOLVED", "MANUAL_REVIEW"],
  WAITING_SHOP: ["WAITING_CUSTOMER", "RESOLVED", "MANUAL_REVIEW"],
  WAITING_CUSTOMER: ["WAITING_SHOP", "RESOLVED", "MANUAL_REVIEW"],
  RESOLVED: ["WAITING_CUSTOMER", "CLOSED"],
  MANUAL_REVIEW: ["WAITING_SHOP", "RESOLVED"],
  CLOSED: [],
};

describe("admin support ticket list", () => {
  it("hangs the ticket queue off the existing support screen", () => {
    for (const rows of [
      [],
      [
        {
          caseId: "C1",
          orderId: "O1",
          orderNumber: "ORD-1",
          customerId: "CU1",
          reasonCode: "ASSET_NOT_WORKING",
          safeSummary: null,
        },
      ],
    ]) {
      const msg = presentAdminSupportQueue(rows);
      expect(callbacks(msg)).toContain("admin:support:tickets");
    }
  });

  it("opens every ticket by id and reads the row, not the internal code", () => {
    const rows = [
      ticket(),
      ticket({
        id: OTHER_TICKET_ID,
        customerLabel: "Khách CD34",
        status: "WAITING_CUSTOMER",
        orderNumber: null,
      }),
    ];
    const msg = presentAdminSupportTickets(rows);

    expect(callbacks(msg)).toContain(`admin:support:ticket:${TICKET_ID}`);
    expect(callbacks(msg)).toContain(`admin:support:ticket:${OTHER_TICKET_ID}`);
    expect(new Set(callbacks(msg)).size).toBe(callbacks(msg).length);
    expect(msg.text).toContain("Khách AB12");
    expect(msg.text).toContain("ORD-0001");
    expect(msg.text).toContain("Chưa nhận được tài khoản.");
    expect(msg.text).toContain(SUPPORT_STATUS_LABELS.WAITING_CUSTOMER);
    expect(msg.text).not.toContain("Đơn: null");
    expect(msg.text).not.toMatch(INTERNAL_CODES);
  });

  it("says so when nothing is open, and keeps the way back", () => {
    const msg = presentAdminSupportTickets([]);

    expect(msg.text).toContain("Không có yêu cầu hỗ trợ nào đang mở.");
    expect(callbacks(msg).some((data) => data.startsWith("admin:support:ticket:"))).toBe(false);
    expect(callbacks(msg)).toContain("admin:support");
  });
});

describe("admin support ticket detail", () => {
  for (const [status, targets] of Object.entries(LEGAL_TARGETS) as [
    SupportTicketStatus,
    string[],
  ][]) {
    it(`offers exactly the legal next states from ${status}`, () => {
      const msg = presentAdminSupportTicket(ticket({ status }));

      expect(statusCallbacks(msg)).toEqual(
        targets.map((to) => `admin:support:status:${TICKET_ID}:${to}`),
      );
      for (const button of flat(msg)) {
        if (button.callbackData.startsWith("admin:support:status:")) {
          expect(button.text).toBe(
            SUPPORT_STATUS_LABELS[
              button.callbackData.slice(
                button.callbackData.lastIndexOf(":") + 1,
              ) as SupportTicketStatus
            ],
          );
        }
      }
      expect(msg.text).toContain(SUPPORT_STATUS_LABELS[status]);
      expect(msg.text).not.toMatch(INTERNAL_CODES);
    });
  }

  it("keeps a way back when the ticket can no longer move", () => {
    const msg = presentAdminSupportTicket(ticket({ status: "CLOSED" }));

    expect(statusCallbacks(msg)).toEqual([]);
    expect(callbacks(msg)).toContain("admin:support:tickets");
  });

  it("shows the order and the SLA deadline the owner decides on", () => {
    const msg = presentAdminSupportTicket(ticket());

    expect(msg.text).toContain("ORD-0001");
    expect(msg.text).toContain("Chưa nhận được tài khoản.");
    expect(msg.text).toContain("Hạn phản hồi:");
    expect(msg.text).not.toMatch(INTERNAL_CODES);
  });

  it("keeps every callback within Telegram's 64-byte limit", () => {
    const messages = [
      presentAdminSupportTickets([ticket()]),
      ...Object.keys(LEGAL_TARGETS).map((status) =>
        presentAdminSupportTicket(ticket({ status: status as SupportTicketStatus })),
      ),
    ];
    const all = messages.flatMap((message) => callbacks(message));

    expect(all.length).toBeGreaterThan(0);
    for (const data of all) {
      expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(64);
    }
  });
});
