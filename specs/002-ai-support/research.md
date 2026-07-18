# Research: AI Support Assistant

## Decision 1: OpenAI-compatible Responses adapter, not provider SDK in domain

**Decision**: Implement a narrow HTTP provider port targeting the configured qrouter OpenAI-compatible
Responses endpoint. Keep base URL, model, wire API, timeouts, limits, and secret injection in config.

**Rationale**: The current host config selects `9router`, `https://qrouter.online/v1`, `responses`,
and the owner-selected cost-balanced model `cx/gpt-5.6-terra`. Both `cx/gpt-5.6-terra` and
`cx/gpt-5.6-luna` were present in the provider model list. A port makes the feature testable with fixtures and replaceable without coupling
catalog/payment/support domains to a provider SDK.

**Verification**: The configured provider returned HTTP 200 for `/v1/models` and listed the selected
model in the current environment. This is an environment smoke signal, not production approval.

**Sources**:

- https://platform.openai.com/docs/api-reference/responses
- https://platform.openai.com/docs/guides/text
- User-provided host routing config (secret value intentionally not copied into this document)

## Decision 2: Ground answers in authoritative read ports

**Decision**: AI may phrase answers, but catalog facts, prices, stock, Order/payment status, FAQ,
usage, and policy content come from typed read ports with source IDs.

**Rationale**: This prevents hallucinated product offers and keeps the existing payment/order source
of truth. Source references enable audit and conflict detection.

**Alternatives considered**: `cx/gpt-5.6-luna` remains an approved lower-cost config alternative.
The higher-capability model is unnecessary for bounded product filtering and FAQ phrasing.
Free-form answers, internet search, and model-owned catalog memory remain rejected.

## Decision 3: Read-only safety boundary

**Decision**: No AI tool can mark paid, change price/stock, reserve asset, call supplier, deliver
credential, refund, mutate ledger, or perform admin action. Support ticket creation requires the
existing customer-confirmed command.

**Rationale**: Prompt injection and model mistakes must not cross financial or secret boundaries.

**Sources**:

- https://owasp.org/www-project-top-10-for-large-language-model-applications/
- https://owasp.org/API-Security/editions/2023/en/0x11-t10/

## Decision 4: Deterministic fallback and bounded cost

**Decision**: Intent/rules/catalog filters run before model calls. Timeout, 401, 429, 5xx, malformed
response, budget, or safety failure falls back to deterministic search/FAQ/order status or human handoff.

**Rationale**: Payment and support remain available when AI is unavailable, and abuse cannot create
unbounded provider spend.

## Decision 5: Privacy-minimized session memory

**Decision**: Retain only redacted bounded context and source metadata; never persist raw digital
credential, API key, bank payload, hidden prompt, or unnecessary PII. Allow deletion under policy.

**Rationale**: Support usefulness does not require long-term unrestricted conversation memory.
