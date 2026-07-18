# Research: Notifications, Quantity Checkout, and Payment UX

## Decision 1: Separate transactional, critical, shop, and purchase-activity classes

**Decision**: Transactional notifications are owner-scoped and necessary for Orders; critical service
messages are rare/non-marketing; shop updates and purchase activity are user-configurable.

**Rationale**: A single global notification toggle either hides essential Order updates or forces
marketing. Class separation provides trust and a real opt-out.

## Decision 2: Aggregate purchase success instead of one broadcast per sale

**Decision**: Each successful sale emits a privacy-safe activity event, but fanout aggregates events
per window and caps recipients (pilot default one purchase-activity message/10 minutes/customer).

**Rationale**: This keeps every sale represented while preventing message storms and Telegram 429s.

**Alternative rejected**: Immediate `all customers × every sale` fanout.

## Decision 3: One Variant with quantity, not a cart

**Decision**: Order line count remains one; quantity is bounded and all-or-nothing before payment.

**Rationale**: Customers can buy multiple accounts/licenses without introducing multi-line pricing,
promotion, split fulfillment, or cart complexity.

## Decision 4: Deterministic unit idempotency for supplier quantity

**Decision**: Use one supplier quantity request when supported; otherwise child idempotency keys are
`{orderId}:{unitIndex}` and uncertain units reconcile before retry.

**Rationale**: This prevents duplicate upstream purchases while allowing N-unit fulfillment.

## Decision 5: Payment copy reflects state truth

**Decision**: `Đã tạo đơn` is used before payment, `Thanh toán thành công` only after verified SePay
evidence, and `Đơn hàng hoàn tất` only after N assets are ready. Raw account secrets remain behind a
Delivery Bundle button.

**Rationale**: The sample copy is useful, but a generic `Đặt hàng thành công` before settlement can
mislead customers about payment/delivery state.

## Decision 6: VND reconciliation fee policy only

**Decision**: If the shop charges a manual reconciliation fee, store/display an exact integer VND
amount before payment and snapshot it on the Order. Do not hardcode `$2` or convert dynamically.

**Rationale**: The shop is VND-only and the customer must know the exact policy before transferring.

## Official references

- Telegram Bot API sendPhoto/edit/callback/rate behavior: https://core.telegram.org/bots/api
- Telegram Bot API response parameters (`retry_after`): https://core.telegram.org/bots/api#responseparameters
- SePay authentication/security/reconciliation: https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc
- VietQR generation: https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr

