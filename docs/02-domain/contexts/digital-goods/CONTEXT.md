# Digital Goods

Digital Goods quản lý quyền truy cập/tài khoản số và cách giao an toàn sau khi payment policy cho phép.

## Language

**Digital Account Asset**:
Một asset tài khoản/quyền truy cập có SKU, provider, trạng thái, expiry và credential reference riêng.
_Avoid_: Product chung, password row

**Entitlement**:
Quyền sử dụng một gói/dịch vụ được giao cho Customer; có thể là invite/license thay vì credential.
_Avoid_: Account credential nếu provider hỗ trợ invite/license

**Credential Reference**:
Tham chiếu tới secret được giữ trong vault; không phải username/password raw trong domain DB.
_Avoid_: Plaintext credential

**Supplier Fulfillment**:
Kết quả upstream provider cấp asset/entitlement cho order của merchant.
_Avoid_: Auto-delivery thành công

**Delivery Bundle**:
Gói giao hàng one-time, có expiry/audit, chứa hướng dẫn và credential reference được phép hiển thị.
_Avoid_: Raw secret log

