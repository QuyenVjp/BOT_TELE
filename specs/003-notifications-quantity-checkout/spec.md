# Feature Specification: Notifications, Quantity Checkout, and Payment UX

**Feature Branch**: `003-notifications-quantity-checkout`

**Created**: 2026-07-16

**Status**: Ready for implementation after Feature 001 payment-boundary handoff

**Input**: Allow customers to buy multiple units of one digital Product Variant, create a clear VietQR payment session with QR image and safe check/cancel buttons, notify customers through transactional and configurable shop notifications, let the sole admin broadcast important messages, announce new/restocked products and completed purchases without exposing buyer data, and apply strict anti-spam/idempotency rules.

## User Scenarios & Testing

### User Story 1 - Buy multiple units of one product (Priority: P1)

A customer chooses one Product Variant, selects a permitted quantity, sees unit price and total,
and creates one immutable Order/payment session for that quantity.

**Independent Test**: Seed ten compatible digital assets, select quantities 1, 3, maximum, zero,
and above-stock; prove exact totals, all-or-nothing reservation, one Order, and no multi-item cart.

**Acceptance Scenarios**:

1. **Given** a sellable variant with sufficient stock, **When** a customer selects quantity 3, **Then** the Order snapshots one variant, quantity 3, unit price, total VND, warranty/delivery policy, and reserves/provisions three compatible assets.
2. **Given** insufficient stock or a quantity above the configured per-Order maximum, **When** the customer confirms, **Then** no payment session is created and the customer sees the permitted quantity/max available.
3. **Given** repeated clicks or callbacks for the same quantity request, **When** Buy Now is processed, **Then** one Order/payment session is returned idempotently.
4. **Given** price or stock changes before confirmation, **When** the customer creates the Order, **Then** the server displays the new unit price/available quantity and requires explicit reconfirmation.
5. **Given** quantity N, **When** fulfillment completes, **Then** one Delivery Bundle safely contains or references exactly N delivered entitlements without placing raw credentials in chat.

### User Story 2 - Understand and control the payment session (Priority: P1)

A customer receives a Vietnamese payment card with QR image, exact bank details, total, transfer
content, expiry, check-status button, and safe cancellation.

**Independent Test**: Create an unpaid Order and prove the displayed fields match its Payment Intent,
QR payload, merchant configuration, quantity, and expiry; check/cancel never marks paid incorrectly.

**Acceptance Scenarios**:

1. **Given** a valid Order, **When** payment is presented, **Then** the bot sends/edits one message with QR image, Order code, product, quantity, unit price, total, bank, account owner/number, transfer content, expiry, and warnings.
2. **Given** a customer presses `Kiểm tra thanh toán`, **When** no verified evidence exists, **Then** the bot reads the internal projection and reports waiting; it does not mark paid or issue one SePay provider request per click.
3. **Given** a customer cancels before verified payment, **When** cancellation wins the race, **Then** the Payment Intent/Order are cancelled idempotently and reservations are released.
4. **Given** verified payment arrives concurrently with cancellation, **When** both process, **Then** payment truth wins according to the state-machine guard and the paid Order is not silently cancelled.
5. **Given** wrong amount/content/account, late, partial, or overpayment, **When** evidence arrives, **Then** the customer receives `Cần đối soát` with support guidance; no fake success or silent fulfillment occurs.

### User Story 3 - Receive accurate transactional updates (Priority: P1)

A customer receives only the necessary Order/payment/fulfillment/support updates for their own Order.

**Independent Test**: Process an Order through created, awaiting payment, paid, processing, delivered,
review, cancelled, and expired states; prove one idempotent customer notification per meaningful transition.

**Acceptance Scenarios**:

1. **Given** an Order is created, **When** payment presentation succeeds, **Then** the customer sees `Đã tạo đơn hàng` rather than a misleading paid/completed message.
2. **Given** SePay settles the payment, **When** the paid transition commits, **Then** the customer receives `Thanh toán thành công — đang chuẩn bị N sản phẩm` exactly once.
3. **Given** all N assets are ready, **When** delivery completes, **Then** the customer receives `Đơn hàng hoàn tất` with a secure `Nhận N sản phẩm` button and no raw credential in chat.
4. **Given** an exception/review/expiry/cancellation, **When** the state changes, **Then** the customer receives the reason and next safe action without duplicate spam.

### User Story 4 - Receive product and purchase-activity announcements (Priority: P2)

Customers who allow shop notifications receive new-product/restock information and privacy-safe
purchase activity, with controls to disable either category.

**Independent Test**: Seed customers with different preferences, create product/restock/sale events,
and prove correct fields, privacy, aggregation, opt-out, quiet hours, and delivery throttling.

**Acceptance Scenarios**:

1. **Given** an authorized active Product Variant is newly published, **When** the catalog transaction commits, **Then** eligible customers receive product name, quantity added, stock after, unit price, and a product button.
2. **Given** existing stock is increased, **When** restock commits, **Then** eligible customers receive restock quantity, current stock, unit price, and product button exactly once.
3. **Given** a customer Order is paid and fulfilled, **When** purchase-activity notification is generated, **Then** eligible customers see product and quantity without buyer identity, Order code, account data, payment content, credential, or private total.
4. **Given** many purchases in a short period, **When** activity notifications fan out, **Then** events are aggregated/debounced into a digest so every purchase contributes to shop activity without one message per sale per recipient.
5. **Given** a customer disables shop updates or purchase activity, **When** future matching events occur, **Then** no matching promotional/social-proof message is sent to that customer.

### User Story 5 - Send important admin announcements safely (Priority: P2)

The sole root admin drafts, previews, confirms, schedules/sends, and audits an important announcement
to eligible customers without direct loops, accidental duplication, or secret disclosure.

**Independent Test**: Draft an announcement as root and non-root identities, preview recipient counts,
confirm twice, cancel, retry Telegram failures, and verify preferences/critical-message policy.

**Acceptance Scenarios**:

1. **Given** the configured numeric root admin in private chat, **When** an announcement is drafted, **Then** the bot shows sanitized preview, notification class, target segment, estimated recipient count, quiet-hours behavior, and `Gửi/Xếp lịch/Hủy` controls.
2. **Given** any other identity or group chat, **When** broadcast is attempted, **Then** it is denied and audited.
3. **Given** confirmed broadcast, **When** fanout runs, **Then** recipients are enqueued through outbox/worker with Telegram rate/backoff handling and no duplicate delivery per campaign/customer.
4. **Given** a normal shop announcement, **When** a customer opted out, **Then** it is suppressed.
5. **Given** a rare mandatory service/security incident, **When** the admin selects `CRITICAL_SERVICE`, **Then** the message bypasses promotional opt-out only after explicit high-risk confirmation and immutable audit; it cannot contain marketing copy.

### User Story 6 - Control notification preferences (Priority: P2)

A customer opens notification settings and controls shop updates, purchase activity, quiet hours, and
digest frequency while still receiving required transactional and critical service messages.

**Independent Test**: Toggle each setting, replay callbacks, change quiet hours, and prove immediate,
idempotent enforcement across fanout jobs.

**Acceptance Scenarios**:

1. **Given** a customer opens settings, **When** preferences load, **Then** the bot clearly separates `Đơn hàng & thanh toán`, `Thông báo dịch vụ quan trọng`, `Sản phẩm & tồn kho`, and `Hoạt động mua hàng`.
2. **Given** shop updates or purchase activity is disabled, **When** the customer saves, **Then** future fanout is suppressed immediately and the confirmation is idempotent.
3. **Given** quiet hours/digest are configured, **When** a non-critical notification occurs during quiet hours, **Then** it is delayed/aggregated rather than lost or sent immediately.
4. **Given** transactional/critical service classes, **When** settings are viewed, **Then** the bot explains why they cannot be fully disabled and keeps them rare and relevant.

### Edge Cases

- Quantity is zero, negative, non-integer, above per-order max, or above local/supplier availability.
- Two customers concurrently request quantities whose combined demand exceeds stock.
- Supplier supports one unit per request while the Order quantity is greater than one.
- Some of N supplier units succeed while others are rejected/unknown.
- Price changes or stock falls between quantity selector, confirmation, and Payment Intent creation.
- Check-payment is clicked repeatedly, from an old message, or after expiry/cancellation/settlement.
- Cancellation and verified payment race; QR generation/send fails after Order commit.
- Telegram returns 403 blocked bot, 429 retry-after, timeout, or permanent chat failure during fanout.
- Admin double-confirms, retries, edits, schedules, or cancels a campaign concurrently.
- Product is archived after announcement enqueue but before delivery.
- Purchase activity volume is high enough to spam all customers.
- Customer changes preferences while fanout batches are already queued.
- A broadcast includes URL, formatting, oversized content, credential-like text, or unsafe attachment.

## Requirements

### Quantity and Order Requirements

- **FR-301**: One retail Order MUST contain one Product Variant and integer quantity `1..max_per_order`; multi-item cart remains out of scope.
- **FR-302**: Server MUST revalidate unit price, quantity limit, stock/source policy, and resale eligibility before Order/payment creation.
- **FR-303**: Order MUST snapshot variant, quantity, unit price, total VND, warranty, delivery, source policy, and reconciliation-fee policy.
- **FR-304**: Total MUST equal integer `unit_price_vnd × quantity` with overflow/bounds validation; client callback cannot supply authoritative price/total.
- **FR-305**: Local reservation MUST be atomic and all-or-nothing for requested quantity; insufficient stock creates no Payment Intent.
- **FR-306**: Supplier fulfillment for quantity N MUST use one quantity-capable idempotent request or N deterministic child keys; retries cannot purchase duplicate units.
- **FR-307**: Partial supplier success MUST enter explicit `PARTIAL_FULFILLMENT_REVIEW`; Order cannot be completed until N valid assets or an approved replacement/refund resolution exists.
- **FR-308**: Delivery Bundle MUST bind and reveal exactly N asset references/entitlements without raw credentials in Telegram history.

### Payment Session Requirements

- **FR-309**: Payment presentation MUST include QR image, Order code, product/variant, quantity, unit price, total, bank name, account owner/number, transfer content, expiry, and exact-transfer warning.
- **FR-310**: Bank/payment display fields MUST come from validated merchant configuration and Payment Intent snapshot, never hardcoded message text.
- **FR-311**: `Kiểm tra thanh toán` MUST be idempotent, rate-limited, read local projection first, and never mark paid or trigger one provider query per click.
- **FR-312**: `Hủy thanh toán` MUST use an idempotent state transition, release reservation only when unpaid cancellation wins, and refuse cancellation after verified settlement.
- **FR-313**: Wrong/partial/over/late/unmatched payment MUST display review guidance and configured VND manual-reconciliation policy; no unapproved USD fee or dynamic exchange conversion.
- **FR-314**: Customer copy MUST distinguish `Đã tạo đơn`, `Chờ thanh toán`, `Thanh toán thành công`, `Đang xử lý`, `Cần đối soát`, and `Đơn hàng hoàn tất`.

### Notification Requirements

- **FR-315**: Notification classes MUST be `TRANSACTIONAL`, `CRITICAL_SERVICE`, `SHOP_UPDATE`, and `PURCHASE_ACTIVITY` with separate policy and preference behavior.
- **FR-316**: Transactional notification MUST be scoped to the owning customer and emitted idempotently from committed Order/payment/fulfillment/support events.
- **FR-317**: New-product/restock notification MUST show product/variant name, quantity added, stock after, current unit price, and product deep link from authoritative snapshots.
- **FR-318**: Purchase-activity notification MUST show only privacy-safe product/quantity/social-proof data; buyer identity, Order code, account, payment reference, credential, and private total are forbidden.
- **FR-319**: Purchase activity MUST aggregate/debounce high-volume events and enforce a per-recipient frequency cap; every sale contributes to an aggregate without requiring one message per sale.
- **FR-320**: Customer MUST be able to independently disable `SHOP_UPDATE` and `PURCHASE_ACTIVITY`, and configure quiet hours/digest frequency.
- **FR-321**: `TRANSACTIONAL` and rare `CRITICAL_SERVICE` notifications cannot be fully disabled; UI MUST explain this and prevent marketing content in `CRITICAL_SERVICE`.
- **FR-322**: Root admin broadcast MUST support draft, sanitized preview, target segment, recipient count estimate, schedule/send/cancel, high-risk confirmation, idempotency, and audit.
- **FR-323**: Broadcast fanout MUST use outbox/worker batches, Telegram retry-after/backoff, per-chat dedupe, blocked-chat suppression, progress metrics, and cancellation of unsent batches.
- **FR-324**: Preference changes MUST apply immediately to unsent fanout items and be idempotent under replay.

### Anti-Spam and Security Requirements

- **SR-301**: Buy Now/payment creation MUST enforce callback dedupe and configurable limits no weaker than 3/minute and 10/hour/customer at pilot start.
- **SR-302**: Check-payment MUST enforce no weaker than one action per 5 seconds and 30/hour/customer and must not poll SePay synchronously per click.
- **SR-303**: Notification fanout MUST enforce Telegram global/per-chat limits, `retry_after`, bounded retries, dead-letter handling, and no tight loops.
- **SR-304**: Campaign/customer unique key MUST prevent duplicate delivery despite worker retry, admin double-confirm, or restart.
- **SR-305**: Broadcast content MUST be length/type/Unicode/URL/format validated and scanned for credential-like content; no arbitrary file/URL fetch.
- **SR-306**: Only configured numeric root admin in private context may create/confirm/cancel campaign; `CRITICAL_SERVICE` requires step-up, reason, and immutable audit.
- **SR-307**: Preference and quiet-hour reads MUST be customer-scoped; opaque callback IDs do not replace authorization.
- **SR-308**: No notification may contain raw credential, provider secret, full bank transaction payload, another customer's identity, or another customer's Order/payment data.

### Key Entities

- **OrderQuantitySnapshot**: one Variant, quantity, unit price, total, fulfillment count, and policy snapshots.
- **PaymentPresentation**: Order/Payment Intent display snapshot, QR media reference, bank fields, transfer content, expiry, and state.
- **NotificationPreference**: per-customer class toggles, quiet hours, timezone, digest interval, and version.
- **NotificationCampaign**: root-admin draft/content/class/segment/schedule/status/idempotency/audit aggregate.
- **NotificationDelivery**: campaign/event/customer/chat delivery status, attempt, retry time, dedupe key, and suppression reason.
- **NotificationDigest**: customer/class/window aggregate of purchase/product events.

## Success Criteria

- **SC-301**: Quantities 1 through configured maximum produce exact integer totals and exactly N reserved/delivered assets in 100% of fixtures.
- **SC-302**: Concurrent quantity tests never reserve more local assets than available and never duplicate supplier unit purchases.
- **SC-303**: Payment presentation fields and QR payload match the Payment Intent/merchant snapshot in 100% of contract fixtures.
- **SC-304**: Replaying create/check/cancel callbacks 100 times produces one logical Order/payment/cancellation outcome.
- **SC-305**: Replaying transactional/campaign events 100 times sends at most one notification per event/campaign/customer dedupe key.
- **SC-306**: Customers who disable shop/purchase notifications receive zero future matching promotional messages after preference commit.
- **SC-307**: Purchase-activity fixtures expose zero buyer identity, Order/payment reference, account information, credential, or private total.
- **SC-308**: At pilot load, non-critical recipients receive no more than configured frequency cap; high-volume purchase events are delivered as digest/aggregate.
- **SC-309**: Telegram 429/timeout/restart fixtures recover through backoff without message storm or loss of transactional state.
- **SC-310**: Unauthorized broadcast and critical-class attempts are denied and audited in 100% of identity/context fixtures.

## Assumptions

- Quantity means multiple units of one Product Variant; different products still require separate Orders.
- Initial `max_per_order` is configurable per Variant and bounded globally; it is not inferred from customer input.
- Manual reconciliation fee, if used, is an explicit integer VND policy displayed before payment and snapshotted; no hardcoded `$2` conversion.
- Transactional and critical service notifications remain available for safety/order fulfillment; customers can disable shop updates and purchase activity.
- Purchase social proof is privacy-safe and aggregated to meet anti-spam requirements.
- Telegram delivery is at-least-once; business and notification effects are idempotent.

## Out of Scope

- Multi-item cart, split tender, public buyer leaderboard, buyer username/identity in social proof.
- Raw credentials in chat notifications or public purchase activity.
- Arbitrary admin HTML/files/URLs, unbounded broadcasts, or bypassing customer preferences for marketing.
- Synchronous SePay polling per customer click.

## Dependencies & Launch Gates

- Feature 001 Order/payment/inventory/fulfillment state and outbox events.
- Product Variant `max_per_order`, stock/source capability, supplier quantity contract, and partial-fulfillment policy.
- Merchant VietQR/SePay bank configuration and integer VND manual-reconciliation policy.
- Telegram bot send/edit/photo capability, retry-after handling, blocked-chat lifecycle, and fanout load evidence.
- Owner-approved notification classes, exact preference defaults, quiet hours, purchase digest/frequency cap, and critical-service policy.
- Privacy review confirming no buyer data in purchase activity and no secrets in transactional/admin notifications.
