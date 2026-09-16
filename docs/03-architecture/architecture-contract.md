# Architecture Contract — Wallet, Customer Identity, Persistent Keyboard

> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** TIER20 SHOP is Telegram-bot-only. Do not treat Mini App, WebApp, `initData`, `startapp`, or `shop.tier20.click` as required, blocked, or future work. See `docs/architecture/telegram-only-commerce.md`.

## 1. Scope

This sprint adds customer store credit, Telegram customer profile snapshots, a persistent Telegram reply keyboard, and restock notifications. Mini App was cancelled by owner decision; commerce is Telegram-bot-only. It does not replace the existing retail order/payment/delivery core. VietQR + SePay remains the payment rail for both direct checkout and wallet top-up settlement.

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
- `modules/payments/sepay-api.ts`
  - Owns bounded read-only SePay API v2 bank-account and transaction reads; official host allowlists and production sandbox refusal run before every bearer request.
- `bot/webhook.ts`, `bot/callbacks/telegram-dispatch.ts`, `bot/grammy-responder.ts`
  - Own Telegram ingress normalization and outgoing Telegram rendering.
- `bot/presenters/admin.ts`, `bot/callbacks/admin.ts`
  - Own admin screens and root-admin guarded actions.
- `modules/digital-goods/delivery-route.ts`
  - Owns operational GET `/d/:token` Bearer reveal. Mini App initData redeem is cancelled; customers receive credentials in Telegram chat.

### New modules to add

- `modules/wallet/*`
  - Own wallet account projection, immutable ledger, top-up intents, and purchase/refund commands.
- `modules/notification/*` or equivalent existing outbox-backed notification lane
  - Owns opt-in settings, stock-change notifications, restock subscriptions, and durable broadcast dispatch.
- Mini App module is cancelled. Do not add `modules/miniapp/*`.

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

CANCELLED BY OWNER — DO NOT IMPLEMENT. No `initData`, WebApp session, or Mini App identity binding.

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
- `💬 Hỗ trợ`

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

## 6. Mini App contract — CANCELLED BY OWNER — DO NOT IMPLEMENT

TIER20 SHOP does not use Telegram Mini Apps. Canonical UX is Telegram Bot API only (`docs/architecture/telegram-only-commerce.md`). Do not implement WebApp URL, `initData`, or `/shop` HTTP storefront.

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
- Mini App/WebApp auth is out of scope; do not add initData verification.
- Notifications respect opt-in.
- Admin messages and wallet adjustments are audited.

### Release-candidate recovery boundary

- Explicit operator recovery targets a known durable job family and ID, requires operator identity and reason, and appends redacted before/after metadata to audit in the same transaction.
- Recovery locks the durable row, rejects nonterminal/already-recovered jobs and owned leases, increments existing fencing generation, and changes only retry-safe scheduling/state fields. Business identity, ownership, provider transaction IDs and idempotency keys are immutable.
- Retry is allowlisted by actual handler semantics, never arbitrary stored payload replay. Ambiguous supplier create results and sensitive Telegram sends require reconciliation or manual review, not resend.
- RC workload/restore scripts use synthetic non-PII data in separate disposable databases. No benchmark invokes real Telegram/supplier transport or SePay Live.
- Checkpoint and RC commits are authorized for this sprint. Staging must run an exact clean commit; production deployment, store opening, live refunds and mass broadcast remain owner-only and unexecuted.

### Live UX P0 boundary

- Wallet entry displays the real balance and an amount picker without creating a top-up intent. A durable customer-owned selection/custom-amount workflow precedes explicit VietQR confirmation; configured integer VND bounds apply once at the shared boundary.
- Confirmed amount is immutable on the resulting intent and QR. Changing an unpaid amount cancels/expires the old intent before returning to selection; paid intents and verified once-only ledger credits remain unchanged.
- Inventory entry is product-first, then variant-first. Durable root-owned import sessions bind the selected variant and configured schema; user input never requires a database variant ID. Templates, uploads and actions follow fulfillment type.
- Inventory preview/list responses contain counts and safe metadata only. Import confirmation remains the stock mutation boundary. Per-variant restock subscriptions retain generation semantics; general shop announcements require preview/confirmation.
- P0 local/staging API and worker restart is authorized after focused checks. Real Telegram wallet/inventory visible acceptance precedes the P0 commit and resumption of overnight release work; no production deployment or real payment is authorized by this canary.

## 9. Increment plan

1. Customer profile snapshot + persistent keyboard + contact share.
2. Wallet schema + ledger + top-up intent + SePay crediting.
3. Wallet purchase confirmation/debit flow.
4. Notification settings, restock subscriptions, stock event capture, broadcasts.
5. ~~Mini App auth + shared storefront API shell~~ CANCELLED BY OWNER — DO NOT IMPLEMENT.
6. Admin customer wallet/detail + message customer.

## 10. Open decisions

- Customer snapshots use `customer_profile_snapshot`; channel identity remains authoritative.
- Notifications extend the existing durable outbox/restock lane, with persisted opt-in and bounded retry/pacing. Admin direct messages require private-chat numeric root-admin authorization and audited enqueue.
- Wallet purchase, ledger debit, payment-intent voiding, and OrderPaid enqueue share one transaction; transaction executors never open nested transactions. Refund credits require the existing authorized refund flow and cannot exceed eligible paid value.
- Mini App / `/shop` storefront / WebApp launch URL: CANCELLED BY OWNER — DO NOT IMPLEMENT.

### Continuation invariant ledger

- `invariants_preserved`: numeric identity; closed-loop integer VND; nonnegative balance; once-only business effects; stock/expiry validation before debit; transactional outbox; opt-in notifications; no secret disclosure.
- `intentional_breaks`: none to existing direct checkout or delivery capabilities.
- `risked_invariants`: concurrent bank settlement versus wallet purchase; reused idempotency keys; refund eligibility; stock-delta dispatch; admin authorization. Integration/security tests must exercise these boundaries, including rollback and replay.

## 11. Commissioning environment contract

- Telegram transport selects grammY `environment: "prod" | "test"` from configuration. Test mode uses Telegram's separate `/test/METHOD_NAME` API path and requires a separate test account and bot; production rejects test mode.
- SePay transport accepts only the official Live or Sandbox v2 hosts. Sandbox credentials and base URLs are non-production-only; production always uses the Live host.
- Supplier-backed variants remain unsellable unless an active supplier mapping exists. With no selected supplier, production keeps the catalog empty of supplier-backed variants instead of pointing at a placeholder endpoint.

### Commissioning invariant ledger

- `invariants_preserved`: production tokens never target Telegram test or SePay Sandbox; provider credentials remain environment-scoped; Telegram-bot-only UX; verified SePay evidence; durable fulfillment and secret-safe diagnostics.
- `intentional_breaks`: none to production transport defaults; non-production gains explicit isolated Telegram and SePay endpoints.
- `risked_invariants`: staging configuration drift and accidental sandbox credentials in production. Config validation and transport host allowlists must fail closed before any external call.

## 12. Observability memory contract

- `src/infrastructure/observability/tracing.ts` remains an optional in-process seam; it does not start an exporter or become a source of truth.
- Latency samples are bounded per metric. Implementations retain at most the latest 256 `valuesMs` entries while `count`, `totalMs`, and `errors` remain aggregate counters.
- No metric label may contain secrets, raw credentials, customer message text, or unbounded identifiers. PostgreSQL remains authoritative for operational state.

## 13. Production cutover remediation contract (2026-09)

This remediation closes the remaining owner-facing commissioning blockers without changing the Telegram-only product surface. It adds protected domain workflows for product publication, store-mode transitions, payment discrepancy disposition, terminal outbox-orphan handling, and readiness diagnostics.

### Required invariants

- A public product variant is sellable only when its product/category/variant state, price, fulfillment route, inventory/readiness, and supplier/resale evidence all satisfy the existing catalog predicates.
- Resale evidence is a first-class immutable reference. Publication binds the selected evidence and current commercial/fulfillment versions; changing those inputs invalidates the publication until an owner republishes.
- Store transitions are explicit, version-checked, audited, idempotent, and protected by the existing root-admin step-up policy. `TEST` is isolated from real customers; `CLOSED` rejects checkout; `OPEN` is reachable only after the existing commissioning gates pass.
- Bank transactions, payment evidence, discrepancies, outbox events, and delivery evidence remain append-only or status-transitioned. Resolution never deletes or rewrites provider evidence.
- Terminal orphan handling records a reason and audit trail, stops retry churn, and keeps the original outbox payload/evidence available for review.
- Admin screens expose safe identifiers and summaries only; no raw provider credentials, vault references, account inventory, or customer secrets are rendered.

### Owner-surface adapter rules

- Publication readiness renders visibility-only blockers (`PRODUCT_TEST_ONLY`) apart from the blockers that stop publication. A technically ready `TEST_ONLY` product can be promoted while the store is `CLOSED`; `TEST` mode is an explicit blocker so a public SKU cannot become visible-but-unbuyable in the test lane.
- The store-open preview and the durable `OPEN` transition read the same readiness through the same `isStoreOpenReady` predicate. The preview names every failing condition (empty public catalog, no in-stock variant, unresolved discrepancies, undisposed terminal outbox rows, `MANUAL_REVIEW` tickets) and offers no confirm button while any of them holds; the transition inside the confirmation remains the final authority.
- Health and operations screens print actionable work apart from retained history (`outboxDeadLetteredDisposed`, `resolvedDiscrepancies`). Ordinary open/waiting tickets stay informational; only `MANUAL_REVIEW` tickets are reported as critical. Both screens use the same predicates, but they are separate reads and may differ transiently while concurrent work commits.
- A recorded disposition request is reported as pending, not completed. Only a successful `/confirm` reports completion.
- Publication, evidence and store transitions stay root-admin gated, step-up protected, and confined to the allowlisted callback path; the worker performs no direct SQL mutation for them. Readiness data carries safe identifiers only — never evidence secrets or vault references.

### Module seams and risk ledger

- `catalog` owns resale-evidence records, publication readiness, and publication version binding; it reuses the current public/test visibility and route/readiness predicates.
- `commerce/store-mode` owns the state machine and optimistic version guard; `identity` owns step-up authorization and audit events.
- `payments/admin` owns discrepancy evidence/disposition; `infrastructure/outbox` owns terminal orphan classification and replay-safe disposition.
- Telegram admin callbacks/presenters are adapters only. They must call domain services and cannot mutate PostgreSQL directly.
- `invariants_preserved`: Telegram-only UX; closed-loop VND accounting; verified SePay evidence; transactional outbox; idempotent admin confirmations; secret-safe diagnostics; no direct inventory or payment bypass.
- `intentional_breaks`: none to customer-facing commerce semantics; the remediation only makes previously implicit owner controls explicit and blocks unsafe publication/opening paths.
- `risked_invariants`: evidence version drift, concurrent store transitions, duplicate disposition/replay, and retry suppression. Focused tests must cover stale versions, idempotent repeats, authorization boundaries, rollback, and terminal-vs-retry classification.

### Cutover contract

No production publication, store opening, discrepancy resolution, or support closure is performed by code deployment alone. The owner must supply legitimate evidence and complete the normal Telegram step-up flow. Production remains non-open until those human gates are observed and verified.
