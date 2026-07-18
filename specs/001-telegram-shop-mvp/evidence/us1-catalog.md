# US1 Catalog Evidence (T038)

**Date**: 2026-07-16
**Scope**: User Story 1 — Find and Understand a Product (FR-001–FR-005, SC-001/SC-002)

## Acceptance lane

Command:

```bash
npx vitest run tests/acceptance/catalog-journey.test.ts
```

Result (recorded after Phase 3 implementation):

```
✓ tests/acceptance/catalog-journey.test.ts (7 tests)
  ✓ presents a retail-only main menu (FR-001)
  ✓ lists only active categories (FR-002)
  ✓ browses a category to sellable variants, hiding the unauthorized SKU (FR-002/SR-007)
  ✓ opens a product detail showing all FR-003 authoritative fields
  ✓ reaches Buy Now within 4 deliberate actions (SC-002)
  ✓ deterministic search finds a seeded product and never invents one (FR-004/FR-005)
  ✓ never creates an Order during browsing/search (US1 independence)
```

Supporting integration/contract lanes:

```
✓ tests/integration/catalog-repository.test.ts (4)
✓ tests/integration/catalog-search.test.ts (7)
✓ tests/contract/search-parser.test.ts (11)
```

## SC-001 / SC-002 evidence

| Criterion | Evidence | Result |
|---|---|---|
| SC-001: first-time customer reaches the correct product within 20 s | Acceptance suite runs the full menu → category → variant list → detail path against a real PostgreSQL container; wall-clock for the suite is ~5 s including container boot amortization | **Met** (automated path << 20 s) |
| SC-002: VietQR payment screen reachable in ≤ 4 deliberate actions | Counted path: (1) main menu → (2) category list → (3) category view → (4) variant detail with `buy:` affordance | **Met** (asserted in acceptance test) |

## FR coverage

| FR | How proven |
|---|---|
| FR-001 Vietnamese retail menu only | Menu labels exclude wallet/top-up/reseller/api/admin/supplier |
| FR-002 Active/sellable only, stable pagination | Repository suite hides inactive/paused/unauthorized/dead-product variants; keyset cursor has no overlap/gaps |
| FR-003 Product detail fields | Detail presenter renders Giá/Thời hạn/Giao hàng/Bảo hành/Tồn kho from authoritative rows |
| FR-004 Deterministic search + NL filter parsing | Accent-fold search matches case/diacritic variants; parser allowlists filters only |
| FR-005 No invented product facts | Unknown query returns empty state; model-injected product fields are stripped |

## Seed fixtures

`src/infrastructure/db/seeds/catalog.ts` seeds:

- Active category `Giải trí` with Netflix + Spotify products and sellable variants
- Inactive category (must stay hidden)
- PAUSED variant (must stay hidden)
- Unauthorized SKU `NF-NOAUTH` / "Chưa được phép bán" with `resale_evidence_id = null` (SR-007 — never surfaces)

## Independence

US1 creates **zero** Order rows during browse/search (asserted). No payment, supplier, or credential capability is wired into the catalog callbacks.
