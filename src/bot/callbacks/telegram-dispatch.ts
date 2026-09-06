import {
  presentAdminInventoryMenu,
  presentAdminMarketingMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductsMenu,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
} from "../presenters/admin.js";
import { presentCustomerAccountPrompt, presentCustomerHome, CUSTOMER_COPY } from "../presenters/customer.js";
import { presentShopLaunch } from "../presenters/customer.js";
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
  walletAccount?(ctx: TelegramActionContext): Promise<PresentedMessage>;
  walletTopup?(ctx: TelegramActionContext): Promise<PresentedMessage>;
  walletPay?(ctx: TelegramActionContext, orderNumber: string): Promise<PresentedMessage>;
  notification?: {
    settings(customerId: string): Promise<PresentedMessage>;
    toggle(customerId: string, kind: "shop" | "activity"): Promise<PresentedMessage>;
    subscriptions(customerId: string): Promise<PresentedMessage>;
  };
  restock?: {
    subscribe(customerId: string, variantId: string): Promise<PresentedMessage>;
    unsubscribe(customerId: string, variantId: string): Promise<PresentedMessage>;
    list(customerId: string): Promise<PresentedMessage>;
  };
  shopUrl?: string;
  admin?: {
    handleToken(input: {
      targetId: string;
      option: number;
      telegramUserId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    mainMenu?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    dashboard?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    products?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    productDetail?(input: {
      telegramUserId: string;
      productId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    inventory?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importPreview?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importConfirm?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importCancel?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    confirm?(input: {
      telegramUserId: string;
      chatType: string;
      confirmationId: string;
      challenge: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    presentAdminCustomerDetail?(ctx: TelegramActionContext, customerId: string): Promise<PresentedMessage>;
    sendAdminCustomerMessage?(ctx: TelegramActionContext, input: { customerId: string; text: string }): Promise<PresentedMessage>;
    marketing?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    broadcastCompose?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    broadcastAudience?(input: {
      telegramUserId: string;
      chatType: string;
      audience: "all" | "shop" | "activity" | "root";
      correlationId: string;
    }): Promise<PresentedMessage>;
    broadcastConfirm?(input: {
      telegramUserId: string;
      chatType: string;
      campaignId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    broadcastCancel?(input: {
      telegramUserId: string;
      chatType: string;
      campaignId?: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    broadcastText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    broadcastStatus?(input: {
      telegramUserId: string;
      chatType: string;
      campaignId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    workflow?: {
      messageText(input: {
        telegramUserId: string;
        text: string;
        chatType: string;
        correlationId: string;
      }): Promise<PresentedMessage | null>;
      start(input: {
        telegramUserId: string;
        chatType: string;
        correlationId: string;
      }): Promise<PresentedMessage>;
      category?(input: {
        telegramUserId: string;
        categoryId: string;
        chatType: string;
        correlationId: string;
      }): Promise<PresentedMessage>;
      confirm?(input: {
        telegramUserId: string;
        chatType: string;
        correlationId: string;
      }): Promise<PresentedMessage>;
      cancel(input: {
        telegramUserId: string;
        chatType: string;
        correlationId: string;
      }): Promise<PresentedMessage>;
    };
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

export interface TelegramActionContext {
  telegramUserId: string;
  chatId: string;
  chatType: string;
  messageId: string | null;
  correlationId: string;
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
      const command = normalizeTelegramCommand(envelope.command);
      let message: PresentedMessage;
      const ctx = actionContext(envelope, correlationId);

      if (envelope.callbackData?.startsWith("buy:")) {
        message = await deps.checkout.buyNowFromCallback({
          callbackData: envelope.callbackData,
          telegramUserId: envelope.actorUserId,
          correlationId,
        });
      } else if (envelope.callbackData?.startsWith("admin:")) {
        const route = envelope.callbackData.slice("admin:".length);
        const admin = deps.admin;
        if (!admin) message = safeError("Lệnh quản trị không khả dụng.");
        else if (route === "menu") {
          message = admin.mainMenu
            ? await admin.mainMenu({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminMenu();
        } else if (route === "dashboard") {
          message = admin.dashboard
            ? await admin.dashboard({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Dashboard không khả dụng.");
        } else if (route === "products") {
          message = admin.products
            ? await admin.products({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminProductsMenu();
        } else if (route.startsWith("products:category:")) {
          message = admin.workflow?.category
            ? await admin.workflow.category({
                telegramUserId: envelope.actorUserId,
                categoryId: route.slice("products:category:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Danh mục không khả dụng.");
        } else if (route === "products:category") {
          message = admin.workflow?.category
            ? await admin.workflow.category({
                telegramUserId: envelope.actorUserId,
                categoryId: "",
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Danh mục không khả dụng.");
        } else if (route === "products:confirm") {
          message = admin.workflow?.confirm
            ? await admin.workflow.confirm({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Xác nhận sản phẩm không khả dụng.");
        } else if (route === "products:cancel") {
          message = admin.workflow
            ? await admin.workflow.cancel({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminMenu();
        } else if (route.startsWith("products:detail:")) {
          message = admin.productDetail
            ? await admin.productDetail({
                telegramUserId: envelope.actorUserId,
                productId: route.slice("products:detail:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Sản phẩm không khả dụng.");
        } else if (route === "inventory") {
          message = admin.inventory
            ? await admin.inventory({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminInventoryMenu();
        } else if (route === "inventory:import") {
          message = admin.importPreview
            ? await admin.importPreview({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Nhập kho không khả dụng.");
        } else if (route === "inventory:confirm") {
          message = admin.importConfirm
            ? await admin.importConfirm({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Xác nhận nhập kho không khả dụng.");
        } else if (route === "inventory:cancel") {
          message = admin.importCancel
            ? await admin.importCancel({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminMenu();
        } else if (route === "marketing") {
          message = admin.marketing
            ? await admin.marketing({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, correlationId })
            : presentAdminMarketingMenu();
        } else if (route === "marketing:compose") {
          message = admin.broadcastCompose
            ? await admin.broadcastCompose({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, correlationId })
            : safeError("Soạn thông báo không khả dụng.");
        } else if (route.startsWith("marketing:audience:")) {
          const audience = route.slice("marketing:audience:".length);
          message = (audience === "all" || audience === "shop" || audience === "activity" || audience === "root") && admin.broadcastAudience
            ? await admin.broadcastAudience({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, audience, correlationId })
            : safeError("Nhóm nhận không hợp lệ.");
        } else if (route.startsWith("marketing:confirm:")) {
          message = admin.broadcastConfirm
            ? await admin.broadcastConfirm({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, campaignId: route.slice("marketing:confirm:".length), correlationId })
            : safeError("Xác nhận thông báo không khả dụng.");
        } else if (route.startsWith("marketing:cancel:")) {
          message = admin.broadcastCancel
            ? await admin.broadcastCancel({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, campaignId: route.slice("marketing:cancel:".length), correlationId })
            : presentAdminMarketingMenu();
        } else if (route === "marketing:cancel") {
          message = admin.broadcastCancel
            ? await admin.broadcastCancel({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, correlationId })
            : presentAdminMarketingMenu();
        } else if (route.startsWith("marketing:status:")) {
          message = admin.broadcastStatus
            ? await admin.broadcastStatus({ telegramUserId: envelope.actorUserId, chatType: envelope.chatType, campaignId: route.slice("marketing:status:".length), correlationId })
            : safeError("Trạng thái thông báo không khả dụng.");
        } else if (route === "orders") {
          message = presentAdminOrdersMenu();
        } else if (route === "payments") {
          message = presentAdminPaymentsMenu();
        } else if (route === "suppliers") {
          message = presentAdminSuppliersMenu();
        } else if (route === "support") {
          message = presentAdminSupportMenu();
        } else {
          message = safeError("Lệnh quản trị không khả dụng.");
        }
      } else if (command === "/admin") {
        message = deps.admin?.mainMenu
          ? await deps.admin.mainMenu({
              telegramUserId: envelope.actorUserId,
              chatType: envelope.chatType,
              correlationId,
            })
          : deps.admin
            ? presentAdminMenu()
            : safeError("Lệnh quản trị không khả dụng.");
      } else if (command === "/confirm") {
        const parsed = parseAdminConfirm(envelope.searchQuery);
        message = parsed && deps.admin?.confirm
          ? await deps.admin.confirm({
              telegramUserId: envelope.actorUserId,
              chatType: envelope.chatType,
              confirmationId: parsed.confirmationId,
              challenge: parsed.challenge,
              correlationId,
            })
          : safeError("Dùng /confirm <confirmationId> <mã xác nhận>.");
      } else if (command === "/cancel" && deps.admin?.workflow) {
        message = await deps.admin.workflow.cancel({
          telegramUserId: envelope.actorUserId,
          chatType: envelope.chatType,
          correlationId,
        });
      } else if (command === "/customer") {
        const customerId = envelope.searchQuery;
        message = customerId && deps.admin?.presentAdminCustomerDetail
          ? await deps.admin.presentAdminCustomerDetail(ctx, customerId)
          : safeError("Dùng /customer kèm mã khách hàng.");
      } else if (command === "/message_customer") {
        const parsed = parseAdminMessageCustomer(envelope.searchQuery);
        message = parsed && deps.admin?.sendAdminCustomerMessage
          ? await deps.admin.sendAdminCustomerMessage(ctx, parsed)
          : safeError("Dùng /message_customer <customerId> <nội dung>.");
      } else if (command === "/start") {
        message = presentCustomerHome();
      } else if (command === "/catalog") {
        message = await deps.catalog.mainMenu();
      } else if (command === "/account" || envelope.callbackData === "wallet:account") {
        message = deps.walletAccount ? await deps.walletAccount(ctx) : presentCustomerAccountPrompt();
      } else if (command === "/topup" || envelope.callbackData === "wallet:topup" || envelope.messageText === CUSTOMER_COPY.topup) {
        message = deps.walletTopup ? await deps.walletTopup(ctx) : safeError("Nạp ví không khả dụng.");
      } else if (command === "/pay") {
        message = deps.walletPay && envelope.searchQuery ? await deps.walletPay(ctx, envelope.searchQuery) : safeError("Dùng /pay kèm mã đơn hàng.");
      } else if (command === "/search") {
        message = envelope.searchQuery
          ? await deps.catalog.search(envelope.searchQuery)
          : safeError("Dùng /search kèm tên sản phẩm.");
      } else if (command === "/support") {
        message = deps.support.reasonMenu();
      } else if (envelope.messageText === "🔔 Báo có hàng") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId && deps.notification ? await deps.notification.subscriptions(customerId) : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === "🔔 Cài đặt thông báo") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId && deps.notification ? await deps.notification.settings(customerId) : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === "🛍 Tắt cập nhật sản phẩm") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId && deps.notification ? await deps.notification.toggle(customerId, "shop") : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === "📣 Tắt hoạt động mua hàng") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId && deps.notification ? await deps.notification.toggle(customerId, "activity") : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === CUSTOMER_COPY.openShop || envelope.messageText === "🌐 Mở cửa hàng") {
        message = presentShopLaunch(deps.shopUrl ?? "");
      } else if (envelope.messageText === CUSTOMER_COPY.browse || envelope.messageText === "🛒 Mua hàng") {
        message = await deps.catalog.mainMenu();
      } else if (envelope.messageText === CUSTOMER_COPY.account || envelope.messageText === "👤 Tài khoản") {
        message = deps.walletAccount ? await deps.walletAccount(ctx) : presentCustomerAccountPrompt();
      } else if (envelope.messageText === CUSTOMER_COPY.back || envelope.messageText === "↩️ Quay lại") {
        message = presentCustomerHome();
      } else if (envelope.messageText === CUSTOMER_COPY.orders || envelope.messageText === "🧾 Đơn hàng") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId ? await deps.history.list(customerId) : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === CUSTOMER_COPY.support || envelope.messageText === "🛟 Hỗ trợ") {
        message = deps.support.reasonMenu();
      } else if (envelope.contactPhoneNumber) {
        message = presentCustomerAccountPrompt();
      } else if (envelope.messageText && (deps.admin?.broadcastText || deps.admin?.importText || deps.admin?.workflow)) {
        message =
          (deps.admin.broadcastText
            ? await deps.admin.broadcastText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
          (deps.admin.importText
            ? await deps.admin.importText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
          (deps.admin.workflow
            ? await deps.admin.workflow.messageText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
          (await deps.catalog.mainMenu());
      } else if (envelope.callbackData) {
        const verified = deps.codec.verify(envelope.callbackData, {
          telegramUserId: envelope.actorUserId,
        });
        message = verified.ok
          ? await dispatchVerified(deps, envelope, verified.value, correlationId)
          : safeError("Yêu cầu không hợp lệ. Vui lòng mở lại menu.");
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

function normalizeTelegramCommand(command?: string): string | undefined {
  return command?.trim().toLowerCase();
}

function actionContext(envelope: TelegramCommandEnvelope, correlationId: string): TelegramActionContext {
  return {
    telegramUserId: envelope.actorUserId,
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    messageId: envelope.messageId,
    correlationId,
  };
}

function parseAdminConfirm(input?: string | null): { confirmationId: string; challenge: string } | null {
  const match = input?.trim().match(/^(\S+)\s+(\S+)$/u);
  if (!match) return null;
  return { confirmationId: match[1]!, challenge: match[2]! };
}

function parseAdminMessageCustomer(input?: string | null): { customerId: string; text: string } | null {
  const match = input?.match(/^(\S+)\s+([\s\S]{1,1000})$/u);
  if (!match) return null;
  const text = match[2]!.trim();
  return text ? { customerId: match[1]!, text } : null;
}

async function dispatchVerified(
  deps: TelegramDomainDispatcherDeps,
  envelope: TelegramCommandEnvelope,
  token: VerifiedCallbackToken,
  correlationId: string,
): Promise<PresentedMessage> {
  const customerId = await deps.resolveCustomerId(envelope.actorUserId);
  if (!customerId) return safeError("Không xác minh được khách hàng.");

  switch (token.action) {
    case "SEARCH_PROMPT":
      return deps.catalog.mainMenu();
    case "MAIN_MENU":
      return deps.catalog.mainMenu();
    case "CATEGORY_LIST":
      return deps.catalog.categoryList();
    case "CATEGORY_VIEW": {
      if (!token.resourceId) return safeError("Danh mục không tồn tại.");
      const page = await deps.resolveCatalogPage(token.resourceId);
      return page
        ? deps.catalog.categoryView(page.categoryId, page.cursor)
        : safeError("Danh mục không tồn tại.");
    }
    case "VARIANT_VIEW":
      return token.resourceId
        ? deps.catalog.variantDetail(token.resourceId, envelope.actorUserId)
        : safeError("Sản phẩm không tồn tại.");
    case "CATALOG_PAGE":
      return deps.catalog.mainMenu();
    case "ORDER_LIST":
      return deps.history.list(customerId);
    case "ORDER_LIST_PAGE":
      return deps.history.list(customerId, token.resourceId ?? null);
    case "ORDER_VIEW":
      return token.resourceId
        ? deps.history.detail(token.resourceId, customerId)
        : safeError("Không tìm thấy đơn hàng.");
    case "PAYMENT_REFRESH": {
      if (!token.resourceId) return safeError("Không tìm thấy đơn hàng.");
      const order = await ownedOrder(deps, token.resourceId, customerId);
      return order
        ? deps.checkout.refresh(order.orderNumber, customerId)
        : safeError("Không tìm thấy đơn hàng.");
    }
    case "PAYMENT_CANCEL": {
      if (!token.resourceId) return safeError("Không tìm thấy đơn hàng.");
      const order = await ownedOrder(deps, token.resourceId, customerId);
      return order
        ? deps.checkout.cancel(order.orderNumber, customerId, correlationId)
        : safeError("Không tìm thấy đơn hàng.");
    }
    case "PAYMENT_REOPEN": {
      if (!token.resourceId) return safeError("Không tìm thấy đơn hàng.");
      const order = await ownedOrder(deps, token.resourceId, customerId);
      return order
        ? deps.checkout.reopen(order.orderNumber, customerId)
        : safeError("Không tìm thấy đơn hàng.");
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
    case "RESTOCK_SUBSCRIBE":
      return deps.restock ? deps.restock.subscribe(customerId, token.resourceId!) : safeError("Báo có hàng không khả dụng.");
    case "RESTOCK_UNSUBSCRIBE":
      return deps.restock ? deps.restock.unsubscribe(customerId, token.resourceId!) : safeError("Báo có hàng không khả dụng.");
    case "RESTOCK_LIST":
      return deps.restock ? deps.restock.list(customerId) : safeError("Báo có hàng không khả dụng.");
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
  return safeError("Yêu cầu không được hỗ trợ.");
}

async function ownedOrder(
  deps: TelegramDomainDispatcherDeps,
  orderId: string,
  customerId: string,
): Promise<OrderRef | null> {
  const order = await deps.resolveOrderById(orderId);
  return order?.customerId === customerId ? order : null;
}

function safeError(text: string): PresentedMessage {
  return { text, buttons: [[{ text: "Menu chính", callbackData: "menu:main" }]] };
}
