# Reseller

Reseller cho đối tác bán lại thông qua public API mà không chia sẻ dữ liệu hoặc quyền giữa tenants.

## Language

**Reseller**:
Tổ chức được phép mua/bán lại theo commercial policy.
_Avoid_: Customer, API user

**Tenant**:
Ranh giới dữ liệu, credential, quota, price plan và audit của một Reseller.
_Avoid_: Account khi ý nghĩa là isolation boundary

**API Credential**:
Danh tính máy có scope và lifecycle riêng trong một Tenant.
_Avoid_: User password

**External Order ID**:
Mã order phía Reseller dùng cho reconciliation, unique trong Tenant.
_Avoid_: Internal Order ID

**Price Plan**:
Bộ giá/markup/commission có thời gian hiệu lực cho một Tenant.
_Avoid_: Current price nếu nói về historical order

**Usage Quota**:
Giới hạn hành vi/API theo Tenant, credential và endpoint.
_Avoid_: Wallet balance

