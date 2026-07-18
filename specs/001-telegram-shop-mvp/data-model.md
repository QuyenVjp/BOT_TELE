# Data Model: Telegram Shop Digital MVP

## Conventions

- Primary identifiers are opaque UUID/ULID values; public Order numbers are separate and non-secret.
- Money is integer VND (`bigint`-safe application type); timestamps are UTC and rendered in `Asia/Ho_Chi_Minh`.
- Every mutable aggregate has `version`; every transition has actor, correlation ID, reason, and time.
- Secrets are represented only by vault references and redacted metadata.
- Unique constraints enforce idempotency and business-effect cardinality in addition to application checks.

## Catalog

### Category

`id`, `name_vi`, `slug`, `is_active`, `sort_order`, `created_at`, `updated_at`, `version`.

Rules: active slug unique; inactive categories are not browsable; deletion never removes Order history.

### Product

`id`, `category_id`, `name_vi`, `slug`, `short_description_vi`, `image_asset_id`, `is_active`,
`sort_order`, `created_at`, `updated_at`, `version`.

### ProductVariant

`id`, `product_id`, `sku`, `name_vi`, `price_vnd`, `duration_code`, `delivery_type`,
`warranty_days`, `stock_policy`, `supplier_sku_id?`, `resale_evidence_id`, `is_active`,
`sort_order`, `created_at`, `updated_at`, `version`.

`delivery_type`: `INVITE | LICENSE | ACTIVATION_KEY | CREDENTIAL | MANUAL_REVIEW`.

`stock_policy`: `LOCAL_ONLY | SUPPLIER_ONLY | LOCAL_THEN_SUPPLIER | PAUSED`.

Invariant: variant is sellable only when product/category/variant are active, price is positive,
resale evidence is valid, and the stock policy is explicitly allowed by the current feature. Feature
001 allows `LOCAL_ONLY` and `LOCAL_THEN_SUPPLIER`; `SUPPLIER_ONLY`, `PAUSED`, null, and unknown
policies are excluded from list/detail/search and cannot mint payment.

### ProductAlias

`id`, `product_id`, `normalized_alias`, `locale`, `priority`.

Unique: `(locale, normalized_alias, product_id)`.

## Identity and administration

### Customer

`id`, `status`, `locale`, `created_at`, `last_seen_at`, `version`.

### ChannelIdentity

`id`, `customer_id`, `channel`, `channel_user_id`, `observed_username?`, `username_observed_at?`,
`created_at`, `last_seen_at`.

Canonical channel value is `TELEGRAM` (uppercase, enforced by a database CHECK/normalization).
Unique: `(channel, channel_user_id)`. Authorization uses numeric `channel_user_id`, never username.
The first private `/start` performs an atomic Customer + ChannelIdentity upsert; username is
metadata only. Concurrent starts converge to one identity, and bootstrap resolves only the
configured numeric root ID on a fresh database; it never copies the expected username into
observed metadata. `observed_username` and `username_observed_at` may change only from a
secret-verified Telegram webhook. A bounded job clears both after 30 days without a newer verified
observation. The durable inbox excludes `actorUsername`; temporary observations are stripped after
processing.

### AdminConfirmation

`id`, `root_channel_identity_id`, `action_fingerprint`, `challenge_hash`, `status`, `expires_at`,
`confirmed_at?`, `consumed_at?`, `correlation_id`, `allowlisted_command_ref`, `payload_redacted`.

State: `CREATED -> CONFIRMED -> CONSUMED`; `CREATED/CONFIRMED -> EXPIRED`; any active state -> `REVOKED`.

Rules: confirmation state is durable PostgreSQL state, never an in-process `Map`. The allowlisted
command reference and redacted payload survive process restart. Consume of a confirmation, the
mutation it authorizes, and the audit event MUST commit as one recoverable unit (same transaction
or transaction + outbox event).

## Commerce and payment

### Order

`id`, `order_number`, `customer_id`, `variant_id`, snapshot fields (`product_name_vi`,
`variant_name_vi`, `price_vnd`, `duration_code`, `delivery_type`, `warranty_days`,
`supplier_policy_snapshot`), `status`, `expires_at`, `paid_at?`, `completed_at?`, `version`,
`created_at`, `updated_at`.

State:

```text
DRAFT -> PENDING_PAYMENT -> PAID -> PROCESSING -> COMPLETED
DRAFT -> REJECTED
PENDING_PAYMENT -> CANCELLED | EXPIRED | PAYMENT_NEEDS_REVIEW
PAID | PROCESSING -> FULFILLMENT_NEEDS_REVIEW
PAID | PROCESSING | COMPLETED -> REFUND_PENDING -> REFUNDED
```

Guards: `PAID` requires one settled Payment Allocation; `COMPLETED` requires one issued Delivery Bundle.

### OrderTransition

`id`, `order_id`, `from_status`, `to_status`, `reason_code`, `actor_type`, `actor_id?`,
`correlation_id`, `occurred_at`, `metadata_redacted`.

### PaymentIntent

`id`, `order_id`, `status`, `amount_vnd`, `merchant_account_id`, `vietqr_account_number`,
`transfer_content`, `bank_display_name?`, `expires_at`, `presented_at?`, `settled_at?`, `version`,
`created_at`.

Unique active intent per Order; transfer content unique within the reconciliation window.

`merchant_account_id` is the canonical SePay merchant identity used for inbound matching.
`vietqr_account_number` is the VietQR beneficiary account number rendered into the EMVCo payload.
These are distinct configuration fields and MUST NOT be collapsed into one field at runtime. Their
values MAY be equal for a single-account pilot or distinct for a VA/sub-account deployment.

State: `CREATED -> PRESENTED -> SUCCEEDED | EXPIRED | FAILED | NEEDS_REVIEW`;
`EXPIRED -> NEEDS_REVIEW` on late evidence; `SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED`;
`CREATED/PRESENTED -> FAILED` on Order cancel/expiry void.

### BankTransaction

`id`, `provider`, `provider_transaction_id`, `direction`, `merchant_account_id`, `amount_vnd`,
`content`, `reference`, `transacted_at`, `received_at`, `raw_hash`, `signature_status`,
`schema_version`, `metadata_redacted`.

Unique: `(provider, provider_transaction_id)`.

### PaymentAllocation

`id`, `bank_transaction_id`, `payment_intent_id`, `allocated_amount_vnd`, `status`, `decision_code`,
`decided_at`, `correlation_id`.

Unique settled allocation by BankTransaction. Sum of successful allocations must satisfy policy
before Payment Intent succeeds.

### Discrepancy

`id`, `type`, `bank_transaction_id?`, `payment_intent_id?`, `order_id?`, `status`, `reason`,
`owner`, `due_at`, `resolution_code?`, `resolved_at?`, `audit_event_id?`.

Types: `UNDERPAYMENT | OVERPAYMENT | LATE_PAYMENT | WRONG_CONTENT | WRONG_ACCOUNT |
UNMATCHED | REFERENCE_COLLISION | REFUND_MISMATCH`.

## Digital goods and supplier

### DigitalAsset

`id`, `variant_id`, `source_type`, `supplier_order_id?`, `vault_ref`, `fingerprint_hash`, `status`,
`expires_at?`, `region?`, `validation_summary`, `reserved_order_id?`, `reserved_until?`,
`delivered_order_id?`, `version`, `created_at`, `updated_at`.

State:

```text
AVAILABLE -> RESERVED -> READY -> DELIVERED
RESERVED -> AVAILABLE | EXPIRED
PROVISIONING -> READY | SUPPLIER_NEEDS_REVIEW | FAILED
READY | DELIVERED -> COMPROMISED | REVOKED
```

### Inventory Reservation (pre-payment hold on DigitalAsset)

### Stock-policy state machine (MVP)

| Policy | Pre-payment | Post-payment |
|---|---|---|
| `LOCAL_ONLY` | MUST reserve one concrete local asset before Order+QR; no unit → typed stock failure (no Order/intent/QR) | Upgrade the reserved asset; never claim a second unit |
| `LOCAL_THEN_SUPPLIER` | **Feature 001 = same as LOCAL_ONLY**: MUST reserve a local asset before Order+QR. No local unit → typed stock failure. Supplier is NOT consulted pre-payment | After payment, if the reserved local unit is gone, enter durable supplier/review/refund — NOT a silent second local claim. Full supplier capacity reservation remains mandatory future work |
| `SUPPLIER_ONLY` | **BLOCKED in Feature 001**: excluded from purchasable catalog and Buy Now; no Order/intent/QR | T142/T143 remain open, but sale stays blocked until a real pre-payment capacity hold + reconciliation + refund contract lands |
| `PAUSED`, null, unknown | Excluded/rejected as not sellable; no Order/intent/QR | N/A |

**Why MVP collapses `LOCAL_THEN_SUPPLIER` to `LOCAL_ONLY` pre-payment:** Feature 001 has no supplier capacity guarantee and no supplier reservation protocol. Treating "no local unit → still mint a QR and hope supplier has stock after payment" reintroduces the exact money-for-no-goods race that FR-006a forbids. Scope change is recorded here so the two readings cannot coexist; when supplier capacity is real, a later feature may restore pre-payment supplier reservation.

For `LOCAL_ONLY` / `LOCAL_THEN_SUPPLIER` variants with finite local stock, `BuyNow` MUST atomically:

1. lock/re-read the variant and its sellability (price, active, stock_policy, resale evidence) **inside the same transaction**,
2. claim exactly one `AVAILABLE` asset with deterministic order (`created_at, id`) via
   `UPDATE … WHERE status = 'AVAILABLE' … FOR UPDATE SKIP LOCKED` (or equivalent),
3. set `status = RESERVED`, `reserved_order_id = <new Order id>`, `reserved_until = Order.expires_at`,
4. insert the Order in `PENDING_PAYMENT`,
5. only then allow Payment Intent / VietQR creation.

Rules:

- Winner of a concurrent contest is the first transaction that commits the reservation.
- Reservation failures return `NO_STOCK`, `CONTENTION_TIMEOUT`, or `RESERVATION_LOST` with no Order,
  no Payment Intent, and no QR. `OUT_OF_STOCK` is only an internal/deprecated compatibility alias
  while a proven legacy caller remains; it is not part of the new BuyNow output contract.
- One active reservation per asset; one active reserved asset per unpaid Order (enforced by a unique
  partial index on `reserved_order_id` over `RESERVED|READY`; `DELIVERED` is historical and excluded
  so a recorded replacement may become the new active hold).
- Cancel/expiry voids the Payment Intent and returns the asset `RESERVED -> AVAILABLE` in the same
  state protocol; a bounded reservation-expiry job recovers stranded holds after crash
  (job implementation is T167/T168; direct cancel/expiry release is T155).
- Post-payment fulfillment upgrades the reserved asset for the paid Order rather than claiming a
  second unit. If the reserved asset is gone (manual revoke/expiry race), fulfillment enters
  review/supplier path rather than silently claiming another customer's reservation.
- Unique active reservation/delivery per asset fingerprint; one active asset per Order unless a
  recorded replacement supersedes the previous asset.
- Claim order is deterministic (`created_at, id`). Each transaction performs one bounded
  `SKIP LOCKED` probe; when available rows are contended, the whole transaction rolls back and is
  retried with a bounded budget. Application sleeps MUST occur only between transactions so catalog
  row locks and database connections are not held during backoff.
- Checkout revalidation locks variant/product/category rows with mutually compatible shared row
  locks. Concurrent buyers can progress; admin UPDATE/deactivate still waits for those readers. Lock
  order is always variant -> product -> category through the same joined query.
- Payment Intent presentation requires a VALID reservation: same `orderId` + same `variantId` +
  status `RESERVED` + `reserved_until > now` + order still `PENDING_PAYMENT` with
  `expires_at > now`. `READY`/`DELIVERED` do NOT authorize a new QR.

### Active fulfillment versus delivered history

- `findActiveAssetHoldByOrder` returns only `RESERVED`/`READY`, ordered deterministically by
  `created_at, id`, and is the only asset lookup allowed for claim/fulfillment re-entry.
- `findDeliveredAssetHistoryForOrder` returns only `DELIVERED` history bound by
  `delivered_order_id`, ordered deterministically by delivery/update time and id.
- Replacement cases link the original delivered-history row. A newer replacement hold never
  becomes `original_asset_id`, and fulfillment re-entry never selects an old delivered credential.

### Supplier

`id`, `name`, `adapter_type`, `credential_vault_ref`, `status`, `timeout_policy`, `created_at`, `version`.

### SupplierSku

`id`, `supplier_id`, `variant_id`, `external_sku`, `cost_vnd`, `region`, `delivery_type`,
`is_active`, `last_verified_at`, `version`.

### SupplierOrder

`id`, `supplier_id`, `supplier_sku_id`, `order_id`, `idempotency_key`, `request_fingerprint`,
`external_order_id?`, `status`, `cost_vnd_snapshot`, `sale_price_vnd_snapshot`,
`margin_vnd_snapshot`, `submitted_at?`, `last_queried_at?`, `next_reconcile_at?`, `version`.

Unique: `(supplier_id, idempotency_key)` and, when present, `(supplier_id, external_order_id)`.

State: `CREATED -> SUBMITTED -> PENDING -> FULFILLED | REJECTED`;
`SUBMITTED/PENDING -> UNKNOWN -> RECONCILED -> FULFILLED | REJECTED`;
eligible states -> `CANCEL_PENDING -> CANCELLED` or `REFUND_PENDING -> REFUNDED`.

### DeliveryBundle

`id`, `order_id`, `customer_id`, `asset_id`, `token_hash`, `status`, `expires_at`, `viewed_at?`,
`consumed_at?`, `revoked_at?`, `reissue_of_id?`, `version`, `created_at`.

Unique active bundle per Order. Token plaintext is never stored.

State: `CREATED -> AVAILABLE -> VIEWED -> CONSUMED`; `AVAILABLE -> EXPIRED | REVOKED`.
The first reveal uses a two-phase protocol: mark `VIEWED`, reveal vault material, then consume and
mark the asset delivered under owner/status guards. A vault failure leaves the bundle re-revealable;
a failed `markAssetDelivered` MUST prevent consume/completion. Access is authorized by a signed
Telegram-bound session, never by a client-supplied customer identity header.

### DeliverySession

`id`, `bundle_id`, `customer_id`, `telegram_user_id`, `audience`, `nonce_hash`, `key_version`,
`expires_at`, `activated_at?`, `used_at?`, `revoked_at?`, `created_at`.

The signed bearer is never stored; only its hash and bounded provenance are durable. Verification
requires signature, expiry, audience, bundle, Telegram numeric identity, customer ownership, key
version, and one-time nonce/replay state. Delivery signing has a dedicated current key and one
previous version accepted only before an explicit configuration grace-until timestamp independent
of token expiry. PREPARED notification sessions have `activated_at = NULL` and cannot redeem;
handoff adoption sets it atomically with the authoritative capability ref. The pending key version
is durable so retry through rotation recreates exact material. Expired-session refresh atomically revokes/replaces the old session and preserves
at most one usable capability per live Bundle. Production notification processing cannot omit the
session codec or TTL.

### DeliveryNotificationHandoff

`id`, `bundle_id`, `customer_id`, `telegram_chat_id`, `capability_key`, `capability_ref?`,
`payload_redacted`, `status`, `attempt_count`, `next_attempt_at`, `claimed_by?`,
`claim_generation`, `claim_expires_at?`, `session_id?`, `session_key_version?`,
`session_generation`, `stored_at?`, `ready_at?`, `capability_expires_at?`, `sent_at?`,
`last_error_code?`.

`capability_key` is deterministic per Bundle/customer/chat; `capability_ref` points to the stored
signed-session capability, never raw credential material. State is
`PREPARED -> STORED -> READY -> PROCESSING -> SENT | DEAD`. `CLEANED` is not a handoff state; orphan
cleanup belongs to `DeliveryCapabilityCompensation`. Bundle issue/outbox commit must durably create or reconstruct the
PREPARED intent before the source event can be acknowledged. Vault network I/O occurs outside long
PostgreSQL transactions. Unique Bundle/chat and capability-key constraints plus fenced retry make
send failure, ambiguous send, session expiry, and crash recovery replayable without a second usable
reveal or order-id recipient. SENT/DEAD/expired refs have bounded cleanup deadlines.

`claim_generation` fences notification lease ownership only. Independent
`payload_redacted.refreshGeneration`, `refreshExpiresAt`, and `refreshKeyVersion` freeze refresh
identity, expiry, and signing key. `payload_redacted.orphanCapabilityRefs` is a bounded compatibility
projection, not the authoritative recovery pointer.

### DeliveryCapabilityCompensation

`id`, `handoff_id`, `capability_ref` (unique), `session_id?`, `reason`, `status`, `cleanup_after`,
`claimed_by?`, `claim_generation`, `claim_expires_at?`, `attempt_count`, `last_error_code?`,
`created_at`, `cleaned_at?`.

State is `PENDING -> DELETING -> CLEANED`. Due or expired-lease rows are claimed with
`FOR UPDATE SKIP LOCKED`, owner, generation, and a bounded lease. Adoption locks the same unique
`capability_ref`; it rejects `DELETING` and may cancel `PENDING` only inside the adoption transaction.
The cleaner rechecks that the ref is not current before network delete. Failure returns the fenced
row to delayed `PENDING`; success deletes/revokes only the orphan and then records `CLEANED`.

### ReplacementCase

`id`, `order_id`, `original_asset_id`, `replacement_asset_id?`, `reason_code`, `status`,
`warranty_deadline`, `opened_at`, `resolved_at?`, `audit_event_id?`.

## Support, reliability, and audit

### SupportTicket

`id`, `customer_id`, `order_id?`, `reason_code`, `status`, `safe_summary`, `due_at`, `created_at`,
`updated_at`, `version`.

State: `OPEN -> WAITING_SHOP | WAITING_CUSTOMER -> RESOLVED -> CLOSED`;
payment/delivery exceptions may enter `MANUAL_REVIEW` but never mutate those domains directly.

### WebhookInbox

`id`, `source`, `source_event_id`, `raw_hash`, `signature_status`, `received_at`, `processing_status`,
`envelope`, `attempt_count`, `next_attempt_at`, `processed_at?`, `last_error_code?`, `claimed_by?`,
`claim_generation`, `claim_expires_at?`, `dead_lettered_at?`, `mutation_count`, `last_mutation_at?`.

Unique: `(source, source_event_id)` with documented hash fallback only when source lacks an ID.

Canonical processing states are `RETRY -> PROCESSING -> PROCESSED | RETRY | DEAD`. A committed
`RETRY` row is the durable-received state and is immediately due when `next_attempt_at <= now()`;
the already-deployed `PENDING` and `FAILED` values are migrated forward to `RETRY` by
`004_telegram_inbox.sql`. `PROCESSING` is always leased. Ack/fail predicates include row id,
`claimed_by`, and `claim_generation`, so a stale owner affects zero rows after lease expiry.

For Telegram, `envelope` is a bounded allowlisted command projection, never the entire raw update:
numeric actor/chat/message references, private-chat type, allowlisted action, and an opaque signed
callback token when present. Callback data is capped at Telegram's 64-byte bound. Free-form message
text, username, credentials, and the raw payload are not persisted. Search/support text requires a
separate approved bounded redaction/encryption/retention contract; until then only an allowlisted
command token is durable. `raw_hash` preserves mutation detection without retaining raw content.

Workers claim due rows in deterministic `(next_attempt_at, received_at, id)` order using bounded
`FOR UPDATE SKIP LOCKED` batches. Retry uses bounded exponential backoff with jitter and a finite
attempt budget; terminal failure records only an allowlisted error code. Processed rows are retained
for 7 days for dedupe/audit and dead rows for 30 days for review, then deleted by a bounded retention
job. Hash mutation for an existing `(source, source_event_id)` is a security discrepancy and never a
duplicate success path. For `source='sepay'`, the envelope is a strict allowlisted payload/auth
projection and the claim carries `raw_hash`; before rebranding it MUST prove source event ID,
provider ID, payload ID/account/amount, structured code/content/reference consistency, and timestamp
validity. A mutation alert is unique by `(source, source_event_id, incoming_raw_hash)` and is written
atomically with mutation accounting. The original evidence fields are immutable at the database
boundary; only lease/retry/status columns may change.

Authoritative inbox is PostgreSQL; in-memory `Set`/`Map` MUST NOT be the sole dedupe store.
Handler failure or HTTP 429 MUST leave the update retryable rather than permanently dropped.

### OutboxEvent

`id`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `event_type`, `payload_redacted`,
`occurred_at`, `published_at?`, `attempt_count`, `next_attempt_at?`, `claimed_by?`, `claimed_at?`,
`claim_expires_at?`, `claim_generation`.

Unique: `(aggregate_type, aggregate_id, aggregate_version, event_type)`.

Claim rules:

- Claim is atomic (`UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`) and stamps
  `claimed_by`, `claimed_at`, `claim_expires_at`, and increments `claim_generation`.
- Ack/fail predicates MUST include `id + claimed_by + claim_generation` (or equivalent fencing token)
  so a stale owner after lease expiry affects zero rows.
- Long handlers renew the lease or claims are bounded to one event per drain.
- Unknown event types fail visibly (never silent ack).

### AuditEvent

`id`, `actor_type`, `actor_id?`, `action`, `target_type`, `target_id`, `reason`, `before_hash?`,
`after_hash?`, `correlation_id`, `occurred_at`, `metadata_redacted`.

Append-only; no raw credential or provider secret.
