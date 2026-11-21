/**
 * The market's frame: a sticky header (brand, «التوصيل إلى», search) and a
 * bottom tab bar — the shape of a shopping app on a phone, centred on a wider
 * screen rather than stretched across it.
 */
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronDown, Grid2x2, House, MapPin, Search, ShoppingBag, Store, UserRound } from "lucide-react";
import { LocationPicker } from "./LocationPicker";
import { useMarketLocation } from "./market-location";
import { useMarketCart } from "./market-cart";

const TABS = [
  { href: "/", label: "الرئيسية", icon: House, testId: "home" },
  { href: "/stores", label: "المتاجر", icon: Store, testId: "stores" },
  { href: "/categories", label: "الفئات", icon: Grid2x2, testId: "categories" },
  { href: "/cart", label: "السلة", icon: ShoppingBag, testId: "cart" },
  { href: "/account", label: "حسابي", icon: UserRound, testId: "account" },
] as const;

function isActive(tab: string, location: string) {
  return tab === "/" ? location === "/" : location === tab || location.startsWith(`${tab}/`);
}

export function MarketShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [marketLocation, setMarketLocation] = useMarketLocation();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const cart = useMarketCart();

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[var(--codiq-canvas)] text-[var(--codiq-text)]" data-testid="market-shell">
      <div className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col bg-[var(--codiq-canvas)]">
        <header className="sticky top-0 z-30 space-y-3 border-b border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <Link href="/" className="text-lg font-black tracking-tight text-[var(--codiq-accent)]" data-testid="market-brand">Codiq ماركت</Link>
            <button type="button" onClick={() => setPicking(true)} className="flex min-w-0 items-center gap-1 rounded-full bg-[var(--codiq-surface-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)]" data-testid="market-location-button">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--codiq-accent)]" />
              <span className="truncate">التوصيل إلى: {marketLocation ? [marketLocation.governorateName, marketLocation.districtName].filter(Boolean).join(" · ") : "اختر محافظتك"}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
          <form onSubmit={submitSearch} role="search">
            <label className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-surface-sunken)] px-3 py-2.5">
              <Search className="h-4 w-4 text-[var(--codiq-text-muted)]" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" enterKeyHint="search" placeholder="ابحث عن منتج، علامة، متجر…" aria-label="بحث" className="w-full bg-transparent text-sm outline-none" data-testid="market-search-input" />
            </label>
          </form>
        </header>

        <main className="flex-1 px-4 pb-28 pt-4">{children}</main>

        <nav aria-label="التنقّل الرئيسيّ" className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[560px] border-t border-[var(--codiq-border)] bg-[var(--codiq-surface)] pb-[env(safe-area-inset-bottom)]">
          <ul className="grid grid-cols-5">
            {TABS.map((tab) => {
              const active = isActive(tab.href, location);
              const Icon = tab.icon;
              return (
                <li key={tab.href}>
                  <Link href={tab.href} aria-current={active ? "page" : undefined} data-testid={`market-tab-${tab.testId}`}
                    className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold ${active ? "text-[var(--codiq-accent)]" : "text-[var(--codiq-text-muted)]"}`}>
                    <span className="relative">
                      <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 1.8} />
                      {tab.testId === "cart" && cart && cart.count > 0 ? <span className="absolute -left-2 -top-1.5 min-w-4 rounded-full bg-[var(--codiq-danger)] px-1 text-center text-[9px] font-black leading-4 text-[var(--codiq-surface)]" data-testid="market-cart-badge">{cart.count > 99 ? "99+" : cart.count.toLocaleString("ar-IQ")}</span> : null}
                    </span>
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      {picking ? <LocationPicker current={marketLocation} onPick={setMarketLocation} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
