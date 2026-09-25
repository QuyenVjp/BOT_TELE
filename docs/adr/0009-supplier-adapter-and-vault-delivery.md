---
status: proposed
---

# Upstream shop APIs are adapters; digital credentials stay in a vault

Calls to other shops are modeled as Supplier Adapters with catalog/availability/order/refund/reconciliation contracts, idempotency and circuit breakers. Supplier credentials and account secrets never live as plaintext in the domain database or chat logs; prefer provider-authorized invite/license entitlements, otherwise deliver through a short-lived one-time vault-backed bundle only when resale is authorized.


## PR #24 catalog normalization contract

- Supplier adapters validate bounded raw transport data before normalization.
- Normalized products preserve provider facts needed for safe curation; a
  `SUPPORTED` / `UNSUPPORTED` status prevents ambiguous upstream quantities from
  authorizing sale.
- `customer_inputs_per_item = 0` is supported only when customer input is not
  required. A required-input product with zero inputs is retained as unsupported.
- `max_quantity = 0` remains zero and is unsupported because QCST documents no
  zero-value semantics; it is never treated as unlimited.
- Unparseable upstream timestamps normalize to null. `last_synced_at` is the
  authoritative observation timestamp.
- Authoritative sync includes unsupported rows, aborts on invalid normalized
  input, and never marks existing mappings missing after a skipped row.
- Supplier catalog rows are discovered disabled by default; unsupported rows
  cannot be selected, enabled, made primary, or published.

## PR #24 supplier purchase readiness boundary

Before a new upstream purchase, the current mapping must be the explicit
`product_variant.supplier_sku_id`, with an active supplier and SKU, a provider
that supports `ORDER_CREATE`, and the effective purchase gate enabled. A
provider that declares `CATALOG_LIST` is catalog-managed: its matching
`supplier_catalog_product` row is mandatory and must be `SELECTED`, enabled,
`SUPPORTED`, not missing, and `AVAILABLE` or `LOW`. The check runs before the
durable `supplier_order` insert and is repeated after winning idempotency, immediately
before `createOrder`; the second check refreshes the canonical upstream SKU/cost
snapshot. Unsafe mappings do not fail over or perform upstream I/O; a race after
the durable insert is recorded as a rejected local supplier order.

The compatibility rule is capability-based, not provider-name-based. A
capability-aware provider with `CATALOG_LIST` requires the catalog row; a
legacy injected `SupplierPort` without capability metadata keeps the existing
non-catalog behavior, while still requiring the explicit primary mapping and
active supplier/SKU.
