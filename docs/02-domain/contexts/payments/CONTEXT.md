# Payments

Payments xác định cách yêu cầu và chứng minh dòng tiền cho Order, không sở hữu catalog, inventory hoặc fulfillment.

## Language

**Payment Intent**:
Ý định thu đúng một tổng tiền cho một Order, có thời hạn và VietQR/SePay mapping. Top-up là post-MVP.
_Avoid_: QR, transaction

**Payment Attempt**:
Một lần tạo link/QR cụ thể cho Payment Intent.
_Avoid_: Payment Intent

**Payment Evidence**:
Dữ liệu provider đã verify chữ ký và match account, amount, currency và reference.
_Avoid_: Receipt screenshot, return URL

**Bank Transaction**:
Dòng tiền provider/bank quan sát với reference duy nhất.
_Avoid_: Webhook request

**Discrepancy**:
Chênh lệch cần xử lý, như thiếu/thừa/trả muộn hoặc không match được order.
_Avoid_: Generic error

**Reconciliation**:
So khớp sổ nội bộ với provider/bank để phát hiện sự kiện thiếu, trùng hoặc lệch.
_Avoid_: Retry webhook

**Refund**:
Nghĩa vụ trả lại tiền có trạng thái, evidence và audit riêng.
_Avoid_: Cancel order
