# Commerce

Commerce xác định khách chọn gì, giá nào, giữ hàng ra sao và khi nào một đơn được thực hiện.

## Language

**Customer**:
Người mua trực tiếp; có thể liên kết nhiều Channel Identity sau khi xác minh.
_Avoid_: User, Telegram user, account

**Product**:
Thứ merchant cung cấp và có thể được bán.
_Avoid_: Item, hàng hóa khi nói về khái niệm chung

**Variant**:
Lựa chọn có SKU, giá hoặc tồn kho riêng của một Product.
_Avoid_: Option nếu option không ảnh hưởng SKU

**Cart**:
Khái niệm post-MVP cho tập lựa chọn nhiều món; retail MVP không tạo Cart mà dùng Buy Now một Variant.
_Avoid_: Order

**Quote**:
Snapshot có thời hạn của giá, giảm giá, phí và tổng tiền.
_Avoid_: Cart total

**Checkout**:
Boundary server-side revalidate Variant/price/stock để tạo Order và reservation; retail MVP không phải một flow/form nhiều bước.
_Avoid_: Checkout screen

**Order**:
Cam kết mua bán có line/price snapshot bất biến.
_Avoid_: Transaction, Payment

**Inventory Reservation**:
Quyền giữ tạm một số lượng hàng tới thời hạn xác định.
_Avoid_: Stock deduction

**Fulfillment**:
Quá trình giao hàng vật lý, quyền truy cập hoặc dịch vụ sau khi policy cho phép.
_Avoid_: Payment success
