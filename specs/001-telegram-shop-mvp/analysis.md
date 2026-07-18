# Implementation Re-analysis Status — REOPENED

The 2026-07-16 independent source review found unresolved Critical/High implementation and evidence
gaps. The previous post-implementation conclusion is no longer valid. See
[`remediation-review.md`](./remediation-review.md) and open tasks T115–T153 in `tasks.md`.

---

# Specification Analysis Report

**Date**: 2026-07-16  
**Scope**: `spec.md`, `plan.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`, and Constitution 1.0.0  
**Mode**: Final pre-code cross-artifact analysis

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|---|---|---:|---|---|---|
| A1 | External dependency | LOW | spec.md §Dependencies; plan.md §Technical Context | Exact supplier and production credentials are intentionally unknown. | Keep as production launch gates; use sandbox/test adapters until dated owner sign-off. |
| A2 | Policy dependency | LOW | spec.md §SR-008; research.md Decision 8 | Telegram policy acceptance is not an engineering fact the project can self-certify. | Preserve the explicit launch gate and do not claim or disguise compliance. |
| A3 | Scale assumption | LOW | plan.md §Technical Context | Pilot scale is an engineering baseline rather than measured production demand. | Retain conservative baseline and tune only from T104 evidence. |

No Critical, High, or Medium inconsistency, ambiguity, constitution violation, or uncovered buildable requirement remains.

## Coverage Summary

| Requirement group | Count | Has tasks/tests? | Notes |
|---|---:|---|---|
| Functional Requirements FR-001–FR-024 | 24 | Yes | Mapped in `traceability.md` |
| Security/Policy Requirements SR-001–SR-008 | 8 | Yes | Contract/security/recovery tasks precede implementation |
| Success Criteria SC-001–SC-010 | 10 | Yes | Each has test or evidence task |
| User Stories US1–US5 | 5 | Yes | Independent acceptance seam and phase for each |

## Constitution Alignment

- Customer-first retail scope: aligned; wallet, top-up, cart, reseller controls, growth AI are out of scope.
- Verified payment truth: aligned; VietQR initiation and SePay evidence/reconciliation are separate.
- Exactly-once effects: aligned through inbox/outbox, unique keys, idempotency, concurrency tests, and recovery states.
- Secrets/identity: aligned through vault-only material, one-time delivery, BOLA tests, and numeric sole-admin rules.
- Contract-first domains: aligned through explicit state/data model and five interface contracts.
- Test-first operations: aligned; every story lists failing tests before implementation and final restore/reconciliation drills.

## Unmapped Tasks

No orphan implementation task was found. Cross-cutting T101–T114 implement Constitution-required
traceability, security, operations, performance, restore, review, and production sign-off gates.

## Metrics

- Total buildable requirements/outcomes: 42
- Total tasks: 114
- Requirements with one or more task/test mappings: 42
- Coverage: 100%
- Ambiguity count: 0
- Duplication count: 0 material duplicates
- Critical issues: 0
- High issues: 0
- Medium issues: 0
- Low observations: 3

## Decision

The artifacts are ready for implementation planning handoff, but production activation remains
blocked by the dated launch inputs in spec.md. `$speckit-implement` may begin only when the owner
explicitly requests coding; this task intentionally stops before source-code implementation.

---

## Post-implementation re-analysis (T113, 2026-07-16)

**Mode**: Cross-artifact re-check after Phases 1–8 implementation.

### Findings

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| A1 | External dependency | LOW | launch-gates.md G2/G3/G6 | Real supplier/SePay/vault credentials remain unknown | Open launch gate; sandbox/test adapters remain in place |
| A2 | Policy dependency | LOW | launch-gates.md G5; TELEGRAM_POLICY_RISK.md | Telegram digital-goods policy acceptance is not self-certifiable | Open launch gate; risk is not concealed |
| A3 | Scale assumption | LOW | evidence (pilot-load) | Pilot percentiles measured on containerized Postgres, not production infra | Open; retune only from production-sized load |
| A4 | Ops drill | LOW | evidence/restore.md | Production-sized restore with managed PITR not yet executed | Open launch gate G8 |

No Critical, High, or Medium inconsistency, ambiguity, constitution violation, or uncovered
buildable requirement remains after implementation. The Low items are the same class of launch
inputs that were already open pre-code; none is a design contradiction.

### Coverage re-check

| Group | Count | Implemented? | Notes |
|---|---:|---|---|
| FR-001–FR-024 | 24 | Yes | All mapped tests green; see `traceability.md` post-impl section |
| SR-001–SR-008 | 8 | Yes (code) / partial (launch) | SR-008 remains a process gate by design |
| SC-001–SC-010 | 10 | Yes | SC-003/SC-004 measured; SC-010 = this analysis |
| US1–US5 | 5 | Yes | Independent acceptance + evidence file each |

### Historical implementation metrics — withdrawn

The earlier completed-task and automated-test counts have been removed because the follow-up review
proved they were not final-source acceptance evidence. No replacement count is recorded until the
2026-07-17 remediation gate runs on the final source.

---

## Gate 0 re-analysis (review remediation, 2026-07-17)

**Mode**: Cross-artifact analysis after the reviewer returned T154–T157 to RED. Updated artifacts are
`spec.md`, `plan.md`, `data-model.md`, `contracts/application-commands.md`, all checklists, and
`tasks.md`. This is the read-only `$speckit-analyze` decision used before remediation implementation.

### Constitution alignment

- Principle IV already names **Inventory Reservation** as a first-class domain with explicit
  transitions. The prior code violated it by minting a Payment Intent before reserving stock. The
  spec/data-model updates (FR-006a–d, Inventory Reservation section) restore alignment WITHOUT
  weakening the constitution — no principle was lowered to fit a skeleton.
- Principle II (verified payment truth) is reinforced by FR-009's branded-evidence requirement.
- Principle V (test-first recovery) is preserved: T154 carries the failing integration matrix before
  T156/T157 implementation, and T155 remains a direct acceptance lane.

### Findings

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| R1 | Typed stock contract | RESOLVED-IN-DESIGN | spec §FR-006a–b; application commands BuyNow | New output is only `NO_STOCK`, `CONTENTION_TIMEOUT`, `RESERVATION_LOST`; `OUT_OF_STOCK` is internal/deprecated only | T154–T157 reopened |
| R2 | Supplier money safety | RESOLVED-IN-DESIGN | spec §FR-002/FR-006e; data-model stock-policy table | Feature 001 hides and payment-blocks `SUPPLIER_ONLY`; supplier fulfillment remains future mandatory work | T142/T143 + FUT-002 remain open |
| R3 | Presenter truth | RESOLVED-IN-DESIGN | spec §FR-006b; application commands BuyNow | One typed message, only routed actions, no fake notify and no duplicate callbacks with different labels | T154/T157 reopened |
| R4 | Replacement correctness | RESOLVED-IN-DESIGN | spec §FR-014/FR-020; data-model active-vs-history | Active `RESERVED/READY` and delivered history are separate deterministic queries | T154/T157 reopened |
| R5 | Locking/load | RESOLVED-IN-DESIGN | spec §SC-011; plan Complexity Tracking | Shared buyer locks, admin serialization, transaction-level retry, p95/pool/orphan evidence specified | T154/T156 reopened |
| R6 | TTL validation | RESOLVED-IN-DESIGN | tasks T154/T156; bounded Order TTL | Non-finite, negative, excessive, and fractional TTL cases have explicit test/implementation scope | T154/T156 reopened |
| R7 | Idempotency | RESOLVED-IN-SPEC | spec §FR-006d; contracts BuyNow | Stable signed nonce + `ON CONFLICT` winner-read specified | T158–T160 remain untouched |
| R8 | Outbox/recovery | RESOLVED-IN-SPEC | spec §FR-025–026; superseded mapping | Historical T130/T132/T133/T134 no longer inflate progress; canonical work is T161/T162/T167/T168 | Open canonical tasks |
| R9 | Evidence provenance | OPEN (environment) | plan Runtime evidence; tasks T151–T153 | `.git` is invalid, so Docker proof is local only and cannot be SHA-bound CI proof | Keep REQUEST_CHANGES |

### Coverage summary

| Requirement group | Count | Has task/test? |
|---|---:|---|
| FR-001–FR-027 (incl. FR-006a–e, FR-025–027) | 32 | Yes |
| SR-001–SR-008 | 8 | Yes |
| SC-001–SC-011 | 11 | Yes |
| T154–T157 reviewer remediation invariants | 7 groups | Yes (T154–T157) |

### Metrics

- Critical issues (cross-artifact design/spec): 0
- High issues (cross-artifact design/spec): 0
- T154–T157 status: acceptance gate passed locally on final source (333 tests / 64 files on host and
  Node 24.18.0 container); this is not SHA-bound CI proof
- Environment residual: invalid git means no SHA-bound CI provenance; local Docker proof stays local

### Decision

Artifacts are internally consistent for the remediation slice and do not weaken the constitution.
The statement below was the T154–T157 checkpoint and is superseded by the dated Gate 0
synchronization that follows: `$speckit-implement` stopped before T158 for reviewer re-check after a
333-test / 64-file local gate.

## Gate 0 synchronization after T158–T160 (2026-07-17)

**Mode**: Superseding cross-artifact re-analysis after the T158–T160 independent review and Gate 0
corrections. The current task truth is **129 checked / 42 open / 171 rows**. Feature 001 remains
`REQUEST_CHANGES`.

### Findings

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| G01 | Status drift | HIGH | `analysis.md`, `traceability.md`, `review.md`, `tasks.md`, remediation evidence | Historical sections described T158–T160 as untouched and selected T161 as the next slice | Resolved by dated superseding sections; canonical next slice is T121/T126 |
| G02 | Bot authorization boundary | HIGH | `src/bot/callbacks/checkout.ts` | The exported bot adapter exposed unsigned `buyNow(customerId, ...)` beside the signed Telegram route | Resolved; production adapter exports only `buyNowFromCallback`, and the boundary test proves no unsigned entrypoint |
| G03 | Callback key configuration | HIGH | `src/config/env.ts`, `src/config/index.ts`, `.env.example` | Production accepted the documented placeholder, cross-domain key reuse, and unbounded positive TTL | Resolved with production-only placeholder/reuse rejection, a 24-hour TTL ceiling, secret-safe diagnostics, and honest single-active-key rotation documentation |
| G04 | Migration ordering | HIGH | Feature 001/002/003 plans and tasks | Planned Feature 002/003 migrations reused deployed `002_*`/`003_*` prefixes and collided with Phase 10 | Superseded: append-only plan is `004`–`008`, Feature 001 `009_identity_delivery_security`, Feature 003 `010_notifications_quantity`, then Feature 002 `011_ai_support` |
| G05 | Provenance | ENVIRONMENT | workspace `.git` | Local evidence cannot be attached to a commit or CI run because `.git` is not a valid repository | Open launch gate; no SHA/CI claim |

### Verification and decision

- Focused RED: 6 expected failures across the unsigned boundary, placeholder, key reuse, and TTL
  cases before source changes.
- Focused GREEN: 12/12 security/config tests and 16/16 affected checkout integration tests.
- Current host full gate: **361/361 tests across 68/68 files**, Node `20.19.0`, Docker context
  `desktop-linux`, Docker server `29.2.1`; typecheck, lint, format check, secret scan, build, and
  production audit all exited 0; production audit found 0 vulnerabilities.
- The older Node 24.18.0 container evidence is preserved as historical local evidence and was not
  rerun by this Gate 0 pass.
- Cross-artifact Critical issues: **0**. Cross-artifact High issues after the corrections above:
  **0**.

Gate 0 is synchronized and permits the canonical TDD slice **T121 then T126**. This does not approve
Feature 001 and does not establish production or pilot readiness; open Phase 9/10 implementation,
independent review, launch inputs, valid Git/SHA provenance, and CI remain required.

## T121/T126 post-implementation re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| I01 | Durable ingress | RESOLVED | webhook, inbox repository, migration, integration test | HTTP commits a bounded envelope before ack; DB failure is retryable; exact duplicate and hash mutation are distinct | T121/T126 complete locally |
| I02 | Concurrency/recovery | RESOLVED | `telegram.ts`, Testcontainers matrix | Bounded SKIP LOCKED claims, owner+generation fencing, throttle/handler retry, attempt budget, dead-letter, retention, and safe backlog telemetry are proven | T121/T126 complete locally |
| I03 | Abuse control | RESOLVED | risk service, worker processor tests | PostgreSQL budgets are atomic across instances and isolate every allowlisted action including catalog/unknown/support/paid recovery | T121/T126 complete locally |
| I04 | Private context | RESOLVED | webhook normalization and HTTP tests | Message and callback-query chat context must be private; actor/update/body/callback bounds fail safely | T121/T126 complete locally |
| I05 | Dispatcher composition | OPEN (owned task) | T125/T129 | The slice exposes the asynchronous envelope handler boundary but intentionally does not adopt the full grammY/domain callback dispatcher | Continue T122/T127, then payment/callback order |

The four-angle Harness manual review accepted and fixed four pre-approval findings: callback-query
group-context bypass, non-durable hash-mutation evidence, catalog/unknown rate-limit bypass, and
permissive/no-op HTTP composition plus missing retention/telemetry. Final slice review has **0
Critical / 0 Major**. Host and Node 24 each pass **371/371 tests across 69/69 files** and all required
static/build/secret/production-audit gates. Feature 001 remains `REQUEST_CHANGES`; canonical next
slice is T122/T127.

## T122/T127 verified SePay ingress re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| S01 | Integrity boundary | RESOLVED | `sepay-ingress.ts`, `sepay-webhook.ts`, contract tests | Exact raw body, `sha256=` HMAC, safe timestamp, post-HMAC schema parsing, and branded evidence are enforced | T122/T127 complete locally |
| S02 | Network trust | RESOLVED | `sepay-ingress.ts`, config tests | Direct peer is authoritative unless explicitly trusted; spoofed forwarding is rejected; production allowlist is mandatory | T122/T127 complete locally |
| S03 | Durable acknowledgement | RESOLVED | ingress handler, payment service/repository, property tests | Success is returned only after transactional application; exact replay is idempotent and mutated provider IDs create a durable discrepancy | T122/T127 complete locally |
| S04 | Resource/config safety | RESOLVED | `app.ts`, config, composition tests | Fastify rejects oversized bodies before verification and invalid trust configuration fails during composition | T122/T127 complete locally |
| S05 | Payment race policy | OPEN (owned task) | T124/T124a/T128 | Atomic order/intent locks, typed `ALREADY_PAID`, and future/invalid transaction-time policy remain outside this slice | Continue canonical payment hardening |

Harness four-angle `manual-pass` found and corrected two pre-approval issues: unsafe ingress trust
configuration was not validated until first traffic, and a typed `{ ok: false }` settlement result
could have been acknowledged as provider success. Final slice review has **0 Critical / 0 Major**.
Host Node `20.19.0` and target Node 24 with real nested Testcontainers each pass **382/382 tests
across 70/70 files**; typecheck, lint, format check, secret scan, build, and production audit pass.
Task truth is **133 checked / 38 open / 171 rows**. Invalid `.git` still prevents SHA/CI provenance.
Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T124/T124a/T128.

## T124/T124a/T128 payment race and evidence-boundary re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| P01 | Runtime trust boundary | RESOLVED | SePay ingress, payment service, hardening tests | Type-only brand erasure previously let forged evidence write VERIFIED rows; a private runtime brand is now required before persistence | T124a/T128 complete locally |
| P02 | Cancellation race | RESOLVED | commerce/payment repositories and services | Order then Intent row locks plus locked re-read make cancel/settle converge; the loser receives typed `ALREADY_PAID` or durable discrepancy | T124/T128 complete locally |
| P03 | Expiry race | RESOLVED | `expireOverdueOrders`, payment service | Expiry locks/re-reads before transition and shares lock order with settlement, removing stale-version/deadlock behavior | T124/T128 complete locally |
| P04 | Evidence time | RESOLVED | ingress parser, payment domain/service | Impossible calendar values and invalid/future transaction times fail closed; late payment uses transfer time plus bounded skew | T124/T128 complete locally |
| P05 | Mutation/projection | RESOLVED | payment repository/service, dedicated matrix | Provider-ID mutations route to `REFERENCE_COLLISION`; live-intent mismatches freeze the Order without `OrderPaid` | T124/T128 complete locally |
| P06 | Full callback dispatcher | OPEN (owned task) | T125/T129 | Remaining Telegram actions still require one signed, opaque, customer-scoped codec and real grammY/domain dispatcher | Continue canonical callback slice |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles after fixing
the runtime-brand, lock-order, strict-date, and provider-acknowledgement findings. The dedicated
11-test PostgreSQL lane passed five repeated concurrency runs. Host Node `20.19.0` and target Node
24 with nested Testcontainers each pass **393/393 tests across 71/71 files**; all static/build/secret
and production-audit gates pass. Final slice review has **0 Critical / 0 Major**. Task truth is
**136 checked / 35 open / 171 rows**. Invalid `.git` still prevents SHA/CI provenance. Feature 001
remains `REQUEST_CHANGES`; canonical next slice is T125/T129.

## T125/T129 unified callback and runtime-dispatch re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| C01 | Callback integrity | RESOLVED | unified codec and security matrix | Every action is opaque, HMAC-bound to numeric Telegram identity, expiring, shape-checked, canonical, and <=64 bytes | T125/T129 complete locally |
| C02 | Surface adoption | RESOLVED | callback sealer and dispatcher | Catalog, checkout, history, support, and admin resources are sealed; copied/tampered/cross-user tokens fail before domain calls | T125/T129 complete locally |
| C03 | Runtime composition | RESOLVED | worker, durable inbox, grammY responder | Worker drains committed Telegram envelopes through distributed limits into real domain ports and grammY API sends | T129 complete locally |
| C04 | Replay safety | RESOLVED | Buy Now nonce, commerce/payment idempotency, support service | Support opens now dedupe on stable callback correlation across workers; other mutating callbacks retain their domain idempotency guards | T125/T129 complete locally |
| C05 | End-to-end proof | RESOLVED | `telegram-runtime-journey.test.ts` | A real signed webhook traverses HTTP, PostgreSQL inbox, verification, domain menu, resealing, and responder | T129 complete locally |
| C06 | Durable admin confirmation | OPEN (owned task) | T163/T164 | Dispatcher reaches the existing root-admin guard, but crash-atomic confirmation/mutation remains the later durable-admin slice | Continue canonical Phase D |

Harness four-angle `manual-pass` fixed noncanonical resource acceptance, missing action-aware rate
classification, missing worker composition, and duplicate support-ticket replay. Host Node `20.19.0`
and target Node 24 with nested Testcontainers each pass **416/416 tests across 74/74 files**; all
static/build/secret and production-audit gates pass. Final slice review has **0 Critical / 0 Major**.
Task truth is **138 checked / 33 open / 171 rows**. Invalid `.git` still prevents SHA/CI provenance.
Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T161/T162.

## T161/T162 outbox fencing re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| O01 | Ownership fencing | RESOLVED | migration 005, outbox repository, fencing tests | Every claim increments a durable generation; stale owner ack/fail predicates match zero rows while the reclaimer retains ownership | T161/T162 complete locally |
| O02 | Bounded ownership | RESOLVED | outbox drainer | A drain cycle claims one event at a time and does not chase events emitted after its database-time cutoff | T162 complete locally |
| O03 | Truthful telemetry | RESOLVED | drainer and production worker | Fenced acknowledgements/failures increment `stale`, never `published`/`failed`; production logs expose the counter | T162 complete locally |
| O04 | Input/query safety | RESOLVED | repository and drainer | Batch, owner, lease, error-code, and attempt bounds fail before mutation; SQL stays parameterized and claim ordering uses `occurred_at, id` | T162 complete locally |
| O05 | Durable admin confirmation | OPEN (owned task) | T163/T164 | Existing confirmation remains restart-unsafe and consume+mutation+audit is not yet one transaction | Continue canonical durable-admin slice |

Spec Kit prerequisites and all three Feature 001 checklists pass. Harness four-angle `manual-pass`
verified Spec, Regression, Security, and Skeptic angles; the pre-approval findings for unbounded
inputs, false-success counters, and nondeterministic tie ordering were fixed. Focused outbox and
fulfillment verification passes **16/16 tests**. Final-source host Node `20.19.0` and target Node 24
with nested PostgreSQL Testcontainers each pass **420/420 tests across 75/75 files**; typecheck,
lint, format check, secret scan, build, and production audit pass with **0 production
vulnerabilities**. Final slice review has **0 Critical / 0 Major**. Task truth is **140 checked / 31
open / 171 rows**. Invalid `.git` still prevents SHA/CI provenance. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice is T163/T164.

## T163/T164 durable AdminConfirmation re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| A01 | Restart durability | RESOLVED | migration 006, confirmation repository, callback test | Allowlisted command reference and bounded redacted payload survive callback/service recomposition; the process-local pending `Map` is gone | T163/T164 complete locally |
| A02 | Atomic effect | RESOLVED | `executeAtomically`, admin callback, forced-audit-failure test | Confirmation row lock, challenge verification, CONFIRMED transition, discrepancy mutation, audit append, and CONSUMED transition share one transaction | T163/T164 complete locally |
| A03 | Replay/concurrency | RESOLVED | durable integration matrix | Two concurrent correct confirmations converge to one mutation and one audit; correct replay is idempotent and wrong-challenge replay fails | T163/T164 complete locally |
| A04 | Action integrity | RESOLVED | command constraint and callback parser | Database and TypeScript allowlists agree; actor, target, reason, resolution code, payload size, and action fingerprint are bounded/validated before mutation | T163/T164 complete locally |
| A05 | Fulfillment atomicity | OPEN (owned task) | T165/T166 | Digital asset claim and `DigitalAssetClaimed` emission still require one crash-safe transaction | Continue canonical fulfillment-atomicity slice |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles after fixing
payload/fingerprint binding, bounded input validation, correct deny-audit target typing, and the
explicit CREATED -> CONFIRMED -> CONSUMED transition inside the atomic transaction. Focused
admin/runtime verification passes **13/13 tests across 5/5 files**. Final-source host Node `20.19.0`
and target Node 24 with nested PostgreSQL Testcontainers each pass **423/423 tests across 76/76
files**; typecheck, lint, format check, secret scan, build, and production audit pass with **0
production vulnerabilities**. Final slice review has **0 Critical / 0 Major**. Task truth is **142
checked / 29 open / 171 rows**. Invalid `.git` still prevents SHA/CI provenance. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice is T165/T166.

## T165/T166 fulfillment atomicity re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| F01 | Crash window | RESOLVED | fulfillment orchestrator and forced-event-failure test | Asset claim/promotion and `DigitalAssetClaimed` append now share one transaction; event failure restores AVAILABLE or the prior RESERVED hold | T165/T166 complete locally |
| F02 | Pre-reservation path | RESOLVED | transaction-only claim/hold repository | The normal Buy Now RESERVED hold is locked, promoted to READY, and emitted instead of silently skipping the claim event | T166 complete locally |
| F03 | Replay/repair | RESOLVED | fulfillment re-entry | READY rows with a historical missing event are repaired under the asset lock; an existing event suppresses duplicate emission | T166 complete locally |
| F04 | Version integrity | RESOLVED | atomicity matrix | Event aggregate version equals the committed READY asset version for both AVAILABLE and pre-reserved entry paths | T165/T166 complete locally |
| F05 | Bounded recovery | OPEN (owned task) | T167/T168 | Order/intent/reservation/SePay/supplier/bundle recovery still requires bounded SKIP LOCKED jobs and backlog telemetry | Continue canonical recovery slice |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles. The final
path keeps opaque vault references only, deterministic row ordering, transaction-only claim APIs,
version-correct events, and idempotent repair. The forced trigger proves rollback after the asset
mutation but before event append for both stock-entry states. Focused fulfillment verification
passes **12/12 tests across 5/5 files**. Final-source host Node `20.19.0` and target Node 24 with
nested PostgreSQL Testcontainers each pass **425/425 tests across 77/77 files**; typecheck, lint,
format check, secret scan, build, and production audit pass with **0 production vulnerabilities**.
Final slice review has **0 Critical / 0 Major**. Task truth is **144 checked / 27 open / 171 rows**.
Invalid `.git` still prevents SHA/CI provenance. Feature 001 remains `REQUEST_CHANGES`; canonical
next slice is T167/T168.

## T167/T168 bounded recovery re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| R01 | Bounded selection | RESOLVED | domain recovery modules and integration matrix | Every database-backed class uses deterministic bounded `FOR UPDATE SKIP LOCKED`; batch inputs are restricted to 1–100 | T167/T168 complete locally |
| R02 | Failure isolation | RESOLVED | recovery loops, provider reconciliation, poison fixtures | A poison reservation/provider row rolls back or defers only itself and later rows continue within the same bounded run | T168 complete locally |
| R03 | External recovery fencing | RESOLVED | SePay and supplier recovery | SePay uses a PostgreSQL advisory lock across the bounded official API call; supplier UNKNOWN rows receive a durable `next_reconcile_at` claim and recovery never calls create | T168 complete locally |
| R04 | Evidence boundary | RESOLVED | official SePay API adapter, ingress, matcher | API rows are schema/size/time bounded, source-qualified, branded only after authenticated adapter validation, and pass the canonical matcher; structured `code` takes precedence over free-form content | T168 plus T122/T127 refinement complete locally |
| R05 | Delivery safety | RESOLVED | Delivery Bundle recovery and concurrent-worker test | Only expired CREATED/AVAILABLE/VIEWED rows become EXPIRED; CONSUMED remains terminal and explicit reissue policy remains unchanged | T168 complete locally |
| R06 | Query scaling | OPEN (owned task) | T169/T170 | Pilot-sized plan assertions and hot composite indexes remain the next canonical slice | Continue canonical query-plan slice |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles. Recovery
telemetry exposes claimed, succeeded, failed, backlog, and oldest age for all configured classes;
the worker runs the jobs single-flight on a 60-second schedule and fails production config closed
without a SePay API credential. Focused recovery and adjacent verification passes **28/28 tests**.
Final-source host Node `20.19.0` and target Node 24 with nested PostgreSQL Testcontainers each pass
**433/433 tests across 79/79 files**; typecheck, lint, format check, secret scan, build, and
production audit pass with **0 production vulnerabilities**. Final slice review has **0 Critical /
0 Major**. Task truth is **146 checked / 25 open / 171 rows**. Invalid `.git` still prevents SHA/CI
provenance. Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T169/T170.

## T169/T170 query-plan and cache re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| Q01 | History plan | RESOLVED | migration 007, query-plan test | Customer history now uses `(customer_id, created_at desc, id desc)` with no planner Sort on pilot-sized data | T169/T170 complete locally |
| Q02 | Asset-claim plan | RESOLVED | migration 007, query-plan test | Deterministic `(variant_id, status, created_at, id)` allocation uses the composite index under `FOR UPDATE SKIP LOCKED` | T169/T170 complete locally |
| Q03 | Search scalability | RESOLVED | catalog search, migration 007 | Accent-folded word-prefix `to_tsquery` plus GIN expression indexes removes leading-wildcard `%LIKE%` scans while retaining name/category/alias behavior | T170 complete locally |
| Q04 | Cache concurrency | RESOLVED | catalog cache and contract matrix | Concurrent cold misses single-flight; invalidation fences stale in-flight reads from repopulating a newer version | T170 complete locally |
| Q05 | Production query evidence | OPEN (owned task) | T173/T174 | Compiled migration/startup and CI Docker provenance remain open launch gates | Continue canonical packaging slice |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles. Focused
query/cache/search/claim verification passes **24/24 tests**. Final-source host Node `20.19.0` and
target Node 24 with nested PostgreSQL Testcontainers each pass **437/437 tests across 81/81 files**;
typecheck, lint, format check, secret scan, build, and production audit pass with **0 production
vulnerabilities**. Migration build output contains **7 files**. Final slice review has **0 Critical /
0 Major**. Task truth is **148 checked / 23 open / 171 rows**. Invalid `.git` still prevents SHA/CI
provenance. Feature 001 remains `REQUEST_CHANGES`; canonical next slice is T171/T172.

## T171/T172 beneficiary identity split re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| B01 | Independent configuration | RESOLVED | `src/config/env.ts`, `tests/contract/payment-beneficiary-config.test.ts` | SePay merchant identity and VietQR beneficiary number are required, independently validated, and rejected when equal; bank display name is bounded and non-blank | T171/T172 complete locally |
| B02 | Settlement matching | RESOLVED | `src/modules/payments/service.ts`, `payment_intent.merchant_account_id` | Payment intents persist `SEPAY_MERCHANT_ACCOUNT_ID`; verified evidence matching remains against that identity | T172 complete locally |
| B03 | QR beneficiary | RESOLVED | `src/modules/payments/service.ts`, `src/modules/payments/vietqr.ts` | QR rendering uses the explicit `beneficiaryAccountNumber` on fresh, reused, and raced presentation paths; it never reads the SePay identity | T172 complete locally |
| B04 | Runtime wiring | RESOLVED | `src/worker.ts`, `src/bot/callbacks/checkout.ts`, `.env.example` | Production composition passes both identities plus validated `VIETQR_BANK_NAME`; presenter carries the bank display name | T172 complete locally |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles. The
contract RED run initially failed on the missing bank-name field and missing distinctness rule;
GREEN now proves independent values, empty-field rejection, equality rejection, and bounded bank
display-name validation. A deliberately distinct acceptance journey proves the SePay merchant
identity settles while the VietQR payload/presenter exposes only the beneficiary account and bank
name. Focused config/VietQR/payment lanes pass **25/25 tests across 4/4 files**; the full host Node
20.19.0 suite passes **442/442 tests across 82/82 files** and target Node 24 Docker with nested
PostgreSQL Testcontainers passes **442/442 tests across 82/82 files**. Typecheck, lint, format
check, secret scan, build, and production audit pass with **0 production vulnerabilities**. Final
slice review has **0 Critical / 0 Major**. Task truth is **150 checked / 21 open / 171 rows**.
Invalid `.git` still prevents SHA/CI provenance. Feature 001 remains `REQUEST_CHANGES`; canonical
next slice is T173/T174.

## T173/T174 compiled migration and honest Docker CI re-analysis (2026-07-17)

| ID | Category | Severity | Location(s) | Summary | Disposition |
|---|---|---|---|---|---|
| P01 | Production migration | RESOLVED | `package.json`, `tests/acceptance/migrate-prod.test.ts`, compiled `dist/` | `migrate:prod` launches `node dist/infrastructure/db/migrate.js`; acceptance proves the compiled artifact runs without `tsx` | T173 complete locally |
| P02 | Docker probe | RESOLVED | `tests/helpers/pg-container.ts` | Docker availability remains a live daemon probe; unavailable daemons are skipped by gated suites, while started-container migration/readiness failures are cleaned up and rethrown | T174 complete locally |
| P03 | CI provenance | RESOLVED (workflow) | `.github/workflows/ci.yml` | CI explicitly runs `docker info`, adds the bank-name env contract, builds before compiled migration smoke, and uses `migrate:prod` | T174 workflow complete; hosted CI run remains external evidence |

Harness four-angle `manual-pass` verified Spec, Regression, Security, and Skeptic angles. The RED
acceptance test initially failed because `migrate:prod` was undefined; GREEN proves the compiled
artifact and real PostgreSQL migration run. Host Node `20.19.0` passes **444/444 tests across
83/83 files**; target Node 24 Docker with nested PostgreSQL Testcontainers passes **444/444 tests
across 83/83 files**. Typecheck, lint, format check, secret scan, build, and production audit
pass with **0 production vulnerabilities**. Final slice review has **0 Critical / 0 Major**. Task
truth is **152 checked / 19 open / 171 rows**. `.git` remains invalid and no hosted CI run was
available in this workspace, so SHA/CI provenance is not claimed. Feature 001 remains
`REQUEST_CHANGES`; canonical next work is the release-evidence/external-gate slice T151–T153.

## T151 CI lane and evidence publication verification (2026-07-17)

T151 is complete as a workflow change. `.github/workflows/ci.yml` now has explicit unit/contract/
property, security, integration, acceptance, performance, typecheck, lint, format, secret, audit,
build, compiled start, compiled migration, and Docker probe lanes. JUnit XML reports for each test
lane are uploaded with `actions/upload-artifact@v4` under a run-scoped artifact name. Local security
passes **73/73** and performance passes **4/4**; full host/Node 24 suites remain **444/444**. No
hosted GitHub run is available in this invalid-`.git` workspace, so T152 provenance remains open.

## T153 independent review and post-review remediation (2026-07-17)

The requested independent file-scoped review used three read-only angles: Spec/Plans, Security,
and Regression/Skeptic. The first regression pass found one Major CI ordering defect: acceptance
tests required ignored `dist/` before Build. The workflow was corrected to build before all
acceptance tests; a focused re-review is **APPROVE, 0 Critical/Major** for that correction.

The consolidated Feature 001 verdict remains **REQUEST_CHANGES** because the Spec/Security angles
found one Critical and several Major launch blockers: delivery route trusts a caller-supplied
`x-customer-id` instead of a signed Telegram session; SePay settlement is still synchronous rather
than durable-inbox/async; external vault, HTTP supplier, and real Telegram delivery notifier are
not wired; QR photo delivery is incomplete; and `.git`/hosted CI provenance is unavailable. During
the remediation loop, documented Telegram placeholders are now rejected in production, the secret
scanner no longer prints matched secret material, and failed asset delivery now rolls back the
consume/completion transaction with a regression test. Full host Node 20.19.0 and target Node 24
Docker suites pass **447/447 tests across 83/83 files**. These fixes do not close T115/T118, T136–T150,
T152, or T153; Feature 001 is not pilot/production ready.

## Official SePay compliance correction (2026-07-17)

The previous T122/T127 local-green claim was incomplete: the webhook still waited for synchronous
settlement and had no immutable evidence retention boundary. The correction now resolves that seam
with a transactional `source='sepay'` inbox, redacted allowlisted envelope plus raw hash/auth
metadata, duplicate/mutation discrepancy handling, an immutability trigger, and a bounded worker
that runs the canonical matcher after ACK. `structuredCode` is the primary matching key, while
content/reference are bounded fallbacks. The official API adapter accepts page/since_id cursors,
normalizes timeouts, and gates requests at 3/s; VietQR uses the official image endpoint with the
allowlist `compact|qronly|standee|empty`, rejecting `compact2`. No Google Sheet code exists in the
payment truth or delivery path; the documented Sheet remains audit projection only. Focused
contract/integration proof is 23/23 with typecheck/lint/format green. Feature 001 remains
`REQUEST_CHANGES` pending independent review and external launch evidence.

## Gate 0 source-of-truth correction (2026-07-17)

Constitution check: the existing v1.0.0 constitution already requires verified payment truth,
least-privilege identity, contract-first state machines, test-first recovery, and zero unresolved
Critical/High design findings before implementation. No constitutional amendment is required.

Specify/clarify result: the user-provided correction is complete and unambiguous; no clarification
marker is needed. The spec delta now states that merchant and beneficiary keys remain separate but
may be equal, QR image/media delivery is independently proven, SePay ACK precedes async settlement,
fresh Telegram identity onboarding is atomic, and delivery sessions, notification handoff,
vault/supplier adapters, and compiled staging boot are release behavior.

Plan/checklist/tasks result: append-only migrations are `001`–`008` for the current source, then
Feature 001 `009_identity_delivery_security.sql`, Feature 003 `010_notifications_quantity.sql`,
and Feature 002 `011_ai_support.sql`. T145, T146, T148, T171, T172, T174, and T178 are reopened;
T175/T176 explicitly own the durable SePay lifecycle, while T179–T185 are RED-first gates and
T186–T190 are their implementation owners. Gate 0 task truth is **155 checked / 32 open / 187 rows**.

### Gate 0 design analysis

| ID | Category | Severity | Disposition |
|---|---|---:|---|
| G0-01 | Merchant/beneficiary semantics | RESOLVED | Separate keys with equal-value pilot acceptance and distinct VA acceptance are normative in spec/plan/contracts/tasks. |
| G0-02 | SePay lifecycle ownership | RESOLVED | T175/T176 own durable accept, strict claim validation, rawHash binding, atomic mutation alert, and PostgreSQL crash/fencing/retry proofs. |
| G0-03 | Migration ordering | SUPERSEDED | The new correction reserves Feature 001 009, Feature 003 010, and Feature 002 011 after frozen SePay-only 008. |
| G0-04 | Feature scope | RESOLVED | Feature 003, AI, wallet/top-up, and Reseller API remain blocked; Feature 001 remains REQUEST_CHANGES. |

Gate 0 has no unresolved Critical/High design inconsistency. Implementation must not begin until the
TDD acceptance tests for the next slice are written and failing; runtime/release Critical/Major
findings remain launch blockers.

## Slice 1 SePay/VietQR correctness re-analysis (2026-07-17)

T171/T172 and T175/T176 are complete locally. The RED config test failed because equal
merchant/beneficiary values were rejected. The RED strict-envelope matrix processed two poisoned
claims because nested objects were not strict and auth timestamp `0` was accepted. GREEN removes
the inequality constraint, makes each claimed envelope object strict, carries and binds rawHash,
checks source/provider/payload/account/amount/direction/code/content/reference/time consistency,
and makes mutation alerts unique by source event plus incoming raw hash in the same transaction as
mutation accounting.

The primary acceptance test is not mock-only: signed official-shaped SePay requests for both a
same-account pilot and a distinct VA pass through Fastify, commit PostgreSQL inbox evidence, return
exact `200 {"success":true}`, then settle only after a worker claim. PostgreSQL tests cover 20-event
mutation flood, immutability, lease expiry, stale generation, crash/restart, strict poison claims,
retry and dead-letter.

Focused Slice 1 verification is **15/15**. Full host verification is **459/459 tests across 85/85
files**. Typecheck, lint, format, secret scan, build (8 migrations), and production audit (0
vulnerabilities) pass. Manual Spec/Security/Concurrency/Regression review reports **0 Critical / 0
Major within Slice 1**. Task truth is **153 checked / 22 open / 175 rows**. Overall Feature 001
remains `REQUEST_CHANGES`; T148/T174 and later production paths remain open.

## Gate 0 correction after Slice 2–3 re-review (2026-07-17)

The prior Slice 2–3 zero-finding conclusions are withdrawn. T177 and T139 remain checked only for
their narrow test scopes. T178, T145, and T146 are reopened.

| ID | Severity | Gap | Required disposition |
|---|---|---|---|
| G2-01 | RESOLVED DESIGN | Identity/delivery DDL was appended to migration 008 after a SePay-only 008 could already be recorded | Frozen 008 plus idempotent 009 upgrade for SePay-only and prior expanded shapes; compiled upgrade proof and collision fail-closed runbook are owned by T179/T183/T186 |
| G2-02 | RESOLVED DESIGN | Bundle commit could succeed before handoff creation and the only plaintext token could disappear with the call stack | Recoverable PREPARED → STORED → READY protocol, durable handoff-before-ack, crash reconstruction, and one-capability convergence are specified and owned by T179/T187 |
| G2-03 | RESOLVED DESIGN | External vault write occurred inside a PostgreSQL transaction and rollback could leave an orphan capability | Deterministic capability keys, compensation/recovery, bounded cleanup, and network I/O outside long DB transactions are specified and owned by T180/T187 |
| G2-04 | RESOLVED DESIGN | Expired session retry, dedicated key separation, current/previous rotation grace, and pre-send claim matching were absent | Dedicated delivery key ring, idempotent refresh, expiry-safe SENT guard, and claim-to-handoff verification are specified and owned by T181/T182/T188 |
| G2-05 | RESOLVED DESIGN | Telegram URL buttons do not attach Authorization headers, so the customer transport was incomplete | Verified Telegram Mini App `initData`, one-time audience-bound redemption, and worker send/edit/photo wiring are specified and owned by T184/T189/T150 |
| G2-06 | RESOLVED DESIGN | Durable inbox retained `actorUsername`; root bootstrap seeded expected username as if observed | Username is excluded from durable inbox, bootstrap is numeric-only, verified-webhook observation and bounded pruning are specified and owned by T185/T190 |

The revised Spec Kit analyze result is **zero unresolved Critical/High design findings** across the
57/57 FR/SR/SC traceability matrix. This is a design-pass only: RED implementation, staging/runtime,
external-vault/supplier/Telegram-media, Git/hosted-CI, and release evidence gates remain open.
Feature 001 therefore remains **`REQUEST_CHANGES`**, and no Feature 003, AI, wallet/top-up, or
Reseller API work is authorized.

## Post-Gate 0 RED/GREEN implementation slice (2026-07-17)

The first bounded implementation slice covers only migration compatibility, durable-inbox username
stripping, and dedicated delivery-session key separation/rotation grace. Migration `008` is now
frozen as SePay-only; idempotent `009_identity_delivery_security.sql` handles both legacy shapes,
adds the collision fail-closed guard, and preserves existing rows. PostgreSQL durable Telegram
acceptance strips `actorUsername` before persistence, and delivery-session verification accepts a
previous key only when its distinct key version is explicitly configured. `DELIVERY_SESSION_*`
configuration is separate from the Buy Now callback key and local ignored `.env` now contains the
required non-placeholder values.

Focused verification includes **32/32 tests across 4 files** plus a compiled PostgreSQL migration
lane with **5/5 tests** covering fresh execution, SePay-only 008, prior expanded 008, preserved rows,
and collision fail-closed behavior. A later independent review found this acceptance false-green:
the expanded-008 fixture omitted its historical RETRY-only due index and real delivery rows, so
`CREATE INDEX IF NOT EXISTS` could leave the wrong predicate in place. The corrected RED test failed
on the missing PROCESSING lease index; GREEN explicitly replaces the due index, adds the lease index,
preserves real historical rows, and asserts both definitions. Compiled migration passes 5/5, so
T183/T186 re-close and task truth is **157 checked / 30 open / 187 rows**. The first full-host run exposed five regressions in capability-key
DDL and username transport; those were fixed and the rerun passes **473/473 tests across 88 files**.
TypeScript, lint, format, secret scan, build, and production dependency audit pass. T183/T186 are now
complete for the exact historical migration/index seam. This does not close crash/handoff recovery,
vault rollback compensation, expired-session refresh, Mini App transport, or username
observation/pruning. Overall Feature 001 remains **`REQUEST_CHANGES`**.

## T179-T190 implementation re-analysis (2026-07-17)

The exact historical expanded-008 migration fixture now includes its old constraints, RETRY-only
due index, and real delivery-session/handoff rows. Migration 009 explicitly replaces that index,
adds a separate PROCESSING lease-expiry index, preserves the historical rows, and fails closed on
`telegram`/`TELEGRAM` collisions. The compiled upgrade lane passes **5/5**.

The durable delivery protocol now reconstructs a missing handoff after Bundle commit, moves vault
I/O outside long PostgreSQL transactions, compensates a successful vault write when the database
store transition rolls back, recovers PREPARED/STORED states, refreshes expired sessions
idempotently, validates current/previous key versions, and performs bounded terminal/expired
capability cleanup. Telegram Mini App redemption verifies bounded `initData`, numeric ownership,
audience, freshness, and one-time use. Durable Telegram inbox rows exclude usernames; root bootstrap
is numeric-only; verified username observations are pruned after the bounded retention window.

The fresh Spec Kit consistency pass still maps **57/57 FR/SR/SC identifiers** to tasks and evidence
seams. No unresolved Critical/High design inconsistency was found. Current OPEN/PARTIAL rows are
implementation and runtime blockers: external vault, HTTP supplier, supplier fulfillment,
delivery completion/reissue invariants, QR image/scan proof, Telegram media/notification draining,
compiled main+worker staging acceptance, Node 24 Docker evidence, valid Git/hosted CI, and final
independent review.

Current host verification on Node **20.19.0** is **484/484 tests across 92/92 files**, with no
skipped-test completion claim. Typecheck, lint, format check, secret scan, build (9 migrations),
production dependency audit (0 vulnerabilities), and compiled migration **5/5** pass. Node 24
Docker was not rerun at this checkpoint. Task truth is **170 checked / 17 open / 187 rows**.
Overall verdict remains **`REQUEST_CHANGES`**; this is not staging, pilot, or production approval.

## T136/T142 external-vault adapter re-analysis (2026-07-17)

The external-vault boundary is now specified by `contracts/external-vault.md` and implemented as a
real authenticated HTTP adapter. The contract fixes deployment/asset/capability namespace
provenance, deterministic idempotency keys, strict health/write/reveal/delete schemas, HTTPS outside
loopback tests, 65536-byte request/response bounds, timeout, bounded retry, generic redacted errors,
and namespace rejection before network access. Main and worker fail closed on startup health; the
Fastify readiness route now checks both PostgreSQL and vault health while liveness remains isolated.

RED evidence first failed **4/5** because the external driver was the old permanent stub. A second
RED cycle exposed missing material-size/content-type validation, and the readiness RED cycle exposed
that the previous test double made every database readiness check look unavailable. GREEN uses an
actual loopback HTTP server for the provider contract and a corrected readiness executor double.

Spec Kit coverage remains **57/57** with FR-028 now covered. Manual Harness/Matt Spec, Standards,
Security, and Regression passes found no unresolved Critical/High design or implementation finding
inside T136/T142. This does not prove an owner-provisioned staging vault endpoint or close the
separate vault-outage reveal task T140.

Final host Node **20.19.0** verification is **492/492 tests across 93/93 files**. Typecheck, lint,
format check, secret scan, build (9 migrations), and production dependency audit (0 vulnerabilities)
pass. Node 24 Docker and true-staging external-vault boot were not run. Task truth is **172 checked /
15 open / 187 rows**. Feature 001 remains **`REQUEST_CHANGES`**.

## Reviewer false-green correction Gate 0 (2026-07-18)

The T136/T142 and T180-T188 local-green conclusions above are superseded. The implementation was
verified against narrower seams, but those seams did not prove full streamed-body timeout ownership,
bounded chunked reads, exact serialized request sizing, redirect refusal, production egress policy,
durable double-failure compensation, refresh crash windows, explicit previous-key grace expiry,
mandatory production session verification, or Telegram secret-gate composition.

Source-of-truth changes keep constitution v1.0.0 intact and refine FR-017/FR-017a/FR-021/FR-024a/
FR-028 plus SR-001/SR-004/SR-006. Contracts now define external-vault streaming/redirect/egress
boundaries, durable orphan tombstones, deterministic refresh generation, explicit previous-key
deadline, and zero persistence from a rejected Telegram webhook. T185/T190 remain checked only for
their core privacy/pruning proof; composition is owned by reopened T182/T188.

T136, T142, T180, T181, T182, T187, and T188 are reopened. Executable task truth is now **165
checked / 22 open / 187 rows**. The historical **492/492** host result remains a real command result
for the older snapshot, but it is not evidence for the new RED boundaries. No new RED, Node 24,
Docker, Git/SHA, hosted-CI, staging-vault, or production claim is made by this Gate 0 correction.
Overall verdict remains **`REQUEST_CHANGES`**.

### Gate 0 cross-artifact analyze result

Spec Kit prerequisites resolve the existing Feature 001 directory and all required artifacts. The
updated inventory remains **57 requirements / 57 mapped**, with **187 tasks: 165 checked / 22 open**.
No `[NEEDS CLARIFICATION]` marker, constitution conflict, competing feature scope, or uncovered
requirement remains. A0/A1 terminology is consistent across spec, plan, data model, contracts,
requirements checklist, tasks, and traceability. Therefore Gate 0 has **0 unresolved Critical/High
design findings** and implementation may begin at A0 RED. This design result does not close any
reopened task or any runtime/release Critical/High finding.

## A0 external-vault correction re-analysis (2026-07-18)

T136/T142 now match the strengthened FR-028/SR-001/SR-004 contract at the real HTTP boundary. One
attempt deadline spans DNS, connect, headers, bounded streaming, UTF-8 decode, strict JSON parse,
and operation schema validation. Unknown-length responses are counted incrementally and destroyed
at `MAX_JSON_ENVELOPE_BYTES + 1`; the exact serialized request buffer is measured once and reused.
Node's non-following transport treats redirects as terminal, endpoint userinfo/query/fragment are
rejected, base paths are normalized without protocol-relative URL reinterpretation, and each
request re-resolves all addresses against explicit host/port/CIDR policy before using a pinned
approved address. Exact-max escaped material round-trips; max+1 fails before network access.

Production composition now parses and passes `VAULT_EGRESS_HOST_ALLOWLIST`,
`VAULT_EGRESS_PORT_ALLOWLIST`, and `VAULT_EGRESS_CIDR_ALLOWLIST` into main and worker. Empty policy
fails production configuration, while private vault networks remain possible only through explicit
allowlisting. Current and previous delivery-session keys are rejected when reused across Telegram,
Buy Now, SePay, vault, or supplier secret domains. Strict non-transient provider failures no longer
consume the retry budget.

Focused proof is **55/55 across 4 files** on host Node **24.15.0**. Typecheck, lint, and focused
format checks pass. No full-host, Docker, Node-24-container, build, secret-scan, dependency-audit,
staging-vault, Git/SHA, or hosted-CI result is inferred. The cross-artifact inventory remains
**57/57 mapped** and task truth is **167 checked / 20 open / 187 rows**. A0 has no unresolved
Critical/High finding; A1 and all later slices remain open, so Feature 001 stays
**`REQUEST_CHANGES`**.

## A1 delivery compensation/rotation re-analysis (2026-07-18)

| ID | Category | Severity | Resolution |
|---|---|---|---|
| A1-01 | Concurrency | HIGH | Closed: `SENT` and `RETRY/DEAD` transitions require a live owner/generation lease; persisted Bundle/Customer/chat/ref are rechecked before send and acknowledgement. |
| A1-02 | Recovery | HIGH | Closed: terminal/expired refs transfer under `FOR UPDATE SKIP LOCKED` into the durable compensation ledger before handoff ref removal; delete failure backs off without losing the pointer. |
| A1-03 | Idempotency | HIGH | Closed: initial and refresh operation identities include durable generation, preserve exact material through allowed rotation, and preserve an existing cleanup delay when re-tombstoned. |
| A1-04 | Authorization | HIGH | Closed: PREPARED sessions remain inactive until atomic adoption, and the real reveal seam rejects the orphan session after double failure. |
| A1-05 | Boundary | MEDIUM | Closed in source: send timeout is below its 30-second notification lease; compensation cleanup owns a 180-second lease, exceeding the external vault adapter's maximum bounded delete retry budget. |
| A1-06 | Observability | MEDIUM | Residual: compensation ledger is durable recovery provenance, but an explicit immutable cleanup `audit_event` assertion remains absent; SR-005 stays PARTIAL and does not authorize release. |

Current-source RED evidence reproduced the generation-key mismatch, unbounded/stale send outcomes,
persisted-recipient drift, duplicate terminal cleaners, missing delayed terminal compensation, and
exact grace-deadline acceptance before their fixes. GREEN ran sequentially after Docker recovery to
avoid the host's observed parallel Node/Testcontainers pressure: **75/75 tests across 8 focused
files**, including real PostgreSQL, compiled migration upgrades, Telegram secret-gate composition,
and key/config security. Typecheck, lint, full format check, secret scan, build with **10 migrations**,
and production audit (**0 vulnerabilities**) pass.

The structural traceability inventory remains **57/57**, and task truth is now **172 checked / 15
open / 187 rows**. The post-A1 Spec Kit analyze rerun found 57 unique requirements, 57 unique
mapped identifiers, no missing/extra identifier, no placeholder, and no unresolved constitution,
ambiguity, consistency, or coverage finding at Critical/High. Independent Spec,
Security/Concurrency, and Regression reviews found **0
Critical / 0 High inside A1** after the correction loop. T150, supplier/delivery completion,
VietQR media, compiled staging, Node 24/full-host, Git/SHA/CI, credential rotation, and owner launch
sign-off remain open. Feature 001 therefore remains **`REQUEST_CHANGES`**; the next permitted slice
is T137 RED -> T143 GREEN.

