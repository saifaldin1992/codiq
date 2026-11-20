/**
 * CD-3 «إرجاعاتي» — what the shopper asked for, and what he was told.
 *
 * The page is honest about what a request IS: an ask, not a return. A portal
 * that showed «تم الإرجاع» the moment he pressed the button would have him
 * expecting his money while the merchant has not even seen the request.
 *
 * A refusal is shown WITH ITS REASON, in full. A rejection the shopper cannot
 * read is a rejection he will phone about, and the merchant was required to
 * write one precisely so this line could exist.
 */
import { useCallback, useEffect, useState } from "react";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { Link } from "wouter";
import { CircleAlert, Clock3, LoaderCircle, PackageX, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { storefrontApi } from "@/lib/storefront-api";

type ReturnRequest = {
  id: string; status: "requested" | "approved" | "rejected" | "withdrawn"; reason: string;
  decisionNote: string | null; decidedAt: string | null; reversalDeadline: string; createdAt: string;
  order: { id: string; orderNumber: string; totalIqd: number };
};

const money = new Intl.NumberFormat("ar-IQ");
const day = (value: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));

/** Each state says what it MEANS for him, not what it is called in the database. */
const STATE: Record<ReturnRequest["status"], { label: string; meaning: string; tint: string }> = {
  requested: { label: "بانتظار رد التاجر", meaning: "وصل طلبك ولم يُجب عليه بعد.", tint: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" },
  approved: { label: "تمت الموافقة", meaning: "وافق التاجر وأُرجع الطلب.", tint: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  rejected: { label: "مرفوض", meaning: "رفض التاجر الطلب، والسبب مذكور أدناه.", tint: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
  withdrawn: { label: "سحبتَه", meaning: "سحبتَ هذا الطلب قبل أن يُجاب عليه.", tint: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]" },
};

export default function CustomerReturnsPage() {
  const { slug, customer, loading } = useStorefront();
  const [requests, setRequests] = useState<ReturnRequest[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const data = await storefrontApi.returns(slug, cursor);
      setRequests((current) => (cursor ? [...(current ?? []), ...data.requests] : data.requests));
      setNextCursor(data.nextCursor);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تحميل طلبات الإرجاع.");
    } finally {
      setLoadingMore(false);
    }
  }, [slug]);
  useEffect(() => { if (customer) void load(); }, [customer, load]);

  async function withdraw(item: ReturnRequest) {
    setBusyId(item.id);
    try { await storefrontApi.withdrawReturn(slug, item.id); await load(); }
    catch (error) { setFailure(error instanceof Error ? error.message : "تعذر السحب."); }
    finally { setBusyId(null); }
  }

  if (loading) return <p className="text-sm text-[var(--storefront-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> لحظة…</p>;
  if (!customer) {
    return (
      <section className="space-y-3">
        <h1 className="text-lg font-black text-[var(--storefront-text)]">إرجاعاتي</h1>
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-5 text-sm text-[var(--storefront-muted)]">
          سجّل الدخول لترى طلبات الإرجاع. <Link href={`/store/${slug}/account/login`} className="font-bold text-[var(--storefront-accent)] hover:underline">تسجيل الدخول</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-black text-[var(--storefront-text)]"><RotateCcw className="h-5 w-5" /> إرجاعاتي</h1>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {!requests ? <p className="text-sm text-[var(--storefront-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {requests && requests.length === 0 ? (
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-6 text-center text-sm text-[var(--storefront-muted)]">
          لا طلبات إرجاع. تجد زر «طلب إرجاع» داخل أي طلب استلمتَه.
        </p>
      ) : null}

      <ul className="space-y-2.5">
        {(requests ?? []).map((item) => {
          const state = STATE[item.status];
          return (
            <li key={item.id} className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/store/${slug}/account/orders/${item.order.id}`} className="text-sm font-bold text-[var(--storefront-text)] hover:underline">
                  الطلب <span dir="ltr">{item.order.orderNumber}</span> · {money.format(item.order.totalIqd)} د.ع
                </Link>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${state.tint}`}>{state.label}</span>
              </div>
              <p className="mt-1 text-[13px] text-[var(--storefront-muted)]">{state.meaning}</p>
              <p className="mt-1.5 text-[13px] leading-6 text-[var(--storefront-text)]">سببك: {item.reason}</p>
              {item.decisionNote ? (
                <p className="mt-1.5 rounded-xl bg-[var(--storefront-canvas)] px-3 py-2 text-[13px] leading-6 text-[var(--storefront-text)]">
                  رد التاجر: {item.decisionNote}
                </p>
              ) : null}
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--storefront-muted)]">
                <span>طُلب في {day(item.createdAt)}</span>
                {item.decidedAt ? <span>· أُجيب في {day(item.decidedAt)}</span> : null}
                {item.status === "requested" ? (
                  // The deadline is his information too: after it, the merchant
                  // can no longer settle it through the normal path.
                  <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden="true" /> مهلة المعالجة حتى {day(item.reversalDeadline)}</span>
                ) : null}
              </p>
              {item.status === "requested" ? (
                <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void withdraw(item)} className="mt-2 rounded-xl text-[var(--storefront-muted)]">
                  <PackageX className="ml-1 h-3.5 w-3.5" /> اسحب الطلب
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <LoadMoreButton tone="storefront" cursor={nextCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="returns-more" />
    </section>
  );
}
