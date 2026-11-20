/**
 * CD-2 — the reviews a shopper reads before buying, and the one he may write.
 *
 * Reading needs no account: a rating you must sign in to see is a rating that
 * does not do its job.
 *
 * A HIDDEN REVIEW STAYS ON THE PAGE, without its text and with its score. Two
 * reasons. A vanished row makes the count above disagree with what is on screen,
 * and a shopper who counts stars finds them missing. And the platform promises
 * the merchant can hide words but not scores — a page that quietly dropped the
 * whole row would break that promise where nobody could see it.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, ShieldCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { storefrontApi } from "@/lib/storefront-api";

type Review = { id: string; rating: number; body: string | null; hidden: boolean; author: string; createdAt: string; verifiedBuyer: boolean; mine: boolean };
type Summary = { average: number | null; count: number; hiddenCount: number; distribution: Record<string, number> };

const number = new Intl.NumberFormat("ar-IQ");
const day = (value: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));

/** ق-200: exported — the product header and the home page's review rail draw the same stars. */
export function Stars({ rating, label }: { rating: number; label?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={label ?? `${rating} من 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star key={star} aria-hidden="true" className={`h-4 w-4 ${star <= rating ? "fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" : "text-[var(--codiq-rating-empty)]"}`} />
      ))}
    </span>
  );
}

export function ProductReviews({ slug, productId, signedIn }: { slug: string; productId: string; signedIn: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // ق-175: two taps to withdraw — the first reveals the confirm, so a stray tap
  // on a phone does not erase what a shopper took the time to write.
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  async function withdraw(reviewId: string) {
    setBusy(true);
    setFailure(null);
    try {
      await storefrontApi.deleteReview(slug, reviewId);
      setWithdrawing(null);
      setNotice("سُحبت مراجعتك. يمكنك كتابة أخرى متى شئت.");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر سحب المراجعة.");
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const data = await storefrontApi.productReviews(slug, productId);
      setSummary(data.summary);
      setReviews(data.reviews);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تحميل المراجعات.");
    }
  }, [slug, productId]);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await storefrontApi.writeReview(slug, productId, { rating, body: body.trim() || undefined });
      setBody("");
      setNotice("شكراً — نُشرت مراجعتك.");
      await load();
    } catch (error) {
      // The purchase refusal is the one a shopper will actually meet, and the
      // server's wording already explains it; repeating a generic message here
      // would replace an answer with an apology.
      setNotice(error instanceof Error ? error.message : "تعذر إرسال المراجعة.");
    } finally {
      setBusy(false);
    }
  }

  if (failure) return <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p>;
  if (!summary) return <p className="text-sm text-[var(--storefront-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ تحميل المراجعات…</p>;

  return (
    <section className="space-y-4" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="text-lg font-black text-[var(--storefront-text)]">آراء المشترين</h2>

      {summary.count === 0 ? (
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-5 text-sm text-[var(--storefront-muted)]">
          لا مراجعات بعد. المراجعات هنا من مشترين فعليين فقط، فهي تتأخر قليلاً — وتستحق الانتظار.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-[var(--storefront-surface)] px-4 py-3.5">
          <div>
            <p className="text-3xl font-black tabular-nums text-[var(--storefront-text)]">{number.format(summary.average ?? 0)}</p>
            <Stars rating={Math.round(summary.average ?? 0)} label={`المعدل ${summary.average} من 5`} />
          </div>
          <div className="min-w-[160px] flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map((score) => {
              const count = summary.distribution[String(score)] ?? 0;
              const share = summary.count === 0 ? 0 : Math.round((count / summary.count) * 100);
              return (
                <div key={score} className="flex items-center gap-2 text-[11px] text-[var(--storefront-muted)]">
                  <span className="w-3 tabular-nums">{score}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--storefront-border)]">
                    <span className="block h-full rounded-full bg-[var(--codiq-rating)]" style={{ width: `${share}%` }} />
                  </span>
                  <span className="w-6 tabular-nums">{number.format(count)}</span>
                </div>
              );
            })}
          </div>
          <p className="w-full text-[11px] text-[var(--storefront-muted)]">
            {number.format(summary.count)} مراجعة من مشترين موثّقين
            {/* Stated, never subtracted quietly: the score of a hidden review is
                still inside the average above. */}
            {summary.hiddenCount > 0 ? <> · أخفى التاجر نصّ {number.format(summary.hiddenCount)} منها، وتقييمها ما زال محسوباً</> : null}
          </p>
        </div>
      )}

      <ul className="space-y-2.5">
        {reviews.map((review) => (
          <li key={review.id} className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Stars rating={review.rating} />
              <span className="text-sm font-bold text-[var(--storefront-text)]">{review.author}</span>
              {review.verifiedBuyer ? (
                <span className="flex items-center gap-1 rounded-full bg-[var(--storefront-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--storefront-accent)]">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" /> مشترٍ موثّق
                </span>
              ) : null}
              <span className="text-[11px] text-[var(--storefront-muted)]">{day(review.createdAt)}</span>
            </div>
            {review.mine ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {withdrawing === review.id ? (
                  <>
                    <span className="text-[12px] text-[var(--storefront-muted)]">تُسحب مراجعتك ويبقى لك أن تكتب غيرها.</span>
                    <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="review-withdraw-confirm" className="h-8 rounded-lg text-[12px] font-bold text-[var(--codiq-danger)]" onClick={() => void withdraw(review.id)}>تأكيد السحب</Button>
                    <Button type="button" size="sm" variant="ghost" className="h-8 rounded-lg text-[12px]" onClick={() => setWithdrawing(null)}>إبقاؤها</Button>
                  </>
                ) : (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="review-withdraw" className="h-8 rounded-lg text-[12px] font-bold text-[var(--storefront-muted)]" onClick={() => setWithdrawing(review.id)}>سحب مراجعتي</Button>
                )}
              </div>
            ) : null}
            {review.hidden ? (
              <p className="mt-1.5 text-[13px] italic text-[var(--storefront-muted)]">أخفى التاجر نصّ هذه المراجعة. تقييمها أعلاه ما زال محسوباً ضمن المعدل.</p>
            ) : review.body ? (
              <p className="mt-1.5 text-[13px] leading-6 text-[var(--storefront-text)]">{review.body}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {signedIn ? (
        <form onSubmit={submit} className="space-y-2.5 rounded-2xl bg-[var(--storefront-surface)] px-4 py-3.5">
          <p className="text-sm font-bold text-[var(--storefront-text)]">اكتب رأيك</p>
          <fieldset className="flex items-center gap-1.5">
            <legend className="sr-only">تقييمك من 1 إلى 5</legend>
            {[1, 2, 3, 4, 5].map((star) => (
              <label key={star} className="cursor-pointer">
                <input type="radio" name="rating" value={star} checked={rating === star} onChange={() => setRating(star)} className="sr-only" />
                <Star aria-hidden="true" className={`h-6 w-6 ${star <= rating ? "fill-[var(--codiq-rating)] text-[var(--codiq-rating)]" : "text-[var(--codiq-rating-empty)]"}`} />
                <span className="sr-only">{star} من 5</span>
              </label>
            ))}
          </fieldset>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="ما الذي أعجبك، وما الذي لم يعجبك؟"
            className="w-full rounded-xl border border-[var(--storefront-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--storefront-text)] outline-none focus:border-[var(--storefront-accent)]"
          />
          {notice ? <p className="text-[13px] font-semibold text-[var(--storefront-accent)]">{notice}</p> : null}
          <Button type="submit" disabled={busy} className="rounded-xl bg-[var(--storefront-accent)] hover:bg-[var(--storefront-accent-hover)]">
            {busy ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : null}إرسال
          </Button>
          <p className="text-[11px] text-[var(--storefront-muted)]">تُقبل المراجعات من زبون استلم هذا المنتج فعلاً. هذا ما يجعل النجوم أعلاه تعني شيئاً.</p>
        </form>
      ) : (
        <p className="rounded-2xl bg-[var(--storefront-surface)] px-4 py-3 text-[13px] text-[var(--storefront-muted)]">
          سجّل الدخول لتكتب رأيك — وتُقبل المراجعة إن كنت قد استلمت هذا المنتج.
        </p>
      )}
    </section>
  );
}
