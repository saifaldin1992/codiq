/**
 * ق-203 — the storefront's shell, in the reference shop's arrangement and the
 * platform's own colours: the announcement strip, a header with the menu
 * drawer, the store's name or logo, search, the account and the cart, a
 * category bar on wide screens, the store-state banners, the page, and the
 * footer. Every merchant-authored thing in it comes from `public-config`
 * through the provider — the shell fetches nothing of its own.
 */
import { Link, useLocation } from "wouter";
import { SlidersHorizontal, BadgeCheck, ChevronDown, Heart, KeyRound, LoaderCircle, LogOut, MapPin, Menu, PackageSearch, Palmtree, Pause, Play, RotateCcw, Search, ShoppingBag, ShoppingCart, Store, UserRound, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useStorefront } from "@/components/StorefrontProvider";
import { StorefrontFooter } from "@/components/StorefrontFooter";
import { buildCategoryTree, type TreeNode } from "@/lib/category-tree";
import { errorMessage, StorefrontCategory, storefrontApi } from "@/lib/storefront-api";

/**
 * The storefront speaks the platform's tokens — the owner's instruction is
 * Codiq's identity with the reference's arrangement. Aliased once here so
 * every storefront component can keep saying `--storefront-*`.
 */
const storefrontVariables = {
  "--storefront-canvas": "var(--codiq-canvas)",
  "--storefront-surface": "var(--codiq-surface)",
  "--storefront-text": "var(--codiq-text)",
  "--storefront-muted": "var(--codiq-text-muted)",
  "--storefront-accent": "var(--codiq-accent)",
  "--storefront-accent-hover": "var(--codiq-accent-hover)",
  "--storefront-accent-soft": "var(--codiq-accent-soft)",
  "--storefront-accent-strong": "var(--codiq-accent-strong)",
  "--storefront-border": "var(--codiq-border)",
} as CSSProperties;

/** ق-199: the merchant's one sentence, above everything, moving — with a pause (WCAG 2.2.2), and still when motion is reduced (the CSS handles that). */
function AnnouncementStrip({ text }: { text: string }) {
  const [playing, setPlaying] = useState(true);
  return (
    <div data-testid="storefront-announcement" className="bg-[var(--storefront-accent-strong)] text-white">
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-1.5 text-[13px] font-semibold sm:px-6">
        <div className="cq-marquee min-w-0 flex-1" data-cq-playing={playing ? "true" : "false"}>
          <div className="cq-marquee__track">
            {Array.from({ length: 8 }, (_, index) => <span key={index} className="whitespace-nowrap px-6" aria-hidden={index > 0 ? "true" : undefined}>{text}</span>)}
          </div>
        </div>
        <button type="button" aria-pressed={!playing} aria-label={playing ? "إيقاف الحركة" : "تشغيل الحركة"} onClick={() => setPlaying((current) => !current)} className="shrink-0 rounded-full p-1.5 text-white/85 hover:bg-white/15 hover:text-white">
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function DrawerCategory({ node, slug }: { node: TreeNode<StorefrontCategory>; slug: string }) {
  return (
    <li>
      <SheetClose asChild>
        <Link href={`/store/${slug}/categories/${node.category.id}`} className={`block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)] ${node.depth === 1 ? "font-bold text-[var(--storefront-text)]" : "text-[var(--storefront-muted)]"}`} style={{ paddingRight: `${0.75 + (node.depth - 1) * 1}rem` }}>
          {node.depth > 1 ? <span aria-hidden="true" className="ml-1.5 text-[var(--storefront-border)]">└</span> : null}{node.category.name}
        </Link>
      </SheetClose>
      {node.children.length ? <ul>{node.children.map((child) => <DrawerCategory key={child.category.id} node={child} slug={slug} />)}</ul> : null}
    </li>
  );
}

export function StorefrontShell({ children }: { children: React.ReactNode }) {
  const { slug, cart, customer, loading, config, categories, notice, setCustomer, setCart, setNotice } = useStorefront();
  const [location, navigate] = useLocation();
  const [searchDraft, setSearchDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  const tree = useMemo(() => buildCategoryTree(categories), [categories]);
  const roots = tree.map((node) => node.category);
  const name = config?.name ?? slug;

  // The provider's notice is drawn ONCE, here, on every page — the cart used
  // to be the only page that showed it, so a shopper confirming an order
  // landed on a page that said nothing. It clears itself; a banner that stays
  // until the next one is a banner nobody reads.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);
  useEffect(() => { setSearchOpen(false); }, [location]);

  async function logout() {
    try { await storefrontApi.logout(slug); setCustomer(null); setCart({ id: null, status: "empty", version: 0, expiresAt: null, ownerKind: "guest", items: [] }); setNotice("تم تسجيل الخروج."); navigate(`/store/${slug}`); }
    catch (error) { setNotice(errorMessage(error)); }
  }
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchDraft.trim();
    navigate(`/store/${slug}/products${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  }

  const searchField = (id: string, autoFocus = false) => (
    <form onSubmit={submitSearch} role="search" className="relative w-full">
      <label className="sr-only" htmlFor={id}>بحث المنتجات</label>
      <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--storefront-muted)]" />
      <input id={id} value={searchDraft} autoFocus={autoFocus} onChange={(event) => setSearchDraft(event.target.value)} placeholder="ابحث عن منتج…" className="h-10 w-full rounded-xl border border-[var(--storefront-border)] bg-[var(--storefront-canvas)] pr-9 pl-3 text-sm outline-none focus:border-[var(--storefront-accent)]" />
      <button type="submit" className="sr-only">بحث</button>
    </form>
  );

  return <div dir="rtl" style={storefrontVariables} className="min-h-screen bg-[var(--storefront-canvas)] text-[var(--storefront-text)]">
    {config?.announcement ? <AnnouncementStrip text={config.announcement.text} /> : null}
    {/* P27-7: the demo banner moved up to the Router in App.tsx — mounted once
        there, it now covers the shell-less routes too (`/`, the login pages,
        NotFound), so mounting it again here would show it twice. */}
    <a href="#storefront-content" className="sr-only focus:not-sr-only focus:fixed focus:right-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-[var(--codiq-surface)] focus:px-4 focus:py-3 focus:shadow-lg">تجاوز إلى المحتوى</a>
    <header className="sticky top-0 z-30 border-b border-[var(--storefront-border)] bg-[var(--storefront-surface)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
          <Sheet>
            <SheetTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="القائمة" data-testid="storefront-menu" className="rounded-xl"><Menu className="h-5 w-5" /></Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[320px] overflow-y-auto p-0 sm:w-[360px]">
              <SheetHeader className="border-b border-[var(--storefront-border)] px-5 py-4 text-right">
                <SheetTitle className="flex items-center gap-2 text-base font-black text-[var(--storefront-text)]">
                  {config?.logoUrl ? <img src={config.logoUrl} alt="" className="h-8 w-8 rounded-lg object-cover" /> : <Store className="h-5 w-5 text-[var(--storefront-accent)]" />}{name}
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="قائمة المتجر" className="px-3 py-3">
                <ul className="space-y-0.5">
                  <li><SheetClose asChild><Link href={`/store/${slug}`} className="block rounded-xl px-3 py-2 text-sm font-bold hover:bg-[var(--storefront-accent-soft)]">الرئيسية</Link></SheetClose></li>
                  <li><SheetClose asChild><Link href={`/store/${slug}/products`} className="block rounded-xl px-3 py-2 text-sm font-bold hover:bg-[var(--storefront-accent-soft)]">كل المنتجات</Link></SheetClose></li>
                  <li><SheetClose asChild><Link href={`/store/${slug}/track`} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold hover:bg-[var(--storefront-accent-soft)]"><PackageSearch className="h-4 w-4" />أين طلبي؟</Link></SheetClose></li>
                </ul>
                {tree.length ? <>
                  <p className="mt-4 px-3 text-[11px] font-bold uppercase tracking-wide text-[var(--storefront-muted)]">التصنيفات</p>
                  <ul className="mt-1 space-y-0.5">{tree.map((node) => <DrawerCategory key={node.category.id} node={node} slug={slug} />)}</ul>
                </> : null}
                <p className="mt-4 px-3 text-[11px] font-bold uppercase tracking-wide text-[var(--storefront-muted)]">حسابي</p>
                <ul className="mt-1 space-y-0.5">
                  {customer ? <>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/orders`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">طلباتي</Link></SheetClose></li>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/wishlist`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">المفضلة</Link></SheetClose></li>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/returns`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">إرجاعاتي</Link></SheetClose></li>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/addresses`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">عناويني</Link></SheetClose></li><li><SheetClose asChild><Link href={`/store/${slug}/account/preferences`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">تفضيلاتي</Link></SheetClose></li>
                  </> : <>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/login`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">تسجيل الدخول</Link></SheetClose></li>
                    <li><SheetClose asChild><Link href={`/store/${slug}/account/register`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">إنشاء حساب</Link></SheetClose></li>
                  </>}
                </ul>
                {config?.policies?.length ? <>
                  <p className="mt-4 px-3 text-[11px] font-bold uppercase tracking-wide text-[var(--storefront-muted)]">السياسات</p>
                  <ul className="mt-1 space-y-0.5">
                    {config.policies.map((kind) => <li key={kind}><SheetClose asChild><Link href={`/store/${slug}/policies/${kind}`} className="block rounded-xl px-3 py-2 text-sm hover:bg-[var(--storefront-accent-soft)]">{kind === "return" ? "سياسة الإرجاع والاستبدال" : kind === "privacy" ? "سياسة الخصوصية" : "سياسة التوصيل"}</Link></SheetClose></li>)}
                  </ul>
                </> : null}
              </nav>
            </SheetContent>
          </Sheet>
          <Link href={`/store/${slug}`} className="flex min-w-0 items-center gap-2.5 font-black text-[var(--storefront-text)]" data-testid="storefront-brand">
            {config?.logoUrl
              ? <img src={config.logoUrl} alt={name} className="h-9 w-9 shrink-0 rounded-xl object-cover" />
              : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--storefront-accent-soft)] text-[var(--storefront-accent)]"><Store className="h-4 w-4" /></span>}
            <span className="truncate text-base tracking-wide sm:text-lg">{name}</span>
          </Link>
          {config?.verified ? <span data-testid="storefront-verified-badge" title="متجر موثّق من Codiq" className="hidden shrink-0 items-center gap-1 rounded-full bg-[var(--storefront-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--storefront-accent)] sm:flex"><BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /><span>موثّق</span><span className="sr-only">متجر وثّقته منصة Codiq</span></span> : null}
        </div>
        <nav aria-label="تنقل المتجر" className="flex items-center gap-0.5 sm:gap-1">
          {/* ONE search box in the DOM at a time: the wide one lives here, the
              phone's replaces it in the row below — a hidden duplicate is still
              a duplicate to a screen reader and to a strict test locator. */}
          {!searchOpen ? <div className="hidden w-60 md:block lg:w-72">{searchField("storefront-search")}</div> : null}
          <Button type="button" variant="ghost" size="icon" aria-label="بحث" aria-expanded={searchOpen} className="rounded-xl md:hidden" onClick={() => setSearchOpen((open) => !open)}>{searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}</Button>
          {loading ? <LoaderCircle className="mx-2 h-4 w-4 animate-spin text-[var(--storefront-muted)]" /> : customer ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" data-testid="storefront-account-menu" aria-label="حسابي" className="gap-1.5 rounded-xl px-2.5 py-2 text-sm font-bold text-[var(--storefront-text)] hover:bg-[var(--storefront-accent-soft)] sm:px-3">
                  <UserRound className="h-4 w-4" />
                  <span className="hidden sm:inline">{customer.isGuest ? "ضيف" : "حسابي"}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem asChild><Link href={`/store/${slug}/account/orders`} data-testid="account-menu-orders" className="cursor-pointer gap-2"><ShoppingBag className="h-4 w-4" />طلباتي</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href={`/store/${slug}/account/wishlist`} data-testid="account-menu-wishlist" className="cursor-pointer gap-2"><Heart className="h-4 w-4" />المفضلة</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href={`/store/${slug}/account/returns`} data-testid="account-menu-returns" className="cursor-pointer gap-2"><RotateCcw className="h-4 w-4" />إرجاعاتي</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href={`/store/${slug}/account/addresses`} data-testid="account-menu-addresses" className="cursor-pointer gap-2"><MapPin className="h-4 w-4" />عناويني</Link></DropdownMenuItem><DropdownMenuItem asChild><Link href={`/store/${slug}/account/preferences`} data-testid="account-menu-preferences" className="cursor-pointer gap-2"><SlidersHorizontal className="h-4 w-4" />تفضيلاتي</Link></DropdownMenuItem>
                {/* ق-201: a guest can sign back in only once he has a password. */}
                {customer.isGuest ? <DropdownMenuItem asChild><Link href={`/store/${slug}/account/orders`} data-testid="account-menu-set-password" className="cursor-pointer gap-2 text-[var(--storefront-accent)]"><KeyRound className="h-4 w-4" />أنشئ كلمة مرور</Link></DropdownMenuItem> : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logout()} data-testid="account-menu-logout" className="cursor-pointer gap-2 text-[var(--storefront-muted)]"><LogOut className="h-4 w-4" />تسجيل الخروج</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : <Link href={`/store/${slug}/account/login`} aria-label="دخول" className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm font-bold text-[var(--storefront-text)] hover:bg-[var(--storefront-accent-soft)] sm:px-3"><UserRound className="h-5 w-5 sm:h-4 sm:w-4" /><span className="hidden sm:inline">دخول</span></Link>}
          <Link href={`/store/${slug}/cart`} className="relative rounded-xl px-2.5 py-2 text-sm font-bold text-[var(--storefront-text)] transition hover:bg-[var(--storefront-accent-soft)] sm:px-3" aria-label={`السلة، ${count} عناصر`}><ShoppingCart className="h-5 w-5" /><span className="sr-only">السلة</span>{count ? <span aria-live="polite" className="absolute -left-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--storefront-accent)] px-1 text-[10px] font-black text-white">{count}</span> : null}</Link>
        </nav>
      </div>
      {searchOpen ? <div className="border-t border-[var(--storefront-border)] px-3 py-2 md:hidden">{searchField("storefront-search-mobile", true)}</div> : null}
      {roots.length ? (
        <div className="hidden border-t border-[var(--storefront-border)] md:block">
          <nav aria-label="التصنيفات" className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-6">
            <Link href={`/store/${slug}/products`} className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-bold text-[var(--storefront-text)] hover:bg-[var(--storefront-accent-soft)]">كل المنتجات</Link>
            {roots.map((category) => <Link key={category.id} href={`/store/${slug}/categories/${category.id}`} className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--storefront-muted)] hover:bg-[var(--storefront-accent-soft)] hover:text-[var(--storefront-accent)]">{category.name}</Link>)}
          </nav>
        </div>
      ) : null}
    </header>
    {/* ق-250: the platform is under maintenance somewhere the shopper may hit — one strip, the owner's sentence. */}
    {config?.availability?.platform?.maintenance ? <div data-testid="storefront-platform-maintenance" role="status" className="border-b border-[var(--storefront-border)] bg-[var(--storefront-accent-soft)]"><div className="mx-auto flex max-w-7xl items-start gap-2.5 px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-accent-on-soft)] sm:px-6"><Pause className="mt-0.5 h-4 w-4 shrink-0" /><span>{config.availability.platform.maintenance.message}</span></div></div> : null}
    {config?.vacation ? <div data-testid="storefront-vacation-banner" role="status" className="border-b border-[#F0DFB8] bg-[var(--codiq-warning-soft)]"><div className="mx-auto flex max-w-7xl items-start gap-2.5 px-4 py-3 text-sm font-semibold leading-6 text-[#8A5710] sm:px-6"><Palmtree className="mt-0.5 h-4 w-4 shrink-0" /><span>{config.vacation.message}</span></div></div> : null}
    {notice ? <div data-testid="storefront-notice" role="status" aria-live="polite" className="border-b border-[var(--storefront-border)] bg-[var(--storefront-accent-soft)]"><div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 text-sm font-semibold text-[var(--codiq-accent-on-soft)] sm:px-6"><span>{notice}</span><button type="button" aria-label="إغلاق التنبيه" onClick={() => setNotice(null)} className="rounded-full p-1 hover:bg-white/60"><X className="h-4 w-4" /></button></div></div> : null}
    {/* ق-249: a store in maintenance keeps its shell — name, logo, footer — and shows the merchant's sentence where the page would be. */}
    <main id="storefront-content" className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8">{config?.availability?.store.status === "maintenance" ? <section role="status" data-testid="storefront-maintenance" className="mx-auto max-w-lg rounded-[26px] bg-[var(--storefront-surface)] px-6 py-10 text-center shadow-sm"><Pause className="mx-auto h-10 w-10 text-[var(--storefront-accent)]" /><h1 className="mt-4 text-xl font-bold text-[var(--storefront-text)]">المتجر مغلق للصيانة.</h1><p className="mt-2 text-sm leading-6 text-[var(--storefront-muted)]">{config.availability.store.message}</p>{config.availability.store.until ? <p className="mt-1 text-xs text-[var(--storefront-muted)]">نعود بحلول {new Date(config.availability.store.until).toLocaleString("ar-IQ")}</p> : null}</section> : children}</main>
    <StorefrontFooter slug={slug} config={config} />
  </div>;
}
