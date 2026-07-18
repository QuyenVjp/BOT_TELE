# Tasks: AI Support Assistant for Telegram Shop

**Input**: Design documents from `specs/002-ai-support/`

**Prerequisites**: `001-telegram-shop-mvp` payment/order/catalog/support read boundaries stable; plan, research, data-model, contracts, checklists, quickstart.

**Tests**: REQUIRED before implementation per project Constitution.

## Phase 1: Setup and Configuration Contract

- [ ] T201 Add AI provider/support environment keys, safe defaults, allowlisted enums, and production fail-closed validation in `src/config/env.ts` and `src/config/ai.ts`
- [ ] T202 [P] Add redacted AI config diagnostics and secret-scan fixtures in `tests/security/ai-config-redaction.test.ts`
- [ ] T203 [P] Define provider/model/wire/timeout/budget types and stable errors in `src/modules/ai-support/provider-port.ts`
- [ ] T204 Add AI config and launch-gate documentation to `docs/04-security/AI_SUPPORT_POLICY.md` and `specs/002-ai-support/launch-gates.md`

## Phase 2: Provider Adapter and Failure Boundary

- [ ] T205 [P] Write failing OpenAI-compatible Responses request/response schema tests using fixtures in `tests/contract/ai-provider.test.ts`
- [ ] T206 [P] Write failing provider timeout/401/429/5xx/malformed/budget error tests in `tests/integration/ai-provider-failures.test.ts`
- [ ] T207 Implement qrouter/OpenAI-compatible Responses HTTP adapter with bounded timeout, retry policy, model allowlist, and no secret logging in `src/modules/ai-support/provider-qrouter.ts`
- [ ] T208 Implement fake provider adapter used by CI/acceptance tests in `src/modules/ai-support/provider-fake.ts`
- [ ] T209 Implement provider health/latency/error telemetry with redacted correlation IDs in `src/modules/ai-support/telemetry.ts`
- [ ] T210 Add opt-in staging-only live smoke command that prints status/latency only in `scripts/ai-provider-smoke.mjs`

## Phase 3: Intent, Grounding, and Safety

- [ ] T211 [P] Write failing intent classification/filter-schema/property tests for FR-201/FR-202 in `tests/contract/ai-intent.test.ts`
- [ ] T212 [P] Write failing grounding tests proving product/price/stock/warranty/delivery facts match source data in `tests/property/ai-grounding.test.ts`
- [ ] T213 [P] Write failing injection/privileged-action/cross-customer refusal tests for SR-202–SR-205 in `tests/security/ai-safety.test.ts`
- [ ] T214 Define typed intent, answer envelope, action proposal, source reference, confidence, and safety result in `src/modules/ai-support/domain.ts`
- [ ] T215 Implement deterministic-first intent classifier and bounded filter parser in `src/modules/ai-support/intent.ts`
- [ ] T216 Implement catalog/order/payment/knowledge read-port grounding with customer ownership checks in `src/modules/ai-support/grounding.ts`
- [ ] T217 Implement safety policy, redaction, forbidden-capability guard, and injection refusal in `src/modules/ai-support/safety.ts`
- [ ] T218 Implement source-aware answer validation that rejects unsupported facts/tool-like instructions in `src/modules/ai-support/answer-validator.ts`
- [ ] T219 Implement deterministic search/FAQ/order-status fallback and human-handoff result in `src/modules/ai-support/fallback.ts`

## Phase 4: Customer AI Support Service and Telegram UX

- [ ] T220 [P] Write failing AI service integration tests for catalog, payment guidance, order status, usage FAQ, triage, unsupported, and handoff intents in `tests/integration/ai-support-service.test.ts`
- [ ] T221 [P] Write failing Telegram acceptance tests for search/support entry points, buttons, Vietnamese copy, loading, fallback, and existing-flow deep links in `tests/acceptance/ai-support-journey.test.ts`
- [ ] T222 Implement AI Support application service that composes intent, grounding, safety, provider, validator, and fallback without domain write access in `src/modules/ai-support/service.ts`
- [ ] T223 Implement AIActionProposal and explicit customer-confirmed support ticket handoff through existing support command in `src/modules/ai-support/actions.ts`
- [ ] T224 Implement Vietnamese AI support presenters, source links, safe refusal, fallback, and handoff copy in `src/bot/presenters/ai-support.ts`
- [ ] T225 Implement search/support AI callbacks and existing catalog/Order/support deep links in `src/bot/callbacks/ai-support.ts`
- [ ] T226 Add AI loading/cooldown/error message editing and rate-limit recovery without blocking Order history/support in `src/bot/middleware/ai-support.ts`

## Phase 5: Session, Usage, Privacy, and Cost Controls

- [ ] T227 [P] Write failing bounded-session retention/deletion and PII-redaction tests for FR-215/SR-207 in `tests/security/ai-retention.test.ts`
- [ ] T228 [P] Write failing per-customer/global rate, token cap, budget bucket, and concurrent-request tests for FR-212/SC-207 in `tests/property/ai-budget.test.ts`
- [ ] T229 Implement AISupportSession/AISupportMessage/AIUsageRecord/SupportKnowledgeEntry migrations in `src/infrastructure/db/migrations/011_ai_support.sql`
- [ ] T230 Implement session/message/knowledge/usage repository with bounded context and deletion policy in `src/modules/ai-support/repository.ts`
- [ ] T231 Implement rate-limit, token/output cap, budget bucket, and provider circuit state in `src/modules/ai-support/usage.ts`
- [ ] T232 Implement redacted structured logging and usage metrics for intent/source/provider/fallback outcomes in `src/modules/ai-support/telemetry.ts`
- [ ] T233 Add approved FAQ/usage/payment/warranty seed fixtures with owner/version/source metadata in `src/infrastructure/db/seeds/ai-knowledge.ts`

## Phase 6: Security, Performance, and Release Evidence

- [ ] T234 [P] Write failing whole-artifact secret scan across DB/log/trace/event/ticket/output fixtures for SR-201/SC-205 in `tests/security/ai-redaction.test.ts`
- [ ] T235 [P] Add AI BOLA tests proving another customer's Order/payment/Delivery Bundle is never grounded in `tests/security/ai-bola.test.ts`
- [ ] T236 [P] Add pilot latency/load tests for SC-201/SC-204 in `tests/performance/ai-support-load.test.ts`
- [ ] T237 [P] Add prompt-injection corpus and refusal regression fixtures in `tests/security/ai-injection-regression.test.ts`
- [ ] T238 Run the offline quickstart matrix and record results in `specs/002-ai-support/evidence/quickstart.md`
- [ ] T239 Run opt-in qrouter staging smoke with redacted output and record status/model/latency only in `specs/002-ai-support/evidence/provider-smoke.md`
- [ ] T240 Update `docs/04-security/THREAT_MODEL.md` with AI prompt-injection, data-exfiltration, provider, and cost-abuse controls
- [ ] T241 Update `docs/06-operations/RECONCILIATION_RUNBOOK.md` or linked AI support runbook with provider outage, budget, fallback, and handoff procedures
- [ ] T242 Run Spec Kit analysis and resolve all Critical/High findings in `specs/002-ai-support/analysis.md`
- [ ] T243 Run independent security/code review and record residual risks in `specs/002-ai-support/review.md`
- [ ] T244 Obtain owner sign-off for provider/model allowlist, key rotation, budget/rate limits, redaction, fallback, and read-only AI authority in `specs/002-ai-support/launch-gates.md`

## Dependencies and checkpoints

- T201–T204 precede provider and service implementation.
- T205–T210 establish provider/failure behavior before T222.
- T211–T219 establish grounding/safety before any customer AI UX.
- T220–T226 implement the first independently testable AI customer journey.
- T227–T233 add persistence/cost controls after service boundaries are stable.
- T234–T244 are release gates; live provider smoke is opt-in and never required for CI.
- No task may grant AI a direct write tool or bypass existing payment/Order/delivery commands.

## Format validation

- Total tasks: 44 (`T201`–`T244`).
- Every task has checkbox, ID, action, and exact path.
- Tests precede their corresponding implementation tasks.
