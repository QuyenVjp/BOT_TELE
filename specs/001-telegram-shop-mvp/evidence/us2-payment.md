# US2 Payment Evidence (T058)

**Date**: 2026-07-16
**Scope**: User Story 2 — Buy and Pay with VietQR (FR-006–FR-012, SC-005/SC-008, SR-002/SR-004)

## Acceptance lane

Command:

```bash
npx vitest run tests/acceptance/payment-journey.test.ts
```

Result:

```
✓ tests/acceptance/payment-journey.test.ts (2 tests)
  ✓ creates an unpaid order, presents VietQR, and settles on verified evidence
  ✓ Buy Now double-tap is idempotent (same order, one intent)
```

The journey drives Buy Now → PaymentIntent + VietQR presentation → verified SePay
evidence → PAID Order against a real PostgreSQL container. VietQR presentation carries
no settlement flag; only SePay evidence settles.

## Historical supporting lanes (superseded as final-source evidence)

```
✓ tests/contract/vietqr-presentation.test.ts   (6)   FR-008 EMVCo TLV + CRC-16/CCITT
✓ tests/contract/sepay-webhook.test.ts         (12)  FR-009/SR-002/SR-004 HMAC + timestamp + schema
✓ tests/property/payment-idempotency.test.ts   (3)   FR-010/SC-005 100x replay → one settlement
✓ tests/integration/payment-discrepancy.test.ts(7)   FR-011/SC-008 under/over/late/wrong-account/unmatched
✓ tests/integration/payment-reconciliation.test.ts(5) FR-012 missing-webhook recovery + rate/backoff
✓ tests/contract/payment-presenter.test.ts     (9)   payment/expiry/settled/review copy, no screenshot
✓ tests/integration/checkout-callbacks.test.ts (6)   Buy Now / refresh / reopen / cancel
✓ tests/contract/payment-telemetry.test.ts     (6)   signature/collision/paid-without-order/backlog/lag alerts
```

Combined US2 payment run: **56 tests / 9 files passed**.

## Requirement coverage

| FR / SC / SR | How proven |
|---|---|
| FR-006 Sellability recheck at Buy Now | `buyNow` reloads the live variant and rejects with a stable code (VARIANT_UNAVAILABLE/PRICE_CHANGED/OUT_OF_STOCK/POLICY_BLOCKED) before any Order row exists |
| FR-007 Immutable Order snapshot | Order captures product/variant/price/duration/delivery/warranty at creation; later catalog edits never rewrite the row |
| FR-008 VietQR exact amount + unique content | EMVCo TLV payload with integer VND amount tag 54 and order-derived transfer content; CRC-16/CCITT over body+`6304`; presentation view exposes copyable fields + expiry and no settlement flag |
| FR-009 SePay raw-body verification | HMAC-SHA256 over `{timestamp}.{raw_body}`, constant-time compare, replay-window timestamp check, allowlisted Zod schema — verified before any match |
| FR-010 Replay/idempotency (SC-005) | `applyPaymentEvidence` dedupes on `bank_transaction (provider, provider_transaction_id)`; 100x replay yields exactly one SETTLED allocation, one PaymentSettled event, PAID order, `countUnpublished ≤ 2` |
| FR-011 Discrepancy classification (SC-008) | `decideMatch` returns typed discrepancies (UNDERPAYMENT/OVERPAYMENT/WRONG_ACCOUNT/LATE_PAYMENT/UNMATCHED); order stays PENDING_PAYMENT, intent flagged NEEDS_REVIEW, PaymentNeedsReview emitted — never a silent mark-paid |
| FR-012 Reconciliation recovery | `reconcileSePay` feeds provider rows through the SAME `applyPaymentEvidence` pipeline: recovers missing webhooks, no-ops duplicates, turns mismatches into discrepancies, and honors a provider-call rate budget with deferral |
| SC-005 Exactly-once effect | Unique-effect keys: bank txn provider id, settled allocation per bank txn, one active intent per order/content, outbox dedupe key |
| SR-002/SR-004 Fail-closed ingress | Signature/timestamp/schema gates precede parse; matcher requires inbound + exact account + exact amount + live content |
| SR-001 No secret leakage | Payment telemetry allowlists diagnostic fields; smuggled `secret`/`signature` fields are dropped from alert payloads (asserted) |

## Exactly-once design notes

Settlement runs in ONE transaction (SR-006): dedup-insert `bank_transaction` →
`decideMatch` → on SETTLE insert SETTLED `payment_allocation` + `settleIntent`
(version-guarded) + `transitionOrder` to PAID + enqueue `PaymentSettled` and
`OrderPaid` outbox events (dedupe key `aggregate_type + aggregate_id +
aggregate_version + event_type`). Because the bank transaction insert uses
`ON CONFLICT DO NOTHING`, a replayed webhook returns `ALREADY_APPLIED` before any
downstream effect, so the settlement pipeline is entered at most once per real
transfer.

## Independence

US2 produces PAID Orders from SePay evidence only. No fulfillment, supplier, or
credential capability is wired into the payment path — the settlement service emits
`OrderPaid`/`PaymentSettled` for downstream stories to consume via the outbox, but
never starts provisioning itself.
