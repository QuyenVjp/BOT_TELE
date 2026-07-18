# Contract: Root Admin Broadcast

## Draft/preview

Only configured numeric root admin in private chat may create a draft. Input includes class, safe
title/body, optional Product ID, target segment, schedule, and reason. Server validates Unicode length,
formatting, links/media policy, credential-like patterns, class/content consistency, and target scope.

Preview displays final rendering, class, segment, quiet-hour behavior, recipient estimate, schedule,
and warnings. No fanout occurs before explicit confirmation bound to campaign fingerprint.

## Confirm/send/cancel

Confirmation is step-up, expiring, idempotent, and audited. Campaign fanout uses a single campaign
idempotency key plus unique campaign/customer delivery keys. Cancellation stops unsent batches but
does not retract already delivered messages unless a separate edit/delete policy permits it.

## Fanout behavior

- Outbox-backed batches, no direct synchronous loop in admin callback.
- Telegram `retry_after` honored; exponential/backoff budget; blocked chats suppressed.
- Progress counts: eligible, suppressed, pending, sent, retrying, dead.
- Message payload contains no credential, provider secret, buyer identity, private Order/payment data.

