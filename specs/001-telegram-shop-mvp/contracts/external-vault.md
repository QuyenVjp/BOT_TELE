# External Vault HTTP Contract

This contract is the Feature 001 staging boundary for raw digital credentials and short-lived
delivery capabilities. It is backend-only. Domain rows, logs, events, Telegram messages, and error
responses store or expose only an opaque `vault:` reference.

## Configuration and readiness

- `VAULT_DRIVER=external` requires a non-empty HTTPS `VAULT_ENDPOINT` and `VAULT_TOKEN`.
  Userinfo, query, and fragment components are forbidden. Plain HTTP is unavailable from production
  environment configuration; a loopback HTTP transport exists only as explicit test injection.
- `VAULT_NAMESPACE` is a bounded deployment namespace. `VAULT_TIMEOUT_MS` is 10-30000 ms and
  `VAULT_MAX_ATTEMPTS` is 1-5.
- Production configuration declares exact `VAULT_EGRESS_HOST_ALLOWLIST`,
  `VAULT_EGRESS_PORT_ALLOWLIST`, and `VAULT_EGRESS_CIDR_ALLOWLIST` values. The endpoint host and every
  resolved address MUST be inside that policy. Empty answers, mixed allowed/disallowed answers,
  metadata/link-local addresses outside the explicit CIDRs, and later DNS re-resolution outside the
  policy fail closed. Private vault addresses are valid only when deliberately listed.
- Main and worker startup MUST complete `GET /healthz` before becoming available. The response is
  strict JSON `{ "status": "ok" }`; timeout, non-JSON, extra fields, or non-2xx status fail closed.
- Every request carries `Authorization: Bearer <VAULT_TOKEN>`. Tokens, endpoint credentials,
  provider response bodies, and stored material MUST NOT appear in errors or telemetry.

## Namespaced secret operations

The client generates a stable, non-secret idempotency key before network retry. Namespace segments
are restricted to `asset|capability`.

| Operation | HTTP contract | Success |
|---|---|---|
| Write | `PUT /v1/secrets/{deployment}/{asset|capability}/{key}` with strict JSON `{ "material": "..." }` | `200|201` and strict `{ "ref": "vault:{deployment}:{kind}:{key}" }` |
| Reveal | `GET /v1/secrets/{deployment}/{asset|capability}/{key}` | `200` and strict `{ "material": "..." }` |
| Delete | `DELETE /v1/secrets/{deployment}/{asset|capability}/{key}` | `204`; `404` is an idempotent no-op |

The adapter rejects a reference from another deployment namespace before network access.
`MAX_MATERIAL_BYTES` is 65536 UTF-8 bytes. `MAX_JSON_ENVELOPE_BYTES` is a distinct bound large enough
for exact-maximum material after worst-case JSON escaping plus fixed schema overhead. Material at the
exact maximum MUST write and reveal successfully; material at maximum plus one byte fails before any
network access. The request body is serialized exactly once, the serialized bytes are measured, and
those same bytes are sent. Response content type must be `application/json` except for a strict empty
`204` DELETE response.

## Retry and failure semantics

- PUT uses the same path/key across attempts, so retry cannot create a second secret.
- GET and DELETE are idempotent. Network errors, timeouts, `408`, `425`, `429`, and selected `5xx`
  statuses retry with bounded backoff up to `VAULT_MAX_ATTEMPTS`.
- One attempt deadline remains active from connection through headers, streamed body size accounting,
  UTF-8 decode, and strict JSON parse. A slow-drip body that exceeds the deadline is aborted. Chunked
  responses without `Content-Length` are counted incrementally and destroyed at the first byte beyond
  `MAX_JSON_ENVELOPE_BYTES`; the implementation does not call an unbounded whole-body helper first.
- Redirect mode is error-only. `301`, `302`, `303`, `307`, and `308` are terminal failures and the
  Authorization header or secret body is never forwarded to a redirect target.
- Health, write, reveal, and delete validate status, content type, size, and an exact allowlisted
  schema. Malformed success, wrong ref, or unexpected fields fail closed. Every accepted and rejected
  response stream is consumed to its bound or explicitly destroyed before retry/return; `204` MUST be
  empty and idempotent `404` DELETE uses the documented strict error envelope.
- Unknown/missing refs return one generic `Secret is not available` error. Other provider failures
  return one generic `External vault request failed` error; neither includes endpoint, token,
  material, provider body, or existence details.
- Delivery handoffs use the `capability` namespace and a deterministic handoff/refresh-generation
  key. Digital assets use the `asset` namespace. Compensation deletes a successful write whose
  database state transition fails; if that delete also fails, the opaque orphan ref enters the
  durable handoff tombstone and bounded cleanup retains it until deletion succeeds.
