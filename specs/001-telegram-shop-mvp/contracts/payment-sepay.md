# Contract: VietQR Presentation and SePay Evidence

## VietQR presentation

Input: merchant bank identifier/account, exact positive integer VND amount, unique transfer content,
and approved template. Output: QR representation plus copyable account/amount/content and expiry.

`SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` are independent configuration keys and
responsibilities; equality is valid for a single-account pilot, while distinct values support a
VA/sub-account deployment. Configuration validation MUST NOT require inequality.

VietQR output never indicates settlement. The account name or rendered image text is display data,
not payment evidence.

## SePay webhook ingress

Processing order is mandatory:

1. Enforce TLS/edge policy and body-size limit before parse.
2. Preserve exact raw bytes.
3. Read required timestamp/signature headers.
4. Reject timestamps outside the configured replay window.
5. Compute documented HMAC over `{timestamp}.{raw_body}` and compare in constant time.
6. Apply the current official IP allowlist policy as defense in depth where supported.
7. Parse and validate the allowlisted schema only after integrity succeeds.
8. Insert/dedupe `WebhookInbox` and `BankTransaction` by SePay transaction ID/raw hash.
9. Acknowledge with the exact documented success response after durable acceptance.
10. Process match/allocation asynchronously and idempotently.

The primary acceptance seam is end to end and uses real PostgreSQL: signed official-shaped request
through Fastify, committed inbox row, exact HTTP `200 {"success":true}`, fenced worker claim,
strict envelope validation, matcher, and settlement. A fake inbox is insufficient for this gate.

Every SePay claim carries the persisted `raw_hash`. Before the runtime trust brand is restored, a
strict schema must validate the entire envelope and require all of the following:

- claim `source_event_id` equals evidence `providerTransactionId`;
- claim `raw_hash` equals evidence `rawHash`;
- payload `id` equals the source/provider transaction ID;
- payload account and amount equal evidence merchant account and amount;
- payload `code`, `content`, and `referenceCode` agree with structured code/content/reference;
- payload direction and timestamp are valid and agree with evidence.

Failure is retryable/dead-lettered and MUST NOT reach settlement. Mutation accounting plus its
security discrepancy is one transaction and idempotent by `(source, source_event_id,
incoming_raw_hash)`, so replay floods create one alert per distinct mutated payload.

## Official SePay provider contract (2026-07-17)

The webhook payload is JSON with `id`, `gateway`, `transactionDate`, `accountNumber`, `subAccount`,
`code`, `content`, `transferType`, `description`, `transferAmount`, `accumulated`, and
`referenceCode`. `id` is stable across retries/replays and is the webhook dedupe key. The shop only
settles `transferType=in`; `transferAmount` is integer VND and `content` is preserved verbatim.

SePay accepts a delivery only when the endpoint returns HTTP `200` or `201`, exact JSON
`{"success": true}`, within 30 seconds. The handler must durably insert the provider inbox/event
before acknowledging, then apply evidence asynchronously. A duplicate event must return the same
success response without repeating business effects.

The production authentication contract is HMAC-SHA256 with `X-SePay-Timestamp` and
`X-SePay-Signature: sha256=...`, signing the exact raw string `{timestamp}.{raw_body}`. API Key
(`Authorization: Apikey ...`) is a weaker alternative; no-auth is test-only. OAuth2 is supported
when the deployment explicitly chooses it. HTTPS, current IP allowlist, NTP/replay protection,
schema validation, and redaction remain mandatory.

SePay retry/replay and reconciliation can deliver the same transaction more than once. The
provider webhook ID and provider API transaction ID therefore need source-qualified text keys; do
not assume the webhook integer ID and API v2 UUID share one namespace.

## Business match

Automatic settlement requires all of:

- unique provider transaction ID;
- inbound direction;
- expected merchant account;
- exact integer VND amount;
- content/reference resolving to exactly one active or recoverable Payment Intent;
- transaction time satisfying normal or explicitly supported late-payment policy;
- no previous allocation to another Payment Intent.

Any missing or conflicting fact returns `NEEDS_REVIEW`; it never falls back to screenshot/manual
mark-paid. Duplicate valid delivery returns success without repeating effects.

## Reconciliation

Scheduled and on-demand reconciliation queries bounded provider time/reference windows, respects
published rate limits/backoff, and compares provider transactions with internal Bank Transactions,
Payment Intents, allocations, refunds, and discrepancies. Missing webhook data may create evidence
through the same verification/match rules; reconciliation cannot bypass them.

The Google Sheet projection is optional operational visibility only. It is never payment truth and
must never by itself mark an Order paid or trigger credential delivery. A Sheet row is accepted only
after the corresponding SePay webhook/API evidence has passed the same verifier and matcher.

## QR image and Telegram media

The QR image path must use a fixed independent official-shaped vector and prove decodability of the
exact account, integer amount, and payment code. Fetch/render is bounded by HTTPS origin,
content-type, byte size, dimensions, timeout, and template allowlist. Telegram `sendPhoto`,
`editMessageText`, and `editMessageMedia` operations preserve a stable delivery idempotency key,
honor `retry_after`, and reconcile ambiguous sends before retrying.

## Security/redaction

Persist raw body only if encrypted retention is explicitly approved; otherwise store raw hash and
redacted allowlisted fields. Never log webhook auth headers, HMAC secret, full raw payload, QR secret
configuration, or bank credentials.
