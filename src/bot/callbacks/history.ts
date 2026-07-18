import type { Db } from "../../infrastructure/db/transaction.js";
import { listOrderHistory, getOrderDetailForCustomer } from "../../modules/commerce/history.js";
import { findOrderByNumber } from "../../modules/commerce/repository.js";
import { presentOrderHistory, presentOrderDetail, HISTORY_COPY } from "../presenters/history.js";
import type { PresentedMessage } from "../presenters/catalog.js";

/**
 * Order history callbacks (T088, FR-018).
 *
 * Thin orchestration over the customer-scoped history read model. Detail and
 * list are both hard-scoped by customer id so a forged callback can never
 * surface another customer's order (BOLA). Reopen is delegated to the checkout
 * callbacks (pay:reopen) — this module never touches payment settlement.
 */

export interface HistoryCallbackDeps {
  db: Db;
  pageSize?: number;
}

export interface HistoryCallbacks {
  list(customerId: string, cursor?: string | null): Promise<PresentedMessage>;
  detail(orderNumber: string, customerId: string): Promise<PresentedMessage>;
}

function errorMessage(text: string): PresentedMessage {
  return {
    text,
    buttons: [[{ text: HISTORY_COPY.mainMenu, callbackData: "menu:main" }]],
  };
}

export function createHistoryCallbacks(deps: HistoryCallbackDeps): HistoryCallbacks {
  const pageSize = deps.pageSize ?? 5;

  return {
    async list(customerId, cursor) {
      const page = await listOrderHistory(deps.db, {
        customerId,
        limit: pageSize,
        cursor: cursor ?? null,
      });
      return presentOrderHistory(page);
    },

    async detail(orderNumber, customerId) {
      // Resolve by public order number, then re-check ownership via the
      // customer-scoped detail helper (defense in depth).
      const byNumber = await findOrderByNumber(deps.db, orderNumber);
      if (!byNumber) return errorMessage("Không tìm thấy đơn hàng.");
      const owned = await getOrderDetailForCustomer(deps.db, {
        orderId: byNumber.id,
        customerId,
      });
      if (!owned) return errorMessage("Bạn không sở hữu đơn hàng này.");
      return presentOrderDetail(owned);
    },
  };
}
