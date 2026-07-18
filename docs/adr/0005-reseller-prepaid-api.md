---
status: proposed
---

# Reseller API starts prepaid and tenant-isolated

Reseller API is a post-MVP lane and is never exposed in the retail Telegram menu. When implemented, reseller orders reserve prepaid credit inside a strict Tenant boundary and use versioned, idempotent REST plus signed at-least-once webhooks. Postpaid credit remains deferred.
