import assert from "node:assert/strict";
import { sql, type RawBuilder } from "kysely";
import { startPostgresContainer, type PgTestContext } from "../tests/helpers/pg-container.js";
import { seedRcDataset } from "../tests/helpers/rc-dataset.js";

const CATEGORY_ID = "01CAT0000000000000000001";
const CUSTOMER_ID = "01CST0" + "1".padStart(20, "0");
const VARIANT_ID = "01VAR0" + "1".padStart(20, "0");
const ORDER_ID = "01ARD0" + "1".padStart(20, "0");
const PAYMENT_ID = "01PAY0" + "1".padStart(20, "0");
const BANK_TRANSACTION_ID = "01BNK0" + "1".padStart(20, "0");
const TELEGRAM_SOURCE_EVENT_ID = "phase2-sql-telegram-1";
const FOLD_FROM = "àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỉĩỵ";
const FOLD_TO = "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy";

interface ExplainEnvelope {
  Plan: ExplainNode;
  "Planning Time": number;
  "Execution Time": number;
  Triggers?: unknown;
}

interface ExplainNode {
  "Node Type": string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Shared Dirtied Blocks"?: number;
  "Shared Written Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  "Index Name"?: string;
  Plans?: ExplainNode[];
  [key: string]: unknown;
}

interface ProfileReport {
  name: string;
  planningMs: number;
  executionMs: number;
  topNode: string;
  actualRows: number | null;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  sharedDirtiedBlocks: number;
  sharedWrittenBlocks: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  indexNames: string[];
  sequentialScanNodes: number;
  rawPlan: ExplainEnvelope[];
}

class RollbackExplain extends Error {}

type ExplainQuery = RawBuilder<unknown>;

function collectPlanEvidence(plan: ExplainNode): {
  indexNames: string[];
  sequentialScanNodes: number;
} {
  const indexNames = new Set<string>();
  let sequentialScanNodes = 0;
  const visit = (node: ExplainNode): void => {
    if (node["Index Name"]) indexNames.add(String(node["Index Name"]));
    if (node["Node Type"] === "Seq Scan") sequentialScanNodes += 1;
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return { indexNames: [...indexNames].sort(), sequentialScanNodes };
}

async function explain(
  ctx: PgTestContext,
  name: string,
  query: ExplainQuery,
): Promise<ProfileReport> {
  let rows: Array<{ "QUERY PLAN": unknown }> | undefined;
  try {
    await ctx.db.transaction().execute(async (trx) => {
      rows = (await query.execute(trx)).rows as Array<{ "QUERY PLAN": unknown }>;
      throw new RollbackExplain();
    });
  } catch (error) {
    if (!(error instanceof RollbackExplain)) throw error;
  }
  const rawPlan = rows?.[0]?.["QUERY PLAN"];
  assert(Array.isArray(rawPlan), `${name} did not return JSON EXPLAIN output`);
  const envelope = rawPlan as ExplainEnvelope[];
  const root = envelope[0];
  assert(root?.Plan, `${name} returned no root plan`);
  const evidence = collectPlanEvidence(root.Plan);
  return {
    name,
    planningMs: root["Planning Time"],
    executionMs: root["Execution Time"],
    topNode: root.Plan["Node Type"],
    actualRows: root.Plan["Actual Rows"] ?? null,
    sharedHitBlocks: root.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: root.Plan["Shared Read Blocks"] ?? 0,
    sharedDirtiedBlocks: root.Plan["Shared Dirtied Blocks"] ?? 0,
    sharedWrittenBlocks: root.Plan["Shared Written Blocks"] ?? 0,
    tempReadBlocks: root.Plan["Temp Read Blocks"] ?? 0,
    tempWrittenBlocks: root.Plan["Temp Written Blocks"] ?? 0,
    ...evidence,
    rawPlan: envelope,
  };
}

async function prepareRepresentativeRows(ctx: PgTestContext): Promise<void> {
  await sql`
    update bank_transaction
    set correlation_key = bank_transaction_correlation_key(
      merchant_account_id, direction, amount_vnd, reference
    )
    where id = ${BANK_TRANSACTION_ID}
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status)
    select
      '01AST0' || lpad(gs::text, 20, '0'), ${VARIANT_ID}, 'RC_PROFILE',
      'vault:phase2-sql-profile', 'phase2-sql-fingerprint-' || gs, 'AVAILABLE'
    from generate_series(1, 5000) gs
    on conflict (id) do nothing
  `.execute(ctx.db);

  await sql`
    insert into outbox_event
      (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
    select
      '01OBX0' || lpad(gs::text, 20, '0'), 'Phase2SqlProfile',
      '01OBX0' || lpad(gs::text, 20, '0'), gs, 'Phase2SqlProfile', '{}'::jsonb
    from generate_series(1, 5000) gs
    on conflict (id) do nothing
  `.execute(ctx.db);

  await sql`
    insert into webhook_inbox
      (id, source, source_event_id, raw_hash, signature_status, received_at,
       processing_status, next_attempt_at, envelope)
    select
      'phase2-sql-tg-' || gs, 'telegram', 'phase2-sql-telegram-' || gs,
      'phase2-sql-tg-hash-' || gs, 'VALID', now(), 'RETRY', now(), '{}'::jsonb
    from generate_series(1, 5000) gs
    on conflict (source, source_event_id) do nothing
  `.execute(ctx.db);

  await sql`
    insert into webhook_inbox
      (id, source, source_event_id, raw_hash, signature_status, received_at,
       processing_status, next_attempt_at, envelope)
    select
      'phase2-sql-sp-' || gs, 'sepay', 'phase2-sql-sepay-' || gs,
      'phase2-sql-sp-hash-' || gs, 'VALID', now(), 'RETRY', now(), '{}'::jsonb
    from generate_series(1, 5000) gs
    on conflict (source, source_event_id) do nothing
  `.execute(ctx.db);

  await sql`
    insert into webhook_inbox
      (id, source, source_event_id, raw_hash, signature_status, received_at, processing_status, next_attempt_at, envelope)
    values
      (${"phase2-sql-telegram-row"}, 'telegram', ${TELEGRAM_SOURCE_EVENT_ID}, 'phase2-sql-hash', 'VALID', now(), 'RETRY', now(), '{}'::jsonb)
    on conflict (source, source_event_id) do update
      set processing_status = 'RETRY', next_attempt_at = now(), claim_expires_at = null
  `.execute(ctx.db);
}

function profileQueries(): Array<{ name: string; query: ExplainQuery }> {
  return [
    {
      name: "catalog.listSellableVariants",
      query: sql`
        explain (analyze, buffers, format json)
        select v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
          v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days, v.stock_policy,
          v.sort_order, v.fulfillment_type, q.available_quantity::int as available_quantity,
          case when v.fulfillment_type = 'QUANTITY_STOCK'
            then coalesce(q.available_quantity, 0) > 0 else false end as is_ready
        from product_variant v
        join product p on p.id = v.product_id
        join category c on c.id = p.category_id
        left join variant_quantity_stock q on q.variant_id = v.id
        where c.is_active and p.is_active and v.is_active and v.price_vnd > 0
          and v.resale_evidence_id is not null
          and v.stock_policy in ('LOCAL_ONLY', 'LOCAL_THEN_SUPPLIER')
          and v.fulfillment_type <> 'SUPPLIER_API'
          and c.id = ${CATEGORY_ID}
        order by v.sort_order asc, v.id asc
        limit 21
      `,
    },
    {
      name: "catalog.searchCatalog",
      query: sql`
        explain (analyze, buffers, format json)
        select v.id, v.product_id, p.name_vi as product_name_vi, v.sku, v.name_vi,
          v.price_vnd, v.sort_order
        from product_variant v
        join product p on p.id = v.product_id
        join category c on c.id = p.category_id
        left join category parent on parent.id = c.parent_id
        left join variant_quantity_stock q on q.variant_id = v.id
        where c.is_active and p.is_active and v.is_active and v.price_vnd > 0
          and (
            (v.stock_policy in ('LOCAL_ONLY', 'LOCAL_THEN_SUPPLIER') and v.fulfillment_type <> 'SUPPLIER_API')
            or (v.stock_policy = 'SUPPLIER_ONLY' and v.fulfillment_type = 'SUPPLIER_API')
          )
          and (
            to_tsvector('simple', translate(lower(p.name_vi), ${FOLD_FROM}, ${FOLD_TO}))
              @@ to_tsquery('simple', 'rc:*')
            or to_tsvector('simple', translate(lower(c.name_vi), ${FOLD_FROM}, ${FOLD_TO}))
              @@ to_tsquery('simple', 'rc:*')
            or to_tsvector('simple', translate(lower(coalesce(parent.name_vi, '')), ${FOLD_FROM}, ${FOLD_TO}))
              @@ to_tsquery('simple', 'rc:*')
            or exists (
              select 1 from product_alias a
              where a.product_id = p.id
                and to_tsvector('simple', translate(lower(a.normalized_alias), ${FOLD_FROM}, ${FOLD_TO}))
                  @@ to_tsquery('simple', 'rc:*')
            )
          )
        order by v.sort_order asc, v.id asc
        limit 21
      `,
    },
    {
      name: "commerce.listOrderHistory",
      query: sql`
        explain (analyze, buffers, format json)
        select id, order_number, customer_id, status, product_name_vi, variant_name_vi,
          price_vnd, created_at
        from "order"
        where customer_id = ${CUSTOMER_ID}
        order by created_at desc, id desc
        limit 21
      `,
    },
    {
      name: "admin.overview.orders",
      query: sql`
        explain (analyze, buffers, format json)
        select
          (select coalesce(sum(o.price_vnd), 0)::text from "order" o
            join product_variant v on v.id = o.variant_id
            join product p on p.id = v.product_id
            where not p.is_test and not p.is_archived and o.status = 'COMPLETED'
              and o.completed_at >= now() - interval '1 day') as revenue_today_vnd,
          (select count(*)::int from "order" o
            join product_variant v on v.id = o.variant_id
            join product p on p.id = v.product_id
            where not p.is_test and not p.is_archived and o.created_at >= now() - interval '1 day') as orders_today,
          (select count(*)::int from "order" o
            join product_variant v on v.id = o.variant_id
            join product p on p.id = v.product_id
            where not p.is_test and not p.is_archived
              and o.status in ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'PAYMENT_NEEDS_REVIEW', 'FULFILLMENT_NEEDS_REVIEW')) as awaiting_action
      `,
    },
    {
      name: "admin.health.queues",
      query: sql`
        explain (analyze, buffers, format json)
        select
          (select count(*)::int from outbox_event where published_at is null and dead_lettered_at is null) as outbox_backlog,
          (select count(*)::int from outbox_event where dead_lettered_at is not null) as outbox_dead_lettered,
          (select count(*)::int from discrepancy where resolved_at is null) as open_discrepancies,
          (select count(*)::int from payment_intent pi
            join "order" o on o.id = pi.order_id
            join product_variant v on v.id = o.variant_id
            join product p on p.id = v.product_id
            where pi.status in ('CREATED', 'PRESENTED') and not p.is_test and not p.is_archived) as awaiting_settlement,
          (select count(*)::int from webhook_inbox
            where source = 'telegram' and processing_status in ('RETRY', 'PROCESSING')) as telegram_pending,
          (select count(*)::int from webhook_inbox
            where source = 'sepay' and processing_status in ('RETRY', 'PROCESSING')) as sepay_pending
      `,
    },
    {
      name: "admin.inventoryHistory",
      query: sql`
        explain (analyze, buffers, format json)
        with history as (
          select created_at as occurred_at
          from quantity_stock_ledger
          where variant_id = ${VARIANT_ID}
          union all
          select occurred_at
          from audit_event
          where target_type = 'DigitalAsset' and target_id = ${VARIANT_ID}
            and action = 'inventory.import'
        )
        select occurred_at from history order by occurred_at desc limit 20
      `,
    },
    {
      name: "payments.findBankTransactionRow",
      query: sql`
        explain (analyze, buffers, format json)
        select id, provider_transaction_id, direction, merchant_account_id,
          amount_vnd, content, raw_hash
        from bank_transaction
        where provider = 'sepay' and provider_transaction_id = 'rc-txn-1'
      `,
    },
    {
      name: "payments.correlationCandidateLookup",
      query: sql`
        explain (analyze, buffers, format json)
        select id, provider_transaction_id, direction, merchant_account_id,
          amount_vnd, content, raw_hash
        from bank_transaction
        where provider = 'sepay'
          and correlation_key = bank_transaction_correlation_key('rc-merchant', 'IN', 100001, 'RCREF1')
          and transacted_at between now() - interval '30 seconds' and now() + interval '30 seconds'
        order by id
      `,
    },
    {
      name: "telegram.inboxClaim",
      query: sql`
        explain (analyze, buffers, format json)
        with candidates as (
          select id
          from webhook_inbox
          where source = 'telegram' and (
            (processing_status = 'RETRY' and coalesce(next_attempt_at, received_at) <= now())
            or (processing_status = 'PROCESSING' and claim_expires_at <= now())
          )
          order by coalesce(next_attempt_at, claim_expires_at, received_at), received_at, id
          for update skip locked
          limit 20
        )
        update webhook_inbox w
        set processing_status = 'PROCESSING', claimed_by = 'phase2-sql-profile',
            claim_generation = w.claim_generation + 1,
            claim_expires_at = now() + interval '30 seconds',
            attempt_count = w.attempt_count + 1
        from candidates c
        where w.id = c.id
        returning w.id
      `,
    },
    {
      name: "sepay.inboxClaim",
      query: sql`
        explain (analyze, buffers, format json)
        with candidates as (
          select id
          from webhook_inbox
          where source = 'sepay' and (
            (processing_status = 'RETRY' and coalesce(next_attempt_at, received_at) <= now())
            or (processing_status = 'PROCESSING' and claim_expires_at <= now())
          )
          order by coalesce(next_attempt_at, claim_expires_at, received_at), received_at, id
          for update skip locked
          limit 20
        )
        update webhook_inbox w
        set processing_status = 'PROCESSING', claimed_by = 'phase2-sql-profile',
            claim_generation = w.claim_generation + 1,
            claim_expires_at = now() + interval '30 seconds',
            attempt_count = w.attempt_count + 1
        from candidates c
        where w.id = c.id
        returning w.id
      `,
    },
    {
      name: "notification.claimDeliveries",
      query: sql`
        explain (analyze, buffers, format json)
        with picked as (
          select d.id
          from notification_delivery d
          join notification_campaign c on c.id = d.campaign_id
          where d.status in ('PENDING', 'RETRY') and d.next_attempt_at <= now()
            and c.status = 'QUEUED'
            and (d.claim_expires_at is null or d.claim_expires_at <= now())
          order by d.next_attempt_at, d.id
          for update of d skip locked
          limit 20
        )
        update notification_delivery d
        set status = 'RETRY', attempts = d.attempts + 1,
            next_attempt_at = now() + interval '30 seconds', claimed_by = 'phase2-sql-profile',
            claim_expires_at = now() + interval '30 seconds', claim_generation = d.claim_generation + 1
        from picked p
        where d.id = p.id
        returning d.id
      `,
    },
    {
      name: "outbox.claimDue",
      query: sql`
        explain (analyze, buffers, format json)
        update outbox_event as o
        set claimed_by = 'phase2-sql-profile', claimed_at = now(),
          claim_expires_at = now() + interval '30 seconds', claim_generation = claim_generation + 1
        from (
          select id
          from outbox_event
          where published_at is null and dead_lettered_at is null
            and (next_attempt_at is null or next_attempt_at <= now())
            and (claim_expires_at is null or claim_expires_at <= now())
          order by occurred_at asc, id asc
          limit 20
          for update skip locked
        ) candidates
        where o.id = candidates.id
        returning o.id
      `,
    },
    {
      name: "inventory.digitalAssetAllocation",
      query: sql`
        explain (analyze, buffers, format json)
        select id, variant_id, vault_ref, fingerprint_hash, status, reserved_order_id, version
        from digital_asset
        where variant_id = ${VARIANT_ID} and status = 'AVAILABLE'
        order by created_at asc, id asc
        limit 1
        for update skip locked
      `,
    },
    {
      name: "inventory.quantityStockAllocation",
      query: sql`
        explain (analyze, buffers, format json)
        select id, variant_id, order_id, entry_type, quantity_delta, quantity_after
        from quantity_stock_ledger
        where variant_id = ${VARIANT_ID}
          and (order_id is null or order_id = ${ORDER_ID})
        order by created_at desc, id desc
        limit 20
      `,
    },
    {
      name: "payments.intentByOrder",
      query: sql`
        explain (analyze, buffers, format json)
        select id, order_id, status, amount_vnd, created_at
        from payment_intent
        where order_id = ${ORDER_ID}
        order by created_at desc, id desc
        limit 1
      `,
    },
    {
      name: "payments.allocationByIntent",
      query: sql`
        explain (analyze, buffers, format json)
        select id, bank_transaction_id, payment_intent_id, allocated_amount_vnd, status
        from payment_allocation
        where payment_intent_id = ${PAYMENT_ID}
        order by id
      `,
    },
  ];
}

async function main(): Promise<void> {
  let ctx: PgTestContext | undefined;
  try {
    ctx = await startPostgresContainer();
    const dataset = await seedRcDataset(ctx.db);
    assert.equal(dataset.counts.orders, 20_000, "RC order count must be 20,000");
    await prepareRepresentativeRows(ctx);
    await sql`analyze`.execute(ctx.db);
    const reports: ProfileReport[] = [];
    for (const item of profileQueries()) reports.push(await explain(ctx, item.name, item.query));
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          productionData: false,
          dataset: dataset.counts,
          explain: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
          rollbackProtected: true,
          reports,
        },
        null,
        2,
      ),
    );
  } finally {
    await ctx?.teardown();
  }
}

await main();
