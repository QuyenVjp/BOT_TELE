# Architecture Contract — Wallet, Customer Identity, Persistent Keyboard, Mini App

## 1. Scope

This sprint adds customer store credit, Telegram customer profile snapshots, a persistent Telegram reply keyboard, restock notifications, and a Mini App foundation. It does not replace the existing retail order/payment/delivery core. VietQR + SePay remains the payment rail for both direct checkout and wallet top-up settlement.

Wallet is closed-loop store credit only. No withdrawal, cash-out, or P2P transfer.

## 2. Module breakdown

### Existing modules that stay authoritative

- `modules/identity/channel-identity.ts`
  - Owns numeric Telegram user identity binding to `customer` + `channel_identity`.
  - Still authorizes by Telegram numeric user ID, never by username.
- `infrastructure/inbox/telegram.ts`
  - Owns Telegram webhook dedupe and username observation snapshot.
- `modules/commerce/buy-now.ts` and `modules/commerce/repository.ts`
  - Own the current retail one-variant purchase path and order persistence.
- `modules/payments/service.ts` and `modules/payments/sepay-ingress.ts`
  - Own the verified-payment path and SePay trust boundary.
- `bot/webhook.ts`, `bot/callbacks/telegram-dispatch.ts`, `bot/grammy-responder.ts`
  - Own Telegram ingress normalization and outgoing Telegram rendering.
- `bot/presenters/admin.ts`, `bot/callbacks/admin.ts`
  - Own admin screens and root-admin guarded actions.
- `modules/digital-goods/delivery-route.ts`
  - Owns the current server-side Mini App validation for delivery redemption.

### New modules to add

- `modules/wallet/*`
  - Own wallet account projection, immutable ledger, top-up intents, and purchase/refund commands.
- `modules/notification/*` or equivalent existing outbox-backed notification lane
  - Owns opt-in settings, stock-change notifications, restock subscriptions, and durable broadcast dispatch.
- `modules/miniapp/*` or equivalent API module
  - Owns Mini App auth validation, shared storefront APIs, and session/user identity binding.

## 3. Data model

### Customer profile

Authoritative customer identity remains the Telegram numeric user ID mapped through `channel_identity`.

Persist customer snapshots with at least:
- `telegram_user_id`
- `chat_id`
- `username`
- `first_name`
- `last_name`
- `display_name`
- `language_code`
- `created_at`
- `last_seen_at`
- `reachable`
- optional `phone_number`
- optional `phone_shared_at`

Profile updates are append-safe snapshots from verified Telegram updates; username is metadata only.

### Wallet

Add wallet tables with integer VND only:
- `wallet_account`
- `wallet_ledger`
- `wallet_topup_intent`

Invariants:
- balance is derived from ledger or kept as a projection guarded by version/transaction
- every balance change has exactly one ledger entry
- no negative balance
- no duplicate credit/debit/refund entry for the same idempotency key

### Notifications / subscriptions

Add persistent settings for customer notification opt-in and per-product restock subscriptions.

### Mini App

Reuse the existing delivery Mini App verification pattern: server validates raw `Telegram.WebApp.initData` and `auth_date` freshness before identifying the user. Do not trust `initDataUnsafe`.

## 4. Request flow

### Telegram customer flow

1. `bot/webhook.ts` verifies webhook secret and dedupes update.
2. `telegram-inbox` stores normalized envelope.
3. Worker resolves/refreshes customer identity snapshot.
4. Dispatcher renders persistent reply keyboard and routes text/callbacks.
5. Wallet actions call wallet domain service only.
6. Verified SePay webhook credits top-up intents through wallet service.
7. Outbox worker sends success/restock/broadcast notifications.

### Wallet purchase flow

1. Customer taps wallet purchase or direct buy.
2. Service revalidates product, stock, and balance in one transaction where practical.
3. If wallet is sufficient, purchase debits ledger atomically and order becomes paid.
4. If stock or balance fails, no debit persists.
5. Fulfillment remains in the existing outbox-driven path.

### Admin customer flow

1. Root-admin guard checks numeric Telegram ID and private chat.
2. Admin can read customer summary, wallet balance, ledger, spend, and last order.
3. Admin message-to-customer is emitted as audited outbound messaging, not direct DB mutation.

## 5. Telegram UI contract

### Persistent reply keyboard

Install/show a native `ReplyKeyboardMarkup` with:
- `resize_keyboard: true`
- `is_persistent: true`

Canonical labels:
- `🛒 Mua hàng`
- `👤 Tài khoản`
- `💰 Nạp ví`
- `🧾 Đơn hàng`
- `🛡 Bảo hành`
- `🔔 Báo có hàng`
- `🛟 Hỗ trợ`
- `🌐 Mở cửa hàng`

Rules:
- `/start` installs or refreshes it.
- Do not spam a new keyboard message on every action.
- Text routing must treat the keyboard labels as first-class commands.

### Contact sharing

Expose explicit `request_contact` only in private chat.

Rules:
- Never infer phone automatically.
- Contact sharing is opt-in and user-approved.
- Store phone only after explicit share.

## 6. Mini App contract

The Mini App is optional storefront UI only.

Must-haves:
- HTTPS WebApp URL
- server-side validation of raw `initData`
- auth_date freshness check
- user identity bound to Telegram numeric ID
- reuse backend commerce/wallet services; no duplicate purchase logic

Bottom navigation can be added later, but it must call shared backend services only.

## 7. Delivery and notification semantics

- Outbox remains the only durable side-effect boundary.
- Restock and wallet notifications are emitted from durable events, not from ad hoc DB updates.
- Broadcast pacing must stay bounded and retry-safe.
- Inventory correction must not masquerade as a customer-facing announcement unless explicitly toggled and derived from a real stock delta.

## 8. Safety invariants

- Username is never customer identity.
- Phone requires explicit share.
- Wallet balance never goes negative.
- One SePay transaction can credit at most one top-up intent.
- One purchase can debit wallet at most once.
- No wallet debit when stock reservation fails.
- Mini App auth must validate raw initData server-side.
- Notifications respect opt-in.
- Admin messages and wallet adjustments are audited.

## 9. Increment plan

1. Customer profile snapshot + persistent keyboard + contact share.
2. Wallet schema + ledger + top-up intent + SePay crediting.
3. Wallet purchase confirmation/debit flow.
4. Notification settings, restock subscriptions, stock event capture, broadcasts.
5. Mini App auth + shared storefront API shell.
6. Admin customer wallet/detail + message customer.

## 10. Open decisions

- Customer snapshots use `customer_profile_snapshot`; channel identity remains authoritative.
- Notifications extend the existing durable outbox/restock lane, with persisted opt-in and bounded retry/pacing. Admin direct messages require private-chat numeric root-admin authorization and audited enqueue.
- Wallet purchase, ledger debit, payment-intent voiding, and OrderPaid enqueue share one transaction; transaction executors never open nested transactions. Refund credits require the existing authorized refund flow and cannot exceed eligible paid value.
- Mini App ships a small working `/shop` storefront and authenticated API using the same catalog, order, and wallet services. No separate purchase engine or frontend dependency. Raw initData is checked server-side on authenticated requests; credentials never enter URLs or logs.
- Existing HTTPS public URL supplies the inline WebApp launch URL. Production registration, deployment, real money movement, and owner Telegram acceptance require explicit owner action; local disposable runtime verification does not substitute for owner acceptance.

### Continuation invariant ledger

- `invariants_preserved`: numeric identity; closed-loop integer VND; nonnegative balance; once-only business effects; stock/expiry validation before debit; transactional outbox; opt-in notifications; no secret disclosure.
- `intentional_breaks`: none to existing direct checkout or delivery capabilities.
- `risked_invariants`: concurrent bank settlement versus wallet purchase; reused idempotency keys; refund eligibility; stock-delta dispatch; expired/forged Mini App authentication; admin authorization. Integration/security tests must exercise these boundaries, including rollback and replay.
