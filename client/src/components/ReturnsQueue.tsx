/**
 * CD-3 — the merchant's returns queue.
 *
 * The screen states the consequence before he acts, because approving here is
 * not a note: it moves the order to «مرتجع» and reverses the sale in the ledger,
 * exactly as if he had done it from the orders screen. A button that looked like
 * an acknowledgement and quietly reversed money would be the worst kind of
 * surprise.
 *
 * It also shows the DEADLINE, and warns as it nears. After it, approving still
 * works but the automatic reversal no longer does — the platform owner has to
 * adjust it by hand, and the merchant deserves to know that before it costs him.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Clock3, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type ReturnRequest = {
  id: string;
  status: string;
  reason: string;
  decisionNote: string | null;
  decidedAt: string | null;
  reversalDeadline: string;
  createdAt: string;
  order: { id: string; orderNumber: string; totalIqd: number; status: string };
  customer: { fullName: string; phone: string | null };
};

const money = new Intl.NumberFormat("ar-IQ");
const day = (value: string) =>
  new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(
    new Date(value)
  );
const daysLeft = (iso: string) => Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);

const STATUS_LABEL: Record<string, { label: string; tint: string }> = {
  requested: {
    label: "بانتظار ردّك",
    tint: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]",
  },
  approved: {
    label: "موافَق عليه",
    tint: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]",
  },
  rejected: { label: "مرفوض", tint: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
  withdrawn: {
    label: "سحبه الزبون",
    tint: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
  },
};

export function ReturnsQueue({ storeSlug }: { storeSlug: string }) {
  const [requests, setRequests] = useState<ReturnRequest[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // 20-2: oldest first and keyset-paged. The queue used to answer with a fixed
  // twenty rows and no way past them.
  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(
          `/api/merchant/stores/${encodeURIComponent(storeSlug)}/returns?${query.toString()}`,
          { credentials: "same-origin" }
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل طلبات الإرجاع.");
        setRequests((current) => (cursor ? [...(current ?? []), ...body.requests] : body.requests));
        setNextCursor(body.nextCursor ?? null);
        setFailure(null);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      } finally {
        setLoadingMore(false);
      }
    },
    [storeSlug]
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: ReturnRequest, approve: boolean, why?: string) {
    setBusyId(item.id);
    try {
      const response = await fetch(
        `/api/merchant/stores/${encodeURIComponent(storeSlug)}/returns/${item.id}/decision`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approve, ...(approve ? {} : { note: why }) }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر حفظ القرار.");
      setRejectFor(null);
      setNote("");
      setFailure(null);
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-[1030px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <RotateCcw className="h-4 w-4" /> طلبات الإرجاع
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

      {/* Said before he presses, not after he is surprised. */}
      <p className="rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-[13px] leading-6 text-[var(--codiq-text)]">
        الموافقة هنا <b className="font-bold">تُرجع الطلب فعلياً</b>: تنقله إلى «مرتجع» وتعكس البيع
        في سجلك المالي — تماماً كما لو فعلتها من شاشة الطلبات. والرفض يحتاج سبباً{" "}
        <b className="font-bold">يقرؤه الزبون</b>. كلا القرارين يُسجَّل في سجل نشاط متجرك.
      </p>

      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {!requests && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {requests && requests.length === 0 ? (
        <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">
          لا طلبات إرجاع.
        </p>
      ) : null}

      <ul className="space-y-2">
        {(requests ?? []).map((item) => {
          const status = STATUS_LABEL[item.status] ?? {
            label: item.status,
            tint: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
          };
          const left = daysLeft(item.reversalDeadline);
          const open = item.status === "requested";
          return (
            <li
              key={item.id}
              className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-[var(--codiq-text)]">
                    الطلب <span dir="ltr">{item.order.orderNumber}</span>
                  </span>
                  <span className="text-[11px] text-[var(--codiq-text-muted)]">
                    {money.format(item.order.totalIqd)} د.ع · {item.customer.fullName}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${status.tint}`}>
                    {status.label}
                  </span>
                </div>
                {open ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() => void decide(item, true)}
                      className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
                    >
                      وافق وأرجِع
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === item.id}
                      onClick={() => {
                        setRejectFor(item.id);
                        setNote("");
                      }}
                      className="rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"
                    >
                      ارفض
                    </Button>
                  </div>
                ) : null}
              </div>

              <p className="mt-1.5 text-[13px] leading-6 text-[var(--codiq-text-secondary)]">
                سبب الزبون: {item.reason}
              </p>
              {item.decisionNote ? (
                <p className="mt-1 text-[12px] text-[var(--codiq-text-muted)]">
                  ردّك: {item.decisionNote}
                </p>
              ) : null}

              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--codiq-text-muted)]">
                <span>طُلب في {day(item.createdAt)}</span>
                {open ? (
                  <span
                    className={`flex items-center gap-1 ${left <= 3 ? "font-bold text-[var(--codiq-danger)]" : ""}`}
                  >
                    <Clock3 className="h-3 w-3" aria-hidden="true" />
                    {left > 0
                      ? `يتبقى ${money.format(left)} يوماً على العكس المالي التلقائي`
                      : "انتهت مهلة العكس التلقائي — الموافقة الآن تحتاج تسوية يدوية من المالك"}
                  </span>
                ) : null}
              </p>

              {rejectFor === item.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void decide(item, false, note.trim());
                  }}
                  className="mt-2.5 space-y-2 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5"
                >
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                      سبب الرفض (مطلوب — يراه الزبون)
                    </span>
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={1000}
                      required
                      placeholder="مثال: المنتج مستعمل ولا يقبل الإرجاع"
                      className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busyId === item.id || !note.trim()}
                      className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
                    >
                      تأكيد الرفض
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRejectFor(null)}
                      className="rounded-xl text-[var(--codiq-text-secondary)]"
                    >
                      إلغاء
                    </Button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      <LoadMoreButton
        cursor={nextCursor}
        busy={loadingMore}
        onLoad={(cursor) => void load(cursor)}
        testId="returns-queue-more"
      />
    </div>
  );
}
