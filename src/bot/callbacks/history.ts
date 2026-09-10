import type { Db } from "../../infrastructure/db/transaction.js";
import { listOrderHistory, getOrderDetailForCustomer } from "../../modules/commerce/history.js";
import { findOrderByNumber } from "../../modules/commerce/repository.js";
import { isId } from "../../shared/ids/index.js";
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
  detail(orderReference: string, customerId: string): Promise<PresentedMessage>;
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

    async detail(orderReference, customerId) {
      // Callback tokens cannot carry the public order number (the callback codec only encodes
      // ULIDs), so `ord:view` arrives here with the internal order id. Accept the number as
      // well so raw / legacy callbacks keep working. Ownership is re-checked by the
      // customer-scoped helper (BOLA defense in depth).
      const orderId = isId(orderReference)
        ? orderReference
        : ((await findOrderByNumber(deps.db, orderReference))?.id ?? null);
      if (!orderId) return errorMessage("Không tìm thấy đơn hàng.");
      const owned = await getOrderDetailForCustomer(deps.db, {
        orderId,
        customerId,
      });
      if (!owned) return errorMessage("Bạn không sở hữu đơn hàng này.");
      return presentOrderDetail(owned);
    },
  };
}
