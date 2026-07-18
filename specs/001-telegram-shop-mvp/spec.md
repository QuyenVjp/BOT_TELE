# Feature Specification: Telegram Shop Digital MVP

**Feature Branch**: `001-telegram-shop-mvp`

**Created**: 2026-07-16

**Status**: Gate 0 correction in progress — `REQUEST_CHANGES`

**Input**: Build a customer-first Telegram shop for Vietnamese buyers of authorized digital account/access products. Customers browse or search the shop, see price and terms, buy one variant, pay by VietQR, have the transfer verified by SePay, and receive the product securely. Only the configured numeric Telegram identity mapped to `@Quyenvjp` is root admin.

## Clarifications

### Session 2026-07-17

- No additional clarification question was needed: the owner explicitly selected the migration
  freeze/upgrade protocol, dedicated delivery key ring with bounded grace, Telegram Mini App
  transport, crash compensation requirements, and username retention boundary. These decisions are
  normative below and remain within Feature 001; Feature 003, AI, wallet/top-up, and Reseller API
  remain out of scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find and understand a product (Priority: P1)

A Vietnamese customer opens the bot, browses active categories or searches by keyword/natural
language, and sees authoritative product cards with the information required to make a purchase.

**Why this priority**: No sale is possible unless customers can quickly find a valid, available
product and understand its price and conditions.

**Independent Test**: Start with a seeded catalog and prove that a customer can reach an active
variant, understand its offer, and return to the main menu without creating an Order.

**Acceptance Scenarios**:

1. **Given** active categories and variants, **When** a customer opens the shop, **Then** the bot shows only `Danh sách sản phẩm`, `Tìm sản phẩm`, `Đơn hàng`, and `Hỗ trợ` as primary actions.
2. **Given** an active category, **When** the customer browses it, **Then** products are paginated in a stable order with visible VND prices.
3. **Given** a natural-language query such as `gói 1 tháng dưới 200k`, **When** search completes, **Then** every displayed name, price, stock, warranty, and delivery fact comes from the shop catalog.
4. **Given** the search parser is unavailable or rejects the query, **When** the customer searches, **Then** deterministic keyword search remains available and no fabricated offer is displayed.
5. **Given** an inactive or unauthorized variant, **When** the catalog is viewed or searched, **Then** that variant is not purchasable.

---

### User Story 2 - Buy and pay with VietQR (Priority: P1)

A customer selects one product variant, sees the final offer, creates one Order, scans a VietQR,
and waits while the shop automatically checks the transfer through SePay.

**Why this priority**: This is the revenue path and the primary trust boundary for the product.

**Independent Test**: From a seeded sellable variant, create an Order and QR, then submit one
matching verified bank transaction and observe exactly one paid Order without fulfillment.

**Acceptance Scenarios**:

1. **Given** a sellable variant with local stock, **When** the customer presses `Mua ngay`, **Then** the shop revalidates the current offer, atomically reserves one concrete asset, and creates one immutable Order snapshot with one Payment Intent/VietQR.
2. **Given** N concurrent `Mua ngay` requests against the final local asset, **When** all transactions complete, **Then** exactly one reservation and one Payment Intent/QR exist; every other request receives an explicit out-of-stock result with no Order, no Payment Intent, and no QR.
3. **Given** an unpaid Order, **When** payment is presented, **Then** the QR, exact VND amount, unique transfer content, bank display name, Asia/Ho_Chi_Minh expiry, and cancel/check actions are clearly shown without requesting a receipt screenshot.
4. **Given** a matching verified inbound transaction, **When** SePay evidence is processed, **Then** the Order becomes paid exactly once.
5. **Given** duplicate or reordered evidence for the same bank transaction, **When** it is processed repeatedly, **Then** payment remains a single settlement with no duplicate downstream effect.
6. **Given** a screenshot, chat message, return URL, or status-refresh action, **When** it is received, **Then** it does not mark the Order paid.
7. **Given** an amount/content/account mismatch, late transfer, underpayment, overpayment, or unmatched deposit, **When** evidence is processed, **Then** the transaction enters a reviewable discrepancy and is not silently fulfilled.
8. **Given** a customer double-taps `Mua ngay` with the same signed checkout nonce, **When** both presses are processed, **Then** only one Order, one reservation, and one Payment Intent exist.
9. **Given** a signed official-shaped SePay request, **When** Fastify accepts it, **Then** PostgreSQL commits the immutable inbox event before the exact success ACK and a later worker claim performs the only settlement effect.
10. **Given** the same bank account is configured for SePay matching and VietQR rendering, **When** a pilot payment is presented and received, **Then** the separate keys are accepted and the payment settles; a distinct VA/sub-account configuration also matches only its configured identity.

---

### User Story 3 - Receive the purchased product securely (Priority: P1)

After verified payment, the customer receives one valid asset from local stock or an authorized
supplier and opens it through a time-limited, view-once delivery page.

**Why this priority**: The purchase has no value until a valid product is delivered without
credential leakage or duplicate allocation.

**Independent Test**: Begin with one paid Order and one available local asset; issue a Delivery
Bundle, open it as the owning customer once, and prove that a second view or second customer is denied.

**Acceptance Scenarios**:

1. **Given** a paid Order and available local stock, **When** fulfillment begins, **Then** one compatible asset is atomically claimed and one Delivery Bundle is issued.
2. **Given** no local stock and an eligible supplier SKU, **When** fulfillment begins, **Then** one idempotent supplier request is created and the customer sees a non-misleading processing state.
3. **Given** an uncertain supplier timeout, **When** recovery runs, **Then** the prior result is queried/reconciled before any create retry.
4. **Given** an invalid, revoked, wrong-region, wrong-duration, or malformed supplier asset, **When** validation runs, **Then** the asset is quarantined and not delivered.
5. **Given** a valid Delivery Bundle, **When** the owning customer views it once before expiry, **Then** the secret/entitlement is shown and subsequent views do not reveal it.
6. **Given** a crash or replay at any fulfillment boundary, **When** processing resumes, **Then** the Order does not receive a second supplier purchase, asset, or Delivery Bundle.
7. **Given** Telegram delivery fails or the worker crashes after an ambiguous send, **When** retry/recovery runs, **Then** the same customer/chat receives at most one usable signed delivery capability and no raw credential is stored in the notification event.
8. **Given** a crash after Delivery Bundle commit but before notification handoff, **When** recovery runs, **Then** exactly one usable handoff/capability is reconstructed without relying on call-stack plaintext and the originating event is not acknowledged early.
9. **Given** capability storage succeeds but its database transition rolls back, **When** compensation runs, **Then** the orphan capability cannot be redeemed and is deleted within a bounded interval.
10. **Given** a notification is retried after its delivery session expires while the Bundle remains live, **When** recovery prepares the send, **Then** one refreshed session replaces the expired capability idempotently and no expired send is marked successful.
11. **Given** a delivery signing-key rotation, **When** a session signed by the previous approved version is redeemed inside the grace window, **Then** it is accepted once; outside that window or for an unknown version it fails closed.
12. **Given** a customer taps the Telegram delivery button, **When** the Mini App validates Telegram `initData`, **Then** it redeems an audience-bound one-time session and can reveal without relying on an Authorization header being attached by Telegram.
13. **Given** a 429, send failure, or ambiguous Telegram result, **When** the notifier retries/reconciles, **Then** media/edit behavior and the durable dedupe key converge on the same customer/chat and capability.

---

### User Story 4 - Review orders and obtain support (Priority: P2)

A customer can review only their own Order history, reopen valid unpaid payment instructions,
understand current states, and open a structured support ticket tied to an Order.

**Why this priority**: Self-service status and contextual support reduce anxiety and manual lookup
without weakening payment or secret controls.

**Independent Test**: Seed Orders in unpaid, processing, completed, and review states for two
customers; prove one customer sees only their Orders and can open a structured ticket without exposing credentials.

**Acceptance Scenarios**:

1. **Given** multiple Orders, **When** a customer opens history, **Then** only Orders owned by that customer are shown with paginated summaries.
2. **Given** an unexpired unpaid Order, **When** the customer reopens it, **Then** the existing payment instructions are shown without creating a duplicate Order.
3. **Given** a completed or problematic Order, **When** the customer requests help, **Then** a structured ticket is created with the Order reference and no raw credential requirement.
4. **Given** a support interaction, **When** an operator reviews it, **Then** support cannot mark payment paid, mutate payment evidence, or reveal the credential.

---

### User Story 5 - Operate the shop as the sole owner (Priority: P2)

The owner mapped to `@Quyenvjp` can privately manage catalog availability, review discrepancies,
and inspect audit evidence while every other Telegram identity is denied root administration.

**Why this priority**: The shop must be operable without creating a second administrator or an
unsafe direct-database workflow.

**Independent Test**: Run the same admin action from the configured numeric identity, a different
numeric identity using the username `@Quyenvjp`, and a group chat; only the configured private identity is accepted after required confirmation.

**Acceptance Scenarios**:

1. **Given** the configured numeric root identity in private chat, **When** a low-risk catalog action is requested, **Then** the action is authorized and audited.
2. **Given** any other numeric identity, **When** it presents the username `@Quyenvjp`, **Then** authorization is denied and recorded.
3. **Given** any chat, **When** `/add-admin` or an equivalent action is attempted, **Then** no administrator is created.
4. **Given** a high-risk action, **When** the owner requests it, **Then** private context, step-up/explicit confirmation, idempotency, reason, and immutable audit are required.

### Edge Cases

- The product price or active status changes between viewing the card and pressing `Mua ngay`.
- Two customers attempt to buy the final local asset concurrently; the reservation-commit loser must get an out-of-stock result with no Order/Payment Intent/QR and no charge.
- A customer double-taps `Mua ngay`, refreshes payment rapidly, or replays an old callback; a stable signed nonce must collapse this to one Order/reservation/intent.
- A cancel and a settlement for the same Order race on two connections; the outcome must follow the verified `transactedAt` policy, not lock timing.
- A valid transfer arrives exactly as the Payment Intent or reservation expires.
- A worker's outbox lease expires mid-handler and another worker reclaims the event; the stale worker's later ack/fail must change zero rows.
- Several partial transfers together equal the Order amount, or one transfer references two Orders.
- SePay sends an event with valid transport but invalid signature, stale timestamp, wrong account, or outbound direction.
- SePay webhook delivery is missing while reconciliation later finds the transaction.
- Payment is verified but local stock and supplier stock both become unavailable.
- Supplier returns success with a malformed/duplicate/revoked asset or times out after creating the upstream order.
- A Delivery Bundle expires before first view, is opened concurrently, or is requested by another customer.
- A process crashes after Bundle commit but before handoff intent, or after capability storage before
  database commit; recovery must not lose the customer path or leave a redeemable orphan.
- A notification session expires while the Bundle is live, or the current delivery key rotates while
  a previous-key session is in its bounded grace period.
- A Telegram send stalls beyond the notification lease; the worker must abort before lease expiry,
  retain the stable dedupe key, and retry/reconcile without a stale `SENT` acknowledgement.
- A legacy database already records migration 008 with either SePay-only or expanded identity/
  delivery objects; migration 009 must preserve data and converge both shapes.
- Both `telegram` and `TELEGRAM` identities exist for the same numeric ID before normalization; the
  migration fails closed and the collision runbook is required.
- An authenticated Telegram update includes a username; the durable inbox must not retain it and
  bounded pruning MUST clear `observed_username` and its observation timestamp after 30 days without
  a newer verified webhook observation; the durable inbox never stores the username.
- The bot, worker, database connection, cache, or supplier is unavailable and later recovers.
- A blocked/rate-limited customer still needs access to a paid Order or support recovery path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The shop MUST present a Vietnamese retail menu containing only catalog, search, Order history, and support actions.
- **FR-002**: The shop MUST list only active categories and sellable product variants in stable, paginated order. In Feature 001, the customer-facing catalog/search/detail surface MUST exclude `SUPPLIER_ONLY`, `PAUSED`, null, and unknown stock policies; only policies explicitly allowlisted by the checkout contract may appear purchasable.
- **FR-003**: Product detail MUST show VND price, duration, availability, delivery type, expected delivery, warranty, and usage conditions before purchase.
- **FR-004**: The shop MUST provide deterministic search by product/category/alias and MAY parse natural-language queries only into an allowlisted filter set.
- **FR-005**: All displayed product facts MUST originate from the authoritative catalog; generated text MUST NOT create or override a product fact.
- **FR-006**: `Mua ngay` MUST revalidate the selected variant, current price, active state, stock policy, and resale eligibility before creating one Order.
- **FR-006a**: For a variant that draws on finite local stock, `Mua ngay` MUST atomically reserve one concrete `AVAILABLE` asset (or a bounded stock unit) in the SAME transaction that creates the Order, BEFORE any Payment Intent or VietQR is created. A failed reservation MUST return exactly one typed outcome: `NO_STOCK` when no available unit exists, `CONTENTION_TIMEOUT` when bounded contention expires, or `RESERVATION_LOST` when a contender loses after observing a candidate. The new output contract MUST NOT emit `OUT_OF_STOCK`; that name may exist only as an internal/deprecated compatibility alias while a proven legacy caller remains. Every failed outcome MUST leave no Order, Payment Intent, or QR. The winner of a concurrent final-stock contest is the FIRST transaction that commits the reservation in PostgreSQL, never the earliest human click or network arrival.
- **FR-006b**: A stock-reservation loser MUST receive one truthful message matching its typed outcome, MUST NOT be shown any "payment successful" or payment-in-progress copy, and MUST NOT be charged. The response SHOULD offer working browse-alternatives and catalog/menu navigation. Notify-when-available SHOULD be offered only after a durable subscription exists with persistence, opt-in, opt-out, dedupe, a restock event, and delivery retry; Feature 001 MUST NOT expose a dead `stock:notify` callback. Distinct labels MUST NOT point to the same callback unless they represent genuinely distinct navigation semantics.
- **FR-006c**: Reservation release on Order cancel or expiry MUST be atomic and recoverable in the same state protocol that voids the Payment Intent; a released unit MUST return to `AVAILABLE` and become reservable again, and a crash between reserve and release MUST be recovered by a bounded reservation-expiry job.
- **FR-006d**: A double-tap of `Mua ngay` by the same customer for the same variant/checkout MUST create at most one Order, one reservation, and one Payment Intent. Idempotency MUST be enforced with a stable signed callback nonce and an `INSERT ... ON CONFLICT DO NOTHING RETURNING` (or savepoint) winner-read, never by catching a unique violation and continuing to query on an aborted transaction.
- **FR-006e**: `SUPPLIER_ONLY` is fail-closed in Feature 001 because no supplier capacity hold, reconciliation, and automatic refund contract exists before payment. `BuyNow` and Payment presentation MUST use explicit stock-policy allowlists; `LOCAL_ONLY` and `LOCAL_THEN_SUPPLIER` require an active reservation, while `SUPPLIER_ONLY`, `PAUSED`, null, and unknown policies MUST NOT create a Payment Intent or VietQR. This is a temporary safety gate, not removal of supplier fulfillment: durable supplier capacity hold, reconciliation, and refund remain mandatory before that policy may become sellable.
- **FR-007**: Each Order MUST contain an immutable snapshot of product/variant name, price, duration, delivery type, warranty, and applicable policy.
- **FR-008**: Each unpaid retail Order MUST have at most one active VietQR payment request with exact integer VND amount, unique transfer content, and expiry. `SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` MUST remain independently configured keys with separate matching/rendering responsibilities, but their configured values MAY be equal for a pilot account or distinct for a VA/sub-account deployment.
- **FR-008a**: The customer payment presentation MUST include an independently verified, scannable QR image for the exact beneficiary, integer VND amount, and structured payment code. Image retrieval and Telegram media delivery MUST be bounded, content-type/size validated, idempotent, and recoverable after rate limits or ambiguous sends; a text-only self-round-trip is not QR-image acceptance evidence.
- **FR-009**: A Payment Intent MUST become settled only from verified, matched SePay transaction evidence. Settlement evidence that reaches domain services MUST be an opaque/branded value produced by the runtime SePay verifier or reconstructed from a strictly validated, hash-bound durable inbox claim; structurally forgeable raw provider payloads MUST NOT be accepted and MUST NOT be stored with a `VERIFIED` signature status.
- **FR-009a**: A signed official-shaped SePay request MUST follow one durable lifecycle: verify raw request, commit an immutable allowlisted inbox envelope, return exact HTTP `200 {"success":true}`, then let a fenced worker claim, validate, match, and settle asynchronously. Before restoring trust, the claimed source event ID, raw hash, payload ID/account/amount/code/content/reference, evidence fields, and valid timestamp MUST agree. Claim/retry/dead-letter/crash recovery and duplicate-mutation alerts MUST be durable and idempotent; a mutation alert key is the source event plus incoming raw hash.
- **FR-010**: Duplicate and reordered Telegram, SePay, worker, and supplier inputs MUST be idempotent.
- **FR-011**: Payment discrepancies MUST preserve the bank transaction, reason, Order mapping candidates, and review status without automatic fulfillment. Money for a cancelled/expired/already-paid Order MUST be recorded as an owned discrepancy/review outcome, never as a silent unmatched drop or a second `OrderPaid`.
- **FR-012**: Reconciliation MUST recover valid missing payment events and surface unresolved mismatches with an owner and SLA.
- **FR-013**: Fulfillment MUST begin only after the related Order has verified payment. Asset claim state and the corresponding outbox event MUST commit in ONE transaction so a crash cannot lose the event after claim.
- **FR-014**: A local digital asset MUST be allocated to at most one active Order using an atomic claim. Pre-payment reservation (FR-006a) is the first claim step for finite local stock; post-payment fulfillment upgrades the same reservation rather than claiming a second asset. Active fulfillment re-entry MUST select only a deterministic `RESERVED`/`READY` hold; delivered-history lookup MUST be a separate deterministic query and MUST never be reused as the active claim source.
- **FR-015**: Supplier creation MUST be idempotent; uncertain results MUST be queried/reconciled before retry. The staging HTTP supplier adapter MUST authenticate and validate bounded availability/create/query/cancel/refund/reconcile responses, and local-stock exhaustion MUST enter this port without creating a second supplier purchase.
- **FR-016**: Supplier output MUST be validated for expected SKU/type, uniqueness, expiry/duration, region, and usability before delivery.
- **FR-017**: Every delivered secret/entitlement MUST use a customer-and-Order-bound Delivery Bundle with expiry and view-once behavior. Public reveal authorization MUST use a short-lived signed Telegram-bound delivery session carrying audience, customer, numeric Telegram identity, Bundle, nonce, expiry, and key version; caller-supplied identity headers are forbidden. Delivery signing uses dedicated current/previous keys, TTL, and an explicit previous-key grace deadline that MUST NOT reuse Buy Now, Telegram, SePay, vault, or supplier secrets. Previous-key tokens MUST fail after that deadline even when their token expiry is later. Production notification processing MUST NOT bypass session verification or omit session TTL. A live Bundle MAY refresh one expired session idempotently but MUST have at most one usable capability.
- **FR-017a**: Delivery notification handoff MUST durably preserve a redacted bearer-capability reference until the correct Telegram chat receives it. Bundle commit, handoff intent, capability storage, notification claim, send, and acknowledgement MUST form a recoverable state protocol that does not depend on plaintext remaining in a call stack. Send failure, database rollback, worker crash, session expiry, retry, lease transfer, signing-key rotation, or ambiguous send MUST NOT expose raw credentials, strand the paid customer, deliver to `orderId`, mint two usable capabilities, or mark an expired session `SENT`. A PREPARED session MUST remain inactive until its capability reference is adopted atomically; the pending signing-key version and deterministic handoff-plus-generation operation identity MUST be frozen so retry across current/previous-key rotation reproduces the exact same material. If a new vault write succeeds but database swap or compensating delete fails, every orphan reference MUST remain in a durable child compensation ledger until bounded cleanup succeeds; the prior usable reference MUST not be lost. Cleanup MUST use leased generation fencing and MUST serialize against capability adoption so it cannot delete a reference that became current. Capability claims MUST match handoff Bundle/Customer/chat immediately before send. External notification send MUST have an abortable timeout strictly shorter than its database lease; timeout/ambiguity retains the stable dedupe key for reconciliation and MUST NOT permit a stale `SENT`. SENT/DEAD/expired refs require bounded cleanup or compensation.
- **FR-018**: Customers MUST be able to view only their own paginated Order history and relevant payment/fulfillment/support states.
- **FR-019**: Customers MUST be able to create a structured support ticket linked to an Order without resubmitting the delivered secret.
- **FR-020**: The system MUST support recorded warranty replacement/refund review without rewriting the original Order or delivery history. A replacement case MUST link the deterministic original `DELIVERED` asset even when a newer `RESERVED`/`READY` replacement exists for the same Order; fulfillment re-entry MUST never re-deliver the old credential.
- **FR-021**: The root-admin capability MUST authorize only the configured numeric Telegram identity mapped to `@Quyenvjp` in the allowed context. A fresh private Telegram interaction MUST atomically upsert one Customer and one canonical `TELEGRAM` ChannelIdentity by numeric user ID; username is metadata only, concurrent `/start` converges to one identity, and the configured numeric root identity is resolvable on an empty database. Root bootstrap MUST NOT copy the configured expected username into observed metadata. A real observed username may be updated only from a secret-verified Telegram webhook and MUST NOT be persisted in the durable inbox; a request rejected by the webhook secret gate MUST write neither inbox work nor username observation. Any temporary observation has explicit retention and bounded pruning.
- **FR-022**: The system MUST NOT expose a command or flow that adds another root administrator.
- **FR-023**: High-risk owner actions MUST require explicit confirmation, idempotency, reason, and immutable audit evidence. Confirmation state MUST be durable (not only an in-memory map) so a process restart cannot drop a pending action, and consume + mutation + audit MUST complete as one recoverable unit.
- **FR-024**: The system MUST provide user/action-specific abuse controls while preserving an authenticated recovery route for paid Orders and support.
- **FR-024a**: Telegram HTTP ingress MUST verify the secret and bounded update shape, normalize the
  smallest allowlisted command envelope, commit it durably in PostgreSQL, and only then acknowledge.
  Business handling MUST be asynchronous. Duplicate update ID plus identical raw hash MUST not
  re-execute; the same update ID with a different hash MUST be an auditable discrepancy. Claimed
  work MUST use owner+generation lease fencing, bounded retry/backoff/dead-letter behavior, and safe
  telemetry. Production abuse budgets MUST be atomic across instances, keyed by normalized numeric
  user plus allowlisted action; paid-Order recovery and support retain bounded authenticated lanes.
  The durable envelope MUST exclude `actorUsername`; authenticated username observation is a
  separate bounded metadata path and is stripped/pruned after its documented retention. The secret
  gate MUST execute before both persistence paths, and rejected requests MUST have zero durable
  inbox or username-observation effect.
- **FR-025**: Outbox claim/ack/fail MUST use owner fencing (claim owner + generation/lease token predicates). A stale worker whose lease expired MUST affect zero rows when it later acks or fails; long work MUST renew the lease or claim one event at a time.
- **FR-026**: Recovery jobs (Order/Payment Intent expiry, reservation release, SePay reconciliation, supplier UNKNOWN query, Delivery Bundle expiry/reissue) MUST process bounded `FOR UPDATE SKIP LOCKED` batches with per-row conflict isolation and backlog/oldest-age telemetry; they MUST NOT load unbounded stale lists into memory.
- **FR-027**: Delivery Bundle reveal MUST be crash-safe: vault material is revealed before consume; asset owner/status is re-checked; a failed `markAssetDelivered` MUST prevent consume/completion; access MUST use a signed Telegram-bound session rather than a trusted client header. The customer transport is a Telegram Mini App that verifies bounded `initData` and performs one-time, audience-bound redemption; the design MUST NOT assume a Telegram URL button sends an Authorization header.
- **FR-028**: The staging external vault adapter MUST implement bounded authenticated read/write/delete/health behavior with one deadline covering response headers and streamed body consumption, distinct material and response-envelope limits, strict content type and schema, retry, redaction, namespace provenance, redirect refusal, and fail-closed readiness. Request limits MUST apply to the exact serialized UTF-8 body sent. Endpoint credentials/query/hash and unsafe egress targets MUST be rejected under a documented deployment policy that supports an explicitly allowlisted private vault without permitting metadata/link-local escape or address re-resolution bypass. Selecting the external driver MUST not silently fall back to memory, a permanently unavailable stub, or an unaudited plaintext transport.
- **FR-029**: A compiled staging boot MUST cover both a fresh database and an existing database whose `schema_migrations` records SePay-only 008 or the prior expanded 008. Migration 008 is frozen; Feature 001 migration 009 must preserve old rows, enforce canonical `TELEGRAM`, create delivery-session/handoff state idempotently, and fail closed with a runbook on case collisions. Additive Feature 001 migration 009a MUST upgrade an already-applied 009 with inactive-session activation and the compensation ledger without rewriting 008/009. The compiled main and worker must pass health/readiness/liveness, onboard a new Telegram customer, accept and settle a signed SePay payment, fulfill, and hand off a usable Mini App delivery notification without test-only identity mocks.

### Security, Policy & Recovery Requirements

- **SR-001**: Raw credentials and provider secrets MUST NOT appear in domain records, telemetry, messages, tickets, exports, webhooks, or error responses. Delivery-session current and previous signing material are a dedicated secret domain and MUST NOT reuse Telegram, Buy Now, SePay, vault, supplier, or any other application/provider key.
- **SR-002**: Payment evidence MUST fail closed when integrity, timestamp freshness, transaction uniqueness, inbound direction, merchant account, exact amount, or Order reference cannot be verified. Invalid or future-skewed transaction timestamps MUST be rejected; late-payment classification MUST use verified `transactedAt` (with a bounded skew), never processing wall-clock alone.
- **SR-003**: Every customer Order, ticket, and Delivery Bundle access MUST enforce object ownership independently of identifier secrecy. Delivery routes MUST NOT trust a client-supplied customer identity header.
- **SR-004**: External request and response payloads MUST have documented serialized size, streamed-envelope size, shape, content type, redirect, timeout, retry, rate, and egress boundaries. Accepted and rejected responses MUST be consumed or cancelled without leaving unbounded streams or reusable secret-bearing redirects.
- **SR-005**: Financial, authorization, supplier, delivery, and manual-review transitions MUST create attributable, immutable audit evidence.
- **SR-006**: The system MUST resume safely after process/worker/database/vault failure without duplicating payment, supplier purchase, asset claim, refund, Delivery Bundle, usable capability, or notification acknowledgement. A failed compensation delete MUST leave a durable, bounded-retry ledger row until the orphan vault reference is deleted. Cleanup rows MUST transition through fenced `PENDING -> DELETING -> CLEANED` ownership with retry backoff; adoption MUST reject a reference owned by `DELETING`. Cleanup failure MUST never erase the only recovery pointer or hot-loop without delay.
- **SR-007**: Only SKUs with recorded resale/transfer permission and product-specific warranty/payment policy MAY be activated.
- **SR-008**: Production launch MUST remain blocked until numeric owner identity, supplier authorization, SePay production setup, warranty/refund policy, operational runbooks, and Telegram policy risk have explicit sign-off.

### Key Entities

- **Customer**: A buyer identified through a Telegram channel identity and bound to their Orders, tickets, and Delivery Bundles.
- **Category**: An active, ordered grouping of products visible to customers.
- **Product**: Authoritative customer-facing identity and description for an offer family.
- **Product Variant**: A sellable duration/delivery/warranty/price option with local or supplier sourcing policy.
- **Order**: Immutable commercial snapshot and lifecycle for one customer purchasing one variant.
- **Payment Intent**: Time-bounded request to pay the exact Order amount through a VietQR representation.
- **Bank Transaction / Payment Evidence**: Provider-observed money movement and the verified/matched evidence derived from it.
- **Discrepancy**: A reviewable mismatch such as partial, over, late, wrong-reference, or unmatched payment.
- **Digital Asset**: An authorized invite/license/key/credential entitlement with lifecycle and vault reference. Finite local stock units enter `RESERVED` under a concrete Order before payment, then upgrade to claim/delivery after settlement.
- **Inventory Reservation**: Time-bounded hold of one concrete Digital Asset (or stock unit) for one unpaid Order, created atomically with the Order and released atomically on cancel/expiry.
- **Supplier Order**: Idempotent upstream provisioning request with explicit uncertain/reconciliation state.
- **Delivery Bundle**: Time-limited, view-once handoff bound to one Customer and one Order.
- **Support Ticket**: Structured customer issue linked to an Order/payment/delivery context.
- **Audit Event**: Immutable actor/action/reason/correlation evidence for sensitive transitions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time customer can reach the correct product within 20 seconds in the seeded usability journey.
- **SC-002**: A customer can reach the VietQR payment screen in no more than four deliberate actions from the main menu on the happy path.
- **SC-003**: At least 95% of catalog/menu interactions receive a useful response within one second under the approved pilot load.
- **SC-004**: When dependencies are healthy, at least 95% of verified paid Orders reach one customer-usable Mini App delivery capability within 60 seconds; crash recovery never acknowledges fulfillment before a durable handoff exists.
- **SC-005**: Replaying the same payment, supplier, fulfillment, or notification event 100 times produces exactly one settlement, supplier purchase, asset allocation, Delivery Bundle, and usable delivery capability.
- **SC-006**: In concurrency tests for the final available asset, zero runs allocate that asset to more than one Order. Under a 20-buyer simultaneous `buyNow → reserve → present payment` load against one asset, exactly one reservation and one Payment Intent exist and the other 19 losers have neither and receive only `NO_STOCK`, `CONTENTION_TIMEOUT`, or `RESERVATION_LOST`.
- **SC-007**: Security scans of domain storage, telemetry, events, support data, and error responses find zero raw delivered credentials or provider secrets.
- **SC-008**: Every seeded partial/over/late/wrong-reference/unmatched payment reaches a traceable discrepancy or documented resolution; none is silently lost or fulfilled.
- **SC-009**: All unauthorized root-admin attempts, including username impersonation, are denied; only the configured numeric identity in the allowed context succeeds.
- **SC-010**: Every buildable FR/SR requirement maps to at least one implementation task and one acceptance/contract/property/integration test before coding begins.
- **SC-011**: Under the approved checkout load, buyers of different variants in the same category can progress concurrently; evidence records checkout p95, peak database-pool occupancy, typed timeout outcomes, and zero orphan Orders or Payment Intents. Buyer read locks remain mutually compatible while concurrent admin update/deactivate is serialized.

## Assumptions

- Customers use Telegram in Vietnamese and pay in VND from a bank application that supports VietQR.
- One retail Order contains one product variant; multi-item cart and split tender are unnecessary for the MVP.
- Product assets are either pre-stocked locally or provisioned through a supplier contract that permits resale/transfer.
- Invite, license, seat, or activation key is preferred; a shared credential is listed only when explicitly authorized.
- Search remains useful without a language model through deterministic keyword/filter behavior.
- Support and finance capabilities may be performed by the sole owner initially, but remain separate capabilities and never become additional root admins.
- Refund execution may require a controlled manual bank operation in the pilot; its request, approval, evidence, and reconciliation remain recorded.

## Out of Scope

- Customer wallet, top-up, cash-out, transfer, or split payment.
- Multi-item cart, coupon/campaign engine, loyalty, referral, A/B testing, or voice AI.
- Autonomous sales/support agent or any AI domain action.
- Zalo/Web channels outside the delivery Mini App, marketplace, or multi-vendor behavior.
- Customer-facing Supplier API details or Reseller API management.
- Selling a SKU without resale/transfer authorization or concealing platform/provider restrictions.

## Dependencies & Launch Gates

- Numeric Telegram `user_id` for the sole root owner mapped to `@Quyenvjp`.
- Production Telegram bot token and webhook configuration.
- VietQR merchant bank identifiers and SePay production authentication/account configuration.
- At least one authorized supplier or approved local stock source with test fixtures.
- Per-SKU authorization, duration, region, delivery, warranty, replacement, and refund policy.
- Vault/secret-manager capability for raw credentials and provider secrets.
- Reconciliation, provider outage, supplier unknown-state, credential leak, replacement/refund, backup, and restore runbooks.
- Explicit production sign-off for Telegram policy risk and all Critical/High security findings.
