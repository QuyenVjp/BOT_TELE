# VietQR Sales Bot — Pre-code Design Pack

Thư mục này là bộ tài liệu nguồn sự thật trước khi viết code cho **shop digital tự động trong Telegram dành cho khách Việt**: tìm sản phẩm, mua ngay, thanh toán VietQR, SePay xác minh, giao hàng bảo mật, lịch sử đơn và hỗ trợ.

## Trạng thái

- Giai đoạn: research + domain/architecture design.
- Chưa có application source code.
- Workspace đã được khởi tạo bằng GitHub Spec Kit 0.12.16 cho Codex; feature source of truth nằm tại `specs/001-telegram-shop-mvp/`.
- Các quyết định trong `docs/adr/` đang ở trạng thái `proposed` cho tới khi product owner chấp nhận.
- `docs/` là tài liệu canonical; `outputs/` là bản xuất để đọc/chia sẻ.

## Spec-driven workflow

```text
$speckit-constitution
→ $speckit-specify
→ $speckit-plan
→ $speckit-checklist
→ $speckit-tasks
→ $speckit-analyze
→ $speckit-implement (chỉ khi owner yêu cầu bắt đầu code)
```

- Project constitution: `.specify/memory/constitution.md`.
- Feature spec/plan/contracts/tasks/analysis: `specs/001-telegram-shop-mvp/`.
- Không code khi còn Critical/High gate hoặc requirement chưa map sang task + test.

## Đọc theo thứ tự

1. [Product overview](./docs/00-overview/README.md)
2. [MVP customer flow](./docs/00-overview/MVP_CUSTOMER_FLOW.md)
3. [Spec Kit feature specification](./specs/001-telegram-shop-mvp/spec.md)
4. [Spec Kit implementation plan](./specs/001-telegram-shop-mvp/plan.md)
5. [Spec Kit tasks and analysis](./specs/001-telegram-shop-mvp/tasks.md)
6. [Functional specification](./docs/02-domain/FUNCTIONAL_SPEC.md)
7. [Payment policy by product](./docs/00-overview/PAYMENT_POLICY_BY_PRODUCT.md)
8. [VietQR + SePay check flow](./docs/01-research/VIETQR_SEPAY_CHECK_FLOW.md)
9. [Repository research](./docs/01-research/RESEARCH_REPOSITORIES.md)
10. [Context map](./CONTEXT-MAP.md)
11. [Architecture blueprint](./docs/03-architecture/BLUEPRINT.md)
12. [Module contracts](./docs/03-architecture/MODULE_CONTRACTS.md)
13. [Threat model](./docs/04-security/THREAT_MODEL.md)
14. [Telegram policy risk gate](./docs/04-security/TELEGRAM_POLICY_RISK.md)
15. [Supplier API contract](./docs/05-api/SUPPLIER_API.md)
16. [Reseller API contract — post-MVP lane](./docs/05-api/RESELLER_API.md)
17. [Growth features — post-MVP](./docs/00-overview/GROWTH_FEATURES.md)
18. [Reconciliation runbook](./docs/06-operations/RECONCILIATION_RUNBOOK.md)
19. [Architecture decisions](./docs/adr/)

## Cấu trúc

```text
.
├── README.md
├── CONTEXT-MAP.md
├── docs/
│   ├── 00-overview/
│   ├── 01-research/
│   ├── 02-domain/
│   │   └── contexts/
│   ├── 03-architecture/
│   ├── 04-security/
│   ├── 05-api/
│   ├── 06-operations/
│   └── adr/
├── outputs/                 # Published snapshots/index
└── work/                    # Scratch/research inputs, not canonical
```

## Quy tắc không thương lượng

- Payment core theo owner request: VietQR dynamic QR + SePay check/reconciliation; ảnh biên lai/redirect không phải bằng chứng đã thanh toán.
- Retail MVP là `catalog → buy now → VietQR → SePay → secure delivery`; không có customer wallet, top-up, cart nhiều món hoặc reseller controls trên menu khách.
- Chỉ bán digital account/access khi supplier/platform cho phép resale/transfer.
- Root admin duy nhất là numeric Telegram ID mapped to `@Quyenvjp`; username không phải credential.
- Chỉ SePay evidence đã verify và match mới được confirm payment/order.
- SePay transaction evidence với HMAC/timestamp/account/amount/content/reference/unique transaction ID là payment evidence.
- AI chỉ parse câu tìm kiếm thành bộ lọc allowlist; product facts luôn lấy từ database.
- Supplier API là backend-only; Reseller API và wallet là lane sau MVP.
- Bot/LLM/channel handler không được bypass commerce/payment/digital-delivery domain rules.
