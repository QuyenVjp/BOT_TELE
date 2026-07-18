# Contract: Secure Delivery Bundle

## Issue

Preconditions: Order is paid, asset is validated and atomically claimed by that Order, no active
Delivery Bundle exists. Output: opaque high-entropy URL token, expiry, safe instructions, and bundle ID.

Only a hash of the token is stored. Issuing the response/outbox twice returns the existing active
bundle, never a second asset or token.

## Reveal

Input: plaintext token plus a short-lived signed Telegram-bound delivery session containing
audience, customer ID, Telegram numeric user ID, bundle ID, nonce, expiry, and key version. A public
caller-supplied customer identity header is never trusted. Atomic transaction verifies:

- token hash and bundle status;
- Customer and Order ownership;
- expiry and revocation;
- first-view/consumption version;
- asset still eligible for reveal.

Success reveals the minimum secret/entitlement once over TLS and records view/consumption audit.
Concurrent or later attempts return a stable safe error without revealing whether another customer's token exists.

Signature, expiry, audience, ownership, key version, and one-time nonce/replay state are verified
before vault access. Forged owner, wrong audience, expired/replayed token, and concurrent reveal all
fail closed without identifying whether the bundle exists.

The current and previous session signing keys are delivery-only and distinct from each other and
from Telegram, Buy Now, SePay, vault, and supplier secrets. Verification accepts the previous
version only before an explicit grace-until timestamp, even when the token expiry is later. Unknown
versions and previous-key sessions outside grace fail closed. Production notification processing
requires session codec configuration plus TTL; there is no optional verification bypass. If a
session expires while its Bundle remains live, recovery creates one replacement session
idempotently and revokes the prior one before send.
The signing-key version chosen for a PREPARED initial/refresh operation is durable. A retry during
the previous-key grace window reconstructs byte-identical session ID, nonce, expiry, signature, and
vault material; it MUST NOT send different material under the same vault operation key.

## Notification handoff

The worker stores only a redacted capability reference and the authoritative Telegram chat/customer
mapping. It never stores raw credential material in outbox or notification payloads. Failed or
ambiguous Telegram sends retain the same capability until retry/reconciliation; crash after send
must not create a second usable capability or address orderId as a customer/chat recipient.

Bundle commit first creates or reconstructs a deterministic PREPARED handoff intent. Its session is
inactive and cannot redeem until capability adoption activates it in the same database transaction. The source
event cannot become PUBLISHED until that intent is durable. Capability storage uses a deterministic
key and PREPARED -> STORED -> READY (or compensation) without external vault I/O inside a long
PostgreSQL transaction. Refresh uses a deterministic operation key derived from handoff ID plus
refresh generation. Session commit before vault write, vault write before database swap, lease
transfer, and database swap before old-ref delete are each recoverable and generation-fenced. A
successful vault write followed by database swap failure first attempts delete; if delete also
fails, a separate short transaction records the opaque orphan ref and inactive session in the
Feature 001 compensation ledger. Cleanup claims a row with owner/generation/lease, changes
`PENDING -> DELETING`, and adoption locks the same row and rejects `DELETING`. Only the fenced cleaner
may delete before marking `CLEANED`; failures return to delayed `PENDING` without losing the pointer.
The cleanup ownership lease exceeds the external vault adapter's complete configured delete
timeout/retry budget, so a live bounded delete is not reclaimed mid-operation.
The prior active ref remains usable until swap succeeds. Before each send,
claims are verified against handoff Bundle/Customer/chat, audience, expiry, and key version. Expired
sessions are refreshed idempotently; they are never marked SENT. SENT, DEAD, expired, and orphan refs
have bounded cleanup. The sender receives an abort signal and a timeout strictly shorter than the
renewed notification lease. A timeout is an ambiguous retryable outcome under the same durable
idempotency key; a stale worker cannot acknowledge `SENT`, and the Telegram adapter reconciles that
key before a later create/send attempt.

## Telegram customer transport

The notification opens a Telegram Mini App. The backend verifies bounded Telegram `initData`, binds
the numeric user/chat to the handoff, and performs one-time audience-bound redemption before reveal.
A normal Telegram URL button is never assumed to attach an Authorization header. The notifier owns
durable send/edit/photo dedupe, 429 `retry_after`, and ambiguous-send reconciliation.

## Migration compatibility

Migration 008 is frozen as SePay-only. Migration 009 upgrades databases that recorded either the
SePay-only 008 or the prior expanded 008 snapshot, preserving rows and idempotently creating missing
identity/delivery objects. Case-colliding `telegram`/`TELEGRAM` identities fail closed and require
the documented collision runbook; they are never silently merged. Telegram username metadata is
cleared after 30 days without a newer verified webhook observation and is never retained in the
durable inbox envelope.

## Reissue

Reissue is permitted only when the prior bundle expired before first view or an audited support/
replacement policy authorizes it. The prior bundle is revoked in the same transaction. A consumed
bundle is never silently reset; compromised delivery enters replacement review.

## Retention and redaction

Delivery pages disable caching and referrer leakage, avoid third-party content, and never place the
secret in URL/query, logs, analytics, traces, screenshots, or support transcript. Audit retains only
bundle/asset references, actor, outcome, time, and correlation ID.
