# Differentiation and Growth Features — Post-MVP

> **MINI APP: NOT IN PRODUCT SCOPE — OWNER DECISION.** TIER20 SHOP is Telegram-bot-only. Do not treat Mini App, WebApp, `initData`, `startapp`, or `shop.tier20.click` as required, blocked, or future work. See `docs/architecture/telegram-only-commerce.md`.

> Tất cả nội dung trong file này bị hoãn cho tới khi customer flow `tìm hàng → mua → VietQR → SePay → nhận hàng` hoạt động ổn định. Không mục nào ở đây được phép làm tăng scope retail MVP.

## Positioning

Khác biệt nên được xây quanh ba trụ cột:

1. **Conversational commerce:** mua hoàn toàn trong chat Telegram (reply keyboard + inline + commands + deep link). Mini App is cancelled permanently.
2. **Trust:** khách luôn biết tiền đang ở trạng thái nào, order nào, ai đang xử lý và khi nào được hoàn.
3. **Convenience:** ít bước, ít tin nhắn rác, deep link đúng ngữ cảnh, mua lại và hỗ trợ không phải kể lại từ đầu.

Không cạnh tranh bằng spam, countdown giả, AI tự ý mua hàng hoặc biến số dư thành “tiền ảo” không có policy rõ ràng.

## Prioritized feature portfolio

| Phase | Feature | Business impact | Risk/guardrail |
|---|---|---|---|
| CANCELLED | Telegram Mini App/Web App catalog + cart | CANCELLED BY OWNER — DO NOT IMPLEMENT | Telegram-bot-only architecture |
| P0 | Payment timeline + trust center | Giảm support và tranh chấp | Chỉ provider evidence mới chuyển settled; hiển thị `Pending/NeedsReview` rõ |
| P0 | One-tap reorder + order deep link | Tăng repeat purchase | Requote/recheck stock; không clone payment cũ mù quáng |
| P0 | Persistent menu, quick replies, edit-in-place, inline actions | UX mượt, ít rác | Opaque expiring action tokens; callback idempotent |
| P0 | Abandoned-cart reminder có consent | Thu hồi doanh thu bị bỏ quên | Quiet hours, frequency cap, suppression sau purchase/refund |
| P0 | Back-in-stock/price-change alerts | Tạo lý do quay lại | Opt-in, unsubscribe, không gửi dồn |
| P1 | Personalized recommendation và bundle/upsell | Tăng AOV và relevance | Không dùng dữ liệu nhạy cảm; deterministic policy; opt-out |
| P1 | Loyalty theo settled purchase/margin | Giữ chân, khuyến khích mua lại | Không tính tier theo top-up; chống self-referral và refund farming |
| P1 | Referral có credit treo | Tăng acquisition | Chỉ thưởng sau order settled + hết refund window; graph/device fraud checks |
| P1 | AI FAQ/intent + support draft | Giảm tải support | AI không direct action; tool allowlist + human approval |
| P1 | Voice note -> draft intent | Mobile UX tiện hơn | Transcribe rồi xác nhận lại; không tự tạo order/payment |
| P2 | Funnel analytics + A/B message/offer | Tối ưu conversion có dữ liệu | A/B offer/message, không tùy tiện phân biệt giá; consent/retention |
| P2 | Smart reorder/reminder theo chu kỳ | Tăng repeat purchase | Cho pause/opt-out; không gửi ngoài giờ |
| P2 | Reseller growth portal | Tăng distribution | Tenant isolation, quota, signed webhook, prepaid only |
| P2 | Campaign engine/segmentation | Khuyến mại chính xác | Rule versioning, audit, no sensitive profiling |

## P0 — tính năng nên làm đầu tiên

### 1. Mini App nhưng không biến bot thành web app nặng

Bot vẫn là entry point. Mini App chỉ nhận các flow cần nhiều dữ liệu:

```text
Bot menu -> Open Mini App -> catalog/search -> cart -> address/variant
          -> server quote -> confirm -> return to bot payment timeline
```

Mini App cần:

- Theme native và responsive mobile.
- Search, filter, pagination/infinite scroll có giới hạn.
- Cart visual, quantity control, variant selector.
- Address form chỉ hiện khi fulfillment cần.
- `initData`/identity được verify ở server; không tin `user`, `price`, `total`, `tenant` từ client.
- Biometric có thể dùng cho UX unlock ở client, không phải bằng chứng ủy quyền payment.
- VietQR vẫn là payment adapter; “one-tap checkout” nghĩa là ít bước tạo order/QR, không nghĩa Telegram tự chứng minh tiền đã vào.

### 2. Trust center / payment timeline

Mỗi order có timeline dễ đọc:

```text
Đã tạo đơn -> Đã giữ hàng -> Chờ thanh toán -> Đã nhận tiền
           -> Đang chuẩn bị -> Đã giao / Cần hỗ trợ / Đã hoàn
```

Mỗi trạng thái có:

- thời điểm;
- hành động tiếp theo;
- reference an toàn;
- SLA dự kiến;
- nút hỗ trợ đúng context.

Không hiển thị raw payload provider, checksum, secret hoặc dữ liệu ngân hàng không cần thiết.

### 3. One-tap reorder

- Lấy order cũ làm đề xuất, không copy giá/stock/payment attempt.
- Tạo quote mới, kiểm tra catalog/stock/policy mới.
- Cho chọn “mua lại tất cả” hoặc từng line.
- Nếu giá thay đổi, hiển thị diff trước xác nhận.
- Payment reference luôn mới.

### 4. Reminder có trách nhiệm

- Chỉ gửi khi customer opt-in hoặc policy hợp lệ.
- Tối đa một reminder cho cart trong một khoảng; có quiet hours theo `Asia/Ho_Chi_Minh`.
- Suppress khi order được tạo, thanh toán, customer mute hoặc ticket đang xử lý.
- Link deep-link tới đúng cart/order, có expiry và không chứa PII.

## P1 — retention nhưng không tạo gian lận

### Loyalty

Khuyến nghị tính tier dựa trên **settled purchases** và margin/rule của merchant, không dựa trên số tiền nạp. Top-up chỉ là funding, không phải doanh thu.

Ví dụ:

```text
Bronze: settled spend >= X trong 90 ngày
Silver: settled spend >= Y và không có fraud/refund pattern
Gold: settled spend >= Z + lịch sử support tốt
```

Rewards phải là versioned ledger grant có expiry, không sửa balance.

### Referral

- Mỗi referral có campaign/version và attribution window.
- Không thưởng self-referral, cùng device/risk cluster, vòng lặp reseller/customer hoặc order bị refund.
- Credit ở trạng thái `PendingReward` cho tới khi order settled và hết refund window.
- Giới hạn số referral/ngày, tổng credit/tháng và giá trị tối đa.
- Tất cả reward/revoke đi qua ledger/audit.

### Recommendations and bundles

- V1 dùng rules rõ ràng: sản phẩm thường mua cùng, biên lợi nhuận, tồn kho, eligibility.
- AI chỉ đề xuất; Pricing/Inventory/Policy domain quyết định có được bán.
- Không recommend sản phẩm hết hàng hoặc khuyến mại đã hết hạn.
- Không dùng PII nhạy cảm để suy đoán nhu cầu; có opt-out.

## AI-assisted nhưng không direct action

AI có thể làm:

- intent classification (`buy`, `top_up`, `order_status`, `support`, `refund_request`);
- FAQ retrieval từ tài liệu đã duyệt;
- product recommendation draft;
- support reply draft và tóm tắt ticket;
- voice note transcription thành draft intent.

AI không được tự làm:

- mark paid, credit wallet, debit wallet, refund, change price, change stock, change reseller scope;
- gọi URL do user cung cấp;
- đọc secret/raw payment payload;
- gửi campaign hàng loạt mà không qua consent/quota.

Flow an toàn:

```text
User input -> normalize/moderate -> AI intent/draft
           -> typed command proposal -> policy/permission/domain validation
           -> confirmation hoặc human approval -> command -> audit/outbox
```

## Analytics và A/B

### Events cần track

- `menu_viewed`, `catalog_opened`, `product_viewed`, `added_to_cart`;
- `checkout_started`, `quote_expired`, `payment_started`, `payment_settled`;
- `wallet_topup_started`, `wallet_topup_settled`, `order_completed`;
- `support_opened`, `refund_requested`, `referral_attributed`;
- `reseller_order_created`, `webhook_delivered`, `webhook_failed`.

Events chứa opaque IDs, campaign/version và timestamp; không gửi payment secret/raw PII vào analytics vendor.

### A/B rules

- Experiment chỉ thay message/layout/offer bundle ở V1.
- Randomization ổn định theo opaque Customer/Reseller ID.
- Snapshot variant vào Order/Quote để phân tích historical truth.
- Stop criteria cho fraud, complaint, latency và margin, không chỉ conversion.
- Không dùng A/B để âm thầm thay quyền lợi/giá giữa các nhóm nếu chưa có policy/pháp lý rõ.

## Voice, media và support

- Voice note được tải vào vùng quarantine, giới hạn size/type, malware scan/transcription timeout.
- Transcript cần customer confirm trước khi biến thành command.
- Ảnh biên lai chỉ là support evidence, không phải payment truth.
- Ticket gắn order/payment reference, không copy toàn bộ PII vào transcript/LLM.

## Metrics: đo hiệu quả nhưng bảo vệ trust

| Nhóm | Metrics |
|---|---|
| Conversion | catalog→cart, cart→checkout, checkout→payment, payment→fulfillment |
| Convenience | message count/order, Mini App completion, reorder rate, support deflection |
| Trust | payment dispute rate, `NeedsReview` SLA, refund completion, unmatched transfer rate |
| Retention | repeat purchase, settled loyalty redemption, referral quality, churn after failed payment |
| Operations | webhook lag, reconciliation mismatch, queue lag, fulfillment duplicate rate |
| Reseller | API success, idempotency conflicts, credit utilization, webhook delivery success, tenant churn |
| Safety | abuse blocks, false positives, credential rotations, AI escalation rate |

## Feature rollout order

1. P0 Mini App + trust timeline + reorder + consented reminders.
2. P0 analytics events and operational dashboards.
3. P1 rules-based bundles/recommendations + loyalty/referral ledger.
4. P1 AI FAQ/support/voice draft with approval gates.
5. P2 A/B experimentation and campaign engine.

## Sources and implementation references

- [Telegram Bot API: setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [Telegram Bot API: answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery)
- [Telegram Mini Apps/Web Apps](https://core.telegram.org/bots/webapps)
- [grammY](https://github.com/grammyjs/grammY)
- [payOS Node SDK](https://github.com/payOSHQ/payos-lib-node)
