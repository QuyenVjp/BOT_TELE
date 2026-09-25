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
