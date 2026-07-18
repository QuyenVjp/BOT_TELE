# Requirement Traceability: Telegram Shop Digital MVP

| Requirement | Primary tasks | Test/evidence seam |
|---|---|---|
| FR-001 | T028, T034–T035 | `catalog-journey.test.ts` |
| FR-002 | T025, T029–T031 | `catalog-repository.test.ts` |
| FR-003 | T028, T034–T035 | `catalog-journey.test.ts` |
| FR-004 | T026–T027, T031–T033 | `catalog-search.test.ts`, `search-parser.test.ts` |
| FR-005 | T027–T028, T032–T034 | parser and catalog acceptance fixtures |
| FR-006 | T039, T046, T048 | `buy-now.test.ts` |
| FR-007 | T039, T046, T048 | immutable snapshot assertions |
| FR-008 | T039–T040, T047–T050 | Buy Now and VietQR contract tests |
| FR-009 | T041, T047, T051–T053 | signed SePay webhook contract |
| FR-010 | T042, T051–T053, T061, T071–T076 | payment/fulfillment replay properties |
| FR-011 | T043, T047, T049, T052–T053 | discrepancy integration test |
| FR-012 | T044, T054, T057 | reconciliation recovery test/alerts |
| FR-013 | T061, T065, T071, T076 | fulfillment guard/recovery tests |
| FR-014 | T059, T065–T066 | final-asset concurrency property |
| FR-015 | T060–T061, T067–T069 | supplier unknown/query-before-retry contract |
| FR-016 | T060, T067–T070 | malformed/invalid asset contract fixtures |
| FR-017 | T062, T065, T072–T074 | Delivery Bundle security tests |
| FR-018 | T080, T084, T087–T088 | Order history BOLA/pagination tests |
| FR-019 | T081–T083, T085–T088 | support integration/acceptance tests |
| FR-020 | T078, T081, T109 | replacement/refund preservation tests/runbook |
| FR-021 | T090, T094–T095 | numeric root identity security test |
| FR-022 | T091, T094–T097 | no-add-admin capability test |
| FR-023 | T092–T093, T096–T099 | action confirmation/audit tests |
| FR-024 | T021–T022, T080–T083 | ingress abuse and recovery-route tests |
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
