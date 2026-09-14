# SePay Webhook và VietQR — nghiên cứu chính thức ngày 2026-07-17

## Kết luận ngắn

SePay Webhook là nguồn sự kiện realtime để backend tiếp nhận giao dịch, nhưng không nên xử lý
nghiệp vụ dài trong HTTP request. Endpoint phải xác thực raw body, ghi inbox/bank transaction bền
vững, trả đúng response contract cho SePay, rồi xử lý đối soát/settlement bất đồng bộ.

Google Sheet owner cung cấp đang đọc được ở dạng CSV và hiện chỉ có hàng tiêu đề. Nó phù hợp làm
projection/audit cho admin, không được dùng làm payment truth hoặc căn cứ tự động giao account.
Payment truth vẫn là verified SePay evidence từ webhook hoặc SePay Transaction API.

## Nguồn chính thức đã kiểm tra

- [SePay Webhooks overview](https://developer.sepay.vn/vi/sepay-webhooks)
- [Bắt đầu nhanh](https://developer.sepay.vn/vi/sepay-webhooks/bat-dau-nhanh)
- [Tích hợp webhook](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook)
- [Tạo webhook](https://developer.sepay.vn/vi/sepay-webhooks/tao-webhook)
- [Xác thực webhook](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc)
- [Bảo mật webhook](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [Xử lý lỗi](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)
- [Giám sát webhook](https://developer.sepay.vn/vi/sepay-webhooks/giam-sat)
- [Đối soát giao dịch](https://developer.sepay.vn/vi/sepay-webhooks/doi-soat-giao-dich)
- [API giao dịch v1](https://developer.sepay.vn/vi/sepay-api/v1/api-giao-dich)
- [Tạo API token](https://developer.sepay.vn/vi/sepay-api/v1/tao-api-token)
- [Tạo QR/VietQR](https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code)
- [Tích hợp Google Sheets](https://docs.sepay.vn/tich-hop-google-sheets.html)

## Payload chuẩn và chống trùng

Webhook JSON chính thức có các trường:

| Trường | Quy tắc cần giữ ở boundary |
|---|---|
| `id` | integer trong webhook; không đổi qua retry/replay; khóa chống trùng |
| `gateway` | tên ngân hàng |
| `transactionDate` | `YYYY-MM-DD HH:mm:ss`, giờ Việt Nam |
| `accountNumber` | tài khoản ngân hàng nhận giao dịch |
| `subAccount` | VA/TKP, có thể rỗng |
| `code` | mã thanh toán theo cấu hình prefix, có thể `null` |
| `content` | nội dung chuyển khoản nguyên văn |
| `transferType` | `in` hoặc `out`; shop chỉ tự động xét `in` |
| `description` | mô tả ngân hàng, có thể rỗng |
| `transferAmount` | số nguyên VND dương |
| `accumulated` | số dư tích lũy, có thể 0 |
| `referenceCode` | mã tham chiếu, có thể rỗng |

Một giao dịch có thể được gửi bởi retry tự động, replay thủ công hoặc nhiều webhook. Database phải
dedupe bằng provider event ID trong namespace của provider; duplicate hợp lệ phải trả success để
SePay không retry và tuyệt đối không tạo thêm allocation/fulfillment.

Lưu ý: trang reconciliation API v2 có thể dùng `id` UUID/reference khác payload webhook integer.
Không ép hai nguồn vào một kiểu ID không có namespace; lưu `source`, `provider_event_id` dạng text
và map rõ nguồn.

## Response contract bắt buộc

SePay coi delivery thành công khi đồng thời đạt:

1. HTTP status `200` hoặc `201`.
2. Body JSON chính xác `{"success": true}`.
3. Response hoàn tất trong dưới 30 giây.

`202`, redirect, `4xx`, `5xx`, body rỗng hoặc body khác đều có thể bị coi là thất bại. Endpoint
phải persist inbox/evidence envelope trước rồi trả response nhanh; settlement, matching, outbox và
fulfillment chạy async. Không giữ request chờ supplier hoặc Telegram.

Tài liệu xử lý lỗi mô tả retry khi status ngoài 200–299, trong khi trang response contract chặt hơn
với 200/201. Implementation chọn contract chặt 200/201 và phải test delivery thật trong SePay
Dashboard sau khi cấu hình.

## Xác thực và bảo mật

### HMAC-SHA256 — lựa chọn production

- Header `X-SePay-Timestamp`: Unix seconds.
- Header `X-SePay-Signature`: `sha256={hex_hash}`.
- Chuỗi ký chính xác: `${timestamp}.${raw_body}`.
- HMAC chạy trên raw bytes, không parse rồi `JSON.stringify` lại.
- So sánh constant-time.
- Reject timestamp ngoài replay window; NTP phải chính xác.
- HTTPS public URL, certificate hợp lệ và IP allowlist là defense in depth.

### Các lựa chọn khác

- API Key: `Authorization: Apikey ...`; tối thiểu cho endpoint đơn giản, không thay thế toàn vẹn
  payload của HMAC.
- OAuth 2.0: SePay dùng client credentials/token endpoint rồi gửi Bearer token.
- No-auth: chỉ dùng khi test, không production.

Không tự suy đoán IP SePay. Danh sách phải lấy từ [trang IP chính thức](https://developer.sepay.vn/vi/dia-chi-ip),
được cấu hình có thể cập nhật và kiểm thử qua trusted proxy boundary.

## Tạo webhook trên SePay

Wizard chính thức có bốn nhóm bước:

1. Tên, HTTPS URL production, event tiền vào/ra/cả hai, JSON và auto retry.
2. Chọn tài khoản, VA/TKP và payment-code prefix; prefix phân biệt hoa thường.
3. Chọn HMAC/API Key/OAuth2.
4. Cảnh báo theo ngưỡng lỗi liên tiếp và kênh Telegram/Slack/Discord.

Shop này chỉ nên chọn event tiền vào, account nhận tiền chính xác và prefix nội dung chuyển khoản
được quản lý trong config. Test “gửi thử” chỉ là sample; phải có test transaction thật trước launch.

## Retry, monitoring và reconciliation

SePay có thể retry tối đa 8 lần theo lịch Fibonacci xấp xỉ `+1m,+1m,+2m,+3m,+5m,+8m,+13m` và
dashboard ghi lại status, HTTP status, response time, transaction và request/response detail.
Replay thủ công có thể replay một hoặc nhiều log, nên endpoint bắt buộc idempotent. Alert có ngưỡng
lỗi liên tiếp, cooldown và thông báo recovery.

Đối soát định kỳ phải gọi SePay Transaction API bằng Bearer API token, theo date range hoặc
`since_id`, page tối đa 100 và giới hạn rate chính thức. Cron đối soát 15–30 phút là lớp bảo vệ khi
webhook bị lỗi; mọi transaction lấy từ API vẫn phải đi qua cùng verifier/matcher, không bypass
payment truth.

## VietQR và beneficiary config

URL ảnh QR của SePay chỉ còn giá trị lịch sử — production render QR local:

```text
https://vietqr.app/img?acc={SO_TK}&bank={NGAN_HANG}&amount={VND}&des={NOI_DUNG}
```

Endpoint trên là ghi chú lịch sử, KHÔNG còn được dùng: bot build payload EMVCo từ
`buildVietQrPayload` rồi render ảnh local bằng `qrcode.toBuffer(payload)` tại presenter.
Nếu sau này cần dùng lại, `des` phải URL-encode. QR chỉ điền sẵn thông tin chuyển khoản; QR không
chứng minh thanh toán.

Owner-provided production beneficiary phải inject bằng secret/config manager, không hardcode vào
source hoặc docs chứa credential:

```text
VIETQR_BANK_ALIAS=MB
VIETQR_BANK_BIN=970422
VIETQR_ACCOUNT_NUMBER=<owner-provided value>
VIETQR_ACCOUNT_NAME=<owner-provided value>
SEPAY_MERCHANT_ACCOUNT_ID=<same-or-distinct value, explicitly configured>
```

SePay matching và VietQR rendering phải giữ hai config surface riêng dù pilot có thể dùng cùng một
tài khoản. Bank alias/BIN phải validate; account name chỉ là display snapshot.

## Google Sheet owner cung cấp

CSV export đã trả HTTP 200 và có các cột:

```text
Ngân hàng, Ngày giao dịch, Số tài khoản, Tài khoản phụ, Code TT,
Nội dung thanh toán, Loại, Số tiền, Mã tham chiếu, Lũy kế
```

Tài liệu SePay khuyến nghị tích hợp Google Sheets chính thức qua OAuth2; App Script thủ công bị
khuyến cáo vì phức tạp và phụ thuộc webhook. Dù dùng cách nào:

- Sheet chỉ là read-only audit/projection cho admin.
- Không cho customer/bot polling sheet để mark paid.
- Không cấp account dựa trên một dòng sheet chưa có verified SePay evidence.
- Không public sheet chứa raw transaction nếu chưa chấp nhận rủi ro dữ liệu.
- Nếu cần export, worker ghi projection bất đồng bộ và dedupe theo provider event ID.

## Việc cần đưa vào code/spec

1. Bổ sung official payload/response/HMAC/retry fixtures vào `tests/contract/sepay-runtime-ingress.test.ts`.
2. Đổi T122/T127 từ “đã có verifier” thành acceptance production: persist inbox rồi ack nhanh,
   apply evidence async, duplicate trả `{"success":true}`.
3. Thêm reconciliation API adapter với Bearer token, rate limit 3 req/s, page/per_page cap và
   namespace ID khác webhook payload.
4. Thêm monitoring/alert/replay runbook; redact request headers/body chứa secret.
5. Thêm env/config cho MB alias/BIN và owner beneficiary; không ghi account thật vào Git.
6. Thêm Google Sheet projection tùy chọn sau khi payment truth đã đúng; không xem Sheet là nguồn
   thanh toán.
7. Test negative: `transferType=out`, sai account, sai amount, code null/sai prefix, replay, duplicate
   mutation, timestamp cũ/tương lai, HMAC sai, IP không allowlist, 429 API và webhook timeout.
