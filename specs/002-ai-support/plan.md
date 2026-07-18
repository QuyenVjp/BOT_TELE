# Implementation Plan: AI Support Assistant for Telegram Shop

**Branch**: `002-ai-support` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

## Summary

Add an AI-support application layer around existing catalog, Order/payment projection, FAQ, and
support commands. The provider adapter speaks the configured OpenAI-compatible Responses wire API
(`https://qrouter.online/v1`, model `cx/gpt-5.6-terra`) through an environment-backed secret. The AI
layer returns typed, source-grounded read-only answers; domain mutation remains behind existing
commands and permissions. Provider failure falls back to deterministic flows.

## Technical Context

**Language/Version**: Existing Node.js 24 LTS + TypeScript strict

**Primary Dependencies**: Existing Fastify/grammY/Zod/Kysely/Vitest stack; native `fetch` or a
small OpenAI-compatible Responses adapter; do not import provider SDK into domain modules

**Storage**: PostgreSQL for redacted session/message/usage/source metadata; no raw credential or
provider secret persistence; Redis only for ephemeral rate/budget counters

**Testing**: Vitest contract/property/integration/acceptance tests with mocked provider fixtures;
one opt-in staging smoke test against qrouter that never runs in CI and never logs key/response secrets

**Target Platform**: Existing Telegram webhook + worker deployment

**Project Type**: Application module and provider adapter added to the current modular monolith

**Performance Goals**: p95 supported answer/fallback under 3 seconds; hard request timeout 30s;
fallback under 5 seconds; configured output cap 600 tokens; 20 requests/customer/minute baseline

**Constraints**: Read-only AI; source-grounded facts; Vietnamese copy; customer object scope;
provider/model allowlist; no raw key in source/logs; no new direct domain side effects

**Scale/Scope**: Pilot 1,000 DAU, 20 concurrent AI requests, bounded 8-message context window;
budget/rate settings remain configuration, not hidden behavior

## Constitution Check

| Gate | Status | Evidence |
|---|---|---|
| Customer-first scope | PASS | AI assists existing search/support; no new sales platform |
| Verified payment truth | PASS | AI reads payment projection only; cannot mark paid |
| Secrets/sole admin | PASS | API key env/secret manager only; no admin tools |
| Contract-first | PASS | provider, grounding, safety, and Telegram contracts |
| Test-first recovery | PASS | provider failure/injection/redaction/fallback tests precede implementation |
| No policy bypass | PASS | AI cannot bypass VietQR/SePay, delivery, or supplier rules |
| Launch gate | PASS WITH GATE | qrouter compatibility/key rotation/budget/owner sign-off required |

## Architecture and boundaries

```text
Telegram message
  → intent classifier (deterministic first)
  → AI Support Application Service
       ├─ Catalog Read Port → authoritative cards
       ├─ Order/Payment Read Port → scoped projection
       ├─ Knowledge Read Port → approved FAQ/usage/policy
       ├─ Safety Policy → allow/deny/hand-off
       └─ AI Provider Port → qrouter Responses adapter
  → typed Vietnamese answer + existing buttons
```

Deterministic search/FAQ/status rules run first; the model is called only when language understanding
or safe phrasing adds value. The AI provider never receives raw credentials, payment secrets, full bank payloads, internal
prompts, or unrestricted database access. An `AIActionProposal` may request an existing read-only
query or customer-confirmed support command, but the AI service cannot invoke domain writes itself.

## Source Code Structure

```text
src/modules/ai-support/
├── domain.ts
├── intent.ts
├── service.ts
├── grounding.ts
├── safety.ts
├── fallback.ts
├── provider-port.ts
├── provider-qrouter.ts
├── usage.ts
├── repository.ts
└── telemetry.ts
src/config/env.ts
src/config/ai.ts
src/bot/callbacks/ai-support.ts
src/bot/presenters/ai-support.ts
src/infrastructure/db/migrations/011_ai_support.sql
tests/contract/ai-provider.test.ts
tests/contract/ai-safety.test.ts
tests/integration/ai-support-service.test.ts
tests/property/ai-grounding.test.ts
tests/acceptance/ai-support-journey.test.ts
tests/security/ai-redaction.test.ts
```

## Delivery Phases

1. Config/provider contract and redacted health check.
2. Intent, grounding, safety, and deterministic fallback.
3. Read-only catalog/order/FAQ answer service and Telegram UX.
4. Session/usage persistence, rate/budget telemetry, and support handoff.
5. Security/replay/abuse/latency tests and opt-in qrouter staging smoke.

## Complexity Tracking

No new framework or autonomous agent is justified. If qrouter compatibility is insufficient, keep
the provider port and use a fixture adapter; do not widen the AI authority or add a second provider
until a separate feature spec is approved.
