import type { Db } from "../../infrastructure/db/transaction.js";
import { findOrderByNumberForOwner } from "../../modules/commerce/repository.js";
import { createSupportService } from "../../modules/support/service.js";
import { isSupportReasonCode } from "../../modules/support/domain.js";
import {
  presentSupportReasonMenu,
  presentTicketOpened,
  presentTicketList,
  SUPPORT_COPY,
} from "../presenters/support.js";
import type { PresentedMessage } from "../presenters/catalog.js";

/**
 * Support callbacks (T088, FR-019).
 *
 * Structured ticket open: reason menu → open with a safe summary. The callback
 * layer never accepts a credential paste and never exposes a mark-paid /
 * refund / reveal verb. Ownership of a linked Order is enforced by the service.
 */

export interface SupportCallbackDeps {
  db: Db;
}

export interface SupportCallbacks {
  /** Show the reason picker (optionally bound to an order number). */
  reasonMenu(orderNumber?: string): PresentedMessage;
  /** Open a ticket after the customer picked a reason. */
  open(input: {
    customerId: string;
    reasonCode: string;
    orderNumber?: string;
    description?: string;
    correlationId: string;
  }): Promise<PresentedMessage>;
  list(customerId: string): Promise<PresentedMessage>;
}

function errorMessage(text: string): PresentedMessage {
  return {
    text,
    buttons: [[{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function createSupportCallbacks(deps: SupportCallbackDeps): SupportCallbacks {
  const svc = createSupportService(deps.db);

  return {
    reasonMenu(orderNumber) {
      return presentSupportReasonMenu(orderNumber);
    },

    async open(input) {
      if (!isSupportReasonCode(input.reasonCode)) {
        return errorMessage("Lý do hỗ trợ không hợp lệ.");
      }

      let orderId: string | undefined;
      if (input.orderNumber) {
        const order = await findOrderByNumberForOwner(deps.db, input.orderNumber, input.customerId);
        if (!order) return errorMessage("Không tìm thấy đơn hàng.");
        // Ownership is re-checked inside the service.
        orderId = order.id;
      }

      const description =
        input.description?.trim() ||
        // Structured open without free-text: use the reason label as a minimal
        // safe summary so the ticket is still actionable.
        input.reasonCode;

      const result = await svc.openTicket({
        customerId: input.customerId,
        ...(orderId !== undefined ? { orderId } : {}),
        reasonCode: input.reasonCode,
        description,
        correlationId: input.correlationId,
      });
      if (!result.ok) return errorMessage(result.message);

      return presentTicketOpened({
        ticketId: result.ticketId,
        orderNumber: input.orderNumber ?? null,
        reasonCode: input.reasonCode,
        ...(result.replacementCaseId ? { replacementCaseId: result.replacementCaseId } : {}),
      });
    },

    async list(customerId) {
      const tickets = await svc.listTickets({ customerId });
      return presentTicketList(tickets);
    },
  };
}
