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

1. For each `UNKNOWN` supplier order: call `queryOrder` with the stored external id / idempotency key.
2. On `FULFILLED`: validate the asset envelope (SKU / delivery type / duration / region / expiry),
   ingest as a vault-backed asset, mark ready, continue fulfillment.
3. On `REJECTED` / terminal failure: transition the supplier order and open a replacement or
   refund-request case; never invent a secret.
4. On still-unknown: leave in `UNKNOWN` and re-schedule; do not re-create.

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
