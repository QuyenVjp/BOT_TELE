# Contract: Supplier Port

All supplier responses are untrusted and schema-validated. Credentials are referenced from a vault.
The adapter maps supplier-specific values into canonical results; domain modules never import an SDK.
The supplier provider resolver MUST return providers whose `providerKey` equals the validated persisted supplier ID (`supplier.id`), never the adapter type (`adapter_type`). Catalog products returned by a resolved provider's `listProducts()` or `getProduct()` MUST set `providerKey` to that same persisted supplier ID, never the adapter type.

Before any purchase preflight or recovery performs provider health, availability, create, or query I/O, the runtime provider MUST expose a non-empty `providerKey` equal to the persisted supplier ID. Missing or mismatched identity MUST fail closed without consuming a supplier attempt or calling the provider; this check is runtime-enforced even when a caller supplies a bare `SupplierPort`.
A `PENDING` create or recovery result MUST persist its provider `externalOrderId` and retain the durable `queryKey`; when the provider has not returned a distinct query key, use the original idempotency key. These identifiers MUST NOT be substituted. `UNKNOWN`, `PENDING`, and previously submitted attempts are query-only; `createOrder` MUST occur only after a fresh durable attempt claim.

## Catalog product normalization

Catalog adapters MUST parse provider payloads into the normalized product schema before curation or persistence. `providerKey`, `externalProductId`, and non-null `externalVariantId` MUST be non-empty, trimmed, bounded identifiers without control characters; provider-specific adapters MAY trim raw identifiers before constructing them.

Normalized products MUST carry integer VND prices (`currency: "VND"`). Non-VND catalog records are rejected at the adapter boundary and MUST NOT be persisted as supplier costs.

Quantity bounds are fail-closed: a `SUPPORTED` product with `maxQuantity < minQuantity` is invalid. An explicitly `UNSUPPORTED` product with `unsupportedReason: "QUANTITY_BOUNDS_INCONSISTENT"` MAY preserve those bounds, remains unbuyable, and is stored only as unsupported catalog data.
Explicit provider `max_quantity: 0` and `fixed_quantity: 0` values are invalid and MUST be rejected; adapters MUST NOT normalize them to null. `stock_quantity: 0` remains a valid supplier fact and is preserved for `OUT` availability.

Catalog synchronization validates every product and preflights duplicate `(externalProductId, externalVariantId)` identities before opening its database transaction; duplicate identities are rejected rather than silently overwritten.

Availability results MUST NOT report `quantity: 0` with `AVAILABLE` or `LOW`; such a result is schema-invalid at the port boundary.

## SUPPLIER_API payment preflight

Before creating a new PaymentIntent or debiting the wallet for a `SUPPLIER_API` order, the
application MUST resolve the variant's selected supplier/SKU from PostgreSQL, validate the
persisted mapping and provider capabilities, and check provider health when supported plus the
selected SKU's current availability. Missing or unhealthy providers, invalid mappings, and
`OUT`/`UNKNOWN` availability MUST fail closed before payment initiation or wallet debit.
Local-stock orders MUST remain independent of supplier readiness. This check is advisory, not a
fulfillment guarantee or payment evidence; it MUST NOT mark an order paid.

## Operations

### `getAvailability`

Input: supplier SKU and optional region. Output: `AVAILABLE | LOW | OUT | UNKNOWN`, observed time,
optional bounded quantity, and supplier reference. This result is advisory until create/claim.

### `createOrder`

Input: stable idempotency key, supplier SKU, expected cost ceiling, internal Order reference, and
minimal provisioning attributes. Output is one of:

- `ACCEPTED { externalOrderId, status }`
- `FULFILLED { externalOrderId, assetEnvelope }`
- `REJECTED { code, retryable }`
- `UNKNOWN { queryKey, reason }`

Transport timeout after request submission maps to `UNKNOWN`, not `REJECTED` and not automatic retry.
During create, a provider identity mismatch or malformed successful response (`SCHEMA_INVALID`) MUST route to durable supplier review/quarantine rather than `UNKNOWN`. Transport errors remain `UNKNOWN`, and recovery is query-only.

### `queryOrder`

Input: optional `externalOrderId` and/or `queryKey`. `externalOrderId` identifies the provider resource; `queryKey` identifies the stable client/idempotency identity. Adapters MUST NOT substitute one for the other. When both are supplied, responses MUST be checked against each corresponding identity field.
Output: canonical pending/fulfilled/rejected/cancelled/refunded state and validated asset envelope when fulfilled.

### `cancelOrder` / `requestRefund`

Input: stable idempotency key, external order ID, reason. Output: accepted/pending/final/unsupported.
Internal refund completion requires separate financial reconciliation.

### `reconcile`

Input: bounded time/reference cursor. Output: paginated canonical supplier order observations with a
stable next cursor.

## Asset validation

An `assetEnvelope` includes delivery type, expected SKU, region, duration/expiry, supplier asset
identifier/fingerprint, and secret material delivered directly into the vault boundary. HTTP success
without a complete valid envelope is `SUPPLIER_NEEDS_REVIEW`.

## Reliability and security

- Timeouts, retry budgets, circuit-breaker thresholds, rate limits, and maximum payload sizes are configured per supplier.
- Create retries reuse the original idempotency key and occur only after query/reconciliation permits them.
- No silent supplier/SKU substitution is allowed without a product policy and customer-visible decision.
- Raw secrets, API keys, and full supplier responses never enter logs, events, support, or reseller webhooks.
