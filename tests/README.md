# Test conventions

Test-first is mandatory (Constitution V). Each behavioral test is written before its
implementation and must first fail for the intended reason.

## Layout

| Directory | Purpose | Seam |
|---|---|---|
| `acceptance/` | End-to-end user-story journeys | Telegram update / SePay webhook / delivery HTTP |
| `contract/` | External adapter input/output, error, idempotency, timeout | Port boundaries |
| `integration/` | Multi-module + PostgreSQL behavior (Testcontainers) | Repositories, services |
| `property/` | Invariants over generated inputs (fast-check) | Money, IDs, replay, concurrency |
| `security/` | Redaction, BOLA/ownership, authorization, credential-leak scans | Cross-cutting |
| `performance/` | Pilot-load latency budgets (SC-003/SC-004) | System |
| `fixtures/` | Shared, secret-free test data and signed provider fixtures | — |

## Rules

- No production secret ever enters a fixture or test. Signed provider fixtures use
  throwaway test keys committed only for deterministic verification.
- Integration/acceptance tests requiring PostgreSQL use Testcontainers; they are
  skipped with a clear message when no container runtime is available, and are
  required to pass in CI.
- Naming: `*.test.ts`. One behavior per `it`; describe blocks reference FR/SR ids.
- Prefer the highest useful seam; drop lower only when the higher one cannot express
  the invariant (e.g. property tests for replay/concurrency).

## Running

```bash
npm run test              # all lanes
npm run test:unit         # property + security + contract
npm run test:integration  # Testcontainers-backed
npm run test:acceptance   # user-story journeys
```
