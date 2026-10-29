import { isId } from "../shared/ids/index.js";
import { isPublicOrderNumber } from "../shared/order-number/index.js";
import { SUPPORT_REASON_CODES } from "../modules/support/domain.js";
import type { PresentedMessage } from "./presenters/catalog.js";
import type {
  CallbackAction,
  CallbackTokenCodec,
  IssueCallbackTokenInput,
} from "./callback-codec.js";

export interface CallbackSealerDeps {
  codec: CallbackTokenCodec;
  telegramUserId: string;
  resolveOrderId(orderNumber: string): Promise<string | null>;
}

/** Replace all legacy readable callbacks with short customer-bound tokens. */
export async function sealPresentedMessageCallbacks(
  message: PresentedMessage,
  deps: CallbackSealerDeps,
): Promise<PresentedMessage> {
  const buttons: PresentedMessage["buttons"] = [];
  for (const row of message.buttons) {
    const sealedRow: PresentedMessage["buttons"][number] = [];
    for (const button of row) {
      if (!button.callbackData && (button.url || button.copyText)) {
        sealedRow.push(button);
        continue;
      }
      if (!button.callbackData) continue;
      if (button.callbackData.startsWith("admin:") && !/^admin:\d/.test(button.callbackData)) {
        sealedRow.push(button);
        continue;
      }
      // The report action is the exact-order warranty entry point. Seal its order id so the
      // callback cannot be replayed by another Telegram account.
      if (button.callbackData.startsWith("warranty:report:")) {
        const orderId = button.callbackData.slice("warranty:report:".length);
        if (isId(orderId)) {
          sealedRow.push({
            ...button,
            callbackData: deps.codec.issue({
              action: "WARRANTY_REPORT",
              resourceId: orderId,
              telegramUserId: deps.telegramUserId,
            }),
          });
        } else {
          sealedRow.push(button);
        }
        continue;
      }
      if (button.callbackData.startsWith("warranty:")) {
        sealedRow.push(button);
        continue;
      }
      if (
        /^wallet:(?:account|history|topup(?::(?:custom|confirm|status|change|cancel|amount:[1-9][0-9]{0,12}))?)$/.test(
          button.callbackData,
        )
      ) {
        sealedRow.push(button);
        continue;
      }
      if (button.callbackData.startsWith("buyagain:")) {
        const orderNumber = button.callbackData.slice("buyagain:".length);
        if (!isPublicOrderNumber(orderNumber)) continue;
        sealedRow.push({
          ...button,
          callbackData: deps.codec.issue({
            action: "BUY_AGAIN",
            resourceId: orderNumber,
            telegramUserId: deps.telegramUserId,
          }),
        });
        continue;
      }
      if (button.callbackData.startsWith("buy:") || button.callbackData.startsWith("cb:")) {
        sealedRow.push(button);
        continue;
      }
      if (
        button.callbackData.startsWith("shop:page:") ||
        button.callbackData.startsWith("cust:notify:marketing:") ||
        button.callbackData.startsWith("cust:notify:social:")
      ) {
        sealedRow.push(button);
        continue;
      }
      if (button.callbackData === "delivery:delete") {
        sealedRow.push(button);
        continue;
      }
      const input = await parseLegacyCallback(button.callbackData, deps.resolveOrderId);
      if (!input) continue;
      sealedRow.push({
        ...button,
        callbackData: deps.codec.issue({ ...input, telegramUserId: deps.telegramUserId }),
      });
    }
    if (sealedRow.length > 0) buttons.push(sealedRow);
  }
  return { ...message, buttons };
}

async function parseLegacyCallback(
  value: string,
  resolveOrderId: (orderNumber: string) => Promise<string | null>,
): Promise<Omit<IssueCallbackTokenInput, "telegramUserId" | "now"> | null> {
  const noResource: Record<string, CallbackAction> = {
    "menu:main": "MAIN_MENU",
    "cat:list": "CATEGORY_LIST",
    "cat:search": "SEARCH_PROMPT",
    "ord:list": "ORDER_LIST",
    "sup:list": "SUPPORT_TICKET_LIST",
    "sup:open": "SUPPORT_MENU",
    "rst:list": "RESTOCK_LIST",
    "supp:open": "SUPPORT_MENU",
    "shop:home": "SHOP_HOME",
    "shop:open": "SHOP_OPEN",
    "cust:notify": "CUSTOMER_NOTIFICATIONS",
    "cust:warranty": "CUSTOMER_WARRANTY",
    "cust:preorders": "PREORDER_LIST",
  };
  if (noResource[value]) return { action: noResource[value] };
  if (value.startsWith("sup:description:cancel:")) {
    const ticketId = value.slice("sup:description:cancel:".length);
    return isId(ticketId) ? { action: "SUPPORT_DESCRIPTION_CANCEL", resourceId: ticketId } : null;
  }

  if (value.startsWith("cat:view:")) {
    const rest = value.slice("cat:view:".length);
    const [categoryId, page] = rest.split(":");
    if (!categoryId || !/^[0-9A-Z]{26}$/.test(categoryId)) return null;
    const option = page && /^\d{1,6}$/.test(page) ? Number(page) : undefined;
    return option === undefined
      ? { action: "CATEGORY_VIEW", resourceId: categoryId }
      : { action: "CATEGORY_VIEW", resourceId: categoryId, option };
  }

  for (const [prefix, action] of [
    ["var:view:", "VARIANT_VIEW"],
    ["sup:view:", "SUPPORT_TICKET_VIEW"],
    ["sup:close:", "SUPPORT_TICKET_CLOSE"],
    ["rst:sub:", "RESTOCK_SUBSCRIBE"],
    ["restock:sub:", "RESTOCK_SUBSCRIBE"],
    ["rst:unsub:", "RESTOCK_UNSUBSCRIBE"],
    ["shop:product:", "SHOP_PRODUCT"],
    ["preorder:consent:", "PREORDER_CONSENT"],
    ["preorder:create:", "PREORDER_CREATE"],
    ["preorder:pay:", "PREORDER_PAY"],
  ] as const) {
    if (value.startsWith(prefix)) {
      const resourceId = value.slice(prefix.length);
      if (
        (action === "SUPPORT_TICKET_VIEW" || action === "SUPPORT_TICKET_CLOSE") &&
        !isId(resourceId)
      ) {
        return null;
      }
      return /^[0-9A-Z]{26}$/.test(resourceId) ? { action, resourceId } : null;
    }
  }
  if (value.startsWith("shop:page:")) {
    const resourceId = value.slice("shop:page:".length);
    return /^\d{1,9}$/.test(resourceId) ? { action: "SHOP_PAGE", resourceId } : null;
  }
  if (value.startsWith("cust:notify:marketing:") || value.startsWith("cust:notify:social:")) {
    const rest = value.slice("cust:notify:".length);
    return /^(?:marketing|social):(?:on|off)$/.test(rest)
      ? { action: "CUSTOMER_NOTIFICATION_TOGGLE", resourceId: rest }
      : null;
  }

  if (value.startsWith("var:page:")) {
    const resourceId = decodeCursorId(value.slice("var:page:".length));
    return resourceId ? { action: "CATALOG_PAGE", resourceId } : null;
  }
  if (value.startsWith("ord:list:")) {
    const resourceId = decodeCursorId(value.slice("ord:list:".length));
    return resourceId ? { action: "ORDER_LIST_PAGE", resourceId } : null;
  }

  for (const [prefix, action] of [
    ["ord:view:", "ORDER_VIEW"],
    ["pay:refresh:", "PAYMENT_REFRESH"],
    ["pay:cancel:", "PAYMENT_CANCEL"],
    ["pay:reopen:", "PAYMENT_REOPEN"],
    ["sup:open:", "SUPPORT_MENU"],
  ] as const) {
    if (value.startsWith(prefix)) {
      const orderId = await resolveOrderId(value.slice(prefix.length));
      return orderId ? { action, resourceId: orderId } : null;
    }
  }

  if (value.startsWith("sup:reason:")) {
    const rest = value.slice("sup:reason:".length);
    const separator = rest.indexOf(":");
    const reason = separator < 0 ? rest : rest.slice(0, separator);
    const option = SUPPORT_REASON_CODES.indexOf(reason as (typeof SUPPORT_REASON_CODES)[number]);
    if (option < 0) return null;
    if (separator < 0) return { action: "SUPPORT_REASON", option };
    const orderId = await resolveOrderId(rest.slice(separator + 1));
    return orderId ? { action: "SUPPORT_REASON", resourceId: orderId, option } : null;
  }

  const adminMatch = /^admin:(\d{1,3}):([0-9A-Z]{26})$/.exec(value);
  if (adminMatch) {
    const option = Number(adminMatch[1]);
    const resourceId = adminMatch[2]!;
    if (option <= 255) return { action: "ADMIN_COMMAND", resourceId, option };
  }
  return null;
}

function decodeCursorId(raw: string): string | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const separator = Math.max(decoded.lastIndexOf(":"), decoded.lastIndexOf("|"));
    if (separator < 0) return null;
    const id = decoded.slice(separator + 1);
    return isId(id) ? id : null;
  } catch {
    return null;
  }
}
