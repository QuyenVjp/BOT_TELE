# Implementation Plan: Notifications, Quantity Checkout, and Payment UX

**Branch**: `003-notifications-quantity-checkout` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

## Summary

Extend the current single-Variant Order with bounded quantity, all-or-nothing reservation, exact VND
total, multi-asset delivery, and explicit partial-fulfillment review. Add canonical QR/payment-state
presenters and event-driven notification modules for transactional updates, admin campaigns,
product/restock announcements, privacy-safe purchase activity, preferences, aggregation, and fanout.

## Technical Context

**Language/Stack**: Existing Node.js 24 LTS, TypeScript strict, Fastify, grammY, Zod, Kysely,
PostgreSQL, transactional outbox, Vitest/Testcontainers/fast-check, Pino/OpenTelemetry

**Storage**: Existing Order/payment/inventory tables plus quantity snapshot, NotificationPreference,
Campaign, Delivery, Digest, and QR media reference fields in PostgreSQL; Redis optional for ephemeral
rate counters only

**Testing**: Contract/property/integration/acceptance tests for exact totals, concurrency, quantity
supplier idempotency, QR/copy, payment/cancel race, fanout dedupe, preference race, 429/backoff, privacy,
and campaign authorization

**Performance Goals**: Payment card under 1 second after Order commit when QR generation is healthy;
transactional notification enqueue in the same committed event path; broadcast fanout respects
Telegram limits; purchase activity per-recipient cap defaults to one message/10 minutes with digest

**Constraints**: One Variant per Order, quantity integer/bounded; VND only; no raw credentials in
Telegram; SePay truth unchanged; no per-click provider poll; root-admin-only campaigns; opt-out for
shop/social notifications; critical service is rare/non-marketing

## Constitution Check

| Gate | Status | Evidence |
|---|---|---|
| Customer-first simplicity | PASS | Quantity is one Variant; no multi-item cart |
| Verified payment truth | PASS | Check/cancel cannot create/override SePay evidence |
| Secret protection | PASS | Delivery uses Bundle button; no raw credentials in notification |
| Contract-first state | PASS | Quantity, payment, campaign, preference, delivery contracts |
| Test-first replay/concurrency | PASS | Quantity/fanout/callback/property tests precede code |
| Anti-spam | PASS | aggregation, frequency caps, Telegram retry/backoff, preference suppression |
| Privacy | PASS | public purchase activity excludes buyer/Order/payment/private data |

## Architecture

```text
Order/Payment/Fulfillment/Catalog committed events
  → Transactional Outbox
  → Notification Policy
       ├─ owner-only transactional recipient
       ├─ preference/quiet-hour/digest evaluation
       └─ privacy-safe snapshot builder
  → NotificationDelivery rows
  → Telegram fanout worker (rate/backoff/dedupe)
```

Admin broadcast:

```text
Root private command → Draft → Preview/recipient estimate → Step-up confirm
→ Campaign scheduled/sending → batched deliveries → completed/cancelled/partial failure
```

Quantity checkout:

```text
Select one Variant + quantity
→ server revalidate price/max/stock/source
→ atomic N reservation + Order snapshot
→ one exact-total Payment Intent + VietQR
→ verified SePay paid event
→ claim/provision N units with deterministic unit keys
→ one Delivery Bundle containing N safe entitlements
```

## Source Structure

```text
src/modules/commerce/quantity.ts
src/modules/commerce/order.ts
src/modules/commerce/buy-now.ts
src/modules/payments/presentation.ts
src/modules/payments/vietqr.ts
src/modules/digital-goods/multi-fulfillment.ts
src/modules/notifications/
├── domain.ts
├── policy.ts
├── preferences.ts
├── campaign.ts
├── digest.ts
├── fanout.ts
├── repository.ts
└── telemetry.ts
src/bot/callbacks/quantity.ts
src/bot/callbacks/payment.ts
src/bot/callbacks/notifications.ts
src/bot/callbacks/admin-broadcast.ts
src/bot/presenters/payment.ts
src/bot/presenters/notifications.ts
src/infrastructure/db/migrations/010_notifications_quantity.sql
tests/contract/
tests/integration/
tests/property/
tests/acceptance/
tests/security/
```

## Canonical payment copy states

### Awaiting payment

```text
🏦 THANH TOÁN CHUYỂN KHOẢN

🆔 Mã đơn: {orderNumber}
🏷️ {productName} — {variantName}
📦 Số lượng: {quantity}
💵 Đơn giá: {unitPriceVnd}
💰 Tổng thanh toán: {totalVnd}

🏛️ Ngân hàng: {bankName}
👤 Chủ tài khoản: {accountName}
💳 Số tài khoản: {accountNumber}
📝 Nội dung chuyển khoản: {transferContent}
⏳ Hết hạn: {expiresAtVietnam}

⚠️ Vui lòng chuyển đúng số tiền và nội dung. Giao dịch sai thông tin có thể cần đối soát thủ công theo chính sách đã hiển thị.
👆 Quét QR phía trên bằng ứng dụng ngân hàng.
✅ Đơn được xử lý tự động sau khi SePay xác nhận tiền vào.

[ 🔄 Kiểm tra thanh toán ] [ ❌ Hủy thanh toán ]
```

### Settled/processing

```text
✅ THANH TOÁN THÀNH CÔNG

🆔 Mã đơn: {orderNumber}
🏷️ {productName} — {variantName} × {quantity}
💰 Đã nhận: {totalVnd}

⏳ Đang chuẩn bị {quantity} sản phẩm...
```

### Completed

```text
✅ ĐƠN HÀNG HOÀN TẤT

🆔 Mã đơn: {orderNumber}
🏷️ {productName} — {variantName} × {quantity}
🛡️ Bảo hành đến: {warrantyDeadline}

[ 🔐 Nhận {quantity} sản phẩm ]
[ 📖 Hướng dẫn ] [ 🛠 Báo lỗi ]
```

## Complexity Tracking

Quantity is an additive single-line extension, not a cart. Purchase activity is aggregated instead
of sending every sale as one immediate message to every customer, because direct fanout would violate
the user's anti-spam requirement and Telegram rate limits while adding no additional customer value.
