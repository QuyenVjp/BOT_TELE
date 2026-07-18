# Module Contracts

## Command boundary

| Owner | Commands |
|---|---|
| Catalog/Search | `BrowseCategories`, `ListProducts`, `SearchCatalog`, `ParseSearchFilters`, `ViewProduct` |
| Commerce | `BuyNow`, `CreateOrder`, `CancelUnpaidOrder`, `StartFulfillment` |
| Payments | `CreatePaymentIntent`, `ApplyPaymentEvidence`, `ExpirePaymentIntent`, `RequestRefund`, `ReconcilePayment` |
| Support | `OpenTicket`, `ReplyTicket`, `EscalateTicket`, `ResolveTicket`, `RequestManualReview` |
| Digital Goods | `ReserveDigitalAsset`, `RequestSupplierFulfillment`, `ValidateSupplierAsset`, `CreateDeliveryBundle`, `AcknowledgeDelivery`, `ReplaceDigitalAsset` |
| Supplier | `SyncSupplierCatalog`, `CreateSupplierOrder`, `QuerySupplierOrder`, `CancelSupplierOrder`, `ReconcileSupplierOrder`, `RotateSupplierCredential` |
| Admin Identity | `BootstrapRootAdmin`, `VerifyAdminAction`, `ConfirmHighRiskAdminAction` |

Post-MVP modules keep separate contracts: Wallet (`CreateTopUp`, ledger/hold/capture/release) and Reseller (`credential`, tenant order, signed webhook). Retail Telegram handlers do not expose these commands.

Commands carry an actor, tenant/customer scope, idempotency key and correlation ID. Channel/API handlers may submit commands but cannot mutate owned tables.

## Domain events

| Event | Producer | Consumers |
|---|---|---|
| `OrderCreated` | Commerce | Payments, Notifications |
| `PaymentSettled` | Payments | Commerce, Reconciliation |
| `PaymentNeedsReview` | Payments | Support, Finance |
| `OrderPaid` | Commerce | Digital Goods, Notifications |
| `FulfillmentCompleted` | Digital Goods | Commerce, Notifications |
| `TicketEscalated` | Support | Finance/Operations notification only |
| `SupplierFulfillmentRequested` | Digital Goods | Supplier adapter/worker |
| `SupplierAssetReady` | Supplier | Digital Goods, Commerce |
| `SupplierNeedsReview` | Supplier | Support, Root Admin |
| `DeliveryBundleCreated` | Digital Goods | Notifications only; event contains no raw credential |
| `DigitalAssetDelivered` | Digital Goods | Commerce, Audit |

## Delivery semantics

- Internal events use transactional outbox and are at-least-once.
- Consumers dedupe by `event_id` and resource version.
- Events never contain secrets or unnecessary PII.
- Side effects are not emitted until the owning transaction commits.
- Replay must not re-settle payment, recreate supplier order, re-fulfill or issue a second asset.
