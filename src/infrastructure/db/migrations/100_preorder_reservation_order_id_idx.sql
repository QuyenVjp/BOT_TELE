create index if not exists preorder_reservation_order_id_idx
  on preorder_reservation (order_id)
  where order_id is not null;
