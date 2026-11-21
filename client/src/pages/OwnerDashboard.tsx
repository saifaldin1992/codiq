/**
 * Design reminder — codiq phase 2: calm Samsung One UI surfaces, RTL-first hierarchy,
 * one open primary accordion section, and placeholder-only content with no real data.
 */
import {
  BadgeCheck,
  Building2,
  ChevronLeft,
  CircleUserRound,
  CreditCard,
  FileText,
  Globe2,
  LayoutDashboard,
  Layers3,
  LogOut,
  Menu,
  ReceiptText,
  Settings2,
  ShoppingBag,
  Sparkles,
  Store,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AccountSecurityPanel } from "@/components/AccountSecurityPanel";
import { OwnerEmailCard, OwnerTotpCard, PlatformContactCard } from "@/components/OwnerAccountPanels";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { ManualMerchantForm } from "@/components/ManualMerchantForm";
import { OrderWorkspace } from "@/components/OrderWorkspace";
import { FinanceCenter } from "@/components/FinanceCenter";
import { MerchantsDirectory } from "@/components/MerchantsDirectory";
import { OwnerHome } from "@/components/OwnerHome";
import { PlansManager } from "@/components/PlansManager";
import { PlatformSettingsPanel } from "@/components/PlatformSettingsPanel";
import { PlatformServicesPanel } from "@/components/PlatformServicesPanel";
import { PlatformModulesPanel } from "@/components/PlatformModulesPanel";
import { PlatformMarketPanel } from "@/components/PlatformMarketPanel";
import { PlatformMarketContentPanel } from "@/components/PlatformMarketContentPanel";
import { PlatformMarketSupportPanel } from "@/components/PlatformMarketSupportPanel";
import { PlatformMarketCampaignsPanel } from "@/components/PlatformMarketCampaignsPanel";
import { PlatformMarketCouponsPanel } from "@/components/PlatformMarketCouponsPanel";
import { PlatformMarketWheelPanel } from "@/components/PlatformMarketWheelPanel";
import { PlatformMarketReelsPanel } from "@/components/PlatformMarketReelsPanel";
import { PlatformMarketImageIndexPanel } from "@/components/PlatformMarketImageIndexPanel";
import { PlatformMarketPaymentsPanel } from "@/components/PlatformMarketPaymentsPanel";
import { PlatformStoresDirectory } from "@/components/PlatformStoresDirectory";
import { PlatformTeamManager } from "@/components/PlatformTeamManager";
import { RegistrationCenter } from "@/components/RegistrationCenter";
import { SubscriptionsManager } from "@/components/SubscriptionsManager";
import { UpgradeRequestsPanel } from "@/components/UpgradeRequestsPanel";
// Phase 14: the sidebar consumes the central navigation source only — no local nav tree.
import { comingSoonLabel, ownerDashboardPath as dashboardPath, ownerNavGroups as navGroups, ownerPrimaryEntry as primaryEntry, type NavEntry, type NavEntryStatus } from "@/config/navigation";

const pageIndex = new Map<string, { label: string; group: string; status: NavEntryStatus }>([
  [primaryEntry.path, { label: primaryEntry.label, group: "Codiq", status: primaryEntry.status }],
  ...navGroups.flatMap((group) => group.entries.map((entry) => [entry.path, { label: entry.label, group: group.label, status: entry.status }] as const)),
]);

function matchesPath(location: string, path: string) {
  return location === path || (path !== dashboardPath && location.startsWith(`${path}/`));
}

function initialAccordionSection(location: string): string {
  const requestedSection = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;
  if (requestedSection && navGroups.some((group) => group.id === requestedSection)) return requestedSection;
  return navGroups.find((group) => group.entries.some((entry) => matchesPath(location, entry.path)))?.id ?? "";
}

function SidebarContent({ location, navigate, closeMobile }: { location: string; navigate: (path: string) => void; closeMobile: () => void }) {
  const [openSection, setOpenSection] = useState<string>(() => initialAccordionSection(location));
  const changePage = (path: string) => {
    // «تسجيل الخروج» is an ACT, not a page — it had a path and no destination,
    // so the owner had no way out of his own dashboard at all. /auth/logout is
    // identity-generic (sessions.ts): it revokes the session row and clears the
    // HttpOnly cookie, which the client cannot drop by itself. He leaves either
    // way — a failed call must not lock him in.
    if (path === "/platform/dashboard/account/sign-out") {
      closeMobile();
      void fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } })
        .catch(() => undefined)
        .then(() => navigate("/platform/login"));
      return;
    }
    navigate(path);
    closeMobile();
  };

  return (
    <div className="flex h-full flex-col" dir="rtl">
      <div className="border-b border-[var(--codiq-border)] px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          {/* ق-138 lockup rules: mark BEFORE word — the row is dir=ltr so the
              mark sits left even in this RTL shell; wordmark «Codiq». */}
          <div dir="ltr" className="flex items-center gap-3">
          <BrandMark className="h-12 w-12 rounded-2xl shadow-[0_8px_18px_rgba(30,111,219,0.22)]" />
          <div>
            <p className="text-[22px] font-bold tracking-[-0.04em] text-[#15233E]">Codiq</p>
            <p className="mt-0.5 text-xs font-medium text-[#8792A7]" dir="rtl">لوحة مالك المنصة</p>
          </div>
          </div>
        </div>
      </div>

      <nav aria-label="التنقل الرئيسي" className="codiq-scroll flex-1 overflow-y-auto px-3 py-4">
        <button
          type="button"
          onClick={() => changePage(primaryEntry.path)}
          className={`mb-2 flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-right text-sm font-semibold transition-all duration-200 ${matchesPath(location, primaryEntry.path) ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)] shadow-[inset_-3px_0_0_#1E6FDB]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-canvas)]"}`}
          aria-current={matchesPath(location, primaryEntry.path) ? "page" : undefined}
        >
          <LayoutDashboard className="h-[18px] w-[18px]" strokeWidth={1.9} />
          <span>{primaryEntry.label}</span>
        </button>

        <Accordion type="single" collapsible value={openSection} onValueChange={setOpenSection} className="space-y-2">
          {navGroups.map((group) => {
            const Icon = group.icon;
            const groupHasActivePage = group.entries.some((entry) => matchesPath(location, entry.path));
            return (
              <AccordionItem key={group.id} value={group.id} className="border-0">
                <AccordionTrigger className={`group rounded-2xl px-3.5 py-3 text-right no-underline hover:no-underline ${groupHasActivePage ? "bg-[var(--codiq-neutral-soft)] text-[#1A5CAC]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-canvas)]"}`}>
                  <span className="flex items-center gap-3 text-sm font-semibold">
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
                    {group.label}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-1 pt-1">
                  <div className="mr-5 border-r border-[var(--codiq-border)] py-1 pr-3">
                    <div className="space-y-0.5">
                      {group.entries.map((entry) => <NavLeaf key={entry.path} entry={entry} location={location} onNavigate={changePage} />)}
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </nav>

      <div className="m-3 rounded-[20px] bg-[var(--codiq-canvas)] p-3.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm"><CircleUserRound className="h-5 w-5" /></div>
          <div className="min-w-0"><p className="truncate text-xs font-bold text-[#293750]">مالك المنصة</p><p className="truncate text-[11px] text-[#8490A5]">وصول كامل للمنصة</p></div>
        </div>
      </div>
    </div>
  );
}

function NavLeaf({ entry, location, onNavigate }: { entry: NavEntry; location: string; onNavigate: (path: string) => void }) {
  const active = location === entry.path;
  const badge = comingSoonLabel(entry.status);
  return (
    <button
      type="button"
      onClick={() => onNavigate(entry.path)}
      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-right text-[13px] transition-colors ${active ? "bg-[var(--codiq-surface)] font-bold text-[var(--codiq-accent)] shadow-sm" : "font-medium text-[#68758A] hover:bg-[var(--codiq-surface)] hover:text-[#26344C]"}`}
      aria-current={active ? "page" : undefined}
    >
      <span>{entry.label}</span>
      {badge ? <span className="shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#8490A5]">{badge}</span> : active ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--codiq-accent)]" /> : null}
    </button>
  );
}

export default function OwnerDashboard() {
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  // ق-171: this shell drew itself for ANYONE who typed the URL. Every screen's
  // own request was refused by the server, so nothing leaked — but a staff
  // member landed on the owner's chrome, and a signed-out visitor on an empty
  // dashboard instead of the login page. The staff shell has always probed its
  // session first; this is the same probe with the owner's own account route.
  // 401 → nobody is signed in; 403 → somebody else is (D-88: one cookie, five
  // identities — a merchant or a store employee as easily as staff), and the
  // only thing every one of them can do here is sign in as the owner.
  const [gate, setGate] = useState<"checking" | "open">("checking");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/platform/security/account", { credentials: "same-origin" });
        if (cancelled) return;
        if (response.status === 401) { navigate("/platform/login"); return; }
        if (response.status === 403) { navigate("/platform/login"); return; }
      } catch {
        /* offline or refused: the screens' own calls will say so in place */
      }
      if (!cancelled) setGate("open");
    })();
    return () => { cancelled = true; };
  }, [navigate]);
  const currentPage = useMemo(() => pageIndex.get(location) ?? { label: "صفحة تجريبية", group: "لوحة المالك", status: "implemented" as NavEntryStatus }, [location]);
  const comingSoon = comingSoonLabel(currentPage.status);
  const isManualMerchantPage = location === "/platform/dashboard/merchants/add";
  const orderRoute = location.match(/^\/platform\/dashboard\/orders(?:\/([^/]+))?(?:\/history)?$/);
  const orderSegment = orderRoute?.[1];
  // The removed status sub-menus keep their deep links: every old URL still
  // opens the orders workspace with its preset (the chips carry it in-page).
  const orderFilters: Record<string, { title: string; status?: "new" | "processing" | "preparation" | "out_for_delivery" | "completed" | "cancelled" | "returned"; preset?: "action-needed" }> = {
    "": { title: "جميع الطلبات" }, "action-needed": { title: "طلبات بحاجة لإجراء", preset: "action-needed" }, processing: { title: "طلبات قيد المعالجة", status: "processing" }, fulfillment: { title: "طلبات قيد التنفيذ", status: "preparation" }, "out-for-delivery": { title: "طلبات قيد التوصيل", status: "out_for_delivery" }, completed: { title: "طلبات مكتملة", status: "completed" }, cancelled: { title: "طلبات ملغاة", status: "cancelled" }, returned: { title: "طلبات مرتجعة", status: "returned" }, returns: { title: "طلبات مرتجعة", status: "returned" },
  };
  const orderMode = orderRoute && orderSegment !== "delivery" && orderSegment !== "reports" ? (orderFilters[orderSegment ?? ""] ? { kind: "list" as const, ...orderFilters[orderSegment ?? ""] } : { kind: "detail" as const, orderId: orderSegment!, backPath: "/platform/dashboard/orders" }) : null;
  const wiredPage = location === "/platform/dashboard/account/security" || location === "/platform/dashboard/account/contact" || location === "/platform/dashboard/account/sessions-devices" || location === dashboardPath || location === "/platform/dashboard/merchants" || location === "/platform/dashboard/stores" || location === "/platform/dashboard/platform-settings" || location === "/platform/dashboard/upgrade-requests" || location === "/platform/dashboard/platform-staff" || location === "/platform/dashboard/services" || location === "/platform/dashboard/modules" || location === "/platform/dashboard/market" || location === "/platform/dashboard/market-content" || location === "/platform/dashboard/market-support" || location === "/platform/dashboard/market-campaigns" || location === "/platform/dashboard/market-coupons" || location === "/platform/dashboard/market-wheel" || location === "/platform/dashboard/market-reels" || location === "/platform/dashboard/market-image-index" || location === "/platform/dashboard/market-payments";

  if (gate === "checking") {
    return <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5"><p className="text-sm font-semibold text-[var(--codiq-text-secondary)]">جارٍ التحقق من الجلسة…</p></main>;
  }

  return (
    <div className="min-h-screen bg-[var(--codiq-canvas)] text-[#17233A] lg:flex" dir="rtl">
      <aside className="sticky top-0 z-30 hidden h-screen w-[310px] shrink-0 border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] shadow-[-14px_0_34px_rgba(36,52,82,0.035)] lg:block">
        <SidebarContent location={location} navigate={navigate} closeMobile={() => undefined} />
      </aside>

      {mobileOpen ? <button type="button" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-[#17233A]/20 lg:hidden" aria-label="إغلاق القائمة" /> : null}
      <aside className={`fixed inset-y-0 right-0 z-50 w-[310px] border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] lg:hidden ${mobileOpen ? "translate-x-0" : "translate-x-full"}`}>
        <div className="absolute left-3 top-3 z-10"><Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="إغلاق القائمة"><X className="h-5 w-5" /></Button></div>
        <SidebarContent location={location} navigate={navigate} closeMobile={() => setMobileOpen(false)} />
      </aside>

      <main className="min-h-screen min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="rounded-xl lg:hidden" aria-label="فتح القائمة"><Menu className="h-5 w-5" /></Button>
          <div className="mr-auto flex items-center gap-2 rounded-full bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-muted)] shadow-sm"><BadgeCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> منصة Codiq</div>
        </header>

        <section className="relative mx-5 overflow-hidden rounded-[28px] bg-[var(--codiq-surface)] px-6 py-7 shadow-[0_12px_36px_rgba(32,52,87,0.055)] sm:mx-8 sm:px-9 sm:py-9 lg:mx-10" style={{ backgroundImage: "linear-gradient(110deg, #FFFFFF 40%, #EEF4FF 78%, #DCE9FF 100%)" }}>
          <div className="relative z-10 max-w-xl">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[var(--codiq-text-muted)]"><span>{currentPage.group}</span><ChevronLeft className="h-3.5 w-3.5" /><span className="text-[var(--codiq-accent)]">{currentPage.label}</span></div>
            <h1 className="text-3xl font-bold tracking-[-0.04em] text-[#15233E] sm:text-[34px]">{currentPage.label}</h1>
            <p className="mt-3 max-w-md text-sm leading-7 text-[#61708A]">{isManualMerchantPage ? "إنشاء يدوي فعلي مقيد بجلسة مالك المنصة، وينشئ التاجر النشط ومتجره الأول ضمن معاملة واحدة." : orderMode ? "إشراف عالمي للقراءة فقط على طلبات المتاجر، من دون أي إجراء لتغيير الحالة." : comingSoon ? `هذه الوجهة مجدولة ضمن خارطة الطريق المعتمدة — ${comingSoon}.` : wiredPage ? "صفحة فعلية تقرأ من الخادم مباشرة ضمن حدود جلسة مالك المنصة." : "هيكل تنقل المرحلة الثانية للوحة مالك المنصة. هذه الصفحة تجريبية ولا تعرض بيانات تشغيلية أو إجراءات فعلية."}</p>
          </div>
          <div className="absolute bottom-0 right-0 h-2/3 w-1.5 rounded-tl-full bg-[var(--codiq-accent)]/80" />
        </section>

        <section className="mx-5 py-7 sm:mx-8 lg:mx-10 lg:py-8">
          {/* P27-11 (ق-99) — the logo panel is gone, and the space it took goes to
              CONTENT rather than to emptiness, which is the acceptance criterion.

              It was never only decoration: every real owner screen — the merchant
              directory, the finance centre, the plans manager — was rendering
              inside a 760px card with 255px of it spent on a logo, so each one had
              about 505px to work with. The merchant dashboard has never done this;
              its real screens render at full width and only its PLACEHOLDER keeps a
              card. The owner dashboard now matches it. */}
          {orderMode ? <OrderWorkspace key={location} scope={{ kind: "platform" }} mode={orderMode} navigate={navigate} /> : location === dashboardPath ? <OwnerHome navigate={navigate} /> : location === "/platform/dashboard/merchants" ? <MerchantsDirectory navigate={navigate} /> : location === "/platform/dashboard/stores" ? <PlatformStoresDirectory /> : location === "/platform/dashboard/platform-settings" ? <PlatformSettingsPanel navigate={navigate} /> : location === "/platform/dashboard/services" ? <PlatformServicesPanel /> : location === "/platform/dashboard/modules" ? <PlatformModulesPanel /> : location === "/platform/dashboard/market" ? <PlatformMarketPanel /> : location === "/platform/dashboard/market-content" ? <PlatformMarketContentPanel /> : location === "/platform/dashboard/market-support" ? <PlatformMarketSupportPanel /> : location === "/platform/dashboard/market-campaigns" ? <PlatformMarketCampaignsPanel /> : location === "/platform/dashboard/market-coupons" ? <PlatformMarketCouponsPanel /> : location === "/platform/dashboard/market-wheel" ? <PlatformMarketWheelPanel /> : location === "/platform/dashboard/market-reels" ? <PlatformMarketReelsPanel /> : location === "/platform/dashboard/market-image-index" ? <PlatformMarketImageIndexPanel /> : location === "/platform/dashboard/market-payments" ? <PlatformMarketPaymentsPanel /> : location === "/platform/dashboard/platform-staff" ? <PlatformTeamManager /> : location === "/platform/dashboard/plans" ? <PlansManager /> : location === "/platform/dashboard/subscriptions" ? <SubscriptionsManager /> : location === "/platform/dashboard/upgrade-requests" ? <UpgradeRequestsPanel /> : location === "/platform/dashboard/commissions" || location === "/platform/dashboard/settlements" || location === "/platform/dashboard/financial-reports" ? <FinanceCenter /> : location === "/platform/dashboard/account/security" ? (
            /* PC-1, then PS-2: «الأمان» is the acts a man performs on his own
               identity, in one place. The password card is the 19-أ component,
               reused rather than rebuilt.

               THE SECOND FACTOR COMES FIRST, and PC-1's ordering note is
               superseded: the email and password cards are maintenance he may
               never need, while ق-124 owes an OUTSTANDING act on a fresh
               account — and its card was missing from this page entirely from
               19-أ until PS-2, which is how a mandatory factor stayed
               impossible to turn on. First position is the correction. */
            <div className="space-y-4"><OwnerTotpCard /><OwnerEmailCard /><AccountSecurityPanel view="password" /></div>
          ) : location === "/platform/dashboard/account/contact" ? <PlatformContactCard /> : location === "/platform/dashboard/account/sessions-devices" ? <AccountSecurityPanel view="sessions" /> : location === "/platform/dashboard/merchants/registration-requests" ? <RegistrationCenter /> :
          isManualMerchantPage ? (
            <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
              <p className="mb-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">إضافة يدوية آمنة</p>
              <h2 className="mb-5 text-xl font-bold text-[#263650]">إنشاء تاجر نشط ومتجره الأول</h2>
              <ManualMerchantForm />
            </div>
          ) : (
            <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Sparkles className="h-5 w-5" /></div>
              <p className="text-lg font-bold text-[#263650]">{comingSoon ? `مساحة ${currentPage.label} قادمة ضمن الخطة` : `مساحة ${currentPage.label} جاهزة للربط لاحقًا`}</p>
              <p className="mt-2 max-w-sm text-sm leading-7 text-[var(--codiq-text-muted)]">{comingSoon ? `هذه الوظيفة مجدولة بدقة ضمن خارطة الطريق المعتمدة وستُبنى في موعدها (${comingSoon}). لا توجد بيانات أو أزرار تشغيلية هنا قبل ذلك.` : "الغرض من هذه المرحلة هو التحقق من هيكل التنقل وسلامة الوصول إلى الصفحة فقط. لا توجد بيانات حقيقية أو أزرار تشغيلية في هذه الشاشة."}</p>
              <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1.5 text-xs font-semibold text-[#65748B]"><FileText className="h-3.5 w-3.5" /> {comingSoon ?? "Placeholder · هيكل تنقل"}</div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
