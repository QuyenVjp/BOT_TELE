# Supplier Outage / Unknown / Invalid-Asset Runbook

## Trigger

- Supplier health alert (`supplierFailures` threshold).
- Supplier order stuck in `UNKNOWN` beyond SLA (`SUPPLIER_UNKNOWN_AGE`).
- Invalid-asset quarantine threshold (`INVALID_ASSET_THRESHOLD`).
- Fulfillment lag alert after payment settled (`FULFILLMENT_LAG`).

## Procedure

### Outage / timeout

1. Confirm the supplier adapter is failing (circuit, timeout, or 5xx). Do not re-create an upstream
   order while the status is `UNKNOWN` — always **query-before-retry** (`recoverUnknownSupplierOrder`).
2. Keep accepting payments; Orders that reach `PAID` stay in the fulfillment queue. Local stock
   continues to fulfill via the local-first path.
3. Surface customer-safe copy (`Đang xử lý`, `Đang kiểm tra với nhà cung cấp`) — never a raw
   supplier payload, never a vault ref.
4. After the supplier recovers: drain the unknown-order queue with query-before-retry, then resume
   create-order traffic at a reduced rate before full throughput.

### Unknown recovery

1. For each `UNKNOWN` supplier order, query by `query_key`; on an unmigrated legacy
   row where it is `NULL`, treat `external_order_id` as `queryKey`, never
   `externalOrderId`. Migration `095` backfills `query_key` without clearing the
   legacy field for rollback; while status is `UNKNOWN`, it remains a lookup key,
   not a provider order ID.
2. For a `PENDING` supplier order: query by its persisted provider external order ID; a `PENDING` observation stays query-only and must never trigger another create.
3. On `FULFILLED`: validate the asset envelope (SKU / delivery type / duration / region / expiry),
   ingest as a vault-backed asset, mark ready, continue fulfillment.
4. On `REJECTED` / terminal failure: transition the supplier order and open a replacement or
   refund-request case; never invent a secret.
5. On still-unknown: leave in `UNKNOWN` and re-schedule; do not re-create.

### Dead-lettered `OrderPaid`

- Ambiguous `UNKNOWN`, `PENDING`, or attempted `SUBMITTED` orders stay out of create/re-arm and are routed to query-only reconciliation; never re-POST them.
- Without an ambiguous row, re-arm a dead `OrderPaid` only when no supplier-order row exists or
  exactly one `SUBMITTED` row remains unattempted (`attempt_count=0`, no `needs_review_at`);
  other terminal, quarantined, or multiple supplier-order histories require manual review.

### Invalid asset

1. An envelope that fails validation is quarantined (`SUPPLIER_NEEDS_REVIEW`). The vault ref is never
   echoed in logs, telemetry, or tickets.
2. Owner reviews the quarantine (private context, audited). Resolution is either re-provision from
   a corrected supplier response or open a replacement/refund case.
3. The original Order history is preserved; no silent re-issue without audit.

## Safety rules

- Never re-create a supplier order whose status is `UNKNOWN`.
- Never store or log a raw credential — only vault refs.
- Asset validation is fail-closed; a malformed envelope never reaches a customer.
- Replacement preserves the original asset and Order history (FR-020).
