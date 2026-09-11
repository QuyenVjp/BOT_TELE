import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import {
  confirmBroadcast,
  createBroadcast,
  enqueueBroadcastRecipients,
  hashBroadcastAudience,
  markBroadcastPreviewed,
  previewBroadcastAudience,
  selectBroadcastAudience,
} from "../../src/modules/notification/service.js";
import {
  dockerAvailable,
  startPostgresContainer,
  type PgTestContext,
} from "../helpers/pg-container.js";

const hasDocker = await dockerAvailable();
let ctx: PgTestContext;

const CONFIRM_DEFAULTS = {
  largeAudienceThreshold: 500,
  cooldownSeconds: 300,
  correlationId: "corr-confirm",
};

beforeAll(async () => {
  if (hasDocker) ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  if (!hasDocker) return;
  await sql`truncate table notification_campaign_audience, notification_delivery, notification_campaign,
      notification_preference, customer_profile_snapshot, channel_identity, customer cascade`.execute(
    ctx.db,
  );
  await sql`update broadcast_throttle set last_large_audience_at = null where id='main'`.execute(
    ctx.db,
  );
});

/** Customer with a reachable Telegram chat, optionally opted into shop updates. */
async function seedReachable(shopUpdates: boolean): Promise<string> {
  const customerId = newId();
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi-VN')`.execute(
    ctx.db,
  );
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', ${String(900_000_000 + Math.floor(Math.random() * 89_999_999))})
  `.execute(ctx.db);
  await sql`
    insert into notification_preference (customer_id, shop_updates, purchase_activity)
    values (${customerId}, ${shopUpdates}, false)
  `.execute(ctx.db);
  return customerId;
}

describe.skipIf(!hasDocker)("broadcast confirmation integrity", () => {
  it("binds the confirmation to the previewed content and audience", async () => {
    await seedReachable(true);
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Sale cuối tuần",
      createdBy: "admin",
      idempotencyKey: "bind-hash",
      audience: "shop",
    });

    expect(
      await markBroadcastPreviewed(ctx.db, {
        campaignId,
        createdBy: "admin",
        content: "Sale cuối tuần",
      }),
    ).toBe(true);

    const previewed = await sql<{
      revision: number;
      previewed_content_hash: string;
      previewed_audience_hash: string;
      previewed_audience_count: number;
    }>`select revision, previewed_content_hash, previewed_audience_hash, previewed_audience_count
       from notification_campaign where id=${campaignId}`.execute(ctx.db);
    const row = previewed.rows[0]!;
    expect(row.previewed_audience_count).toBe(2);
    expect(row.previewed_content_hash).toMatch(/^[0-9a-f]{64}$/);

    // The recorded audience hash must be the fingerprint of the frozen preview set.
    const frozen = await sql<{ customer_id: string; chat_id: string }>`
      select customer_id, chat_id from notification_campaign_audience
      where campaign_id=${campaignId} and stage='PREVIEW' order by customer_id
    `.execute(ctx.db);
    expect(
      hashBroadcastAudience(
        frozen.rows.map((r) => ({ customerId: r.customer_id, chatId: r.chat_id })),
      ),
    ).toBe(row.previewed_audience_hash);

    const confirmed = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(confirmed).toMatchObject({ ok: true, queued: 2, revision: row.revision });

    const evidence = await sql<{
      confirmed_at: Date | null;
      confirmed_by: string | null;
      audience_hash: string;
    }>`
      select confirmed_at, confirmed_by, audience_hash from notification_campaign where id=${campaignId}
    `.execute(ctx.db);
    expect(evidence.rows[0]?.confirmed_by).toBe("admin");
    expect(evidence.rows[0]?.confirmed_at).not.toBeNull();
    expect(evidence.rows[0]?.audience_hash).toBe(row.previewed_audience_hash);
  });

  it("refuses to confirm a preview whose audience has since changed", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Marketing",
      createdBy: "admin",
      idempotencyKey: "stale-audience",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Marketing" });

    // A new customer opts in after the operator reviewed the preview.
    await seedReachable(true);

    const refused = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(refused).toEqual({ ok: false, reason: "STALE_PREVIEW" });

    // Nothing was queued and no delivery escaped.
    const status = await sql<{ status: string }>`
      select status from notification_campaign where id=${campaignId}
    `.execute(ctx.db);
    expect(status.rows[0]?.status).toBe("DRAFT");
    const deliveries = await sql<{ count: number }>`
      select count(*)::int as count from notification_delivery where campaign_id=${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows[0]?.count).toBe(0);

    // Re-previewing picks up the new audience and then confirmation succeeds.
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Marketing" });
    const retried = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(retried).toMatchObject({ ok: true, queued: 2 });
  });

  it("refuses to confirm content that differs from what was previewed", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Bản gốc",
      createdBy: "admin",
      idempotencyKey: "stale-content",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Bản gốc" });

    // A write that bypasses preview: the reviewed text is no longer the stored text.
    await sql`update notification_campaign set content='Nội dung bị đổi' where id=${campaignId}`.execute(
      ctx.db,
    );

    await expect(
      confirmBroadcast(ctx.db, { campaignId, createdBy: "admin", ...CONFIRM_DEFAULTS }),
    ).resolves.toEqual({ ok: false, reason: "STALE_PREVIEW" });
  });

  it("is idempotent: a repeated confirmation cannot fan out twice", async () => {
    const first = await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Chỉ một lần",
      createdBy: "admin",
      idempotencyKey: "idempotent-confirm",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Chỉ một lần",
    });

    const once = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(once).toMatchObject({ ok: true, queued: 1 });

    const twice = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(twice).toEqual({ ok: false, reason: "NOT_DRAFT" });

    const deliveries = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery where campaign_id=${campaignId}
    `.execute(ctx.db);
    expect(deliveries.rows).toEqual([{ customer_id: first }]);
  });

  it("refuses a confirmation from an admin who does not own the draft", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Của admin khác",
      createdBy: "admin",
      idempotencyKey: "ownership",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Của admin khác",
    });

    await expect(
      confirmBroadcast(ctx.db, { campaignId, createdBy: "kẻ-mạo-danh", ...CONFIRM_DEFAULTS }),
    ).resolves.toEqual({ ok: false, reason: "NOT_OWNED" });
    // The compatibility enqueue path enforces the same ownership rule.
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId, undefined, "kẻ-mạo-danh")).toBe(0);
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId, undefined, "admin")).toBe(1);
  });

  it("refuses to confirm a draft that was never previewed", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Chưa xem trước",
      createdBy: "admin",
      idempotencyKey: "not-previewed",
      audience: "shop",
    });

    await expect(
      confirmBroadcast(ctx.db, { campaignId, createdBy: "admin", ...CONFIRM_DEFAULTS }),
    ).resolves.toEqual({ ok: false, reason: "NOT_PREVIEWED" });
    expect(await enqueueBroadcastRecipients(ctx.db, campaignId)).toBe(0);
  });

  it("rate limits a large audience until the cooldown expires", async () => {
    for (let index = 0; index < 3; index += 1) await seedReachable(true);

    const build = async (key: string): Promise<string> => {
      const campaignId = await createBroadcast(ctx.db, {
        class: "SHOP_UPDATE",
        content: `Chiến dịch ${key}`,
        createdBy: "admin",
        idempotencyKey: key,
        audience: "shop",
      });
      await markBroadcastPreviewed(ctx.db, {
        campaignId,
        createdBy: "admin",
        content: `Chiến dịch ${key}`,
      });
      return campaignId;
    };

    // Threshold 2 so the 3-recipient audience counts as "large" for this test.
    const small = { largeAudienceThreshold: 2, cooldownSeconds: 300 };
    const first = await build("cooldown-a");
    const start = new Date("2026-09-11T00:00:00.000Z");
    expect(
      await confirmBroadcast(ctx.db, {
        campaignId: first,
        createdBy: "admin",
        correlationId: "c1",
        now: start,
        ...small,
      }),
    ).toMatchObject({ ok: true, queued: 3 });

    const second = await build("cooldown-b");
    const during = new Date(start.getTime() + 60_000);
    await expect(
      confirmBroadcast(ctx.db, {
        campaignId: second,
        createdBy: "admin",
        correlationId: "c2",
        now: during,
        ...small,
      }),
    ).resolves.toEqual({ ok: false, reason: "COOLDOWN_ACTIVE" });

    const after = new Date(start.getTime() + 301_000);
    await expect(
      confirmBroadcast(ctx.db, {
        campaignId: second,
        createdBy: "admin",
        correlationId: "c3",
        now: after,
        ...small,
      }),
    ).resolves.toMatchObject({ ok: true, queued: 3 });
  });

  it("keeps the audit trail for confirmation and cancellation without secrets", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Có kiểm toán",
      createdBy: "admin",
      idempotencyKey: "audited",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Có kiểm toán",
    });
    await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
      correlationId: "audit-corr",
    });

    const audit = await sql<{ action: string; metadata_redacted: Record<string, unknown> }>`
      select action, metadata_redacted from audit_event
      where target_type='NotificationCampaign' and target_id=${campaignId}
      order by occurred_at asc
    `.execute(ctx.db);
    expect(audit.rows.map((row) => row.action)).toContain("broadcast.confirmed");
    const confirmedRow = audit.rows.find((row) => row.action === "broadcast.confirmed")!;
    expect(confirmedRow.metadata_redacted).toMatchObject({
      audience: "shop",
      audienceCount: 1,
    });
    // No credential-shaped value may appear in the audit payload.
    expect(JSON.stringify(confirmedRow.metadata_redacted)).not.toMatch(/token|secret|password/i);
  });

  it("freezes the audience so a later preference change cannot alter a queued send", async () => {
    const optedIn = await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Đóng băng",
      createdBy: "admin",
      idempotencyKey: "frozen",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Đóng băng" });

    // A second customer opts in after the preview, then the owner's prefs change.
    const late = await seedReachable(true);
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Đóng băng" });
    await confirmBroadcast(ctx.db, { campaignId, createdBy: "admin", ...CONFIRM_DEFAULTS });

    await sql`update notification_preference set shop_updates=false where customer_id in (${optedIn}, ${late})`.execute(
      ctx.db,
    );

    const deliveries = await sql<{ customer_id: string }>`
      select customer_id from notification_delivery where campaign_id=${campaignId} order by customer_id
    `.execute(ctx.db);
    expect(deliveries.rows.map((r) => r.customer_id)).toEqual([optedIn, late].sort());
  });

  it("makes confirmed audience evidence append-only", async () => {
    await seedReachable(true);
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Bằng chứng",
      createdBy: "admin",
      idempotencyKey: "append-only",
      audience: "shop",
    });
    await markBroadcastPreviewed(ctx.db, { campaignId, createdBy: "admin", content: "Bằng chứng" });
    await confirmBroadcast(ctx.db, { campaignId, createdBy: "admin", ...CONFIRM_DEFAULTS });

    await expect(
      sql`update notification_campaign_audience set chat_id='999' where stage='CONFIRMED'`.execute(
        ctx.db,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      sql`delete from notification_campaign_audience where stage='CONFIRMED'`.execute(ctx.db),
    ).rejects.toThrow(/append-only/i);
  });

  it("has an empty audience when nobody is reachable and still confirms cleanly", async () => {
    const campaignId = await createBroadcast(ctx.db, {
      class: "SHOP_UPDATE",
      content: "Không ai nhận",
      createdBy: "admin",
      idempotencyKey: "empty-audience",
      audience: "shop",
    });
    expect(await previewBroadcastAudience(ctx.db, "shop")).toBe(0);
    await markBroadcastPreviewed(ctx.db, {
      campaignId,
      createdBy: "admin",
      content: "Không ai nhận",
    });

    const confirmed = await confirmBroadcast(ctx.db, {
      campaignId,
      createdBy: "admin",
      ...CONFIRM_DEFAULTS,
    });
    expect(confirmed).toMatchObject({ ok: true, queued: 0 });
  });

  it("selects exactly the reachable audience the preview counted", async () => {
    const reachable = await seedReachable(true);
    const unreachableId = await seedReachable(true);
    await sql`
      insert into customer_profile_snapshot (customer_id, telegram_user_id, chat_id, reachable)
      values (${unreachableId}, '555000111', '555000111', false)
    `.execute(ctx.db);

    const selected = await selectBroadcastAudience(ctx.db, "shop", undefined, "SHOP_UPDATE");
    expect(selected.map((r) => r.customerId)).toEqual([reachable]);
    expect(await previewBroadcastAudience(ctx.db, "shop", undefined, "SHOP_UPDATE")).toBe(
      selected.length,
    );
  });
});
