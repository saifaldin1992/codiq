/**
 * CD-2 — the merchant's review queue.
 *
 * The screen states the boundary before he uses it, because the boundary is not
 * what he will expect: hiding takes the WORDS, and the score stays in his
 * rating. A merchant who discovers that after hiding a one-star review and
 * seeing his average unmoved will think it a bug; told first, it reads as what
 * it is — the reason a CODIQ rating is worth something to his shoppers.
 *
 * The reason field is required and it is not private: it goes into the store's
 * activity log, which the platform owner reads.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Eye, EyeOff, LoaderCircle, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";

type Review = {
  id: string; rating: number; body: string | null; hiddenAt: string | null; hiddenReason: string | null; createdAt: string;
  product: { id: string; name: string };
  customer: { fullName: string };
  orderId: string;
};

const day = (value: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));

export function ReviewModeration({ storeSlug }: { storeSlug: string }) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/reviews`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل المراجعات.");
      setReviews(body.reviews);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [storeSlug]);
  useEffect(() => { void load(); }, [load]);

  async function setHidden(review: Review, hidden: boolean, why?: string) {
    setBusyId(review.id);
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/reviews/${review.id}/hidden`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden, ...(hidden ? { reason: why } : {}) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر الحفظ.");
      setReasonFor(null);
      setReason("");
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
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Star className="h-4 w-4" /> مراجعات منتجاتك</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* Said before he acts, not after he is surprised. */}
      <p className="rounded-2xl bg-[var(--codiq-accent-soft)] px-4 py-3 text-[13px] leading-6 text-[var(--codiq-text)]">
        تستطيع إخفاء <b className="font-bold">نصّ</b> أي مراجعة — لا تقييمها. النجوم تبقى ضمن معدل منتجك، وواجهة المتجر تذكر أن هناك مراجعة مخفية.
        هذا ما يجعل تقييمك ذا قيمة أمام الزبون: لو استطاع أي تاجر حذف النجمة الواحدة، لما صدّق أحد الخمس نجوم.
        سبب الإخفاء يُسجَّل في سجل نشاط متجرك ويطّلع عليه مالك المنصة.
      </p>

      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {!reviews && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {reviews && reviews.length === 0 ? <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">لا مراجعات بعد.</p> : null}

      <ul className="space-y-2">
        {(reviews ?? []).map((review) => (
          <li key={review.id} className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-0.5" role="img" aria-label={`${review.rating} من 5`}>
                  {[1, 2, 3, 4, 5].map((star) => <Star key={star} aria-hidden="true" className={`h-3.5 w-3.5 ${star <= review.rating ? "fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" : "text-[var(--codiq-rating-empty)]"}`} />)}
                </span>
                <span className="text-sm font-bold text-[var(--codiq-text)]">{review.product.name}</span>
                <span className="text-[11px] text-[var(--codiq-text-muted)]">{review.customer.fullName} · {day(review.createdAt)}</span>
                {review.hiddenAt ? <span className="rounded-full bg-[var(--codiq-warning-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--codiq-warning)]">النص مخفي</span> : null}
              </div>
              {review.hiddenAt ? (
                <Button size="sm" variant="outline" disabled={busyId === review.id} onClick={() => void setHidden(review, false)} className="rounded-xl">
                  <Eye className="ml-1 h-3.5 w-3.5" />إظهار النص
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busyId === review.id} onClick={() => { setReasonFor(review.id); setReason(""); }} className="rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]">
                  <EyeOff className="ml-1 h-3.5 w-3.5" />إخفاء النص
                </Button>
              )}
            </div>

            {review.body ? <p className="mt-1.5 text-[13px] leading-6 text-[var(--codiq-text-secondary)]">{review.body}</p> : <p className="mt-1.5 text-[13px] italic text-[var(--codiq-text-muted)]">تقييم بلا نص.</p>}
            {review.hiddenReason ? <p className="mt-1 text-[11px] text-[var(--codiq-text-muted)]">سبب الإخفاء: {review.hiddenReason}</p> : null}

            {reasonFor === review.id ? (
              <form
                onSubmit={(event) => { event.preventDefault(); void setHidden(review, true, reason.trim()); }}
                className="mt-2.5 space-y-2 rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5"
              >
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-[var(--codiq-text-secondary)]">سبب الإخفاء (مطلوب)</span>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    required
                    placeholder="مثال: لغة مسيئة، أو مراجعة عن منتج آخر"
                    className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
                  />
                </label>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busyId === review.id || !reason.trim()} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">تأكيد الإخفاء</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setReasonFor(null)} className="rounded-xl text-[var(--codiq-text-secondary)]">إلغاء</Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
