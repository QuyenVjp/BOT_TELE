# Architecture Contract — Wallet, Customer Identity, Persistent Keyboard

> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** TIER20 SHOP is Telegram-bot-only. Do not treat Mini App, WebApp, `initData`, `startapp`, or `shop.tier20.click` as required, blocked, or future work. See `docs/architecture/telegram-only-commerce.md`.

## 1. Scope

This sprint retains the closed-loop wallet domain, Telegram customer profile snapshots, a
persistent Telegram reply keyboard, and restock notifications. Mini App was cancelled by owner
decision; commerce is Telegram-bot-only. The retail MVP exposes catalog → VietQR → SePay →
delivery; wallet and top-up remain backend/post-MVP lanes.

Wallet is closed-loop store credit only. No withdrawal, cash-out, or P2P transfer.

### Operational product-to-delivery sprint

The active scope is the complete admin product → variant → inventory → customer checkout → verified payment → durable fulfillment → warranty workflow. The previous wallet/broadcast checkpoint remains an immutable baseline, not a production release.

- Reuse `product` and `product_variant`; inventory, fulfillment configuration, price, supplier mapping and low-stock threshold belong to the variant.
- Explicit fulfillment types: `STOCK_ACCOUNT`, `STOCK_CODE`, `DIGITAL_FILE`, `SUPPLIER_API`, `MANUAL_FULFILLMENT`, `QUANTITY_STOCK`, `UNLIMITED_SERVICE`. User-facing labels are Vietnamese, not enum names.
- Discrete account/code records retain reservation, delivery and replacement lineage. A reusable file artifact is versioned content, never a one-unit stock item; file bytes stay outside PostgreSQL and Telegram identifiers are bound to artifact version/hash.
- Retail payment remains VietQR/bank/verified SePay. The wallet domain stays isolated for a separately
  approved lane; payment handlers never perform type-specific delivery.
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
4. Dispatcher renders the retail reply keyboard and routes text/callbacks.
5. Approved wallet/admin paths, when enabled, call the wallet domain service only.
6. Verified SePay webhook credits top-up intents through the wallet service.
7. Outbox worker sends success/restock/broadcast notifications.

### Wallet purchase flow (deferred retail lane)

1. An explicitly enabled wallet lane may offer a wallet purchase.
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

Canonical retail labels:

- `🛒 Mua hàng`
- `👤 Tài khoản`
- `🧾 Đơn hàng`
- `🛡 Bảo hành`
- `💬 Hỗ trợ`

Wallet/top-up and reseller controls are not customer-facing retail MVP labels.

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
- Credential-bearing local/supplier bundles are delivered automatically in the successful Telegram notification after verified payment. The message renders every `customerVisible` inventory field plus configured usage and warranty text; internal-only fields remain withheld.
- `delivery_bundle` and the authenticated `/d/:token`/callback reveal path remain as retry/recovery compatibility surfaces, but a new purchase does not require a customer tap to receive its credentials.
- Automatic delivery must remain retry-safe: the worker may read the customer-visible secret before sending, but only finalizes bundle consumption and order completion after the Telegram send succeeds.
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

- Wallet entry and top-up selection remain deferred from the retail MVP; if enabled later, the
  existing ledger, VND bounds, and VietQR confirmation invariants still apply.
- Confirmed amount is immutable on the resulting intent and QR. Changing an unpaid amount cancels/expires the old intent before returning to selection; paid intents and verified once-only ledger credits remain unchanged.
- Inventory entry is product-first, then variant-first. Durable root-owned import sessions bind the selected variant and configured schema; user input never requires a database variant ID. Templates, uploads and actions follow fulfillment type.
- Inventory preview/list responses contain counts and safe metadata only. Import confirmation remains the stock mutation boundary. Per-variant restock subscriptions retain generation semantics; general shop announcements require preview/confirmation.
- P0 local/staging API and worker restart is authorized after focused checks. Real Telegram retail visible acceptance precedes the P0 commit; no production deployment or real payment is authorized by this canary.

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
- Store transitions are explicit, version-checked, audited, idempotent, and protected by the configured root-admin policy: TOTP grants when `ADMIN_STEP_UP_MODE=required`, identity plus durable confirmation when `disabled`. `TEST` is isolated from real customers; `CLOSED` rejects checkout; `OPEN` is reachable only after the existing commissioning gates pass.
- Bank transactions, payment evidence, discrepancies, outbox events, and delivery evidence remain append-only or status-transitioned. Resolution never deletes or rewrites provider evidence.
- Terminal orphan handling records a reason and audit trail, stops retry churn, and keeps the original outbox payload/evidence available for review.
- Admin screens expose safe identifiers and summaries only; no raw provider credentials, vault references, account inventory, or customer secrets are rendered.

### Owner-requested TOTP enforcement (2026-09-20)

- Production uses `ADMIN_STEP_UP_MODE=required` with the external Vault. Every action in `SENSITIVE_ACTION_POLICY` that has a non-null category requires a current RFC 6238 TOTP grant bound to the exact action, resource, version, and payload before mutation.
- Enrollment and factor replacement stay on the local operator host: render the `otpauth://` URI as a local QR, scan it into the owner's authenticator, and never send the seed or QR through Telegram. PostgreSQL stores only an opaque `vault:` reference.
- The bot-generated `/confirm` challenge is an action-binding/anti-replay gate, not 2FA. It remains separate from and cannot substitute for the owner's authenticator code.
- A failed, missing, expired, or locked-out TOTP verification must fail closed before the business mutation; attempts and authorization outcomes remain append-only redacted audit evidence.

### Owner-surface adapter rules

- Publication readiness renders visibility-only blockers (`PRODUCT_TEST_ONLY`) apart from the blockers that stop publication. A technically ready `TEST_ONLY` product can be promoted while the store is `CLOSED`; `TEST` mode is an explicit blocker so a public SKU cannot become visible-but-unbuyable in the test lane.
- The store-open preview and the durable `OPEN` transition read the same readiness through the same `isStoreOpenReady` predicate. The preview names every failing condition (empty public catalog, no in-stock variant, unresolved discrepancies, undisposed terminal outbox rows, `MANUAL_REVIEW` tickets) and offers no confirm button while any of them holds; the transition inside the confirmation remains the final authority.
- Health and operations screens print actionable work apart from retained history (`outboxDeadLetteredDisposed`, `resolvedDiscrepancies`). Ordinary open/waiting tickets stay informational; only `MANUAL_REVIEW` tickets are reported as critical. Both screens use the same predicates, but they are separate reads and may differ transiently while concurrent work commits.
- A recorded disposition request is reported as pending, not completed. Only a successful `/confirm` reports completion.
- Publication, evidence and store transitions stay root-admin gated and protected by the configured step-up mode, with durable confirmation in both modes, and remain confined to the allowlisted callback path; the worker performs no direct SQL mutation for them. Readiness data carries safe identifiers only — never evidence secrets or vault references.

### Module seams and risk ledger

- `catalog` owns resale-evidence records, publication readiness, and publication version binding; it reuses the current public/test visibility and route/readiness predicates.
- `commerce/store-mode` owns the state machine and optimistic version guard; `identity` owns step-up authorization and audit events.
- `payments/admin` owns discrepancy evidence/disposition; `infrastructure/outbox` owns terminal orphan classification and replay-safe disposition.
- Telegram admin callbacks/presenters are adapters only. They must call domain services and cannot mutate PostgreSQL directly.
- `invariants_preserved`: Telegram-only UX; closed-loop VND accounting; verified SePay evidence; transactional outbox; idempotent admin confirmations; secret-safe diagnostics; no direct inventory or payment bypass; root identity and exact action/resource/version binding in both step-up modes.
- `intentional_breaks`: the owner-approved `ADMIN_STEP_UP_MODE=disabled` posture bypasses TOTP enrollment, verification, attempts, and grants while leaving the existing factor/recovery data intact.
- `risked_invariants`: reduced second-factor defense while disabled, evidence version drift, concurrent store transitions, duplicate disposition/replay, and retry suppression. Focused tests must cover mode selection, stale versions, idempotent repeats, authorization boundaries, rollback, and terminal-vs-retry classification.

### Cutover contract

- No production publication, store opening, discrepancy resolution, or support closure is performed by code deployment alone. The owner must supply legitimate evidence and complete the configured Telegram root-admin confirmation flow. Production remains non-open until those human gates are observed and verified.

### Local lost-factor recovery contract

- The active root-admin TOTP factor remains authoritative until a new candidate factor verifies successfully. Recovery never disables step-up, deletes the active factor first, or creates another admin.
- `admin_step_up_recovery_candidate` stores only an opaque Vault reference for one short-lived candidate per admin. The candidate is local-operator initiated, bound to the current factor version, and never exposed through Telegram, HTTP, logs, or audit metadata.
- Recovery is a two-phase TTY flow: explicit production/root-identity confirmation; locally rendered QR; local candidate-code verification; one transaction promotes the candidate, increments the factor version, revokes all unconsumed grants, removes the candidate row, and appends redacted audit evidence.
- Failed or aborted recovery leaves the active factor usable. Candidate material is time-bounded and may be retried or replaced only through the same local recovery command; invalid candidate codes are durably rate-limited without changing the active factor.
- The existing `replace` command remains current-factor gated. The external Vault remains the only secret store; PostgreSQL stores opaque references and versioned metadata only.

### MFA recovery risk ledger

- `invariants_preserved`: numeric root identity; private Telegram authorization; Vault-only TOTP material; append-only attempts/audits; single-use resource-bound grants; active factor continuity until verified promotion.
- `intentional_breaks`: none to normal step-up verification or Telegram admin semantics; lost-factor recovery adds only a local operator path.
- `risked_invariants`: candidate expiry, concurrent recovery attempts, factor promotion versus grant consumption, Vault cleanup after commit, and operator interruption between QR display and code entry. Focused tests must cover stale candidates, invalid codes, atomic promotion, grant revocation, old/new factor behavior, and abort safety.

## 14. READY asset recovery contract (2026-09)

- `digital-goods/recovery` owns the only `READY -> AVAILABLE` correction path. It is never exposed as inventory hygiene and never writes Vault data.
- The owner command `inventory.ready.release` is a root-admin, private-chat, durable-confirmation action bound to the full asset ID, expected asset version, reason, and confirmation fingerprint. The `STOCK_ADJUSTMENT` policy remains authoritative.
- The transaction locks the asset and linked order, validates the expected version and `READY` state, then proves the order is economically unpaid: no paid order status, no succeeded/refunded payment intent, no settled allocation, no unresolved discrepancy, no live or consumed delivery bundle, no open refund obligation, no active replacement/warranty case, and no open manual-fulfillment task.
- A successful correction clears reservation ownership, increments the asset version, and appends redacted audit evidence. Any missing or ambiguous proof refuses without mutation. Replayed confirmations are no-ops; a new request with a stale version refuses.
- `delivery_notification_handoff` with `SENT` plus a live bundle remains manual-review evidence, not inventory stock. It is never released by this operation.
- `invariants_preserved`: paid ownership and delivery evidence remain immutable; no secret or Vault reference enters logs, audit, confirmation payloads, or Telegram; concurrent checkout/recovery is serialized by row locks and version checks.
- `risked_invariants`: incomplete historical delivery finalization and a customer who may already possess a valid delivery capability. Production recovery must prefer leaving a paid `READY` asset unchanged over guessing.

### Paid delivery reconciliation contract

- `digital-goods/recovery` owns the only correction for the historical paid-delivery anomaly `PROCESSING + SUCCEEDED + SETTLED + READY + EXPIRED + SENT`; detection is exact and transaction-scoped, not a generic status override.
- The owner command `fulfillment.reconcile` is a root-admin, private-chat, durable-confirmation action bound to the order ID and current order version. It may only park the exact anomaly in `FULFILLMENT_NEEDS_REVIEW`.
- The transaction locks the order and linked fulfillment evidence, proves that no consumed bundle, delivered asset, or `DigitalAssetDelivered` evidence exists, and then records the order transition plus redacted audit evidence. Any mismatch, stale version, missing evidence, or concurrent change refuses without mutation.
- This path never releases or reuses the `READY` asset, reissues or expires a bundle, changes payment/allocation truth, retries or sends Telegram, marks delivery complete, or creates an automatic worker retry. Later customer resolution is a separate owner-reviewed operation.
- `delivery_notification_handoff` with `SENT` and either a live or expired bundle remains manual-review evidence; `SENT + EXPIRED + READY` is not proof that delivery failed and is never auto-resendable.
- The notification sender must return the successful Telegram Bot API `Message` identity. The worker persists only safe provider evidence (`message_id`, recipient chat ID, and provider-success timestamp) in the redacted handoff record before bundle finalization; no credential or capability material is persisted there.
- A durable send-attempt marker is written before calling Telegram. An expired claim with no provider-success evidence is parked as delivery-uncertain and never retried blindly. An expired claim with provider-success evidence is self-healed by finalization without another Telegram send.
- `fulfillment.reconcile_delivered` is a separate root-admin, private-chat, durable-confirmation action. It requires current order version/fingerprint and proves payment `SUCCEEDED`, allocation `SETTLED`, exact recipient/order/asset/bundle/customer bindings, provider `message_id`, no duplicate delivery, no refund/reversal, and no conflicting manual fulfillment. It atomically moves the review order to `COMPLETED`, the exact `READY` asset to `DELIVERED`, the exact expired bundle to `CONSUMED`, writes one `DigitalAssetDelivered` outbox event, preserves `SENT`, and appends redacted audit evidence without touching payment, allocation, Vault, or Telegram.
- `fulfillment.keep_uncertain` is the explicit owner resolution when provider success or another required binding cannot be proved. It keeps the order in `FULFILLMENT_NEEDS_REVIEW`, records `DELIVERY_UNCERTAIN` with safe evidence and reason, and never releases, reissues, completes, refunds, or sends.
- `invariants_preserved`: payment, allocation, recipient, and Vault evidence remain immutable; a credential-bearing Telegram send occurs at most once per handoff; completion requires durable provider proof; confirmation is version/fingerprint-bound; no secret or raw delivery payload enters state, audit, confirmation payloads, or Telegram.
- `risked_invariants`: the customer may already possess a valid delivery capability despite incomplete finalization. The safe correction is therefore an explicit delivered-proof or uncertain disposition, never an inferred resend, release, refund, or completion.

## 15. Google Sheets operations control plane (2026-09)

Google Sheets is a disabled-by-default, asynchronous operational projection and
controlled request surface. PostgreSQL remains authoritative for orders,
payments, inventory, fulfillment, warranty/support, audit and all versions;
Vault remains authoritative for credentials and secret material. Sheets outage,
quota exhaustion or malformed external data must never block checkout, payment
or fulfillment.

### Module seams

- `infrastructure/google-sheets/client.ts` owns the official Google Sheets API
  client, minimal `spreadsheets` scope, credential loading from an opaque Vault
  reference, timeout/backoff and safe error classification.
- `modules/google-sheets/projection.ts` owns allowlisted, secret-free row
  builders, workbook schema/version, dashboard metrics and reconciliation.
- `modules/google-sheets/requests.ts` owns Requests parsing, action allowlist,
  optimistic version checks, idempotency, authorization, fixed transactional
  state transitions and audit writeback. It never executes arbitrary SQL or
  payment/delivery state transitions.
- `worker.ts` owns only asynchronous dispatch and periodic reconciliation. An
  outbox wake is a hint that can trigger a single-flight Sheets cycle; the
  periodic lane remains the durable recovery path. No Google call runs inside a
  commerce transaction.

### Workbook contract

The managed tabs are `Dashboard`, `Inventory`, `Orders`, `Payments`,
`Fulfillment`, `Warranty_Support`, `Suppliers`, `Requests` and `Audit`. Tab
creation is additive and non-destructive. Every projection row carries an
immutable source key (`asset_id`/`asset_code`, `order_id`/`order_code`,
`payment_intent_id`, `case_id` or `request_id`); spreadsheet row numbers are
never production identity.

The column ownership is explicit and structural, not a color convention:

- Every canonical column on `Dashboard`, `Inventory`, `Orders`, `Payments`,
  `Fulfillment`, `Warranty_Support`, `Suppliers` and `Audit` is
  `SYSTEM_AUTHORITATIVE`. The current `Inventory.safe_note` and supplier
  metadata are PostgreSQL-backed safe metadata, not human-owned cells.
- `Requests!A:H` (`request_id` through `payload`) is `HUMAN_EDITABLE`;
  `Requests!I:L` (`status` through `processed_at`) is
  `SYSTEM_AUTHORITATIVE`.
- Columns outside the canonical header width are `FORMULA_VIEW`. Reconciliation
  reads `A:Z` to discover stable keys and existing rows but writes only managed
  ranges, so formulas/views are never cleared.
- A safe note entered by a human is carried in the Requests payload and survives
  reconciliation until the request is processed. There is no current
  human-owned supplier/operator note column.

Projection uses immutable source keys to update the existing row in place,
appends only missing keys, clears only stale system cells, and preserves
Requests input cells. Sorting, filtering, row reordering and deletion cannot
change entity ownership. Audit projection is deterministic `audit_event.id ->
row`; it uses idempotent values upserts rather than blind append, so retry after
an ambiguous timeout and reconciliation after manual deletion converge to one
row per PostgreSQL audit event.

Workbook protection is part of the trust boundary: projection tabs and
Requests system columns are service-account-only; Requests input columns are
editable only by the configured Google owner account plus the service account.
`requested_by` is defense-in-depth metadata, not proof of the human editor
because the Values API does not carry collaborator identity. Successful
Requests are audited as `SYSTEM/google-sheets`, never as a Telegram
`ROOT_ADMIN` derived from cell text. Deployment must share the workbook with
the intended owner and service account and verify the protected ranges.
The service account receives direct access to this workbook only; no
domain-wide delegation is used.
The worker establishes or repairs this protection before reading request rows;
an uninitialized workbook cannot become an implicit write path.
The Requests state machine is `PENDING -> PROCESSING -> SUCCEEDED`,
`REJECTED`, `STALE` or `FAILED`; successful rows carry result code `APPLIED`
or `ALREADY_APPLIED`. `request_id`, target identity, expected version, safe
payload, descriptive `requested_by`, timestamps, result and audit linkage are
durable in PostgreSQL. `PENDING`/`PROCESSING` rows resume safely; a repeated
request ID replays its terminal result and a changed payload becomes a
`REQUEST_ID_CONFLICT` rejection without a second domain mutation.

Dashboard thresholds and sync state are safe operational signals only. They
must not trigger duplicate Telegram broadcasts or mutate commerce state.
Apps Script, if an operator adds it later, is formatting/convenience only and
is never an authority or an alternate write path.

### Secret boundary

No spreadsheet value, formula, hyperlink, audit metadata, request payload or
log may contain passwords, TOTP, cookies, sessions, access/refresh tokens,
Telegram auth, raw Vault values or digital-asset secrets. Account rows may
contain only a masked login, stable non-reversible identity fingerprint,
opaque Vault reference and safe operational metadata.

### Controlled request allowlist

Allowed actions are limited to `ADD_INVENTORY_METADATA`, `UPDATE_COST`,
`UPDATE_SAFE_NOTE`, `DISABLE_ASSET`, `ENABLE_ASSET`, `MARK_ASSET_REVIEW` and
`REQUEST_SUPPORT_REVIEW`, each routed through a fixed transactional domain
boundary, audit event and request-id idempotency record. `MARK_PAID`,
`SETTLED`, `DELIVERED`, allocation/evidence/ledger mutation, secret reveal and
direct `READY -> AVAILABLE` release are permanently rejected.

### Invariant ledger

- `invariants_preserved`: PostgreSQL/Vault authority; secret redaction; exact
  domain status; optimistic versions; stable row keys; durable audit;
  idempotent requests; transactional commerce isolation; batch API use.
- `intentional_breaks`: none; Sheets is opt-in and may be stale during outage.
- `risked_invariants`: collaborator edits, duplicate/replayed rows, stale
  versions, quota/network failure, credential misconfiguration and incomplete
  reconciliation. Focused tests and periodic full reconciliation cover them.
