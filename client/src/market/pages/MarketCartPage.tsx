/**
 * السلة — one basket across stores, shown store by store, each with its own
 * «إتمام الشراء». A line that can no longer be bought as it stands says why
 * and what to do, and holds its store back until it is fixed.
 */
import { useState } from "react";
import { Link } from "wouter";
import { CircleAlert, LoaderCircle, Minus, Package, Plus, ShoppingBag, Store, Trash2 } from "lucide-react";
import { useShopper } from "../market-shopper";
import { cartWrite, PROBLEM_TEXT, useMarketCart, type CartLine } from "../market-cart";
import { iqd } from "../market-products";
import { MarketSignIn } from "./MarketAccountPages";
import { MarketEmptyState } from "../MarketEmptyState";

export function MarketCartPage() {
  const { status, shopper } = useShopper();
  const cart = useMarketCart();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (status === "loading") return null;
  if (!shopper) return <div className="space-y-3" data-testid="market-cart"><p className="text-sm text-[var(--codiq-text-secondary)]">سجّل الدخول لتحفظ سلتك وتطلب من كل المتاجر.</p><MarketSignIn /></div>;
  if (!cart) return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]" data-testid="market-cart"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  if (cart.stores.length === 0) return <MarketEmptyState testId="market-cart" icon={ShoppingBag} title="سلتك فارغة" body="ابدأ التسوّق واكتشف عروض اليوم." action={<Link href="/" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">تصفّح المنتجات</Link>} />;

  const run = async (key: string, url: string, init: RequestInit) => {
    setBusy(key); setFailure(null);
    try { await cartWrite(url, init); } catch (error) { setFailure((error as Error).message); } finally { setBusy(null); }
  };
  const anyPriceMoved = cart.stores.some((group) => group.lines.some((line) => line.problem === "price_changed"));

  return (
    <div className="space-y-4" data-testid="market-cart">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">السلة ({cart.count.toLocaleString("ar-IQ")})</h1>
        <button type="button" onClick={() => { if (window.confirm("سيتم حذف جميع المنتجات من سلتك. لا يمكن التراجع.")) void run("clear", "/api/market/cart", { method: "DELETE" }); }} className="text-xs font-bold text-[var(--codiq-danger)]" data-testid="market-cart-clear">إفراغ السلة</button>
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-cart-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {anyPriceMoved ? (
        <div className="flex items-center justify-between gap-2 rounded-2xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-warning)]">
          تغيّرت أسعار بعض المنتجات منذ أضفتها.
          <button type="button" onClick={() => void run("accept", "/api/market/cart/accept-prices", { method: "POST" })} className="shrink-0 rounded-full bg-[var(--codiq-surface)] px-3 py-1 font-bold" data-testid="market-cart-accept-prices">اعتمد الأسعار الجديدة</button>
        </div>
      ) : null}
      {cart.stores.map((group) => (
        <section key={group.store.slug} className="space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-cart-store-${group.store.slug}`}>
          <Link href={`/s/${encodeURIComponent(group.store.slug)}`} className="flex items-center gap-2 text-sm font-black text-[var(--codiq-text)]">
            {group.store.logoUrl ? <img src={group.store.logoUrl} alt="" className="h-8 w-8 rounded-xl object-cover" /> : <Store className="h-5 w-5 text-[var(--codiq-accent)]" />} {group.store.name}
          </Link>
          <ul className="divide-y divide-[var(--codiq-border)]">
            {group.lines.map((line) => <Line key={line.id} line={line} busy={busy === line.id} onQuantity={(quantity) => void run(line.id, `/api/market/cart/items/${line.id}`, { method: "PATCH", body: JSON.stringify({ quantity }) })} onRemove={() => void run(line.id, `/api/market/cart/items/${line.id}`, { method: "DELETE" })} />)}
          </ul>
          <div className="flex items-center justify-between border-t border-[var(--codiq-border)] pt-3">
            <span className="text-xs text-[var(--codiq-text-muted)]">المجموع الفرعيّ</span>
            <span className="text-base font-black text-[var(--codiq-text)]">{iqd(group.subtotalIqd)}</span>
          </div>
          {group.ready ? (
            <Link href={`/checkout/${encodeURIComponent(group.store.slug)}`} className="block w-full rounded-full bg-[var(--codiq-accent)] py-3 text-center text-sm font-black text-[var(--codiq-surface)]" data-testid={`market-cart-checkout-${group.store.slug}`}>إتمام الشراء من {group.store.name}</Link>
          ) : <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-3 py-2 text-center text-xs text-[var(--codiq-text-secondary)]">عدّل المنتجات المعلَّمة أعلاه لإتمام الشراء من هذا المتجر.</p>}
        </section>
      ))}
      <Link href="/" className="block text-center text-xs font-bold text-[var(--codiq-accent)]">أضف المزيد</Link>
    </div>
  );
}

function Line({ line, busy, onQuantity, onRemove }: { line: CartLine; busy: boolean; onQuantity: (quantity: number) => void; onRemove: () => void }) {
  const max = Math.min(99, line.product.maxPerOrder ?? 99, line.available ?? 99);
  return (
    <li className="flex gap-3 py-3" data-testid={`market-cart-line-${line.id}`}>
      <Link href={`/p/${line.product.id}`} className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-[var(--codiq-surface-sunken)]">
        {line.product.imageUrl ? <img src={line.product.imageUrl} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-[var(--codiq-text-muted)]"><Package className="h-6 w-6" /></span>}
      </Link>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="line-clamp-2 text-xs font-bold text-[var(--codiq-text)]">{line.product.name}</p>
        {line.variant.name ? <p className="text-[11px] text-[var(--codiq-text-muted)]">{line.variant.name}</p> : null}
        {line.addons.length ? <p className="text-[11px] text-[var(--codiq-text-muted)]">+ {line.addons.map((addon) => addon.name).join("، ")}</p> : null}
        {line.product.isPreorder ? <p className="text-[11px] font-bold text-[var(--codiq-accent)]">طلب مسبق</p> : null}
        <p className="text-sm font-black text-[var(--codiq-text)]">{line.listPriceIqd && line.problem !== "price_changed" ? <span className="ml-1 text-[11px] font-semibold text-[var(--codiq-text-muted)] line-through">{iqd(line.listPriceIqd)}</span> : null}{iqd(line.unitPriceIqd)}{line.problem === "price_changed" ? <span className="mr-1 text-[11px] font-semibold text-[var(--codiq-warning)]">← {iqd(line.livePriceIqd)}</span> : null}</p>
        {line.problem ? <p className="text-[11px] font-semibold text-[var(--codiq-danger)]" data-testid="market-cart-line-problem">{PROBLEM_TEXT[line.problem]}{line.problem === "insufficient_stock" && line.available ? ` (المتوفّر ${line.available.toLocaleString("ar-IQ")})` : ""}</p> : null}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] px-1">
            <button type="button" aria-label="زيادة" disabled={busy || line.quantity >= max} onClick={() => onQuantity(line.quantity + 1)} className="p-1.5 disabled:opacity-30" data-testid="market-cart-plus"><Plus className="h-3.5 w-3.5" /></button>
            <span className="min-w-5 text-center text-sm font-bold" data-testid="market-cart-quantity">{busy ? <LoaderCircle className="inline h-3.5 w-3.5 animate-spin" /> : line.quantity.toLocaleString("ar-IQ")}</span>
            <button type="button" aria-label="إنقاص" disabled={busy || line.quantity <= 1} onClick={() => onQuantity(line.quantity - 1)} className="p-1.5 disabled:opacity-30"><Minus className="h-3.5 w-3.5" /></button>
          </div>
          <button type="button" aria-label="حذف المنتج" onClick={onRemove} disabled={busy} data-testid="market-cart-remove"><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
        </div>
      </div>
    </li>
  );
}
