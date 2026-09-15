import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/infrastructure/db/client.js";

export interface RcDatasetIds {
  categoryId: string;
  campaignIds: string[];
}

export interface RcDatasetCounts {
  customers: number;
  orders: number;
  walletLedger: number;
  inventoryMovements: number;
  products: number;
  variants: number;
  notificationDeliveries: number;
}

export interface RcDatasetSummary {
  ids: RcDatasetIds;
  counts: RcDatasetCounts;
}

const COUNTS = {
  customers: 5_000,
  orders: 20_000,
  walletLedger: 50_000,
  inventoryMovements: 50_000,
  products: 100,
  variants: 500,
  notificationDeliveries: 10_000,
} as const satisfies RcDatasetCounts;

const CATEGORY_ID = "01CAT0000000000000000001";
const CAMPAIGN_IDS = ["01CAM0000000000000000001", "01CAM0000000000000000002"];

export async function seedRcDataset(db: Kysely<Database>): Promise<RcDatasetSummary> {
  await db.transaction().execute(async (trx) => {
    await sql`
      insert into category (id, name_vi, slug, is_active, sort_order)
      values (${CATEGORY_ID}, 'RC synthetic', 'rc-synthetic', true, 1)
    `.execute(trx);

    await sql`
      insert into product (id, category_id, name_vi, slug, is_active, sort_order)
      select '01PRD0' || lpad(gs::text, 20, '0'), ${CATEGORY_ID}, 'RC Product ' || gs,
        'rc-product-' || gs, true, gs
      from generate_series(1, ${COUNTS.products}) gs
    `.execute(trx);

    await sql`
      insert into product_variant
        (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, fulfillment_type, resale_evidence_id, sort_order)
      select '01VAR0' || lpad(gs::text, 20, '0'),
        '01PRD0' || lpad((((gs - 1) / 5)::int + 1)::text, 20, '0'),
        'RC-SKU-' || gs, 'RC Variant ' || gs, 100000 + gs, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'QUANTITY_STOCK', '01EVD0' || lpad(gs::text, 20, '0'), gs
      from generate_series(1, ${COUNTS.variants}) gs
    `.execute(trx);

    await sql`
      insert into variant_service_fulfillment (variant_id, fulfillment_type, instructions)
      select '01VAR0' || lpad(gs::text, 20, '0'), 'QUANTITY_STOCK', 'RC synthetic quantity stock'
      from generate_series(1, ${COUNTS.variants}) gs
    `.execute(trx);

    // Resale evidence is metadata-only: the synthetic attestation asserts no
    // supplier agreement, holds no credential, and exists so the dataset has a
    // real evidence row per variant to bind a publication to.
    await sql`
      insert into resale_evidence
        (id, variant_id, source, reference, summary, metadata_redacted, status, created_by)
      select '01EVD0' || lpad(gs::text, 20, '0'),
        '01VAR0' || lpad(gs::text, 20, '0'),
        'OWNER_ATTESTATION',
        'rc-synthetic-attestation-' || gs,
        'RC synthetic owner attestation for load profiling; no supplier authorization is asserted.',
        jsonb_build_object('synthetic', true, 'assertedBy', 'rc-seed', 'scope', 'rc-profile'),
        'ACTIVE', 'rc-seed'
      from generate_series(1, ${COUNTS.variants}) gs
    `.execute(trx);

    // Publish every variant against its own evidence at the row's current
    // version, which is the exact binding the catalog visibility predicate and
    // the buy-now publication guard compare against.
    await sql`
      update product_variant v
         set publication_evidence_id = v.resale_evidence_id,
             publication_product_version = p.version,
             publication_variant_version = v.version,
             published_at = now(),
             published_by = 'rc-seed'
        from product p
       where p.id = v.product_id
         and exists (
           select 1 from resale_evidence re
           where re.id = v.resale_evidence_id and re.variant_id = v.id and re.status = 'ACTIVE'
         )
    `.execute(trx);

    await sql`
      insert into customer (id, status, locale)
      select '01CST0' || lpad(gs::text, 20, '0'), 'ACTIVE', 'vi-VN'
      from generate_series(1, ${COUNTS.customers}) gs
    `.execute(trx);

    await sql`
      insert into channel_identity (id, customer_id, channel, channel_user_id, observed_username)
      select '01CHN0' || lpad(gs::text, 20, '0'), '01CST0' || lpad(gs::text, 20, '0'),
        'TELEGRAM', (9000000000::bigint + gs)::text, 'rc_user_' || gs
      from generate_series(1, ${COUNTS.customers}) gs
    `.execute(trx);

    // Wallets open empty: the double-entry invariant (migration 052) refuses an
    // account whose cached balance is not backed by postings. The cache is
    // materialised at the end, after the postings exist.
    await sql`
      insert into wallet_account (id, customer_id, balance_vnd)
      select '01WAL0' || lpad(gs::text, 20, '0'), '01CST0' || lpad(gs::text, 20, '0'), 0
      from generate_series(1, ${COUNTS.customers}) gs
    `.execute(trx);

    await sql`
      insert into wallet_ledger
        (id, wallet_account_id, entry_type, amount_vnd, balance_before_vnd, balance_after_vnd, idempotency_key, correlation_id, reason)
      select '01LED0' || lpad(((c - 1) * 10 + e)::text, 20, '0'),
        '01WAL0' || lpad(c::text, 20, '0'), 'CREDIT', 1000, (e - 1) * 1000, e * 1000,
        'rc-wallet-' || c || '-' || e, 'rc-wallet-' || c, 'RC synthetic topup'
      from generate_series(1, ${COUNTS.customers}) c cross join generate_series(1, 10) e
    `.execute(trx);

    // Mirror each synthetic movement into the double-entry layer so the loaded
    // dataset is internally consistent, then materialise the cached balance.
    await sql`
      insert into ledger_transaction
        (id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason)
      select '01LTX0' || lpad(((c - 1) * 10 + e)::text, 20, '0'), 'CREDIT_ADJUSTMENT',
        '01WAL0' || lpad(c::text, 20, '0'), 'rc-wallet-ledger:' || c || '-' || e,
        'rc-wallet-' || c, 'RC synthetic topup'
      from generate_series(1, ${COUNTS.customers}) c cross join generate_series(1, 10) e
    `.execute(trx);

    await sql`
      insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
      select '01LPO0' || lpad(((c - 1) * 10 + e)::text, 20, '0') || '_w',
        '01LTX0' || lpad(((c - 1) * 10 + e)::text, 20, '0'), a.id, 'CREDIT', 1000
      from generate_series(1, ${COUNTS.customers}) c cross join generate_series(1, 10) e
      join ledger_account a on a.wallet_account_id = '01WAL0' || lpad(c::text, 20, '0')
    `.execute(trx);

    await sql`
      insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
      select '01LPO0' || lpad(((c - 1) * 10 + e)::text, 20, '0') || '_c',
        '01LTX0' || lpad(((c - 1) * 10 + e)::text, 20, '0'), sys.id, 'DEBIT', 1000
      from generate_series(1, ${COUNTS.customers}) c cross join generate_series(1, 10) e
      cross join (select id from ledger_account where code = 'SHOP:ADJUSTMENT_EXPENSE') sys
    `.execute(trx);

    await sql`update wallet_account set balance_vnd = 10000 where id like '01WAL0%'`.execute(trx);

    await sql`
      insert into "order"
        (id, order_number, idempotency_key, customer_id, variant_id, product_name_vi, variant_name_vi, price_vnd, duration_code, delivery_type, warranty_days, supplier_policy_snapshot, fulfillment_type, status, expires_at, paid_at, completed_at)
      select '01ARD0' || lpad(o::text, 20, '0'), 'RC' || lpad(o::text, 10, '0'), 'rc-order-' || o,
        '01CST0' || lpad((((o - 1) % ${COUNTS.customers}) + 1)::text, 20, '0'),
        v.id, p.name_vi, v.name_vi, v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days, v.stock_policy, v.fulfillment_type,
        'COMPLETED', now() + interval '1 day', now(), now()
      from generate_series(1, ${COUNTS.orders}) o
      join product_variant v on v.id = '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0')
      join product p on p.id = v.product_id
    `.execute(trx);

    await sql`
      insert into order_transition (id, order_id, from_status, to_status, reason_code, actor_type, correlation_id)
      select '01TRN0' || lpad(gs::text, 20, '0'), '01ARD0' || lpad(gs::text, 20, '0'),
        'PENDING_PAYMENT', 'COMPLETED', 'RC_SEED', 'system', 'rc-order-' || gs
      from generate_series(1, ${COUNTS.orders}) gs
    `.execute(trx);

    await sql`
      insert into payment_intent
        (id, order_id, status, amount_vnd, merchant_account_id, transfer_content, expires_at, presented_at, settled_at)
      select '01PAY0' || lpad(o::text, 20, '0'), '01ARD0' || lpad(o::text, 20, '0'), 'SUCCEEDED', v.price_vnd,
        'rc-merchant', 'RC PAY ' || o, now() + interval '1 day', now(), now()
      from generate_series(1, ${COUNTS.orders}) o
      join product_variant v on v.id = '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0')
    `.execute(trx);

    await sql`
      insert into bank_transaction
        (id, provider, provider_transaction_id, direction, merchant_account_id, amount_vnd, content, reference, transacted_at, raw_hash, signature_status, schema_version)
      select '01BNK0' || lpad(o::text, 20, '0'), 'sepay', 'rc-txn-' || o, 'IN', 'rc-merchant', v.price_vnd,
        'RC PAY ' || o, 'RCREF' || o, now(), md5('rc-txn-' || o), 'VALID', 'rc-1'
      from generate_series(1, ${COUNTS.orders}) o
      join product_variant v on v.id = '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0')
    `.execute(trx);

    await sql`
      insert into payment_allocation
        (id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status, decision_code, correlation_id)
      select '01ALC0' || lpad(o::text, 20, '0'), '01BNK0' || lpad(o::text, 20, '0'), '01PAY0' || lpad(o::text, 20, '0'),
        v.price_vnd, 'SETTLED', 'EXACT_MATCH', 'rc-payment-' || o
      from generate_series(1, ${COUNTS.orders}) o
      join product_variant v on v.id = '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0')
    `.execute(trx);

    await sql`
      insert into variant_quantity_stock (variant_id, available_quantity)
      select '01VAR0' || lpad(gs::text, 20, '0'), 100
      from generate_series(1, ${COUNTS.variants}) gs
    `.execute(trx);

    await sql`
      insert into quantity_stock_ledger (id, variant_id, entry_type, quantity_delta, quantity_after, idempotency_key)
      select '01MOV0' || lpad(gs::text, 20, '0'), '01VAR0' || lpad(gs::text, 20, '0'),
        'ADJUST', 121, 121, 'rc-stock-initial-' || gs
      from generate_series(1, ${COUNTS.variants}) gs
    `.execute(trx);

    await sql`
      insert into quantity_stock_ledger (id, variant_id, entry_type, quantity_delta, quantity_after, idempotency_key)
      select '01MOV0' || lpad((500 + (v - 1) * 19 + e)::text, 20, '0'),
        '01VAR0' || lpad(v::text, 20, '0'), 'ADJUST', 1, 121 + e,
        'rc-stock-extra-' || v || '-' || e
      from generate_series(1, ${COUNTS.variants}) v cross join generate_series(1, 19) e
    `.execute(trx);

    await sql`
      insert into quantity_stock_ledger (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, expires_at)
      select '01MOV0' || lpad((10000 + o)::text, 20, '0'),
        '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0'),
        '01ARD0' || lpad(o::text, 20, '0'), 'RESERVE', -1,
        140 - (((o - 1) / ${COUNTS.variants})::int + 1), now() + interval '1 day'
      from generate_series(1, ${COUNTS.orders}) o
    `.execute(trx);

    await sql`
      insert into quantity_stock_ledger (id, variant_id, order_id, entry_type, quantity_delta, quantity_after, parent_ledger_id)
      select '01MOV0' || lpad((30000 + o)::text, 20, '0'),
        '01VAR0' || lpad((((o - 1) % ${COUNTS.variants}) + 1)::text, 20, '0'),
        '01ARD0' || lpad(o::text, 20, '0'), 'DELIVER', 0,
        140 - (((o - 1) / ${COUNTS.variants})::int + 1),
        '01MOV0' || lpad((10000 + o)::text, 20, '0')
      from generate_series(1, ${COUNTS.orders}) o
    `.execute(trx);

    await sql`
      insert into notification_campaign (id, class, content, status, idempotency_key, created_by, product_variant_id)
      values
        (${CAMPAIGN_IDS[0]}, 'SHOP_UPDATE', 'RC synthetic campaign A', 'QUEUED', 'rc-campaign-1', 'rc-seed', '01VAR0' || lpad('1', 20, '0')),
        (${CAMPAIGN_IDS[1]}, 'PURCHASE_ACTIVITY', 'RC synthetic campaign B', 'QUEUED', 'rc-campaign-2', 'rc-seed', '01VAR0' || lpad('2', 20, '0'))
    `.execute(trx);

    await sql`
      insert into notification_delivery (id, campaign_id, customer_id, chat_id, status, attempts, next_attempt_at, sent_at)
      select '01DLV0' || lpad(gs::text, 20, '0'),
        case when gs <= 5000 then ${CAMPAIGN_IDS[0]} else ${CAMPAIGN_IDS[1]} end,
        '01CST0' || lpad((((gs - 1) % ${COUNTS.customers}) + 1)::text, 20, '0'),
        (9000000000::bigint + (((gs - 1) % ${COUNTS.customers}) + 1))::text,
        case when gs % 10 = 0 then 'SENT' else 'PENDING' end,
        case when gs % 10 = 0 then 1 else 0 end,
        now(), case when gs % 10 = 0 then now() else null end
      from generate_series(1, ${COUNTS.notificationDeliveries}) gs
    `.execute(trx);

    await sql`
      insert into audit_event (id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata_redacted)
      select '01AUD0' || lpad(gs::text, 20, '0'), 'SYSTEM', 'rc-seed', 'ORDER_COMPLETED', 'order',
        '01ARD0' || lpad(gs::text, 20, '0'), 'RC synthetic seed', 'rc-order-' || gs, jsonb_build_object('synthetic', true)
      from generate_series(1, ${COUNTS.orders}) gs
    `.execute(trx);
  });

  await verifyRcDataset(db);
  return { ids: { categoryId: CATEGORY_ID, campaignIds: CAMPAIGN_IDS }, counts: COUNTS };
}

export async function verifyRcDataset(db: Kysely<Database>): Promise<RcDatasetSummary> {
  const counts = await sql<RcDatasetCounts>`
    select
      (select count(*)::int from customer) as customers,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from wallet_ledger) as "walletLedger",
      (select count(*)::int from quantity_stock_ledger) as "inventoryMovements",
      (select count(*)::int from product) as products,
      (select count(*)::int from product_variant) as variants,
      (select count(*)::int from notification_delivery) as "notificationDeliveries"
  `.execute(db);
  const actual = counts.rows[0];
  if (!actual) throw new Error("RC dataset verification returned no counts");

  const mismatches = (Object.keys(COUNTS) as (keyof RcDatasetCounts)[]).filter(
    (key) => actual[key] !== COUNTS[key],
  );
  if (mismatches.length > 0) {
    throw new Error(
      `RC dataset count mismatch: ${mismatches.map((key) => `${key}=${actual[key]} expected ${COUNTS[key]}`).join(", ")}`,
    );
  }

  const invariants = await sql<{ failures: number }>`
    with wallet_failures as (
      select count(*)::int as n
      from wallet_account w
      left join (
        select wallet_account_id,
          sum(case when entry_type = 'CREDIT' then amount_vnd else -amount_vnd end)::bigint as balance
        from wallet_ledger
        group by wallet_account_id
      ) l on l.wallet_account_id = w.id
      where w.balance_vnd <> coalesce(l.balance, 0)
    ), order_failures as (
      select count(*)::int as n
      from "order" o
      where not exists (select 1 from product_variant v where v.id = o.variant_id)
        or not exists (select 1 from customer c where c.id = o.customer_id)
        or not exists (select 1 from payment_intent p where p.order_id = o.id and p.status = 'SUCCEEDED')
        or not exists (select 1 from payment_allocation a join payment_intent p on p.id = a.payment_intent_id where p.order_id = o.id and a.status = 'SETTLED')
        or not exists (select 1 from audit_event a where a.target_type = 'order' and a.target_id = o.id)
    ), fulfillment_failures as (
      select count(*)::int as n
      from product_variant v
      left join variant_quantity_stock s on s.variant_id = v.id
      left join variant_service_fulfillment f on f.variant_id = v.id and f.is_active
      where v.fulfillment_type <> 'QUANTITY_STOCK'
        or s.variant_id is null
        or f.fulfillment_type <> v.fulfillment_type
        or not exists (
          select 1 from "order" o
          where o.variant_id = v.id and o.fulfillment_type = v.fulfillment_type
        )
    ), stock_failures as (
      select count(*)::int as n
      from variant_quantity_stock s
      left join product_variant v on v.id = s.variant_id
      left join (
        select variant_id, sum(quantity_delta)::int as available_quantity
        from quantity_stock_ledger
        group by variant_id
      ) l on l.variant_id = s.variant_id
      where s.available_quantity <> coalesce(l.available_quantity, -1)
        or v.fulfillment_type <> 'QUANTITY_STOCK'
        or not exists (
          select 1 from variant_service_fulfillment f
          where f.variant_id = s.variant_id and f.fulfillment_type = v.fulfillment_type and f.is_active
        )
    ), delivery_failures as (
      select count(*)::int as n
      from notification_delivery d
      where not exists (select 1 from notification_campaign c where c.id = d.campaign_id and c.status = 'QUEUED')
        or not exists (select 1 from customer c where c.id = d.customer_id)
    ), publication_failures as (
      select count(*)::int as n
      from product_variant v
      join product p on p.id = v.product_id
      left join resale_evidence re on re.id = v.publication_evidence_id
      where v.resale_evidence_id is null
        or v.publication_evidence_id is distinct from v.resale_evidence_id
        or v.publication_product_version is distinct from p.version
        or v.publication_variant_version is distinct from v.version
        or v.published_at is null
        or v.published_by is null
        or re.id is null
        or re.variant_id is distinct from v.id
        or re.status <> 'ACTIVE'
    )
    select ((select n from wallet_failures) + (select n from order_failures) +
      (select n from fulfillment_failures) + (select n from stock_failures) +
      (select n from delivery_failures) + (select n from publication_failures))::int as failures
  `.execute(db);

  const failures = invariants.rows[0]?.failures ?? 1;
  if (failures > 0) throw new Error(`RC dataset invariant failures: ${failures}`);

  return { ids: { categoryId: CATEGORY_ID, campaignIds: CAMPAIGN_IDS }, counts: actual };
}
