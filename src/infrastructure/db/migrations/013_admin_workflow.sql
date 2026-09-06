-- Durable, non-sensitive admin catalog workflow state.
create table if not exists admin_workflow (
  admin_telegram_user_id text primary key,
  workflow_type text not null default 'PRODUCT_CREATE',
  step text not null,
  name text,
  slug text,
  sku text,
  category_id text,
  price_vnd bigint,
  description text,
  low_stock_threshold integer,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint admin_workflow_type_check check (workflow_type = 'PRODUCT_CREATE'),
  constraint admin_workflow_step_check check (step in ('name','sku','category','price','description','threshold','confirm')),
  constraint admin_workflow_price_check check (price_vnd is null or price_vnd >= 0),
  constraint admin_workflow_threshold_check check (low_stock_threshold is null or low_stock_threshold >= 0)
);
create index if not exists admin_workflow_expiry_idx on admin_workflow (expires_at);
