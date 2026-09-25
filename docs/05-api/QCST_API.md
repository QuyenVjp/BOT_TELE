# QCST Partner API contract

Status: provider and catalog integration contract; live purchase remains disabled until an owner-controlled acceptance checkpoint enables it.

## Upstream boundary

- Base URL is `https://api.qcst.tech` in production. The adapter must pin egress to the official host and HTTPS port.
- Authentication is the raw API key in the `X-API-Key` header. The application never accepts `Bearer`, a Telegram label, a quoted value, or a key in normal environment configuration.
- The raw key is revealed from Vault only at request time. PostgreSQL, Telegram, audit metadata, logs, Sheets, fixtures, screenshots, and error messages store only the opaque Vault reference and safe operational metadata.
- `GET /v1/products` and `GET /v1/balance` are read-only catalog/credit probes. The provider also documents versioned `GET /v1/catalog?since_version=...` for complete snapshots. `POST /v1/orders` is the only purchase operation and is unreachable unless `QCST_PURCHASE_ENABLED=true` and the provider hardening checks pass. `POST /v1/orders/{order_id}/cancel` is a separate documented cancellation endpoint.
- Every order create sends a stable `Idempotency-Key` and a stable `client_order_id`. A transport timeout after submission is `UNKNOWN`; it is reconciled by the existing durable supplier-order workflow before any retry. Cancellation is idempotent at the supplier endpoint; no separate refund endpoint is assumed.

## Validated response surface

The adapter accepts only the documented fields needed by the domain and rejects malformed required fields:

- Product: `id`, Vietnamese/English names and descriptions, warranty text, customer-input contract, fulfillment mode, availability, stock type, integer `price`, `currency`, `updated_at`, and optional bounded quantity fields.
- Balance: integer `available` and `currency`.
- Order: identifiers, product/quantity, integer unit/total amounts, currency, status/payment/cancellation/delivery flags, status URL, polling hint, timestamps, and optional error. Delivery payload shape is not documented; an unknown delivery payload never becomes a delivered asset.
- Attaching a supplier source to an existing local variant is mapping-only. It
  does not rewrite local product/variant names, descriptions, or selling price;
  supplier cost and availability remain upstream observations.

- `401`, `403`, `429`, `5xx`, malformed JSON, unexpected content type, oversized bodies, and unknown delivery semantics fail closed. `Retry-After` is retained as bounded retry metadata only; the adapter does not tight-loop.

The OpenAPI document advertises status as a string without a lifecycle enum and delivery as untyped JSON. The implementation therefore maps known terminal failure strings conservatively, keeps unknown states pending/review, and never guesses a credential field.

## Local curation

QCST is an upstream source, not an authority to publish products. A successful sync upserts safe upstream metadata into a durable catalog table:

- unseen products are `DISCOVERED`, disabled, and absent from the customer catalog;
- selected products retain a local product/variant mapping, local Vietnamese name/description, and local selling price independent of QCST cost;
- only an owner-confirmed `SELECTED + enabled` mapping that is also the explicit
  `product_variant.supplier_sku_id` primary can enter customer routing;
- local price changes never follow QCST price changes automatically;
- a successful sync marks absent upstream products missing/out-of-stock but preserves history and mapping; a failed sync does not mutate availability;
- duplicate provider/external identities and duplicate same-provider/local-variant mappings are rejected; mappings from different providers may share one local variant.

Telegram is the only owner UI. The owner sees paginated safe metadata, submits a bounded configuration line, reviews a redacted preview, and explicitly confirms save/enable or save/disable. No Mini App or public admin HTTP surface is part of this integration.

## Rollout gates

The rollout flags control operational behavior; they do not attest that a
safety invariant or acceptance review has passed:

- `QCST_CATALOG_SYNC`: allow read-only product sync;
- `QCST_ADMIN_PRODUCT_BROWSER`: expose the owner Telegram browser;
- `QCST_OWNER_SELECTION`: allow mapping mutations after owner confirmation;
- `QCST_LOCAL_PRICE_CONTROL`: expose the local catalog curation control;
- `QCST_PURCHASE_ENABLED`: provider-specific purchase rollout gate;
- `SUPPLIER_PURCHASE_ENABLED`: generic purchase rollout gate.
- Release evidence for owner selection and purchase remains external to runtime
  configuration and must cite its sanitized acceptance artifact.
- Duplicate mapping protection, hidden unselected products, local price
  authority, and step-up authorization are code/DB/domain invariants, not
  environment assertions.
- Purchase remains false until the owner provides a fresh Vault key, records
  sanitized catalog/read-only evidence, completes owner Telegram curation, and
  records reversible exactly-once and timeout-reconciliation evidence.

No runtime flag asserts that browser or purchase evidence exists; the release
report must cite the external acceptance artifact before purchase is enabled.

## Invariant ledger

- `invariants_preserved`: Vault-only secrets; Telegram-only UX; durable supplier idempotency; no blind retry after ambiguous create; local price authority; owner/root authorization; existing catalog publication/evidence gates; audit and optimistic versions.
- `intentional_breaks`: QCST catalog data may be stale and selected mappings may be temporarily unavailable; they remain visible to the owner for repair but are not purchasable.
- `risked_invariants`: upstream status/delivery ambiguity, stale catalog pages, owner mispricing, duplicate callbacks, and network/rate-limit failures. Schema validation, unique constraints, step-up confirmation, fail-closed routing, and reconciliation bound these risks.
