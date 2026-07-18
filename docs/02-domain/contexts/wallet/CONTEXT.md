# Wallet

Wallet quản lý closed-loop store credit dùng mua sản phẩm/dịch vụ của merchant.

## Language

**Store Credit**:
Giá trị prepaid chỉ dùng trong hệ thống theo policy V1.
_Avoid_: E-wallet, cash, bank balance

**Ledger Transaction**:
Một thay đổi tài chính cân bằng gồm nhiều Ledger Entry.
_Avoid_: Mutable balance update

**Ledger Entry**:
Một debit hoặc credit bất biến trên Ledger Account.
_Avoid_: Balance row

**Available Balance**:
Store Credit đã settle trừ các Hold đang hiệu lực.
_Avoid_: Total credits

**Hold**:
Khoản Store Credit tạm giữ cho một Order trước capture hoặc release.
_Avoid_: Debit

**Top-up**:
Yêu cầu tăng Store Credit bằng một Payment Intent riêng.
_Avoid_: Bank transfer tự do

