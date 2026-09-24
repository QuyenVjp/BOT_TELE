import { sql } from "kysely";
import type { Db } from "../../infrastructure/db/transaction.js";
import { createReview, getReviewEligibility } from "../../modules/reviews/service.js";
import { findOrderByNumberForOwner } from "../../modules/commerce/repository.js";
import { getOrderDetailForCustomer } from "../../modules/commerce/history.js";
import { isId } from "../../shared/ids/index.js";
import {
  presentReviewRating,
  presentReviewSaved,
  presentReviewUnavailable,
} from "../presenters/reviews.js";
import type { PresentedMessage } from "../presenters/catalog.js";

export interface ReviewCallbacks {
  start(orderReference: string, customerId: string): Promise<PresentedMessage>;
  rate(orderReference: string, customerId: string, rating: number): Promise<PresentedMessage>;
}

function resolveOrderId(
  db: Db,
  orderReference: string,
  customerId: string,
): Promise<string | null> {
  return isId(orderReference)
    ? Promise.resolve(orderReference)
    : findOrderByNumberForOwner(db, orderReference, customerId).then((order) => order?.id ?? null);
}

export function createReviewCallbacks(db: Db): ReviewCallbacks {
  async function ownedOrder(orderReference: string, customerId: string) {
    const orderId = await resolveOrderId(db, orderReference, customerId);
    return orderId ? getOrderDetailForCustomer(db, { orderId, customerId }) : null;
  }

  return {
    async start(orderReference, customerId) {
      const order = await ownedOrder(orderReference, customerId);
      if (!order) return presentReviewUnavailable();
      const eligibility = await getReviewEligibility(db, { orderId: order.id, customerId });
      if (!eligibility) return presentReviewUnavailable();
      const existing = await sql<{ id: string }>`
        select id from product_review
        where order_id = ${order.id} and customer_id = ${customerId}
        limit 1
      `.execute(db);
      if (existing.rows[0]) return presentReviewSaved();
      return presentReviewRating({
        productName: eligibility.productName,
        variantName: eligibility.variantName,
        orderReference: order.orderNumber,
      });
    },

    async rate(orderReference, customerId, rating) {
      const order = await ownedOrder(orderReference, customerId);
      if (!order) return presentReviewUnavailable();
      const result = await createReview(db, {
        orderId: order.id,
        customerId,
        rating,
      });
      return result.ok || result.code === "DUPLICATE"
        ? presentReviewSaved()
        : presentReviewUnavailable();
    },
  };
}
