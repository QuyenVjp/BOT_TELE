import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";

/**
 * Goal §95: the operator's payment queues. The admin payment screen used to show the SePay
 * reconciliation status and nothing else, so "unmatched money is never discarded" (§96) had nowhere
 * to be seen. Each view is a plain read of the same tables the domain settles from.
 */
export type AdminPaymentOpsView =
  "pending" | "late" | "paid" | "unmatched" | "discrepancy" | "refund";

export interface AdminPaymentOpsRow {
  id: string;
  label: string;
  detail: string;
}

export interface AdminPaymentOpsPage {
  view: AdminPaymentOpsView;
  title: string;
  rows: AdminPaymentOpsRow[];
  emptyHint: string;
}

export const ADMIN_PAYMENT_OPS_VIEWS: ReadonlyArray<{
  view: AdminPaymentOpsView;
  label: string;
}> = [
  { view: "pending", label: "⏳ Chờ thanh toán" },
  { view: "late", label: "⌛ Quá hạn" },
  { view: "paid", label: "✅ Đã thanh toán" },
  { view: "unmatched", label: "❓ Tiền chưa khớp" },
  { view: "discrepancy", label: "⚠️ Sai lệch" },
  { view: "refund", label: "↩️ Cần hoàn tiền" },
];

const TITLES: Record<AdminPaymentOpsView, string> = {
  pending: "⏳ CHỜ THANH TOÁN",
  late: "⌛ QUÁ HẠN",
  paid: "✅ ĐÃ THANH TOÁN",
  unmatched: "❓ TIỀN CHƯA KHỚP",
  discrepancy: "⚠️ SAI LỆCH",
  refund: "↩️ CẦN HOÀN TIỀN",
};

const EMPTY_HINTS: Record<AdminPaymentOpsView, string> = {
  pending: "Không có yêu cầu thanh toán nào đang chờ.",
  late: "Không có yêu cầu nào quá hạn.",
  paid: "Chưa có thanh toán nào thành công.",
  unmatched: "Không có khoản tiền nào chưa khớp.",
  discrepancy: "Không có sai lệch nào đang mở.",
  refund: "Không có nghĩa vụ hoàn tiền nào đang mở.",
};

const vnd = (value: bigint | number | string): string =>
  `${BigInt(value).toLocaleString("vi-VN")} ₫`;

const shortTime = (value: string | Date | null): string => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Read one payment queue. Test and archived products are excluded the same way the health screen
 * excludes them (§136): a canary payment is not something an operator should be reconciling.
 */
export async function listAdminPaymentOps(
  exec: Executor,
  view: AdminPaymentOpsView,
  limit = 8,
): Promise<AdminPaymentOpsPage> {
  const base = { view, title: TITLES[view], emptyHint: EMPTY_HINTS[view] };

  if (view === "pending" || view === "late") {
    const late = view === "late";
    const result = await sql<{
      id: string;
      amount_vnd: string;
      expires_at: Date | null;
      order_number: string | null;
      transfer_content: string | null;
    }>`
      select i.id, i.amount_vnd::text as amount_vnd, i.expires_at, o.order_number, i.transfer_content
        from payment_intent i
        left join "order" o on o.id = i.order_id
        left join product_variant v on v.id = o.variant_id
        left join product p on p.id = v.product_id
       where i.status in ('CREATED', 'PRESENTED')
         and (${late} is false and i.expires_at > now() or ${late} is true and i.expires_at <= now())
         and (p.id is null or (not p.is_test and not p.is_archived))
       order by i.created_at desc
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Đơn khác"} · ${vnd(row.amount_vnd)}`,
        detail: `${row.transfer_content ?? "—"} · hết hạn ${shortTime(row.expires_at)}`,
      })),
    };
  }

  if (view === "paid") {
    const result = await sql<{
      id: string;
      amount_vnd: string;
      settled_at: Date | null;
      order_number: string | null;
    }>`
      select i.id, i.amount_vnd::text as amount_vnd, i.settled_at, o.order_number
        from payment_intent i
        left join "order" o on o.id = i.order_id
        left join product_variant v on v.id = o.variant_id
        left join product p on p.id = v.product_id
       where i.status in ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
         and (p.id is null or (not p.is_test and not p.is_archived))
       order by i.settled_at desc nulls last
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Đơn khác"} · ${vnd(row.amount_vnd)}`,
        detail: `đã nhận ${shortTime(row.settled_at)}`,
      })),
    };
  }

  if (view === "unmatched" || view === "discrepancy") {
    const unmatched = view === "unmatched";
    const result = await sql<{
      id: string;
      type: string;
      reason: string | null;
      due_at: Date | null;
      bank_transaction_id: string | null;
      order_number: string | null;
    }>`
      select d.id, d.type, d.reason, d.due_at, d.bank_transaction_id, o.order_number
        from discrepancy d
        left join "order" o on o.id = d.order_id
       where d.resolved_at is null
         and (${unmatched} is true and d.type = 'UNMATCHED' or ${unmatched} is false and d.type <> 'UNMATCHED')
       order by d.due_at asc nulls last, d.id
       limit ${limit}
    `.execute(exec);
    return {
      ...base,
      rows: result.rows.map((row) => ({
        id: row.id,
        label: `${row.order_number ?? "Không gắn đơn"} · ${row.type}`,
        detail: `${row.reason ?? "—"}${
          row.bank_transaction_id ? ` · GD ${row.bank_transaction_id}` : ""
        } · hạn ${shortTime(row.due_at)}`,
      })),
    };
  }

  const result = await sql<{
    id: string;
    amount_vnd: string;
    status: string;
    created_at: Date;
    order_number: string | null;
    claim_id: string | null;
  }>`
    select r.id, r.amount_vnd::text as amount_vnd, r.status, r.created_at, o.order_number, r.claim_id
      from shop_refund_obligation r
      left join "order" o on o.id = r.order_id
     where r.status = 'OPEN'
     order by r.created_at asc
     limit ${limit}
  `.execute(exec);
  return {
    ...base,
    rows: result.rows.map((row) => ({
      id: row.id,
      label: `${row.order_number ?? (row.claim_id ? "Bảo hành" : "Đặt cọc")} · ${vnd(row.amount_vnd)}`,
      detail: `phát sinh ${shortTime(row.created_at)}`,
    })),
  };
}
