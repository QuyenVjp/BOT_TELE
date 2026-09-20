# Supplier API / Upstream Provider Adapter

Đây là boundary để shop gọi API của bên khác rồi bán lại; khác với [Reseller API](./RESELLER_API.md), là API để đối tác gọi vào shop của mình.

## Non-negotiable policy

- Chỉ tích hợp supplier/provider có quyền bán lại, API contract và điều khoản cho phép.
- Không mua/bán account vi phạm điều khoản nền tảng, không bypass region/ban, không dùng scraping/login/captcha.
- Với ChatGPT Plus, Super Grok hoặc dịch vụ tương tự: ưu tiên license/invite/seat/API entitlement được nhà cung cấp ủy quyền; nếu policy cấm transfer/shared credentials thì SKU phải bị `Blocked`.
- Supplier secret chỉ ở secret manager/vault; không gửi cho reseller/customer và không log.
- Chỉ root admin `@Quyenvjp` (được authorize bằng numeric Telegram `user_id`) mới được register/rotate/disable supplier credential; reseller/customer không có quyền này.

## Adapter port

```text
SupplierAdapter
  getCatalog(cursor)
  getProduct(supplierSku)
  getAvailability(supplierSku)
  createFulfillment({supplierOrderKey, supplierSku, quantity, customerRef})
  getFulfillment(supplierOrderId)
  cancelFulfillment(supplierOrderId)
  requestRefund(supplierOrderId, reason)
  reconcile(window/reference)
```

Mỗi adapter phải có contract fixture, timeout, retryability map, idempotency behavior, rate limit, circuit breaker và reconciliation strategy.

## Supplier order flow

```text
Customer/Reseller Order
 -> verify product/payment policy
 -> reserve margin and digital slot
 -> create supplier fulfillment with idempotency key
 -> wait webhook or bounded poll
 -> validate supplier result
 -> vault credential / entitlement
 -> create recipient-bound delivery handoff
 -> send verified customer-visible fields in Telegram
 -> consume delivery once after successful send
 -> reconcile cost, margin and supplier status
```

## Price and margin

- Snapshot supplier cost, sell price, markup/commission, FX/fees (nếu có) vào Order.
- Không tính lại giá lịch sử khi supplier đổi giá.
- Không fulfill nếu supplier cost vượt policy margin hoặc reseller credit không đủ.
- Không tự thay SKU/provider khi supplier lỗi; chỉ fallback sang provider đã được policy cho phép và phải thông báo thay đổi.

## Upstream failure states

`SupplierUnavailable`, `SupplierTimeout`, `SupplierInsufficientStock`, `SupplierRejected`, `SupplierDeliveredUnverified`, `SupplierRefundPending` đều là trạng thái có audit; không gắn nhãn `Delivered` chỉ vì HTTP 200.

## Credential and delivery safety

- Store a vault reference, not raw password/token in PostgreSQL.
- Prefer invite/license/API key entitlement over shared username/password.
- If credentials must be delivered, send only verified `customerVisible` fields in one Telegram message to the bound customer/chat; keep raw secret out of logs, events, analytics, support, webhooks and reseller payloads.
- Delivery retry must use the same logical asset/handoff and must not allocate or send a second asset; support can revoke/reissue only through a controlled workflow. The legacy signed link is a recovery surface, not the primary delivery path.
