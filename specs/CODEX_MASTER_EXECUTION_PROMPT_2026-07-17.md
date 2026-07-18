# Codex master execution prompt — hoàn thiện Telegram VietQR shop

Bạn là Codex implementation owner cho workspace:

`C:\Users\ADMIN\Documents\Codex\2026-07-16\nghi`

Mục tiêu là hoàn thiện hệ thống bán digital account/access cho khách Việt qua Telegram, thanh toán
VietQR và chỉ ghi nhận tiền từ SePay evidence đã xác minh. Tiếp tục tự động qua các slice đã được
spec hóa; không dừng sau mỗi slice để hỏi “có tiếp tục không?”. Chỉ dừng khi có decision nghiệp vụ
thật sự chưa được owner chốt, thiếu quyền/credential production bắt buộc, hoặc một blocker đã được
chứng minh bằng evidence.

## Suggested skills và workflow bắt buộc

1. Đọc `C:\Users\ADMIN\.codex\AGENTS.md`, constitution và toàn bộ artifact của feature đang làm.
2. Dùng `$karpathy-guidelines`: nêu assumption, thay đổi surgical, không abstraction đoán trước,
   mỗi task có tiêu chí kiểm chứng.
3. Dùng Spec Kit làm SSOT:
   `$speckit-constitution -> $speckit-specify -> $speckit-clarify` khi cần `-> $speckit-plan ->
   $speckit-checklist -> $speckit-tasks -> $speckit-analyze -> $speckit-implement`.
4. Dùng Harness để thực thi: `$harness-sync`, `$harness-work`, `$harness-review`; dùng
   `$harness-loop all` cho chuỗi task dài đã đủ spec.
5. Với logic có thể test, dùng `$tdd`/`$test-driven-development`: RED thật, GREEN tối thiểu,
   refactor sau khi green.
6. Trước khi tuyên bố phase hoàn tất, dùng `$requesting-code-review` hoặc `$harness-review`.
7. Nếu app/process bị crash hoặc resume: chạy `$harness-sync`, kiểm tra source + task + evidence,
   rồi tiếp tục từ task canonical đầu tiên còn mở; không làm lại task đã có proof hợp lệ.

Không dùng Claude/Claude Code command. Đây là workflow Codex-only.

## Source of truth

Đọc trực tiếp, không dựa vào summary cũ:

- `.specify/memory/constitution.md`
- `specs/001-telegram-shop-mvp/`
- `specs/002-ai-support/`
- `specs/003-notifications-quantity-checkout/`
- `docs/02-domain/`
- `docs/03-architecture/`
- `docs/04-security/`
- `docs/05-api/SUPPLIER_API.md`
- `docs/05-api/RESELLER_API.md`
- `docs/06-operations/`
- `src/`, `tests/`, `package.json`, `compose.yaml`

Hiện trạng kiểm chứng gần nhất chỉ là baseline để bắt đầu, không được copy thành claim mới:

- Feature 001: 129 checked / 42 open / 171 total.
- Feature 002: 0 checked / 44 open.
- Feature 003: 0 checked / 72 open.
- Full local suite gần nhất: 355 tests / 67 files pass.
- Feature 001 vẫn `REQUEST_CHANGES`.
- Workspace chưa có Git history hợp lệ, nên chưa có SHA/CI provenance.
- `src/main.ts` vẫn dùng Telegram no-op handler và SePay 503 placeholder.
- Production external vault, HTTP supplier, Telegram notifier và QR image chưa được nối.

Snapshot supersession (Gate 0 correction, 2026-07-17): the baseline above is historical. The current
Feature 001 artifact truth is **149 checked / 26 open / 175 rows**, with T148/T171/T172/T174 reopened
and T175/T176 plus identity tasks T177/T178 added. Current migrations end at
`008_sepay_inbox_security.sql`; Feature 001 identity/delivery security is reserved for
`009_identity_delivery_security.sql`; Feature 003 is reserved for `010_notifications_quantity.sql`
and Feature 002 for `011_ai_support.sql`. Feature 001 remains `REQUEST_CHANGES`; do not begin Feature
003, AI, wallet/top-up, or Reseller API.

Không được coi baseline trên là evidence của source sau khi sửa. Luôn chạy lại verification.

## Gate 0 — đồng bộ sự thật trước khi code tiếp

Thực hiện read-only review trước, sau đó sửa artifact tối thiểu cần thiết:

1. Đồng bộ `analysis.md`, `traceability.md`, `review.md`, `tasks.md` và
   `evidence/phase9-remediation.md` để không còn câu nói T158–T160 chưa làm hoặc next task là T161.
2. Ghi đúng: T158–T160 đã hoàn tất local; Feature 001 vẫn `REQUEST_CHANGES`; canonical next slice
   là T121/T126.
3. Kiểm tra lại public checkout surface: production dispatcher chỉ được vào Buy Now qua callback
   signed/customer-scoped; không expose orchestration nhận `customerId` do caller tự khai.
4. Harden callback HMAC config: reject placeholder/default/reused secret, giới hạn TTL hợp lý,
   constant-time verify và key-rotation path nếu contract yêu cầu.
5. Sửa migration plan của Feature 002/003. Không dùng lại `002_*` hoặc `003_*` vì source đã có
   `002_review_remediation.sql` và `003_reservation_invariant.sql`. Cấp prefix tăng đơn điệu tiếp
   theo tất cả migration Feature 001 đã plan; không thêm migration có lexical order đứng trước
   migration đã từng deploy.
6. Chạy lại `$speckit-analyze` cho feature bị đổi; unresolved Critical/High phải bằng 0 trước code.
7. T175/T176 must prove durable SePay acceptance with rawHash-bearing strict claims, source/payload
   consistency, atomic mutation-alert idempotency, and real PostgreSQL crash/lease/retry coverage.

Gate 0 chỉ được hoàn tất khi artifact và source không còn status drift.

## Thứ tự thực thi canonical

Không chạy theo số task thuần túy. Chạy theo dependency sau.

### Phase A — Telegram ingress production: T121/T126

- Viết RED matrix bằng PostgreSQL Testcontainers, ít nhất hai app/limiter instance.
- Durable inbox có state `PROCESSING`, `PROCESSED`, `RETRY`, attempt count, lease/timeout,
  `next_attempt_at`, deterministic ordering và retention.
- Không claim vĩnh viễn trước rate limit/handler rồi làm mất Telegram retry.
- Handler failure, 429, process restart và duplicate update phải converge về đúng một business
  effect.
- Rate limit atomic/distributed theo numeric user ID + action: Buy Now, check payment, cancel,
  support, admin.
- Webhook phải ack nhanh; không giữ HTTP request chờ business handler chậm.
- Không dùng `Map`/`Set` làm authority production.

### Phase B — SePay verified ingress: T122/T127

- T122/T127 may already be checked in the current task ledger. If so, do not blindly reimplement:
  re-run the official-provider acceptance below and reopen only the failing seam.
- Preserve exact raw bytes.
- Verify đúng provider contract: `sha256=` signature, timestamp/freshness, replay window,
  trusted-proxy/IP allowlist, schema và body-size bound.
- Chỉ ingress verifier được mint branded `VerifiedSePayEvidence`.
- Provider transaction ID duplicate với raw hash/amount/account/content khác phải vào discrepancy,
  không silently no-op.
- Screenshot, tin nhắn khách, nút “check”, QR hay return URL không bao giờ là payment evidence.
- Webhook duplicate/reordered/delayed phải idempotent và trả provider-safe response.

Official SePay contract to test verbatim:

- Payload fields include `id`, `gateway`, `transactionDate`, `accountNumber`, `subAccount`, `code`,
  `content`, `transferType`, `description`, `transferAmount`, `accumulated`, `referenceCode`.
- Webhook `id` is stable across retry/replay and is the unique dedupe key in the webhook namespace.
- HMAC is `X-SePay-Signature: sha256=...` over `${X-SePay-Timestamp}.${raw_body}`; compare constant-time.
- Successful delivery is only HTTP 200/201 + exact `{"success": true}` within 30 seconds. Duplicate
  events also return this success response.
- Persist inbox/event durably, acknowledge quickly, and apply evidence asynchronously. Do not call
  supplier, Telegram or a slow reconciliation API inline in the webhook request.
- Configure the official current SePay IP allowlist from the provider source/dashboard; never guess
  or hardcode an unverified list. Support rotation/update of the list.
- SePay retry/replay is at-least-once (up to eight sends on the documented schedule); webhook and
  reconciliation API IDs may differ in type/namespace, so use source-qualified text IDs.
- Reconciliation calls SePay Transaction API with Bearer token, bounded date/since-id windows,
  `page/per_page` cap, rate-limit/backoff and the same payment matcher. It may repair a missing
  webhook but cannot bypass verification.
- Validate structured `code` against the live Payment Intent when present; do not rely only on a
  substring search in `content`.
- Current official QR image templates are empty/default, `compact`, `qronly`, and `standee`.
  Do not use `compact2` when following SePay's image endpoint contract.

Google Sheet integration is optional and read-only for admin audit/projection. The owner-provided
sheet may be linked in an admin runbook, but it is not payment truth: never poll it to mark paid or
deliver an account. SePay webhook/API evidence remains authoritative.

### Phase C — payment race và callback boundary: T124/T124a/T128, T125/T129

- Atomic lock/re-read Order + Payment Intent khi settle/cancel/expire.
- Typed `ALREADY_PAID`; cancel không thắng verified settlement.
- Reject future/invalid `transactedAt`; late payment dựa trên transaction evidence + bounded skew.
- Signed, opaque, expiring, customer-scoped callback cho catalog, checkout, history, support và admin.
- Nối grammY dispatcher thật. Không còn no-op composition.
- Built-entrypoint acceptance phải chứng minh bot update thật đi vào domain command, không chỉ HTTP 200.

### Phase D — outbox, admin, atomicity và recovery: T161–T174

- T161/T162: owner + generation fencing; stale owner ack/fail phải update zero rows; lease renewal
  hoặc bounded one-event claim.
- T163/T164: AdminConfirmation durable; allowlisted command ref; consume + domain mutation +
  append-only audit trong cùng transaction.
- Root admin chỉ theo configured numeric Telegram user ID, private context; username chỉ display.
  Không có `/add-admin`, không username fallback.
- T165/T166: asset claim và `DigitalAssetClaimed` outbox commit atomic.
- T167/T168: bounded `FOR UPDATE SKIP LOCKED` recovery cho Order/intent expiry, reservation release,
  SePay reconcile, supplier UNKNOWN và Delivery Bundle expiry; có backlog/oldest-age telemetry.
- T169/T170: query-plan tests và indexes cho history/asset claim; tránh `%LIKE%`, N+1 và cache stampede.
- T171/T172: tách `SEPAY_MERCHANT_ACCOUNT_ID` khỏi `VIETQR_ACCOUNT_NUMBER`; bank display validated.
- T173/T174: `migrate:prod` chạy compiled artifact, Docker probe trung thực, CI dùng Docker thật.

### Phase E — fulfillment production và Telegram delivery: T136–T150

- External vault adapter thật, fail-closed, health check, timeout/retry, namespace/provenance,
  tuyệt đối không log secret.
- Authenticated HTTP SupplierPort: availability/create/query/cancel/refund, idempotency, timeout
  `UNKNOWN`, schema validation, circuit/retry/reconciliation.
- Supplier timeout không được create lại trước khi query/reconcile kết quả cũ.
- Local/supplier fulfillment, asset allocation và outbox phải transactional, crash-safe.
- One-time delivery reveal phải đọc vault thành công trước consume; lỗi vault không burn link.
- Order hoàn tất, bundle expiry/reissue, supplier replay guard và credential fingerprint uniqueness.
- Tạo ảnh QR thật từ payload EMVCo đã validate; test bằng independent/golden fixture.
- Telegram adapter thật: `sendMessage`, `editMessageText`, `sendPhoto`/media fallback, dedupe,
  recipient chính xác, 429 `retry_after`, bounded retry và blocked-chat handling.
- Payment UI bằng tiếng Việt phải có Order code, sản phẩm, quantity, đơn giá, tổng VND, bank,
  chủ/số tài khoản, nội dung chuyển khoản, expiry `Asia/Ho_Chi_Minh`, ảnh QR, nút check/cancel.

### Phase F — Feature 001 release gate: T151–T153

- CI bắt buộc: typecheck, lint, format, secret scan, production audit, build, compiled start,
  production migration, unit, contract, property, integration, acceptance, security, performance.
- Restore Git history hợp lệ trước khi claim release; evidence phải gắn commit SHA + CI run.
- Independent code/security/spec review: zero unresolved Critical/High.
- Telegram policy acceptance, production SePay, external vault, supplier authorization, restore drill
  và container scan là launch gates; không fake green.

Chỉ khi Telegram update thật -> Order -> VietQR image -> verified SePay -> fulfillment -> secure
delivery -> history/support chạy end-to-end mới được gọi Feature 001 pilot-ready.

### Phase G — Feature 003 trước AI: quantity, payment UX, notifications

Sau khi Feature 001 green, làm toàn bộ T301–T372 theo TDD. Feature 003 ưu tiên trước AI vì trực tiếp
phục vụ bán hàng.

Yêu cầu bắt buộc:

- Một Order có một Variant và quantity `1..max_per_order`; không biến thành multi-item cart.
- Server tính integer VND `unit_price * quantity`, bounds/overflow guard.
- Reserve N account atomic all-or-nothing. Hai khách tranh stock: transaction thắng trước được hàng;
  người thua nhận thông báo hết hàng rõ ràng và không có Order/Payment Intent/QR giả.
- Supplier quantity dùng một request idempotent hoặc child keys `{orderId}:{unitIndex}`.
- Partial supplier success vào `PARTIAL_FULFILLMENT_REVIEW`.
- Delivery Bundle chứa đúng N entitlement/account.
- Transactional notification riêng tư và idempotent.
- Restock/new product: tên product/variant, số lượng thêm, tồn sau, giá hiện tại, deep link.
- Purchase activity chỉ social proof an toàn; không buyer identity, Order code, payment reference,
  account, credential hoặc private total; phải aggregate/debounce/frequency-cap.
- Customer tắt độc lập `SHOP_UPDATE` và `PURCHASE_ACTIVITY`; hỗ trợ quiet hours/digest.
- Admin broadcast có draft, sanitized preview, target, recipient estimate, step-up confirmation,
  schedule/send/cancel, audit, fanout batches, retry-after, dedupe, blocked-chat suppression.
- Không dùng emoji rải rác. Copy, icon token, callback action, notification class và template phải
  có owner rõ ràng, centralize khi thực sự dùng lại.

### Phase H — Feature 002 AI Support

Làm toàn bộ T201–T244 sau Feature 003.

- Provider là OpenAI-compatible Responses qua qrouter, HTTP adapter riêng.
- Default cost-balanced allowlist: `gpt-5.6-luna`; có thể cho phép `gpt-5.6-terra` bằng config,
  không hardcode secret/model ngoài allowlist.
- API key chỉ từ environment/secret manager, không log, không commit, không echo trong evidence.
- AI chỉ classify intent, tạo bounded catalog filter, FAQ, product recommendation read-only,
  order/payment guidance read-only và support draft/handoff.
- Product/price/stock/warranty/delivery facts luôn lấy từ database/approved knowledge.
- AI không có tool/direct authority cho payment, inventory, supplier, delivery, refund hoặc admin.
- BOLA, prompt injection, exfiltration, provider failure, 401/429/5xx/timeout/malformed, budget và
  concurrent-abuse phải có test.
- Có timeout, token cap, per-user/global rate, cost bucket, circuit state, retention/deletion,
  deterministic fallback và telemetry redacted.

### Phase I — tạo Spec Kit riêng cho Wallet/Top-up và Reseller API

Đây là yêu cầu sản phẩm đã có trong conversation nhưng Feature 001 cố ý loại khỏi MVP. Không nhét
vào schema/flow retail bằng code ad-hoc.

1. Tạo một feature Spec Kit riêng cho customer wallet/top-up.
2. Tạo một feature Spec Kit riêng cho Reseller API.
3. Chạy đủ constitution -> specify -> clarify -> plan -> checklist -> tasks -> analyze.
4. Chỉ implement khi mỗi feature có zero unresolved Critical/High và dependency Feature 001 green.

Wallet/top-up tối thiểu:

- Immutable double-entry ledger; balance chỉ là projection.
- VietQR/SePay top-up intent và verified evidence; idempotent credit exactly once.
- Hold/capture/release/refund; không âm balance, không float money.
- Reconciliation, append-only audit, admin manual correction theo dual-entry compensating entry.
- Retail Order payment và reseller prepaid funding là policy lane tách biệt.

Reseller API tối thiểu:

- `/v1` REST/OpenAPI executable contract.
- Tenant, API credential prefix+hash, scopes, rotation/revocation và object authorization.
- Catalog, balance/ledger, create/read/cancel Order, top-up, usage và webhook endpoint.
- `Idempotency-Key` + request fingerprint cho mọi mutation.
- Prepaid credit reserve/capture/release atomic cùng canonical Order.
- Quota/rate limit, cursor pagination, stable error codes và `Retry-After`.
- Signed outbound webhook, at-least-once dedupe, bounded retry/DLQ/manual replay.
- HTTPS challenge, DNS/IP/port allowlist, re-resolution và egress policy chống SSRF.
- Không lộ supplier credential, raw account hoặc dữ liệu tenant khác.

Mini App, loyalty, referral, A/B, voice và abandoned-cart reminder vẫn là feature riêng sau core;
không tự ý implement nếu chưa có Spec Kit/owner priority.

## Code-quality contract

- Không gom mọi `const` lên đầu file một cách máy móc. Chỉ centralize reusable domain constants,
  copy/templates, limits, callback actions và immutable lookup có owner rõ ràng.
- Tìm duplicated logic trước khi viết helper mới; tái sử dụng existing domain command/repository.
- Không tạo “utils” chung chung, God service, speculative framework hoặc wrapper chỉ dùng một lần.
- Handler/channel không mutate domain table trực tiếp.
- SQL hot path phải bounded, indexed và có deterministic ordering.
- Mọi external input untrusted: Telegram, SePay, supplier, reseller, AI.
- Mọi list có pagination/cap; mọi retry có bound/backoff/jitter; mọi worker batch có limit.
- Không fake provider, no-op handler, permissive security fallback hoặc in-memory authority trong
  production composition.
- Không bỏ test bằng `skip`; không viết assertion kiểu `<= 1` nếu expected phải chính xác là 1;
  không claim pass khi suite setup failure.
- Preserve unrelated user changes. Không dùng destructive git command.

## Secrets và production safety

Telegram bot token và qrouter key từng xuất hiện trong chat phải được coi là đã lộ. Không copy chúng
vào prompt, source, test, log, evidence hoặc commit. Production launch bị block cho tới khi owner
rotate credential và inject bản mới qua environment/secret manager.

Không gọi provider live bằng credential thật trong CI. Dùng sanitized fixtures/contract server;
live smoke phải opt-in, redacted và chỉ ghi status/model/latency.

Không thêm Telegram Stars vào flow được yêu cầu. Vẫn giữ Telegram policy risk như launch gate,
không che giấu hoặc tuyên bố policy compliant khi chưa có owner sign-off.

## Verification và reporting contract

Mỗi slice:

1. Ghi RED evidence trước implementation khi TDD required.
2. Chạy focused tests.
3. Chạy typecheck/lint/format/secret-scan/build liên quan.
4. Chạy full suite ở cuối phase với PostgreSQL Testcontainers thật.
5. Chỉ check task khi DoD đúng nghĩa; code partial không được check full task.
6. Cập nhật traceability/evidence bằng kết quả thực, runtime, Docker context, Node version và SHA/CI
   nếu có.
7. Chạy independent review; accepted/rejected finding phải có lý do và file:line.

Không báo “hoàn tất toàn bộ” chỉ vì test hiện tại green. Báo theo format:

```text
Verdict: APPROVE | REQUEST_CHANGES | BLOCKED
Completed tasks: ...
Open tasks: ...
Production path proven: ...
Commands and exact results: ...
Critical/High findings: ...
Residual launch gates: ...
Canonical next task: ...
```

Tiếp tục tự động sang canonical next task nếu verdict của slice không có blocker cần owner quyết
định. Không hỏi “muốn tôi tiếp tục không?”.

## Điều kiện kết thúc master run

Master run chỉ hoàn tất khi:

- Feature 001, 003 và 002 code + tests + runtime đều green theo đúng dependency order.
- Wallet/top-up và Reseller API đã có Spec Kit hoàn chỉnh; nếu owner đã duyệt implementation thì
  code/test/runtime cũng green, nếu chưa duyệt phải báo rõ `decision_needed`, không gọi toàn hệ thống
  hoàn tất.
- Không còn no-op/fake/permissive production wiring.
- Telegram, VietQR, SePay, supplier, vault, delivery và notification end-to-end có acceptance proof.
- Zero unresolved Critical/High.
- Secrets đã rotate và không xuất hiện trong artifacts.
- Git/CI/SHA, migration, backup/restore và launch gates có evidence trung thực.

Lệnh khởi động đề xuất trong Codex:

`$harness-loop all`

Nếu Harness loop không tự chọn đúng feature, nhập:

`Đọc specs/CODEX_MASTER_EXECUTION_PROMPT_2026-07-17.md, chạy Gate 0 rồi tiếp tục canonical Phase A; không dừng sau mỗi slice trừ blocker thật.`
