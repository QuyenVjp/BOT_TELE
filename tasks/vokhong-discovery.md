# Vô Không discovery evidence

Date: 2026-09-24
Scope: unauthenticated, read-only HTTP discovery only. No API key, purchase, catalog mutation, or order mutation was attempted.

## Observed responses

- `GET https://vokhong.xyz/` → HTTP 200 JSON: `{"success":true,"service":"TelegramShopBot"}`.
- `GET https://vokhong.xyz/api` → HTTP 404.
- `GET https://vokhong.xyz/api/openapi.json` → HTTP 404.
- `GET https://vokhong.xyz/api/docs` → HTTP 404.
- `GET https://vokhong.xyz/api/swagger.json` → HTTP 404.
- `GET https://vokhong.xyz/docs` → HTTP 404.
- `GET https://vokhong.xyz/openapi.json` → HTTP 404.

## Decision

The repository previously observed only an unauthenticated root response and
must not infer provider behavior from QCST. The owner has now supplied a
documented Vô Không API contract covering `/api/health`, `/api/products`,
`/api/balance`, `/api/orders`, API-key authentication, idempotency, and
rate-limit behavior. The supplied credential is not used or stored.

The current adapter adopts only the authenticated `/api/health` read. It keeps
only `HEALTH_READ`; catalog, balance, order, delivery, cancellation, refund,
and reconciliation capabilities remain unsupported until implemented against
fresh read-only evidence. Provider startup requires a fresh Vault reference;
there is no fake credential reference.

Required before enabling additional Vô Không capabilities or purchase:

1. fresh API key stored only as a Vault reference;
2. sanitized `GET /api/products`, `GET /api/balance`, and `GET /api/orders` evidence;
3. bounded adapter schemas and capability contract tests;
4. no `POST /api/orders` until an owner-approved reversible purchase gate;
5. durable idempotency and timeout-recovery evidence;
6. owner curation and explicit-primary readiness evidence.
