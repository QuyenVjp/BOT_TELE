# Contract: Supplier Port

All supplier responses are untrusted and schema-validated. Credentials are referenced from a vault.
The adapter maps supplier-specific values into canonical results; domain modules never import an SDK.

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

### `queryOrder`

Input: external order ID or query key. Output: canonical pending/fulfilled/rejected/cancelled/refunded
state and validated asset envelope when fulfilled.

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
