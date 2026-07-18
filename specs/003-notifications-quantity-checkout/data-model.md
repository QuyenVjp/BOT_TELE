# Data Model: Notifications, Quantity Checkout, and Payment UX

## Order/Variant additions

### ProductVariant

Add `max_per_order` and source capability for quantity. `max_per_order` is positive, globally capped,
and may not exceed an operational supplier/local limit.

### Order

Add/snapshot:

- `quantity` integer > 0.
- `unit_price_vnd` integer > 0.
- `total_vnd` checked integer multiplication.
- `reserved_quantity`, `fulfilled_quantity`, `delivered_quantity`.
- `manual_reconciliation_fee_vnd` policy snapshot.

Invariant: `0 <= delivered <= fulfilled <= reserved <= quantity`; Completed requires `delivered = quantity`.

### SupplierUnitAttempt

`id`, `supplier_order_id`, `unit_index`, `idempotency_key`, `external_order_id?`, `status`, `asset_id?`,
`last_queried_at?`, `next_reconcile_at?`, `version`.

Unique `(supplier_order_id, unit_index)` and `(supplier_id, idempotency_key)`.

State: `CREATED -> SUBMITTED -> PENDING -> FULFILLED | REJECTED`; uncertain response -> `UNKNOWN -> RECONCILED`.

## PaymentPresentation

`id`, `payment_intent_id`, `order_id`, `qr_media_ref`, `bank_name`, `account_name`, `account_number_masked`,
`amount_vnd`, `transfer_content`, `expires_at`, `render_version`, `created_at`.

Sensitive merchant configuration is not duplicated beyond approved display snapshot. QR media may be
regenerated idempotently from Payment Intent fields.

## NotificationPreference

`customer_id`, `transactional_enabled=true`, `critical_service_enabled=true`, `shop_update_enabled`,
`purchase_activity_enabled`, `quiet_start_local?`, `quiet_end_local?`, `digest_minutes`, `timezone`,
`version`, `updated_at`.

Transactional/critical flags are policy-locked true; customer-controlled flags are shop/purchase.

## NotificationCampaign

`id`, `created_by_root_id`, `class`, `title`, `safe_body`, `product_id?`, `target_segment`, `status`,
`idempotency_key`, `scheduled_at?`, `confirmed_at?`, `cancelled_at?`, `reason`, `recipient_estimate`,
`created_at`, `updated_at`, `version`.

State: `DRAFT -> PREVIEWED -> CONFIRMED -> SCHEDULED | SENDING -> COMPLETED | PARTIAL_FAILED`;
eligible non-terminal states -> `CANCELLED`.

## NotificationDelivery

`id`, `campaign_id?`, `source_event_id?`, `customer_id`, `chat_id`, `class`, `dedupe_key`, `status`,
`scheduled_at`, `attempt_count`, `next_attempt_at?`, `telegram_message_id?`, `suppression_reason?`,
`last_error_code?`, `sent_at?`, `created_at`.

Unique `dedupe_key` per logical message/customer. State: `PENDING -> SENDING -> SENT | SUPPRESSED |
RETRY_WAIT | DEAD`; retry returns to `PENDING` according to backoff/retry-after.

## NotificationDigest

`id`, `customer_id`, `class`, `window_start`, `window_end`, `event_count`, `product_summaries_redacted`,
`status`, `scheduled_at`, `sent_at?`.

Purchase summaries contain only product/variant ID, safe name, aggregate quantity/count, and public price reference.

## NotificationEventSnapshot

For `PRODUCT_PUBLISHED`, `STOCK_ADDED`, `PURCHASE_COMPLETED`, and transactional states, store only
allowlisted display fields required by the class. Purchase events never contain buyer identity,
Order number, payment reference, bank/account data, credential, or private total.

