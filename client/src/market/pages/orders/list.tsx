/**
 * The shopper's orders — list. Split verbatim from MarketOrdersPages.tsx (review batch 2, ت-١١);
 * MarketOrdersPages.tsx re-exports what it always exported.
 */
import { useState, useMemo } from "react";
import { LoaderCircle, Package, Store } from "lucide-react";
import { Link } from "wouter";
import { useShopper } from "../../market-shopper";
import { useMarketList } from "../../use-market-list";
import { MarketSignIn } from "../MarketAccountPages";
import { MarketEmptyState } from "../../MarketEmptyState";
import { iqd } from "../../market-products";

type OrderCard = {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  fulfilment: string;
  totalIqd: number;
  createdAt: string;
  store: { slug: string; name: string };
  itemCount: number;
  preview: string[];
};

const TABS = [
  { value: "", label: "الكل" },
  { value: "active", label: "الجارية" },
  { value: "done", label: "المنتهية" },
];

const TONE: Record<string, string> = {
  completed: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]",
  cancelled: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  rejected: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  returned: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]",
};

export function MarketOrdersPage() {
  const { status, shopper } = useShopper();
  const [tab, setTab] = useState("");
  const url = useMemo(
    () => (shopper ? `/api/market/orders?limit=20${tab ? `&status=${tab}` : ""}` : null),
    [shopper, tab]
  );
  const list = useMarketList<OrderCard>(url, "orders");
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-orders">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">طلباتي</h1>
      <div className="flex gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === entry.value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`}
          >
            {entry.label}
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
          icon={Package}
          title="لا توجد طلبات هنا"
          body="جرّب تبويباً آخر أو ابدأ التسوّق من الرئيسيّة."
        />
      ) : null}
      <ul className="space-y-3">
        {list.items?.map((order) => (
          <li key={order.id}>
            <Link
              href={`/orders/${order.id}`}
              className="block space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm"
              data-testid={`market-order-${order.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-sm font-black text-[var(--codiq-text)]">
                  <Store className="h-4 w-4 text-[var(--codiq-accent)]" /> {order.store.name}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[order.status] ?? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}
                >
                  {order.statusLabel}
                </span>
              </div>
              <p className="truncate text-xs text-[var(--codiq-text-secondary)]">
                {order.preview.join("، ")}
                {order.itemCount > order.preview.length
                  ? ` و${(order.itemCount - order.preview.length).toLocaleString("ar-IQ")} منتج آخر`
                  : ""}
              </p>
              <div className="flex justify-between text-xs text-[var(--codiq-text-muted)]">
                <span>
                  طلب #{order.orderNumber} — {new Date(order.createdAt).toLocaleDateString("ar-IQ")}
                </span>
                <span className="font-bold text-[var(--codiq-text)]">{iqd(order.totalIqd)}</span>
              </div>
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
