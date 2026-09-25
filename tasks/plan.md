# Multi-supplier platform refactor

## Overview
Refactor the existing QCST supplier work into a provider-neutral supplier platform. QCST remains the first real adapter. Vô Không is discovery-first and read-only until its contract and a fresh Vault credential exist. Telegram remains the only owner UI; no Mini App, no real supplier POST, no automatic cross-provider failover.

## Architecture decisions
- `SupplierProvider` is the provider-neutral adapter boundary. It exposes declared capabilities and optional operations; the generic purchase service depends on the boundary, never on QCST or Vô Không names.
- Normalized supplier products/orders cross the adapter boundary. Raw provider payloads remain inside adapters and are schema-validated before normalization.
- Existing `supplier`, `supplier_sku`, and `supplier_order` tables remain the generic durable purchase foundation. Migration `093` is the next unused source ordinal after a complete scan of migrations through `092`; it must contain only forward-compatible generic changes.
- `supplier_catalog_product` is treated as a generic supplier catalog snapshot/mapping table, with provider-namespaced external identity and optional external variant identity. Owner selection, local price, and primary source selection are local state.
- One local variant may have multiple supplier mappings, but `product_variant.supplier_sku_id` remains the explicit primary source. Non-primary mappings may retain local metadata but are not routable fallback candidates; automatic failover is off.
- Provider capabilities are explicit. Missing balance, listing, cancellation, refund, stock, delivery, pagination, webhook, or native-idempotency capabilities are surfaced as unsupported and never emulated.
- QCST uses its documented `X-API-Key`, Vault reference, pinned `https://api.qcst.tech`, and read-only rollout gates. Vô Không currently exposes only an observed unauthenticated root health response; undocumented catalog/order routes are not invented.
- Supplier-specific rollout flags are provider-neutral where possible, with per-provider enable/purchase gates. Runtime flags never assert browser acceptance.

## Dependency graph

```text
migration 093 + provider-neutral contracts
        -> normalized adapters + registry
        -> generic catalog sync/mapping service
        -> generic supplier routing + primary-source selection
        -> Telegram supplier hub and per-provider screens
        -> QCST/Vô Không contract tests and release evidence
```

## Acceptance checkpoints
- Migration ordinal and fresh/upgrade migration checks pass.
- Generic contract tests pass for QCST and capability-limited Vô Không.
- QCST curation invariants remain green: discovered disabled, explicit selection, local-price authority, missing/out-of-stock safety, duplicate protection, stale callback protection.
- Same local variant can hold multiple mappings with one explicit primary; no automatic fallback purchase.
- Supplier hub and per-provider Telegram callbacks never show secrets and never expose customer provider choice.
- QCST purchase and Vô Không purchase remain disabled; no real order POST is performed.

## External blocker
Vô Không has no public API/OpenAPI contract at the observed safe routes (`https://vokhong.xyz/api`, `/api/openapi.json`, `/api/docs`, `/api/swagger.json`, root `/docs`, root `/openapi.json`); only `GET https://vokhong.xyz/` returned `{"success":true,"service":"TelegramShopBot"}`. A read-only catalog/balance/order adapter cannot be truthfully enabled until the owner supplies documented endpoints and a fresh Vault key.
