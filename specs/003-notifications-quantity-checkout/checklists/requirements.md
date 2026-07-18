# Requirements Quality Checklist — Quantity, Payment UX, and Notifications

**Purpose:** Unit tests for the written requirements, not tests of implementation behavior.
**Audience:** Author and reviewer before implementation; standard depth.

## Requirement completeness

- [x] CHK001 — Are the one-Variant-per-Order and bounded integer quantity rules explicit, including the fact that a multi-item cart remains out of scope? [Completeness, Spec §FR-301]
- [x] CHK002 — Are server-side revalidation inputs (price, maximum, stock, source capability, and resale eligibility) all named before payment creation? [Completeness, Spec §FR-302]
- [x] CHK003 — Does the requirement list every value that must be snapshotted on the Order, including warranty, delivery, source, and reconciliation policy? [Completeness, Spec §FR-303]
- [x] CHK004 — Are all required payment-card fields, QR, expiry, warning, and both customer actions specified together? [Completeness, Spec §FR-309]
- [x] CHK005 — Are all four notification classes and their recipient, opt-out, quiet-hour, and content rules defined? [Completeness, Spec §FR-315]
- [x] CHK006 — Are product/restock, purchase activity, transactional, and admin announcement content requirements each represented? [Completeness, Spec §FR-316–FR-323]

## Requirement clarity and measurability

- [x] CHK007 — Is the quantity domain unambiguous for zero, negative, fractional, above-maximum, and above-stock values? [Clarity, Spec §FR-301]
- [x] CHK008 — Is the total calculation defined as bounded integer VND multiplication rather than a client-supplied amount? [Clarity, Spec §FR-304]
- [x] CHK009 — Is “all-or-nothing” reservation defined sufficiently to distinguish a failed reservation from a partial reservation? [Clarity, Spec §FR-305]
- [x] CHK010 — Are supplier quantity requests and deterministic child idempotency keys both defined for supported and unsupported supplier capabilities? [Clarity, Spec §FR-306]
- [x] CHK011 — Is “exactly N valid assets” a measurable completion condition, including the partial-success review state? [Measurability, Spec §FR-307–FR-308]
- [x] CHK012 — Are `Đã tạo đơn`, `Chờ thanh toán`, `Thanh toán thành công`, `Đang xử lý`, `Cần đối soát`, `Đã hủy`, `Hết hạn`, and `Đơn hàng hoàn tất` distinct and non-misleading states? [Clarity, Spec §FR-314]
- [x] CHK013 — Are “privacy-safe”, “rare”, “important”, and “high volume” bounded by an allowlist, frequency cap, or explicit policy? [Ambiguity, Spec §FR-318–FR-323]
- [x] CHK014 — Are “immediate” preference effects and quiet-hour/digest behavior defined at the point of send rather than only at campaign creation? [Clarity, Spec §FR-320–FR-324]

## Consistency and traceability

- [x] CHK015 — Do quantity, payment, fulfillment, and notification requirements consistently use the same Order, Product Variant, Payment Intent, and Delivery Bundle vocabulary? [Consistency, Spec §FR-301–FR-324]
- [x] CHK016 — Do the QR display fields and the Payment Intent snapshot use the same authoritative source and VND semantics? [Consistency, Spec §FR-309–FR-310]
- [x] CHK017 — Are customer-controlled notification classes consistent with the prohibition on disabling transactional and critical-service messages? [Consistency, Spec §FR-320–FR-321]
- [x] CHK018 — Does the requirement to inform customers of successful purchases avoid contradicting the privacy and aggregation requirements? [Consistency, Spec §FR-318–FR-319]
- [x] CHK019 — Is every functional requirement mapped to an implementation task and an acceptance or contract test? [Traceability, Spec §FR-301–FR-324]
- [x] CHK020 — Is every buildable success criterion mapped to at least one test-first task? [Traceability, Spec §SC-301–SC-310]

## Scenario and edge-case coverage

- [x] CHK021 — Are stale price/stock callbacks, repeated Buy Now requests, and duplicate callback tokens covered as alternate flows? [Coverage, Spec §FR-302, FR-304]
- [x] CHK022 — Are concurrent settlement/cancellation, duplicate/reordered SePay evidence, and expired payment sessions covered as race or recovery flows? [Coverage, Spec §FR-311–FR-313]
- [x] CHK023 — Are wrong, partial, over, late, unmatched, wrong-account, and wrong-content transfers each assigned an observable review outcome? [Coverage, Spec §FR-313]
- [x] CHK024 — Are zero stock, no eligible recipient, blocked Telegram chat, quiet hours, and disabled preferences defined? [Edge Case, Spec §FR-320–FR-324]
- [x] CHK025 — Are supplier timeout/unknown, partial success, invalid asset, and replacement/refund resolution requirements explicit? [Recovery, Spec §FR-306–FR-308]
- [x] CHK026 — Are broadcast draft, preview, confirmation expiry, cancellation after partial fanout, and campaign replay scenarios documented? [Coverage, Spec §FR-322–FR-323]

## Acceptance and non-functional quality

- [x] CHK027 — Can exact totals, reserved units, fulfilled units, and delivered units be objectively measured for every permitted quantity? [Acceptance, Spec §SC-301–SC-302]
- [x] CHK028 — Can idempotency be measured across 100 replays without conflating logical outcomes and Telegram delivery attempts? [Acceptance, Spec §SC-304–SC-305]
- [x] CHK029 — Is the purchase-activity frequency cap quantified and does the requirement explain how every event contributes to an aggregate? [Acceptance, Spec §SC-308]
- [x] CHK030 — Are Telegram 429, timeout, worker restart, and blocked-chat recovery targets explicit enough to evaluate loss versus retry storms? [Acceptance, Spec §SC-309]
- [x] CHK031 — Are performance goals for payment presentation and asynchronous notification enqueue stated without making provider latency a synchronous customer action? [Non-Functional, Plan §Technical Context]
- [x] CHK032 — Are privacy, secret-redaction, authorization, and audit outcomes stated as release-blocking requirements where appropriate? [Non-Functional, Spec §SC-307, SC-310]

## Dependencies and assumptions

- [x] CHK033 — Are Feature 001 Order/payment/inventory/outbox events and merchant VietQR/SePay configuration named as prerequisites? [Dependency, Spec §Dependencies & Launch Gates]
- [x] CHK034 — Are owner decisions for default notification preferences, quiet hours, digest window, frequency cap, and critical-service policy recorded as launch gates? [Assumption, Spec §Assumptions]
- [x] CHK035 — Is the boundary between this feature and out-of-scope wallet, cart, reseller API, marketing campaigns, and arbitrary admin content explicit? [Scope, Spec §Out of Scope]
