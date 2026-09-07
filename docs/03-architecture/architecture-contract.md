# Architecture Contract — Wallet, Customer Identity, Persistent Keyboard, Mini App

## 1. Scope

This sprint adds customer store credit, Telegram customer profile snapshots, a persistent Telegram reply keyboard, restock notifications, and a Mini App foundation. It does not replace the existing retail order/payment/delivery core. VietQR + SePay remains the payment rail for both direct checkout and wallet top-up settlement.

Wallet is closed-loop store credit only. No withdrawal, cash-out, or P2P transfer.

### Operational product-to-delivery sprint

The active scope is the complete admin product → variant → inventory → customer checkout → verified payment → durable fulfillment → warranty workflow. The previous wallet/broadcast checkpoint remains an immutable baseline, not a production release.

- Reuse `product` and `product_variant`; inventory, fulfillment configuration, price, supplier mapping and low-stock threshold belong to the variant.
- Explicit fulfillment types: `STOCK_ACCOUNT`, `STOCK_CODE`, `DIGITAL_FILE`, `SUPPLIER_API`, `MANUAL_FULFILLMENT`, `QUANTITY_STOCK`, `UNLIMITED_SERVICE`. User-facing labels are Vietnamese, not enum names.
- Discrete account/code records retain reservation, delivery and replacement lineage. A reusable file artifact is versioned content, never a one-unit stock item; file bytes stay outside PostgreSQL and Telegram identifiers are bound to artifact version/hash.
- Payment remains VietQR/bank/verified SePay or atomic wallet checkout. Payment handlers never perform type-specific delivery; the existing durable fulfillment boundary owns routing and retries.
- Account field schemas distinguish required, secret and customer-visible fields. Import previews, audit, metrics and callbacks never contain inventory values. Existing vault protection remains mandatory.
- Inventory home selects a product first. With no products it offers creation; it never presents a contextless global stock count or generic CSV instructions.
- Preserve HMAC over timestamp plus exact raw body, ledger-only money changes, numeric Telegram identity, root/private admin authorization, atomic reservations and supplier UNKNOWN reconciliation before failover.
- Acceptance requires real owner-operable Telegram paths; source/test presence alone does not prove live UI acceptance. No new Telegram Stars payment path.

### Seven-type operational completion contract

- Customer catalog and checkout use the same fulfillment-type/stock-policy compatibility rules. `SUPPLIER_ONLY` is accepted only for configured `SUPPLIER_API`; unsupported legacy combinations remain blocked.
- Catalog readiness reflects each type's backing inventory/configuration. Zero quantity may remain visible for restock navigation, but must not expose a payable action. Checkout revalidates readiness transactionally; catalog readiness is never payment authorization.
- File setup may create an inactive variant before upload. Admin inventory must keep that variant reachable, and activation requires a real active artifact. No placeholder metadata counts as ready inventory.
- The seven-type creation wizard reuses existing schemas and root/private preview-confirm flows. Supplier configuration references an existing provider; service types persist their actual service definition; quantity stock uses its ledger-backed operations.
- Intentional compatibility change: configured supplier-only API products become customer-operable. Preserved invariants: resale evidence, numeric identity, atomic reservations, verified payment, durable fulfillment, secret-safe previews and explicit owner activation.

### Operational history and wallet event dispatch

- Root-private variant inventory history reads bounded redacted audit counts and quantity-ledger movements. New single-variant imports bind audit target IDs to the variant; older unscoped `manual` import records cannot be attributed retroactively.
- `WalletTopupPresented`, `WalletTopupCredited`, and `WalletRefunded` enqueue durable critical-service notifications through the existing notification lane. Campaign/delivery keys deduplicate replay; missing recipients retry and malformed known wallet payloads require terminal review rather than silent acknowledgement.
- Product-specific restock subscriptions provide consent only for that product's alert. Subscribing does not enable general shop-update campaigns.

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
- Marketing `all` is `SHOP_UPDATE` and requires `shop_updates` consent at preview, recipient creation and send time. Only genuine service-critical campaigns retain opt-out-independent delivery; marketing navigation cannot select that class.
- Owner-triggered stock announcements from an inventory variant view are optional `SHOP_UPDATE` marketing broadcasts. The preview content is rebuilt from product/variant/stock/price tables, then confirmed through the existing broadcast campaign flow; product restock subscriptions never imply shop-update consent.
- A supplier purchase has one persisted dispatch winner. Re-entering a pending/submitted/unknown attempt never issues another purchase; recovery queries the original provider identity without holding a database transaction across network I/O.

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

### Release-candidate recovery boundary

- Explicit operator recovery targets a known durable job family and ID, requires operator identity and reason, and appends redacted before/after metadata to audit in the same transaction.
- Recovery locks the durable row, rejects nonterminal/already-recovered jobs and owned leases, increments existing fencing generation, and changes only retry-safe scheduling/state fields. Business identity, ownership, provider transaction IDs and idempotency keys are immutable.
- Retry is allowlisted by actual handler semantics, never arbitrary stored payload replay. Ambiguous supplier create results and sensitive Telegram sends require reconciliation or manual review, not resend.
- RC workload/restore scripts use synthetic non-PII data in separate disposable databases. No benchmark invokes real Telegram/supplier transport or SePay Live.
- Checkpoint and RC commits are authorized for this sprint. Staging must run an exact clean commit; production deployment, store opening, live refunds and mass broadcast remain owner-only and unexecuted.

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
