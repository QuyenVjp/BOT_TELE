import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import type { CallbackTokenCodec } from "../callback-codec.js";
import { listOrderHistory, getOrderDetailForCustomer } from "../../modules/commerce/history.js";
import { findOrderByNumberForOwner } from "../../modules/commerce/repository.js";
import { isId } from "../../shared/ids/index.js";
import {
  presentBuyAgainUnavailable,
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
  /** Re-reads the live catalog and returns a pre-checkout screen; it must not charge. */
  buyAgainVariantDetail?: (variantId: string, telegramUserId: string) => Promise<PresentedMessage>;
  /** Verifies that live catalog output contains this actor's current checkout preview. */
  tokenCodec?: CallbackTokenCodec;
}

export interface HistoryCallbacks {
  list(customerId: string, cursor?: string | null): Promise<PresentedMessage>;
  detail(orderReference: string, customerId: string): Promise<PresentedMessage>;
  buyAgain(
    orderReference: string,
    customerId: string,
    telegramUserId: string,
  ): Promise<PresentedMessage>;
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
  order: { id: string },
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
    where o.id = ${order.id} and o.status = 'COMPLETED'
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
    orderId: order.id,
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
    async buyAgain(orderReference, customerId, telegramUserId) {
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
      // Only a completed historical purchase is an eligible source. The current
      // variant, price, publication and stock are re-read by the catalog adapter below.
      if (!owned || owned.status !== "COMPLETED" || !owned.completedAt) {
        return errorMessage("Đơn hàng này chưa đủ điều kiện để mua lại.");
      }
      if (!deps.buyAgainVariantDetail) return errorMessage("Mua lại hiện chưa khả dụng.");
      try {
        const current = await deps.buyAgainVariantDetail(owned.variantId, telegramUserId);
        // A buy-again result is safe only when it is the current signed checkout
        // preview. A legacy charge token or a generic/stale screen fails closed.
        const tokenCodec = deps.tokenCodec;
        const hasCheckoutPreview =
          tokenCodec !== undefined &&
          current.buttons.some((row) =>
            row.some((button) => {
              const callbackData = button.callbackData;
              if (!callbackData.startsWith("cb:")) return false;
              const verification = tokenCodec.verify(callbackData, { telegramUserId });
              return (
                verification.ok &&
                verification.value.action === "CHECKOUT_PREVIEW" &&
                verification.value.resourceId === owned.variantId
              );
            }),
          );
        return hasCheckoutPreview ? current : presentBuyAgainUnavailable();
      } catch {
        return presentBuyAgainUnavailable();
      }
    },
  };
}
