# Reseller API v1

## Contract principles

- REST/JSON under `/v1`; OpenAPI is the executable contract.
- Prepaid credit only in V1.
- Every mutation accepts `Idempotency-Key` and binds it to a request fingerprint.
- Every response includes `request_id`; resources use opaque IDs.
- Tenant is derived from credential, never trusted from request body.
- Cursor pagination and hard caps on every list endpoint.
- Stable machine error codes and documented retryability.

## Authentication and authorization

- Credential secret is shown once; only prefix + hash are stored.
- Scopes: `catalog:read`, `balance:read`, `ledger:read`, `orders:create`, `orders:read`, `orders:cancel`, `webhooks:manage`, `usage:read`.
- Credential rotation supports overlap; revocation is immediate.
- High-risk tenants may require HMAC request signing, IP allowlist or mTLS.
- Every resource read/write applies tenant object authorization.

## Endpoints

```text
GET    /v1/catalog
GET    /v1/catalog/{product_id}
GET    /v1/balance
GET    /v1/ledger?cursor=...
POST   /v1/orders
GET    /v1/orders/{order_id}
GET    /v1/orders?external_order_id=...&cursor=...
POST   /v1/orders/{order_id}/cancel
POST   /v1/topups
GET    /v1/topups/{topup_id}
POST   /v1/webhook-endpoints
POST   /v1/webhook-endpoints/{id}/test
GET    /v1/usage
```

## Create order contract

Required concepts: `external_order_id`, line items/options, fulfillment destination/reference, metadata allowlist and idempotency key. Price, tenant, permission, available credit and inventory are server-authoritative.

Atomic flow:

1. Authenticate credential and scope.
2. Resolve tenant/price plan/quota.
3. Check idempotency fingerprint.
4. Validate catalog/options and calculate quote.
5. Reserve inventory and prepaid credit.
6. Create canonical Order and reseller mapping.
7. Return `201`; retries return the original result.

## Error envelope

```json
{
  "error": {
    "code": "insufficient_credit",
    "message": "Insufficient prepaid credit",
    "retryable": false,
    "request_id": "req_opaque"
  }
}
```

Supported codes include `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `insufficient_credit`, `payment_pending`, `manual_review`, and `provider_unavailable`.

## Outbound webhooks

- At-least-once delivery.
- Headers carry event ID, timestamp, signature version and HMAC signature over `timestamp.raw_body`.
- Payload carries event type, occurred time, resource ID/version and tenant-safe data.
- Retry with bounded backoff; endpoint health, DLQ and manual replay are visible.
- Endpoint registration uses HTTPS challenge and SSRF/egress protection.
- Consumer must dedupe by event ID; replay never changes event identity.

## Compatibility

- Backward-compatible additive changes stay in `/v1`.
- Breaking semantic/schema/auth changes require `/v2` and migration window.
- Unknown response fields must be ignored; unknown request fields are rejected or explicitly versioned.
- Deprecation includes announcement, sunset date, metrics and migration guide.

