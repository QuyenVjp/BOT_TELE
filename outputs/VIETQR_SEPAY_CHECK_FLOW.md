# VietQR + SePay: luồng tạo QR, kiểm tra tiền vào và đối soát cho bot bán account/access

Ngày nghiên cứu: 2026-07-16. Phạm vi đã chốt: **chỉ dùng VietQR để tạo QR và SePay để nhận/check/đối soát giao dịch**. Nguồn chỉ gồm tài liệu chính thức VietQR, NAPAS và SePay.

## Kết luận kiến trúc

> **VietQR là lớp tạo lệnh chuyển khoản/ảnh QR. VietQR không chứng minh tiền đã vào. SePay mới là lớp nhận biến động số dư, xác thực webhook, truy vấn giao dịch và đối soát.**

Bot không được chuyển đơn sang `PAID` từ ảnh QR, `returnUrl`, ảnh biên lai, nút “Tôi đã thanh toán”, nội dung chat hoặc việc QR được tạo thành công. Chỉ ghi nhận thanh toán khi event SePay đã được xác thực và đồng thời khớp tất cả invariant: giao dịch tiền vào, đúng tài khoản, đúng mã đơn, đúng số tiền, đơn còn hiệu lực và SePay transaction ID chưa xử lý.

```text
Bot -> Order service -> VietQR Generate API -> gửi QR cho khách
                                           khách chuyển khoản
Ngân hàng -> SePay -> webhook HMAC -> Payment inbox -> worker -> Order PAID
                                                |                 |
                                                +-> dedupe        +-> fulfillment exactly once

SePay API v2 <---------------- reconciliation job <---------------+
```

## Nguồn chính thống

- [VietQR Generate API `v2/generate`](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr)
- [VietQR Quick Link](https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/)
- [NAPAS 247 bằng VietQR](https://napas.com.vn/dich-vu-chuyen-tien-nhanh-napas-247)
- [SePay webhook quickstart](https://developer.sepay.vn/vi/sepay-webhooks/bat-dau-nhanh)
- [SePay tích hợp webhook và payload](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook)
- [SePay xác thực webhook](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc)
- [SePay bảo mật webhook](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [SePay retry và xử lý lỗi](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)
- [SePay đối soát giao dịch](https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich)
- [SePay QR và form thanh toán](https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan)
- [SePay API v2](https://developer.sepay.vn/vi/sepay-api/v2/gioi-thieu)
- [SePay API v2 authentication/rate limit](https://developer.sepay.vn/vi/sepay-api/v2/xac-thuc)
- [Danh sách IP công khai của SePay](https://developer.sepay.vn/vi/dia-chi-ip)

## 1. Tạo order trước, tạo QR sau

### Dữ liệu order tối thiểu

```text
order_id              UUID/ULID nội bộ
public_code           mã ngắn để đưa vào addInfo; UNIQUE, không chứa PII
telegram_user_id      chủ sở hữu đơn
product_id            account/access SKU
unit_price_vnd        snapshot giá tại lúc đặt
quantity              giới hạn theo SKU
amount_due_vnd        integer, tính hoàn toàn ở server
receive_account_no    tài khoản ngân hàng dự kiến nhận
status                AWAITING_PAYMENT...
expires_at            thời điểm hết hạn thanh toán
created_at/updated_at
```

Quy tắc:

1. Client/bot chỉ gửi `product_id` và `quantity`; backend tự đọc giá và tính `amount_due_vnd`.
2. Tiền VND dùng integer; không dùng float.
3. `public_code` là mã duy nhất, không chứa tên, số điện thoại, Telegram username hay bí mật account/access.
4. Mỗi user chỉ có tối đa một order chưa thanh toán cho cùng SKU; bấm lại trả order/QR cũ còn hiệu lực thay vì tạo vô hạn.
5. Order phải được commit vào DB trước khi gọi VietQR; retry tạo QR không tạo order mới.

## 2. Gọi VietQR Generate API

Tài liệu VietQR mô tả request `POST /v2/generate`, xác thực bằng `x-client-id` và `x-api-key`. Payload điển hình:

```json
{
  "accountNo": "0123456789",
  "accountName": "TEN CHU TAI KHOAN",
  "acqId": 970436,
  "amount": 129000,
  "addInfo": "DH01J9N7K2P",
  "format": "text",
  "template": "compact"
}
```

Thiết kế an toàn:

- Gọi VietQR từ backend. Không đưa `x-api-key`, `x-client-id` vào Telegram message, frontend hoặc log.
- `accountNo`, `accountName`, `acqId` lấy từ cấu hình server đã duyệt, không lấy từ input người dùng.
- `amount` lấy từ `order.amount_due_vnd`; `addInfo` lấy từ `order.public_code`.
- Lưu `qr_payload_hash`, thời điểm tạo và response metadata cần thiết; không coi response `generate successful` là payment event.
- Có thể dùng Quick Link cho hiển thị đơn giản, nhưng boundary vẫn không đổi: link/ảnh QR chỉ hướng dẫn chuyển khoản.
- Nếu VietQR lỗi/timeout, order vẫn ở `AWAITING_PAYMENT`; retry bằng cùng order, không sinh mã mới trừ khi order cũ bị hủy rõ ràng.

## 3. Webhook SePay là nguồn realtime

Payload chính thức có dạng:

```json
{
  "id": 92704,
  "gateway": "Vietcombank",
  "transactionDate": "2024-07-02 11:08:33",
  "accountNumber": "1017588888",
  "subAccount": "",
  "code": "DH01J9N7K2P",
  "content": "DH01J9N7K2P chuyen tien",
  "transferType": "in",
  "description": "NGUYEN VAN A chuyen tien",
  "transferAmount": 129000,
  "accumulated": 105000000,
  "referenceCode": "FT24012345678"
}
```

Ý nghĩa quan trọng:

- `id` là ID giao dịch SePay, không đổi qua retry/replay; dùng làm khóa chống trùng.
- `code` là mã thanh toán SePay trích từ nội dung theo cấu hình; có thể `null` nếu không match.
- `content` là nội dung chuyển khoản gốc; chỉ dùng fallback/manual review, không dùng fuzzy match để tự cấp hàng.
- `transferType` phải là `in`.
- `transferAmount` phải bằng chính xác `order.amount_due_vnd`.
- `accountNumber` phải nằm trong allowlist tài khoản nhận của merchant.
- `referenceCode` được lưu để audit/đối soát; nên có unique phụ nếu dữ liệu thực tế của ngân hàng bảo đảm ổn định.

## 4. Xác thực webhook bằng raw-body HMAC

Production chọn HMAC-SHA256. SePay mô tả chuỗi ký chính xác:

```text
signed_payload = X-SePay-Timestamp + "." + raw_http_body
expected       = "sha256=" + HMAC_SHA256_HEX(secret, signed_payload)
```

Headers:

```text
X-SePay-Signature: sha256={hex_hash}
X-SePay-Timestamp: {unix_seconds}
```

Thứ tự xử lý bắt buộc:

1. Đọc **raw bytes** của request body một lần; giới hạn body size và timeout.
2. Parse timestamp, từ chối nếu lệch quá `±300` giây theo ví dụ chính thức của SePay.
3. Tạo HMAC trên đúng `timestamp.raw_body`; không parse JSON rồi stringify lại vì whitespace, thứ tự key và Unicode có thể đổi chữ ký.
4. So sánh signature bằng constant-time compare (`timingSafeEqual`/tương đương), không dùng `===` thông thường.
5. Chỉ sau khi HMAC hợp lệ mới parse JSON và validate schema.
6. Secret nằm trong secret manager/env bảo vệ; hỗ trợ rotate, không log secret/signature đầy đủ.

HMAC là kiểm chứng nội dung/nguồn ở cấp ứng dụng. IP allowlist chỉ là lớp defense-in-depth, không thay thế HMAC.

## 5. IP allowlist

Tại ngày nghiên cứu, trang IP chính thức của SePay liệt kê:

```text
IPv4
172.236.138.20
172.233.83.68
171.244.35.2
151.158.108.68
151.158.109.79
103.255.238.139

IPv6
2400:8905::2000:8cff:fe98:45cd
2600:3c15::2000:8aff:fedd:874b
```

Quy tắc vận hành:

- Allowlist toàn bộ IPv4 và IPv6 ở reverse proxy/firewall; SePay có thể gửi từ bất kỳ IP nào trong danh sách.
- Danh sách có thể thay đổi. Tạo runbook kiểm tra trang chính thức định kỳ và cập nhật atomically trước khi xóa IP cũ.
- Nếu chạy sau CDN/proxy, chỉ tin `X-Forwarded-For` từ proxy đã cấu hình; không nhận header IP do internet client tự gửi.
- Không hard-code IP rải rác trong app; quản lý một cấu hình versioned và có health test.

## 6. Inbox idempotent và response hợp lệ

Unique constraint bắt buộc:

```sql
UNIQUE (provider, provider_transaction_id)
-- provider = 'sepay', provider_transaction_id = payload.id
```

Pseudo flow:

```text
verify HMAC/timestamp/IP -> validate JSON
  -> INSERT payment_webhook_inbox(provider, event_id, raw_body_hash, payload)
     ON CONFLICT DO NOTHING
  -> duplicate: trả {"success": true}, không enqueue/cấp hàng lại
  -> mới: enqueue inbox_id
  -> trả HTTP 200 hoặc 201 với body chính xác {"success": true}
```

SePay chỉ xem webhook thành công khi đủ ba điều:

1. HTTP status `200` hoặc `201`;
2. body JSON `{"success": true}`;
3. hoàn tất trong 30 giây.

Thiết kế nên trả trong vài trăm mili-giây sau khi durable inbox insert; mọi lookup order, transition và fulfillment chạy ở worker. Không trả `202`, redirect, body rỗng hoặc `{"status":"ok"}`.

## 7. Worker match giao dịch với order

Trong một DB transaction:

1. Lock inbox event và order match bằng `payload.code == order.public_code`.
2. Kiểm tra event chưa processed.
3. Kiểm tra `transferType == "in"`.
4. Kiểm tra `accountNumber == order.receive_account_no`.
5. Kiểm tra `transferAmount == order.amount_due_vnd`.
6. Kiểm tra order đang `AWAITING_PAYMENT` và chưa hết hạn/hủy.
7. Append payment event + compare-and-swap `AWAITING_PAYMENT → PAYMENT_CONFIRMED`.
8. Ghi outbox `FULFILL_ACCOUNT_ACCESS`; đánh dấu inbox processed trong cùng transaction.

Nếu không match chính xác:

- sai/thiếu `code`, sai số tiền, sai account, order hết hạn hoặc đã hủy → `REVIEW_REQUIRED`;
- không tự ghép fuzzy theo tên người gửi/nội dung;
- không tự refund; admin xử lý bằng RBAC + reason + audit log.

## 8. Fulfillment account/access exactly once

Vì sản phẩm là account/access, rủi ro lớn nhất là cấp cùng một credential nhiều lần hoặc lộ credential qua log/chat.

- Kho access có state `AVAILABLE → RESERVED → DELIVERED | RELEASED` và unique `delivered_order_id`.
- Reserve stock và tạo delivery record trong transaction/row lock; chỉ một worker thắng.
- Telegram send thất bại không được rollback payment. Dùng outbox retry riêng.
- Không log credential/token/password; mã hóa at rest. Ưu tiên one-time reveal URL ngắn hạn thay vì gửi secret vĩnh viễn trong chat.
- Resend/reveal lại cần xác thực đúng Telegram user của order, rate limit và audit.
- Chỉ bán account/access mà người bán có quyền phân phối; kiểm tra điều khoản nhà cung cấp trước khi tự động hóa cấp quyền.

## 9. Retry của SePay

Khi bật tự động gửi lại và endpoint lỗi, SePay dùng lịch Fibonacci:

| Lần | Chờ | Tổng thời gian |
|---:|---:|---:|
| 1 | ngay | 0 phút |
| 2 | 1 phút | 1 phút |
| 3 | 1 phút | 2 phút |
| 4 | 2 phút | 4 phút |
| 5 | 3 phút | 7 phút |
| 6 | 5 phút | 12 phút |
| 7 | 8 phút | 20 phút |
| 8 | 13 phút | 33 phút |

Tổng 8 lần trong khoảng 33 phút. Vì retry là hành vi bình thường, dedupe bằng DB unique key là bắt buộc. Không dùng “đã thấy trong memory” vì restart/multi-instance sẽ cấp hàng trùng.

## 10. Reconciliation bằng SePay API v2

Webhook lo realtime; API v2 lo tra cứu và đối soát. Reconciliation job cần:

1. Lưu high-water mark theo `transactionDate/id`, có overlap window để tránh mất event ở biên.
2. Định kỳ gọi danh sách giao dịch SePay API v2 theo khoảng thời gian/tài khoản.
3. Với mỗi giao dịch chưa có `(sepay, id)`, đi qua cùng canonical processor như webhook, không viết một nhánh logic payment khác.
4. Đối chiếu thêm `referenceCode`, account, amount, code và trạng thái order.
5. Alert khi webhook lag, signature fail, amount mismatch, event API có nhưng inbox không có hoặc fulfillment treo.

SePay API v2 dùng:

```text
Authorization: Bearer {api_key}
```

Rate limit chính thức:

- `3 request/giây` cho mỗi địa chỉ IP;
- kiểm tra rate limit trước authentication;
- vượt giới hạn trả `429 rate_limited`;
- đọc `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` để backoff.

Job phải phân trang tuần tự, giới hạn concurrency và backoff theo headers; không poll API để thay webhook realtime.

## 11. Chống spam ở bot

Rate limit của SePay API không thay thế anti-spam của bot. Áp dụng quota riêng, lưu ở Redis/DB atomic counter:

- `/start`/browse: giới hạn mềm theo `telegram_user_id` và IP nếu có web view;
- tạo order/QR: cooldown theo user, SKU và device; một active unpaid order/SKU;
- “check payment”: chỉ đọc trạng thái nội bộ, không gọi SePay API mỗi lần bấm;
- support/resend access: quota thấp hơn và tăng backoff;
- admin/manual review: RBAC, MFA nếu có web admin, audit mọi override.

Không dùng CAPTCHA cho Telegram-native flow như bằng chứng thanh toán. Nếu có web checkout, CAPTCHA chỉ là anti-bot ở edge, không thay webhook HMAC.

## 12. State machine chốt trước code

```text
Order:
CREATED
  -> AWAITING_PAYMENT
  -> PAYMENT_CONFIRMED
  -> FULFILLING
  -> FULFILLED

AWAITING_PAYMENT -> EXPIRED | CANCELLED | REVIEW_REQUIRED
PAYMENT_CONFIRMED -> REVIEW_REQUIRED | REFUND_PENDING
FULFILLING       -> FULFILLMENT_FAILED | FULFILLED

Payment event:
RECEIVED -> VERIFIED -> MATCHED -> APPLIED
           |           |
           +-> REJECTED+-> REVIEW_REQUIRED
```

Invariant:

- `PAYMENT_CONFIRMED` chỉ từ SePay event đã verify.
- `FULFILLED` chỉ có một delivery record và một inventory reservation thành công.
- Webhook duplicate luôn no-op nhưng trả success.
- Payment và delivery failure là hai sự cố khác nhau; không hạ order về unpaid khi gửi access thất bại.

## 13. Acceptance/security tests tối thiểu

- QR request lấy amount/account/addInfo hoàn toàn từ server.
- HMAC đúng/sai, thiếu header, raw-body khác một byte, timestamp cũ hơn 5 phút, timestamp tương lai.
- Webhook cùng `id` gửi 2–100 lần/concurrent chỉ tạo một payment event và một fulfillment.
- Đúng mã nhưng sai amount/account/transferType → review, không cấp hàng.
- Webhook đến sau order expired/cancelled → review.
- SePay retry khi endpoint timeout; handler duplicate vẫn trả `{"success": true}`.
- Worker crash sau inbox insert, sau payment commit và trước Telegram send: resume không cấp lại credential.
- Reconciliation tìm được giao dịch bị mất webhook và chạy cùng processor idempotent.
- SePay API trả 429: job tôn trọng `Retry-After`, không thundering herd.
- Rotate HMAC/API secrets, update IP allowlist và rollback cấu hình có runbook/test.

## Giới hạn phải ghi rõ trong PRD

1. VietQR tạo QR nhưng không bảo đảm người dùng đã chuyển, chuyển đúng số tiền hoặc tiền đã vào tài khoản.
2. SePay webhook là tín hiệu realtime; reconciliation API là lớp bù khi webhook thất lạc. Cả hai phải hội tụ vào cùng idempotent payment processor.
3. Không có “check payment” an toàn bằng cách cho bot tự đọc ảnh chuyển khoản hoặc query ngân hàng không chính thức.
4. IP allowlist không thay HMAC; HMAC không thay schema/invariant validation; cả hai không thay reconciliation.
5. Bot chỉ tự cấp account/access khi mọi điều kiện match tuyệt đối. Mọi trường hợp mơ hồ đi `REVIEW_REQUIRED`.

