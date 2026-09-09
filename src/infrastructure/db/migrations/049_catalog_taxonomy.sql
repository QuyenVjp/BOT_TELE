-- Catalog taxonomy and merchandising fields (idempotent).
alter table category add column if not exists parent_id text references category(id) on delete restrict;
do $$ begin
  alter table category add constraint category_parent_not_self check (parent_id is distinct from id);
exception
  when duplicate_object then null;
end $$;
alter table category add column if not exists icon text;
alter table category add column if not exists display_name_vi text;
alter table category add column if not exists is_featured boolean not null default false;
alter table category add column if not exists featured_rank integer;
create index if not exists category_parent_idx on category(parent_id);
create index if not exists category_active_sort_idx on category(is_active, sort_order);

alter table product add column if not exists is_featured boolean not null default false;
alter table product add column if not exists featured_rank integer;
alter table product add column if not exists is_category_featured boolean not null default false;
alter table product add column if not exists category_featured_rank integer;
alter table product add column if not exists stock_display_mode text;
update product set stock_display_mode = 'BAND' where stock_display_mode is null;
do $$ begin
  alter table product add constraint product_stock_display_mode_chk
    check (stock_display_mode in ('BAND', 'EXACT'));
exception
  when duplicate_object then null;
end $$;
alter table product alter column stock_display_mode set default 'BAND';
alter table product alter column stock_display_mode set not null;
create index if not exists product_featured_idx on product (is_featured, featured_rank) where is_featured;
create index if not exists product_category_active_idx on product (category_id, is_active) where not is_archived;

alter table shop_settings alter column shop_name set default 'TIER20 SHOP';
alter table shop_settings alter column shop_tagline set default 'AI • Coding • VPN • Phần mềm số';
alter table shop_settings alter column community_url set default 'https://t.me/aicodexvn';
alter table shop_settings alter column support_url set default 'https://t.me/Quyenvjp';
alter table shop_settings add column if not exists admin_contact_url text not null default 'https://t.me/Quyenvjp';
alter table shop_settings add column if not exists admin_display text not null default '@Quyenvjp';
update shop_settings
set
  shop_name = 'TIER20 SHOP',
  shop_tagline = 'AI • Coding • VPN • Phần mềm số',
  community_url = 'https://t.me/aicodexvn',
  support_url = 'https://t.me/Quyenvjp',
  admin_contact_url = 'https://t.me/Quyenvjp',
  admin_display = '@Quyenvjp'
where id = 'main';
