# Prompt giao cho Claude — triển khai Telegram Shop Digital MVP

Copy toàn bộ nội dung bên dưới và gửi cho Claude trong một phiên làm việc có quyền đọc/ghi workspace.

---

Bạn là implementation owner chịu trách nhiệm hoàn thành hệ thống Telegram Shop Digital MVP trong workspace:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Mục tiêu là triển khai đúng bộ đặc tả đã được chốt. Không thiết kế lại sản phẩm, không mở rộng scope,
không bỏ qua security gate và không tự deploy production.

## 1. Đọc nguồn sự thật trước khi sửa file

Đọc theo đúng thứ tự:

1. `C:\Users\ADMIN\.codex\AGENTS.md`
2. `.specify/memory/constitution.md`
3. `specs/001-telegram-shop-mvp/spec.md`
4. `specs/001-telegram-shop-mvp/plan.md`
5. `specs/001-telegram-shop-mvp/research.md`
6. `specs/001-telegram-shop-mvp/data-model.md`
7. Toàn bộ `specs/001-telegram-shop-mvp/contracts/`
8. Toàn bộ `specs/001-telegram-shop-mvp/checklists/`
9. `specs/001-telegram-shop-mvp/traceability.md`
10. `specs/001-telegram-shop-mvp/tasks.md`
11. `specs/001-telegram-shop-mvp/analysis.md`
12. Các tài liệu canonical liên quan trong `docs/`, đặc biệt VietQR, SePay, admin identity,
    supplier, threat model và reconciliation runbook.

Không sao chép lại nội dung các tài liệu này thành một bộ spec thứ hai. Nếu phát hiện mâu thuẫn,
Constitution và feature spec là authority; báo rõ file/section bị mâu thuẫn trước khi sửa.

## 2. Workflow bắt buộc

- Dùng Spec Kit artifacts làm feature truth.
- Dùng workflow implementation/review của local skills khi phù hợp.
- Thực hiện các task Feature 001 theo checkbox/evidence thực tế trong `specs/001-telegram-shop-mvp/tasks.md`;
  không reset hoặc đánh dấu khống. Sau khi payment boundary hiện tại ổn định, tích hợp Feature 003
  theo `T310` đến `T332` trước khi tuyên bố payment phase hoàn tất.
- Mỗi task hoàn thành phải đổi checkbox từ `[ ]` thành `[x]` và ghi evidence thật, không đánh dấu khống.
- Với mỗi behavior: viết test trước, chạy để quan sát failure đúng lý do, implement tối thiểu, chạy lại,
  rồi refactor nếu cần.
- Sau mỗi phase, chạy typecheck, lint và targeted tests của phase đó.
- Sau mỗi user story, chạy independent acceptance test được mô tả trong `spec.md` và `tasks.md`.
- Trước khi tuyên bố hoàn thành, chạy toàn bộ quickstart, security, replay, concurrency,
  reconciliation, restore và credential-redaction gates.

Không được bắt đầu bằng một đợt refactor hoặc framework abstraction lớn. Thay đổi phải surgical,
theo đúng file paths và module ownership trong plan/tasks. Nếu một path trong task chưa tồn tại,
tạo đúng cấu trúc đã chốt thay vì phát minh kiến trúc khác.

## 3. Scope sản phẩm không được thay đổi

Retail MVP chỉ có:

```text
Danh sách sản phẩm
→ tìm/chọn variant
→ xem giá và điều kiện
→ Mua ngay
→ VietQR
→ SePay xác minh
→ kho nội bộ hoặc Supplier API
→ Delivery Bundle xem một lần
→ lịch sử đơn/hỗ trợ
```

Không thêm customer wallet, nạp số dư, multi-item cart, coupon/marketing campaign, loyalty, referral,
A/B testing, voice AI, autonomous sales agent, mandatory Mini App hoặc reseller controls vào menu khách.
Reseller API là lane post-MVP, không được làm phức tạp retail flow.

AI chỉ được parse câu tìm kiếm thành bounded filter schema. AI không được tạo product facts,
thay giá, tạo Order, xác nhận thanh toán, gọi supplier, giao credential, refund hoặc gọi admin command.

## 3A. Feature 002 — AI Support Assistant đã được chốt bằng Spec Kit

Sau khi hoàn tất và verify đủ payment/read boundaries của feature `001-telegram-shop-mvp`, tiếp tục
feature pack `specs/002-ai-support/`. Không tự viết lại spec; đọc toàn bộ `spec.md`, `plan.md`,
`research.md`, `data-model.md`, `contracts/`, `checklists/`, `tasks.md`, `traceability.md`, và `analysis.md`.

AI support được phép:

- hiểu câu hỏi tìm sản phẩm, giá, duration và stock rồi gọi catalog read path;
- giải thích FAQ/usage/warranty từ approved knowledge entries;
- đọc payment/order projection của chính khách để giải thích trạng thái;
- phân loại support và đề xuất ticket/human handoff qua command có confirmation.

AI support bị cấm tuyệt đối:

- mark paid, bypass VietQR/SePay, đổi giá/stock/order, reserve asset;
- gọi Supplier API, giao/reveal/reissue credential, refund, sửa ledger;
- thêm admin, đọc prompt/key/config, đọc Order của khách khác;
- trả product/price/policy fact do model tự bịa.

Provider config đã chuẩn bị trong `.env` local và `.env.example`:

```text
AI_PROVIDER=9router
AI_API_BASE_URL=https://qrouter.online/v1
AI_MODEL=cx/gpt-5.6-terra
AI_WIRE_API=responses
AI_REASONING_EFFORT=low
AI_VERBOSITY=low
AI_MAX_OUTPUT_TOKENS=600
```

Không in hoặc commit `AI_API_KEY`. Dùng fake adapter cho CI; live qrouter smoke chỉ chạy opt-in staging,
chỉ ghi status/model/latency, không ghi request/response/key. Provider/model allowlist, timeout,
fallback, rate/budget, redaction, injection refusal và read-only authority phải pass trước release.
Chạy deterministic search/filter/FAQ trước để tiết kiệm chi phí; chỉ gọi model khi cần hiểu câu tự
nhiên hoặc phrasing support. `cx/gpt-5.6-luna` là fallback cấu hình được owner cho phép, không tự
fallback sang model đắt hơn.

## 3B. Feature 003 — Quantity Checkout, Payment UX, and Notifications (bắt buộc)

Đọc toàn bộ pack `specs/003-notifications-quantity-checkout/` gồm `spec.md`, `plan.md`,
`research.md`, `data-model.md`, `contracts/`, `checklists/`, `quickstart.md`, `tasks.md`,
`traceability.md`, và `analysis.md`. Đây là phần mở rộng đã chốt; không tạo spec cạnh tranh và
không đổi `.specify/feature.json` khỏi Feature 001 trong phiên đang triển khai MVP.

### Quantity và giao nhiều đơn vị

- Một Order chỉ có một Product Variant, nhưng quantity là số nguyên `1..max_per_order`; không tạo
  multi-item cart. Server revalidate giá, giới hạn, stock, source capability và resale eligibility.
- Snapshot unit price/total/warranty/delivery/source/reconciliation policy; total là integer VND
  `unit_price_vnd × quantity` với bounds/overflow guard. Reservation local phải atomic all-or-nothing.
- Supplier dùng một request quantity idempotent hoặc child keys `{orderId}:{unitIndex}`. Timeout
  không rõ kết quả là `Unknown`, partial success là `PARTIAL_FULFILLMENT_REVIEW`; chỉ hoàn tất khi đủ N
  asset hợp lệ hoặc replacement/refund resolution được duyệt. Delivery Bundle không reveal raw credential
  trong lịch sử Telegram.

### VietQR/SePay payment session

- Trước settlement dùng `Đã tạo đơn`/`Chờ thanh toán`, không nói `Đặt hàng thành công`.
- Payment card phải có ảnh QR và Order code, sản phẩm/variant, quantity, unit price, exact total,
  ngân hàng, chủ TK, số TK, nội dung CK, expiry theo giờ Việt Nam, cảnh báo chuyển đúng, nút
  `Kiểm tra thanh toán`, nút `Hủy thanh toán`.
- VietQR chỉ khởi tạo; SePay là payment truth. Check đọc projection local, idempotent/rate-limited,
  không poll SePay đồng bộ mỗi click và không mark paid. Cancel giải phóng reservation chỉ khi unpaid
  cancellation thắng; verified settlement luôn thắng race. Sai/thiếu/thừa/trễ/unmatched vào đối soát
  theo chính sách integer VND, tuyệt đối không hardcode hoặc tự đổi `$2`.

### Notification và anti-spam

- Transactional (owner-only) và CRITICAL_SERVICE (rare, non-marketing) không thể tắt. SHOP_UPDATE và
  PURCHASE_ACTIVITY có toggle riêng, quiet hours và digest frequency; preference áp dụng ngay trước send.
- Product/restock phải nêu tên product/variant, quantity thêm, stock sau, giá hiện tại và deep link.
  Purchase activity là aggregate/debounce (pilot mặc định tối đa khoảng một message/recipient/10 phút),
  nhưng mọi sale vẫn góp vào digest. Cấm buyer name/username/ID, Order code, transfer content,
  ngân hàng/số TK, credential, private total.
- Admin broadcast chỉ numeric root admin `ADMIN_TELEGRAM_USER_ID` trong private chat; username
  `Quyenvjp` chỉ drift metadata. Draft → sanitized preview/estimate → step-up confirm/schedule/send/cancel,
  immutable audit, outbox/worker batches, dedupe, Telegram `retry_after`/backoff, blocked-chat suppression,
  progress metrics và cancel unsent. Không arbitrary URL/file/HTML, credential-like content, hoặc marketing
  trong critical-service.

### Thứ tự thực thi Feature 003

1. Test trước rồi làm `T310`–`T332` (quantity + payment) và gắn vào payment phase hiện tại của Feature 001.
2. Làm `T333`–`T341` transactional sau khi Order/payment/fulfillment event đã commit ổn định.
3. Làm `T342`–`T350` product/activity, `T351`–`T359` admin broadcast, `T360`–`T366` preferences.
4. Chạy `T367`–`T372` cross-cutting evidence. Không claim done nếu còn Critical/High hoặc thiếu privacy,
   replay, concurrency, 429, restart, redaction và audit evidence.

Trong giai đoạn này không thêm wallet/nạp số dư, multi-item cart, Telegram Stars, marketing bypass,
hoặc reseller controls vào retail menu.

## 4. Quy tắc payment tuyệt đối

- VietQR chỉ tạo/hiển thị QR exact amount + unique Order content.
- SePay là lớp xác minh và reconciliation.
- Verify chữ ký trên timestamp + raw request body trước khi parse/reserialize.
- Áp dụng replay window, constant-time signature comparison, transaction ID uniqueness,
  inbound direction, merchant account, exact amount và Order content/reference matching.
- Screenshot, chat text, return URL, QR image và nút kiểm tra trạng thái không phải payment evidence.
- Duplicate/reordered webhook phải hội tụ một kết quả.
- Partial, over, late, wrong-content, wrong-account và unmatched transaction vào `NeedsReview`;
  không silent fulfill và không làm mất dấu giao dịch.
- Webhook phải durable-ack nhanh; fulfillment chạy qua outbox/worker.
- Reconciliation phải bắt được webhook bị mất và không bypass verification rules.

Không tích hợp Telegram Stars vào implementation này. Tuy nhiên không được xóa hoặc che giấu
policy-risk note; production launch vẫn cần owner sign-off theo tài liệu.

## 5. Quy tắc supplier và secure delivery

- Chỉ SKU có bằng chứng resale/transfer mới được active.
- Ưu tiên invite/license/seat/activation key hơn shared credential.
- Supplier create-order phải có stable idempotency key.
- Timeout không rõ kết quả phải vào `Unknown`; query/reconcile trước create retry.
- HTTP 200 không đồng nghĩa asset hợp lệ; validate SKU/type, uniqueness, region, duration/expiry và usability.
- Không silent substitute supplier/SKU.
- Raw credential chỉ nằm trong vault boundary.
- Không để raw credential trong PostgreSQL domain tables, log, trace, analytics, event, outbox,
  support transcript, error response, reseller webhook hoặc Telegram history.
- Delivery Bundle phải bind đúng Customer + Order, có TTL, atomic first view và controlled reissue.
- Replay/crash không được tạo supplier purchase, asset hoặc Delivery Bundle thứ hai.

## 6. Root admin và bảo mật

- Root admin duy nhất lấy từ `ADMIN_TELEGRAM_USER_ID=<numeric id>`.
- `ADMIN_EXPECTED_USERNAME=Quyenvjp` chỉ dùng để hiển thị/cảnh báo drift, không authorize.
- Không có `/add-admin`, add-admin API hoặc username fallback.
- Admin action chỉ trong private context; action nguy hiểm cần expiring step-up/confirmation,
  action fingerprint, idempotency, reason và immutable audit.
- Mọi customer object access phải kiểm tra ownership server-side; opaque ID không thay authorization.
- External input và third-party response đều là untrusted data, validate bằng allowlist tại boundary.
- Áp dụng body limits, rate limits theo action/user, dedupe, queue backpressure, safe errors và secret redaction.
- Critical/High STRIDE/OWASP finding phải được sửa trước khi tiếp tục release gate.

## 7. Tech stack đã chốt

- Node.js 24 LTS + TypeScript strict.
- Fastify 5, grammY 1, Zod 4, Kysely 0.29.
- PostgreSQL là source of truth.
- Transactional outbox là authoritative delivery mechanism.
- Redis/BullMQ chỉ dùng cho ephemeral rate limit/cache/job khi có lý do; không là payment/order/stock truth.
- Vitest 4, Testcontainers 12, fast-check 4.
- Pino 10 + OpenTelemetry.
- Một codebase modular monolith, hai entrypoint `main.ts` và `worker.ts`; không tự tách microservices.

Trước khi khóa dependency, kiểm tra lại official docs và phiên bản hiện hành. Commit lockfile.
Không dùng API/package hoặc behavior chỉ dựa trên trí nhớ.

## 8. Missing production values không được chặn local implementation

Không yêu cầu tao đưa secret vào chat. Với các giá trị chưa có:

- Telegram bot token.
- Numeric Telegram admin ID thật.
- SePay production key/account.
- Supplier production credentials.
- Vault production configuration.

Hãy dùng typed environment placeholders, sandbox/test fixtures và fake adapters. Production startup
phải fail closed nếu thiếu giá trị bắt buộc. Ghi các giá trị cần owner cung cấp vào
`specs/001-telegram-shop-mvp/launch-gates.md`, không hardcode và không commit secret.

Nếu chưa có supplier thật, hoàn thiện Supplier Port, contract tests, sandbox adapter và fixture-based
walking skeleton. Không scrape, login automation, captcha solve hoặc bypass provider/region policy.

## 9. Báo cáo tiến độ

Trong khi làm:

- Báo ngắn khi bắt đầu/kết thúc mỗi phase.
- Nêu test nào đã fail trước implementation và test nào đã pass sau đó.
- Nếu phát hiện design contradiction hoặc security blocker, dừng đúng boundary đó, ghi evidence và
  đề xuất sửa artifact; không tự nới lỏng Constitution.
- Không báo hoàn thành chỉ vì build pass; cần full test, quickstart, traceability và launch-gate status.

Khi kết thúc, trả về:

1. Phase/task đã hoàn thành và task còn lại của Feature 001 (`T001`–`T114`) cùng Feature 003 (`T301`–`T372`).
2. File thay đổi theo module.
3. Exact commands/checks đã chạy và kết quả.
4. Coverage/replay/concurrency/security/restore evidence.
5. Production launch gates còn thiếu.
6. Residual risks, không che giấu.

## 10. Lệnh bắt đầu

Bắt đầu bằng preflight read-only:

1. Xác nhận working directory và liệt kê cấu trúc hiện tại.
2. Kiểm tra git status; không revert thay đổi có sẵn và không push/deploy.
3. Chạy Spec Kit prerequisite/analysis checks hiện có.
4. Đối chiếu `tasks.md` với trạng thái filesystem.
5. Sau đó tiếp tục từ task chưa hoàn thành đầu tiên của Feature 001; khi payment boundary đủ evidence,
   chạy Feature 003 theo dependency `T301`–`T372` và cập nhật checkbox/evidence thật.

Tiếp tục theo task list cho tới khi hoàn thành tối đa công việc an toàn trong phiên. Không bỏ qua
test-first, không đánh dấu task chưa có evidence và không mở rộng scope.

---
