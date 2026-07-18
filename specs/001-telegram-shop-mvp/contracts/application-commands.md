# Contract: Application Commands and Events

## Envelope

Every command carries:

- `commandId`: unique request identifier.
- `idempotencyKey`: stable per logical mutation.
- `actor`: customer, root admin, system, provider, or worker identity with scoped identifier.
- `correlationId`: stable across Telegram update, Order, payment, supplier, delivery, and audit.
- `occurredAt`: trusted server time.
- typed payload validated at the ingress boundary.

Every command returns either a typed success or one stable error envelope:

```text
Error { code, messageVi, retryable, correlationId, safeDetails? }
```

No error includes stack trace, secret, raw provider body, vault reference, or another customer's existence.

## Core commands

| Command | Input | Success | Stable errors |
|---|---|---|---|
| `SearchCatalog` | bounded filters, cursor, page size | authoritative product cards + next cursor | `INVALID_FILTER`, `RATE_LIMITED` |
| `BuyNow` | customer ID, variant ID, expected price, stable signed checkout nonce | Order snapshot + reserved asset id (when local stock) + payment presentation status | `VARIANT_UNAVAILABLE`, `PRICE_CHANGED`, `NO_STOCK`, `CONTENTION_TIMEOUT`, `RESERVATION_LOST`, `POLICY_BLOCKED` |
| `CreatePaymentIntent` | Order ID | exact amount/content/expiry + QR representation using separately configured VietQR beneficiary and SePay merchant identity fields (equal or distinct values) + bank display name | `ORDER_NOT_PAYABLE`, `PAYMENT_ALREADY_ACTIVE`, `NO_ACTIVE_RESERVATION`, `PROVIDER_UNAVAILABLE` |
| `ApplyPaymentEvidence` | branded `VerifiedSePayEvidence` only (never raw provider payload) | Payment Intent status + outbox event, or owned discrepancy | `EVIDENCE_INVALID`, `MISMATCH_NEEDS_REVIEW`, `ALREADY_ALLOCATED`, `ALREADY_PAID`, `MONEY_FOR_TERMINAL_ORDER` |
| `CancelUnpaidOrder` | Order ID, owning customer ID | cancelled Order + released reservation + voided intent | `ORDER_NOT_OWNED`, `ORDER_NOT_CANCELLABLE`, `ALREADY_PAID` |
| `StartFulfillment` | paid Order ID | upgrade of the pre-payment reservation (local) or Supplier Order reference; claim + outbox event in one transaction | `ORDER_NOT_PAID`, `FULFILLMENT_EXISTS`, `NO_SOURCE_AVAILABLE`, `RESERVATION_LOST` |
| `CreateDeliveryBundle` | Order ID, asset ID | expiry + opaque reveal URL | `ASSET_NOT_READY`, `BUNDLE_EXISTS`, `OWNERSHIP_MISMATCH` |
| `RedeemDeliveryMiniAppSession` | verified Telegram initData, handoff id, one-time audience | one-time reveal session/cookie | `INVALID_INIT_DATA`, `NOT_OWNER`, `EXPIRED`, `WRONG_AUDIENCE`, `REPLAYED_SESSION`, `UNKNOWN_KEY_VERSION` |
| `RevealDeliveryBundle` | token, redeemed Telegram-bound delivery session | one-time secret/entitlement response | `INVALID_TOKEN`, `NOT_OWNER`, `EXPIRED`, `ALREADY_CONSUMED`, `REVOKED`, `WRONG_AUDIENCE`, `REPLAYED_SESSION` |
| `OpenSupportTicket` | customer ID, Order ID?, reason, safe summary | ticket reference + status | `ORDER_NOT_OWNED`, `INVALID_REASON`, `RATE_LIMITED` |
| `ConfirmAdminAction` | root identity, challenge, action fingerprint | confirmation receipt | `NOT_ROOT_ADMIN`, `WRONG_CONTEXT`, `CHALLENGE_EXPIRED`, `ACTION_MISMATCH` |

## BuyNow reservation contract

1. Ingress supplies a **stable signed checkout nonce** as the idempotency key. Handlers MUST NOT mint a
   fresh random key when the callback omits one.
2. Inside one PostgreSQL transaction the command:
   - revalidates variant/price/policy,
   - for finite local stock, reserves exactly one `AVAILABLE` asset (`created_at, id` order,
     `SKIP LOCKED`) setting `RESERVED` + `reserved_order_id` + `reserved_until`,
   - inserts the Order in `PENDING_PAYMENT` with the immutable snapshot,
   - returns success only after that commit.
3. Only after a successful reservation+Order commit may the caller present a Payment Intent/VietQR.
4. A reservation failure returns exactly one of `NO_STOCK`, `CONTENTION_TIMEOUT`, or
   `RESERVATION_LOST` with no Order, no Payment Intent, no QR, and one non-duplicated typed message
   stating the customer was not charged. `OUT_OF_STOCK` is not emitted by this contract; it may only
   remain as a deprecated internal alias for a proven legacy caller.
5. Payment presentation is policy-allowlisted. `LOCAL_ONLY` and `LOCAL_THEN_SUPPLIER` require a valid
   active reservation. `SUPPLIER_ONLY`, `PAUSED`, null, and unknown policy snapshots fail closed and
   cannot create a Payment Intent or VietQR in Feature 001.
6. Notify-when-available is absent until a durable subscription contract covers persistence,
   opt-in, opt-out, dedupe, restock events, and delivery retry. Presenter buttons expose only routed
   handlers and do not use different labels for the same navigation action.
7. Idempotent re-entry with the same customer+nonce returns the existing Order/reservation without a
   second claim. Implementation MUST use `INSERT ... ON CONFLICT DO NOTHING RETURNING` or a savepoint;
   catching a unique violation and querying on the aborted transaction is forbidden.

## Domain events

Events are at-least-once and contain no raw secret:

- `OrderCreated`, `InventoryReserved`, `InventoryReservationReleased`, `PaymentIntentPresented`,
  `PaymentSettled`, `PaymentNeedsReview`.
- `OrderPaid`, `SupplierFulfillmentRequested`, `SupplierOrderUnknown`, `SupplierAssetReady`.
- `DigitalAssetClaimed`, `DeliveryBundleCreated`, `DigitalAssetDelivered`.
- `TicketOpened`, `ReplacementRequested`, `RefundRequested`.

Consumers deduplicate by `eventId` plus aggregate version. Business-effect consumers also enforce a
domain unique key such as settled Bank Transaction, supplier idempotency key, claimed asset, or active Delivery Bundle.
Outbox publish ack/fail MUST be fenced by claim owner + generation so a stale worker cannot clear a reclaimed event.
