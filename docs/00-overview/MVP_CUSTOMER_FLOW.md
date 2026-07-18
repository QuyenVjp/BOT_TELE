# MVP Customer Flow — Shop digital trong Telegram

> Trạng thái: đề xuất chốt trước khi code  
> Phiên bản: v0.2 — 2026-07-16

## 1. Product wedge

Đây là một **shop tự động trong Telegram**, không phải chatbot AI bán hàng và không phải một sàn commerce tổng quát.

Luồng tạo giá trị duy nhất của MVP:

```text
Mở bot
→ tìm/chọn sản phẩm
→ xem giá và điều kiện
→ mua ngay
→ quét VietQR
→ SePay xác minh giao dịch
→ lấy hàng từ kho hoặc Supplier API
→ giao qua link nhận một lần
→ xem lại đơn hoặc báo lỗi
```

Sản phẩm là account/access số chỉ khi supplier hoặc provider cho phép resale/transfer. Ưu tiên invite, license, seat hoặc activation key; shared credential chỉ được bán nếu có quyền rõ ràng và có cơ chế giao bí mật an toàn.

## 2. Mục tiêu UX

- Khách tìm được sản phẩm phù hợp trong dưới 20 giây.
- Từ menu chính tới VietQR trong tối đa 3–4 lần bấm ở happy path.
- Giá VND, thời hạn, tình trạng, cách giao và bảo hành hiện trước nút mua.
- Không bắt nhập tên, số điện thoại hoặc địa chỉ khi sản phẩm không cần các dữ liệu đó.
- Không yêu cầu gửi ảnh biên lai.
- Sau SePay xác minh, hệ thống tự giao hàng; khi supplier bình thường, mục tiêu dưới 60 giây.
- Bot ưu tiên sửa một message hiện tại thay vì bắn nhiều message mới.

## 3. Phạm vi MVP

1. Menu chính.
2. Danh mục sản phẩm.
3. Danh sách sản phẩm có phân trang.
4. Tìm kiếm từ khóa và tìm kiếm câu tự nhiên có giới hạn.
5. Chi tiết sản phẩm và variant.
6. Mua ngay một sản phẩm/variant.
7. Tạo Order và giữ hàng.
8. Tạo VietQR đúng số tiền, nội dung duy nhất và thời hạn.
9. SePay webhook/check/reconciliation xác minh tiền vào.
10. Lấy asset từ kho nội bộ hoặc Supplier API.
11. Giao hàng bằng Delivery Bundle xem một lần, có thời hạn.
12. Lịch sử và chi tiết đơn hàng.
13. Báo sản phẩm lỗi và hỗ trợ gắn với đơn.

## 4. Không xuất hiện trước khách lẻ trong MVP

- Ví, nạp số dư, ledger hoặc số dư reseller.
- Reseller API, API key, quota hoặc supplier infrastructure.
- Sales AI agent, hội thoại thuyết phục hoặc AI tự ra quyết định.
- Loyalty, referral, campaign, A/B testing, voice AI.
- Giỏ hàng nhiều món, coupon engine hoặc checkout nhiều bước.
- Mini App bắt buộc. Inline keyboard và message card là giao diện mặc định; chỉ thêm Mini App khi catalog thực tế chứng minh cần.

Supplier API và Reseller API vẫn có thể được thiết kế ở backend, nhưng là lane riêng sau khi retail walking skeleton ổn định. Chúng không được làm tăng số bước mua của khách lẻ.

## 5. Menu và màn hình chuẩn

### 5.1 Menu chính

```text
🛒 SHOP DIGITAL

Mua nhanh • Thanh toán VietQR
Giao tự động sau khi SePay xác nhận tiền

[ 🛍 Danh sách sản phẩm ]

[ 🔍 Tìm sản phẩm ] [ 📦 Đơn hàng ]
[ 💬 Hỗ trợ ]
```

### 5.2 Danh mục

```text
Chọn loại sản phẩm

[ AI & Chatbot ]
[ Thiết kế ]
[ Giải trí ]
[ VPN & Công cụ ]
[ Sản phẩm khác ]
```

Danh mục lấy từ database, chỉ hiển thị category đang active và có ít nhất một sản phẩm có thể bán.

### 5.3 Danh sách sản phẩm

```text
AI & Chatbot

[ Sản phẩm A — từ 149.000đ ]
[ Sản phẩm B — 199.000đ ]
[ Sản phẩm C — 299.000đ ]

[ ⬅️ ] [ Trang 1/3 ] [ ➡️ ]
[ 🔍 Tìm kiếm ]
[ 🏠 Menu chính ]
```

Không hiển thị sản phẩm inactive hoặc variant không thể bán. Callback chỉ chứa opaque ID/token; server luôn đọc lại giá và trạng thái từ source of truth.

### 5.4 Chi tiết sản phẩm

```text
📦 SẢN PHẨM A — 1 THÁNG

Giá: 149.000đ
Tình trạng: Còn hàng
Giao hàng: Tự động
Thời gian dự kiến: Dưới 1 phút
Bảo hành: 7 ngày

Mô tả ngắn và điều kiện sử dụng.

[ 🛒 Mua ngay — 149.000đ ]
[ ⬅️ Quay lại ] [ 🏠 Menu chính ]
```

Nếu có nhiều variant, khách chọn variant trước khi bấm mua. Giá hiển thị trong nút phải được server render từ snapshot hiện tại, không tin dữ liệu callback từ client.

### 5.5 Thanh toán

```text
💳 THANH TOÁN ĐƠN DH8K2P9

Sản phẩm: Sản phẩm A — 1 tháng
Số tiền: 149.000đ
Nội dung: DH8K2P9
Hết hạn: 10:45 16/07/2026

[ QR VIETQR ]

Hệ thống tự kiểm tra giao dịch qua SePay.
Không cần gửi ảnh biên lai.

Trạng thái: ⏳ Chờ thanh toán

[ 🔄 Kiểm tra trạng thái ]
[ Hủy đơn ]
```

Nút kiểm tra chỉ đọc trạng thái nội bộ mới nhất. Nó không gọi SePay theo từng click và không tự đánh dấu đã thanh toán.

### 5.6 Đã nhận tiền và đang giao

```text
✅ ĐÃ NHẬN THANH TOÁN

Đơn: DH8K2P9
Đang chuẩn bị sản phẩm...
```

Nếu kho/supplier chậm, bot hiển thị trạng thái đang xử lý và thời gian cập nhật tiếp theo. Không tạo Order mới hoặc gọi create supplier order lần hai vì khách bấm lại.

### 5.7 Giao thành công

```text
🎉 MUA HÀNG THÀNH CÔNG

Sản phẩm: Sản phẩm A — 1 tháng
Mã đơn: DH8K2P9
Bảo hành đến: 23/07/2026

[ 🔐 Nhận sản phẩm ]
[ 📖 Hướng dẫn sử dụng ]
[ 🛠 Báo sản phẩm lỗi ]
```

`Nhận sản phẩm` mở Delivery Bundle có TTL, xem một lần và ràng buộc đúng customer/order. Bot không gửi raw password tồn tại lâu trong lịch sử chat.

### 5.8 Lịch sử đơn

```text
📦 ĐƠN HÀNG CỦA BẠN

DH8K2P9 • Sản phẩm A • 149.000đ
✅ Hoàn tất • 16/07/2026 10:31
[ Xem chi tiết ]

DH7M1Q4 • Sản phẩm B • 199.000đ
⏳ Chờ thanh toán • hết hạn sau 06:12
[ Thanh toán ] [ Hủy ]
```

Mỗi khách chỉ xem được order thuộc Telegram numeric `user_id` đã ánh xạ với customer của họ.

### 5.9 Hỗ trợ

Khách chọn một trong các lý do có cấu trúc:

- Chưa nhận được hàng sau khi đã thanh toán.
- Link nhận hàng hết hạn/chưa mở được.
- Asset không hợp lệ, sai mô tả hoặc bị thu hồi.
- Chuyển thiếu/thừa/sai nội dung/trễ hạn.
- Câu hỏi sử dụng hoặc bảo hành.

Ticket nên gắn sẵn `order_id`; không yêu cầu khách gửi lại password hoặc secret. Support không có quyền tự mark paid, thay đổi payment evidence hoặc đọc raw credential.

## 6. Mô hình dữ liệu catalog tối thiểu

### Category

| Field | Quy tắc |
|---|---|
| `id` | Opaque immutable ID |
| `name` | Tên tiếng Việt hiển thị cho khách |
| `slug` | Unique, dùng nội bộ/deep link |
| `is_active` | Chỉ active mới được browse |
| `sort_order` | Sắp xếp ổn định |

### Product

| Field | Quy tắc |
|---|---|
| `id` | Opaque immutable ID |
| `name` | Tên authoritative từ database |
| `category_id` | Category hợp lệ |
| `short_description` | Text đã sanitize, giới hạn độ dài |
| `image_url` | Asset do shop kiểm soát; không fetch URL tùy ý lúc render |
| `is_active` | Kill switch bán hàng |
| `sort_order` | Sắp xếp ổn định |

### Product Variant

| Field | Quy tắc |
|---|---|
| `id` | Opaque immutable ID |
| `product_id` | Product cha |
| `name` | Ví dụ `1 tháng`, `3 tháng` |
| `price_vnd` | Integer VND lớn hơn 0 |
| `duration` | Enum/normalized duration |
| `delivery_type` | `invite`, `license`, `activation_key`, `credential`, `manual_review` |
| `warranty_days` | Integer không âm; snapshot vào Order |
| `stock_status` | Projection: `available`, `low`, `out`, `supplier_only`, `paused` |
| `supplier_sku` | Nullable; không lộ ra customer UI |
| `is_active` | Variant kill switch |
| `sort_order` | Sắp xếp ổn định |

Tên, giá, stock, warranty, delivery type và policy hiển thị cho khách luôn lấy từ database/read model, không lấy từ text do AI sinh.

## 7. Contract tìm kiếm

### 7.1 Thứ tự xử lý

1. Normalize Unicode, lowercase và giới hạn độ dài input.
2. Chạy tìm kiếm deterministic theo tên, alias, keyword, category, duration và price.
3. Chỉ gọi model parser khi input có cấu trúc câu tự nhiên và tìm kiếm thường chưa đủ rõ.
4. Validate output model bằng schema allowlist.
5. Backend query database và render card bằng dữ liệu authoritative.

### 7.2 Bounded filter schema

```json
{
  "query": "string | null",
  "category_id": "opaque_id | null",
  "duration": "1_month | 3_months | 6_months | 12_months | null",
  "min_price_vnd": "integer | null",
  "max_price_vnd": "integer | null",
  "stock_status": "available | null",
  "delivery_type": "invite | license | activation_key | credential | null",
  "sort": "relevance | price_asc | price_desc | null"
}
```

Mọi field lạ bị loại; giá âm/quá trần, chuỗi quá dài hoặc enum ngoài allowlist bị reject. Model không có tool gọi payment, order, stock, supplier hoặc admin command.

### 7.3 Quy tắc AI

AI được phép:

- trích keyword, mức giá, thời hạn, loại hàng và cách sắp xếp;
- trả `needs_clarification` nếu câu không thể map an toàn;
- không dùng AI và fallback keyword search khi model timeout.

AI không được phép:

- bịa tên, giá, tồn kho, bảo hành, khuyến mãi hoặc điều khoản;
- tìm/mua hàng ngoài catalog của shop;
- đổi giá, giữ hàng, tạo order hoặc xác nhận thanh toán;
- trả raw model text trực tiếp như product facts.

## 8. Quy tắc checkout và payment

1. `Mua ngay` tạo tối đa một active Order cho cùng customer + variant + idempotency token trong cửa sổ chống double tap.
2. Server re-read variant, price, stock và resale eligibility trước khi tạo Order.
3. Order snapshot giữ tên variant, `price_vnd`, warranty, delivery type, supplier policy và expiry.
4. Mỗi Order có một active VietQR Payment Intent với exact amount và order reference duy nhất.
5. VietQR chỉ tạo QR; SePay mới là lớp check/reconciliation.
6. Chỉ SePay evidence đã verify raw-body HMAC/timestamp và match transaction ID, inbound direction, merchant account, amount và order content/reference mới settle payment.
7. Screenshot, chat, return URL và nút kiểm tra không phải payment evidence.
8. Duplicate/reordered webhook phải hội tụ về cùng một kết quả; giao hàng tối đa một lần.
9. Thiếu tiền, thừa tiền, trả trễ, sai nội dung hoặc transaction không match đi `NeedsReview`; không silent fulfill.
10. Reconciliation định kỳ phát hiện webhook bị mất trước khi kết luận discrepancy.

## 9. Quy tắc fulfillment và delivery

1. Chỉ bắt đầu fulfillment sau `PaymentSettled` hợp lệ.
2. Kho nội bộ reserve asset nguyên tử; hai order không thể nhận cùng asset.
3. Supplier create-order dùng idempotency key. Timeout có kết quả không chắc chắn phải vào `Unknown` và query/reconcile trước retry.
4. HTTP 200 từ supplier chưa đủ; asset phải qua validation theo loại sản phẩm.
5. Raw credential chỉ tồn tại ở vault; domain DB, log, event, analytics, support và reseller webhook chỉ giữ vault reference/redacted metadata.
6. Delivery Bundle ràng buộc một customer, một order, TTL và số lần xem; replay không cấp asset mới.
7. Asset invalid/revoked đi replacement hoặc refund workflow theo warranty snapshot, không sửa lịch sử Order.

## 10. Loading, error và recovery copy

| Tình huống | Khách thấy | Hành vi hệ thống |
|---|---|---|
| Hết hàng trước khi mua | `Sản phẩm vừa hết hàng` | Không tạo payment; gợi ý quay lại catalog |
| Giá thay đổi | Hiện giá cũ và mới, yêu cầu xác nhận | Không dùng callback amount cũ |
| QR tạo lỗi | `Chưa thể tạo QR, đơn vẫn được giữ` | Retry có backoff; không tạo order trùng |
| SePay chưa báo tiền | `Chưa thấy giao dịch, vui lòng chờ` | Đọc local state; reconciliation theo lịch |
| Thanh toán thiếu/thừa/trễ | `Giao dịch cần đối chiếu` | Tạo discrepancy/ticket; không giao tự động |
| Supplier chậm | `Đã nhận tiền, đang chuẩn bị sản phẩm` | Poll/reconcile bounded; không create lại mù quáng |
| Supplier hết hàng sau payment | `Đơn cần hỗ trợ` | Fallback có policy hoặc refund/replacement |
| Link giao hết hạn chưa xem | Cho phép reissue có kiểm soát | Revoke bundle cũ; asset không bị cấp hai lần |
| Link đã xem | `Liên kết đã được sử dụng` | Yêu cầu step-up/support trước reissue |
| Bot/worker restart | Trạng thái phục hồi từ DB | Outbox replay idempotent |

## 11. Acceptance seam

Kiểm thử ở seam cao nhất: Telegram update/callback + SePay webhook đi qua application và quan sát reply/state/outbox, với provider/supplier adapters bằng fixture.

Happy path bắt buộc:

```text
/start
→ browse/search
→ view product
→ buy now
→ create VietQR
→ ingest verified SePay transaction
→ reserve/fetch one asset
→ issue one Delivery Bundle
→ order appears Completed in history
```

Các assertion không thương lượng:

- QR đạt được trong 3–4 click ở happy path.
- AI parser không thể tạo product fact hoặc domain command.
- 100 webhook trùng vẫn chỉ settle/fulfill/deliver một lần.
- Callback amount giả không thay đổi Order total.
- Hai khách mua asset cuối cùng chỉ một người reserve thành công.
- Screenshot hoặc nút kiểm tra không thể chuyển payment sang `Succeeded`.
- Credential không xuất hiện trong DB domain, structured log, outbox hoặc support transcript.

## 12. Lộ trình sau MVP

Sau khi retail flow có số liệu ổn định mới cân nhắc theo thứ tự:

1. Reseller API lane riêng.
2. Reseller prepaid ledger/funding nếu mô hình thương mại yêu cầu.
3. Retail wallet/top-up chỉ khi chứng minh giảm ma sát và đã chốt accounting/compliance.
4. Mini App cho catalog lớn hoặc form phức tạp.
5. Reorder, reminder có consent.
6. Loyalty, referral, campaign và A/B testing.
7. Recommendation nâng cao; AI vẫn chỉ đề xuất, không trực tiếp hành động.

