# Notifications, Quantity Checkout, and Payment UX — Spec Kit Pack

Canonical source: [`../specs/003-notifications-quantity-checkout/`](../specs/003-notifications-quantity-checkout/)

Feature 003 adds bounded quantity for one Product Variant, a clear VietQR payment session, and safe
customer/admin notifications to the retail MVP. It does not add a multi-item cart, wallet, Telegram
Stars, or reseller controls to the customer flow.

## Chốt nghiệp vụ

- One Order contains one Variant and quantity `1..max_per_order`; the server recalculates integer VND
  total and atomically reserves N units.
- Supplier quantity uses one supported idempotent request or child keys `{orderId}:{unitIndex}`;
  Unknown/partial fulfillment enters review, and completion requires exactly N valid entitlements.
- VietQR creates the payment presentation; SePay is the only payment truth. The card includes QR image,
  order/product/quantity/price/total, validated ACB/merchant display snapshot, transfer content, expiry,
  check button, cancel button, and exact VND reconciliation policy. Check/cancel are safe and idempotent.
- Transactional updates are owner-only and cannot be disabled. Critical service is rare and non-marketing.
  Shop updates and purchase activity are independently configurable with quiet hours/digest frequency.
- New/restock messages show product, quantity added, stock after, current price, and deep link.
- Purchase success is privacy-safe aggregate social proof, capped by recipient frequency; no buyer,
  order/payment/bank/account/credential/private-total data is sent.
- Root admin is the configured numeric Telegram ID mapped to `@Quyenvjp`; broadcasts require private
  context, sanitized preview, step-up confirmation, audit, outbox fanout, dedupe, backoff, and cancellation.

## Artifact index

- [Feature specification](../specs/003-notifications-quantity-checkout/spec.md)
- [Implementation plan and canonical Vietnamese payment copy](../specs/003-notifications-quantity-checkout/plan.md)
- [Research decisions and official references](../specs/003-notifications-quantity-checkout/research.md)
- [Data model](../specs/003-notifications-quantity-checkout/data-model.md)
- [Contracts](../specs/003-notifications-quantity-checkout/contracts/)
- [Requirements checklist](../specs/003-notifications-quantity-checkout/checklists/requirements.md)
- [Security checklist](../specs/003-notifications-quantity-checkout/checklists/security.md)
- [Quickstart acceptance lanes](../specs/003-notifications-quantity-checkout/quickstart.md)
- [Task list](../specs/003-notifications-quantity-checkout/tasks.md)
- [Traceability](../specs/003-notifications-quantity-checkout/traceability.md)
- [Cross-artifact analysis](../specs/003-notifications-quantity-checkout/analysis.md)

## Implementation order for Claude

1. Integrate quantity and payment-session tasks `T310`–`T332` into the current Feature 001 payment phase.
2. Add transactional notifications `T333`–`T341` after committed Order/payment/fulfillment events.
3. Add product/activity `T342`–`T350`, admin broadcast `T351`–`T359`, and preferences `T360`–`T366`.
4. Finish cross-cutting evidence `T367`–`T372`; no Critical/High finding may remain.

The active `.specify/feature.json` must stay on Feature 001 until the existing MVP implementation
phase is explicitly handed over.
