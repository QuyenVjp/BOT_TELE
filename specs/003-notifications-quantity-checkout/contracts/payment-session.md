# Contract: Quantity Payment Session and Telegram Copy

## Create

Input: authenticated Customer, Variant ID, integer quantity, callback/idempotency token.

Server revalidates Variant status, resale policy, unit price, max quantity, local/supplier capability,
and stock. Success returns one Order snapshot and Payment Intent. Price/stock change returns a typed
reconfirmation result, never silently accepts stale callback data.

## Presentation

The QR image and message render from Payment Intent + merchant display config. Required fields:
Order code, product/variant, quantity, unit price, exact total, bank, owner, account number, transfer
content, Vietnam-time expiry, exact-transfer warning, QR, check, and cancel buttons.

## Check status

Callback is opaque/expiring/customer-scoped. It reads the internal projection; optional reconciliation
request is debounced/queued and rate-limited. It never creates evidence or makes a synchronous provider
query per click.

## Cancel

Cancellation is idempotent and transactional with reservation release. If verified settlement wins
the race, cancel returns `ALREADY_PAID`; it cannot revert Payment Intent or discard the paid Order.

## Stable user states

`ORDER_CREATED`, `AWAITING_PAYMENT`, `PAYMENT_SETTLED`, `PROCESSING`, `NEEDS_REVIEW`, `CANCELLED`,
`EXPIRED`, `COMPLETED` each map to distinct Vietnamese copy.

