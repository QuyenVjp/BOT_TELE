# Context Map

## Contexts

- [Commerce](./docs/02-domain/contexts/commerce/CONTEXT.md) — catalog, search, Buy Now, order, inventory reservation và fulfillment.
- [Payments](./docs/02-domain/contexts/payments/CONTEXT.md) — VietQR payment intent, provider evidence, refund và reconciliation.
- [Wallet](./docs/02-domain/contexts/wallet/CONTEXT.md) — post-MVP closed-loop store credit, không có trên retail menu.
- [Reseller](./docs/02-domain/contexts/reseller/CONTEXT.md) — post-MVP tenant/API lane, không có trên retail menu.
- [Support](./docs/02-domain/contexts/support/CONTEXT.md) — ticket, human handoff, SLA và manual review.
- [Digital Goods](./docs/02-domain/contexts/digital-goods/CONTEXT.md) — account asset, entitlement, supplier fulfillment và one-time delivery.

## Relationships

- **Commerce → Payments**: Commerce requests `PaymentIntentRequested`; Payments emits `PaymentSettled`, `PaymentNeedsReview` hoặc `PaymentExpired`.
- **Commerce → Digital Goods**: confirmed order reserves a Digital Account Asset or requests Supplier Fulfillment; Digital Goods emits `DeliveryReady`, `SupplierNeedsReview` hoặc `DeliveryFailed`.
- **Digital Goods → Payments**: Product policy requires VietQR + verified SePay evidence before delivery; Digital Goods cannot override payment truth.
- **Commerce → Support**: an Order or Fulfillment may open a Ticket with a stable reference, never a mutable object dump.
- **Payments → Support**: a Discrepancy may request `ManualReview`; Support cannot mutate payment/ledger directly.
- **Reseller → Commerce**: Reseller translates a tenant-scoped API request into the same application commands used by retail channels.
- **Commerce/Payments/Digital Goods → Reseller**: only in the post-MVP reseller lane, domain events become signed at-least-once webhooks.

## Shared primitives

- `Money`: integer VND only in V1.
- `CustomerId`, `TenantId`, `OrderId`, `PaymentIntentId`: opaque identifiers.
- `CorrelationId`: connects channel update, command, order, payment, ledger and audit without exposing secrets.
