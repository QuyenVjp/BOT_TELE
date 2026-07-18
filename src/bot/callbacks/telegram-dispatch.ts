import type { TelegramUpdate } from "../webhook.js";
import type { PresentedMessage } from "../presenters/catalog.js";
import type { CheckoutCallbacks } from "./checkout.js";
import type { TelegramCommandEnvelope } from "../../infrastructure/inbox/telegram.js";
import type { CallbackTokenCodec, VerifiedCallbackToken } from "../callback-codec.js";
import { sealPresentedMessageCallbacks } from "../callback-sealer.js";
import { SUPPORT_REASON_CODES } from "../../modules/support/domain.js";

export type TelegramBuyNowDispatchResult =
  { handled: false } | { handled: true; callbackQueryId: string; message: PresentedMessage };

/**
 * Narrow Telegram callback dispatcher for the T160 Buy Now slice.
 *
 * Full grammY reply/ack composition remains T129. This seam deliberately owns
 * only routing verified `buy:` callback data plus the numeric Telegram actor
 * into CheckoutCallbacks; no caller-controlled internal customer id crosses it.
 */
export async function dispatchTelegramBuyNow(
  update: TelegramUpdate,
  checkout: CheckoutCallbacks,
): Promise<TelegramBuyNowDispatchResult> {
  const query = update.callback_query;
  const callbackData = query?.data;
  const telegramUserId = query?.from?.id;
  if (
    !query ||
    typeof callbackData !== "string" ||
    !callbackData.startsWith("buy:") ||
    telegramUserId === undefined
  ) {
    return { handled: false };
  }
  const message = await checkout.buyNowFromCallback({
    callbackData,
    telegramUserId,
    correlationId: `telegram-update:${update.update_id}`,
  });
  return { handled: true, callbackQueryId: query.id, message };
}

interface OrderRef {
  id: string;
  orderNumber: string;
  customerId: string;
  createdAt: string;
}

export interface TelegramDomainDispatcherDeps {
  codec: CallbackTokenCodec;
  resolveCustomerId(telegramUserId: string): Promise<string | null>;
  resolveOrderById(orderId: string): Promise<OrderRef | null>;
  resolveOrderIdByNumber(orderNumber: string): Promise<string | null>;
  resolveCatalogPage(
    cursorVariantId: string,
  ): Promise<{ categoryId: string; cursor: string } | null>;
  catalog: {
    mainMenu(): Promise<PresentedMessage>;
    categoryList(): Promise<PresentedMessage>;
    categoryView(categoryId: string, cursor?: string): Promise<PresentedMessage>;
    variantDetail(
      variantId: string,
      telegramUserId: string | bigint | number,
    ): Promise<PresentedMessage>;
    search(rawQuery: string): Promise<PresentedMessage>;
  };
  checkout: Pick<CheckoutCallbacks, "buyNowFromCallback" | "refresh" | "reopen" | "cancel">;
  history: {
    list(customerId: string, cursor?: string | null): Promise<PresentedMessage>;
    detail(orderNumber: string, customerId: string): Promise<PresentedMessage>;
  };
  support: {
    reasonMenu(orderNumber?: string): PresentedMessage;
    open(input: {
      customerId: string;
      reasonCode: string;
      orderNumber?: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    list(customerId: string): Promise<PresentedMessage>;
  };
  admin?: {
    handleToken(input: {
      targetId: string;
      option: number;
      telegramUserId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
  };
  responder: {
    send(input: {
      chatId: string;
      messageId: string | null;
      callbackQueryId?: string;
      message: PresentedMessage;
    }): Promise<void>;
  };
}

export interface TelegramDomainDispatcher {
  handle(envelope: TelegramCommandEnvelope): Promise<void>;
}

export function createTelegramDomainDispatcher(
  deps: TelegramDomainDispatcherDeps,
): TelegramDomainDispatcher {
  return {
    async handle(envelope) {
      if (envelope.chatType !== "private") return;
      const correlationId = `telegram:${envelope.messageId ?? envelope.actorUserId}`;
      let message: PresentedMessage;

      if (envelope.callbackData?.startsWith("buy:")) {
        message = await deps.checkout.buyNowFromCallback({
          callbackData: envelope.callbackData,
          telegramUserId: envelope.actorUserId,
          correlationId,
        });
      } else if (envelope.callbackData) {
        const verified = deps.codec.verify(envelope.callbackData, {
          telegramUserId: envelope.actorUserId,
        });
        if (!verified.ok) {
          message = safeError(
            verified.code === "EXPIRED"
              ? "Nút này đã hết hạn. Vui lòng mở lại menu."
              : "Yêu cầu không hợp lệ. Vui lòng mở lại menu.",
          );
        } else {
          message = await dispatchVerified(deps, envelope, verified.value, correlationId);
        }
      } else if (envelope.command === "/start" || envelope.command === "/catalog") {
        message = await deps.catalog.mainMenu();
      } else if (envelope.command === "/search") {
        message = envelope.searchQuery
          ? await deps.catalog.search(envelope.searchQuery)
          : {
              text: "Dùng /search kèm tên sản phẩm, ví dụ: /search Netflix.",
              buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
            };
      } else if (envelope.command === "/support") {
        message = deps.support.reasonMenu();
      } else {
        message = await deps.catalog.mainMenu();
      }

      const sealed = await sealPresentedMessageCallbacks(message, {
        codec: deps.codec,
        telegramUserId: envelope.actorUserId,
        resolveOrderId: deps.resolveOrderIdByNumber,
      });
      await deps.responder.send({
        chatId: envelope.chatId,
        messageId: envelope.messageId,
        ...(envelope.callbackQueryId ? { callbackQueryId: envelope.callbackQueryId } : {}),
        message: sealed,
      });
    },
  };
}

async function dispatchVerified(
  deps: TelegramDomainDispatcherDeps,
  envelope: TelegramCommandEnvelope,
  token: VerifiedCallbackToken,
  correlationId: string,
): Promise<PresentedMessage> {
  const customerId = await deps.resolveCustomerId(envelope.actorUserId);
  if (!customerId) return safeError("Không tìm thấy tài khoản khách hàng.");
  switch (token.action) {
    case "SEARCH_PROMPT":
      return {
        text: "Gửi tên sản phẩm bạn muốn tìm (không gửi mật khẩu hoặc thông tin đăng nhập).",
        buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]],
      };
    case "MAIN_MENU":
      return deps.catalog.mainMenu();
    case "CATEGORY_LIST":
      return deps.catalog.categoryList();
    case "CATEGORY_VIEW":
      return deps.catalog.categoryView(token.resourceId!);
    case "VARIANT_VIEW":
      return deps.catalog.variantDetail(token.resourceId!, envelope.actorUserId);
    case "CATALOG_PAGE": {
      const page = await deps.resolveCatalogPage(token.secondaryResourceId ?? token.resourceId!);
      return page
        ? deps.catalog.categoryView(
            token.secondaryResourceId ? token.resourceId! : page.categoryId,
            page.cursor,
          )
        : safeError("Trang sản phẩm không còn khả dụng.");
    }
    case "ORDER_LIST":
      return deps.history.list(customerId);
    case "ORDER_LIST_PAGE": {
      const order = await ownedOrder(deps, token.resourceId!, customerId);
      return order
        ? deps.history.list(customerId, encodeHistoryCursor(order))
        : safeError("Không tìm thấy đơn hàng.");
    }
    case "ORDER_VIEW": {
      const order = await ownedOrder(deps, token.resourceId!, customerId);
      return order
        ? deps.history.detail(order.orderNumber, customerId)
        : safeError("Không tìm thấy đơn hàng.");
    }
    case "PAYMENT_REFRESH":
    case "PAYMENT_REOPEN":
    case "PAYMENT_CANCEL": {
      const order = await ownedOrder(deps, token.resourceId!, customerId);
      if (!order) return safeError("Không tìm thấy đơn hàng.");
      if (token.action === "PAYMENT_REFRESH") {
        return deps.checkout.refresh(order.orderNumber, customerId);
      }
      if (token.action === "PAYMENT_REOPEN") {
        return deps.checkout.reopen(order.orderNumber, customerId);
      }
      return deps.checkout.cancel(order.orderNumber, customerId, correlationId);
    }
    case "SUPPORT_MENU": {
      if (!token.resourceId) return deps.support.reasonMenu();
      const order = await ownedOrder(deps, token.resourceId, customerId);
      return order
        ? deps.support.reasonMenu(order.orderNumber)
        : safeError("Không tìm thấy đơn hàng.");
    }
    case "SUPPORT_REASON": {
      const reasonCode = SUPPORT_REASON_CODES[token.option ?? -1];
      if (!reasonCode) return safeError("Lý do hỗ trợ không hợp lệ.");
      const order = token.resourceId ? await ownedOrder(deps, token.resourceId, customerId) : null;
      if (token.resourceId && !order) return safeError("Không tìm thấy đơn hàng.");
      return deps.support.open({
        customerId,
        reasonCode,
        ...(order ? { orderNumber: order.orderNumber } : {}),
        correlationId,
      });
    }
    case "SUPPORT_TICKET_VIEW":
      return deps.support.list(customerId);
    case "ADMIN_COMMAND":
      return deps.admin
        ? deps.admin.handleToken({
            targetId: token.resourceId!,
            option: token.option!,
            telegramUserId: envelope.actorUserId,
            correlationId,
          })
        : safeError("Lệnh quản trị không khả dụng.");
  }
}

async function ownedOrder(
  deps: TelegramDomainDispatcherDeps,
  orderId: string,
  customerId: string,
): Promise<OrderRef | null> {
  const order = await deps.resolveOrderById(orderId);
  return order?.customerId === customerId ? order : null;
}

function encodeHistoryCursor(order: OrderRef): string {
  return Buffer.from(`${order.createdAt}|${order.id}`, "utf8").toString("base64url");
}

function safeError(text: string): PresentedMessage {
  return { text, buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
}
