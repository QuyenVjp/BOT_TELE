---
status: proposed
---

# Upstream shop APIs are adapters; digital credentials stay in a vault

Calls to other shops are modeled as Supplier Adapters with catalog/availability/order/refund/reconciliation contracts, idempotency and circuit breakers. Supplier credentials and account secrets never live as plaintext in the domain database or chat logs; prefer provider-authorized invite/license entitlements, otherwise deliver through a short-lived one-time vault-backed bundle only when resale is authorized.

