import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import type { PresentedMessage } from "../../bot/presenters/catalog.js";
import { presentGroupProductCard, presentGroupQAResponse } from "../../bot/presenters/group.js";
import type { InlineQueryResultArticle } from "../../bot/grammy-responder.js";
import { issueProductLinkToken } from "./product-link-token.js";

export interface GroupCommerceSettingsRow {
  id: string;
  group_chat_id: string;
  group_reply_mode: "MENTION_ONLY" | "PASSIVE_COMMERCE";
  shop_panel_enabled: boolean;
  shop_panel_message_id: string | null;
  shop_panel_version: number;
  welcome_enabled: boolean;
  welcome_cooldown_seconds: number;
  last_welcome_at: Date | null;
  restock_publishing_enabled: boolean;
  last_restock_published_at: Date | null;
  social_proof_mode: "OFF" | "INDIVIDUAL" | "DIGEST";
  social_proof_min_interval_seconds: number;
  last_social_proof_at: Date | null;
  shop_topic_id: string | null;
  restock_topic_id: string | null;
  support_topic_id: string | null;
  announcement_topic_id: string | null;
  updated_at: Date;
  updated_by: string | null;
}

export async function getGroupCommerceSettings(exec: Executor): Promise<GroupCommerceSettingsRow> {
  const result = await sql<GroupCommerceSettingsRow>`
    select * from group_commerce_settings where id = 'main' limit 1
  `.execute(exec);
  if (result.rows[0]) return result.rows[0];

  await sql`
    insert into group_commerce_settings (id) values ('main')
    on conflict (id) do nothing
  `.execute(exec);

  const fresh = await sql<GroupCommerceSettingsRow>`
    select * from group_commerce_settings where id = 'main' limit 1
  `.execute(exec);
  return fresh.rows[0]!;
}

export async function updateGroupCommerceSettings(
  exec: Executor,
  patch: Partial<GroupCommerceSettingsRow> & { updated_by?: string },
): Promise<void> {
  const current = await getGroupCommerceSettings(exec);
  await sql`
    update group_commerce_settings
    set
      group_chat_id = ${patch.group_chat_id ?? current.group_chat_id},
      group_reply_mode = ${patch.group_reply_mode ?? current.group_reply_mode},
      shop_panel_enabled = ${patch.shop_panel_enabled ?? current.shop_panel_enabled},
      shop_panel_message_id = ${patch.shop_panel_message_id !== undefined ? patch.shop_panel_message_id : current.shop_panel_message_id},
      shop_panel_version = ${patch.shop_panel_version ?? current.shop_panel_version},
      welcome_enabled = ${patch.welcome_enabled ?? current.welcome_enabled},
      welcome_cooldown_seconds = ${patch.welcome_cooldown_seconds ?? current.welcome_cooldown_seconds},
      restock_publishing_enabled = ${patch.restock_publishing_enabled ?? current.restock_publishing_enabled},
      social_proof_mode = ${patch.social_proof_mode ?? current.social_proof_mode},
      shop_topic_id = ${patch.shop_topic_id !== undefined ? patch.shop_topic_id : current.shop_topic_id},
      restock_topic_id = ${patch.restock_topic_id !== undefined ? patch.restock_topic_id : current.restock_topic_id},
      support_topic_id = ${patch.support_topic_id !== undefined ? patch.support_topic_id : current.support_topic_id},
      announcement_topic_id = ${patch.announcement_topic_id !== undefined ? patch.announcement_topic_id : current.announcement_topic_id},
      updated_at = now(),
      updated_by = ${patch.updated_by ?? null}
    where id = 'main'
  `.execute(exec);
}

export interface GroupProductSearchRow {
  id: string;
  name_vi: string;
  slug: string;
  short_description_vi: string | null;
  warranty_vi: string | null;
  min_price: string;
  total_available: number;
}

export async function searchPublicGroupProducts(
  exec: Executor,
  query: string,
  limit = 5,
): Promise<GroupProductSearchRow[]> {
  const normalized = query.normalize("NFC").trim().toLowerCase();
  const pattern = `%${normalized}%`;

  const result = await sql<GroupProductSearchRow>`
    select
      p.id,
      p.name_vi,
      p.slug,
      p.short_description_vi,
      p.warranty_vi,
      coalesce(min(v.price_vnd)::text, '0') as min_price,
      coalesce(sum(case when da.status = 'AVAILABLE' then 1 else 0 end)::int, 0) as total_available
    from product p
    join category c on c.id = p.category_id
    join product_variant v on v.product_id = p.id
    left join digital_asset da on da.variant_id = v.id
    where p.is_active = true
      and p.is_test = false
      and p.is_archived = false
      and c.is_active = true
      and v.is_active = true
      and (
        ${normalized.length === 0}
        or lower(p.name_vi) like ${pattern}
        or lower(p.slug) like ${pattern}
        or lower(c.name_vi) like ${pattern}
      )
    group by p.id, p.name_vi, p.slug, p.short_description_vi, p.warranty_vi, p.featured_rank, p.sort_order
    order by p.featured_rank desc, p.sort_order asc, p.name_vi asc
    limit ${limit}
  `.execute(exec);

  return result.rows;
}

export async function buildInlineQueryResults(
  exec: Executor,
  input: {
    query: string;
    botUsername: string;
    linkSecret: string;
    isRootOrTester?: boolean;
  },
): Promise<InlineQueryResultArticle[]> {
  const products = await searchPublicGroupProducts(exec, input.query, 8);
  const results: InlineQueryResultArticle[] = [];

  for (const prod of products) {
    const isOos = prod.total_available <= 0;
    const stockLabel = isOos ? "Hết hàng" : `Còn hàng (${prod.total_available})`;
    const priceFormatted = Number(prod.min_price).toLocaleString("vi-VN") + " ₫";
    const token = issueProductLinkToken(prod.id, { secret: input.linkSecret });

    const card = presentGroupProductCard({
      name: prod.name_vi,
      shortDescription: prod.short_description_vi,
      priceVnd: Number(prod.min_price),
      isOutOfStock: isOos,
      stockLabel,
      deliveryTypeLabel: "Tự động 24/7",
      warrantyText: prod.warranty_vi,
      productToken: token,
      botUsername: input.botUsername,
    });

    results.push({
      type: "article",
      id: `prod_${prod.id}`,
      title: `${prod.name_vi} — từ ${priceFormatted}`,
      description: `💰 ${priceFormatted} | ${isOos ? "🔴 Hết hàng" : "🟢 Còn hàng"} | ⚡ Giao tự động`,
      input_message_content: {
        message_text: card.text,
        parse_mode: "Markdown",
      },
      reply_markup: {
        inline_keyboard: card.buttons.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            ...(btn.url ? { url: btn.url } : {}),
            ...(btn.callbackData ? { callback_data: btn.callbackData } : {}),
          })),
        ),
      },
    });
  }

  return results;
}

export async function parseNaturalSalesQA(
  exec: Executor,
  input: {
    question: string;
    botUsername: string;
    linkSecret: string;
    replyToText?: string | null;
  },
): Promise<PresentedMessage | null> {
  const text = input.question.toLowerCase().normalize("NFC");
  const replyText = (input.replyToText ?? "").toLowerCase().normalize("NFC");

  // Determine candidate products to check
  let candidates: GroupProductSearchRow[] = [];

  // 1. Check if user is replying to a product card
  if (replyText.length > 0) {
    for (const kw of [
      "claude",
      "chatgpt",
      "gpt",
      "cursor",
      "kiro",
      "vpn",
      "expressvpn",
      "hma",
      "canva",
      "gemini",
    ]) {
      if (replyText.includes(kw)) {
        candidates = await searchPublicGroupProducts(exec, kw, 1);
        if (candidates.length > 0) break;
      }
    }
  }

  // 2. If not replying or no candidate found from reply, search by keywords in question
  if (candidates.length === 0) {
    for (const kw of [
      "claude",
      "chatgpt",
      "gpt",
      "cursor",
      "kiro",
      "expressvpn",
      "hma",
      "vpn",
      "canva",
      "gemini",
    ]) {
      if (text.includes(kw)) {
        const queryTerm = kw === "gpt" ? "chatgpt" : kw;
        candidates = await searchPublicGroupProducts(exec, queryTerm, 1);
        if (candidates.length > 0) break;
      }
    }
  }

  // If no specific product matched, check for general commerce FAQ intents
  if (candidates.length === 0) {
    if (text.includes("bảo hành") || text.includes("bao lau") || text.includes("chính sách")) {
      return presentGroupQAResponse({
        answer:
          "Toàn bộ tài khoản và phần mềm tại TIER20 SHOP được bảo hành 1 đổi 1 trong suốt thời gian sử dụng gói đăng ký. Hỗ trợ kỹ thuật 24/7 qua Admin.",
        botUsername: input.botUsername,
      });
    }
    if (text.includes("thanh toán") || text.includes("vietqr") || text.includes("chuyển khoản")) {
      return presentGroupQAResponse({
        answer:
          "TIER20 SHOP hỗ trợ thanh toán VietQR tự động qua mọi ngân hàng tại Việt Nam, quét mã nhận diện giao dịch và giao hàng tức thì trong vài giây.",
        botUsername: input.botUsername,
      });
    }
    if (text.includes("giao hàng") || text.includes("nhận hàng") || text.includes("bao lâu")) {
      return presentGroupQAResponse({
        answer:
          "Hệ thống giao hàng hoàn toàn tự động 24/7 ngay sau khi thanh toán thành công. Thông tin tài khoản được gửi riêng tư qua bot chat.",
        botUsername: input.botUsername,
      });
    }
    // Generic fallback: provide shop link
    return presentGroupQAResponse({
      answer:
        "Bạn cần hỗ trợ về sản phẩm nào? Bấm nút bên dưới để mở danh mục sản phẩm của TIER20 SHOP:",
      botUsername: input.botUsername,
    });
  }

  const prod = candidates[0]!;
  const priceFormatted = Number(prod.min_price).toLocaleString("vi-VN") + " ₫";
  const isOos = prod.total_available <= 0;
  const token = issueProductLinkToken(prod.id, { secret: input.linkSecret });

  let answerText = "";
  if (text.includes("giá") || text.includes("bao nhiêu") || text.includes("nhiêu")) {
    answerText = `${prod.name_vi} hiện có giá từ ${priceFormatted}.${isOos ? " (Hiện tạm hết hàng)." : " (Đang có sẵn hàng giao ngay)."}`;
  } else if (text.includes("còn") || text.includes("hết") || text.includes("stock")) {
    answerText = isOos
      ? `Dạ hiện tại ${prod.name_vi} đang tạm hết hàng. Bạn có thể bấm nút bên dưới để nhận thông báo ngay khi có đợt mới.`
      : `Dạ ${prod.name_vi} hiện đang CÒN HÀNG (sẵn sàng giao ngay), giá từ ${priceFormatted}.`;
  } else if (text.includes("bảo hành") || text.includes("bh")) {
    answerText = `${prod.name_vi}: ${prod.warranty_vi ?? "Bảo hành 1 đổi 1 trọn thời gian sử dụng."} Giá từ ${priceFormatted}.`;
  } else {
    answerText = `${prod.name_vi}: Giá từ ${priceFormatted}, tình trạng ${isOos ? "Tạm hết hàng" : "Còn hàng"}. Giao tự động 24/7.`;
  }

  return presentGroupQAResponse({
    answer: answerText,
    productToken: token,
    botUsername: input.botUsername,
  });
}
