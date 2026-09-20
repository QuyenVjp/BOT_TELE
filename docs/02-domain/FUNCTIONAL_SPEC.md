# Functional Specification: Telegram shop bán digital account

> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** TIER20 SHOP is Telegram-bot-only. Do not treat Mini App, WebApp, `initData`, `startapp`, or `shop.tier20.click` as required, blocked, or future work. See `docs/architecture/telegram-only-commerce.md`.

> Phiên bản: v0.2 — customer-first MVP  
> Ngày: 2026-07-16  
> UX chuẩn: [MVP Customer Flow](../00-overview/MVP_CUSTOMER_FLOW.md)  
> Kiến trúc nền: [Blueprint](../03-architecture/BLUEPRINT.md)

## Problem Statement

Khách Việt cần một cách mua account/access số thật nhanh trong Telegram: mở bot, thấy sản phẩm và giá, bấm mua, quét VietQR, chờ SePay xác minh rồi nhận hàng an toàn. Họ không cần học command, nạp ví trước, hiểu supplier/API hay trò chuyện dài với AI.

Shop cần tự động hóa luồng này mà không đánh đổi tính đúng đắn của tiền, tồn kho và bí mật:

- không giao hàng từ ảnh biên lai, chat text hoặc nút `đã chuyển khoản`;
- không giao một asset cho hai khách;
- không gọi supplier create-order trùng khi timeout/retry;
- không để raw credential trong database domain, log, event, telemetry, ticket hoặc kênh không phải Telegram message đã bind customer;
- không để AI bịa giá/tồn kho/chính sách hay tác động trực tiếp tới order/payment;
- chỉ bán SKU có quyền resale/transfer rõ ràng;
- chỉ numeric Telegram `user_id` cấu hình cho `@Quyenvjp` có quyền root admin.

## Solution

Xây một shop tự động với một happy path duy nhất:

```text
Telegram menu
→ category/search
→ product + variant
→ Buy Now
→ Order + VietQR Payment Intent
→ verified SePay transaction
→ local stock hoặc Supplier API
→ vault-backed one-time Delivery Bundle
→ Completed / Order History / Support
```

MVP dùng inline keyboard và edit-in-place message. AI chỉ là query parser có schema giới hạn; backend truy vấn catalog và render mọi product fact từ database. Supplier API nằm sau backend boundary. Customer wallet, top-up, multi-item cart và Reseller API không thuộc retail MVP.

## Actors and permissions

| Actor              | Năng lực trong phạm vi này                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Customer           | Browse/search, xem product, mua ngay, thanh toán VietQR, xem order, nhận hàng, mở ticket                          |
| Root Admin         | Duy nhất numeric Telegram ID mapped với `@Quyenvjp`; quản lý catalog/stock/discrepancy theo private hardened flow |
| Support capability | Xem dữ liệu tối thiểu của ticket/order và trả lời; không mark paid hoặc đọc raw credential                        |
| SePay              | Cung cấp transaction evidence và reconciliation data; không tự quyết định Order state                             |
| VietQR             | Encode/render thông tin chuyển khoản; không xác nhận đã nhận tiền                                                 |
| Supplier           | Cung cấp availability/order/asset/refund qua adapter; không đọc customer data ngoài reference cần thiết           |
| Search parser      | Chuyển câu tự nhiên thành bounded filters; không có domain command/tool                                           |

## User Stories

### A. Vào shop và điều hướng

1. As a Customer, I want `/start` to show a compact Vietnamese menu, so that I can shop immediately.
2. As a Customer, I want the menu to expose only products, search, orders and support, so that technical functions do not distract me.
3. As a Customer, I want `Quay lại` and `Menu chính` on every non-terminal screen, so that I am never trapped.
4. As a Customer, I want the bot to edit the current card when practical, so that the chat is not flooded.
5. As a Customer, I want duplicate taps to return the existing result, so that slow mobile networks do not create duplicate orders.
6. As a Customer, I want loading states for operations over one second, so that I know the bot is working.

### B. Browse catalog

1. As a Customer, I want to browse active categories, so that I can narrow the catalog quickly.
2. As a Customer, I want paginated product lists with visible starting prices, so that I can compare without opening every card.
3. As a Customer, I want inactive/out-of-stock products hidden or clearly unavailable, so that I do not enter a dead checkout.
4. As a Customer, I want stable pagination and sorting, so that items do not jump while I browse.
5. As a Customer, I want product detail to show price, duration, stock, delivery type, expected delivery and warranty, so that I can decide before paying.
6. As a Customer, I want to choose a duration/variant using buttons, so that I cannot mistype a SKU.
7. As a Customer, I want a visible usage condition and warranty summary, so that expectations are explicit.
8. As an Owner, I want a product/variant kill switch, so that an unsafe or unauthorized SKU disappears immediately without deleting history.

### C. Search

 1. As a Customer, I want keyword search by product, category and alias, so that common searches are fast and deterministic.
 2. As a Customer, I want to type `gói 1 tháng dưới 200k`, so that natural language can become catalog filters.
 3. As a Customer, I want result cards to use the shop's real price, stock and warranty, so that AI cannot fabricate an offer.
 4. As a Customer, I want a clear no-result state with reset filters, so that I can continue browsing.
 5. As a Customer, I want a useful fallback when the model is unavailable, so that search still works by keyword.
 6. As an Owner, I want model output validated against an allowlist, so that prompt injection cannot produce a domain action.
 7. As an Owner, I want search input length, Unicode and rate controls, so that model/DB resources cannot be abused.

### D. Buy now and create Order

 1. As a Customer, I want a single `Mua ngay — <price>` button, so that checkout is short.
 2. As a Customer, I want the server to revalidate price, active state, stock and resale eligibility, so that stale cards cannot create an invalid order.
 3. As a Customer, I want price/warranty/product facts snapshot on my Order, so that later catalog changes do not rewrite my purchase.
 4. As a Customer, I want no unnecessary address, name or phone form for digital delivery, so that checkout remains private and fast.
 5. As a Customer, I want a price change shown for confirmation before QR creation, so that I am never charged a silent new price.
 6. As a Customer, I want an out-of-stock result before payment when possible, so that money is not taken for unavailable inventory.
 7. As an Owner, I want concurrent last-item purchases serialized, so that one asset cannot be promised twice.

### E. VietQR and SePay payment

 1. As a Customer, I want a VietQR with exact amount and a short unique order content, so that my transfer can be matched automatically.
 2. As a Customer, I want QR expiry displayed in Vietnam time, so that I know when to pay.
 3. As a Customer, I want a copyable amount/content fallback, so that I can pay when QR scanning is inconvenient.
 4. As a Customer, I want the bot to say I do not need a receipt screenshot, so that I do not expose bank information.
 5. As a Customer, I want `Kiểm tra trạng thái` to refresh safely, so that I can see progress without falsely marking paid.
 6. As a Customer, I want verified payment to update automatically without polling manually, so that delivery starts promptly.
 7. As a Customer, I want a late, short, overpaid or wrong-content transfer to enter review with a reference, so that money is not lost silently.
 8. As an Owner, I want SePay raw-body HMAC, timestamp/replay window and unique transaction ID verified before parsing effects, so that forged/replayed webhooks cannot settle orders.
 9. As an Owner, I want account, inbound direction, amount and order content/reference matched, so that unrelated deposits cannot buy goods.
10. As an Owner, I want duplicate/reordered SePay events idempotent, so that payment and fulfillment happen exactly once.
11. As an Owner, I want periodic reconciliation, so that missing webhooks are recovered.
12. As an Owner, I want webhook acknowledgement decoupled from slow fulfillment, so that SePay retry behavior does not duplicate work.

### F. Fulfillment and Supplier API

 1. As a Customer, I want fulfillment to start only after verified payment, so that order status is trustworthy.
 2. As a Customer, I want local stock delivered first when policy selects it, so that delivery is fast.
 3. As a Customer, I want supplier-sourced products provisioned automatically, so that the shop can sell authorized upstream stock.
 4. As a Customer, I want `Đang chuẩn bị sản phẩm` when fulfillment is slow, so that paid orders do not look lost.
 5. As an Owner, I want supplier create-order idempotent, so that retries cannot buy duplicate upstream assets.
 6. As an Owner, I want timeout-unknown supplier results queried/reconciled before retry, so that uncertain outcomes do not create duplicates.
 7. As an Owner, I want supplier responses validated beyond HTTP 200, so that malformed/revoked assets are quarantined.
 8. As an Owner, I want supplier cost, sale price, margin and reference snapshot, so that each order can be audited.
 9. As an Owner, I want a configured fallback decision rather than silent supplier switching, so that product promises remain accurate.

### G. Secure delivery and warranty

 1. As a Customer, I want all `customerVisible` delivery fields sent automatically in the Telegram message bound to my order, so that I receive the product without another reveal action.
 2. As a Customer, I want the automatic delivery to be retried safely after a send failure, so that I receive the same asset without a duplicate allocation.
 3. As a Customer, I want a clear delivery failure/recovery state, so that I know when to contact support; the legacy reveal link remains a controlled recovery surface.
 4. As a Customer, I want usage instructions and warranty expiry on the completed message, so that onboarding is easy.
 5. As a Customer, I want to report invalid/revoked/incorrect delivery from the Order, so that support has context.
 6. As an Owner, I want raw credentials stored only in a vault except for the intended bound Telegram delivery message, so that domain DB, logs, analytics, events and support transcripts remain secret-free.
 7. As an Owner, I want delivery exactly once under replay/crash, so that a second asset is not accidentally issued.
 8. As an Owner, I want replacement/refund follow a recorded warranty policy, so that a compromised asset is not handled by direct DB edits.

### H. Order history and support

 1. As a Customer, I want a paginated list of my own orders, so that I can find recent purchases quickly.
 2. As a Customer, I want order detail to show immutable product/price, payment, fulfillment, delivery and support states, so that current progress is clear.
 3. As a Customer, I want an unpaid unexpired order to reopen its QR, so that I can finish payment.
 4. As a Customer, I want cancellation allowed only before the payment race is resolved, so that a paid order is not silently discarded.
 5. As a Customer, I want structured support reasons linked to an Order, so that I do not repeat context.
 6. As a Customer, I want ticket state and next action, so that I know whether the shop or I must respond.
 7. As an Owner, I want support unable to mark payment paid or reveal secrets, so that assistance cannot bypass domain rules.
 8. As an Owner, I want all manual review outcomes audited with actor, reason and evidence, so that financial/delivery decisions are explainable.

### I. Admin identity and abuse controls

 1. As the Owner, I want only configured numeric Telegram `user_id` for `@Quyenvjp` authorized as root, so that username changes cannot grant access.
 2. As the Owner, I want no `/add-admin` or username fallback, so that no second admin can be created through the bot.
 3. As the Owner, I want high-risk actions limited to private chat with step-up and explicit confirmation, so that stolen sessions are contained.
 4. As the Owner, I want rate limits by Telegram user and action, so that catalog remains responsive during spam.
 5. As a legitimate Customer, I want cooldowns to preserve access to order history/support, so that anti-abuse does not erase paid-order recovery.
 6. As the Owner, I want callback/update/webhook dedupe and bounded payloads, so that replay/resource-exhaustion cannot multiply side effects.

## Implementation Decisions

### 1. Scope and channel

- Telegram is the only customer channel in MVP; domain remains behind a channel adapter.
- Customer menu contains only catalog, search, orders and support.
- Inline keyboard + edited messages are the default. Mini App is deferred until catalog/form complexity demonstrates a need.
- Retail purchase is one product variant per Order. There is no customer cart or split tender.

### 2. Catalog and search

- `Category`, `Product` and `ProductVariant` are distinct. Price, duration, delivery type, warranty and supplier SKU belong to the variant.
- Product/variant soft disable preserves Order snapshots and audit history.
- Deterministic search runs first. Natural-language parser returns only bounded filters: query, category, duration, min/max price, available stock, delivery type and sort.
- Model output never renders directly as product facts and has no application/domain tools.

### 3. Order and payment

- Server-side revalidation and immutable Order snapshot occur before QR creation.
- Each Order has one active VietQR Payment Intent in MVP, with integer VND exact amount, unique content and expiry.
- VietQR is QR generation only. SePay verified transaction evidence is payment truth.
- Signature verification covers timestamp plus raw request bytes before JSON reserialization; replay window, constant-time compare and current allowlist policy apply.
- `PaymentSettled` is idempotent and does not directly mean `FulfillmentCompleted`.
- Underpayment, overpayment, late payment, wrong content/account and unmatched transaction enter `NeedsReview`.

### 4. Inventory, supplier and delivery

- A paid Order atomically claims a local asset or creates an idempotent supplier request.
- Supplier `Unknown` is a first-class state after uncertain timeout; query/reconcile precedes retry.
- Raw credentials are vault-only except for the recipient-bound Telegram delivery message. Domain records contain asset/vault references and redacted metadata.
- The automatic delivery handoff sends verified `customerVisible` fields, then consumes the Delivery Bundle only after Telegram send succeeds. The legacy `/d/:token` route and `delivery:open` callback retain customer/order binding, TTL and view-once semantics for recovery.
- Invite/license/seat/key is preferred to shared credentials.

### 5. Identity and security

- Root admin authorization uses `ADMIN_TELEGRAM_USER_ID`; `ADMIN_EXPECTED_USERNAME=Quyenvjp` is only an alert/display check.
- No command can add another admin.
- Telegram webhook secret, update dedupe, opaque callbacks, per-action rate limits, payload limits and queue backpressure are mandatory.
- Supplier, SePay, bot and admin secrets are stored outside source/config logs and support data.

### 6. Backend architecture

- Node.js LTS + TypeScript, Fastify, grammY, Zod, PostgreSQL and Kysely.
- Modular monolith with worker and transactional outbox. PostgreSQL is authoritative.
- Redis/BullMQ may handle rate limit/cache/retryable work, but Redis is not the source of truth for money, Order, stock or delivery.
- Provider integrations are ports/adapters with contract fixtures.

### 7. Post-MVP lanes

- Reseller API remains a separate tenant-scoped contract and is not exposed to retail customers.
- Customer wallet/top-up is deferred. If later accepted, it requires an immutable double-entry ledger and separate accounting/compliance review.
- Loyalty, referral, campaign, A/B, voice AI, advanced recommendation and mandatory Mini App are deferred.

## Testing Decisions

Tests assert external behavior at the highest useful seam: Telegram update/callback and SePay webhook into the application, then inspect response, persisted state and outbox. VietQR, SePay and supplier adapters use official-shaped fixtures; tests do not assert private helper calls.

### Required suites

- Catalog/search: active filters, pagination, variant pricing, AI schema rejection, model outage fallback, no fabricated facts.
- Checkout: stale price, inactive SKU, last-item concurrency, duplicate tap idempotency, forged callback amount.
- SePay: valid/invalid HMAC, timestamp replay, wrong account/direction/amount/content, duplicate event, event order, missing webhook reconciliation.
- Supplier: success, rejection, timeout-unknown, query recovery, malformed asset, no-stock after payment, idempotent create.
- Delivery: automatic customer-visible disclosure, send failure/retry, wrong customer, legacy view once, replay, worker crash, controlled reissue, secret-redaction tests.
- Authorization/abuse: BOLA on Order/Delivery Bundle, sole-admin checks, callback replay, QR churn, search spam and payload limits.

### Acceptance gates

- Happy path reaches QR in 3–4 taps and automatic delivery target is under 60 seconds when dependencies are healthy.
- Replaying the same SePay transaction 100 times settles, fulfills and issues delivery no more than once.
- Screenshot, chat text, return URL and status-refresh button can never create payment evidence.
- Raw credential never appears in domain DB fixture, Pino logs, OpenTelemetry attributes, outbox, ticket or error response.
- Two concurrent buyers cannot receive the same asset.
- Search parser cannot call domain commands or create product facts.

## Out of Scope

- Customer wallet, top-up, cash-out, transfer or split payment.
- Multi-item cart, coupon/campaign engine and complex promotion stacking.
- Customer-facing Reseller API controls or supplier details.
- Sales AI agent, free-form recommendation agent, voice AI or autonomous actions.
- Loyalty, referral, A/B testing and large analytics dashboard.
- Mandatory Mini App, Zalo/Web channels or marketplace/multi-vendor behavior.
- Selling any SKU without verified resale/transfer authorization.
- Hiding or bypassing Telegram/provider policy; production launch remains gated by the documented policy review.

## Further Notes

### Decisions still requiring owner sign-off

1. Numeric Telegram `user_id` thật của `@Quyenvjp`.
2. Supplier/SKU authorization evidence and allowed delivery form for each product.
3. Warranty/replacement/refund rules for invalid, revoked, region-locked or early-expiry assets.
4. SePay production credential, merchant bank account, limits and IP/HMAC operating policy.
5. Exact Order/QR expiry and local-stock reservation TTL per product family.
6. Support/manual-review SLA and financial refund method.
7. Telegram policy-risk sign-off before production.

### Definition of Ready

- Customer screens/copy and 13-step flow are accepted.
- Catalog/variant schema and AI filter schema are accepted.
- Order, Payment Intent, Digital Asset, Supplier Order and Delivery Bundle state machines are accepted.
- VietQR/SePay and supplier sandbox fixtures cover retry, duplicate, mismatch and reconciliation.
- Numeric root admin ID is configured and tested with deny-by-default behavior.
- Every active SKU has resale/transfer evidence and warranty policy.
- Critical/High security controls have an owner and executable acceptance scenario.

### Recommended implementation order

1. Telegram walking skeleton, identity, anti-spam and edited-message navigation.
2. Category/Product/Variant read model and deterministic search.
3. Bounded natural-language search parser.
4. Buy Now, Order snapshot and local asset reservation.
5. VietQR generation, SePay inbox/verification and reconciliation.
6. Supplier adapter with `Unknown` recovery.
7. Vault + Delivery Bundle + Order history.
8. Support/replacement/refund manual-review path.
9. Hardening, load/concurrency/security tests and limited pilot.
10. Reseller API/wallet/growth only as separately approved post-MVP work.
