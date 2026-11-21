/**
 * «قيّم طلبك» (Marketplace M6, G6): stars for each product — they become the
 * store's verified-buyer reviews — stars for the delivery, tags, and a note.
 * Also «بانتظار تقييمك» (the completed orders not rated yet) and «تقييماتي».
 */
import { useState } from "react";
import { Link } from "wouter";
import { LoaderCircle, MessageSquareHeart, Star } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { useMarketList } from "../use-market-list";
import { MarketSignIn } from "./MarketAccountPages";
import { MarketEmptyState } from "../MarketEmptyState";

export type RatingTag = { code: string; label: string; tone: "positive" | "negative" };
export type OrderRating = {
  deliveryRating: number | null;
  tags: RatingTag[];
  note: string | null;
  products: { productId: string; rating: number; comment: string | null }[];
  ratedAt: string | null;
};
type RatedItem = { productId: string | null; productName: string };

function Stars({ value, onChange, label, testId }: { value: number; onChange: (value: number) => void; label: string; testId: string }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label={label} data-testid={testId}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button key={star} type="button" role="radio" aria-checked={value === star} aria-label={`${star.toLocaleString("ar-IQ")} من ٥`} onClick={() => onChange(star)} data-testid={`${testId}-${star}`}>
          <Star className={`h-6 w-6 ${star <= value ? "fill-[var(--codiq-warning)] text-[var(--codiq-warning)]" : "text-[var(--codiq-border)]"}`} />
        </button>
      ))}
    </div>
  );
}

/** The rating form on a completed order. Opens filled with the earlier rating, if any, so it can be revised. */
export function OrderRatingForm({ orderId, items, fulfilment, tags, rating, onSaved }: { orderId: string; items: RatedItem[]; fulfilment: string; tags: RatingTag[]; rating: OrderRating | null; onSaved: (rating: OrderRating) => void }) {
  const products = Array.from(new Map(items.filter((item) => item.productId).map((item) => [item.productId as string, item.productName])).entries());
  const [stars, setStars] = useState<Record<string, number>>(() => Object.fromEntries((rating?.products ?? []).map((row) => [row.productId, row.rating])));
  const [delivery, setDelivery] = useState(rating?.deliveryRating ?? 0);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((rating?.tags ?? []).map((tag) => tag.code)));
  const [note, setNote] = useState(rating?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const toggle = (code: string) => setChosen((current) => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  const anything = Object.keys(stars).length > 0 || delivery > 0 || chosen.size > 0 || note.trim().length > 0;
  const save = async () => {
    setBusy(true); setProblem(null); setSaved(false);
    try {
      const body = {
        products: Object.entries(stars).map(([productId, value]) => ({ productId, rating: value })),
        deliveryRating: fulfilment === "pickup" || delivery === 0 ? null : delivery,
        tags: Array.from(chosen),
        note: note.trim() || null,
      };
      const result = await accountCall<{ rating: OrderRating }>(`/api/market/orders/${encodeURIComponent(orderId)}/rating`, { method: "PUT", body: JSON.stringify(body) });
      setSaved(true);
      onSaved(result.rating);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-order-rating">
      <p className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]"><MessageSquareHeart className="h-4 w-4 text-[var(--codiq-accent)]" /> {rating ? "تقييمك لهذا الطلب" : "قيّم طلبك"}</p>
      {products.map(([productId, name]) => (
        <div key={productId} className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-[var(--codiq-text)]">{name}</span>
          <Stars value={stars[productId] ?? 0} onChange={(value) => setStars((current) => ({ ...current, [productId]: value }))} label={`تقييم ${name}`} testId={`market-rate-product-${productId}`} />
        </div>
      ))}
      {fulfilment !== "pickup" ? (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--codiq-border)] pt-3">
          <span className="text-xs font-bold text-[var(--codiq-text)]">التوصيل</span>
          <Stars value={delivery} onChange={setDelivery} label="تقييم التوصيل" testId="market-rate-delivery" />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2" data-testid="market-rate-tags">
        {tags.map((tag) => (
          <button key={tag.code} type="button" aria-pressed={chosen.has(tag.code)} onClick={() => toggle(tag.code)} className={`rounded-full border px-3 py-1 text-[11px] font-bold ${chosen.has(tag.code) ? (tag.tone === "positive" ? "border-[var(--codiq-success)] bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "border-[var(--codiq-danger)] bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]") : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`} data-testid={`market-rate-tag-${tag.code}`}>{tag.label}</button>
        ))}
      </div>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} placeholder="ملاحظة للمتجر (اختياري)" className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm" data-testid="market-rate-note" />
      {problem ? <p className="text-xs text-[var(--codiq-danger)]">{problem}</p> : null}
      {saved ? <p className="text-xs font-bold text-[var(--codiq-success)]" data-testid="market-rate-saved">شكراً، حُفظ تقييمك.</p> : null}
      <button type="button" disabled={!anything || busy} onClick={() => void save()} className="w-full rounded-full bg-[var(--codiq-accent)] py-2.5 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-50" data-testid="market-rate-save">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} {rating ? "تحديث التقييم" : "إرسال التقييم"}</button>
    </section>
  );
}

type PendingOrder = { id: string; orderNumber: string; store: { slug: string; name: string }; preview: string[] };

/** «بانتظار تقييمك» on top of «طلباتي»: hidden when nothing waits. */
export function PendingRatingsStrip() {
  const list = useMarketList<PendingOrder>("/api/market/me/ratings/pending", "orders");
  if (!list.items?.length) return null;
  return (
    <section className="space-y-2 rounded-[22px] bg-[var(--codiq-accent-soft)] p-3" data-testid="market-pending-ratings">
      <p className="text-xs font-black text-[var(--codiq-accent)]">بانتظار تقييمك ({list.items.length.toLocaleString("ar-IQ")})</p>
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none]">
        {list.items.map((order) => (
          <Link key={order.id} href={`/orders/${order.id}`} className="w-48 shrink-0 rounded-2xl bg-[var(--codiq-surface)] p-3 text-xs shadow-sm" data-testid={`market-pending-rating-${order.id}`}>
            <p className="truncate font-black text-[var(--codiq-text)]">{order.store.name}</p>
            <p className="truncate text-[var(--codiq-text-secondary)]">{order.preview.join("، ")}</p>
            <p className="mt-1 font-bold text-[var(--codiq-accent)]">قيّم الآن ←</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

type MyRating = { id: string; ratedAt: string; deliveryRating: number | null; tags: RatingTag[]; note: string | null; order: { id: string; orderNumber: string; store: { slug: string; name: string }; preview: string[] } };

/** «تقييماتي» — every order the shopper rated, newest first. */
export function MarketRatingsPage() {
  const { status, shopper } = useShopper();
  const list = useMarketList<MyRating>(shopper ? "/api/market/me/ratings?limit=20" : null, "ratings");
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-ratings">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تقييماتي</h1>
      <PendingRatingsStrip />
      {!list.items ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {list.items?.length === 0 ? <MarketEmptyState icon={MessageSquareHeart} title="لم تقيّم أيّ طلب بعد" body="بعد استلام طلبك، قيّمه من صفحة الطلب ليعرف المتجر رأيك." /> : null}
      <ul className="space-y-3">
        {list.items?.map((row) => (
          <li key={row.id}>
            <Link href={`/orders/${row.order.id}`} className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-rating-${row.order.id}`}>
              <div className="flex justify-between text-sm font-black text-[var(--codiq-text)]"><span>{row.order.store.name}</span><span className="text-xs text-[var(--codiq-text-muted)]">{new Date(row.ratedAt).toLocaleDateString("ar-IQ")}</span></div>
              <p className="truncate text-xs text-[var(--codiq-text-secondary)]">{row.order.preview.join("، ")}</p>
              {row.deliveryRating ? <p className="text-xs text-[var(--codiq-text-secondary)]">التوصيل: {"★".repeat(row.deliveryRating)}{"☆".repeat(5 - row.deliveryRating)}</p> : null}
              {row.tags.length ? <p className="text-[11px] text-[var(--codiq-text-muted)]">{row.tags.map((tag) => tag.label).join(" · ")}</p> : null}
            </Link>
          </li>
        ))}
      </ul>
      {list.nextCursor ? <button type="button" onClick={() => void list.loadMore()} className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]">عرض المزيد</button> : null}
    </div>
  );
}
