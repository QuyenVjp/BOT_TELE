# Nghiên cứu repo và nguồn chính thống cho bot bán hàng Việt Nam + VietQR

Ngày rà soát: 2026-07-16. Phạm vi: bot chỉ phục vụ người Việt, tạo QR chuyển khoản VietQR, xác nhận tiền vào qua provider/webhook đã xác thực, chống spam/replay, dễ bảo trì. Số sao/ngày push là snapshot GitHub tại ngày rà soát; không dùng số sao thay cho đánh giá mã nguồn.

## Kết luận nhanh

1. **VietQR không phải bằng chứng đã thanh toán.** VietQR/Quick Link chủ yếu tạo payload hoặc ảnh QR. Trạng thái `PAID` chỉ được ghi khi backend nhận webhook/API giao dịch hợp lệ, kiểm tra chữ ký/nguồn, đúng tài khoản nhận, đúng mã đơn, đúng số tiền và transaction chưa xử lý.
2. **Khuyến nghị MVP:** dùng hosted checkout của payOS nếu ưu tiên giảm bề mặt bảo mật và bảo trì. Nếu cần tự chủ giao diện/logic, dùng VietQR để tạo QR và SePay (hoặc Casso/Open Banking tương đương) làm nguồn webhook + reconciliation; không tự “đọc ảnh chuyển khoản”.
3. **Tách state machine:** `Order` và `Payment` là hai máy trạng thái riêng. Fulfillment (giao hàng) là một bước idempotent sau `PaymentReceived/OrderPaid`, không nằm trong HTTP webhook handler.
4. **Webhook phải là inbox + queue:** nhận raw body, xác thực chữ ký/timestamp, validate schema, lưu event với unique key, trả 2xx nhanh, xử lý transaction/fulfillment bất đồng bộ; webhook trùng phải trả thành công nhưng không cấp hàng lần hai.
5. **Không copy nguyên repo Telegram shop bot gần domain:** repo đó hữu ích để xem UX flow và schema tối thiểu, nhưng code hiện tại dùng polling/manual admin confirm, không có webhook SePay thực sự trong `bot.js`, mã thanh toán ngắn ngẫu nhiên và chưa chứng minh các invariant bảo mật.

## Bảng repo nên đọc

| Repo | Snapshot | Mức gần bài toán | Nên học | Không nên copy |
|---|---:|---|---|---|
| [Vendure](https://github.com/vendurehq/vendure) | 8.2k★, push 2026-07-15 | Cao cho order/payment domain | Finite-state machine có transition hợp lệ, hook start/end/error, validation cấu hình, history/event | Toàn bộ GraphQL/NestJS nếu bot nhỏ; chỉ lấy domain pattern |
| [Medusa](https://github.com/medusajs/medusa) | 35k★, push 2026-07-15 | Cao cho payment provider boundary | Provider interface (create/authorize/capture/refund/cancel/webhook), idempotency key theo session/capture, module boundary | Độ phức tạp module/workflow lớn hơn nhu cầu MVP |
| [Saleor](https://github.com/saleor/saleor) | 23k★, push 2026-07-15 | Cao cho API/webhook extensibility | API-only, app/webhook tách khỏi core, split payments/returns, công nghệ-agnostic | Vận hành service-oriented full stack cho một bot nhỏ |
| [grammY](https://github.com/grammyjs/grammY) | 3.6k★, push 2026-07-15 | Cao nếu kênh Telegram | Framework typed, middleware/plugin và webhook adapter; tham chiếu [Telegram Bot API](https://core.telegram.org/bots/api) | Không coi framework chat là order/payment ledger |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 34k★, push 2026-07-15 | Trung bình, cho support/admin | Conversation/inbox, phân quyền, audit và omnichannel support | Kéo cả CRM/helpdesk vào payment core |
| [payOS Node SDK](https://github.com/payOSHQ/payos-lib-node) | 8★, push 2026-03-05 | Rất cao cho payOS | SDK chính thức: HMAC, verify webhook, confirm URL; dùng provider code thay vì tự crypto | Không suy ra maturity từ số sao thấp; phải pin version và test contract |
| [VietQR Node](https://github.com/vietqr/vietqr-node) | 36★, push 2023-12-10 | Cao cho QR generation | API `getBanks/getTemplate/generate`, BIN/account/amount/memo/template | Đây là QR generation SDK, không có bằng chứng settlement/webhook; code cũ dùng axios 0.24 và nuốt lỗi |
| [telegram-shop-bot](https://github.com/kentzu213/telegram-shop-bot) | 17★, push 2026-03-07 | Rất gần UX bán hàng | Flow chọn sản phẩm → số lượng → tạo order/payment code → admin confirm → giao stock; SQLite schema và WAL | `bot.js` chạy polling, không có endpoint webhook; nút “đã thanh toán” chỉ báo pending; giao hàng/admin confirm chưa có provider verification, reconciliation, lock/unique transaction event |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | 3.2k★, push 2026-07-14 | Trung bình cho HTTP edge | Middleware giới hạn endpoint, store/key generator/headers | Memory store đơn lẻ không đủ cho nhiều instance |
| [node-rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) | 3.5k★, push 2026-07-15 | Cao cho anti-abuse | Atomic increments, Redis/Valkey/Postgres/SQLite adapters, block/penalty/reward, insurance khi store lỗi | Đừng dùng một limiter chung cho mọi hành vi; phải tách key và quota theo action |

## Findings theo repo

### 1) Vendure: mẫu state machine đáng lấy nhất

Nguồn: [order-state.ts](https://github.com/vendurehq/vendure/blob/master/packages/core/src/service/helpers/order-state-machine/order-state.ts), [order-state-machine.ts](https://github.com/vendurehq/vendure/blob/master/packages/core/src/service/helpers/order-state-machine/order-state-machine.ts), [payment-state.ts](https://github.com/vendurehq/vendure/blob/master/packages/core/src/service/helpers/payment-state-machine/payment-state.ts), [payment-state-machine.ts](https://github.com/vendurehq/vendure/blob/master/packages/core/src/service/helpers/payment-state-machine/payment-state-machine.ts), [default-payment-process.ts](https://github.com/vendurehq/vendure/blob/master/packages/core/src/config/payment/default-payment-process.ts).

- `OrderStateMachine` có initial state `Created`, `canTransition`, `getNextStates`, `transition`; transition được gom từ các `OrderProcess`, validate lúc khởi tạo và gọi hook `onTransitionStart/onTransitionEnd/onTransitionError`.
- `PaymentStateMachine` độc lập với order; trạng thái mặc định `Created → Authorized/Settled/Declined/Error/Cancelled`, `Authorized → Settled/Error/Cancelled`, terminal `Cancelled`. Mỗi transition nhận context gồm order/payment để kiểm tra invariant.
- `defaultPaymentProcess` ghi history entry và chỉ chuyển order sang payment-settled khi tổng payment settled cover order total. Đây là pattern quan trọng: không chuyển `OrderPaid` chỉ vì một callback “success”.
- Khi định nghĩa module bot, nên có các state tối thiểu:
  - Order: `DRAFT → AWAITING_PAYMENT → PAYMENT_RECEIVED → FULFILLING → FULFILLED`; nhánh `EXPIRED/CANCELLED/REFUND_PENDING/REFUNDED`.
  - Payment: `CREATED → PENDING → CONFIRMED | FAILED | EXPIRED`; `CONFIRMED` chỉ qua provider event đã verify.
- Ghi transition history append-only (actor, source, destination, reason, provider event id, timestamps) để audit và điều tra tranh chấp.

### 2) Medusa: provider boundary và idempotency

Nguồn: [payment-provider.ts](https://github.com/medusajs/medusa/blob/develop/packages/modules/payment/src/services/payment-provider.ts), [payment-module.ts](https://github.com/medusajs/medusa/blob/develop/packages/modules/payment/src/services/payment-module.ts), [security policy](https://github.com/medusajs/medusa/blob/develop/SECURITY.md).

- `PaymentProviderService` tách provider adapter khỏi module: create session, authorize, capture, cancel, refund, list/save/delete payment method và `getWebhookActionAndData`.
- Khi tạo session, Medusa truyền `context.idempotency_key` theo payment session id. Khi authorize, nếu session đã có payment + `authorized_at`, service trả lại payment thay vì gọi provider lần nữa. Capture/refund cũng truyền idempotency key theo capture/refund id.
- Bài học cho bot: mỗi `order_id` có một `payment_attempt`; retry HTTP/provider phải giữ cùng idempotency key; không tạo order mới vì client bấm lại.
- Adapter VietQR/SePay nên chỉ làm nhiệm vụ map payload provider → canonical event; domain service mới quyết định số tiền, trạng thái và fulfillment.

### 3) Saleor: tách extension khỏi core

Nguồn: [README – API-only Architecture](https://github.com/saleor/saleor#why-api-only-architecture), [webhooks overview](https://docs.saleor.io/developer/extending/webhooks/overview), [payment features](https://github.com/saleor/saleor#features).

Saleor nêu rõ API-first + webhooks/apps giúp extension deploy độc lập, giảm downtime, công nghệ-agnostic, đơn giản upgrade/debug; core có order model, split payments, returns và payment orchestration. Với bot nhỏ, không cần copy toàn bộ Saleor, nhưng nên giữ boundary tương tự: `catalog`, `cart/order`, `payment`, `fulfillment`, `notifications`, `admin` là module độc lập với event contract rõ ràng.

### 4) Telegram/grammY và Telegram Bot API

Nguồn: [grammY README](https://github.com/grammyjs/grammY), [Telegram Bot API – setWebhook](https://core.telegram.org/bots/api#setwebhook), [Telegram Bot API – Update/update_id](https://core.telegram.org/bots/api#update).

- Telegram yêu cầu Bot API qua HTTPS. `setWebhook` hỗ trợ `secret_token`; Telegram gửi header `X-Telegram-Bot-Api-Secret-Token`, cần kiểm tra constant-time trước khi parse/dispatch.
- `update_id` tăng tuần tự và tài liệu nói dùng để bỏ qua update trùng hoặc khôi phục thứ tự. Lưu `telegram_update_id`/dedupe key trong inbox để webhook retry không chạy command hai lần.
- Giới hạn `max_connections` khi set webhook để điều tiết tải; chỉ subscribe các update type cần thiết.
- Middleware của grammY phù hợp cho auth/role/rate-limit/command routing, nhưng không được để middleware gọi thẳng fulfillment; mọi side effect phải qua domain command có idempotency.

### 5) payOS chính thức: hosted VietQR checkout + webhook

Nguồn chính: [payOS API docs](https://payos.vn/docs/api/), [checkout flow](https://payos.vn/docs/checkout/how-checkout-works), [webhook docs](https://payos.vn/docs/du-lieu-tra-ve/webhook), [signature verification](https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/), [official Node SDK](https://github.com/payOSHQ/payos-lib-node).

- Link thanh toán chứa `orderCode`, `amount`, `description`, `cancelUrl`, `returnUrl`, `expiredAt`, `signature`; server auth bằng client id/API key. `returnUrl` chỉ phục vụ UX, không phải proof.
- SDK `webhooks.confirm(url)` để đăng ký/kiểm tra endpoint; `webhooks.verify(webhook)` kiểm tra `data` + `signature` rồi dùng HMAC-SHA256 checksum key. SDK source sort keys alphabetically, chuyển thành query string và ký HMAC.
- Payload webhook có `orderCode`, `amount`, `description`, `reference`, `transactionDateTime`, `paymentLinkId`, account/counter-account fields. Lưu toàn bộ raw payload để audit nhưng redact secret/log nhạy cảm.
- Quy tắc canonical khi nhận webhook: verify signature trước; validate `code/success`, currency VND, account nhận, amount và orderCode; unique `(provider, provider_transaction_id/reference)`; transaction compare-and-swap `PENDING → PAID`; enqueue fulfillment; trả 2xx nhanh.
- Dùng SDK chính thức làm implementation reference, nhưng thêm test vector của riêng hệ thống (key order, Unicode, null, amount integer) và pin version.

### 6) VietQR Node và NAPAS/VietQR docs: QR generation only

Nguồn: [vietqr-node README](https://github.com/vietqr/vietqr-node), [source index.js](https://github.com/vietqr/vietqr-node/blob/main/index.js), [VietQR Quick Link](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/), [VietQR Generate API](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr), [NAPAS 247 VietQR](https://napas.com.vn/dich-vu-chuyen-tien-nhanh-napas-247).

SDK nhận BIN/account/name/amount/memo/template rồi gọi API generate hoặc tạo quick link. Đây là lớp hiển thị lệnh chuyển khoản, không cung cấp settlement guarantee. `addInfo` nên chứa mã đơn ngắn, duy nhất, không chứa tên/số điện thoại; QR động không tự ngăn người dùng chuyển sai số tiền.

Repo này ít test, dependency axios cũ và helper catch rồi `console.log`/trả error object; dùng làm tham khảo payload thôi, không copy error handling/secret management.

### 7) Repo gần domain: kentzu213/telegram-shop-bot

Nguồn: [README](https://github.com/kentzu213/telegram-shop-bot), [paymentService.js](https://github.com/kentzu213/telegram-shop-bot/blob/main/src/services/paymentService.js), [paymentConfirm.js](https://github.com/kentzu213/telegram-shop-bot/blob/main/src/handlers/paymentConfirm.js), [orderService.js](https://github.com/kentzu213/telegram-shop-bot/blob/main/src/services/orderService.js), [database.js](https://github.com/kentzu213/telegram-shop-bot/blob/main/src/database.js), [bot.js](https://github.com/kentzu213/telegram-shop-bot/blob/main/src/bot.js).

**Có thể học:** UX command/menu, product/category/stock/order tables, `payment_code` unique, SQLite WAL + foreign keys, state `pending/delivered/cancelled`, admin panel flow.

**Không đạt production payment proof:** `paymentService` tạo mã `NAP PAY-` + 6 ký tự và URL ảnh VietQR; `paymentConfirm` chỉ trả pending; `bot.js` dùng `bot.launch()` polling và không có HTTP webhook receiver/SePay verification; `confirmAndDeliver` cấp stock trực tiếp khi admin gọi, không có provider transaction id/unique inbox/reconciliation/lease. README nói “webhook” nhưng source bot hiện tại không chứng minh luồng đó. Repo nên dùng làm UX prototype, không dùng làm security baseline.

## Webhook/payment patterns từ provider chính thức

### SePay

Nguồn: [xác thực webhook](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc), [bảo mật](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat), [retry/lỗi](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi), [đối soát](https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich), [QR + form](https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan), [IP](https://developer.sepay.vn/vi/dia-chi-ip).

- Hỗ trợ HMAC-SHA256, API Key, OAuth2 hoặc không auth; production chọn HMAC + IP allowlist defense-in-depth.
- HMAC ký chính xác `{timestamp}.{raw_body}`; header gồm `X-SePay-Signature: sha256=...` và `X-SePay-Timestamp`. Phải verify raw bytes trước JSON parse; kiểm tra timestamp window để chống replay.
- Payload có transaction `id`, gateway, account, code/content, transfer type/amount, reference. Dùng unique `(provider, id)` và transaction DB; duplicate trả success nhưng không giao lại.
- Endpoint ack nhanh và đẩy queue; retry provider theo lịch. Có reconciliation định kỳ qua API để tìm webhook thất lạc.
- Sample cũ trong docs dùng SQL string interpolation/MyISAM; chỉ lấy schema/pattern, không copy code SQL đó. Dùng prepared statements, InnoDB/Postgres và unique constraints.

### Casso

Nguồn: [developer portal](https://developer.casso.vn/), [webhook thủ công](https://developer.casso.vn/webhook/thiet-lap-webhook-thu-cong), [Webhook V2](https://docs.casso.vn/tich-hop/webhook_v2), [sample handler](https://github.com/CassoHQ/casso-webhook-handler-sample).

Casso webhook yêu cầu endpoint HTTPS, phản hồi nhanh (strict mode `{"success": true}`), có retry khi lỗi, transaction `id` duy nhất và khuyến nghị kiểm tra duplicate. V2 có security key/signature và hỗ trợ rotate key; event tồn đọng có thể dùng key cũ nên cần overlap key khi rotate. Có job hậu kiểm API giao dịch để bù event bị sót. Casso phù hợp lớp biến động số dư/đối soát; nếu cần hosted checkout, docs hướng sang payOS by Casso.

## Anti-spam, chống replay và chống abuse

Nguồn: [rate-limiter-flexible README](https://github.com/animir/node-rate-limiter-flexible), [express-rate-limit README](https://github.com/express-rate-limit/express-rate-limit), [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

- Dùng Redis/Valkey hoặc Postgres atomic counter cho các key riêng: `telegram_user_id`, IP/subnet, device/session, `order_create`, `payment_check`, `support_message`, provider webhook IP. `rate-limiter-flexible` có atomic increments, block/penalty/reward, insurance strategy khi store lỗi.
- Không dùng IP đơn độc (NAT/VPN); kết hợp user ID + IP + hành vi, quota theo action và exponential backoff. Webhook provider không bị rate limit giống public command nhưng phải có body-size/timeout/concurrency limit.
- Turnstile token phải verify server-side qua Siteverify; token tối đa 2048 ký tự, sống 300 giây và single-use. Chỉ áp dụng cho web entry/high-risk actions, không coi CAPTCHA là auth/payment proof.
- Lưu abuse event (reason, key hash, rule, expiry) và có admin unblock/audit. Không log raw token, API key, checksum key hoặc toàn bộ thông tin tài khoản ngân hàng.

## Design system và quy tắc nghiệp vụ cần chốt trước khi code

### Module boundaries

1. `channel-adapters`: Telegram (sau này web/Zalo), parse command/callback, verify webhook secret, normalize actor.
2. `catalog`: sản phẩm/giá/VND, version giá; không cho client gửi lại giá làm nguồn tin cậy.
3. `orders`: tạo snapshot line/price, expiry, state machine và transition history.
4. `payments`: payment attempt, provider adapter, canonical event, signature verification, inbox, reconciliation.
5. `fulfillment`: reserve stock, deliver exactly once, retry notification độc lập với việc ghi nhận đã giao.
6. `abuse-control`: rate limit, Turnstile/risk score, denylist, lockout.
7. `admin/audit`: RBAC, maker-checker cho refund/manual override, immutable audit log.
8. `observability`: correlation ID, metrics (webhook lag, duplicate rate, mismatch amount, fulfillment failure), alert.

### Invariants bắt buộc

- Không `PAID` từ `returnUrl`, screenshot, nút “Tôi đã thanh toán”, hoặc lời nhắn chat.
- Payment event chỉ hợp lệ nếu signature/timestamp/provider account/schema/amount/currency/order code đều khớp; kiểm tra order chưa expired/cancelled.
- Unique tối thiểu `(provider, provider_transaction_id)` và `(provider, provider_reference)` nếu provider có cả hai.
- Một order không được có hai payment attempt active; retry dùng cùng idempotency key.
- Fulfillment phải idempotent: reserve stock + mark delivered trong một transaction/locking strategy; gửi Telegram có outbox retry riêng.
- Mismatch (sai số tiền, sai mã, tiền ra, transaction cũ) chuyển `REVIEW_REQUIRED`, không tự giao hàng và không tự refund.
- Refund/manual mark-paid cần RBAC + reason + audit; không cho admin gửi raw SQL/đổi amount.

### State machine đề xuất

```text
Order:   DRAFT -> AWAITING_PAYMENT -> PAYMENT_RECEIVED -> FULFILLING -> FULFILLED
                    |                    |                   |
                    +-> EXPIRED          +-> REVIEW_REQUIRED +-> FULFILLMENT_FAILED
                    +-> CANCELLED        +-> REFUND_PENDING  +-> CANCELLED

Payment: CREATED -> PENDING -> CONFIRMED
                    |       \-> FAILED
                    \-> EXPIRED
```

`PAYMENT_RECEIVED` chỉ là canonical provider event đã verify; `FULFILLED` chỉ sau khi stock reservation/delivery commit thành công. Mỗi transition ghi actor/source/event id/reason.

### Webhook algorithm (pseudo)

```text
receive raw bytes
  -> enforce size + timeout + provider route
  -> verify secret/signature/timestamp on raw bytes (constant-time)
  -> parse + schema validate + normalize VND integer
  -> insert payment_inbox(provider, event_id, raw_hash, raw_payload) ON CONFLICT DO NOTHING
  -> if duplicate: return 2xx (no side effect)
  -> enqueue event; return 2xx

worker transaction:
  -> lock payment/order by id
  -> check provider account, order code, amount, expiry, current state
  -> append payment event + CAS PENDING -> CONFIRMED/PAYMENT_RECEIVED
  -> reserve/consume stock exactly once; outbox fulfillment notification
  -> commit; retry only safe/idempotent operations
```

## Những thứ tuyệt đối không copy

- SQL string interpolation và MyISAM sample trong một số SePay docs.
- “Nút đã thanh toán” hoặc ảnh biên lai làm trigger cấp hàng.
- Polling/manual admin confirmation làm payment source of truth.
- Short random payment code không có unique DB constraint/provider transaction id.
- Webhook handler làm mọi việc đồng bộ trước khi trả response.
- Chỉ rate-limit bằng process memory khi chạy nhiều instance.
- Log raw webhook/API credentials hoặc thông tin tài khoản ngân hàng.
- Cho phép client gửi `price`, `amount`, `user_id`, `is_admin` rồi tin thẳng ở server.

## Thứ tự triển khai an toàn

1. Chốt contract/state machine + invariants và viết transition/property tests.
2. Chốt một provider (payOS hosted checkout hoặc SePay webhook) và lưu raw payload/test vectors.
3. Implement inbox/idempotency/reconciliation trước UI bot.
4. Implement fulfillment/outbox + stock locking, sau đó mới nối Telegram/grammY.
5. Thêm rate limit/Turnstile/RBAC/audit/metrics; chạy replay, duplicate, wrong amount, timeout và provider retry tests.
6. Chỉ production khi có runbook đối soát thủ công và đường lui `REVIEW_REQUIRED`; không auto-deliver các case mơ hồ.

## Addendum: digital account resale and Telegram policy (2026-07-16)

- Telegram's official bot feature documentation states that digital goods/services sold in a bot or Mini App must use Telegram Stars (`XTR`). The Stars guide requires an invoice, `pre_checkout_query` validation, `successful_payment` handling, storage of `telegram_payment_charge_id`, delivery and refund support. Sources: [Telegram payments for digital goods](https://core.telegram.org/bots/payments-stars) and [Bot Features — Payments](https://core.telegram.org/bots/features#payments).
- Telegram Mini App identity data must be verified server-side from `Telegram.WebApp.initData`; `initDataUnsafe` is not an authorization source. Source: [Telegram Mini Apps validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
- Telegram Managed Bots can let a manager bot help users create/manage their own bots. This is a potential white-label reseller wedge, but it does not remove tenant isolation, credential scoping or provider-policy obligations. Source: [Telegram Managed Bots](https://core.telegram.org/bots/features#managed-bots).
- grammY conversations are replay-based; database/network/global-state side effects must be wrapped through the plugin's external mechanism. The conversation state is UX state, not an order/payment/ledger source of truth. Source: [grammY conversations](https://grammy.dev/plugins/conversations).
- For ChatGPT Plus, Super Grok or similar account access, the product catalog must record resale/transfer authorization, region, expiry and warranty. If upstream terms do not authorize resale or shared credentials, the SKU is blocked; no login/captcha/scraping bypass is acceptable.
- The product design therefore separates `PaymentPolicy` by product/channel, a Digital Account Asset state machine, Supplier API adapters, vault-backed one-time Delivery Bundles and a single root-admin identity mapped to the numeric Telegram ID of `@Quyenvjp`.
