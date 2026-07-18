# Product Overview

## Product surface ưu tiên

### Retail bot

- Browse danh mục và danh sách sản phẩm.
- Tìm kiếm từ khóa; AI chỉ parse câu tự nhiên thành filter.
- Xem chi tiết, giá, thời hạn, cách giao và bảo hành.
- Mua ngay một variant, thanh toán VietQR.
- SePay tự động xác minh/đối chiếu giao dịch.
- Giao account/access qua link nhận một lần.
- Lịch sử đơn, báo lỗi và hỗ trợ gắn với đơn.

Flow chuẩn và copy màn hình nằm tại [MVP Customer Flow](./MVP_CUSTOMER_FLOW.md).

### Backend/post-MVP lanes

- Supplier API là backend-only để lấy/provision hàng sau khi payment được xác minh.
- Reseller API, prepaid credit, wallet/top-up, Mini App và growth engine là các lane sau MVP.
- Các lane này không xuất hiện trên menu khách lẻ và không được làm phức tạp happy path.

## Main bot menu

```text
🛒 SHOP DIGITAL

[ 🛍 Danh sách sản phẩm ]

[ 🔍 Tìm sản phẩm ] [ 📦 Đơn hàng ]
[ 💬 Hỗ trợ ]
```

## Current product wedge

Giai đoạn này ưu tiên **shop Telegram bán digital account/access có nguồn supplier được ủy quyền**. Khách thấy giá, bấm mua, quét VietQR; SePay xác minh rồi hệ thống giao entitlement/credential một lần. Xem [MVP Customer Flow](./MVP_CUSTOMER_FLOW.md), [Payment policy by product](./PAYMENT_POLICY_BY_PRODUCT.md), [Supplier API](../05-api/SUPPLIER_API.md) và [Root admin identity](../04-security/ADMIN_IDENTITY.md).

## V1 defaults

- Core độc lập kênh; Telegram là reference UX, Zalo/Web là adapters.
- Một order dùng một VietQR PaymentIntent; SePay check/reconcile trước khi giao account.
- Không có customer wallet/top-up hoặc multi-item cart trong retail MVP.
- Supplier API nằm sau application boundary và không lộ trong customer UX.
- Payment provider của flow này là VietQR + SePay.
- AI chỉ parse search filters; không có quyền tạo product fact hoặc domain command.

## Decision gates

Kênh đầu tiên và wedge đã chốt là Telegram + authorized digital account/access. Trước implementation còn phải chốt numeric admin ID, supplier authorization, SePay contract/limits, account warranty/replacement, support SLA và retention/compliance. Xem [Telegram policy risk](../04-security/TELEGRAM_POLICY_RISK.md) trước production.

## Growth design

Các ý tưởng Mini App, loyalty, referral, campaign, A/B và recommendation nâng cao được giữ tại [GROWTH_FEATURES.md](./GROWTH_FEATURES.md) nhưng đều là post-MVP. MVP chỉ tối ưu `tìm hàng → mua → VietQR → SePay → nhận hàng`.
