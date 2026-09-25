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

The repository does not claim a Vô Không catalog, balance, order, cancellation, refund, delivery, authentication, or idempotency contract from these observations. The adapter exposes only `HEALTH_READ`; all purchase and unsupported operations fail closed with `UNSUPPORTED`.

Required before enabling Vô Không catalog or purchase:

1. owner-supplied documented authenticated endpoint contract;
2. fresh API key stored only as a Vault reference;
3. bounded adapter schemas and capability contract tests;
4. sandbox/production read and purchase evidence, including idempotency and timeout recovery;
5. owner curation and explicit-primary readiness evidence.
