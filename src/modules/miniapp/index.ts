import type { FastifyInstance } from "fastify";
import type { Db } from "../../infrastructure/db/transaction.js";
import { ensureTelegramIdentity } from "../identity/channel-identity.js";
import { verifyTelegramMiniAppInitData } from "../digital-goods/delivery-route.js";
import { searchCatalog } from "../catalog/search.js";
import { listFeaturedProducts, listPublicRootCategories } from "../catalog/repository.js";
import { SHOP_NAME } from "../catalog/shop-profile.js";
import { resolveCatalogAudience } from "../catalog/visibility.js";
import { buyNow } from "../commerce/buy-now.js";
import { createWalletPurchaseService } from "../wallet/purchase.js";
import { sql } from "kysely";

export interface MiniAppOptions {
  db: Db;
  botToken: string;
  path?: string;
  maxAgeSeconds: number;
  adminTelegramUserId?: string | undefined;
}

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
} as const;

const STYLE =
  "body{font:16px system-ui,sans-serif;max-width:760px;margin:auto;padding:1rem;background:#f6f7f9;color:#17202a}header{display:flex;justify-content:space-between;align-items:center}main{display:grid;gap:.75rem}.card{background:white;border-radius:12px;padding:1rem;box-shadow:0 1px 4px #0002}button{border:0;border-radius:8px;padding:.65rem 1rem;background:#1683d8;color:white;font-weight:600}button:disabled{opacity:.5}input{padding:.65rem;border:1px solid #ccd2d8;border-radius:8px;width:100%;box-sizing:border-box}.muted{color:#58636e}.error{color:#a21b1b}.actions{display:flex;gap:.5rem;flex-wrap:wrap}";

const APP_JS = String.raw`
const statusEl = document.querySelector("#status");
const products = document.querySelector("#products");
const search = document.querySelector("#search");
const account = document.querySelector("#account");
const apiBase = document.body.dataset.apiBase;
const initData = window.Telegram?.WebApp?.initData || "";
window.Telegram?.WebApp?.ready?.();

async function api(path, opt = {}) {
  const r = await fetch(apiBase + path, {
    ...opt,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData,
      ...(opt.headers || {}),
    },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.message || d.error || "request_failed");
  return d;
}

function text(v) {
  return String(v ?? "");
}

function money(v) {
  return Number(v).toLocaleString("vi-VN") + " VND";
}

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.className = error ? "error" : "muted";
}

function render(items) {
  products.replaceChildren(...items.map((x) => {
    const e = document.createElement("article");
    e.className = "card";
    const h = document.createElement("h2");
    h.textContent = text(x.productNameVi) + " — " + text(x.nameVi);
    const p = document.createElement("p");
    p.textContent = money(x.priceVnd) + " · " + text(x.deliveryType);
    const actions = document.createElement("div");
    actions.className = "actions";
    const buy = document.createElement("button");
    const ready = x.isReady === true;
    buy.textContent = "Đặt hàng";
    buy.disabled = !ready;
    buy.onclick = async () => {
      buy.disabled = true;
      setStatus("Đang tạo đơn…");
      try {
        const d = await api("/api/orders", {
          method: "POST",
          body: JSON.stringify({
            variantId: x.id,
            expectedPriceVnd: Number(x.priceVnd),
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        setStatus("Đơn " + text(d.order.orderNumber) + " đang chờ thanh toán.");
        actions.append(walletButton(d.order));
      } catch (err) {
        setStatus(err.message, true);
        buy.disabled = !ready;
      }
    };
    actions.append(buy);
    if (!ready) {
      const unavailable = document.createElement("span");
      unavailable.className = "muted";
      unavailable.textContent = "Tạm hết hàng";
      actions.append(unavailable);
    }
    e.append(h, p, actions);
    return e;
  }));
}

function walletButton(order) {
  const pay = document.createElement("button");
  pay.textContent = "Thanh toán bằng ví";
  pay.onclick = async () => {
    pay.disabled = true;
    setStatus("Đang thanh toán bằng ví…");
    try {
      const d = await api("/api/orders/" + encodeURIComponent(order.id) + "/wallet-pay", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      setStatus(d.kind === "ALREADY_PAID" ? "Đơn đã được thanh toán." : "Đã thanh toán bằng ví.");
    } catch (err) {
      setStatus(err.message, true);
      pay.disabled = false;
    }
  };
  return pay;
}

async function load() {
  setStatus("Đang tải…");
  try {
    const d = await api("/api/catalog?q=" + encodeURIComponent(search.value));
    render(d.items);
    setStatus(d.items.length ? "" : "Không có sản phẩm phù hợp.");
  } catch (err) {
    setStatus(err.message, true);
  }
}

search.oninput = () => load();
account.onclick = async () => {
  try {
    const d = await api("/api/account");
    setStatus("Số dư ví: " + money(d.balanceVnd) + " · Đơn hàng: " + text(d.orderCount));
    const history = await api("/api/orders");
    const heading = document.createElement("h2");
    heading.textContent = "50 đơn hàng gần nhất";
    const rows = history.items.map((order) => {
      const row = document.createElement("article");
      row.className = "card";
      const title = document.createElement("h3");
      title.textContent = text(order.order_number);
      const detail = document.createElement("p");
      detail.textContent = text(order.status) + " · " + money(order.price_vnd)
        + " · " + new Date(order.created_at).toLocaleString("vi-VN");
      row.append(title, detail);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "Bạn chưa có đơn hàng.";
      rows.push(empty);
    }
    products.replaceChildren(heading, ...rows);
  } catch (err) {
    setStatus(err.message, true);
  }
};
load();
`;

function shell(path: string): string {
  const safePath = JSON.stringify(path);
  const appJs = JSON.stringify(`${path}/app.js`);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIER20 SHOP</title><style>${STYLE}</style><script src="https://telegram.org/js/telegram-web-app.js"></script><script src=${appJs} defer></script></head><body data-api-base=${safePath}><header><h1>TIER20 SHOP</h1><button id="account">Tài khoản</button></header><main><label for="search">Tìm sản phẩm</label><input id="search" autocomplete="off" placeholder="Nhập tên sản phẩm"><section id="status" class="muted" aria-live="polite">Đang tải…</section><section id="products"></section></main></body></html>`;
}

function setHeaders(reply: { header(name: string, value: string): unknown }): void {
  for (const [key, value] of Object.entries(NO_CACHE)) reply.header(key, value);
}

function initDataFrom(request: { headers: Record<string, string | string[] | undefined> }): string {
  const value = request.headers["x-telegram-init-data"];
  return typeof value === "string" ? value : "";
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function presentVariant(row: {
  id: string;
  product_id: string;
  product_name_vi: string;
  sku: string;
  name_vi: string;
  price_vnd: string;
  duration_code: string | null;
  delivery_type: string;
  warranty_days: number;
  stock_policy: string;
  sort_order: number;
  fulfillment_type: string;
  available_quantity: number | null;
  is_ready: boolean;
}) {
  return {
    id: row.id,
    productId: row.product_id,
    productNameVi: row.product_name_vi,
    sku: row.sku,
    nameVi: row.name_vi,
    priceVnd: row.price_vnd,
    durationCode: row.duration_code,
    deliveryType: row.delivery_type,
    warrantyDays: row.warranty_days,
    stockPolicy: row.stock_policy,
    sortOrder: row.sort_order,
    fulfillmentType: row.fulfillment_type,
    availableQuantity: row.available_quantity,
    isReady: row.is_ready,
    canBuy: row.is_ready,
  };
}

export async function registerMiniApp(
  app: FastifyInstance,
  options: MiniAppOptions,
): Promise<void> {
  const path = options.path ?? "/shop";
  const walletPurchase = createWalletPurchaseService(options.db);
  app.get(path, async (_request, reply) => {
    setHeaders(reply);
    return reply.type("text/html; charset=utf-8").send(shell(path));
  });
  app.get(`${path}/app.js`, async (_request, reply) => {
    setHeaders(reply);
    return reply.type("application/javascript; charset=utf-8").send(APP_JS);
  });
  app.get(`${path}/api/catalog`, async (request, reply) => {
    setHeaders(reply);
    const query = request.query as { q?: string; cursor?: string };
    try {
      const raw = initDataFrom(request);
      const verified = raw
        ? verifyTelegramMiniAppInitData(raw, {
            botToken: options.botToken,
            maxAgeSeconds: options.maxAgeSeconds,
          })
        : null;
      const telegramUserId = verified ? String(verified.telegramUserId) : undefined;
      const isRootAdmin =
        telegramUserId !== undefined &&
        options.adminTelegramUserId !== undefined &&
        telegramUserId === options.adminTelegramUserId;
      const audience = await resolveCatalogAudience(
        options.db,
        telegramUserId ? { telegramUserId, isRootAdmin } : undefined,
      );
      const searchOptions = {
        limit: 24,
        audience,
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
      };
      const page = await searchCatalog(
        options.db,
        { query: typeof query.q === "string" ? query.q : undefined },
        searchOptions,
      );
      const [categories, featured] = await Promise.all([
        listPublicRootCategories(options.db, audience),
        listFeaturedProducts(options.db, audience, 3),
      ]);
      return reply.send({
        shopName: SHOP_NAME,
        categories: categories.map((category) => ({
          id: category.id,
          nameVi: category.display_name_vi || category.name_vi,
          icon: category.icon,
        })),
        featured: featured.map((product) => ({
          id: product.id,
          nameVi: product.name_vi,
          minPriceVnd: product.min_price_vnd,
        })),
        items: page.items.map(presentVariant),
        nextCursor: page.nextCursor,
      });
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
  });
  const authenticate = async (request: {
    headers: Record<string, string | string[] | undefined>;
  }) => {
    const raw = initDataFrom(request);
    const verified = raw
      ? verifyTelegramMiniAppInitData(raw, {
          botToken: options.botToken,
          maxAgeSeconds: options.maxAgeSeconds,
        })
      : null;
    if (!verified) return null;
    return ensureTelegramIdentity(options.db, { telegramUserId: verified.telegramUserId });
  };
  app.get(`${path}/api/account`, async (request, reply) => {
    setHeaders(reply);
    const identity = await authenticate(request);
    if (!identity) return reply.code(401).send({ ok: false, error: "unauthorized" });
    const row = (
      await sql<{
        balance_vnd: string;
        order_count: string;
      }>`select coalesce((select balance_vnd from wallet_account where customer_id=${identity.customerId}),'0') balance_vnd, (select count(*) from "order" where customer_id=${identity.customerId}) order_count`.execute(
        options.db,
      )
    ).rows[0]!;
    return reply.send({
      ok: true,
      balanceVnd: row.balance_vnd,
      orderCount: Number(row.order_count),
    });
  });
  app.get(`${path}/api/orders`, async (request, reply) => {
    setHeaders(reply);
    const identity = await authenticate(request);
    if (!identity) return reply.code(401).send({ ok: false, error: "unauthorized" });
    const rows = (
      await sql`select id, order_number, status, price_vnd, created_at from "order" where customer_id=${identity.customerId} order by created_at desc, id desc limit 50`.execute(
        options.db,
      )
    ).rows;
    return reply.send({ ok: true, items: rows });
  });
  app.post(`${path}/api/orders`, async (request, reply) => {
    setHeaders(reply);
    const identity = await authenticate(request);
    if (!identity) return reply.code(401).send({ ok: false, error: "unauthorized" });
    const body = parseBody(request.body);
    const variantId = typeof body?.variantId === "string" ? body.variantId : "";
    const key = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
    const price = typeof body?.expectedPriceVnd === "number" ? body.expectedPriceVnd : NaN;
    if (!variantId || !validKey(key) || !Number.isSafeInteger(price) || price <= 0)
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    const result = await buyNow(options.db, {
      customerId: identity.customerId,
      variantId,
      expectedPriceVnd: price,
      idempotencyKey: key,
      correlationId: `miniapp-${identity.customerId}`,
    });
    return reply.code(result.ok ? 200 : 409).send(result);
  });
  app.post(`${path}/api/orders/:orderId/wallet-pay`, async (request, reply) => {
    setHeaders(reply);
    const identity = await authenticate(request);
    if (!identity) return reply.code(401).send({ ok: false, error: "unauthorized" });
    const params = request.params as { orderId?: string };
    const body = parseBody(request.body);
    const key = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!params.orderId || !validKey(key))
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    const result = await walletPurchase.purchase({
      customerId: identity.customerId,
      orderId: params.orderId,
      idempotencyKey: `miniapp:${key}`,
      correlationId: `miniapp-${identity.customerId}`,
    });
    return reply.code(result.ok ? 200 : 409).send(result);
  });
}
