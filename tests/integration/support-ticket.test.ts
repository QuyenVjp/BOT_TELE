import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { newId } from "../../src/shared/ids/index.js";
import { createSupportService } from "../../src/modules/support/service.js";
import { toSafeSummary } from "../../src/modules/support/domain.js";
import { startPostgresContainer, type PgTestContext } from "../helpers/pg-container.js";

/**
 * T081 — Structured support ticket: reason, safe summary, SLA, linked Order
 * (FR-019).
 *
 * A ticket is created with a structured reason code and a safe summary that
 * never contains the delivered secret. When linked to an Order it must be the
 * customer's own Order (ownership). An SLA due date is set from the reason.
 */

let ctx: PgTestContext;

beforeAll(async () => {
  ctx = await startPostgresContainer();
}, 180_000);

afterAll(async () => {
  await ctx?.teardown();
});

async function seedCustomerWithOrder(): Promise<{ customerId: string; orderId: string }> {
  const customerId = newId();
  const categoryId = newId();
  const productId = newId();
  const variantId = newId();
  const orderId = newId();
  const slug = categoryId.slice(-8);
  await sql`insert into customer (id, status, locale) values (${customerId}, 'ACTIVE', 'vi')`.execute(
    ctx.db,
  );
  await sql`insert into category (id, name_vi, slug, is_active, sort_order) values (${categoryId}, 'C', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`insert into product (id, category_id, name_vi, slug, is_active, sort_order) values (${productId}, ${categoryId}, 'P', ${slug}, true, 1)`.execute(
    ctx.db,
  );
  await sql`
    insert into product_variant (id, product_id, sku, name_vi, price_vnd, duration_code, delivery_type, stock_policy, resale_evidence_id)
    values (${variantId}, ${productId}, ${"SKU-" + variantId}, 'V', 100000, 'P1M', 'CREDENTIAL', 'LOCAL_ONLY', 'RES-1')
  `.execute(ctx.db);
  await sql`
    insert into "order" (id, order_number, customer_id, variant_id, product_name_vi, variant_name_vi,
      price_vnd, duration_code, delivery_type, status, paid_at)
    values (${orderId}, ${"ORD-" + orderId}, ${customerId}, ${variantId}, 'P', 'V',
      100000, 'P1M', 'CREDENTIAL', 'COMPLETED', now())
  `.execute(ctx.db);
  return { customerId, orderId };
}

beforeEach(async () => {
  await sql`
    truncate table support_ticket, delivery_bundle, digital_asset, order_transition, "order",
      product_variant, product, category, customer, outbox_event cascade
  `.execute(ctx.db);
});

describe("support ticket (FR-019)", () => {
  it("redacts credential repros while preserving ordinary email, time, and order text", () => {
    const longPlainEmail = "verylongsupportaddresswithmanyletters@example.com";
    const standaloneUnicodeEmail = "用户@例え.テスト";
    const summary = toSafeSummary(
      [
        `Email ${longPlainEmail}, ${standaloneUnicodeEmail}, lúc 8:30, Mã đơn: 1234.`,
        "alice:secret; 用户@example.com:pw; mật\u200Bkhẩu = z; password ＝ z;",
        "password = ,x; password = a,b;",
        "user = u7 pw = x9; login: bob7 mật khẩu: y8; account: acct3 passwd: z6;",
        "password = p1; passcode: p2; pwd = p3; email2@example.com password = p4; email3@example.com:q7.",
      ].join(" "),
    );

    expect(summary).toContain(longPlainEmail);
    expect(summary).toContain(standaloneUnicodeEmail);
    expect(summary).toContain("8:30");
    expect(summary).toContain("Mã đơn: 1234");
    for (const secret of [
      "alice",
      "secret",
      "pw",
      "z",
      ",x",
      "a,b",
      "u7",
      "x9",
      "bob7",
      "y8",
      "acct3",
      "z6",
      "p1",
      "p2",
      "p3",
      "p4",
      "q7",
    ]) {
      expect(summary).not.toContain(secret);
    }
  });
  it("SUP-RED-REVIEW-001..005 redact quoted, spaced, fullwidth, and multiline credentials", () => {
    const jsonPassword = ["json", "fixture", "value"].join(" ");
    const jsonUser = ["json", "fixture", "name"].join(" ");
    const jsonPasswordLabel = ["pass", "word"].join("");
    const jsonDescription = JSON.stringify({ [jsonPasswordLabel]: jsonPassword, user: jsonUser });
    const summary = toSafeSummary(
      [
        jsonDescription,
        "password: multi word fixture passphrase; keep this support sentence",
        "alice: generic fixture secret; support context after generic",
        "alice : spaced fixture secret; Contact helpdesk@example.com for support.",
        "ｐａｓｓｗｏｒｄ：fullwidth fixture secret; keep fullwidth context",
        "p\uFE0F\u200Dassword\u2060: invisible fixture phrase\nKeep line context",
        "Mã:1234; Mã đơn:ORD-20261022-1234567890abcdef; time:8:30:00",
      ].join("\n"),
    );

    for (const secret of [
      jsonPassword,
      jsonUser,
      "multi word fixture passphrase",
      "alice",
      "generic fixture secret",
      "spaced fixture secret",
      "fullwidth fixture secret",
      "invisible fixture phrase",
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("keep this support sentence");
    expect(summary).toContain("support context after generic");
    expect(summary).toContain("helpdesk@example.com");
    expect(summary).toContain("keep fullwidth context");
    expect(summary).toContain("Keep line context");
    expect(summary).toContain("Mã:1234");
    expect(summary).toContain("Mã đơn:ORD-20261022-1234567890abcdef");
    expect(summary).toContain("time:8:30:00");
  });
  it("SUP-RED-REVIEW-001..005 redact punctuation-separated credential tails", () => {
    const labeledFirst = ["label", "first"].join("-");
    const labeledSecond = ["label", "second"].join("-");
    const labeledThird = ["label", "third"].join("-");
    const labeledFourth = ["label", "fourth"].join("-");
    const passwordLabel = ["pass", "word"].join("");
    const genericLabel = ["ali", "ce"].join("");
    const genericFirst = ["generic", "first"].join("-");
    const genericSecond = ["generic", "second"].join("-");
    const spacedFirst = ["spaced", "first"].join("-");
    const spacedSecond = ["spaced", "second"].join("-");
    const periodLabeledFirst = ["period", "labeled", "first"].join("-");
    const periodLabeledSecond = ["period", "labeled", "second"].join("-");
    const periodGenericFirst = ["period", "generic", "first"].join("-");
    const periodGenericSecond = ["period", "generic", "second"].join("-");
    const mixedOrderSecret = ["mixed", "order", "value"].join("-");
    const mixedTimeSecret = ["mixed", "time", "value"].join("-");
    const summary = toSafeSummary(
      [
        `${passwordLabel}: ${labeledFirst}, ${labeledSecond}; keep labeled context`,
        `${passwordLabel}: ${labeledThird}:${labeledFourth}; keep colon context`,
        `${genericLabel}: ${genericFirst}, ${genericSecond}; keep generic context`,
        `${genericLabel} : ${spacedFirst}:${spacedSecond}; keep spaced context`,
        `${passwordLabel}: ${periodLabeledFirst}. ${periodLabeledSecond}; keep period labeled context`,
        `${genericLabel}: ${periodGenericFirst}. ${periodGenericSecond}; keep period generic context`,
        `${genericLabel}: ${mixedOrderSecret} Mã:1234; keep mixed order context`,
        `${genericLabel}: ${mixedTimeSecret} time:8:30:00; keep mixed time context`,
      ].join("\n"),
    );

    for (const secret of [
      labeledFirst,
      labeledSecond,
      labeledThird,
      labeledFourth,
      genericLabel,
      genericFirst,
      genericSecond,
      spacedFirst,
      spacedSecond,
      periodLabeledFirst,
      periodLabeledSecond,
      periodGenericFirst,
      periodGenericSecond,
      mixedOrderSecret,
      mixedTimeSecret,
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("keep labeled context");
    expect(summary).toContain("keep colon context");
    expect(summary).toContain("keep generic context");
    expect(summary).toContain("keep spaced context");
    expect(summary).toContain("keep period labeled context");
    expect(summary).toContain("keep period generic context");
    expect(summary).toContain("Mã:1234");
    expect(summary).toContain("keep mixed order context");
    expect(summary).toContain("time:8:30:00");
    expect(summary).toContain("keep mixed time context");
  });

  it("SUP-RED-001 removes format controls without splitting credential labels", () => {
    const summary = toSafeSummary(
      [
        ["password", " = ", "part1", "\u200B", "part2"].join(""),
        "password\u2060=\u2060secret",
        "mật\u200Bkhẩu=compact-secret",
        "mật khẩu = spaced-secret",
      ].join("; "),
    );

    for (const secret of ["part1", "part2", "secret", "compact-secret", "spaced-secret"]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).not.toMatch(/\p{Cf}/u);
  });

  it("SUP-RED-002 redacts credential-only email forms without a domain", () => {
    const summary = toSafeSummary("user@:<short-password>");

    expect(summary).not.toContain("user@");
    expect(summary).not.toContain("short-password");
  });

  it("SUP-RED-003 preserves literal private-use sequences with or without email protection", () => {
    const placeholder = "\uE0000\uE001";
    const ordinaryEmail = "verylongsupportaddresswithmanyletters@example.com";

    const withoutEmail = toSafeSummary(`Literal ${placeholder}`);
    const withEmail = toSafeSummary(`Literal ${placeholder} ${ordinaryEmail}`);

    expect(withoutEmail).toContain(placeholder);
    expect(withEmail).toContain(placeholder);
    expect(withEmail).toContain(ordinaryEmail);
  });

  it("SUP-RED-004 preserves valid order and time context values", () => {
    const summary = toSafeSummary("Mã đơn:1234; time:8:30");

    expect(summary).toContain("Mã đơn:1234");
    expect(summary).toContain("time:8:30");
  });

  it("SUP-RED-005 redacts punctuation-leading generic password tokens", () => {
    const summary = toSafeSummary("alice:!short");

    expect(summary).not.toContain("alice");
    expect(summary).not.toContain("!short");
  });

  it("SUP-RED-REVIEW-006..009 redact unsafe order and delimiter continuations", () => {
    const secretPass = ["Secret", "Pass"].join("");
    const unsafeOrder = ["leaked-support-token-4d6e", "8a2b9c1f7e0a"].join("");
    const summary = toSafeSummary(
      [
        `Mã đơn: ${unsafeOrder}`,
        "Mã đơn: ORD-20261023-AB12CD34",
        "Mã:1234",
        `password\u0338=${secretPass}`,
        `password\u2028=\u2028${secretPass}`,
        ["password", "=", "\n", secretPass].join(""),
        "password=alpha;BravoSecret",
        "password: value; keep this support sentence",
      ].join("; "),
    );

    for (const secret of [unsafeOrder, secretPass, "alpha", "BravoSecret", "value", "password"]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("Mã đơn: ORD-20261023-AB12CD34");
    expect(summary).toContain("Mã:1234");
    expect(summary).toContain("keep this support sentence");
  });
  it("SUP-RED-REVIEW-010 redacts quoted and multi-word labels with Unicode obfuscation", () => {
    const summary = toSafeSummary(
      [
        '"user name": quoted-label-secret',
        "login\u00a0name = spaced-label-secret",
        "p\uFE0F\u200Dassword\u2060: invisible-label-secret",
        "pass\u0338word = combining-label-secret",
        "Mã đơn:1234",
        "time:8:30",
        "agent: leaked Mã\u00a0đơn\u00a0:\u00a01234; keep order context",
        "agent: leaked time\u00a0:\u00a08:30; keep time context",
        "Keep this support sentence.",
      ].join("; "),
    );

    for (const secret of [
      "quoted-label-secret",
      "spaced-label-secret",
      "invisible-label-secret",
      "combining-label-secret",
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("Mã đơn:1234");
    expect(summary).toContain("time:8:30");
    expect(summary).toContain("Mã đơn : 1234");
    expect(summary).toContain("time : 8:30");
    expect(summary).toContain("keep order context");
    expect(summary).toContain("keep time context");
    expect(summary).toContain("Keep this support sentence.");
  });

  it("SUP-RED-001..005 persist only the safe summary for every credential shape", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const placeholder = "\uE0000\uE001";
    const ordinaryEmail = "verylongsupportaddresswithmanyletters@example.com";
    const description = [
      ["password", " = ", "part1", "\u200B", "part2"].join(""),
      "password\u2060=\u2060secret",
      "user@:<short-password>",
      `literal ${placeholder}`,
      ordinaryEmail,
      "Mã đơn:1234",
      "time:8:30",
      "alice:!short",
    ].join("; ");

    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description,
      correlationId: "sup-red-all",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await sql<{ safe_summary: string }>`
      select safe_summary from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    const summary = row.rows[0]?.safe_summary ?? "";

    for (const secret of [
      "part1",
      "part2",
      "secret",
      "user@",
      "short-password",
      "alice",
      "!short",
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain(placeholder);
    expect(summary).toContain(ordinaryEmail);
    expect(summary).toContain("Mã đơn:1234");
    expect(summary).toContain("time:8:30");
  });
  it("SUP-RED-REVIEW-001..005 persists no credential fragments while retaining safe context", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const jsonPassword = ["json", "fixture", "value"].join(" ");
    const jsonUser = ["json", "fixture", "name"].join(" ");
    const jsonPasswordLabel = ["pass", "word"].join("");
    const jsonDescription = JSON.stringify({ [jsonPasswordLabel]: jsonPassword, user: jsonUser });
    const persistedPasswordLabel = ["pass", "word"].join("");
    const persistedGenericLabel = ["ali", "ce"].join("");
    const persistedLabeledFirst = ["persisted", "first"].join("-");
    const persistedLabeledSecond = ["persisted", "second"].join("-");
    const persistedGenericFirst = ["persisted", "generic", "first"].join("-");
    const persistedGenericSecond = ["persisted", "generic", "second"].join("-");
    const persistedPeriodLabeledFirst = ["persisted", "period", "labeled", "first"].join("-");
    const persistedPeriodLabeledSecond = ["persisted", "period", "labeled", "second"].join("-");
    const persistedPeriodGenericFirst = ["persisted", "period", "generic", "first"].join("-");
    const persistedPeriodGenericSecond = ["persisted", "period", "generic", "second"].join("-");
    const persistedMixedOrderSecret = ["persisted", "mixed", "order"].join("-");
    const persistedMixedTimeSecret = ["persisted", "mixed", "time"].join("-");
    const description = [
      jsonDescription,
      `${persistedPasswordLabel}: ${persistedLabeledFirst}, ${persistedLabeledSecond}; persisted labeled context`,
      `${persistedGenericLabel} : ${persistedGenericFirst}:${persistedGenericSecond}; persisted generic context`,
      `${persistedPasswordLabel}: ${persistedPeriodLabeledFirst}. ${persistedPeriodLabeledSecond}; persisted period labeled context`,
      `${persistedGenericLabel}: ${persistedPeriodGenericFirst}. ${persistedPeriodGenericSecond}; persisted period generic context`,
      `${persistedGenericLabel}: ${persistedMixedOrderSecret} Mã:1234; persisted mixed order context`,
      `${persistedGenericLabel}: ${persistedMixedTimeSecret} time:8:30:00; persisted mixed time context`,
      "password: multi word fixture passphrase; keep this support sentence",
      "alice: generic fixture secret; support context after generic",
      "alice : spaced fixture secret; Contact helpdesk@example.com for support.",
      "ｐａｓｓｗｏｒｄ：fullwidth fixture secret; keep fullwidth context",
      "p\uFE0F\u200Dassword\u2060: invisible fixture phrase",
    ].join("\n");

    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description,
      correlationId: "sup-red-review-all",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await sql<{ safe_summary: string }>`
      select safe_summary from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    const summary = row.rows[0]?.safe_summary ?? "";

    for (const secret of [
      jsonPassword,
      jsonUser,
      persistedLabeledFirst,
      persistedLabeledSecond,
      persistedGenericFirst,
      persistedGenericSecond,
      persistedPeriodLabeledFirst,
      persistedPeriodLabeledSecond,
      persistedPeriodGenericFirst,
      persistedPeriodGenericSecond,
      persistedMixedOrderSecret,
      persistedMixedTimeSecret,
      "multi word fixture passphrase",
      "alice",
      "generic fixture secret",
      "spaced fixture secret",
      "fullwidth fixture secret",
      "invisible fixture phrase",
    ]) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain("keep this support sentence");
    expect(summary).toContain("persisted labeled context");
    expect(summary).toContain("persisted generic context");
    expect(summary).toContain("persisted period labeled context");
    expect(summary).toContain("persisted period generic context");
    expect(summary).toContain("Mã:1234");
    expect(summary).toContain("persisted mixed order context");
    expect(summary).toContain("time:8:30:00");
    expect(summary).toContain("persisted mixed time context");
    expect(summary).toContain("support context after generic");
    expect(summary).toContain("helpdesk@example.com");
    expect(summary).toContain("keep fullwidth context");
  });

  it("SUP-RED-REVIEW-006..009 persist safe summaries through both support paths", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const secretPass = ["Secret", "Pass"].join("");
    const unsafeOrder = ["leaked-support-token-4d6e", "8a2b9c1f7e0a"].join("");
    const description = [
      `Mã đơn: ${unsafeOrder}`,
      "Mã đơn: ORD-20261023-AB12CD34",
      "Mã:1234",
      `password\u0338=${secretPass}`,
      `password\u2028=\u2028${secretPass}`,
      ["password", "=", "\n", secretPass].join(""),
      ["password", "=", "alpha", ";", "BravoSecret"].join(""),
      "password: value; keep this support sentence",
    ].join("; ");

    const assertSafeSummary = (summary: string): void => {
      for (const secret of [unsafeOrder, secretPass, "alpha", "BravoSecret", "value", "password"]) {
        expect(summary).not.toContain(secret);
      }
      expect(summary).toContain("Mã đơn: ORD-20261023-AB12CD34");
      expect(summary).toContain("Mã:1234");
      expect(summary).toContain("keep this support sentence");
    };

    const opened = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      description,
      correlationId: "sup-red-review-006-open",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const draft = await svc.beginDescription({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      correlationId: "sup-red-review-006-begin",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const submitted = await svc.submitDescription({
      customerId,
      ticketId: draft.ticketId,
      description,
      correlationId: "sup-red-review-006-submit",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const rows = await sql<{ id: string; safe_summary: string }>`
      select id, safe_summary
      from support_ticket
      where id in (${opened.ticketId}, ${submitted.ticketId})
      order by id
    `.execute(ctx.db);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) assertSafeSummary(row.safe_summary);
  });
  it("SUP-RED-REVIEW-011 strips control obfuscation from both persisted support paths", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const description = [
      "Benign\u0000 support\u200B prose\u2060 remains.",
      "pass\u0000word = nul-secret",
      "Mã đơn:1234",
      "time:8:30",
    ].join("; ");

    const opened = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      description,
      correlationId: "sup-red-review-011-open",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const draft = await svc.beginDescription({
      customerId,
      orderId,
      reasonCode: "GENERAL_QUESTION",
      correlationId: "sup-red-review-011-begin",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const submitted = await svc.submitDescription({
      customerId,
      ticketId: draft.ticketId,
      description,
      correlationId: "sup-red-review-011-submit",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const rows = await sql<{ id: string; safe_summary: string }>`
      select id, safe_summary
      from support_ticket
      where id in (${opened.ticketId}, ${submitted.ticketId})
      order by id
    `.execute(ctx.db);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.safe_summary).toContain("Benign support prose remains.");
      expect(row.safe_summary).toContain("Mã đơn:1234");
      expect(row.safe_summary).toContain("time:8:30");
      expect(row.safe_summary).not.toContain("nul-secret");
      expect(row.safe_summary).not.toMatch(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/u);
    }
  });

  it("opens a structured ticket linked to the customer's own order", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description: "Tài khoản đăng nhập báo lỗi.",
      correlationId: "sup-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("OPEN");

    const row = await sql<{
      order_id: string | null;
      reason_code: string;
      safe_summary: string;
      due_at: string | null;
    }>`
      select order_id, reason_code, safe_summary, due_at from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.order_id).toBe(orderId);
    expect(row.rows[0]?.reason_code).toBe("ASSET_NOT_WORKING");
    expect(row.rows[0]?.due_at).toBeTruthy();
  });

  it("never stores a raw secret in the safe summary", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const secretish = "user@example.com:SuperSecretPass123";
    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description: `Đây là mật khẩu của tôi ${secretish} xin hãy kiểm tra`,
      correlationId: "sup-2",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await sql<{ safe_summary: string }>`
      select safe_summary from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    // The credential-shaped substring is redacted out of the stored summary.
    expect(row.rows[0]?.safe_summary).not.toContain("SuperSecretPass123");
    const events = await sql<{
      event_type: string;
      payload_redacted: Record<string, unknown>;
    }>`
      select event_type, payload_redacted
      from outbox_event
      where aggregate_id = ${res.ticketId} and event_type = 'TicketOpened'
    `.execute(ctx.db);
    expect(events.rows).toEqual([
      {
        event_type: "TicketOpened",
        payload_redacted: {
          ticketId: res.ticketId,
          customerId,
          orderId,
          reasonCode: "ASSET_NOT_WORKING",
          correlationId: "sup-2",
        },
      },
    ]);
    expect(JSON.stringify(events.rows[0]?.payload_redacted)).not.toContain(secretish);
  });
  it("persists generic short credentials without secrets on openTicket", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const description = "Đăng nhập lỗi: alice:secret, lúc 8:30. Mã đơn: 1234";
    const res = await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "ASSET_NOT_WORKING",
      description,
      correlationId: "sup-2-short-separated",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await sql<{ safe_summary: string }>`
      select safe_summary from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.safe_summary).toContain("8:30");
    expect(row.rows[0]?.safe_summary).toContain("Mã đơn: 1234");
    expect(row.rows[0]?.safe_summary).not.toContain("alice");
    expect(row.rows[0]?.safe_summary).not.toContain("secret");
  });

  it("refuses to link a ticket to another customer's order (ownership)", async () => {
    const { orderId } = await seedCustomerWithOrder();
    const stranger = newId();
    await sql`insert into customer (id, status, locale) values (${stranger}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId: stranger,
      orderId,
      reasonCode: "OTHER",
      description: "not my order",
      correlationId: "sup-3",
    });
    expect(res.ok).toBe(false);
    // A foreign order is indistinguishable from a missing one: no existence oracle.
    if (!res.ok) expect(res.code).toBe("ORDER_NOT_FOUND");
  });

  it("allows an order-less general ticket", async () => {
    const { customerId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const res = await svc.openTicket({
      customerId,
      reasonCode: "GENERAL_QUESTION",
      description: "Cho hỏi cách dùng",
      correlationId: "sup-4",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await sql<{ order_id: string | null }>`
      select order_id from support_ticket where id = ${res.ticketId}
    `.execute(ctx.db);
    expect(row.rows[0]?.order_id).toBeNull();
  });

  it("deduplicates replayed structured opens by stable callback correlation", async () => {
    const { customerId } = await seedCustomerWithOrder();
    const svc = createSupportService(ctx.db);
    const input = {
      customerId,
      reasonCode: "GENERAL_QUESTION",
      description: "GENERAL_QUESTION",
      correlationId: "telegram:stable-message-77",
    };
    const [first, replay] = await Promise.all([svc.openTicket(input), svc.openTicket(input)]);
    expect(replay).toEqual(first);
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from support_ticket where customer_id = ${customerId}
    `.execute(ctx.db);
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(1);
  });

  it("lists only the customer's own tickets", async () => {
    const { customerId, orderId } = await seedCustomerWithOrder();
    const other = newId();
    await sql`insert into customer (id, status, locale) values (${other}, 'ACTIVE', 'vi')`.execute(
      ctx.db,
    );
    const svc = createSupportService(ctx.db);
    await svc.openTicket({
      customerId,
      orderId,
      reasonCode: "OTHER",
      description: "a",
      correlationId: "c1",
    });
    await svc.openTicket({
      customerId: other,
      reasonCode: "OTHER",
      description: "b",
      correlationId: "c2",
    });

    const mine = await svc.listTickets({ customerId });
    expect(mine.every((t) => t.customerId === customerId)).toBe(true);
    expect(mine).toHaveLength(1);
  });
});
