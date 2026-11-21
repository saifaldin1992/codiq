/**
 * «المدفوعات الإلكترونيّة» — every card payment and instalment plan in the
 * market, newest first, with its state and what was refunded. Says plainly
 * when the TEST providers are on, and when online payment is off.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Payment = {
  id: string;
  method: string;
  provider: string;
  status: string;
  statusLabel: string;
  amountIqd: number;
  refundedIqd: number;
  months: number | null;
  monthlyIqd: number | null;
  createdAt: string;
  store: { name: string; slug: string };
  order: { orderNumber: string; status: string } | null;
  shopperPhone: string;
};
type Page = { mode: "off" | "fake"; payments: Payment[]; nextCursor: string | null };
const FILTERS = [
  ["", "الكلّ"],
  ["pending", "بانتظار الدفع"],
  ["paid", "مدفوعة"],
  ["approved", "تقسيط معتمد"],
  ["refunded", "مُستردّة"],
  ["expired", "منتهية"],
] as const;
const money = (value: number) => `${value.toLocaleString("ar-IQ")} د.ع`;

async function call<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function PlatformMarketPaymentsPanel() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      try {
        const next = await call<Page>(
          `/api/platform/market/payments?limit=30${status ? `&status=${status}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        setPage((current) =>
          cursor && current ? { ...next, payments: [...current.payments, ...next.payments] } : next
        );
      } catch (error) {
        setFailure((error as Error).message);
      }
    },
    [status]
  );
  useEffect(() => {
    setPage(null);
    void load();
  }, [load]);
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-payments">
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {page?.mode === "fake" ? (
        <p
          className="rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-warning)]"
          data-testid="payments-test-mode"
        >
          المزوّدون التجريبيّون مفعّلون — لا تُسحب أموال حقيقيّة. اربط البوابة وجهات التقسيط عند
          التعاقد.
        </p>
      ) : null}
      {page?.mode === "off" ? (
        <p className="rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-sm text-[var(--codiq-text-secondary)]">
          الدفع الإلكترونيّ غير مفعّل — السوق يقبل الدفع نقداً فقط.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant={status === value ? "default" : "outline"}
            onClick={() => setStatus(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {!page ? (
        <LoaderCircle className="h-5 w-5 animate-spin" />
      ) : !page.payments.length ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">لا مدفوعات هنا.</p>
      ) : (
        <div className="overflow-x-auto rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)]">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--codiq-text-muted)]">
              <tr>
                <th className="p-3 text-right">الطلب</th>
                <th className="p-3 text-right">المتجر</th>
                <th className="p-3 text-right">الطريقة</th>
                <th className="p-3 text-right">المبلغ</th>
                <th className="p-3 text-right">الحالة</th>
                <th className="p-3 text-right">الوقت</th>
              </tr>
            </thead>
            <tbody>
              {page.payments.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[var(--codiq-border)]"
                  data-testid="payments-row"
                >
                  <td className="p-3 font-bold" dir="ltr">
                    {row.order?.orderNumber ?? "—"}
                  </td>
                  <td className="p-3">{row.store.name}</td>
                  <td className="p-3">
                    {row.method === "card"
                      ? "بطاقة"
                      : row.method === "partner"
                        ? "التطبيق الشريك"
                        : `أقساط ${row.months?.toLocaleString("ar-IQ") ?? ""} × ${row.monthlyIqd ? money(row.monthlyIqd) : ""}`}
                    <span className="block text-[10px] text-[var(--codiq-text-muted)]">
                      {row.provider} · {row.shopperPhone}
                    </span>
                  </td>
                  <td className="p-3 font-black">
                    {money(row.amountIqd)}
                    {row.refundedIqd ? (
                      <span className="block text-[10px] text-[var(--codiq-success)]">
                        مُسترد {money(row.refundedIqd)}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-3">{row.statusLabel}</td>
                  <td className="p-3 text-xs text-[var(--codiq-text-muted)]">
                    {new Date(row.createdAt).toLocaleString("ar-IQ", { timeZone: "Asia/Baghdad" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void load(page.nextCursor ?? undefined)}
        >
          المزيد
        </Button>
      ) : null}
    </div>
  );
}
