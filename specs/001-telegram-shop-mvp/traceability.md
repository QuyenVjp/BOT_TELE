# Requirement Traceability: Telegram Shop Digital MVP

| Requirement | Primary tasks | Test/evidence seam |
|---|---|---|
| FR-001 | T028, T034–T035 | `catalog-journey.test.ts` |
| FR-002 | T025, T029–T031, T154, T157 | `catalog-repository.test.ts`, `catalog-search.test.ts` supplier-policy exclusion |
| FR-003 | T028, T034–T035 | `catalog-journey.test.ts` |
| FR-004 | T026–T027, T031–T033 | `catalog-search.test.ts`, `search-parser.test.ts` |
| FR-005 | T027–T028, T032–T034 | parser and catalog acceptance fixtures |
| FR-006/FR-006a–e | T039, T046, T048, T154–T160 | typed stock, TTL, supplier fail-closed, locking/load, presenter, and idempotency integration lanes |
| FR-007 | T039, T046, T048 | immutable snapshot assertions |
| FR-008 | T039–T040, T047–T050 | Buy Now and VietQR contract tests |
| FR-009 | T041, T047, T051–T053 | signed SePay webhook contract |
| FR-010 | T042, T051–T053, T061, T071–T076 | payment/fulfillment replay properties |
| FR-011 | T043, T047, T049, T052–T053 | discrepancy integration test |
| FR-012 | T044, T054, T057 | reconciliation recovery test/alerts |
| FR-013 | T061, T065, T071, T076 | fulfillment guard/recovery tests |
| FR-014 | T059, T065–T066, T154, T157 | final-asset concurrency plus deterministic active-hold/re-entry tests |
| FR-015 | T060–T061, T067–T069 | supplier unknown/query-before-retry contract |
| FR-016 | T060, T067–T070 | malformed/invalid asset contract fixtures |
| FR-017 | T062, T065, T072–T074 | Delivery Bundle security tests |
| FR-018 | T080, T084, T087–T088 | Order history BOLA/pagination tests |
| FR-019 | T081–T083, T085–T088 | support integration/acceptance tests |
| FR-020 | T078, T081, T109, T154, T157 | real-PostgreSQL original-delivered-asset replacement tests/runbook |
| FR-021 | T090, T094–T095 | numeric root identity security test |
| FR-022 | T091, T094–T097 | no-add-admin capability test |
| FR-023 | T092–T093, T096–T099 | action confirmation/audit tests |
| FR-024 | T021–T022, T080–T083 | ingress abuse and recovery-route tests |
| FR-024a | T121, T126 | `telegram-ingress-durable.test.ts`: durable ack, hash mutation, fenced claims, retry/dead, action budgets, private callback context, retention, safe telemetry |
| SR-001 | T009, T019–T020, T024, T063, T072–T074 | telemetry/credential leak scans |
| SR-002 | T041–T044, T051–T054 | SePay verification/mismatch contracts |
| SR-003 | T062, T080, T084, T073–T074 | Delivery/Order BOLA tests |
| SR-004 | T021–T022, T027, T041, T060, T067–T069 | ingress/parser/provider boundary tests |
| SR-005 | T019–T020, T092–T099 | redaction and immutable audit tests |
| SR-006 | T017–T018, T042, T061, T071–T076, T105 | outbox/fulfillment crash recovery and restore drill |
| SR-007 | T025, T029, T037, T111 | unauthorized SKU filtering and dated authorization gate |
| SR-008 | T102–T114 | security review, runbooks, quickstart, owner sign-offs |
| SC-001 | T028, T038 | timed product discovery acceptance evidence |
| SC-002 | T028, T038 | menu-to-QR action count evidence |
| SC-003 | T104 | pilot catalog/navigation load evidence |
| SC-004 | T064, T077, T104 | paid-to-delivery percentile evidence |
| SC-005 | T042, T061, T079 | 100-replay payment/fulfillment evidence |
| SC-006 | T059, T066, T079 | 20-buyer final-asset concurrency evidence |
| SC-007 | T019, T063, T103 | secret leak and supply-chain scans |
| SC-008 | T043–T044, T052–T058 | complete discrepancy fixture matrix |
| SC-009 | T090–T100 | sole-admin impersonation/context evidence |
| SC-010 | T101, T113 | traceability and final Spec Kit analysis |

**Coverage**: 42/42 buildable requirements and success criteria map to at least one task and test/evidence seam (100%).

## Post-implementation verification (T101, 2026-07-16)

All mapped seams are now implemented and green. Every FR/SR/SC above resolves to a passing test lane
or a recorded evidence file; no requirement is left uncovered.

| Evidence file | Requirements confirmed |
|---|---|
| `evidence/us1-catalog.md` | FR-001–FR-005, SC-001, SC-002 |
| `evidence/us2-payment.md` | FR-006–FR-012, SR-002, SC-005, SC-008 |
| `evidence/us3-fulfillment.md` | FR-013–FR-017, FR-020, SR-001, SR-003, SR-006, SC-004, SC-006, SC-007 |
| `evidence/us4-support.md` | FR-018, FR-019, SR-003 |
| `evidence/us5-admin.md` | FR-021, FR-022, FR-023, SR-005, SC-009 |
| `evidence/supply-chain.md` | SR-001, SC-007 (+ SR-008 container gate) |
| `evidence/restore.md` | SR-006 (+ SR-008 production drill gate) |
| `evidence/quickstart.md` | End-to-end lanes for all user stories |
| `security-review.md` | STRIDE/OWASP disposition for SEC-001…SEC-016 |
| `launch-gates.md` | SR-007, SR-008 production sign-off gates |
| `tests/performance/pilot-load.test.ts` | SC-003, SC-004 percentiles |

The paragraph above was the T154–T157 checkpoint. It is superseded by the 2026-07-17 Gate 0 run:
T158–T160 are complete locally, task truth is **129 checked / 42 open / 171 rows**, and the current
host gate is **361/361 tests across 68/68 files**. Typecheck, lint, format check, secret scan, build,
and production audit exited 0; production audit found 0 vulnerabilities. The historical Node
24.18.0 container result was not rerun in this pass. Invalid `.git` still prevents SHA-bound CI
evidence, Feature 001 remains `REQUEST_CHANGES`, and the canonical next slice is T121/T126.

## T121/T126 durable Telegram ingress verification (2026-07-17)

T121/T126 are complete locally. Task truth is now **131 checked / 40 open / 171 rows**. RED was a
missing durable inbox module; GREEN is 10/10 dedicated PostgreSQL Testcontainers cases, five repeated
pre-review concurrency runs, and the final **371/371 tests across 69/69 files** on both host Node
`20.19.0` and target Node 24 with the Docker socket/host override. The build packages
`004_telegram_inbox.sql`; typecheck, lint, format check, secret scan, build, and production audit pass.
The slice proves durable receipt and the asynchronous fenced processor/rate-limit boundary, not the
future grammY/domain dispatcher owned by T125/T129. `.git` remains invalid, so evidence is local and
not SHA/CI-bound. Canonical next slice: T122/T127.

## T122/T127 verified SePay ingress verification (2026-07-17)

T122/T127 are complete locally. Task truth is now **133 checked / 38 open / 171 rows**. Contract and
composition coverage proves exact raw-body preservation, `sha256=` HMAC, safe freshness bounds,
trusted direct-proxy/IP handling, schema-after-integrity, branded evidence, pre-verifier body limits,
startup trust-config validation, provider-safe failure responses, exact replay idempotency, and
mutated provider-ID discrepancy routing. The final host Node `20.19.0` and target Node 24 Docker
lanes each passed **382/382 tests across 70/70 files** with real nested PostgreSQL Testcontainers.
Typecheck, lint, format check, secret scan, build, and production audit pass with 0 production
vulnerabilities. The remaining payment concurrency/time boundary is owned by T124/T124a/T128.
`.git` remains invalid, so evidence is local and not SHA/CI-bound. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice: T124/T124a/T128.

## T124/T124a/T128 payment hardening verification (2026-07-17)

T124/T124a/T128 are complete locally. Task truth is now **136 checked / 35 open / 171 rows**. The
dedicated 11-test Testcontainers matrix covers raw/unbranded rejection before persistence, provider
ID mutations across hash/amount/account/content/direction, invalid/future transaction time,
transaction-time expiry, discrepancy-to-Order projection, typed `ALREADY_PAID`, two-connection
cancel/settle convergence, and expiry/settlement lock re-read. The concurrency file passed five
consecutive runs. Full host Node `20.19.0` and target Node 24 Docker lanes each passed **393/393
tests across 71/71 files** with nested PostgreSQL Testcontainers; typecheck, lint, format check,
secret scan, build, and production audit pass. `.git` remains invalid, so proof is local and not
SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice: T125/T129.

## T125/T129 unified callback and runtime dispatch verification (2026-07-17)

T125/T129 are complete locally. Task truth is now **138 checked / 33 open / 171 rows**. The 19-case
security matrix covers every callback action shape, two-resource maximum-size token, expiry,
not-yet-valid/tamper/wrong-user/malformed cases, replay stability, weak config, and canonical IDs.
Runtime tests prove response-button resealing and cross-user rejection; acceptance proves Telegram
HTTP -> durable PostgreSQL inbox -> domain command -> responder. Production worker now composes the
distributed limiter, callback/domain ports, admin root guard, and grammY API responder. Support
mutation replay is correlation-idempotent across workers. Final host Node `20.19.0` and target Node
24 Docker lanes each passed **416/416 tests across 74/74 files** with nested Testcontainers;
typecheck, lint, format check, secret scan, build, and production audit pass. `.git` remains invalid,
so proof is local and not SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice:
T161/T162.

## T161/T162 outbox fencing verification (2026-07-17)

T161/T162 are complete locally. Task truth is now **140 checked / 31 open / 171 rows**. RED was
two dedicated failures: claim/failure inputs accepted unsafe bounds and a stale ack was omitted from
worker accounting. The four-test fencing matrix now proves generation increments on reclaim, stale
ack/fail changes zero rows, the current generation mutates once, replay mutates zero rows, invalid
inputs leave the row untouched, and stale completion is never reported as published. The drainer
uses the allowed bounded one-event ownership alternative and a database-time cutoff; production
logs expose stale fencing. The focused outbox/fulfillment lane passes **16/16 tests**. Final host
Node `20.19.0` and target Node 24 Docker lanes each pass **420/420 tests across 75/75 files** with
real nested PostgreSQL Testcontainers. Typecheck, lint, format check, secret scan, build, and
production audit pass with 0 production vulnerabilities; build output contains all five migrations.
`.git` remains invalid, so proof is local and not SHA/CI-bound. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice: T163/T164.

## T163/T164 durable AdminConfirmation verification (2026-07-17)

T163/T164 are complete locally. Task truth is now **142 checked / 29 open / 171 rows**. RED was
**0/2**: the durable command/payload columns were absent, a new callback composition could not find
the pending action, and forced audit failure exposed the consume-before-apply crash window. The
three-test durable matrix now proves restart recovery, allowlisted/redacted persistence, concurrent
idempotent confirmation, wrong-challenge rejection, payload/fingerprint tamper rejection, and
transaction rollback when audit append fails after the domain update. Focused admin/runtime lanes
pass **13/13 tests across 5/5 files**. Final host Node `20.19.0` and target Node 24 Docker lanes each
pass **423/423 tests across 76/76 files** with real nested PostgreSQL Testcontainers. Typecheck,
lint, format check, secret scan, build, and production audit pass with 0 production vulnerabilities;
build output contains all six migrations. `.git` remains invalid, so proof is local and not
SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice: T165/T166.

## T165/T166 fulfillment atomicity verification (2026-07-17)

T165/T166 are complete locally. Task truth is now **144 checked / 27 open / 171 rows**. RED was
**0/2**: forced `DigitalAssetClaimed` insert failure left AVAILABLE stock committed as READY, while
the real pre-reserved path emitted no claim event. The two-case crash matrix now proves that event
failure rolls back AVAILABLE -> RESERVED -> READY to AVAILABLE and RESERVED -> READY to RESERVED.
After fault removal, each path commits one version-matched claim event; replay remains exactly one.
Focused fulfillment/replay/concurrency/acceptance lanes pass **12/12 tests across 5/5 files**. Final
host Node `20.19.0` and target Node 24 Docker lanes each pass **425/425 tests across 77/77 files**
with real nested PostgreSQL Testcontainers. Typecheck, lint, format check, secret scan, build, and
production audit pass with 0 production vulnerabilities. `.git` remains invalid, so proof is local
and not SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice: T167/T168.

## T167/T168 bounded recovery verification (2026-07-17)

T167/T168 are complete locally. Task truth is now **146 checked / 25 open / 171 rows**. RED was a
suite-import failure because none of the five scheduled recovery batch seams existed. The dedicated
five-case PostgreSQL matrix now proves bounded deterministic Order/intent expiry, poison-isolated
reservation release, verified SePay reconciliation through the canonical matcher, supplier UNKNOWN
query-only recovery with durable retry claims, and two concurrent bundle workers that split expired
rows without resetting CONSUMED. Each class reports backlog and oldest age. The official SePay API
v2 adapter additionally proves Bearer transport, date/page/per-page bounds, response size/schema
validation, source-qualified IDs, 429 metadata, and structured-code precedence. Focused recovery
and adjacent lanes pass **28/28 tests**. Final host Node `20.19.0` and target Node 24 Docker lanes
each pass **433/433 tests across 79/79 files** with real nested PostgreSQL Testcontainers.
Typecheck, lint, format check, secret scan, build, and production audit pass with 0 production
vulnerabilities. `.git` remains invalid, so proof is local and not SHA/CI-bound. Feature 001 remains
`REQUEST_CHANGES`; canonical next slice: T169/T170.

## T169/T170 query-plan and cache verification (2026-07-17)

T169/T170 are complete locally. Task truth is now **148 checked / 23 open / 171 rows**. RED was
two real `EXPLAIN ANALYZE` failures: history chose `order_customer_idx` plus Sort, and asset claim
used a Seq Scan plus Sort. GREEN uses `order_history_customer_created_idx` and
`digital_asset_claim_idx` on pilot-sized PostgreSQL data, with no Sort node. Catalog search now uses
bounded accent-folded word-prefix `to_tsquery` backed by migration-007 GIN expression indexes;
legacy leading-wildcard `%LIKE%` is gone. The cache contract proves one authoritative load for 20
concurrent cold misses and rejects stale in-flight repopulation after invalidation. Focused
query/cache/search/claim lanes pass **24/24 tests**. Final host Node `20.19.0` and target Node 24
Docker lanes each pass **437/437 tests across 81/81 files** with real nested PostgreSQL
Testcontainers. Typecheck, lint, format check, secret scan, build, and production audit pass with
0 production vulnerabilities; build output contains seven migrations. `.git` remains invalid, so
proof is local and not SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice:
T171/T172.

## T171/T172 beneficiary identity split verification (2026-07-17)

T171/T172 are complete locally. Task truth is now **150 checked / 21 open / 171 rows**. The RED
contract run failed **3/5** on the absent bank display field, absent equality rejection, and absent
bank-name bounds. GREEN proves that `SEPAY_MERCHANT_ACCOUNT_ID` and `VIETQR_ACCOUNT_NUMBER` remain
independent validated values and cannot be configured equal. Runtime composition stores and
matches only the SePay merchant identity in `payment_intent.merchant_account_id`, while every QR
presentation path uses the separately supplied beneficiary number and carries the validated bank
display name. The deliberately distinct acceptance journey settles against the SePay identity and
renders the beneficiary account. Focused config/VietQR/payment lanes pass **25/25 tests across 4/4
files**. Final host Node `20.19.0` and target Node 24 Docker lanes each pass **442/442 tests across
82/82 files** with real nested PostgreSQL Testcontainers. Typecheck, lint, format check, secret
scan, build, and production audit pass with 0 production vulnerabilities. `.git` remains invalid,
so proof is local and not SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next slice:
T173/T174.

## T173/T174 compiled migration and honest Docker CI verification (2026-07-17)

T173/T174 are complete locally. Task truth is now **152 checked / 19 open / 171 rows**. RED was
the missing `migrate:prod` script; GREEN adds the compiled Node entrypoint and an acceptance test
that runs it against real PostgreSQL without invoking `tsx`. The Testcontainers helper keeps the
daemon probe read-only and skip-safe for unavailable runtimes, while a container that has started
but fails migration is cleaned up and rethrown as a test failure. CI now verifies `docker info`,
sets the complete config contract, builds before the compiled migration smoke, and invokes
`migrate:prod`. Host Node 20.19.0 and target Node 24 Docker each pass **444/444 tests across 83/83
files**; typecheck, lint, format check, secret scan, build, and production audit pass with 0
production vulnerabilities. `.git` remains invalid and no hosted CI run was available, so proof is
local and not SHA/CI-bound. Feature 001 remains `REQUEST_CHANGES`; canonical next work: T151–T153.

## T151 CI evidence lanes (2026-07-17)

T151 is complete at workflow level: every required static/runtime/performance lane is explicit and
JUnit evidence is uploaded even when a later step fails. Local lane proof is security **73/73**,
performance **4/4**, and full host/Node 24 **444/444**. T152 remains open because `.git` is invalid
and there is no hosted CI run/SHA to bind the artifacts to.

## Post-T153 verification supersession (2026-07-17)

After the independent review remediation loop, the corrected workflow and asset rollback guard
were reverified. Host Node 20.19.0 and target Node 24 Docker each pass **447/447 tests across
83/83 files**. Production Telegram placeholders and scanner-output leakage are covered by the
updated security lane. The Critical signed-delivery-session gap, synchronous SePay acknowledgement,
unwired production adapters/notifier/media, and invalid Git/hosted-CI provenance remain open gates;
Feature 001 stays `REQUEST_CHANGES`.

## T122/T127 official SePay compliance correction (2026-07-17)

The prior verifier-only evidence is superseded. The current source persists a redacted allowlisted
SePay envelope and raw hash in a source-qualified PostgreSQL inbox before returning exact HTTP 200
`{"success":true}`. A worker claims that inbox with bounded retries, restores the runtime evidence
brand, and is the only path that invokes settlement. Identical duplicates ACK without a second
effect; mutated provider IDs update a durable security discrepancy, and a database trigger rejects
mutation of the retained evidence fields. Structured `code` is stored separately and wins matching;
content/reference are fallbacks. Official API pagination/since_id, timeout, rate gate, VietQR
template allowlist/image URL, and Google-Sheet-as-audit-only boundaries are covered by focused
tests. Focused contract/integration proof is **23/23**; typecheck, lint, and format pass. Full
suite, external dashboard delivery, and invalid `.git`/hosted-CI provenance remain open launch
gates, so Feature 001 remains `REQUEST_CHANGES`.

## Gate 0 correction and task reopening (2026-07-17)

Spec Kit sequence completed in order: constitution check (v1.0.0 unchanged) -> specify delta ->
clarify (not required; requirements are explicit) -> plan -> checklist -> tasks -> analyze. The
source of truth now reopens T148, T171, T172, and T174 and adds T175/T176. Gate 0 task truth is
**149 checked / 26 open / 175 rows**.

The plan and contracts preserve separate SePay merchant and VietQR beneficiary keys while accepting
equal pilot values, require independent QR image/media proof, define atomic Telegram identity
bootstrap, signed delivery sessions and durable notification capability, and bind Feature 003/002
migrations to Feature 001 `009_identity_delivery_security.sql`, Feature 003
`010_notifications_quantity.sql`, and Feature 002 `011_ai_support.sql`. The older analyze result is
superseded; the current Gate 0 must be re-analyzed before implementation. The prior result had zero
unresolved Critical/High design findings. Feature 001 remains `REQUEST_CHANGES`; implementation and
release evidence are not being claimed by this Gate 0 document update.

## Slice 1 verification (2026-07-17)

T171/T172/T175/T176 are complete locally. FR-008 and FR-009/FR-009a now trace to config contract,
real Fastify/PostgreSQL acceptance, strict claimed-envelope integration, mutation flood,
lease/fencing/crash/retry/dead-letter, and canonical matcher settlement tests. Both same-value pilot
and distinct VA/sub-account paths pass. Focused proof is **15/15** and full host proof is **459/459
tests across 85/85 files**; static/build/secret/audit gates pass with 8 migrations and zero
production vulnerabilities. Slice review is 0 Critical/Major. Task truth is **153 checked / 22
open / 175 rows**. Feature 001 remains `REQUEST_CHANGES`; canonical next slice is fresh Telegram
identity onboarding.

## Gate 0 requirement traceability matrix (2026-07-17)

The previous Slice 2/3 PASS rows and the T136/T142/T180-T188 local-green claims are superseded. This
matrix deliberately covers all **57/57** FR/SR/SC identifiers. Statuses reflect the 2026-07-18
reviewer correction without claiming implementation, staging, or release approval.

| ID | Primary task(s) | Required test/evidence seam | Gate 0 status |
|---|---|---|---|
| FR-001 | T028,T034-T035 | catalog journey | covered |
| FR-002 | T025,T029-T031,T154,T157 | catalog policy exclusion | covered |
| FR-003 | T028,T034-T035 | product detail acceptance | covered |
| FR-004 | T026-T033 | deterministic/search contracts | covered |
| FR-005 | T027-T034 | catalog fact provenance | covered |
| FR-006 | T039,T046,T048,T154-T160 | Buy Now revalidation | covered |
| FR-006a | T154-T156 | stock reservation concurrency | covered |
| FR-006b | T157 | typed loser/presenter contract | covered |
| FR-006c | T155,T167 | release/recovery | covered |
| FR-006d | T158-T160 | idempotency winner-read | covered |
| FR-006e | T157,T143 | supplier-only fail-closed | covered |
| FR-007 | T039,T046,T048 | immutable Order snapshot | covered |
| FR-008 | T039-T050,T171-T172 | VietQR/payment config | covered |
| FR-008a | T148,T149 | QR image/vector/media | OPEN |
| FR-009 | T041,T047,T051-T053,T175-T176 | branded SePay evidence | covered |
| FR-009a | T175-T176 | durable ACK/claim/settlement | covered |
| FR-010 | T042,T051-T053,T061,T071-T076 | replay properties | covered |
| FR-011 | T043,T047,T049,T052-T053 | discrepancy ownership | covered |
| FR-012 | T044,T054,T057,T167 | reconciliation recovery | covered |
| FR-013 | T061,T065,T071,T076,T165-T166 | payment gate/atomic claim | covered |
| FR-014 | T059,T065-T066,T154,T157 | deterministic asset ownership | covered |
| FR-015 | T060-T061,T067-T069,T137-T138,T143-T144 | supplier contract | OPEN |
| FR-016 | T060,T067-T070,T143-T144 | supplier validation | OPEN |
| FR-017 | T062,T065,T072-T074,T146,T181-T184,T188-T189 | session/reveal transport | covered - A1 session/rotation/reveal proof |
| FR-017a | T139,T145,T179-T182,T150,T187 | durable handoff/recovery | PARTIAL - A1 crash/cleanup proof covered; T150 notifier/reconciliation open |
| FR-018 | T080,T084,T087-T088 | history BOLA/pagination | covered |
| FR-019 | T081-T083,T085-T088 | support integration | covered |
| FR-020 | T078,T081,T109,T154,T157 | replacement history | covered |
| FR-021 | T090,T094-T095,T177,T178,T182,T185,T188,T190 | numeric identity/privacy | covered - numeric identity plus verified secret-gate composition |
| FR-022 | T091,T094-T097 | no add-admin | covered |
| FR-023 | T092-T093,T096-T099 | durable confirmation | covered |
| FR-024 | T021-T022,T080-T083 | abuse/recovery lanes | covered |
| FR-024a | T121,T126,T182,T185,T188,T190 | durable inbox/privacy | covered |
| FR-025 | T161-T162,T181,T187 | owner fencing plus lease-safe notification send timeout | covered |
| FR-026 | T167-T168,T180-T181,T187 | bounded recovery | covered - orphan/refresh/cleanup batches fenced |
| FR-027 | T062,T073-T074,T146,T181-T184,T189 | crash-safe Mini App reveal | covered |
| FR-028 | T136,T142 | external vault contract | covered - focused A0 network/config proof |
| FR-029 | T115,T118,T174,T183,T186 | compiled fresh/existing boot | OPEN |
| SR-001 | T009,T019-T020,T063,T072-T074,T136,T180,T182,T185,T188 | redaction/secret scan | covered - A0/A1 redaction and anti-reuse proof |
| SR-002 | T041-T044,T051-T054 | timestamp/integrity | covered |
| SR-003 | T062,T073-T074,T080,T084,T184,T189 | ownership/session | covered |
| SR-004 | T021-T022,T027,T041,T060,T067-T069,T136,T137,T142,T143,T150 | boundary limits | REOPENED/OPEN - vault then supplier/media |
| SR-005 | T019-T020,T077,T092-T099,T187 | immutable audit plus durable cleanup provenance | PARTIAL - compensation ledger proves recovery state; explicit cleanup audit-event assertion remains residual |
| SR-006 | T017-T018,T042,T061,T071-T076,T105,T140-T141,T150,T179-T182,T187 | crash/recovery | PARTIAL - A1 compensation/lease recovery covered; T140/T141/T150 open |
| SR-007 | T025,T029,T037,T111 | resale authorization | covered |
| SR-008 | T102-T114,T151-T153 | launch sign-off | OPEN |
| SC-001 | T028,T038 | product discovery timing | covered |
| SC-002 | T028,T038 | action count | covered |
| SC-003 | T104 | pilot interaction load | covered |
| SC-004 | T064,T077,T104,T150,T179,T181,T184 | paid-to-capability timing | PARTIAL - A1 refresh covered; T150 runtime timing open |
| SC-005 | T042,T061,T079,T137-T144,T150,T179-T182,T187 | 100 replay convergence | PARTIAL - A1 convergence covered; supplier/notifier open |
| SC-006 | T059,T066,T079 | final asset concurrency | covered |
| SC-007 | T019,T063,T103,T136,T140,T142,T180,T182,T185,T188 | credential/secret scans | PARTIAL - A0/A1 covered; T140 outage/reveal proof open |
| SC-008 | T043-T044,T052-T058 | discrepancy matrix | covered |
| SC-009 | T090-T100 | sole-admin impersonation | covered |
| SC-010 | T101,T113,T183,T185 | task/test traceability | covered |
| SC-011 | T169-T170,T154-T157 | checkout/load/query evidence | covered |

**Coverage**: 57/57 identifiers have a primary task and a named seam. Rows marked OPEN/PARTIAL are
still blockers. Current task truth after A1 closeout is **172 checked / 15 open / 187 rows**.
T185/T190 remain checked for core privacy/pruning, and T182/T188 now provide the verified Telegram
secret-gate composition proof. The overall Feature 001 verdict is `REQUEST_CHANGES`.

## A1 delivery compensation/rotation verification (2026-07-18)

T180/T181/T182/T187/T188 are checked after current-run RED evidence, sequential **75/75** focused
GREEN with real PostgreSQL/Testcontainers, passing typecheck/lint/format/secret/build/audit, and
independent Spec, Security/Concurrency, and Regression re-review with **0 Critical / 0 High inside
A1**. FR-017, FR-025, FR-026, and the A1 portion of FR-017a/SR-006 are covered. T150 and later
supplier/notifier/staging/release seams remain OPEN/PARTIAL; SR-005 explicitly retains the residual
cleanup audit-event observation. Task truth is **172 checked / 15 open / 187**, and the overall
verdict remains `REQUEST_CHANGES`.

