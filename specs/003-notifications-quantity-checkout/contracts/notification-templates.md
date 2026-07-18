# Contract: Canonical Notification Templates

## New product/restock

```text
🆕 SẢN PHẨM MỚI

🏷️ {productName} — {variantName}
📦 Vừa thêm: {addedQuantity}
📊 Tồn kho hiện tại: {stockAfter}
💰 Đơn giá: {unitPriceVnd}

[ 🛒 Xem sản phẩm ] [ 🔔 Cài đặt thông báo ]
```

Restock uses `📦 ĐÃ BỔ SUNG HÀNG` with the same authoritative fields.

## Purchase activity

```text
🔥 HOẠT ĐỘNG MUA HÀNG

Trong {windowMinutes} phút vừa qua:
🏷️ {productName} — {variantName}
📦 Đã có khách mua tổng cộng: {aggregateQuantity}

[ 🛒 Xem sản phẩm ] [ 🔕 Tắt hoạt động mua hàng ]
```

Never include buyer name/username/ID, Order code, transfer content, bank account, credential, or private total.

## Admin announcement

```text
📢 THÔNG BÁO TỪ SHOP

{safeTitle}
{safeBody}

[ ✅ Đã đọc ] [ 🔔 Cài đặt thông báo ]
```

Critical service messages use `🚨 THÔNG BÁO DỊCH VỤ QUAN TRỌNG` and cannot contain marketing CTA.

