/**
 * The shopper's orders — ratings. Split verbatim from MarketOrdersPages.tsx (review batch 2, ت-١١);
 * MarketOrdersPages.tsx re-exports what it always exported.
 */
import { useState } from "react";
import { LoaderCircle, Star } from "lucide-react";
import { Link } from "wouter";
import { useShopper } from "../../market-shopper";
import { useMarketList } from "../../use-market-list";
import { MarketSignIn } from "../MarketAccountPages";
import { MarketEmptyState } from "../../MarketEmptyState";
import { Stars } from "../../components/OrderAfterSales";

// ── تقييماتي ─────────────────────────────────────────────────────────────────

type PendingRating = {
  id: string;
  orderNumber: string;
  deliveredAt: string;
  rateBy: string;
  store: { slug: string; name: string };
  preview: string[];
};

type MyRating = {
  id: string;
  storeStars: number;
  deliveryStars: number | null;
  tagLabels: string[];
  note: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string; store: { slug: string; name: string } };
};

export function MarketRatingsPage() {
  const { status, shopper } = useShopper();
  const [tab, setTab] = useState<"pending" | "mine">("pending");
  const pending = useMarketList<PendingRating>(
    shopper && tab === "pending" ? "/api/market/ratings/pending?limit=20" : null,
    "orders"
  );
  const mine = useMarketList<MyRating>(
    shopper && tab === "mine" ? "/api/market/ratings?limit=20" : null,
    "ratings"
  );
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  const list = tab === "pending" ? pending : mine;
  return (
    <div className="space-y-4" data-testid="market-ratings">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تقييماتي</h1>
      <div className="flex gap-2">
        {(
          [
            ["pending", "بانتظار تقييمك"],
            ["mine", "قيّمتها"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}
            data-testid={`market-ratings-tab-${value}`}
          >
            {label}
          </button>
        ))}
      </div>
      {!list.items ? (
        <p className="text-center text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {list.items?.length === 0 ? (
        <MarketEmptyState
          icon={Star}
          title={tab === "pending" ? "لا طلبات بانتظار تقييمك" : "لم تقيّم أيّ طلب بعد"}
          body="بعد استلام طلبك يظهر هنا لتقيّم المتجر والمنتجات."
        />
      ) : null}
      <ul className="space-y-3">
        {tab === "pending"
          ? pending.items?.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/orders/${row.id}`}
                  className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
                  data-testid={`market-pending-${row.id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-[var(--codiq-text)]">
                      {row.store.name}
                    </span>
                    <span className="rounded-full bg-[var(--codiq-accent)] px-3 py-1 text-[11px] font-bold text-[var(--codiq-surface)]">
                      قيّم الآن
                    </span>
                  </div>
                  <p className="truncate text-xs text-[var(--codiq-text-secondary)]">
                    {row.preview.join("، ")}
                  </p>
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    طلب #{row.orderNumber} — التقييم متاح حتّى{" "}
                    {new Date(row.rateBy).toLocaleDateString("ar-IQ")}
                  </p>
                </Link>
              </li>
            ))
          : mine.items?.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/orders/${row.order.id}`}
                  className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
                  data-testid={`market-rated-${row.order.id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-[var(--codiq-text)]">
                      {row.order.store.name}
                    </span>
                    <Stars value={row.storeStars} label="تقييم المتجر" />
                  </div>
                  {row.tagLabels.length ? (
                    <p className="text-xs text-[var(--codiq-text-secondary)]">
                      {row.tagLabels.join("، ")}
                    </p>
                  ) : null}
                  {row.note ? <p className="text-xs text-[var(--codiq-text)]">{row.note}</p> : null}
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    طلب #{row.order.orderNumber} —{" "}
                    {new Date(row.createdAt).toLocaleDateString("ar-IQ")}
                  </p>
                </Link>
              </li>
            ))}
      </ul>
      {list.nextCursor ? (
        <button
          type="button"
          onClick={() => void list.loadMore()}
          className="w-full rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-accent)]"
        >
          عرض المزيد
        </button>
      ) : null}
    </div>
  );
}
