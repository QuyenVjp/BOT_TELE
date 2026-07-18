# Feature Specification: Telegram Shop Digital MVP

**Feature Branch**: `001-telegram-shop-mvp`

**Created**: 2026-07-16

**Status**: Ready for planning

**Input**: Build a customer-first Telegram shop for Vietnamese buyers of authorized digital account/access products. Customers browse or search the shop, see price and terms, buy one variant, pay by VietQR, have the transfer verified by SePay, and receive the product securely. Only the configured numeric Telegram identity mapped to `@Quyenvjp` is root admin.

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

1. **Given** a sellable variant, **When** the customer presses `Mua ngay`, **Then** the shop revalidates the current offer and creates one immutable Order snapshot.
2. **Given** an unpaid Order, **When** payment is presented, **Then** the QR, exact VND amount, unique transfer content, and expiry are clearly shown without requesting a receipt screenshot.
3. **Given** a matching verified inbound transaction, **When** SePay evidence is processed, **Then** the Order becomes paid exactly once.
4. **Given** duplicate or reordered evidence for the same bank transaction, **When** it is processed repeatedly, **Then** payment remains a single settlement with no duplicate downstream effect.
5. **Given** a screenshot, chat message, return URL, or status-refresh action, **When** it is received, **Then** it does not mark the Order paid.
6. **Given** an amount/content/account mismatch, late transfer, underpayment, overpayment, or unmatched deposit, **When** evidence is processed, **Then** the transaction enters a reviewable discrepancy and is not silently fulfilled.

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
- Two customers attempt to buy the final local asset concurrently.
- A customer double-taps `Mua ngay`, refreshes payment rapidly, or replays an old callback.
- A valid transfer arrives exactly as the Payment Intent or reservation expires.
- Several partial transfers together equal the Order amount, or one transfer references two Orders.
- SePay sends an event with valid transport but invalid signature, stale timestamp, wrong account, or outbound direction.
- SePay webhook delivery is missing while reconciliation later finds the transaction.
- Payment is verified but local stock and supplier stock both become unavailable.
- Supplier returns success with a malformed/duplicate/revoked asset or times out after creating the upstream order.
- A Delivery Bundle expires before first view, is opened concurrently, or is requested by another customer.
- The bot, worker, database connection, cache, or supplier is unavailable and later recovers.
- A blocked/rate-limited customer still needs access to a paid Order or support recovery path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The shop MUST present a Vietnamese retail menu containing only catalog, search, Order history, and support actions.
- **FR-002**: The shop MUST list only active categories and sellable product variants in stable, paginated order.
- **FR-003**: Product detail MUST show VND price, duration, availability, delivery type, expected delivery, warranty, and usage conditions before purchase.
- **FR-004**: The shop MUST provide deterministic search by product/category/alias and MAY parse natural-language queries only into an allowlisted filter set.
- **FR-005**: All displayed product facts MUST originate from the authoritative catalog; generated text MUST NOT create or override a product fact.
- **FR-006**: `Mua ngay` MUST revalidate the selected variant, current price, active state, stock policy, and resale eligibility before creating one Order.
- **FR-007**: Each Order MUST contain an immutable snapshot of product/variant name, price, duration, delivery type, warranty, and applicable policy.
- **FR-008**: Each unpaid retail Order MUST have at most one active VietQR payment request with exact integer VND amount, unique transfer content, and expiry.
- **FR-009**: A Payment Intent MUST become settled only from verified, matched SePay transaction evidence.
- **FR-010**: Duplicate and reordered Telegram, SePay, worker, and supplier inputs MUST be idempotent.
- **FR-011**: Payment discrepancies MUST preserve the bank transaction, reason, Order mapping candidates, and review status without automatic fulfillment.
- **FR-012**: Reconciliation MUST recover valid missing payment events and surface unresolved mismatches with an owner and SLA.
- **FR-013**: Fulfillment MUST begin only after the related Order has verified payment.
- **FR-014**: A local digital asset MUST be allocated to at most one active Order using an atomic claim.
- **FR-015**: Supplier creation MUST be idempotent; uncertain results MUST be queried/reconciled before retry.
- **FR-016**: Supplier output MUST be validated for expected SKU/type, uniqueness, expiry/duration, region, and usability before delivery.
- **FR-017**: Every delivered secret/entitlement MUST use a customer-and-Order-bound Delivery Bundle with expiry and view-once behavior.
- **FR-018**: Customers MUST be able to view only their own paginated Order history and relevant payment/fulfillment/support states.
- **FR-019**: Customers MUST be able to create a structured support ticket linked to an Order without resubmitting the delivered secret.
- **FR-020**: The system MUST support recorded warranty replacement/refund review without rewriting the original Order or delivery history.
- **FR-021**: The root-admin capability MUST authorize only the configured numeric Telegram identity mapped to `@Quyenvjp` in the allowed context.
- **FR-022**: The system MUST NOT expose a command or flow that adds another root administrator.
- **FR-023**: High-risk owner actions MUST require explicit confirmation, idempotency, reason, and immutable audit evidence.
- **FR-024**: The system MUST provide user/action-specific abuse controls while preserving an authenticated recovery route for paid Orders and support.

### Security, Policy & Recovery Requirements

- **SR-001**: Raw credentials and provider secrets MUST NOT appear in domain records, telemetry, messages, tickets, exports, webhooks, or error responses.
- **SR-002**: Payment evidence MUST fail closed when integrity, timestamp freshness, transaction uniqueness, inbound direction, merchant account, exact amount, or Order reference cannot be verified.
- **SR-003**: Every customer Order, ticket, and Delivery Bundle access MUST enforce object ownership independently of identifier secrecy.
- **SR-004**: External request and response payloads MUST have documented size, shape, timeout, retry, and rate boundaries.
- **SR-005**: Financial, authorization, supplier, delivery, and manual-review transitions MUST create attributable, immutable audit evidence.
- **SR-006**: The system MUST resume safely after process/worker failure without duplicating payment, supplier purchase, asset claim, refund, or delivery.
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
- **Digital Asset**: An authorized invite/license/key/credential entitlement with lifecycle and vault reference.
- **Supplier Order**: Idempotent upstream provisioning request with explicit uncertain/reconciliation state.
- **Delivery Bundle**: Time-limited, view-once handoff bound to one Customer and one Order.
- **Support Ticket**: Structured customer issue linked to an Order/payment/delivery context.
- **Audit Event**: Immutable actor/action/reason/correlation evidence for sensitive transitions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time customer can reach the correct product within 20 seconds in the seeded usability journey.
- **SC-002**: A customer can reach the VietQR payment screen in no more than four deliberate actions from the main menu on the happy path.
- **SC-003**: At least 95% of catalog/menu interactions receive a useful response within one second under the approved pilot load.
- **SC-004**: When dependencies are healthy, at least 95% of verified paid Orders reach a usable Delivery Bundle within 60 seconds.
- **SC-005**: Replaying the same payment or supplier event 100 times produces exactly one settlement, supplier purchase, asset allocation, and Delivery Bundle.
- **SC-006**: In concurrency tests for the final available asset, zero runs allocate that asset to more than one Order.
- **SC-007**: Security scans of domain storage, telemetry, events, support data, and error responses find zero raw delivered credentials or provider secrets.
- **SC-008**: Every seeded partial/over/late/wrong-reference/unmatched payment reaches a traceable discrepancy or documented resolution; none is silently lost or fulfilled.
- **SC-009**: All unauthorized root-admin attempts, including username impersonation, are denied; only the configured numeric identity in the allowed context succeeds.
- **SC-010**: Every buildable FR/SR requirement maps to at least one implementation task and one acceptance/contract/property/integration test before coding begins.

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
- Mandatory Mini App, Zalo/Web channels, marketplace, or multi-vendor behavior.
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
