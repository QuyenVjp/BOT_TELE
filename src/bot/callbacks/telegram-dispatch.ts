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
import {
  presentCustomerAccountPrompt,
  presentCustomerHome,
  CUSTOMER_COPY,
} from "../presenters/customer.js";
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
    variantCreatePrompt?(input: {
      telegramUserId: string;
      productId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    variantEditPrompt?(input: {
      telegramUserId: string;
      variantId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    inventory?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    inventoryProduct?(input: {
      telegramUserId: string;
      productId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    inventoryVariant?(input: {
      telegramUserId: string;
      variantId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    stockAnnouncementPreview?(input: {
      telegramUserId: string;
      variantId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    inventoryHistory?(input: {
      telegramUserId: string;
      variantId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    quantityAdjustPreview?(input: {
      telegramUserId: string;
      variantId: string;
      delta: number;
      expectedStockVersion: number;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    quantityAdjustConfirm?(input: {
      telegramUserId: string;
      stateId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    quantityAdjustText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    suppliers?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    supplierVariant?(input: {
      telegramUserId: string;
      chatType: string;
      variantId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    supplierSelect?(input: {
      telegramUserId: string;
      chatType: string;
      supplierSkuId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    supplierClear?(input: {
      telegramUserId: string;
      chatType: string;
      variantId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    supplierVerify?(input: {
      telegramUserId: string;
      chatType: string;
      supplierSkuId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importPreview?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
      variantId?: string;
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
    importFileConfirm?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    importText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    importDocument?(input: {
      telegramUserId: string;
      document: {
        fileId: string;
        fileUniqueId?: string | null;
        filename: string;
        mimeType: string;
        fileSize?: number;
      };
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    importTemplate?(input: {
      telegramUserId: string;
      chatType: string;
      variantId: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    confirm?(input: {
      telegramUserId: string;
      chatType: string;
      confirmationId: string;
      challenge: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    manualTasks?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    manualTask?(input: {
      telegramUserId: string;
      chatType: string;
      taskId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    manualComplete?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    orders?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
      filter?:
        | "all"
        | "pending_payment"
        | "paid"
        | "processing"
        | "completed"
        | "payment_review"
        | "fulfillment_review"
        | "refunds";
      query?: string | null;
      cursor?: string | null;
    }): Promise<PresentedMessage>;
    orderState?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    orderSearch?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    orderMessagePrompt?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    orderText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    support?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    supportApprove?(input: {
      telegramUserId: string;
      chatType: string;
      caseId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    customers?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
      filter?: "recent" | "top_spend" | "unreachable" | "support_open" | "payment_review";
      query?: string | null;
      cursor?: string | null;
    }): Promise<PresentedMessage>;
    customerState?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    customerSearch?(input: {
      telegramUserId: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    customerMessagePrompt?(input: {
      telegramUserId: string;
      chatType: string;
      stateId: string;
      correlationId: string;
    }): Promise<PresentedMessage>;
    customerText?(input: {
      telegramUserId: string;
      text: string;
      chatType: string;
      correlationId: string;
    }): Promise<PresentedMessage | null>;
    presentAdminCustomerDetail?(
      ctx: TelegramActionContext,
      customerId: string,
    ): Promise<PresentedMessage>;
    sendAdminCustomerMessage?(
      ctx: TelegramActionContext,
      input: { customerId: string; text: string },
    ): Promise<PresentedMessage>;
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
      variantText?(input: {
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
      fulfillmentType?(input: {
        telegramUserId: string;
        fulfillmentType: string;
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
        } else if (route === "products:create") {
          message = admin.workflow
            ? await admin.workflow.start({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Tạo sản phẩm không khả dụng.");
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
        } else if (route.startsWith("products:type:")) {
          message = admin.workflow?.fulfillmentType
            ? await admin.workflow.fulfillmentType({
                telegramUserId: envelope.actorUserId,
                fulfillmentType: route.slice("products:type:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Loại giao hàng không khả dụng.");
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
        } else if (route.startsWith("products:variant-add:")) {
          message = admin.variantCreatePrompt
            ? await admin.variantCreatePrompt({
                telegramUserId: envelope.actorUserId,
                productId: route.slice("products:variant-add:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Thêm biến thể không khả dụng.");
        } else if (route.startsWith("products:variant-edit:")) {
          message = admin.variantEditPrompt
            ? await admin.variantEditPrompt({
                telegramUserId: envelope.actorUserId,
                variantId: route.slice("products:variant-edit:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Sửa biến thể không khả dụng.");
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
        } else if (route.startsWith("inventory:product:")) {
          message = admin.inventoryProduct
            ? await admin.inventoryProduct({
                telegramUserId: envelope.actorUserId,
                productId: route.slice("inventory:product:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Sản phẩm kho không khả dụng.");
        } else if (route.startsWith("inventory:variant:")) {
          message = admin.inventoryVariant
            ? await admin.inventoryVariant({
                telegramUserId: envelope.actorUserId,
                variantId: route.slice("inventory:variant:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Biến thể kho không khả dụng.");
        } else if (route.startsWith("inventory:announce:")) {
          message = admin.stockAnnouncementPreview
            ? await admin.stockAnnouncementPreview({
                telegramUserId: envelope.actorUserId,
                variantId: route.slice("inventory:announce:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Thông báo kho không khả dụng.");
        } else if (route.startsWith("inventory:history:")) {
          message = admin.inventoryHistory
            ? await admin.inventoryHistory({
                telegramUserId: envelope.actorUserId,
                variantId: route.slice("inventory:history:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Lịch sử kho không khả dụng.");
        } else if (route.startsWith("inventory:qty-confirm:")) {
          message = admin.quantityAdjustConfirm
            ? await admin.quantityAdjustConfirm({
                telegramUserId: envelope.actorUserId,
                stateId: route.slice("inventory:qty-confirm:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Điều chỉnh tồn kho không khả dụng.");
        } else if (route.startsWith("inventory:qty:")) {
          const [, variantId, rawDelta, rawVersion] =
            route.match(/^inventory:qty:([^:]+):(-?\d+):(\d+)$/u) ?? [];
          message =
            admin.quantityAdjustPreview && variantId && rawDelta && rawVersion
              ? await admin.quantityAdjustPreview({
                  telegramUserId: envelope.actorUserId,
                  variantId,
                  delta: Number(rawDelta),
                  expectedStockVersion: Number(rawVersion),
                  chatType: envelope.chatType,
                  correlationId,
                })
              : safeError("Điều chỉnh tồn kho không hợp lệ.");
        } else if (route.startsWith("inventory:import:")) {
          message = admin.importPreview
            ? await admin.importPreview({
                telegramUserId: envelope.actorUserId,
                variantId: route.slice("inventory:import:".length),
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Nhập kho không khả dụng.");
        } else if (route === "inventory:import") {
          message = safeError("Chọn biến thể tài khoản/mã kho trước khi nhập kho.");
        } else if (route.startsWith("inventory:file-confirm:")) {
          message = admin.importFileConfirm
            ? await admin.importFileConfirm({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice("inventory:file-confirm:".length),
                correlationId,
              })
            : safeError("Xác nhận tệp không khả dụng.");
        } else if (route === "inventory:confirm") {
          message = admin.importConfirm
            ? await admin.importConfirm({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Xác nhận nhập kho không khả dụng.");
        } else if (route.startsWith("inventory:template:")) {
          message = admin.importTemplate
            ? ((await admin.importTemplate({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                variantId: route.slice("inventory:template:".length),
                correlationId,
              })) ?? safeError("CSV mẫu nhập kho không khả dụng."))
            : safeError("CSV mẫu nhập kho không khả dụng.");
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
            ? await admin.marketing({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminMarketingMenu();
        } else if (route === "marketing:compose") {
          message = admin.broadcastCompose
            ? await admin.broadcastCompose({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Soạn thông báo không khả dụng.");
        } else if (route.startsWith("marketing:audience:")) {
          const audience = route.slice("marketing:audience:".length);
          message =
            (audience === "all" ||
              audience === "shop" ||
              audience === "activity" ||
              audience === "root") &&
            admin.broadcastAudience
              ? await admin.broadcastAudience({
                  telegramUserId: envelope.actorUserId,
                  chatType: envelope.chatType,
                  audience,
                  correlationId,
                })
              : safeError("Nhóm nhận không hợp lệ.");
        } else if (route.startsWith("marketing:confirm:")) {
          message = admin.broadcastConfirm
            ? await admin.broadcastConfirm({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                campaignId: route.slice("marketing:confirm:".length),
                correlationId,
              })
            : safeError("Xác nhận thông báo không khả dụng.");
        } else if (route.startsWith("marketing:cancel:")) {
          message = admin.broadcastCancel
            ? await admin.broadcastCancel({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                campaignId: route.slice("marketing:cancel:".length),
                correlationId,
              })
            : presentAdminMarketingMenu();
        } else if (route === "marketing:cancel") {
          message = admin.broadcastCancel
            ? await admin.broadcastCancel({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminMarketingMenu();
        } else if (route.startsWith("marketing:status:")) {
          message = admin.broadcastStatus
            ? await admin.broadcastStatus({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                campaignId: route.slice("marketing:status:".length),
                correlationId,
              })
            : safeError("Trạng thái thông báo không khả dụng.");
        } else if (route === "customers") {
          message = admin.customers
            ? await admin.customers({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Khách hàng không khả dụng.");
        } else if (route === "customers:search") {
          message = admin.customerSearch
            ? await admin.customerSearch({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Tìm khách không khả dụng.");
        } else if (route.startsWith("customers:filter:")) {
          const filter = route.slice("customers:filter:".length);
          message =
            (filter === "recent" ||
              filter === "top_spend" ||
              filter === "unreachable" ||
              filter === "support_open" ||
              filter === "payment_review") &&
            admin.customers
              ? await admin.customers({
                  telegramUserId: envelope.actorUserId,
                  chatType: envelope.chatType,
                  filter,
                  correlationId,
                })
              : safeError("Bộ lọc khách không hợp lệ.");
        } else if (route.startsWith("customers:view:") || route.startsWith("customers:page:")) {
          const prefix = route.startsWith("customers:view:")
            ? "customers:view:"
            : "customers:page:";
          message = admin.customerState
            ? await admin.customerState({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice(prefix.length),
                correlationId,
              })
            : safeError("Phiên khách hàng không khả dụng.");
        } else if (route.startsWith("customers:message:")) {
          message = admin.customerMessagePrompt
            ? await admin.customerMessagePrompt({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice("customers:message:".length),
                correlationId,
              })
            : safeError("Nhắn khách không khả dụng.");
        } else if (route === "manual") {
          message = admin.manualTasks
            ? await admin.manualTasks({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Xử lý thủ công không khả dụng.");
        } else if (route.startsWith("manual:view:")) {
          message = admin.manualTask
            ? await admin.manualTask({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                taskId: route.slice("manual:view:".length),
                correlationId,
              })
            : safeError("Tác vụ thủ công không khả dụng.");
        } else if (route.startsWith("manual:complete:")) {
          message = admin.manualComplete
            ? await admin.manualComplete({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice("manual:complete:".length),
                correlationId,
              })
            : safeError("Xác nhận tác vụ thủ công không khả dụng.");
        } else if (route === "orders") {
          message = admin.orders
            ? await admin.orders({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminOrdersMenu();
        } else if (route === "orders:search") {
          message = admin.orderSearch
            ? await admin.orderSearch({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : safeError("Tìm đơn không khả dụng.");
        } else if (route.startsWith("orders:filter:")) {
          const filter = route.slice("orders:filter:".length);
          message =
            (filter === "all" ||
              filter === "pending_payment" ||
              filter === "paid" ||
              filter === "processing" ||
              filter === "completed" ||
              filter === "payment_review" ||
              filter === "fulfillment_review" ||
              filter === "refunds") &&
            admin.orders
              ? await admin.orders({
                  telegramUserId: envelope.actorUserId,
                  chatType: envelope.chatType,
                  filter,
                  correlationId,
                })
              : safeError("Bộ lọc đơn không hợp lệ.");
        } else if (route.startsWith("orders:view:") || route.startsWith("orders:page:")) {
          const prefix = route.startsWith("orders:view:") ? "orders:view:" : "orders:page:";
          message = admin.orderState
            ? await admin.orderState({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice(prefix.length),
                correlationId,
              })
            : safeError("Phiên đơn hàng không khả dụng.");
        } else if (route.startsWith("orders:message:")) {
          message = admin.orderMessagePrompt
            ? await admin.orderMessagePrompt({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                stateId: route.slice("orders:message:".length),
                correlationId,
              })
            : safeError("Nhắn khách theo đơn không khả dụng.");
        } else if (route === "payments") {
          message = presentAdminPaymentsMenu();
        } else if (route === "suppliers") {
          message = admin.suppliers
            ? await admin.suppliers({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminSuppliersMenu();
        } else if (route.startsWith("supv:")) {
          message = admin.supplierVariant
            ? await admin.supplierVariant({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                variantId: route.slice("supv:".length),
                correlationId,
              })
            : safeError("Nhà cung cấp không khả dụng.");
        } else if (route.startsWith("sups:")) {
          message = admin.supplierSelect
            ? await admin.supplierSelect({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                supplierSkuId: route.slice("sups:".length),
                correlationId,
              })
            : safeError("Mapping nhà cung cấp không khả dụng.");
        } else if (route.startsWith("supc:")) {
          message = admin.supplierClear
            ? await admin.supplierClear({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                variantId: route.slice("supc:".length),
                correlationId,
              })
            : safeError("Mapping nhà cung cấp không khả dụng.");
        } else if (route.startsWith("supm:")) {
          message = admin.supplierVerify
            ? await admin.supplierVerify({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                supplierSkuId: route.slice("supm:".length),
                correlationId,
              })
            : safeError("Xác nhận thủ công không khả dụng.");
        } else if (route === "support") {
          message = admin.support
            ? await admin.support({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                correlationId,
              })
            : presentAdminSupportMenu();
        } else if (route.startsWith("support:approve:")) {
          message = admin.supportApprove
            ? await admin.supportApprove({
                telegramUserId: envelope.actorUserId,
                chatType: envelope.chatType,
                caseId: route.slice("support:approve:".length),
                correlationId,
              })
            : safeError("Duyệt thay thế không khả dụng.");
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
        message =
          parsed && deps.admin?.confirm
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
        message =
          customerId && deps.admin?.presentAdminCustomerDetail
            ? await deps.admin.presentAdminCustomerDetail(ctx, customerId)
            : safeError("Dùng /customer kèm mã khách hàng.");
      } else if (command === "/message_customer") {
        const parsed = parseAdminMessageCustomer(envelope.searchQuery);
        message =
          parsed && deps.admin?.sendAdminCustomerMessage
            ? await deps.admin.sendAdminCustomerMessage(ctx, parsed)
            : safeError("Dùng /message_customer <customerId> <nội dung>.");
      } else if (command === "/start") {
        message = presentCustomerHome();
      } else if (command === "/catalog") {
        message = await deps.catalog.mainMenu();
      } else if (command === "/account" || envelope.callbackData === "wallet:account") {
        message = deps.walletAccount
          ? await deps.walletAccount(ctx)
          : presentCustomerAccountPrompt();
      } else if (
        command === "/topup" ||
        envelope.callbackData === "wallet:topup" ||
        envelope.messageText === CUSTOMER_COPY.topup
      ) {
        message = deps.walletTopup
          ? await deps.walletTopup(ctx)
          : safeError("Nạp ví không khả dụng.");
      } else if (command === "/pay") {
        message =
          deps.walletPay && envelope.searchQuery
            ? await deps.walletPay(ctx, envelope.searchQuery)
            : safeError("Dùng /pay kèm mã đơn hàng.");
      } else if (command === "/search") {
        message = envelope.searchQuery
          ? await deps.catalog.search(envelope.searchQuery)
          : safeError("Dùng /search kèm tên sản phẩm.");
      } else if (command === "/support") {
        message = deps.support.reasonMenu();
      } else if (envelope.messageText === "🔔 Báo có hàng") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message =
          customerId && deps.notification
            ? await deps.notification.subscriptions(customerId)
            : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === "🔔 Cài đặt thông báo") {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message =
          customerId && deps.notification
            ? await deps.notification.settings(customerId)
            : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === CUSTOMER_COPY.shopUpdates) {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message =
          customerId && deps.notification
            ? await deps.notification.toggle(customerId, "shop")
            : safeError("Không xác minh được khách hàng.");
      } else if (envelope.messageText === CUSTOMER_COPY.purchaseActivity) {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message =
          customerId && deps.notification
            ? await deps.notification.toggle(customerId, "activity")
            : safeError("Không xác minh được khách hàng.");
      } else if (
        envelope.messageText === CUSTOMER_COPY.openShop ||
        envelope.messageText === "🌐 Mở cửa hàng"
      ) {
        message = presentShopLaunch(deps.shopUrl ?? "");
      } else if (
        envelope.messageText === CUSTOMER_COPY.browse ||
        envelope.messageText === "🛒 Mua hàng"
      ) {
        message = await deps.catalog.mainMenu();
      } else if (
        envelope.messageText === CUSTOMER_COPY.account ||
        envelope.messageText === "👤 Tài khoản"
      ) {
        message = deps.walletAccount
          ? await deps.walletAccount(ctx)
          : presentCustomerAccountPrompt();
      } else if (
        envelope.messageText === CUSTOMER_COPY.back ||
        envelope.messageText === "↩️ Quay lại"
      ) {
        message = presentCustomerHome();
      } else if (
        envelope.messageText === CUSTOMER_COPY.orders ||
        envelope.messageText === "🧾 Đơn hàng"
      ) {
        const customerId = await deps.resolveCustomerId(envelope.actorUserId);
        message = customerId
          ? await deps.history.list(customerId)
          : safeError("Không xác minh được khách hàng.");
      } else if (
        envelope.messageText === CUSTOMER_COPY.support ||
        envelope.messageText === "🛟 Hỗ trợ"
      ) {
        message = deps.support.reasonMenu();
      } else if (envelope.contactPhoneNumber) {
        message = presentCustomerAccountPrompt();
      } else if (envelope.document && deps.admin?.importDocument) {
        message =
          (await deps.admin.importDocument({
            telegramUserId: envelope.actorUserId,
            document: envelope.document,
            chatType: envelope.chatType,
            correlationId,
          })) ?? (await deps.catalog.mainMenu());
      } else if (
        envelope.messageText &&
        (deps.admin?.orderText ||
          deps.admin?.customerText ||
          deps.admin?.broadcastText ||
          deps.admin?.importText ||
          deps.admin?.quantityAdjustText ||
          deps.admin?.workflow?.variantText ||
          deps.admin?.workflow)
      ) {
        message =
          (deps.admin.orderText
            ? await deps.admin.orderText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
          (deps.admin.customerText
            ? await deps.admin.customerText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
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
          (deps.admin.quantityAdjustText
            ? await deps.admin.quantityAdjustText({
                telegramUserId: envelope.actorUserId,
                text: envelope.messageText,
                chatType: envelope.chatType,
                correlationId,
              })
            : null) ??
          (deps.admin.workflow?.variantText
            ? await deps.admin.workflow.variantText({
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

function actionContext(
  envelope: TelegramCommandEnvelope,
  correlationId: string,
): TelegramActionContext {
  return {
    telegramUserId: envelope.actorUserId,
    chatId: envelope.chatId,
    chatType: envelope.chatType,
    messageId: envelope.messageId,
    correlationId,
  };
}

function parseAdminConfirm(
  input?: string | null,
): { confirmationId: string; challenge: string } | null {
  const match = input?.trim().match(/^(\S+)\s+(\S+)$/u);
  if (!match) return null;
  return { confirmationId: match[1]!, challenge: match[2]! };
}

function parseAdminMessageCustomer(
  input?: string | null,
): { customerId: string; text: string } | null {
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
      return deps.restock
        ? deps.restock.subscribe(customerId, token.resourceId!)
        : safeError("Báo có hàng không khả dụng.");
    case "RESTOCK_UNSUBSCRIBE":
      return deps.restock
        ? deps.restock.unsubscribe(customerId, token.resourceId!)
        : safeError("Báo có hàng không khả dụng.");
    case "RESTOCK_LIST":
      return deps.restock
        ? deps.restock.list(customerId)
        : safeError("Báo có hàng không khả dụng.");
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
