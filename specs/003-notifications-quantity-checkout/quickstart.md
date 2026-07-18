# Feature 003 Quickstart and Acceptance Lanes

This document defines the pre-implementation verification lanes for Feature 003. It is a test
scenario contract, not a production runbook. Run against fake providers and a disposable PostgreSQL
database; never use live bank credentials or the production Telegram bot in CI.

## Preconditions

1. Keep `.specify/feature.json` pinned to `specs/001-telegram-shop-mvp` while Claude finishes the
   active MVP. Feature 003 artifacts are read by path and must not change the active feature state.
2. Use `npm ci`, `npm run secret-scan`, `npm run typecheck`, and `npm run lint` before the feature lanes.
3. Seed one sellable Product Variant with a configured `max_per_order`, integer VND unit price,
   ten compatible digital assets, a fake supplier adapter, a fake SePay verifier, and a deterministic
   VietQR renderer.
4. Seed at least three customers: opted-in, opted-out, and a customer in quiet hours. Seed the sole
   root admin by numeric Telegram ID only; the expected username is metadata, not authorization.

## Lane A — quantity and fulfillment

- Quantities `1`, `3`, and `max_per_order` produce one Order, exact `unit_price_vnd × quantity`,
  all-or-nothing reservation, and exactly N delivered entitlements.
- Quantities `0`, negative, fractional, above maximum, and above stock produce a typed rejection,
  show the allowed maximum/availability, and create no Payment Intent.
- Replaying the same Buy Now idempotency token 100 times returns one logical Order/Payment Intent.
- Concurrent requests cannot reserve more assets than available. A supplier supporting quantity uses
  one idempotent request; a supplier without it uses `{orderId}:{unitIndex}` keys. Timeout/unknown and
  partial success go to reconciliation/review before retry or completion.

## Lane B — VietQR payment session

- The awaiting-payment presenter contains QR image, Order code, product/variant, quantity, unit price,
  exact total, validated bank/owner/account display, transfer content, Vietnam-time expiry, warning,
  `Kiểm tra thanh toán`, and `Hủy thanh toán`.
- QR payload and visible fields match the immutable Payment Intent/merchant snapshot. The pre-settlement
  copy says `Đã tạo đơn`/`Chờ thanh toán`, never paid or completed.
- Check-payment reads the local projection first, is limited to one request per five seconds and 30/hour,
  and does not synchronously poll SePay or change paid state. Repeated callbacks are idempotent.
- Cancel is idempotent and releases an unpaid reservation only when cancellation wins. A verified SePay
  settlement wins a race and returns `ALREADY_PAID` to cancel.
- Wrong, partial, over, late, wrong-account, wrong-content, and unmatched evidence become `Cần đối soát`
  with the configured integer VND manual-reconciliation policy and no silent fulfillment.

## Lane C — transactional notifications

- Committed Order/payment/fulfillment/support transitions emit one owner-scoped notification per logical
  transition, even after event replay or worker restart.
- The customer sees distinct Vietnamese states: created/awaiting, payment settled, processing, review,
  cancelled/expired, and completed. A successful payment says preparation is in progress; completion
  offers a safe Delivery Bundle button and never raw credentials in history.

## Lane D — product and purchase activity

- A product publish/restock event shows authoritative product/variant name, added quantity, stock after,
  current unit price, deep link, and notification settings.
- Completed purchases create privacy-safe activity events. Aggregation contributes every sale but caps a
  recipient to the pilot default of one message per ten minutes; no buyer identity, Order/payment data,
  account details, credential, or private total appears.
- Opted-out customers receive zero future matching shop/purchase messages after the preference commit.

## Lane E — admin broadcast and fanout

- Only the configured numeric root admin in private chat can draft, preview, confirm, schedule, send, or
  cancel a campaign. Preview includes class, sanitized body, target, estimate, quiet-hour effect, and
  warnings; confirmation expires and is bound to a campaign fingerprint.
- Fanout is outbox/worker based, deduplicated per campaign/customer, bounded by Telegram limits, honors
  `retry_after`, suppresses blocked chats, reports eligible/suppressed/pending/sent/retrying/dead counts,
  and stops unsent deliveries on cancellation.
- Unauthorized, username-only, group-chat, expired-confirmation, malicious-content, and replay attempts
  are denied and audited. Critical-service campaigns require reason/step-up and contain no marketing CTA.

## Commands and evidence

```text
npm run secret-scan
npm run typecheck
npm run lint
npm run test -- tests/contract/payment-session.test.ts tests/contract/notification-policy.test.ts
npm run test -- tests/property/quantity-idempotency.test.ts tests/property/notification-dedupe.test.ts
npm run test -- tests/integration/quantity-checkout.test.ts tests/integration/payment-race.test.ts tests/integration/notification-fanout.test.ts
npm run test -- tests/security/payment-integrity.test.ts tests/security/notification-privacy.test.ts tests/security/admin-broadcast.test.ts
npm run test:acceptance -- tests/acceptance/quantity-payment-notification-journey.test.ts
```

Record command output, fixture counts, replay counts, rate-limit outcomes, privacy-redaction checks,
and unresolved launch gates under `specs/003-notifications-quantity-checkout/evidence/`. Do not commit
secrets, raw credentials, real transfer content, or private customer data.
