# State Machines

## Order

```text
Draft -> PendingPayment -> Paid -> Processing -> Completed
Draft -> Rejected
PendingPayment -> Cancelled
PendingPayment -> Expired
PendingPayment -> PaymentNeedsReview
Paid -> FulfillmentNeedsReview
Processing -> FulfillmentNeedsReview
Paid/Processing/Completed -> RefundPending -> Refunded
```

`Paid` chỉ đến từ verified SePay evidence. `Completed` chỉ đến sau Delivery Bundle được phát hành thành công; payment và fulfillment không dùng chung một status.

## Payment Intent

```text
Created -> Presented -> Succeeded
                    -> Failed
                    -> Expired
                    -> NeedsReview
Expired -> NeedsReview on valid late transfer
Succeeded -> PartiallyRefunded -> Refunded
Succeeded -> Refunded
```

`Presented` không được chuyển sang `Succeeded` bởi screenshot, chat text, return URL hoặc nút refresh.

## Inventory Reservation / Digital Asset Claim

```text
Available -> Reserved -> Claimed
          -> Released
Reserved -> Expired
```

Reservation/claim phải dùng atomic compare-and-swap hoặc DB lock để hai Order không nhận cùng asset.

## Customer wallet/top-up — post-MVP

Không có state machine customer wallet/top-up trong retail MVP. Nếu lane này được duyệt sau MVP, nó phải được đặc tả và kiểm thử riêng trước khi xuất hiện trên bot.

## Support Ticket

```text
Open -> WaitingShop -> WaitingCustomer -> Resolved -> Closed
                   -> EscalatedFinance -> ManualReview -> Resolved
```

## Reseller Order

Reseller Order không có business state riêng; nó là tenant-scoped mapping tới canonical Order. API status được project từ Order, Payment và Fulfillment để tránh ba nguồn sự thật.

## Digital Account Asset

```text
Available -> Reserved -> Provisioning -> Ready -> Delivered
          -> Released                 -> Compromised
                                      -> Revoked
Provisioning -> SupplierNeedsReview -> Ready
                                     -> Failed
                                     -> RefundPending
```

## Supplier Order

```text
Created -> Submitted -> Pending -> Fulfilled
                    -> Rejected
                    -> Unknown -> Reconciled -> Fulfilled/Rejected
                    -> CancelPending -> Cancelled
                    -> RefundPending -> Refunded
```

`Unknown` is mandatory after a timeout with uncertain upstream outcome; the system queries/reconciles before retrying create.

## Delivery Bundle

```text
Created -> Available -> Viewed -> Consumed
                    -> Expired
                    -> Revoked
```

Only a controlled replacement workflow may revoke a consumed/compromised asset and issue a new bundle.
