/**
 * MD-3 — «سينفد خلال ~N أيام».
 *
 * This is a list of what is RUNNING OUT, not a stock report, and the page says
 * so. A product absent from it has not sold enough in the window for a rate to
 * mean anything — which is not the same as being well stocked, and a screen that
 * let the omission imply otherwise would turn a silence into a claim.
 *
 * Every row carries the evidence beside the estimate: units sold, the window
 * they were sold over, and the rate. A merchant who can see where the number
 * came from can tell how much to trust it, which is the only honest way to show
 * a forecast at all.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, PackageSearch, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Forecast = {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  stockQuantity: number;
  soldInWindow: number;
  dailyRate: number;
  daysRemaining: number | null;
  windowDays: number;
};

const number = new Intl.NumberFormat("ar-IQ");
/** Under a week is the point at which reordering stops being optional. */
const urgent = (days: number | null) => days !== null && days <= 7;

export function StockForecastPanel({ storeSlug }: { storeSlug: string }) {
  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/merchant/stores/${encodeURIComponent(storeSlug)}/inventory/forecast`,
        { credentials: "same-origin" }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل التوقعات.");
      setForecasts(body.forecasts);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [storeSlug]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="max-w-[1030px] space-y-3" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <PackageSearch className="h-4 w-4" /> متى ينفد مخزونك
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          className="rounded-xl text-[var(--codiq-text-secondary)]"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {!forecasts && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ الحساب…
        </p>
      ) : null}

      {forecasts ? (
        <>
          {forecasts.length === 0 ? (
            <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">
              لا يوجد منتج بيعه الأخير كافٍ لتقدير موعد نفاده. التقدير يحتاج حركة بيع فعلية، وبدونها
              لا نخمّن.
            </p>
          ) : (
            <ul className="space-y-2">
              {forecasts.map((row) => (
                <li
                  key={row.variantId ?? row.productId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[var(--codiq-text)]">
                      {row.name}
                    </p>
                    {/* The evidence, beside the estimate: this is what makes the estimate judgeable. */}
                    <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
                      {row.sku ? (
                        <>
                          <span dir="ltr">{row.sku}</span> ·{" "}
                        </>
                      ) : null}
                      في المخزون:{" "}
                      <b className="font-bold tabular-nums">{number.format(row.stockQuantity)}</b> ·
                      بيعت{" "}
                      <b className="font-bold tabular-nums">{number.format(row.soldInWindow)}</b>{" "}
                      خلال {number.format(row.windowDays)} يوماً ({number.format(row.dailyRate)}
                      /يوم)
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold ${urgent(row.daysRemaining) ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
                  >
                    {/* «~» is not decoration: it is the claim being made. */}
                    يكفي ~{number.format(row.daysRemaining ?? 0)} يوماً
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] leading-5 text-[var(--codiq-text-muted)]">
            هذه قائمة بما يوشك أن ينفد، لا جرد للمخزون. المنتج غير الموجود هنا لم يُبَع بما يكفي
            لتقدير معدله — وهذا لا يعني أن مخزونه وافر.
          </p>
        </>
      ) : null}
    </section>
  );
}
