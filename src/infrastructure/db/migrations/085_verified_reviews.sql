-- Verified customer reviews. One row per completed order: hidden rows remain
-- restorable evidence and cannot be replaced by a second review.
create table if not exists product_review (
  id          text primary key,
  order_id    text not null references "order"(id),
  customer_id text not null references customer(id),
  product_id  text not null references product(id),
  variant_id  text not null references product_variant(id),
  rating      integer not null check (rating between 1 and 5),
  comment     text not null default '' check (length(comment) <= 1000),
  status      text not null default 'VISIBLE' check (status in ('VISIBLE','HIDDEN')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (order_id)
);

create index if not exists product_review_visible_product_idx
  on product_review(product_id, created_at desc, id desc)
  where status = 'VISIBLE';
create index if not exists product_review_customer_idx
  on product_review(customer_id, created_at desc, id desc);
