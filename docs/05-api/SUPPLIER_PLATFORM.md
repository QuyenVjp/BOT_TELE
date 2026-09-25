# Supplier platform contract

Status: provider-neutral owner curation and read-only sync are implemented. External purchase remains disabled until provider-specific acceptance.

## Boundary

`SupplierProvider` is the only adapter contract used by fulfillment, catalog sync, recovery, and admin curation. Adapters validate untrusted upstream responses and return normalized products, balance, health, order, and availability results. Provider payloads never enter PostgreSQL, Telegram, Sheets, logs, or delivery assets.

Provider capabilities are explicit: `HEALTH_READ`, `CATALOG_LIST`, `CATALOG_DETAIL`, `BALANCE_READ`, `ORDER_CREATE`, `ORDER_READ`, `ORDER_LIST`, `NATIVE_IDEMPOTENCY`, `CANCEL`, `REFUND`, `STOCK_QUANTITY`, `DELIVERY_PAYLOAD`, and `RATE_LIMIT_RETRY_AFTER`. Missing capabilities are `UNSUPPORTED`; the application never emulates them.

The registry resolves providers by a namespaced `providerKey`. Customer routes never contain provider IDs and never choose a supplier.

## Catalog and mappings

Migration `093_supplier_catalog_platform.sql` stores provider-namespaced `(supplier_id, external_product_id, external_variant_id)` snapshots and only normalized safe fields. Sync is read-only: new rows are `DISCOVERED`, disabled, and absent from customer routing. Missing upstream rows preserve mapping history and become `MISSING`/disabled.

Owner curation is private Telegram-only. The owner sets local Vietnamese presentation, local selling price, enabled state, and mapping. Supplier cost is reference data and never changes local price. One local variant may have multiple `supplier_sku` mappings; `product_variant.supplier_sku_id` is the explicit primary mapping. Non-primary mappings are not automatic fallback candidates. Changing primary is an explicit owner action with authorization, optimistic version binding, and audit evidence.

Customer publication and routing require the existing product/evidence gates plus the explicit primary mapping. `AVAILABLE`/`LOW` is required for supplier readiness. Automatic cross-provider failover is permanently off for this rollout.

## Provider status

- **QCST:** documented `X-API-Key` access is revealed from Vault at request time; catalog, balance, order, query, list, native idempotency, cancel, stock, and bounded retry metadata are declared only where the current OpenAPI contract supports them. Delivery remains review-only until a real reversible purchase acceptance.
- **Vô Không:** safe discovery observed only `GET https://vokhong.xyz/` returning the service marker. `/api`, common docs, and OpenAPI routes returned 404. The adapter exposes only `HEALTH_READ`; catalog, balance, order, delivery, cancel, refund, and reconciliation remain unsupported.

## Security and rollout

Provider base URLs are HTTPS and host/port pinned in production. Credentials are Vault references only; raw provider keys are rejected from production configuration. Health reads are bounded and fail closed. A timeout after order submission is `UNKNOWN` and enters durable reconciliation; it is never blindly retried.

Required checkpoints before enabling real purchase:

1. fresh sanitized QCST read-only evidence and owner Telegram curation evidence;
2. a reversible QCST purchase with durable exactly-once/reconciliation proof;
3. a documented Vô Không authenticated catalog/order contract and fresh Vault key;
4. a reversible Vô Không purchase acceptance.

No Mini App or public supplier HTTP/admin surface is part of this contract.
