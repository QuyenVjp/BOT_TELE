import type { Db } from "../../infrastructure/db/transaction.js";
import {
  findOrderByIdForOwner,
  findOrderByNumberForOwner,
} from "../../modules/commerce/repository.js";
import { createSupportService } from "../../modules/support/service.js";
import { isSupportReasonCode } from "../../modules/support/domain.js";
import {
  presentDescriptionCancelled,
  presentDescriptionPrompt,
  presentDescriptionSubmitted,
  presentSupportReasonMenu,
  presentTicketDetail,
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

export type SupportDescriptionStateRef =
  { ticketId: string; stateId?: never } | { stateId: string; ticketId?: never };

export type SupportDescriptionSubmitInput = {
  customerId: string;
  ticketId?: string;
  stateId?: string;
  description: string;
  correlationId: string;
};

export type SupportDescriptionCancelInput = SupportDescriptionStateRef & {
  customerId: string;
  correlationId: string;
};

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
  /**
   * Create/reuse a durable WAITING_CUSTOMER ticket and prompt for text.
   * Ordinary text submits through the owner-scoped pending-ticket lookup; a
   * sealed ticketId/stateId is optional for callback-driven hosts.
   */
  beginDescription(input: {
    customerId: string;
    reasonCode: string;
    orderNumber?: string;
    correlationId: string;
  }): Promise<PresentedMessage>;
  submitDescription(input: SupportDescriptionSubmitInput): Promise<PresentedMessage | null>;
  cancelDescription(input: SupportDescriptionCancelInput): Promise<PresentedMessage>;
  list(customerId: string): Promise<PresentedMessage>;
  view(ticketId: string, customerId: string): Promise<PresentedMessage>;
  close(input: {
    ticketId: string;
    customerId: string;
    correlationId: string;
  }): Promise<PresentedMessage>;
}

function errorMessage(text: string): PresentedMessage {
  return {
    text,
    buttons: [[{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}
function missingTicketMessage(): PresentedMessage {
  return errorMessage("Không tìm thấy ticket.");
}

function supportStateTicketId(input: SupportDescriptionStateRef): string {
  return "ticketId" in input ? input.ticketId : input.stateId;
}

function optionalSupportStateTicketId(input: {
  ticketId?: string;
  stateId?: string;
}): string | undefined {
  return input.ticketId ?? input.stateId;
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

    async beginDescription(input) {
      if (!isSupportReasonCode(input.reasonCode)) {
        return errorMessage("Lý do hỗ trợ không hợp lệ.");
      }
      let orderId: string | undefined;
      if (input.orderNumber) {
        const order = await findOrderByNumberForOwner(deps.db, input.orderNumber, input.customerId);
        if (!order) return errorMessage("Không tìm thấy đơn hàng.");
        orderId = order.id;
      }
      const result = await svc.beginDescription({
        customerId: input.customerId,
        ...(orderId !== undefined ? { orderId } : {}),
        reasonCode: input.reasonCode,
        correlationId: input.correlationId,
      });
      if (!result.ok) return errorMessage(result.message);
      let orderNumber: string | null = null;
      if (result.orderId) {
        const order = await findOrderByIdForOwner(deps.db, result.orderId, input.customerId);
        orderNumber = order?.orderNumber ?? null;
      }
      return presentDescriptionPrompt({
        ticketId: result.ticketId,
        orderNumber,
        reasonCode: result.reasonCode,
      });
    },

    async submitDescription(input) {
      const ticketId = optionalSupportStateTicketId(input);
      const result = await svc.submitDescription({
        ...(ticketId !== undefined ? { ticketId } : {}),
        customerId: input.customerId,
        description: input.description,
        correlationId: input.correlationId,
      });
      if (!result.ok) {
        return result.code === "NOT_FOUND" && ticketId === undefined
          ? null
          : errorMessage(result.message);
      }
      let orderNumber: string | null = null;
      if (result.orderId) {
        const order = await findOrderByIdForOwner(deps.db, result.orderId, input.customerId);
        orderNumber = order?.orderNumber ?? null;
      }
      return presentDescriptionSubmitted({
        ticketId: result.ticketId,
        orderNumber,
        reasonCode: result.reasonCode,
      });
    },

    async cancelDescription(input) {
      const result = await svc.cancelDescription({
        ticketId: supportStateTicketId(input),
        customerId: input.customerId,
        correlationId: input.correlationId,
      });
      if (!result.ok) return errorMessage(result.message);
      return presentDescriptionCancelled();
    },

    async list(customerId) {
      const tickets = await svc.listTickets({ customerId });
      return presentTicketList(tickets);
    },
    async view(ticketId, customerId) {
      const ticket = await svc.getTicket({ ticketId, customerId });
      if (!ticket) return missingTicketMessage();
      let orderNumber: string | null = null;
      if (ticket.orderId) {
        const order = await findOrderByIdForOwner(deps.db, ticket.orderId, customerId);
        orderNumber = order?.orderNumber ?? null;
      }
      return presentTicketDetail(ticket, orderNumber);
    },

    async close(input) {
      const ticket = await svc.getTicket({
        ticketId: input.ticketId,
        customerId: input.customerId,
      });
      if (!ticket || ticket.status !== "RESOLVED") return missingTicketMessage();
      const result = await svc.closeTicket(input);
      if (!result.ok) return missingTicketMessage();
      return {
        text: "✅ Đã đóng ticket hỗ trợ.",
        buttons: [[{ text: SUPPORT_COPY.mainMenu, callbackData: "menu:main" }]],
      };
    },
  };
}
