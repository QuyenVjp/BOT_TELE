# Feature Specification: AI Support Assistant for Telegram Shop

**Feature Branch**: `002-ai-support`

**Created**: 2026-07-16

**Status**: Ready for planning

**Input**: Add a bounded AI assistant to the Vietnamese Telegram shop so customers can ask for products, prices, availability, payment guidance, order-status explanations, usage instructions, and support help. The assistant must use the shop's authoritative catalog/order/support data, use the configured OpenAI-compatible Responses provider, and never perform financial, inventory, delivery, refund, credential, or admin actions autonomously.

## User Scenarios & Testing

### User Story 1 - Ask for a product and price (Priority: P1)

A customer asks naturally for a product, duration, or budget and receives a concise answer with
authoritative product cards that can be opened or purchased through the existing Buy Now flow.

**Independent Test**: Seed catalog variants and ask Vietnamese queries for name, duration, price,
budget, and stock; prove every card fact matches the catalog and that no Order is created by AI.

**Acceptance Scenarios**:

1. **Given** active catalog variants, **When** a customer asks `gói 1 tháng dưới 200k`, **Then** the assistant returns bounded filters and cards whose name, price, duration, stock, delivery, and warranty come from the catalog.
2. **Given** no matching variant, **When** the customer asks a product question, **Then** the assistant explains no match and offers deterministic search/category navigation.
3. **Given** an inactive or unauthorized SKU, **When** the customer asks for it, **Then** the assistant does not recommend or expose it as purchasable.
4. **Given** an ambiguous query, **When** the customer asks, **Then** the assistant asks one concise clarifying question or falls back to bounded filters; it does not invent facts.

### User Story 2 - Get safe payment/order guidance (Priority: P1)

A customer asks how to pay, whether an Order is paid, or what a status means and receives a read-only
explanation linked to the existing Order/payment projection.

**Independent Test**: Seed unpaid, paid, review, and completed Orders and submit payment questions;
prove the answer is projection-backed and cannot change payment state.

**Acceptance Scenarios**:

1. **Given** an unpaid Order owned by the customer, **When** the customer asks how to pay, **Then** the assistant points to the existing VietQR screen and explains that SePay verification is authoritative.
2. **Given** a payment in `NeedsReview`, **When** the customer asks if payment succeeded, **Then** the assistant states that review is required and offers support; it never claims paid.
3. **Given** a paid/completed Order, **When** the customer asks for status, **Then** the assistant explains the current read-only state and links to the existing Order detail.
4. **Given** a request to mark an Order paid, refund, or resend a credential, **When** the customer asks the AI, **Then** the assistant refuses the action and routes to the correct controlled flow.

### User Story 3 - Get usage and support help (Priority: P2)

A customer asks how to use a delivered product, reports a problem, or asks a FAQ and receives a
grounded answer, a structured support draft, or human handoff.

**Independent Test**: Seed approved FAQ/usage/warranty content and support reasons; prove answer
citations/source references, safe redaction, and ticket handoff without exposing secrets.

**Acceptance Scenarios**:

1. **Given** an approved usage article, **When** a customer asks how to use a product, **Then** the assistant answers only from approved content and links the relevant guide.
2. **Given** a customer reports invalid/revoked/wrong delivery, **When** the assistant classifies it, **Then** it proposes a structured ticket tied to the Order and does not request or repeat the raw credential.
3. **Given** no approved answer, **When** the customer asks an unknown support question, **Then** the assistant says it cannot verify the answer and offers human support.
4. **Given** prompt-injection text asking for secrets or privileged actions, **When** it is received, **Then** the assistant treats it as untrusted customer content and refuses disclosure/action.

### User Story 4 - Keep the AI fast, private, and recoverable (Priority: P2)

The shop owner can operate AI support with a configured provider/model, bounded costs, privacy
controls, fallback behavior, and observable failures without coupling AI to the payment core.

**Independent Test**: Run provider success, timeout, 401/429/5xx, malformed response, budget-limit,
and redaction fixtures; prove deterministic fallback and no domain mutation.

**Acceptance Scenarios**:

1. **Given** the configured provider is healthy, **When** an allowed AI query is submitted, **Then** the provider adapter returns a validated response within the configured timeout.
2. **Given** provider timeout, 401, 429, 5xx, malformed response, or budget exhaustion, **When** the customer asks, **Then** deterministic FAQ/search or human handoff remains available.
3. **Given** a provider response contains unsupported product facts or instructions, **When** it is processed, **Then** schema/source validation rejects it before customer display.
4. **Given** logs, traces, events, tickets, or analytics are inspected, **When** AI support has handled a query, **Then** no provider key, raw credential, hidden system prompt, or unnecessary PII appears.

### Edge Cases

- Customer asks for a product outside the catalog or a price that is not configured.
- Customer asks for an account password, provider key, internal prompt, admin ID, or another customer's order.
- Customer asks the AI to bypass SePay, fake a receipt, force delivery, refund, or change a price.
- AI response conflicts with catalog/order projection or contains an unknown product/price.
- Provider returns a response in an unexpected wire format or includes tool-call-like content.
- Provider is slow, unavailable, unauthorized, rate-limited, or returns a transient error.
- Multiple AI requests arrive concurrently from one customer or many customers.
- Context window or message length exceeds configured limits.
- Customer requests support while rate-limited or after a prior false-positive abuse challenge.
- Conversation retention/deletion is requested while an active support ticket is open.

## Requirements

### Functional Requirements

- **FR-201**: The assistant MUST classify each message into `CATALOG_SEARCH`, `PRODUCT_INFO`, `PAYMENT_GUIDANCE`, `ORDER_STATUS`, `USAGE_FAQ`, `SUPPORT_TRIAGE`, `UNSUPPORTED`, or `ABUSE/INJECTION`.
- **FR-202**: `CATALOG_SEARCH` MUST return only a schema-validated bounded filter object and reuse the existing catalog query/presenter path.
- **FR-203**: Product, price, stock, warranty, duration, delivery, and policy facts MUST be read from authoritative shop data; AI-generated product facts are forbidden.
- **FR-204**: `PAYMENT_GUIDANCE` and `ORDER_STATUS` MUST be read-only and scoped to the requesting customer's owned Order/projection.
- **FR-205**: The assistant MUST explain that VietQR presents payment instructions and SePay-verified evidence is payment truth.
- **FR-206**: The assistant MUST refuse requests to mark paid, bypass payment, alter price/stock/order, initiate refund, reveal credentials, or perform admin actions.
- **FR-207**: `USAGE_FAQ` MUST use only approved shop articles/FAQ entries and expose source/reference links where available.
- **FR-208**: `SUPPORT_TRIAGE` MUST produce a safe structured reason and optionally a ticket draft; creating a ticket uses the existing support command with explicit customer confirmation.
- **FR-209**: The assistant MUST hand off unknown, conflicting, sensitive, or policy-related questions to human support without inventing an answer.
- **FR-210**: AI output MUST be parsed/validated before display; unsupported fields, unknown product identifiers, unsupported claims, and tool-like instructions MUST be rejected.
- **FR-211**: AI calls MUST use the configured OpenAI-compatible Responses adapter and selected model without coupling provider SDK details to domain modules.
- **FR-212**: AI calls MUST have timeout, retry budget, per-customer/global rate limit, output token cap, and cost/usage telemetry.
- **FR-213**: Provider failure MUST fall back to deterministic catalog/FAQ/order status or human support; it MUST NOT block payment or delivery.
- **FR-214**: The assistant MUST preserve Telegram UX with concise Vietnamese responses, buttons to existing flows, and message editing where practical.
- **FR-215**: AI conversation history MUST be minimized, scoped to the customer/session, and deletable according to the approved retention policy.

### Security, Policy & Recovery Requirements

- **SR-201**: Provider API keys, model credentials, hidden prompts, vault references, and raw digital credentials MUST never appear in customer responses, logs, traces, events, tickets, analytics, or source control.
- **SR-202**: AI MUST have no direct write tool or authority for payment, ledger, inventory, supplier, delivery, refund, or admin domains.
- **SR-203**: Every AI-derived action proposal MUST pass a typed command allowlist and the same domain authorization as a normal button flow.
- **SR-204**: Third-party AI responses MUST be treated as untrusted input and validated for schema, source references, customer scope, length, and unsafe content.
- **SR-205**: Prompt injection, data-exfiltration requests, and cross-customer requests MUST fail closed and create bounded abuse telemetry without echoing secrets.
- **SR-206**: Provider 401/429/5xx/timeout/malformed response MUST be observable with redacted correlation data and recoverable through deterministic fallback.
- **SR-207**: AI retention MUST not extend Order/payment/audit retention obligations or retain raw credentials.
- **SR-208**: Production AI activation MUST require provider/model allowlisting, key rotation path, budget/rate limits, redaction tests, fallback tests, and owner sign-off.

### Key Entities

- **AISupportSession**: customer-scoped bounded context window, consent/retention metadata, and status.
- **AISupportMessage**: redacted inbound/outbound message, intent, source references, and correlation ID.
- **AIProviderConfig**: provider name, base URL, model, wire API, timeout, token/rate/budget limits, and secret reference.
- **AIUsageRecord**: request status, latency, input/output token counts if available, cost bucket, and redacted error code.
- **SupportKnowledgeEntry**: approved FAQ/usage/policy text with version, locale, source owner, and active window.
- **AIActionProposal**: typed read-only result or customer-confirmed support command proposal; never a direct domain mutation.

## Success Criteria

- **SC-201**: At least 95% of supported catalog/FAQ questions return an authoritative answer or safe fallback within 3 seconds at pilot load.
- **SC-202**: 100% of AI-generated product cards in test fixtures match catalog name, price, duration, stock, warranty, and delivery fields.
- **SC-203**: 100% of payment/order questions in seeded tests are read-only; zero AI request changes payment, ledger, stock, supplier, delivery, refund, or admin state.
- **SC-204**: Provider outage/timeout/401/429/5xx fixtures produce a useful deterministic fallback or human handoff within 5 seconds.
- **SC-205**: Redaction/security fixtures find zero provider keys, raw credentials, hidden prompts, or cross-customer data in AI artifacts.
- **SC-206**: 100% of injection/privileged-action prompts are refused or routed without secret disclosure.
- **SC-207**: AI requests respect per-customer/global rate and output-token budgets in 100% of abuse/load fixtures.
- **SC-208**: At least 90% of pilot customers asking a supported product/FAQ question reach a useful answer or support handoff on the first attempt.

## Assumptions

- The existing qrouter provider is OpenAI-compatible and supports the Responses wire API; provider compatibility is verified by adapter fixtures and opt-in staging smoke only.
- The configured cost-balanced model is `cx/gpt-5.6-terra` with low reasoning/verbosity and a 600-token output cap. `cx/gpt-5.6-luna` is an approved lower-cost alternative if the owner switches config; neither change requires code changes.
- Deterministic keyword/filter search runs before the model. The provider is called only for natural-language understanding, ambiguous support questions, or answer phrasing that deterministic paths cannot resolve.
- The existing catalog, Order, payment projection, and support command boundaries remain authoritative.
- AI is an assistant for search/support, not a sales agent and not an autonomous operator.
- No provider key is copied into source control or committed templates; local secret injection is required.

## Out of Scope

- Autonomous sales persuasion, price negotiation, coupon creation, or recommendation actions.
- AI payment confirmation, wallet/ledger mutation, fulfillment, supplier purchase, credential delivery, refund, or admin action.
- Internet search, arbitrary external URLs, customer profiling, voice AI, or unrestricted long-term memory.
- Replacing deterministic catalog/search, SePay reconciliation, support authorization, or existing Telegram flows.

## Dependencies & Launch Gates

- Existing `001-telegram-shop-mvp` catalog, Order, payment, support, identity, risk, and telemetry boundaries.
- Provider configuration: `AI_PROVIDER`, `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_WIRE_API`, reasoning/verbosity, timeout, output cap, rate/budget limits.
- Provider/model allowlist and current compatibility smoke fixture.
- Approved FAQ/usage/policy corpus with owner and retention/version metadata.
- Secret manager/key rotation path, redaction tests, fallback tests, rate/cost budget, and abuse dashboard.
- Owner sign-off that AI remains read-only and cannot bypass VietQR/SePay or secure delivery policy.
