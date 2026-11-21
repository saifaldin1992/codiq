/**
 * codiq — merchant delivery-rate management (settings ← shipping).
 * The 18 governorate rows are seeded disabled at store creation; a store can
 * only receive checkout orders for governorates enabled here with a price.
 */
import { useCallback, useEffect, useState } from "react";
import { governorateLabel } from "@/lib/governorates";
import { CircleAlert, LoaderCircle, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";

type Rate = { governorate: string; amountIqd: number; isEnabled: boolean; updatedAt: string };

const numberFormat = new Intl.NumberFormat("ar-IQ");

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "تعذر تنفيذ الطلب."
    );
  return body as T;
}

export function DeliveryRatesManager({ storeSlug }: { storeSlug?: string }) {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyGovernorate, setBusyGovernorate] = useState<string | null>(null);
  const base = storeSlug
    ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/delivery-rates`
    : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const result = await api<{ rates: Rate[] }>(base);
      setRates(result.rates);
      setDrafts(
        Object.fromEntries(result.rates.map((rate) => [rate.governorate, String(rate.amountIqd)]))
      );
      setFailure(null);
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.code === "STAFF_PERMISSION_DENIED"
          ? "هذه الجلسة لا تملك صلاحية إدارة الإعدادات (403)."
          : error instanceof Error
            ? error.message
            : "خطأ غير متوقع."
      );
      setRates(null);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(governorate: string, body: { amountIqd?: number; isEnabled?: boolean }) {
    if (!base) return;
    setBusyGovernorate(governorate);
    setNotice(null);
    try {
      const result = await api<{ rate: Rate }>(`${base}/${encodeURIComponent(governorate)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setRates(
        (current) =>
          current?.map((rate) => (rate.governorate === governorate ? result.rate : rate)) ?? null
      );
      setDrafts((current) => ({ ...current, [governorate]: String(result.rate.amountIqd) }));
      setNotice(`حُفظ سعر التوصيل لمحافظة ${governorateLabel(governorate)}.`);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusyGovernorate(null);
    }
  }

  function submitAmount(rate: Rate) {
    const draft = (drafts[rate.governorate] ?? "").trim();
    const amount = Number(draft);
    if (!Number.isInteger(amount) || amount < 0) {
      setFailure("سعر التوصيل يجب أن يكون رقمًا صحيحًا غير سالب بالدينار العراقي.");
      return;
    }
    if (amount === rate.amountIqd) return;
    void save(rate.governorate, { amountIqd: amount });
  }

  if (!storeSlug) {
    return (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 text-sm font-semibold text-[var(--codiq-danger)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        افتح اللوحة عبر مسار متجر محدد قبل إدارة التوصيل.
      </div>
    );
  }

  const enabledCount = rates?.filter((rate) => rate.isEnabled).length ?? 0;

  return (
    <div className="max-w-[1030px] space-y-5">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <Truck className="h-4 w-4" /> أسعار التوصيل حسب المحافظة
        </p>
        <h2 className="mb-1 text-xl font-bold text-[#263650]">أين يوصّل متجرك وبكم؟</h2>
        <p className="mb-5 text-sm leading-6 text-[var(--codiq-text-muted)]">
          لا يقبل المتجر أي طلب شراء لمحافظة غير مفعّلة هنا. فعّل المحافظات التي تغطيها وحدّد سعر
          التوصيل بالدينار العراقي.
        </p>
        {failure ? (
          <p
            data-testid="delivery-error"
            className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          >
            <CircleAlert className="h-4 w-4" /> {failure}
          </p>
        ) : null}
        {notice ? (
          <p
            data-testid="delivery-notice"
            className="mb-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          >
            {notice}
          </p>
        ) : null}
        {rates === null && !failure ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">
            <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
          </p>
        ) : null}
        {rates ? (
          <div className="space-y-4">
            <p
              data-testid="delivery-enabled-count"
              className="inline-flex items-center gap-2 rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1.5 text-xs font-semibold text-[#65748B]"
            >
              المحافظات المفعّلة: {numberFormat.format(enabledCount)} من{" "}
              {numberFormat.format(rates.length)}
            </p>
            <div className="grid gap-2 lg:grid-cols-2">
              {rates.map((rate) => (
                <div
                  key={rate.governorate}
                  data-testid={`delivery-rate-${rate.governorate}`}
                  className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 ${rate.isEnabled ? "bg-[var(--codiq-surface-sunken)]" : "bg-[var(--codiq-surface-sunken)] opacity-80"}`}
                >
                  <label className="flex min-w-0 items-center gap-3">
                    <input
                      data-testid={`delivery-toggle-${rate.governorate}`}
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-[var(--codiq-accent)]"
                      checked={rate.isEnabled}
                      disabled={busyGovernorate === rate.governorate}
                      onChange={(event) =>
                        void save(rate.governorate, { isEnabled: event.target.checked })
                      }
                    />
                    <span className="truncate text-sm font-bold text-[#33435D]">
                      {governorateLabel(rate.governorate)}
                    </span>
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    <input
                      data-testid={`delivery-amount-${rate.governorate}`}
                      type="number"
                      min={0}
                      step={250}
                      inputMode="numeric"
                      className="w-24 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2.5 py-1.5 text-left text-sm font-semibold text-[#33435D] outline-none focus:border-[var(--codiq-accent)]"
                      value={drafts[rate.governorate] ?? String(rate.amountIqd)}
                      disabled={busyGovernorate === rate.governorate}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [rate.governorate]: event.target.value,
                        }))
                      }
                      onBlur={() => submitAmount(rate)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitAmount(rate);
                      }}
                    />
                    <span className="text-xs font-semibold text-[#8A96A9]">د.ع</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-xs font-semibold text-[#65748B]">
              <span>يُحفظ السعر عند مغادرة الحقل أو بضغط Enter، ويُحفظ التفعيل فور تبديله.</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-[var(--codiq-accent)]"
                onClick={() => void load()}
              >
                تحديث
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
