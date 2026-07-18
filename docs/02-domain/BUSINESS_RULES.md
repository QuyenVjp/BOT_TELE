# Business Rules Index

Đặc tả đầy đủ nằm trong [FUNCTIONAL_SPEC.md](./FUNCTIONAL_SPEC.md). File này là index các invariant dùng làm test gate.

## Payment

- `PAY-001`: QR, return URL, chat text và ảnh biên lai không tạo Payment Evidence.
- `PAY-002`: provider transaction reference chỉ được allocate một lần.
- `PAY-003`: duplicate/reordered webhook phải hội tụ về cùng kết quả.
- `PAY-004`: under/over/late/unmatched payment đi `NeedsReview`, không silent fulfill.
- `PAY-005`: refund có state, idempotency, approval và reconciliation riêng.
- `PAY-006`: VietQR chỉ tạo QR; SePay verified evidence mới được settle Payment Intent.
- `PAY-007`: mỗi retail Order có tối đa một active Payment Intent; amount/content do server tạo từ Order snapshot.

## Customer UX and search

- `UX-001`: menu retail MVP chỉ có danh sách sản phẩm, tìm kiếm, đơn hàng và hỗ trợ.
- `UX-002`: happy path tới VietQR không quá 3–4 lần bấm và không thu dữ liệu không cần thiết.
- `UX-003`: giá, duration, delivery type, warranty và stock phải hiện trước khi mua.
- `SEA-001`: deterministic search chạy trước AI parser.
- `SEA-002`: AI chỉ trả bounded filter allowlist; không được tạo product fact hoặc domain command.
- `SEA-003`: mọi result card render từ database/read model; model timeout phải fallback an toàn.

## Wallet — post-MVP only

- `WAL-001`: customer wallet/top-up không thuộc retail MVP và không xuất hiện trên menu khách.
- `WAL-002`: nếu được duyệt sau MVP, mọi thay đổi phải là balanced immutable Ledger Transaction.
- `WAL-003`: V1 của wallet sau này không withdraw, transfer hoặc cash conversion nếu chưa có review riêng.

## Commerce

- `COM-001`: server tính giá; callback/client không có quyền khai báo amount.
- `COM-002`: Order giữ immutable line/price snapshot.
- `COM-003`: retail MVP dùng Buy Now một variant/Order; không có multi-item cart.
- `COM-004`: stock reserve và order creation/claim phải có atomic concurrency boundary.
- `COM-005`: payment settled không đồng nghĩa fulfillment completed.

## Reseller API

Các rule này là lane post-MVP, không phải customer UX.

- `API-001`: mọi object read/write kiểm tra Tenant server-side.
- `API-002`: mọi mutation hỗ trợ Idempotency-Key + request fingerprint.
- `API-003`: credential chỉ lưu hash, có scope, rotation và revocation.
- `API-004`: webhook at-least-once, signed timestamp/raw-body, replay-safe.
- `API-005`: V1 reseller settlement là prepaid; không postpaid/negative credit.

## Support

- `SUP-001`: Ticket/manual review không mark-paid hoặc sửa ledger trực tiếp.
- `SUP-002`: attachment có type/size/magic-byte/malware policy.
- `SUP-003`: mọi manual financial action có actor, reason, evidence và approval.

## Digital accounts and supplier sourcing

- `DIG-001`: chỉ SKU có bằng chứng resale/transfer được phép mới có thể `Active`.
- `DIG-002`: digital-account order dùng VietQR dynamic QR và chỉ settle sau SePay evidence đã verify; Telegram/provider policy risk phải được sign-off trước production.
- `DIG-003`: provider invite/license/seat được ưu tiên hơn shared credentials.
- `DIG-004`: mỗi Digital Account Asset được allocate tối đa một active Order.
- `DIG-005`: raw credential không xuất hiện trong DB domain, log, analytics, support, event hoặc webhook.
- `DIG-006`: delivery dùng vault-backed one-time bundle và chỉ sau verified payment + validated supplier asset.
- `DIG-007`: Delivery Bundle bind đúng customer/order, có TTL và view-once; reissue phải revoke bundle cũ và audit.
- `SUPR-001`: supplier create-order dùng idempotency key; timeout-unknown phải query/reconcile trước retry.
- `SUPR-002`: supplier cost, sell price và margin được snapshot trên Order.
- `SUPR-003`: supplier HTTP 200 không đồng nghĩa fulfillment hợp lệ.
- `SUPR-004`: không tự đổi supplier/SKU mà không có fallback policy và customer-visible decision.

## Root admin

- `ADM-001`: root admin duy nhất là numeric Telegram `user_id` được cấu hình cho `@Quyenvjp`.
- `ADM-002`: username không bao giờ là authorization credential; không có `/add-admin`.
- `ADM-003`: admin action nguy hiểm chỉ trong private context, có step-up, idempotency và audit.
- `ADM-004`: admin không thể đọc lại supplier/account secret qua bot.
