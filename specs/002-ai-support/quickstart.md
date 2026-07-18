# Quickstart Validation: AI Support Assistant

## Offline/CI lanes

1. Load a fake provider adapter; never require a live key in CI.
2. Seed catalog, Order projections, approved FAQ/usage entries, and two customers.
3. Run intent/schema, grounding, safety, fallback, BOLA, redaction, rate, budget, and latency fixtures.

Expected: every response is typed, source-grounded, Vietnamese-safe, and read-only.

## Provider contract smoke

Opt-in staging only:

```text
AI_SUPPORT_LIVE_SMOKE=1
AI_API_BASE_URL=https://qrouter.online/v1
AI_MODEL=cx/gpt-5.6-terra
```

The smoke must load `AI_API_KEY` from the secret manager/environment, call a harmless catalog-support
question, print only status/latency/model availability, and never log request, response, key, hidden
instructions, or customer data. A provider 401/429/5xx/timeout is a test result that must exercise fallback.

## Acceptance matrix

- Product query under budget → catalog cards from DB.
- Payment status query → projection-backed answer, no mutation.
- FAQ/usage query → approved source reference.
- Unknown/sensitive/injection query → refusal or human handoff.
- Provider unavailable/malformed → deterministic fallback.
- Concurrent/rate-limit/budget cases → bounded safe response.
- Log/trace/event/ticket scan → zero provider key/raw credential/hidden prompt.
