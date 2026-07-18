# Codex prompt — hoàn thiện SePay/VietQR theo tài liệu chính thức

Workspace: `C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Đọc trước:

- `C:\Users\ADMIN\.codex\AGENTS.md`
- `.specify/memory/constitution.md`
- `docs/01-research/SEPAY_WEBHOOK_INTEGRATION_2026-07-17.md`
- `specs/001-telegram-shop-mvp/spec.md`
- `specs/001-telegram-shop-mvp/contracts/payment-sepay.md`
- `specs/001-telegram-shop-mvp/tasks.md`
- source/test/config payment hiện tại.

T122/T127 đang được check local với evidence 382/382 tests. Không tin checkbox một cách mù quáng:
chạy `$harness-sync`, `$speckit-analyze` và review source theo official contract dưới đây. Reopen hoặc
tạo task correction bằng Spec Kit nếu acceptance chưa đúng. Không sửa ngoài payment/VietQR/ops
scope và không reset thay đổi đang có của user/agent khác.

## Official sources

- https://developer.sepay.vn/vi/sepay-webhooks
- https://developer.sepay.vn/vi/sepay-webhooks/bat-dau-nhanh
- https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook
- https://developer.sepay.vn/vi/sepay-webhooks/tao-webhook
- https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc
- https://developer.sepay.vn/vi/sepay-webhooks/bao-mat
- https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi
- https://developer.sepay.vn/vi/sepay-webhooks/giam-sat
- https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich
- https://developer.sepay.vn/vi/dia-chi-ip
- https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code
- https://docs.sepay.vn/tich-hop-google-sheets.html

## P0 corrections phải chứng minh bằng test

### 1. Durable accept rồi ACK nhanh

Current `createSePayIngressHandler` đang gọi `applyPaymentEvidence()` trong webhook request trước khi
ACK. Sửa thành:

```text
receive raw request
-> verify trusted source/HMAC/timestamp/schema
-> transactionally persist immutable SePay inbox event + raw hash/auth metadata
-> duplicate-identical: ACK success
-> duplicate-mutated: persist discrepancy/security alert
-> ACK HTTP 200 exact {"success":true}
-> worker asynchronously applies evidence/matcher/outbox
```

Không gọi supplier, Telegram, external reconciliation API hoặc business handler chậm trong request.
Acceptance phải đo response dưới 30 giây và dùng tighter project target.

### 2. Exact response contract

- Chỉ `200` hoặc `201` + JSON exact `{"success":true}` là success contract.
- `202`, redirect, body rỗng/body khác, timeout là failure fixture.
- Invalid HMAC/schema/IP có status fail-closed và không persist verified evidence.
- Khi internal business processing tạm lỗi sau durable accept, không làm SePay gửi lại vô hạn; inbox
  worker retry bounded từ PostgreSQL.

### 3. Payload đầy đủ và exact matching

Validate/persist allowlisted payload fields:

`id`, `gateway`, `transactionDate`, `accountNumber`, `subAccount`, `code`, `content`,
`transferType`, `description`, `transferAmount`, `accumulated`, `referenceCode`.

Automatic settlement yêu cầu đồng thời:

- `transferType === "in"`;
- merchant account chính xác;
- integer VND amount chính xác;
- structured `code` khớp một live/recoverable Payment Intent khi có;
- content/reference policy chỉ là bounded fallback, không thay thế structured code;
- transaction time hợp lệ;
- provider event chưa allocation cho Order khác.

Cùng webhook `id` + payload giống hệt là duplicate success. Cùng `id` nhưng raw hash/account/amount/
code/content khác là discrepancy/security alert; không silently ACK như identical duplicate.

### 4. HMAC, proxy và IP

- Verify `X-SePay-Signature: sha256=...` trên `${timestamp}.${raw_body}`.
- `X-SePay-Timestamp` Unix seconds; default replay window 300s; reject stale và future.
- Constant-time comparison; raw bytes không parse/stringify lại.
- Chỉ tin `X-Forwarded-For` khi peer thuộc configured trusted proxy.
- IP allowlist là typed config có rotation. Seed `.env.example` bằng placeholder/comment hoặc current
  official list theo policy, nhưng runtime/runbook phải buộc refresh từ official source; không coi
  danh sách copy hôm nay là bất biến.
- Không log HMAC secret, API token, Authorization header hoặc raw payload.

### 5. Immutable raw evidence retention

Official docs yêu cầu lưu raw payload trước xử lý. Chốt và implement một trong hai cách an toàn:

- encrypted raw payload/blob với retention/access policy; hoặc
- approved external encrypted evidence store + DB raw hash/provenance pointer.

Không lưu plaintext transaction payload chứa PII vào log/outbox/analytics. Worker parse từ immutable
evidence copy; audit vẫn đối chiếu được raw hash.

### 6. Reconciliation API thật

Current config default cũ không được nối mù vào production. Implement adapter/contract fixtures theo
official current endpoint:

```text
GET https://userapi.sepay.vn/v2/transactions
Authorization: Bearer <SEPAY_API_TOKEN>
```

- date range hoặc `since_id` cursor;
- `page`/`per_page` tối đa 100;
- rate limit 3 request/giây, 429 backoff/jitter;
- timeout/5xx/malformed response/duplicate/reordered fixtures;
- cron bounded 15–30 phút và backlog/lag telemetry;
- API transaction ID có thể khác kiểu/namespace webhook integer ID; dùng source-qualified text IDs;
- reconciliation evidence phải đi qua cùng matcher, không trực tiếp mark paid.

### 7. VietQR theo SePay

SePay image endpoint:

```text
https://vietqr.app/img?acc={ACCOUNT}&bank={BANK}&amount={VND}&des={CODE}
```

- `des` URL-encode; amount integer VND.
- MB config public: alias/code `MB`, short name `MBBank`, BIN `970422`.
- Current official image template allowlist: default/empty, `compact`, `qronly`, `standee`.
- Repo đang default `compact2`; nếu dùng SePay image contract thì đổi sang `compact` hoặc explicit
  allowlisted config. Không nhầm image template với NAPAS service code.
- QR chỉ khởi tạo chuyển khoản, không phải payment evidence.

Beneficiary owner đã cung cấp phải được inject qua environment/secret manager:

```text
VIETQR_BANK_ALIAS=MB
VIETQR_BANK_BIN=970422
VIETQR_ACCOUNT_NUMBER=<owner-provided>
VIETQR_ACCOUNT_NAME=<owner-provided>
SEPAY_MERCHANT_ACCOUNT_ID=<explicitly configured>
```

Không hardcode account number/name vào source, test fixture công khai hoặc log. Giữ merchant
matching và VietQR beneficiary thành hai env fields dù production pilot dùng cùng giá trị.

### 8. Google Sheet boundary

Owner-provided Google Sheet hiện public CSV-readable và mới có header. Không dùng Sheet để quyết
định Order paid hoặc giao account.

- Sheet là admin audit/projection optional.
- Nếu cần integration, ưu tiên SePay official OAuth2 Google Sheets; App Script thủ công chỉ fallback.
- Sheet writer chạy async từ verified event, dedupe provider ID, không chứa raw secret.
- Không poll Sheet từ nút “Kiểm tra thanh toán”. Nút chỉ đọc local projection; reconciliation job
  dùng SePay API theo budget.
- Cân nhắc chuyển sheet về restricted access vì transaction data là dữ liệu tài chính.

### 9. Monitoring/operations

Runbook phải bao phủ:

- SePay delivery history, HTTP status/latency, request/response inspection đã redacted;
- retry tối đa 8 send theo lịch documented;
- manual replay single/bulk và idempotency;
- alert threshold + Telegram/Slack/Discord, cooldown/recovery;
- discrepancy backlog, signature failure, duplicate mutation, reconciliation lag;
- provider outage, 429, endpoint down >5h và manual recovery.

## TDD matrix tối thiểu

Viết RED trước khi sửa:

1. Exact official payload fixture và nullable/empty fields.
2. Exact HMAC raw-body Unicode/whitespace/key-order fixture.
3. 300s stale/future timestamp.
4. Trusted proxy spoof và IP reject.
5. Duplicate identical ACK once; duplicate mutation discrepancy.
6. Durable commit trước ACK; worker crash sau ACK vẫn settle được.
7. Slow `applyEvidence` không làm webhook response chờ.
8. Response exact 200 + `{"success":true}`.
9. `transferType=out`, wrong account, wrong amount, null/wrong code, late payment.
10. Reconciliation v2 pagination, `since_id`, 3 req/s, 429/5xx/timeout/malformed.
11. QR MB alias/BIN, URL encoding, template allowlist và exact amount/code.
12. Google Sheet không thể mark paid hoặc trigger delivery.

Test bằng PostgreSQL Testcontainers thật; không `skip`, không network live trong CI, không dùng
credential thật. Official-shaped fixture phải độc lập với implementation parser.

## Verification gate

Chạy tối thiểu:

```text
npm run typecheck
npm run lint
npm run format:check
npm run secret-scan
npm run build
npm run audit
npm run test
```

Sau đó `$harness-review --security` hoặc `$harness-review` theo bốn góc spec/security/concurrency/
operations. Chỉ check task khi zero Critical/Major và evidence phản ánh source hiện tại. Feature 001
vẫn `REQUEST_CHANGES` cho tới khi các production paths khác hoàn tất.

Không dừng để hỏi “có tiếp tục không?” giữa các correction đã rõ. Chỉ dừng khi cần owner cung cấp
rotated HMAC/API token, cấu hình SePay Dashboard hoặc production HTTPS URL; không yêu cầu user dán
secret vào chat.
