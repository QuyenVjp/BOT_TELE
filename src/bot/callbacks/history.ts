import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { listOrderHistory, getOrderDetailForCustomer } from "../../modules/commerce/history.js";
import { findOrderByNumberForOwner } from "../../modules/commerce/repository.js";
import { isId } from "../../shared/ids/index.js";
import {
  presentOrderHistory,
  presentOrderDetail,
  HISTORY_COPY,
  type OrderWarrantyState,
} from "../presenters/history.js";
import type { PresentedMessage } from "../presenters/catalog.js";
import { isWithinWarranty, usedDaysAt, warrantyEndOf } from "../../modules/warranty/proration.js";

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

/**
 * Goal §7: the warranty the customer can actually see on their own order — the end date, what has
 * been used and what is left. Derived from the order's own snapshot plus its variant policy, so an
 * order placed before a policy change still reads the way it was sold.
 */
async function orderWarrantyState(
  db: Db,
  order: { id: string; variantId: string },
): Promise<OrderWarrantyState | undefined> {
  const rows = await sql<{
    warranty_days: number;
    completed_at: Date | string | null;
    warranty_enabled: boolean;
  }>`
    select coalesce(o.warranty_days, 0) as warranty_days, o.completed_at,
           coalesce(v.warranty_enabled, false) as warranty_enabled
    from "order" o
    join product_variant v on v.id = o.variant_id
    where o.id = ${order.id}
    limit 1
  `.execute(db);
  const row = rows.rows[0];
  const days = row?.warranty_days ?? 0;
  if (!row || !row.warranty_enabled || days <= 0 || !row.completed_at) return undefined;
  const start =
    row.completed_at instanceof Date ? row.completed_at : new Date(String(row.completed_at));
  const terms = { warrantyDays: days, warrantyStart: start };
  const now = new Date();
  const used = usedDaysAt(terms, now);
  return {
    warrantyDays: days,
    endsAt: warrantyEndOf(terms).toISOString(),
    usedDays: Math.min(used, days),
    remainingDays: Math.max(0, days - used),
    expired: !isWithinWarranty(terms, now),
    variantId: order.variantId,
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
        : ((await findOrderByNumberForOwner(deps.db, orderReference, customerId))?.id ?? null);
      if (!orderId) {
        return errorMessage("Không tìm thấy đơn hàng hoặc bạn không sở hữu đơn hàng này.");
      }
      const owned = await getOrderDetailForCustomer(deps.db, {
        orderId,
        customerId,
      });
      if (!owned) {
        return errorMessage("Không tìm thấy đơn hàng hoặc bạn không sở hữu đơn hàng này.");
      }
      return presentOrderDetail(owned, await orderWarrantyState(deps.db, owned));
    },
  };
}
