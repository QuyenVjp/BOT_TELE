# Superseding Independent Review — REQUEST_CHANGES

**Date**: 2026-07-16  
**Verdict**: `REQUEST_CHANGES`  
**Authority**: This section supersedes the earlier T114 pilot recommendation below.

Three independent read-only reviewers plus a root verification pass found production-blocking
implementation gaps. The complete evidence and remediation order are recorded in
[`remediation-review.md`](./remediation-review.md). The earlier claim that no further Critical/High
code changes are required is withdrawn. Feature 001 is not runnable or pilot-ready until tasks
T115–T153 pass and a new independent review binds evidence to a real commit/CI run.

**Historical 2026-07-17 T154–T157 checkpoint (superseded below)**: 333 tests / 64 files passed on the
host and Node 24.18.0 container after build; work then stopped before T158 for re-review.

**2026-07-17 Gate 0 status**: T158–T160 are complete locally and the task truth is **129 checked / 42
open / 171 rows**. The independent T158–T160 review returned `REQUEST_CHANGES` for stale artifact
status, an exported unsigned checkout method, callback-key production hardening, and incorrect
migration numbering. Those four Gate 0 findings are now corrected. A fresh host gate passed
**361/361 tests across 68/68 files** plus typecheck, lint, format check, secret scan, build, and
production audit (0 production vulnerabilities). The Node 24 lane was not rerun in this correction
pass, `.git` remains invalid, no SHA/CI provenance exists, and the broader implementation backlog is
open. This review therefore remains `REQUEST_CHANGES`; canonical next slice: T121/T126.

### T121/T126 slice review — APPROVE (2026-07-17)

**Target**: T121/T126 durable Telegram ingress and distributed abuse-control slice (manual target;
invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic). The review first
returned `REQUEST_CHANGES`, then verified corrections for group callback context, durable mutation
evidence, all-action budgets, required durable app composition, bounded retention, and safe telemetry.

- Verification: 10/10 focused PostgreSQL tests; concurrency lane repeated; full host and Node 24
  suites each **371/371 across 69/69**; typecheck, lint, format check, secret scan, build, packaged
  migration, and production audit pass.
- Accepted findings fixed: 4. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: approval covers durable receipt, claims/retries, action budgets, retention, and
  processor port. It does not approve the full Telegram business dispatcher (T125/T129), SePay, or
  Feature 001.

### T122/T127 slice review — APPROVE (2026-07-17)

**Target**: verified SePay runtime ingress, branded evidence boundary, provider replay/mutation
behavior, and production composition (manual target; invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic). The review first
returned `REQUEST_CHANGES`, then verified startup trust-config validation and fail-closed handling
of typed settlement failures.

- Verification: focused contract/config/payment lanes; full host and target Node 24 suites each
  **382/382 across 70/70** with nested Testcontainers; typecheck, lint, format check, secret scan,
  build, and production audit pass.
- Accepted findings fixed: 2. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: approval covers verified ingress and durable provider acknowledgement. Atomic
  cancel/settle locks, typed `ALREADY_PAID`, and invalid/future evidence time remain T124/T124a/T128.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T124/T124a/T128.

### T124/T124a/T128 slice review — APPROVE (2026-07-17)

**Target**: runtime verified-evidence boundary, duplicate mutation policy, transaction-time policy,
and cancel/expire/settle concurrency (manual target; invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic). RED exposed five
money-safety failures: forgeable evidence, future settlement, untyped paid cancellation,
stale-version cancel race, and expiry/settlement deadlock. Review then verified a private runtime
brand, strict provider date parsing, bounded future rejection, one Order-to-Intent lock order, and
locked re-read in every competing transition.

- Verification: 11/11 dedicated PostgreSQL tests, five repeated concurrency runs, and full host and
  target Node 24 suites each **393/393 across 71/71** with nested Testcontainers.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass; 0
  production vulnerabilities.
- Accepted findings fixed: 5 groups. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: approval covers payment evidence and transition races. Full callback adoption and
  grammY/domain dispatch remain T125/T129.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T125/T129.

### T125/T129 slice review — APPROVE (2026-07-17)

**Target**: unified callback integrity/adoption and durable Telegram runtime dispatch (manual target;
invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic). Review verified
all action/resource schemas, identity binding, expiry, Telegram size, response resealing, production
worker composition, action-aware abuse budgets, grammY sending, and replay behavior.

- Verification: 19-case token security matrix, dispatcher integration, built worker smoke, and
  HTTP->PostgreSQL->domain->responder acceptance.
- Full host and target Node 24 suites each pass **416/416 across 74/74** with nested Testcontainers;
  typecheck, lint, format check, secret scan, build, and production audit pass.
- Accepted findings fixed: canonical resource validation, runtime worker composition,
  action-budget classification, and support replay dedupe. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: outbox fencing, durable admin consume+mutation, full Telegram photo/edit retry,
  and remaining production launch adapters retain their own open tasks.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T161/T162.

### T161/T162 slice review — APPROVE (2026-07-17)

**Target**: outbox owner+generation fencing and bounded one-event draining (manual target; invalid
`.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic).

- Spec: migration `005_outbox_fencing.sql`, generation increment, owner+generation ack/fail
  predicates, and the bounded one-event alternative satisfy the canonical T161/T162 contract.
- Regression: all repository call sites carry the full claim; focused outbox/fulfillment tests pass
  **16/16** and final host/Node 24 suites each pass **420/420 across 75/75**.
- Security: batch/owner/lease/error/attempt inputs are bounded before mutation, error labels are
  capped, SQL values are parameterized, and no secret-bearing data enters telemetry.
- Skeptic: an expired worker can neither publish nor fail a reclaimed row; stale results are counted
  explicitly, and deterministic `occurred_at, id` ordering removes same-time claim ambiguity.
- Static/build evidence: typecheck, lint, format check, secret scan, build, and production audit all
  pass; production audit reports 0 vulnerabilities.
- Accepted findings fixed: unbounded inputs, false-success worker accounting, and deterministic
  tie ordering. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: durable admin confirmation, recovery jobs, fulfillment atomicity, external
  adapters, delivery UX, and release provenance retain their open tasks.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T163/T164.

### T163/T164 slice review — APPROVE (2026-07-17)

**Target**: durable allowlisted AdminConfirmation and atomic high-risk execution (manual target;
invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic).

- Spec: migration 006 persists `allowlisted_command_ref` and `payload_redacted`; no process-local
  pending map remains, and the production callback uses the atomic service path required by FR-023.
- Regression: legacy aggregate tests, owner operations, Telegram dispatch/acceptance, and the new
  durable matrix pass **13/13**; final host/Node 24 suites each pass **423/423 across 76/76**.
- Security: numeric root/private context remains the authorization key; command ref is constrained,
  challenge comparison stays constant-time, payload fields are bounded, and actor/fingerprint
  mutation fails closed without consuming.
- Skeptic: a database trigger forces audit failure after the discrepancy update and proves both the
  domain row and confirmation roll back; concurrent correct confirms produce one effect/audit and
  idempotent success for the waiter.
- Static/build evidence: typecheck, lint, format check, secret scan, build, and production audit all
  pass; production audit reports 0 vulnerabilities and build packages six migrations.
- Accepted findings fixed: payload/fingerprint binding, input bounds, deny-audit target typing, and
  explicit state-machine transition ordering. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: fulfillment atomicity, recovery jobs, external adapters, delivery UX, query
  indexes, production packaging, and release provenance retain their open tasks.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T165/T166.

### T165/T166 slice review — APPROVE (2026-07-17)

**Target**: local asset claim/promotion and `DigitalAssetClaimed` transactional integrity (manual
target; invalid `.git` prevents a diff range).

**Mode**: Harness four-angle `manual-pass` (Spec, Regression, Security, Skeptic).

- Spec: AVAILABLE and normal pre-reserved fulfillment paths both commit the READY state and claim
  event in one transaction, satisfying FR-013 and T165/T166.
- Regression: claim concurrency, fulfillment recovery/handler replay, and end-to-end fulfillment
  pass **12/12**; final host/Node 24 suites each pass **425/425 across 77/77**.
- Security: outbox payload retains only IDs, correlation, and an opaque vault reference; no secret
  is revealed, and transaction-only APIs prevent lock loss from accidental autocommit use.
- Skeptic: a PostgreSQL trigger fails exactly at `DigitalAssetClaimed` insertion for AVAILABLE and
  RESERVED entry states; both prior states are restored, retry commits one event, and replay stays
  at one version-matched event.
- Static/build evidence: typecheck, lint, format check, secret scan, build, and production audit all
  pass; production audit reports 0 vulnerabilities.
- Accepted findings fixed: skipped pre-reservation event, hard-coded event version, nondeterministic
  claim tie ordering, and historical READY-without-event repair. Rejected findings: 0.
- Slice verdict: `APPROVE`, **0 Critical / 0 Major**.
- Scope boundary: bounded recovery jobs, external vault/supplier/notifier adapters, delivery UX,
  query indexes, production packaging, and release provenance retain their open tasks.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T167/T168.

### T167/T168 slice review — APPROVE (2026-07-17)

- Target: the T167/T168 recovery implementation, official SePay read boundary, worker composition,
  dedicated RED/GREEN tests, and superseding evidence sections. `.git` is invalid, so review is
  file-scoped rather than commit/diff-scoped.
- Spec pass (`manual-pass`): all five recovery classes are bounded and deterministic; Order expiry
  voids intents/releases holds atomically, supplier UNKNOWN only queries, SePay uses verified API
  evidence and the canonical matcher, and bundle expiry leaves CONSUMED terminal.
- Regression pass (`manual-pass`): focused recovery/adjacent lanes pass 28/28; the full host and
  target Node 24 lanes each pass 433/433 tests across 79/79 files.
- Security pass (`manual-pass`): SQL remains parameterized; external inputs have batch, URL, timeout,
  body, schema, and page caps; the API credential is environment-only/redacted; malformed/429
  responses fail closed; structured payment code takes precedence over noisy content.
- Skeptic pass (`manual-pass`): concurrent bundle workers split rows via SKIP LOCKED, supplier claims
  persist a retry deadline before network I/O, the SePay class is fenced by a database advisory
  lock, poison rows cannot abort later work, and backlog/oldest-age telemetry remains truthful.
- Accepted findings fixed before approval: SePay reconciliation previously did not catch thrown
  per-evidence failures; the production worker initially lacked an official API port; and ingress
  discarded structured `code`. All three now have regression tests.
- Rejected findings: no Critical/Major finding remained after direct source and runtime checks.
- Verdict: **APPROVE**, **0 Critical / 0 Major**.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T169/T170.

### T169/T170 slice review — APPROVE (2026-07-17)

- Target: migration `007_hot_indexes.sql`, customer-history and asset-claim query plans, catalog
  search, cache single-flight behavior, tests, and superseding evidence. `.git` is invalid, so the
  review is file-scoped.
- Spec pass (`manual-pass`): both requested hot paths are verified with real `EXPLAIN ANALYZE`, the
  composite indexes match the exact keyset/order predicates, and catalog/cache behavior preserves
  authoritative results under bounded search and concurrent invalidation.
- Regression pass (`manual-pass`): focused query/cache/search/claim lanes pass 24/24; full host and
  target Node 24 lanes pass 437/437 tests across 81/81 files.
- Security pass (`manual-pass`): search tokens are Unicode-tokenized and parameterized before
  `to_tsquery`; expression indexes contain no secrets; cache remains advisory and cannot override
  PostgreSQL truth; migrations are forward-only and idempotent.
- Skeptic pass (`manual-pass`): plans prove no Sort/Seq Scan on pilot data, the asset lock order is
  unchanged, and stale cache results cannot overwrite a newer invalidation version.
- Accepted findings fixed before approval: missing composite indexes, leading-wildcard search, and
  cache stampede/stale in-flight repopulation. Rejected findings: no Critical/Major finding remained.
- Verdict: **APPROVE**, **0 Critical / 0 Major**.

Feature 001 verdict remains `REQUEST_CHANGES`. Canonical next slice is T171/T172.

---

# Prior Independent Code / Security Review (T114, superseded)

**Date**: 2026-07-16
**Scope**: Phases 1–8 of `specs/001-telegram-shop-mvp` as implemented in `src/` and proven by
`tests/`. Residual risk is recorded for the pilot owner.

## Method

- Cross-check every FR/SR/SC against its mapped test/evidence seam (`traceability.md`).
- Re-read STRIDE disposition (`security-review.md`) against the actual modules for root-admin,
  payment settlement, fulfillment, delivery, support, and vault.
- Run the full automated suite, static gates, secret scan, and dependency audit.
- Inspect residual launch gates that engineering cannot self-close.

## Results

| Check | Result |
|---|---|
| Full suite | Superseded; final-source rerun pending |
| Typecheck / lint / format | Superseded; remediation baseline is RED |
| Secret scan | Final-source rerun pending |
| Dependency audit (production dependencies) | Final-source rerun pending |
| SBOM | `evidence/sbom.json` (9 production components) |
| FR/SR/SC coverage | 42/42 mapped and exercised |
| Critical / High open findings | Superseded; Feature 001 remains REQUEST_CHANGES |

## Residual risk (accepted for pilot only when gates are signed)

1. **Telegram platform policy (SEC-015 / G5).** The VietQR digital-goods flow is intentionally not
   disguised. Production must not open until the owner records an explicit decision (approval,
   channel change, or product change). Residual: regulatory / platform enforcement risk.
2. **Upstream account provenance (SEC-014 / G2).** In-app validation and quarantine exist; per-SKU
   human authorization is still a process gate. Residual: selling an unauthorized SKU if the gate
   is skipped.
3. **External vault not yet wired (G6).** Production config fails closed without it; residual is
   operational (cannot go live with the memory driver), not a silent secret-in-DB risk.
4. **Container image not yet published (G7).** Source-based pilot is fine; residual is the OS
   surface of whatever base image is eventually chosen — must be scanned before production.
5. **Production-sized restore not yet drilled (G8).** Pilot-scale RPO/RTO targets are defined;
   residual is unconfirmed recovery time under real data volume.
6. **Manual bank refund in pilot (FR-020).** Request/approval/evidence/reconciliation are recorded;
   residual is human error in the out-of-band bank step, mitigated by audit + dual evidence.

## Strengths observed

- Fail-closed authorization: numeric root id only; username never a key; no add-admin path.
- Exactly-once effects: inbox/outbox + unique business keys + version guards + SKIP LOCKED.
- Secret hygiene: vault refs only; strict Zod at every untrusted boundary; allowlisted telemetry;
  safe-summary redaction on the support path.
- Ownership (BOLA) enforced on history, tickets, and delivery reveal; foreign ids return null /
  generic failure with no existence oracle.
- High-risk owner actions require private context + expiring confirmation + non-empty reason +
  append-only audit.

## Recommendation

**Ship to pilot** only after G1–G9 in `launch-gates.md` carry dated owner sign-off. No further code
change is required to close a Critical or High finding. Residual risks above are process / external
dependencies, not latent defects in the implemented control plane.

## T171/T172 beneficiary identity split review (2026-07-17)

- Spec pass: configuration, settlement matching, QR rendering, and presenter wiring now have
  separate explicit contracts; equality between SePay identity and VietQR beneficiary is rejected.
- Regression pass: the new config contract is green, the acceptance journey uses deliberately
  distinct values, and host/Node 24 full suites pass **442/442 tests across 82/82 files**.
- Security pass: no merchant identity is silently reused as a QR account; bank display name is
  bounded, non-blank, and not a settlement assertion; secret scan and production audit are clean.
- Skeptic pass: fresh, reused, and insert-race payment presentation paths all use the explicit
  beneficiary account; verified evidence still matches the persisted SePay identity.
- Verdict: **APPROVE**, **0 Critical / 0 Major**. `.git` is invalid, so no commit/SHA/CI provenance
  claim is made. Feature 001 remains `REQUEST_CHANGES` until external launch gates close; next
canonical slice is T173/T174.

## T173/T174 compiled migration and Docker CI review (2026-07-17)

- Spec pass: production migration has a compiled-only contract and Docker availability is treated
  as an environment gate, not a code-success shortcut.
- Regression pass: migration acceptance, host full suite, and Node 24 Docker full suite pass
  **444/444 tests across 83/83 files**.
- Security pass: `migrate:prod` does not load `tsx`; connection strings remain environment-only;
  CI receives sanitized fixtures and no live provider credential.
- Skeptic pass: started-container failures are rethrown after cleanup, and the workflow explicitly
  probes Docker before Testcontainers lanes.
- Verdict: **APPROVE**, **0 Critical / 0 Major**. No hosted CI run or valid Git SHA exists locally;
Feature 001 remains `REQUEST_CHANGES` and T151–T153 remain external-evidence gates.

## T153 independent multi-angle review and remediation (2026-07-17)

Review mode: `manual-pass` with three read-only agents (Spec/Plans, Security, Regression/Skeptic);
`.git` invalid, so no diff/SHA/CI provenance was used.

### Verdict: REQUEST_CHANGES

- **Critical — delivery BOLA:** `src/modules/digital-goods/delivery-route.ts:58-64` accepts
  caller-controlled `x-customer-id`; FR-027/SR-003 require a signed Telegram-bound session.
- **Major — synchronous SePay settlement:** `src/main.ts:40-46` awaits `applyPaymentEvidence`
  from the HTTP route instead of durable insert/quick ack/async worker processing.
- **Major — production fulfillment unavailable:** external vault remains fail-closed/unwired;
  `SUPPLIER_DRIVER=http` resolves to null; notifier is absent and its dormant path used order id
  as customer id (`src/worker.ts:119-140`, `src/modules/digital-goods/handlers.ts:96`).
- **Major — QR/Telegram media incomplete:** no QR image generation or `sendPhoto`/edit path;
  T149/T150 remain open.
- **Major — release evidence:** invalid `.git`, no hosted CI run, and previously exposed
  credentials still require rotation/injection before any production claim.

Post-review fixes verified in this run: Build now precedes acceptance in CI; production rejects
documented Telegram placeholders; secret scan reports only rule/file/line; and failed
`markAssetDelivered` rolls back bundle consumption/completion (new security regression test).
Verification: host and Node 24 Docker **447/447 tests, 83/83 files**; typecheck/lint/format/secret
scan/build/audit pass. T153 remains open until the Critical/Major findings and external provenance
gates are closed; Feature 001 remains `REQUEST_CHANGES`.

## SePay official-compliance re-review (2026-07-17)

The synchronous-SePay finding above is superseded for the payment slice. `main.ts` now composes a
durable `source='sepay'` inbox; the route verifies and persists a redacted immutable evidence copy
before returning exact HTTP 200 success, while `worker.ts` claims and applies evidence with bounded
retries. Duplicate mutation creates a payments-security discrepancy, and structured provider code
is the primary matcher key. Focused contract/integration proof is **23/23** with typecheck/lint/
format green. This closes only the SePay ingress correction; the signed delivery-session, external
vault/supplier/notifier/media, and invalid Git/hosted-CI findings above remain open, so the overall
Feature 001 verdict is still `REQUEST_CHANGES`.

## Gate 0 artifact re-review (2026-07-17)

The required Spec Kit order is now reflected in the artifacts: constitution check, specify delta,
no-clarify-needed decision, plan, checklist, tasks, and analyze. T148/T171/T172/T174 are explicitly
reopened, T175/T176 own the durable SePay lifecycle, and later Feature 003/002 migration names are
009/010. Gate 0 has zero unresolved Critical/High design findings, but this is not implementation
approval: delivery BOLA, fresh identity, notification, vault, supplier, QR/media, compiled runtime,
and Git/hosted-CI findings remain open. Overall Feature 001 verdict stays `REQUEST_CHANGES`.

## Slice 1 SePay/VietQR review (2026-07-17)

Review target: the Gate 0 + T171/T172/T175/T176 working snapshot, because `.git` is invalid and no
commit diff can be pinned. Manual Harness-equivalent passes covered Spec, Security, Concurrency,
and Regression/TDD. The implementation uses a real PostgreSQL/Fastify acceptance seam, does not
restore the trust brand before strict hash/payload/time validation, and mutation alerting is atomic
and replay-flood idempotent. Full host suite is **459/459 across 85 files** and all static/build/audit
gates pass.

Slice verdict: **APPROVE, 0 Critical/Major for Slice 1**. Overall Feature 001 verdict remains
`REQUEST_CHANGES` because fresh identity, signed delivery, notification, vault, supplier, QR/media,
compiled runtime, and Git/hosted-CI gates remain open.

## Gate 0 correction review after Slice 2–3 re-review (2026-07-17)

The former Slice 2 and Slice 3 `APPROVE`/zero-Critical-Major claims are removed and superseded.
The working snapshot is **REQUEST_CHANGES**. `.git` is invalid, so no fixed-point diff/SHA can be
claimed; review is a read-only Harness/Matt Standards+Spec manual pass over the source-of-truth
delta.

Findings that block implementation:

- **HIGH** — mutable 008 now contains identity/delivery DDL even though SePay-only 008 may already
  be applied; migration 009 compatibility and collision runbook are missing.
- **HIGH** — a successful Bundle commit can be followed by a crash before handoff creation, losing
  the only plaintext capability and allowing premature outbox acknowledgement.
- **HIGH** — vault write is performed inside a long PostgreSQL transaction; DB rollback compensation
  and bounded orphan cleanup are not proven.
- **HIGH** — dedicated delivery key configuration, previous-key grace, expiry refresh, and
  claim-to-handoff verification are incomplete.
- **HIGH** — Telegram notification transport has no customer-usable Mini App redemption and cannot
  rely on URL buttons to attach Authorization headers.
- **HIGH** — `actorUsername` is retained in durable inbox data and bootstrap can copy expected
  username metadata; retention/pruning and verified-observation boundaries are incomplete.

T145/T146/T178 are reopened. T139/T177 remain checked only for their previously proven narrow
scopes. No code implementation may proceed until Spec Kit analyze reports zero unresolved
Critical/High design findings. Overall verdict remains **REQUEST_CHANGES**.

## Post-Gate 0 focused implementation review (2026-07-17)

Verdict: **REQUEST_CHANGES**.

- Spec/plan: the source changes stay inside Feature 001 and match the approved migration,
  identity-privacy, and delivery-key design; Feature 003/AI/wallet/reseller code was not started.
- Security: the delivery key no longer reuses the Buy Now callback secret, previous-key acceptance
  is version-bound, and durable Telegram inbox rows no longer retain `actorUsername`.
- Migration: the false-green was reproduced with exact historical expanded-008 constraints/indexes
  and real delivery rows. The RED test failed on the missing PROCESSING lease index. Migration 009
  now drops/recreates the old RETRY-only due index, adds a separate PROCESSING lease-expiry index,
  and compiled 5/5 asserts row preservation, constraints, and `pg_get_indexdef()`. T183/T186 re-close.
- Regression: the first full-host run caught five capability-key/username-path regressions; targeted
  fixes passed 6/6, then the full rerun passed 473/473 across 88 files. Compiled migration is 5/5;
  typecheck, lint, format, secret scan, build, and production audit pass. No Node 24, staging, SHA,
  or hosted-CI claim is made in this slice.
- Blocking findings remain: crash-after-Bundle-before-handoff, vault-write/DB-rollback compensation,
  expired-session refresh, Mini App redemption/Telegram send wiring, username observation pruning,
  external vault/supplier/media adapters, and release provenance.

The review therefore cannot approve Slice 2–3 or Feature 001. Overall verdict remains
**REQUEST_CHANGES**.

## T179-T190 superseding review (2026-07-17)

Verdict: **REQUEST_CHANGES**.

- Spec/Plans: T179-T190 stay within Feature 001 and implement the approved crash, migration,
  session-rotation, Mini App, and username-retention contracts. Feature 003, AI, wallet/top-up,
  and Reseller API were not started. The traceability matrix remains complete at **57/57**.
- Migration: the historical expanded-008 false-green is closed with real rows, old constraints,
  exact old index definitions, explicit index replacement, a separate PROCESSING lease index,
  collision rollback, and compiled **5/5** acceptance.
- Delivery security: Bundle-to-handoff recovery, vault-write compensation, one-live-capability
  convergence, current/previous delivery keys, expired-session refresh, claim binding, and bounded
  cleanup are covered by real PostgreSQL tests. Mini App redemption does not assume Telegram sends
  an Authorization header and rejects replay, BOLA, tampered/expired auth, and wrong audience.
- Identity/privacy: root bootstrap uses only numeric Telegram identity; durable inbox storage strips
  `actorUsername`; only authenticated webhook observations update metadata; the worker runs bounded
  retention pruning.
- Regression evidence: host Node 20.19.0 passes **484/484 tests across 92/92 files**. Typecheck,
  lint, format check, secret scan, build, production audit, and compiled migration **5/5** pass.
  The verification pass found and fixed one unused test import and one secret-scan fixture pattern;
  the affected Mini App acceptance was rerun before the full suite.

Blocking Critical/High release work is still represented by open tasks T115/T118, T136-T144,
T147-T150, T152/T153, and T174. In particular, no real external-vault runtime, authenticated HTTP
supplier, Telegram media/notifier worker drain, independent QR scan proof, compiled true-staging
journey, Node 24 rerun, valid Git SHA, or hosted CI evidence exists. T153 stays open. No Slice 2-3,
staging, pilot, or production APPROVE claim is made.

## T136/T142 external-vault review (2026-07-17)

Verdict: **REQUEST_CHANGES** overall; **0 Critical / 0 High within the T136/T142 slice**.

- Spec axis: the new HTTP contract covers FR-028/SR-001/SR-004 with authenticated bounded
  health/write/reveal/delete operations, deterministic retry keys, deployment plus asset/capability
  provenance, strict schemas, timeout/retry, and generic redacted failure semantics.
- Standards/security axis: the adapter rejects non-HTTPS non-loopback endpoints, foreign namespace
  refs, oversized material/responses, non-JSON responses, and provider ref substitution. It never
  includes endpoint, bearer token, material, or provider body in an error. Transient retry reuses the
  same path, so it cannot mint a second secret.
- Runtime axis: main and worker perform a fail-closed vault startup probe. `/ready` probes database
  and vault; `/health` remains dependency-free. A real loopback HTTP provider proves network/auth/
  retry behavior; this is not a mock-only completion.
- Regression axis: final host Node 20.19.0 passes **492/492 tests across 93/93 files**; all static,
  format, secret, build, and production-audit gates pass.

The feature verdict cannot change: no owner-provisioned staging vault endpoint/readiness evidence is
bound to a valid Git SHA, and T140 plus supplier, Telegram media, QR scan, compiled runtime, Node 24,
hosted CI, and final-review tasks remain open. `.git` is still invalid, so Matt's fixed-point diff
review was reproduced as explicit manual Spec/Standards passes rather than claimed as a commit diff.

## Reviewer false-green correction (2026-07-18)

Verdict: **REQUEST_CHANGES**.

The prior T136/T142 slice approval is withdrawn. Review of the actual source found the following
High gaps relative to the strengthened contracts:

- the timeout was cleared after response headers, so slow body streaming/parsing was unbounded;
- chunked responses were accumulated by `response.text()` before the byte limit was checked;
- write validation measured material rather than the exact serialized UTF-8 request body;
- redirects and endpoint/egress re-resolution were not proven fail closed;
- accepted/error response body finalization and exact-max material envelope behavior were incomplete;
- compensation could lose an orphan ref when database swap and vault delete both failed;
- refresh crash windows, deterministic generation identity, explicit previous-key grace deadline,
  mandatory production session verification, cross-domain key reuse, and Telegram secret-gate
  username composition were not proven.

T136/T142/T180/T181/T182/T187/T188 are reopened. T185/T190 retain only their narrow core scope.
Current truth is **165 checked / 22 open / 187 rows**. No implementation or verification claim is
accepted for A0/A1 until the new RED tests fail for the intended reason and focused PostgreSQL/network
tests pass after correction. Feature 001 and T153 remain **REQUEST_CHANGES**.

Gate 0 re-review confirms the corrected source-of-truth has **0 unresolved Critical/High design
findings**, complete **57/57** requirement mapping, and exact task truth **165/22/187**. That is
authorization only for A0 RED; it is not approval of the reopened implementation or release state.

## A0 T136/T142 corrected external-vault review (2026-07-18)

Verdict: **REQUEST_CHANGES overall**; **0 unresolved Critical / High inside the A0 scope**.

Review target is the explicit A0 file set because `.git` is invalid and no fixed-point diff can be
resolved. Harness/Matt review therefore used a four-angle `manual-pass` against
`contracts/external-vault.md`, T136/T142, and the recorded RED/GREEN commands.

- Spec: streamed response timeout ownership, bounded chunk counting, exact serialized request
  sizing, strict schemas, endpoint normalization, redirect refusal, DNS re-resolution plus pinned
  egress, exact-max material, response finalization, readiness composition, and secret-domain
  separation are implemented at the contract seams.
- Standards/quality: request bodies are serialized once, retry identity is stable, non-transient
  failures stop after one call, and validation errors expose only generic messages. The initially
  suspected URL bug was proven with `new URL("//healthz", base)` behavior and fixed surgically.
- Security/skeptic: loopback HTTP is reachable only through direct test injection; production env
  requires explicit host/port/CIDR policy; mixed or changed DNS answers fail closed; redirects never
  receive bearer/body; current/previous delivery keys cannot equal Telegram, BuyNow, SePay, vault,
  or supplier secrets.
- Regression/TDD: RED evidence includes the intended 16-boundary failure set, the missing adapter
  egress wiring, and a separate 3-call non-transient retry failure. GREEN is 55/55 across the four
  focused files; typecheck, lint, and focused Prettier checks pass on host Node 24.15.0.

No full-host/Docker/build/secret/audit/staging/SHA/CI evidence was run for this closeout. A1 crash
compensation/key-grace/secret-gated composition, supplier, delivery completion, QR/media, compiled
staging, and release gates remain Critical/High work under open tasks. T153 remains last and overall
Feature 001 remains **REQUEST_CHANGES**. Task truth: **167 checked / 20 open / 187**.

## A1 T180-T182/T187-T188 corrected delivery review (2026-07-18)

Verdict: **REQUEST_CHANGES overall**; **0 unresolved Critical / High inside A1**.

The review target is the explicit A1 source/test/artifact set because `.git` remains invalid.
Harness/Matt review used independent Spec/Traceability, Security/Concurrency, and
Regression/Skeptic agents, followed by correction and re-review:

- Spec: inactive PREPARED sessions, deterministic initial/refresh generations, bounded previous-key
  grace, real Mini App reveal denial, durable orphan/terminal cleanup, and pre-send persisted claim
  matching align with FR-017/FR-017a/FR-025/SR-006.
- Security/concurrency: stale lease owners affect zero ACK/fail rows; send timeout is below the
  notification lease; terminal refs enter the child ledger under `SKIP LOCKED`; cleanup adoption is
  fenced; delayed backoff survives re-tombstone; cleanup ownership exceeds the bounded vault delete
  retry budget.
- Regression/TDD: current-run RED captured stale ACK/fail, recipient drift, concurrent cleaner,
  missing terminal compensation, operation-generation, and exact grace-boundary failures. Sequential
  GREEN is **75/75 across 8 files** with real Docker/PostgreSQL, and no required test in this lane is
  skipped.
- Static/build: typecheck, lint, format check, secret scan, build, and production audit pass; build
  packages **10 migrations**, and production audit reports **0 vulnerabilities**.

Residual non-blocking observations are explicit cleanup audit-event coverage (traceability SR-005
remains PARTIAL) and generic `Error` telemetry classification. T174's Docker pass-via-return harness,
T150 production Telegram notifier/reconciliation, supplier, delivery completion, QR media, true
staging, Node 24/full-host, Git/SHA/hosted CI, rotated credentials, and G1-G9 owner decisions remain
outside A1 and open. Task truth is **172 checked / 15 open / 187**. T153 stays last; Feature 001 is
not staging/pilot/production ready and remains **REQUEST_CHANGES**.

