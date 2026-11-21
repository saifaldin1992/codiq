/** All of a store's reviews, newest first, paged. */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { ChevronLeft, LoaderCircle, Star } from "lucide-react";
import { marketGet } from "../market-api";
import { ReviewItem } from "./MarketStorePage";
import { MarketEmptyState } from "../MarketEmptyState";

type Review = Parameters<typeof ReviewItem>[0]["review"];

export function MarketStoreReviewsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const base = `/api/market/stores/${encodeURIComponent(slug)}/reviews?limit=20`;
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    marketGet<{ reviews: Review[]; nextCursor: string | null }>(base).then((page) => { setReviews(page.reviews); setCursor(page.nextCursor); }).catch((error: Error) => setFailure(error.message));
  }, [base]);

  const more = useCallback(async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await marketGet<{ reviews: Review[]; nextCursor: string | null }>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setReviews((current) => [...(current ?? []), ...page.reviews]);
      setCursor(page.nextCursor);
    } finally { setBusy(false); }
  }, [base, cursor]);

  return (
    <div className="space-y-4" data-testid="market-store-reviews-page">
      <Link href={`/s/${encodeURIComponent(slug)}`} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"><ChevronLeft className="h-4 w-4 rotate-180" /> رجوع للمتجر</Link>
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تقييمات المتجر</h1>
      {failure ? <p className="text-sm text-[var(--codiq-danger)]">{failure}</p> : null}
      {!reviews && !failure ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {reviews?.length === 0 ? <MarketEmptyState icon={Star} title="لا توجد تقييمات بعد" /> : null}
      {reviews?.length ? <ul className="space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">{reviews.map((review) => <ReviewItem key={review.id} review={review} />)}</ul> : null}
      {cursor ? <button type="button" disabled={busy} onClick={() => void more()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} عرض المزيد</button> : null}
    </div>
  );
}
