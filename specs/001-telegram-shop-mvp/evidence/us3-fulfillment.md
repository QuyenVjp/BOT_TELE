# US3 Fulfillment Evidence (T079)

**Date**: 2026-07-16
**Scope**: User Story 3 — Secure Fulfillment and Delivery (FR-013–FR-017, FR-020, SC-004/SC-006/SC-007, SR-001/SR-003/SR-006)

## Acceptance lane

Command:

```bash
npx vitest run tests/acceptance/fulfillment-journey.test.ts
```

Result:

```
✓ tests/acceptance/fulfillment-journey.test.ts (1 test)
  ✓ Buy Now → SePay settle → fulfill local asset → owner reveal (SC-004 timing)
```

The journey drives Buy Now → VietQR → SePay settle → local claim + Delivery Bundle
→ owner reveal against a real PostgreSQL container. Paid-to-delivery wall-clock is
asserted under 30 s (SC-004). Presenters never embed the secret.

## Historical supporting lanes (superseded as final-source evidence)

```
✓ tests/property/asset-claim.test.ts              (3)   FR-014/SC-006 20 concurrent buyers → one claim
✓ tests/contract/supplier-port.test.ts            (16)  FR-015/FR-016 schema, idempotency, UNKNOWN recovery
✓ tests/integration/fulfillment-recovery.test.ts  (4)   FR-010/SR-006 crash/replay at every boundary
✓ tests/security/delivery-bundle.test.ts          (8)   FR-017/SR-003 ownership, view-once, reissue
✓ tests/security/credential-leak.test.ts          (6)   SR-001/SC-007 zero raw secrets in fixtures
✓ tests/contract/asset-validation.test.ts         (9)   FR-016 quarantine reasons
✓ tests/integration/supplier-service.test.ts      (4)   FR-015 provision + UNKNOWN→query recovery
✓ tests/contract/fulfillment-telemetry.test.ts    (5)   supplier/fulfillment alerts
✓ tests/contract/vault-adapter.test.ts            (4)   T072 vault boundary fail-closed
✓ tests/contract/delivery-route.test.ts           (2)   T074 no-cache authenticated reveal
✓ tests/integration/fulfillment-handlers.test.ts  (2)   T076 OrderPaid → fulfill via outbox
✓ tests/integration/replacement.test.ts           (3)   T078 replacement/refund preserves history
```

Combined suite at US3 close: **219 tests / 35 files passed**.

## Requirement coverage

| FR / SC / SR | How proven |
|---|---|
| FR-013 Fulfillment only after verified payment | `fulfillPaidOrder` rejects non-PAID/PROCESSING/COMPLETED with `NOT_PAID`; acceptance journey settles via SePay before fulfill |
| FR-014 Atomic local claim (SC-006) | 20 concurrent `claimLocalAsset` calls → exactly one RESERVED winner; unique active-fingerprint index + `FOR UPDATE SKIP LOCKED` |
| FR-015 Supplier create idempotent; UNKNOWN before retry | Sandbox adapter + `provisionFromSupplier` / `recoverUnknownSupplierOrder`; timeout → UNKNOWN → query recovers FULFILLED; one `supplier_order` row |
| FR-016 Asset validation before delivery | `validateAssetEnvelope` quarantines SKU/type/duration/region/expiry mismatches; never echoes vault refs |
| FR-017 View-once Delivery Bundle | Issue stores only token hash; reveal AVAILABLE→CONSUMED under version guard; concurrent reveals → one winner; reissue only when no live bundle |
| FR-020 Replacement/refund preserves history | `openReplacementCase` inserts case with original asset; refund → REFUND_PENDING + order_transition; original asset row untouched |
| SC-004 Paid-to-delivery timing | Acceptance asserts paid→fulfill < 30 s wall-clock on containerized Postgres |
| SC-006 Final-asset concurrency | Property test: 20 buyers, 1 claim, 1 active fingerprint |
| SC-007 / SR-001 Zero raw secrets | Credential-leak suite + vault-ref-only envelopes + audit tripwire + telemetry allowlist |
| SR-003 Ownership | Delivery reveal refuses non-owner without consuming; replacement refuses non-owner |
| SR-006 Crash/replay safety | Fulfillment recovery + outbox handler replay: one asset, one bundle under re-entry |

## Exactly-once design notes

- **Local claim**: `FOR UPDATE SKIP LOCKED` + version-guarded RESERVED + unique active fingerprint.
- **Supplier create**: unique `(supplier_id, idempotency_key)`; UNKNOWN recovered by query only.
- **Delivery Bundle**: unique active-per-order index; token hash unique; reveal version-guarded to CONSUMED.
- **Outbox**: `OrderPaid` handler re-enters `fulfillPaidOrder`, which reuses held asset + active bundle.

## Independence

US3 consumes `OrderPaid` from the outbox and never invents settlement. Raw credentials exist only inside the vault/reveal boundary (memory or external driver). Delivery presenters link to the authenticated `/d/:token` surface and never embed the secret.

## Remaining production seams (documented, not blocking US3 checkpoint)

- External vault provider client (driver selected, refuses silent memory fallback).
- Telegram delivery notifier (handler injects the port; worker boots without it).
- HTTP supplier adapter (fixture/sandbox is the authorized first adapter).
