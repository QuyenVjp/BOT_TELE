import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Vault } from "../../src/infrastructure/vault/port.js";
import { createInMemoryVault } from "../../src/infrastructure/vault/testing-adapter.js";
import {
  cleanupDeliveryNotificationCapabilitiesBatch,
  createDeliveryNotificationHandoff,
  processDeliveryNotificationBatch,
  recoverStoredDeliveryNotificationHandoffsBatch,
} from "../../src/modules/digital-goods/delivery-notification.js";
import {
  issueDeliveryBundle,
  revealDeliveryBundle,
} from "../../src/modules/digital-goods/delivery.js";
import { verifyDeliverySessionToken } from "../../src/modules/digital-goods/delivery-session.js";
import { fulfillPaidOrder } from "../../src/modules/digital-goods/fulfillment.js";
import { createFulfillmentOutboxHandler } from "../../src/modules/digital-goods/handlers.js";
import { newId } from "../../src/shared/ids/index.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

const SESSION_CONFIG = {
  key: "test-only-crash-delivery-session-key-material-123456",
  keyVersion: 4,
  audience: "delivery-reveal",
};
const ROTATED_SESSION_CONFIG = {
  key: "test-only-rotated-delivery-session-key-material-123456",
  keyVersion: 3,
  audience: SESSION_CONFIG.audience,
  previousKey: SESSION_CONFIG.key,
  previousKeyVersion: SESSION_CONFIG.keyVersion,
  previousKeyGraceUntil: new Date("2100-01-01T00:00:00.000Z"),
};
const EXPIRED_ROTATION_CONFIG = {
  ...ROTATED_SESSION_CONFIG,
  previousKeyGraceUntil: new Date("2000-01-01T00:00:00.000Z"),
};

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

beforeEach(async () => {
  await sql`
    truncate table delivery_capability_compensation, delivery_notification_handoff,
      delivery_session, delivery_bundle,
      channel_identity, digital_asset, outbox_event, order_transition, "order",
      product_variant, product, category, customer cascade
  `.execute(ctx.db);
});

async function seedPaidAsset(status: "AVAILABLE" | "READY") {
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const customerId = newId();
  const orderId = newId();
  const assetId = newId();
  const assetVault = createInMemoryVault();
  const vaultRef = await assetVault.write("CRASH-FIXTURE-CREDENTIAL");
  const slug = categoryId.slice(-8);
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant
      (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type,
       stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M',
      'CREDENTIAL', 'LOCAL_ONLY', 'RES-CRASH')
  `.execute(ctx.db);
  await sql`insert into customer (id) values (${customerId})`.execute(ctx.db);
  await sql`
    insert into channel_identity (id, customer_id, channel, channel_user_id)
    values (${newId()}, ${customerId}, 'TELEGRAM', '7788990011')
  `.execute(ctx.db);
  await sql`
    insert into "order"
      (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
       price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'PAID', now())
  `.execute(ctx.db);
  await sql`
    insert into digital_asset
      (id, variant_id, source_type, vault_ref, fingerprint_hash, status, reserved_order_id)
    values (${assetId}, ${variantId}, 'LOCAL', ${vaultRef}, ${"fp-" + newId()}, ${status},
      ${status === "READY" ? orderId : null})
  `.execute(ctx.db);
  return { customerId, orderId, assetId, assetVault };
}

async function seedReadyBundle() {
  const fixture = await seedPaidAsset("READY");
  const issued = await issueDeliveryBundle(ctx.db, {
    orderId: fixture.orderId,
    customerId: fixture.customerId,
    assetId: fixture.assetId,
    ttlSeconds: 900,
    correlationId: "delivery-crash-fixture",
  });
  if (!issued.ok) throw new Error("bundle issue failed");
  return { ...fixture, ...issued };
}

function createControlledVault() {
  const base = createInMemoryVault();
  const writeKeys: string[] = [];
  const writes: Array<{ key: string; material: string }> = [];
  const deleteAttempts: string[] = [];
  const failingDeleteRefs = new Set<string>();
  let failNextWrite = false;
  let failEveryDelete = false;
  let revealGate:
    | {
        started: () => void;
        wait: Promise<void>;
      }
    | undefined;
  let deleteGate:
    | {
        ref: string;
        started: () => void;
        wait: Promise<void>;
      }
    | undefined;
  const vault: Vault = {
    async write(material, options) {
      writeKeys.push(options?.idempotencyKey ?? "");
      writes.push({ key: options?.idempotencyKey ?? "", material });
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("forced vault write failure");
      }
      return base.write(material, options);
    },
    async reveal(ref) {
      const material = await base.reveal(ref);
      const gate = revealGate;
      if (gate) {
        revealGate = undefined;
        gate.started();
        await gate.wait;
      }
      return material;
    },
    async delete(ref) {
      deleteAttempts.push(ref);
      const gate = deleteGate;
      if (gate?.ref === ref) {
        deleteGate = undefined;
        gate.started();
        await gate.wait;
      }
      if (failEveryDelete || failingDeleteRefs.has(ref)) {
        throw new Error("forced vault delete failure");
      }
      await base.delete(ref);
    },
  };
  return {
    vault,
    writeKeys,
    writes,
    deleteAttempts,
    failingDeleteRefs,
    failNextWrite() {
      failNextWrite = true;
    },
    setFailEveryDelete(value: boolean) {
      failEveryDelete = value;
    },
    blockNextReveal() {
      let startedResolve!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      revealGate = { started: startedResolve, wait };
      return { started, release };
    },
    blockNextDelete(ref: string) {
      let startedResolve!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      deleteGate = { ref, started: startedResolve, wait };
      return { started, release };
    },
  };
}

async function liveSessionCount(bundleId: string): Promise<string> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from delivery_session
    where bundle_id = ${bundleId} and expires_at > now()
      and activated_at is not null
      and used_at is null and revoked_at is null
  `.execute(ctx.db);
  return result.rows[0]?.count ?? "0";
}

describe("recoverable delivery handoff protocol (T179-T181 RED)", () => {
  it("reconstructs one usable handoff after Bundle commit and before-handoff crash", async () => {
    const f = await seedPaidAsset("AVAILABLE");
    const first = await fulfillPaidOrder(ctx.db, {
      orderId: f.orderId,
      correlationId: "crash-before-handoff",
      deps: {
        vault: f.assetVault,
        supplier: null,
        deliveryBaseUrl: "https://shop.example/d",
        bundleTtlSeconds: 900,
        deliveryTokenKeys: [SESSION_CONFIG.key],
      },
    });
    if (!first.ok) throw new Error("fulfillment failed");
    expect(first.token).not.toBe("");

    // Process exited here: bundle/outbox committed, plaintext token disappeared,
    // and no notification handoff exists.
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from delivery_notification_handoff`.execute(ctx.db)
      ).rows[0]?.count,
    ).toBe("0");

    const notificationVault = createInMemoryVault();
    const handler = createFulfillmentOutboxHandler({
      db: ctx.db,
      vault: notificationVault,
      supplier: null,
      deliveryBaseUrl: "https://shop.example/d",
      bundleTtlSeconds: 900,
      deliverySession: { config: SESSION_CONFIG, ttlSeconds: 300 },
    });
    const decision = await handler({
      id: newId(),
      aggregateType: "Order",
      aggregateId: f.orderId,
      aggregateVersion: 2,
      eventType: "OrderPaid",
      payloadRedacted: { orderId: f.orderId, correlationId: "crash-before-handoff" },
      attemptCount: 2,
      claimedBy: "recovery-worker",
      generation: 2,
    });
    const handoffs = await sql<{ status: string; capability_ref: string | null }>`
      select status, capability_ref from delivery_notification_handoff
    `.execute(ctx.db);
    expect(decision).toEqual({ kind: "PUBLISHED" });
    expect(handoffs.rows).toEqual([
      { status: "READY", capability_ref: expect.stringMatching(/^vault:/) },
    ]);
  });

  it("compensates a successful vault write when the database transaction rolls back", async () => {
    const f = await seedReadyBundle();
    const stored = new Map<string, string>();
    const deleted: string[] = [];
    const vault: Vault = {
      async write(material) {
        const ref = `vault:orphan-${newId()}`;
        stored.set(ref, material);
        return ref;
      },
      async reveal(ref) {
        const value = stored.get(ref);
        if (!value) throw new Error("not found");
        return value;
      },
      async delete(ref) {
        deleted.push(ref);
        stored.delete(ref);
      },
    };
    await sql
      .raw(
        `
      create or replace function fail_delivery_handoff_store()
      returns trigger language plpgsql as $$ begin
        raise exception 'forced handoff rollback';
      end $$;
      create trigger fail_delivery_handoff_store
      before update of capability_ref on delivery_notification_handoff
      for each row when (new.capability_ref is not null)
      execute function fail_delivery_handoff_store();
    `,
      )
      .execute(ctx.db);
    try {
      await expect(
        createDeliveryNotificationHandoff(ctx.db, {
          vault,
          bundleId: f.bundleId,
          customerId: f.customerId,
          deliveryUrl: `https://shop.example/d/${f.token}`,
          sessionTtlSeconds: 300,
          sessionConfig: SESSION_CONFIG,
        }),
      ).rejects.toThrow(/forced handoff rollback/);
    } finally {
      await sql
        .raw(
          `
        drop trigger if exists fail_delivery_handoff_store on delivery_notification_handoff;
        drop function if exists fail_delivery_handoff_store();
      `,
        )
        .execute(ctx.db);
    }
    expect(deleted).toHaveLength(1);
    expect(stored.size).toBe(0);
  });

  it("retries a PREPARED initial handoff with the exact same session material", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    controlled.failNextWrite();
    await expect(
      createDeliveryNotificationHandoff(ctx.db, {
        vault: controlled.vault,
        bundleId: f.bundleId,
        customerId: f.customerId,
        deliveryUrl: `https://shop.example/d/${f.token}`,
        sessionTtlSeconds: 300,
        sessionConfig: SESSION_CONFIG,
      }),
    ).rejects.toThrow(/forced vault write failure/);
    const recovered = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: ROTATED_SESSION_CONFIG,
    });
    const initialWrites = controlled.writes.filter(({ key }) => !key.includes("-refresh-"));
    expect(recovered).toMatchObject({ reused: false });
    expect(initialWrites).toHaveLength(2);
    expect(new Set(initialWrites.map(({ key }) => key)).size).toBe(1);
    expect(new Set(initialWrites.map(({ material }) => material)).size).toBe(1);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("advances a PREPARED initial operation after previous-key grace closes", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    controlled.failNextWrite();
    await expect(
      createDeliveryNotificationHandoff(ctx.db, {
        vault: controlled.vault,
        bundleId: f.bundleId,
        customerId: f.customerId,
        deliveryUrl: `https://shop.example/d/${f.token}`,
        sessionTtlSeconds: 300,
        sessionConfig: SESSION_CONFIG,
      }),
    ).rejects.toThrow(/forced vault write failure/);
    const recovered = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: EXPIRED_ROTATION_CONFIG,
    });
    const writes = controlled.writes.filter(({ key }) => !key.includes("-refresh-"));
    expect(recovered).toMatchObject({ reused: false });
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map(({ key }) => key)).size).toBe(2);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("fails closed when an initial PREPARED session was activated outside adoption", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    controlled.failNextWrite();
    await expect(
      createDeliveryNotificationHandoff(ctx.db, {
        vault: controlled.vault,
        bundleId: f.bundleId,
        customerId: f.customerId,
        deliveryUrl: `https://shop.example/d/${f.token}`,
        sessionTtlSeconds: 300,
        sessionConfig: SESSION_CONFIG,
      }),
    ).rejects.toThrow(/forced vault write failure/);
    await sql`
      update delivery_session set activated_at = now()
      where bundle_id = ${f.bundleId} and activated_at is null
    `.execute(ctx.db);

    await expect(
      createDeliveryNotificationHandoff(ctx.db, {
        vault: controlled.vault,
        bundleId: f.bundleId,
        customerId: f.customerId,
        deliveryUrl: `https://shop.example/d/${f.token}`,
        sessionTtlSeconds: 300,
        sessionConfig: SESSION_CONFIG,
      }),
    ).rejects.toThrow(/Delivery session idempotency conflict/);
    const handoff = await sql<{ status: string; capability_ref: string | null }>`
      select status, capability_ref from delivery_notification_handoff
      where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    expect(handoff.rows[0]).toMatchObject({ status: "PREPARED", capability_ref: null });
  });

  it("durably tombstones an orphan when database swap and compensation delete both fail", async () => {
    const f = await seedReadyBundle();
    const stored = new Map<string, string>();
    let failDelete = true;
    const vault: Vault = {
      async write(material, options) {
        const ref = `vault:double-failure:${options?.idempotencyKey ?? newId()}`;
        stored.set(ref, material);
        return ref;
      },
      async reveal(ref) {
        const value = stored.get(ref);
        if (!value) throw new Error("not found");
        return value;
      },
      async delete(ref) {
        if (failDelete) throw new Error("forced vault delete failure");
        stored.delete(ref);
      },
    };
    await sql
      .raw(
        `
      create or replace function fail_delivery_handoff_store()
      returns trigger language plpgsql as $$ begin
        raise exception 'forced handoff rollback';
      end $$;
      create trigger fail_delivery_handoff_store
      before update of capability_ref on delivery_notification_handoff
      for each row when (new.capability_ref is not null)
      execute function fail_delivery_handoff_store();
    `,
      )
      .execute(ctx.db);
    try {
      await expect(
        createDeliveryNotificationHandoff(ctx.db, {
          vault,
          bundleId: f.bundleId,
          customerId: f.customerId,
          deliveryUrl: `https://shop.example/d/${f.token}`,
          sessionTtlSeconds: 300,
          sessionConfig: SESSION_CONFIG,
        }),
      ).rejects.toThrow(/forced handoff rollback/);
    } finally {
      await sql
        .raw(
          `
        drop trigger if exists fail_delivery_handoff_store on delivery_notification_handoff;
        drop function if exists fail_delivery_handoff_store();
      `,
        )
        .execute(ctx.db);
    }

    const stranded = await sql<{
      capability_ref: string | null;
      payload_redacted: { orphanCapabilityRefs?: string[] };
    }>`
      select capability_ref, payload_redacted
      from delivery_notification_handoff
      where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    const orphanRef = stranded.rows[0]?.payload_redacted.orphanCapabilityRefs?.[0];
    expect(stranded.rows[0]?.capability_ref).toBeNull();
    expect(orphanRef).toMatch(/^vault:double-failure:/);
    expect(stored.has(orphanRef!)).toBe(true);
    const liveSessions = await liveSessionCount(f.bundleId);
    expect(liveSessions).toBe("0");
    const orphanCapability = JSON.parse(await vault.reveal(orphanRef!)) as {
      sessionToken: string;
    };
    const inactiveClaims = verifyDeliverySessionToken(
      orphanCapability.sessionToken,
      SESSION_CONFIG,
    );
    expect(inactiveClaims).not.toBeNull();
    await expect(
      revealDeliveryBundle(ctx.db, {
        token: f.token,
        session: inactiveClaims!,
        correlationId: "inactive-orphan-reveal",
        vault: f.assetVault,
      }),
    ).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });

    failDelete = false;
    await sql`
      update delivery_bundle set status = 'EXPIRED', expires_at = now() - interval '1 second'
      where id = ${f.bundleId}
    `.execute(ctx.db);
    const cleanup = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    expect(cleanup).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const recovered = await sql<{ payload_redacted: { orphanCapabilityRefs?: string[] } }>`
      select payload_redacted from delivery_notification_handoff where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    expect(recovered.rows[0]?.payload_redacted.orphanCapabilityRefs ?? []).toEqual([]);
    expect(stored.size).toBe(0);
  });

  it("records compensation in the child ledger when the legacy tombstone array is full", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await sql
      .raw(
        `
      create or replace function saturate_delivery_handoff_tombstone()
      returns trigger language plpgsql as $$ begin
        new.payload_redacted = jsonb_build_object(
          'orphanCapabilityRefs',
          (select jsonb_agg('vault:legacy:' || i) from generate_series(0, 15) as i)
        );
        return new;
      end $$;
      create trigger saturate_delivery_handoff_tombstone
      before insert on delivery_notification_handoff
      for each row execute function saturate_delivery_handoff_tombstone();
      create or replace function fail_delivery_handoff_store()
      returns trigger language plpgsql as $$ begin
        raise exception 'forced saturated handoff rollback';
      end $$;
      create trigger fail_delivery_handoff_store
      before update of capability_ref on delivery_notification_handoff
      for each row when (new.capability_ref is not null)
      execute function fail_delivery_handoff_store();
    `,
      )
      .execute(ctx.db);
    controlled.setFailEveryDelete(true);
    try {
      await expect(
        createDeliveryNotificationHandoff(ctx.db, {
          vault: controlled.vault,
          bundleId: f.bundleId,
          customerId: f.customerId,
          deliveryUrl: `https://shop.example/d/${f.token}`,
          sessionTtlSeconds: 300,
          sessionConfig: SESSION_CONFIG,
        }),
      ).rejects.toThrow(/forced saturated handoff rollback/);
    } finally {
      await sql
        .raw(
          `
        drop trigger if exists fail_delivery_handoff_store on delivery_notification_handoff;
        drop function if exists fail_delivery_handoff_store();
        drop trigger if exists saturate_delivery_handoff_tombstone on delivery_notification_handoff;
        drop function if exists saturate_delivery_handoff_tombstone();
      `,
        )
        .execute(ctx.db);
    }
    const proof = await sql<{ ledger_count: string; legacy_count: number }>`
      select
        (select count(*)::text from delivery_capability_compensation
         where handoff_id = h.id and status = 'PENDING') as ledger_count,
        jsonb_array_length(payload_redacted -> 'orphanCapabilityRefs') as legacy_count
      from delivery_notification_handoff h where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    expect(proof.rows).toEqual([{ ledger_count: "1", legacy_count: 16 }]);
  });

  it("refreshes an expired session idempotently while the Bundle is still live", async () => {
    const f = await seedReadyBundle();
    const vault = createInMemoryVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const result = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault,
      sender: {
        async send(input) {
          expect(input.miniAppUrl).toContain("handoff=");
        },
      },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "expiry-refresh-worker",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    } as Parameters<typeof processDeliveryNotificationBatch>[0]);
    const proof = await sql<{ status: string; live_sessions: string }>`
      select h.status,
        (select count(*)::text from delivery_session s
         where s.bundle_id = h.bundle_id and s.expires_at > now()
           and s.used_at is null and s.revoked_at is null) as live_sessions
      from delivery_notification_handoff h
    `.execute(ctx.db);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(proof.rows).toEqual([{ status: "SENT", live_sessions: "1" }]);
  });

  it("reuses one refresh operation key after session commit but before vault write", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    controlled.failNextWrite();

    const first = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "refresh-before-write-a",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const second = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "refresh-before-write-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: ROTATED_SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });

    const refreshKeys = controlled.writeKeys.filter((key) => key.includes("-refresh-"));
    const refreshMaterials = controlled.writes
      .filter(({ key }) => key.includes("-refresh-"))
      .map(({ material }) => material);
    expect(first).toMatchObject({ failed: 1, sent: 0 });
    expect(second).toMatchObject({ failed: 0, sent: 1 });
    expect(refreshKeys).toHaveLength(2);
    expect(new Set(refreshKeys).size).toBe(1);
    expect(new Set(refreshMaterials).size).toBe(1);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("advances refresh generation after previous-key grace closes", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    controlled.failNextWrite();
    const first = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "refresh-grace-a",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const second = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "refresh-grace-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: EXPIRED_ROTATION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const keys = controlled.writeKeys.filter((key) => key.includes("-refresh-"));
    expect(first).toMatchObject({ failed: 1, sent: 0 });
    expect(second).toMatchObject({ failed: 0, sent: 1 });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("recovers a vault write before database swap with one deterministic capability", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await sql
      .raw(
        `
      create or replace function fail_delivery_refresh_swap()
      returns trigger language plpgsql as $$ begin
        raise exception 'forced refresh swap rollback';
      end $$;
      create trigger fail_delivery_refresh_swap
      before update of capability_ref on delivery_notification_handoff
      for each row when (new.capability_ref is distinct from old.capability_ref)
      execute function fail_delivery_refresh_swap();
    `,
      )
      .execute(ctx.db);
    controlled.setFailEveryDelete(true);
    try {
      const first = await processDeliveryNotificationBatch({
        db: ctx.db,
        vault: controlled.vault,
        sender: { async send() {} },
        miniAppBaseUrl: "https://shop.example/miniapp/delivery",
        owner: "refresh-swap-a",
        batchSize: 1,
        maxAttempts: 5,
        sessionConfig: SESSION_CONFIG,
        sessionTtlSeconds: 300,
      });
      expect(first).toMatchObject({ failed: 1, sent: 0 });
    } finally {
      await sql
        .raw(
          `
        drop trigger if exists fail_delivery_refresh_swap on delivery_notification_handoff;
        drop function if exists fail_delivery_refresh_swap();
      `,
        )
        .execute(ctx.db);
    }
    controlled.setFailEveryDelete(false);

    const second = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "refresh-swap-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const refreshKeys = controlled.writeKeys.filter((key) => key.includes("-refresh-"));
    const row = await sql<{
      status: string;
      payload_redacted: { orphanCapabilityRefs?: string[]; refreshPending?: boolean };
    }>`select status, payload_redacted from delivery_notification_handoff where bundle_id = ${f.bundleId}`.execute(
      ctx.db,
    );
    expect(second).toMatchObject({ failed: 0, sent: 1 });
    expect(new Set(refreshKeys).size).toBe(1);
    expect(row.rows[0]).toMatchObject({ status: "SENT" });
    expect(row.rows[0]?.payload_redacted.refreshPending).toBe(false);
    expect(row.rows[0]?.payload_redacted.orphanCapabilityRefs ?? []).toEqual([]);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("fences capability adoption while the compensation ledger owns deletion", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await sql
      .raw(
        `
      create or replace function fail_delivery_refresh_swap()
      returns trigger language plpgsql as $$ begin
        raise exception 'forced refresh cleanup race';
      end $$;
      create trigger fail_delivery_refresh_swap
      before update of capability_ref on delivery_notification_handoff
      for each row when (new.capability_ref is distinct from old.capability_ref)
      execute function fail_delivery_refresh_swap();
    `,
      )
      .execute(ctx.db);
    controlled.setFailEveryDelete(true);
    try {
      const first = await processDeliveryNotificationBatch({
        db: ctx.db,
        vault: controlled.vault,
        sender: { async send() {} },
        miniAppBaseUrl: "https://shop.example/miniapp/delivery",
        owner: "cleanup-race-a",
        batchSize: 1,
        maxAttempts: 5,
        sessionConfig: SESSION_CONFIG,
        sessionTtlSeconds: 300,
      });
      expect(first).toMatchObject({ failed: 1, sent: 0 });
    } finally {
      await sql
        .raw(
          `
        drop trigger if exists fail_delivery_refresh_swap on delivery_notification_handoff;
        drop function if exists fail_delivery_refresh_swap();
      `,
        )
        .execute(ctx.db);
      controlled.setFailEveryDelete(false);
    }
    const pending = await sql<{ capability_ref: string }>`
      select capability_ref from delivery_capability_compensation
      where handoff_id = (select id from delivery_notification_handoff where bundle_id = ${f.bundleId})
        and status = 'PENDING'
    `.execute(ctx.db);
    const pendingRef = pending.rows[0]!.capability_ref;
    const gate = controlled.blockNextDelete(pendingRef);
    const cleanupRun = cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    await gate.started;
    const fenced = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "cleanup-race-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    gate.release();
    const cleanup = await cleanupRun;
    const recovered = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "cleanup-race-c",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const current = await sql<{ capability_ref: string }>`
      select capability_ref from delivery_notification_handoff where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    expect(fenced).toMatchObject({ failed: 1, sent: 0 });
    expect(cleanup).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(recovered).toMatchObject({ failed: 0, sent: 1 });
    await expect(controlled.vault.reveal(current.rows[0]!.capability_ref)).resolves.toContain(
      "sessionToken",
    );
  });

  it("fences a stale refresh after lease transfer without creating another capability", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const gate = controlled.blockNextReveal();
    const staleRun = processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "lease-owner-a",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    await gate.started;
    await sql`
      update delivery_notification_handoff set claim_expires_at = now() - interval '1 second'
      where bundle_id = ${f.bundleId}
    `.execute(ctx.db);
    const winner = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "lease-owner-b",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    gate.release();
    const stale = await staleRun;

    const refreshKeys = controlled.writeKeys.filter((key) => key.includes("-refresh-"));
    expect(winner).toMatchObject({ sent: 1, stale: 0 });
    expect(stale).toMatchObject({ sent: 0, stale: 1 });
    expect(refreshKeys).toHaveLength(1);
    expect(await liveSessionCount(f.bundleId)).toBe("1");
  });

  it("tombstones an old capability before delete and cleans it after delete recovery", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 1,
      sessionConfig: SESSION_CONFIG,
    });
    const before = await sql<{ capability_ref: string }>`
      select capability_ref from delivery_notification_handoff where id = ${handoff.id}
    `.execute(ctx.db);
    const oldRef = before.rows[0]!.capability_ref;
    controlled.failingDeleteRefs.add(oldRef);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const sent = await processDeliveryNotificationBatch({
      db: ctx.db,
      vault: controlled.vault,
      sender: { async send() {} },
      miniAppBaseUrl: "https://shop.example/miniapp/delivery",
      owner: "old-ref-delete-failure",
      batchSize: 1,
      maxAttempts: 5,
      sessionConfig: SESSION_CONFIG,
      sessionTtlSeconds: 300,
    });
    const swapped = await sql<{
      capability_ref: string;
      payload_redacted: { orphanCapabilityRefs?: string[] };
    }>`select capability_ref, payload_redacted from delivery_notification_handoff where id = ${handoff.id}`.execute(
      ctx.db,
    );
    expect(sent).toMatchObject({ sent: 1, failed: 0 });
    expect(swapped.rows[0]?.capability_ref).not.toBe(oldRef);
    expect(swapped.rows[0]?.payload_redacted.orphanCapabilityRefs).toContain(oldRef);

    controlled.failingDeleteRefs.delete(oldRef);
    const cleanup = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    expect(cleanup).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const cleaned = await sql<{ payload_redacted: { orphanCapabilityRefs?: string[] } }>`
      select payload_redacted from delivery_notification_handoff where id = ${handoff.id}
    `.execute(ctx.db);
    expect(cleaned.rows[0]?.payload_redacted.orphanCapabilityRefs ?? []).toEqual([]);
    await expect(controlled.vault.reveal(oldRef)).rejects.toThrow();
    await expect(controlled.vault.reveal(swapped.rows[0]!.capability_ref)).resolves.toContain(
      "sessionToken",
    );
  });

  it("promotes crash-left STORED handoffs and cleans terminal capability refs in bounded batches", async () => {
    const f = await seedReadyBundle();
    const vault = createInMemoryVault();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const ref = (
      await sql<{ capability_ref: string }>`
        update delivery_notification_handoff set status = 'STORED', ready_at = null
        where id = ${handoff.id} returning capability_ref
      `.execute(ctx.db)
    ).rows[0]!.capability_ref;

    const recovered = await recoverStoredDeliveryNotificationHandoffsBatch(ctx.db, {
      batchSize: 1,
    });
    expect(recovered).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    await sql`
      update delivery_notification_handoff
      set status = 'SENT', sent_at = now() - interval '1 day'
      where id = ${handoff.id}
    `.execute(ctx.db);
    const cleaned = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    expect(cleaned).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const row = await sql<{ capability_ref: string | null }>`
      select capability_ref from delivery_notification_handoff where id = ${handoff.id}
    `.execute(ctx.db);
    expect(row.rows[0]?.capability_ref).toBeNull();
    await expect(vault.reveal(ref)).rejects.toThrow();
  });

  it("reclaims expired cleanup leases with backoff and never deletes a CLEANED ref twice", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const orphanRef = await controlled.vault.write("orphan-capability", {
      namespace: "capability",
      idempotencyKey: "expired-cleanup-lease",
    });
    controlled.failingDeleteRefs.add(orphanRef);
    const now = new Date("2026-07-18T00:00:00.000Z");
    await sql`
      insert into delivery_capability_compensation
        (id, handoff_id, capability_ref, reason, status, cleanup_after,
         claimed_by, claim_generation, claim_expires_at, attempt_count)
      values (${newId()}, ${handoff.id}, ${orphanRef}, 'TEST_EXPIRED_LEASE', 'DELETING',
        ${new Date(now.getTime() - 60_000).toISOString()}, 'crashed-cleaner', 7,
        ${new Date(now.getTime() - 1_000).toISOString()}, 3)
    `.execute(ctx.db);

    const failed = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
      now,
    });
    const backedOff = await sql<{
      status: string;
      attempt_count: number;
      cleanup_after: Date | string;
    }>`select status, attempt_count, cleanup_after from delivery_capability_compensation
       where capability_ref = ${orphanRef}`.execute(ctx.db);
    expect(failed).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(backedOff.rows[0]).toMatchObject({ status: "PENDING", attempt_count: 4 });
    expect(new Date(backedOff.rows[0]!.cleanup_after).getTime()).toBe(now.getTime() + 80_000);

    const tooEarly = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
      now,
    });
    expect(tooEarly.claimed).toBe(0);
    controlled.failingDeleteRefs.delete(orphanRef);
    const recovered = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
      now: new Date(now.getTime() + 81_000),
    });
    const afterClean = await cleanupDeliveryNotificationCapabilitiesBatch(
      ctx.db,
      controlled.vault,
      {
        batchSize: 1,
        retentionSeconds: 0,
        now: new Date(now.getTime() + 82_000),
      },
    );
    expect(recovered).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(afterClean.claimed).toBe(0);
    expect(controlled.deleteAttempts.filter((ref) => ref === orphanRef)).toHaveLength(2);
  });

  it("fences concurrent cleaners for one terminal handoff capability", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const terminal = await sql<{ capability_ref: string }>`
      update delivery_notification_handoff
      set status = 'SENT', sent_at = now() - interval '1 day'
      where id = ${handoff.id}
      returning capability_ref
    `.execute(ctx.db);
    const ref = terminal.rows[0]!.capability_ref;
    const gate = controlled.blockNextDelete(ref);
    const firstRun = cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    await gate.started;
    const second = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
    });
    gate.release();
    const first = await firstRun;
    expect(first).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(second.claimed).toBe(0);
    expect(controlled.deleteAttempts.filter((candidate) => candidate === ref)).toHaveLength(1);
  });

  it("moves a failed terminal cleanup into delayed durable compensation", async () => {
    const f = await seedReadyBundle();
    const controlled = createControlledVault();
    const handoff = await createDeliveryNotificationHandoff(ctx.db, {
      vault: controlled.vault,
      bundleId: f.bundleId,
      customerId: f.customerId,
      deliveryUrl: `https://shop.example/d/${f.token}`,
      sessionTtlSeconds: 300,
      sessionConfig: SESSION_CONFIG,
    });
    const terminal = await sql<{ capability_ref: string }>`
      update delivery_notification_handoff
      set status = 'DEAD', sent_at = now() - interval '1 day'
      where id = ${handoff.id}
      returning capability_ref
    `.execute(ctx.db);
    const ref = terminal.rows[0]!.capability_ref;
    controlled.failingDeleteRefs.add(ref);
    const now = new Date();
    const first = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
      now,
    });
    const row = await sql<{
      capability_ref: string | null;
      status: string;
      cleanup_after: Date | string;
    }>`
      select h.capability_ref, c.status, c.cleanup_after
      from delivery_notification_handoff h
      join delivery_capability_compensation c on c.handoff_id = h.id
      where h.id = ${handoff.id} and c.capability_ref = ${ref}
    `.execute(ctx.db);
    await sql`
      update delivery_notification_handoff set capability_ref = ${ref}
      where id = ${handoff.id}
    `.execute(ctx.db);
    const immediate = await cleanupDeliveryNotificationCapabilitiesBatch(ctx.db, controlled.vault, {
      batchSize: 1,
      retentionSeconds: 0,
      now,
    });
    const retombstoned = await sql<{ cleanup_after: Date | string }>`
      select cleanup_after from delivery_capability_compensation
      where capability_ref = ${ref}
    `.execute(ctx.db);
    expect(first).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(row.rows[0]?.capability_ref).toBeNull();
    expect(row.rows[0]?.status).toBe("PENDING");
    expect(new Date(row.rows[0]!.cleanup_after).getTime()).toBeGreaterThan(now.getTime());
    expect(immediate.claimed).toBe(0);
    expect(new Date(retombstoned.rows[0]!.cleanup_after).getTime()).toBe(
      new Date(row.rows[0]!.cleanup_after).getTime(),
    );
    expect(controlled.deleteAttempts.filter((candidate) => candidate === ref)).toHaveLength(1);
  });
});
