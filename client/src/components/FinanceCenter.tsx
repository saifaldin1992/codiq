/**
 * codiq phase 17 — platform-owner finance center: period report per merchant,
 * settlement recording (append-only), and manual late-return adjustments.
 */
import { useCallback, useEffect, useState } from "react";
import { Banknote, CircleAlert, LoaderCircle, RefreshCw, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type Totals = {
  completedOrders: number;
  reversedOrders: number;
  subtotalIqd: number;
  deliveryFeeIqd: number;
  loyaltyDiscountIqd: number;
  commissionIqd: number;
};
type MerchantRow = {
  merchantId: string;
  email: string;
  businessName: string;
  totals: Totals;
  deliveryToSubtotalBps: number | null;
};
type Report = { period: { from: string; to: string }; totals: Totals; merchants: MerchantRow[] };
type Settlement = {
  id: string;
  periodFrom: string;
  periodTo: string;
  ordersCount: number;
  commissionIqd: number;
  subtotalIqd: number;
  deliveryFeeIqd: number;
  loyaltyDiscountIqd: number | null;
  netPayoutIqd: number | null;
  note: string | null;
  createdAt: string;
};
type SettlementPreview = {
  periodFrom: string;
  periodTo: string;
  ordersCount: number;
  subtotalIqd: number;
  deliveryFeeIqd: number;
  loyaltyDiscountIqd: number;
  commissionIqd: number;
  netPayoutIqd: number;
};

/**
 * Audit 17-ب: what the platform owes — the same formula as the merchant's wallet
 * (`netPayout` in merchant-wallet.service.ts). The four cards alone invited
 * «sales + delivery − commission», which overstates it by the redeemed points.
 */
const netDue = (totals: Totals) =>
  totals.subtotalIqd + totals.deliveryFeeIqd - totals.loyaltyDiscountIqd - totals.commissionIqd;

const money = new Intl.NumberFormat("ar-IQ");
const dateOnly = (value: string | Date) => new Date(value).toISOString().slice(0, 10);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function TotalsCards({ totals }: { totals: Totals }) {
  const cards = [
    {
      label: "طلبات مكتملة (صافي)",
      value: money.format(totals.completedOrders - totals.reversedOrders),
    },
    { label: "مبيعات (صافي)", value: `${money.format(totals.subtotalIqd)} د.ع` },
    { label: "توصيل", value: `${money.format(totals.deliveryFeeIqd)} د.ع` },
    { label: "نقاط ولاء مستردة", value: `${money.format(totals.loyaltyDiscountIqd)} د.ع` },
    { label: "عمولات المنصة", value: `${money.format(totals.commissionIqd)} د.ع` },
    { label: "المستحق للتجار (صافي)", value: `${money.format(netDue(totals))} د.ع` },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-3.5 shadow-sm"
        >
          <p className="text-[11px] font-semibold text-[#8A96A9]">{card.label}</p>
          <p
            className="mt-1 text-lg font-bold text-[#243855]"
            data-testid={`finance-total-${card.label}`}
          >
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function FinanceCenter() {
  const now = new Date();
  const [from, setFrom] = useState(
    dateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
  );
  const [to, setTo] = useState(dateOnly(now));
  const [report, setReport] = useState<Report | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settleFor, setSettleFor] = useState<MerchantRow | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  // 20-2: a merchant's settlement history is a keyset page, not a fixed 100.
  const [history, setHistory] = useState<{
    merchant: MerchantRow;
    rows: Settlement[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [adjustOrderId, setAdjustOrderId] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<Report>(
        `/api/platform/finance/report?from=${from}T00:00:00Z&to=${to}T23:59:59Z`
      );
      setReport(result);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setReport(null);
    }
  }, [from, to]);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * ق-233: where THIS merchant's next period must begin — the instant his last
   * one ended, to the millisecond. The screen used to send the REPORT's date
   * range, which has nothing to do with him: every settlement after his first
   * left the hours between his last `periodTo` and some midnight in no
   * settlement and in no pending balance. The server and a database trigger
   * both refuse that now; this is what lets the operator succeed rather than
   * read a refusal.
   */
  async function settlementAnchor(merchant: MerchantRow): Promise<string | null> {
    const result = await api<{ settlements: Settlement[] }>(
      `/api/platform/finance/settlements/${merchant.merchantId}?limit=1`
    );
    return result.settlements[0]?.periodTo ?? null;
  }

  /**
   * Audit 17-ب: the form states the amount BEFORE the button. The preview runs
   * the server's own settlement computation over the exact period the confirm
   * will send (anchored at his previous settlement, clamped to now), so the
   * figure read here is the figure recorded — or the confirm is refused.
   */
  async function openSettle(merchant: MerchantRow) {
    setSettleFor(merchant);
    setPreview(null);
    setFailure(null);
    try {
      // His first settlement has no anchor, so the chosen start stands; every
      // one after it continues exactly where the previous stopped.
      const anchor = await settlementAnchor(merchant);
      const query = new URLSearchParams({
        periodFrom: anchor ?? `${from}T00:00:00Z`,
        periodTo: `${to}T23:59:59Z`,
      });
      const result = await api<{ preview: SettlementPreview }>(
        `/api/platform/finance/settlements/${merchant.merchantId}/preview?${query.toString()}`
      );
      setPreview(result.preview);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      setSettleFor(null);
    }
  }

  async function settle(merchant: MerchantRow, note: string) {
    if (!preview) return;
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/platform/finance/settlements", {
        method: "POST",
        body: JSON.stringify({
          merchantId: merchant.merchantId,
          periodFrom: preview.periodFrom,
          periodTo: preview.periodTo,
          expectedNetPayoutIqd: preview.netPayoutIqd,
          note,
        }),
      });
      setNotice(
        `سُجلت تسوية «${merchant.businessName}» بمبلغ ${money.format(preview.netPayoutIqd)} د.ع حتى ${dateOnly(preview.periodTo)} — سجل غير قابل للتعديل.`
      );
      setSettleFor(null);
      setPreview(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  async function openHistory(merchant: MerchantRow, cursor?: string) {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await api<{ settlements: Settlement[]; nextCursor: string | null }>(
        `/api/platform/finance/settlements/${merchant.merchantId}?${query.toString()}`
      );
      setHistory((current) => ({
        merchant,
        rows:
          cursor && current?.merchant.merchantId === merchant.merchantId
            ? [...current.rows, ...result.settlements]
            : result.settlements,
        nextCursor: result.nextCursor,
      }));
    } finally {
      setLoadingMore(false);
    }
  }

  async function adjust() {
    if (!adjustOrderId.trim()) return;
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await api("/api/platform/finance/adjustments", {
        method: "POST",
        body: JSON.stringify({ orderId: adjustOrderId.trim(), note: "تسوية إرجاع خارج النافذة" }),
      });
      setNotice("سُجل قيد التسوية اليدوية للإرجاع المتأخر.");
      setAdjustOrderId("");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[1030px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <Banknote className="h-4 w-4" /> السجل المالي — قيود append-only محمية في قاعدة البيانات
        </p>
        <div className="flex items-end gap-2">
          <label className="block space-y-1 text-[11px] font-semibold text-[#44526A]">
            <span>من</span>
            <Input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9"
              dir="ltr"
            />
          </label>
          <label className="block space-y-1 text-[11px] font-semibold text-[#44526A]">
            <span>إلى</span>
            <Input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-9"
              dir="ltr"
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="rounded-xl text-[var(--codiq-text-secondary)]"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          data-testid="finance-notice"
          className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
        >
          {notice}
        </p>
      ) : null}
      {report === null && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {report ? (
        <>
          <TotalsCards totals={report.totals} />
          <div className="space-y-2">
            {report.merchants.length === 0 ? (
              <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-4 text-sm text-[var(--codiq-text-muted)] shadow-sm">
                لا توجد قيود مالية في هذه الفترة.
              </p>
            ) : null}
            {report.merchants.map((merchant) => (
              <div
                key={merchant.merchantId}
                data-testid={`finance-merchant-${merchant.email}`}
                className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[#263650]">
                      {merchant.businessName}
                    </p>
                    <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                      {merchant.email}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[#65748B]">
                      مبيعات: {money.format(merchant.totals.subtotalIqd)} د.ع
                    </span>
                    <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 font-bold text-[var(--codiq-accent-hover)]">
                      عمولة: {money.format(merchant.totals.commissionIqd)} د.ع
                    </span>
                    {/* 19-د: delivery is outside the commission base by design (ADR-006), so
                        a merchant can move his takings into it. The ratio is shown BESIDE
                        the commission — the two were reported on this screen without ever
                        being related — and highlighted once delivery outweighs the goods,
                        which is the shape of the shift rather than a verdict on it. */}
                    {merchant.deliveryToSubtotalBps === null ? null : (
                      <span
                        className={`rounded-full px-2.5 py-1 ${merchant.deliveryToSubtotalBps > 10000 ? "bg-[var(--codiq-danger-soft)] font-bold text-[var(--codiq-danger)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-muted)]"}`}
                        title="نسبة أجور التوصيل إلى المبيعات في هذه الفترة"
                      >
                        توصيل/مبيعات: {(merchant.deliveryToSubtotalBps / 100).toFixed(1)}%
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-xl border-[var(--codiq-border-strong)]"
                      onClick={() => void openHistory(merchant)}
                    >
                      التسويات
                    </Button>
                    <Button
                      data-testid={`finance-settle-${merchant.email}`}
                      size="sm"
                      disabled={busy}
                      className="rounded-xl bg-[var(--codiq-accent)] text-white hover:bg-[var(--codiq-accent-hover)]"
                      onClick={() => void openSettle(merchant)}
                    >
                      تسوية الفترة
                    </Button>
                  </div>
                </div>
                {settleFor?.merchantId === merchant.merchantId ? (
                  <form
                    className="mt-3 space-y-2 rounded-xl bg-[var(--codiq-surface-sunken)] p-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void settle(
                        merchant,
                        String(new FormData(event.currentTarget).get("note") ?? "")
                      );
                    }}
                  >
                    {preview ? (
                      <div
                        data-testid="finance-settle-preview"
                        className="rounded-xl bg-[var(--codiq-surface)] px-4 py-3 shadow-sm"
                      >
                        <p className="text-[11px] font-semibold text-[var(--codiq-text-muted)]">
                          المبلغ الذي ستحوّله للتاجر عن الفترة{" "}
                          <span dir="ltr">
                            {dateOnly(preview.periodFrom)} → {dateOnly(preview.periodTo)}
                          </span>
                        </p>
                        <p
                          data-testid="finance-settle-amount"
                          className="mt-1 text-2xl font-black tabular-nums text-[var(--codiq-text)]"
                        >
                          {money.format(preview.netPayoutIqd)} د.ع
                        </p>
                        <p className="mt-1 text-[11px] leading-6 text-[var(--codiq-text-muted)]">
                          مبيعات {money.format(preview.subtotalIqd)} + توصيل{" "}
                          {money.format(preview.deliveryFeeIqd)} − نقاط{" "}
                          {money.format(preview.loyaltyDiscountIqd)} − عمولة{" "}
                          {money.format(preview.commissionIqd)} ·{" "}
                          {money.format(preview.ordersCount)} طلب
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--codiq-text-muted)]">
                        <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ حساب
                        المبلغ…
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        name="note"
                        placeholder="ملاحظة (مثال: حُوّلت عبر زين كاش)"
                        className="h-9 flex-1"
                      />
                      <Button
                        data-testid="finance-settle-confirm"
                        size="sm"
                        disabled={busy || !preview}
                        className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]"
                      >
                        تأكيد التسوية
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        className="rounded-xl"
                        onClick={() => {
                          setSettleFor(null);
                          setPreview(null);
                        }}
                      >
                        إلغاء
                      </Button>
                    </div>
                  </form>
                ) : null}
                {history?.merchant.merchantId === merchant.merchantId ? (
                  <div className="mt-3 space-y-1.5 rounded-xl bg-[var(--codiq-surface-sunken)] p-3">
                    {history.rows.length === 0 ? (
                      <p className="text-xs text-[var(--codiq-text-muted)]">
                        لا توجد تسويات مسجلة لهذا التاجر.
                      </p>
                    ) : null}
                    {history.rows.map((row) => (
                      <p
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--codiq-surface)] px-3 py-2 text-xs text-[#44526A] shadow-sm"
                      >
                        <span dir="ltr">
                          {dateOnly(row.periodFrom)} → {dateOnly(row.periodTo)}
                        </span>
                        <span>
                          <b className="text-[var(--codiq-text)]">
                            المحوَّل: {money.format(row.netPayoutIqd ?? 0)} د.ع
                          </b>{" "}
                          · طلبات: {row.ordersCount} · عمولة: {money.format(row.commissionIqd)} د.ع
                          {row.note ? ` · ${row.note}` : ""}
                        </span>
                      </p>
                    ))}
                    <LoadMoreButton
                      cursor={history.nextCursor}
                      busy={loadingMore}
                      onLoad={(cursor) => void openHistory(merchant, cursor)}
                      testId="platform-settlements-more"
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-5">
        <p className="mb-3 flex items-center gap-2 text-xs font-bold text-[#44526A]">
          <Scale className="h-4 w-4 text-[var(--codiq-accent)]" /> تسوية إرجاع خارج نافذة الـ15
          يوماً (قيد يدوي append-only)
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-testid="finance-adjust-order"
            value={adjustOrderId}
            onChange={(event) => setAdjustOrderId(event.target.value)}
            placeholder="معرّف الطلب (UUID)"
            className="h-9 flex-1"
            dir="ltr"
          />
          <Button
            data-testid="finance-adjust-submit"
            size="sm"
            disabled={busy || !adjustOrderId.trim()}
            onClick={() => void adjust()}
            className="rounded-xl bg-[#80584A] text-white hover:bg-[#6E493E]"
          >
            تسجيل قيد الإرجاع
          </Button>
        </div>
      </div>
    </div>
  );
}
