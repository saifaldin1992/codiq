/**
 * Design reminder — codiq phase 3: calm Samsung One UI surfaces, RTL-first hierarchy,
 * merchant-only navigation, one open primary accordion, and placeholder-only content.
 */
import { ReturnsQueue } from "@/components/ReturnsQueue";
import {
  Archive,
  Box,
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  LogOut,
  ClipboardList,
  FileText,
  Gift,
  LayoutDashboard,
  Menu,
  PackageSearch,
  Settings2,
  Sparkles,
  ShoppingBag,
  StoreIcon,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { RoadmapPanel } from "@/components/RoadmapPanel";
import { merchantScreenFor } from "@/dashboard/merchant-screens";
import { BrandMark } from "@/components/BrandMark";
import { MerchantHome } from "@/components/MerchantHome";
import {
  MerchantCommandPalette,
  MerchantCommandPaletteButton,
  useMerchantCommandPalette,
} from "@/components/MerchantCommandPalette";
import { MerchantStoreSwitcher } from "@/components/MerchantStoreSwitcher";
import { ProductCatalogManager } from "@/components/ProductCatalogManager";
import { OrderWorkspace } from "@/components/OrderWorkspace";
import { MerchantAvailabilityBanner } from "@/components/MerchantAvailabilityBanner";
// PG-2: the trash bin owns the activity log as its fifth tab, so ONE import
// registers both screens the plan §4 asks for.
// Phase 14: the sidebar consumes the central navigation source only — no local nav tree.
import {
  comingSoonLabel,
  merchantDashboardPath as dashboardPath,
  merchantNavGroups as navGroups,
  merchantPrimaryEntry as primaryEntry,
  merchantRoadmap as roadmap,
  merchantRoadmapEntry as roadmapEntry,
  type NavEntry,
  type NavEntryStatus,
} from "@/config/navigation";

function canonicalMerchantDashboardPath(location: string) {
  const scoped = location.match(/^\/merchant\/stores\/[^/]+\/dashboard(?:\/(.*))?\/?$/);
  return scoped ? (scoped[1] ? `/merchant/dashboard/${scoped[1]}` : dashboardPath) : location;
}

function merchantPathForStore(path: string, storeSlug?: string) {
  if (!storeSlug || !path.startsWith("/merchant/dashboard")) return path;
  return `/merchant/stores/${storeSlug}/dashboard${path.slice("/merchant/dashboard".length)}`;
}

const pageIndex = new Map<string, { label: string; group: string; status: NavEntryStatus }>([
  [dashboardPath, { label: "الرئيسية", group: "Codiq — لوحة التاجر", status: "implemented" }],
  ...navGroups.flatMap((group) =>
    group.entries.map(
      (entry) =>
        [
          entry.path,
          { label: entry.label, group: entry.context ?? group.label, status: entry.status },
        ] as const
    )
  ),
  // The scheduled destinations left the sidebar but not the index: a bookmark
  // to one must still land on its own «قادمة ضمن المرحلة X» screen.
  ...roadmap.map(
    (entry) => [entry.path, { label: entry.label, group: "قريباً", status: entry.status }] as const
  ),
  [
    roadmapEntry.path,
    { label: roadmapEntry.label, group: "قريباً", status: "implemented" as const },
  ],
]);

function getPagePresentation(page: { label: string; group: string }) {
  // The roadmap is a REAL page, so it must not inherit the generic
  // «هيكل تنقل» blurb that describes an unbuilt one — that copy would say the
  // page is empty while the page lists fourteen destinations (ق-10).
  if (page.group === "قريباً")
    return {
      icon: Sparkles,
      eyebrow: "خارطة الطريق",
      detail: "الوجهات المجدولة التي لم تُبنَ بعد، مجموعة في مكان واحد بدل أن تتناثر داخل القوائم.",
    };
  // ق-204: the home and «واجهة المتجر» are real screens now; the generic blurb
  // below would say «no store data» above a page that is nothing but store data.
  if (page.label === "الرئيسية")
    return {
      icon: LayoutDashboard,
      eyebrow: "اليوم",
      detail:
        "نبض متجرك اليوم مقارنة بالأمس، ومؤشراته على مدى تختاره، وآخر طلباته ورصيدك — في شاشة واحدة.",
    };
  if (page.label === "واجهة المتجر")
    return {
      icon: ShoppingBag,
      eyebrow: "واجهة المتجر",
      detail:
        "كل ما يراه زبونك ويختلف من متجر لآخر — الاسم والشعار والصور الكبيرة والإعلان والتواصل والسياسات وأقسام الرئيسية — يُحرَّر هنا ويظهر في متجرك فوراً.",
    };
  // ق-249: «الخدمات» is a real screen — the generic settings blurb below would call it structure-only.
  if (page.label === "الخدمات")
    return {
      icon: Settings2,
      eyebrow: "الخدمات والإتاحة",
      detail:
        "ما يعمل في متجرك الآن وما ينتظر — كلّ قدرةٍ بحالتها وسببها كما تقرّرها المنصّة، لا كما تخمّنها الشاشة.",
    };
  if (page.label === "التهيئة")
    return {
      icon: Settings2,
      eyebrow: "التهيئة",
      detail:
        "ما ينطبق على متجرك ومَن قرّره — المنصّة ثمّ خطّتك ثمّ حسابك ثمّ المتجر — ورأيك حيث لك رأي.",
    };
  if (page.label === "الدفع")
    return {
      icon: Settings2,
      eyebrow: "وسائل الدفع",
      detail:
        "شغّل ما يقبله متجرك: الدفع عند الاستلام، والتحويل إلى محفظتك؛ البوابات الإلكترونية تُربط في مرحلتها.",
    };
  // PG-2: the «الإعدادات» blurb below still says those destinations are
  // structure-only, which is no longer true for several of them and is flatly
  // false above a working trash bin (ق-10). Fixing the whole group's copy is
  // outside this mandate — see the debt register — so this page states its own.
  if (page.label === "سلة المحذوفات")
    return {
      icon: Archive,
      eyebrow: "الاستعادة والتدقيق",
      detail:
        "كل ما أزلته من هذا المتجر قابل للاستعادة حتى موعد تنقيته، ومعه سجل «من فعل ماذا» غير القابل للتعديل.",
    };
  if (page.group.includes("صفحات المتجر"))
    return {
      icon: FileText,
      eyebrow: "محتوى المتجر",
      detail:
        "هذه مساحة صفحات المتجر المحدد فقط؛ وهي منفصلة بنيويًا عن صفحات الموقع التعريفي في لوحة المالك.",
    };
  if (page.group === "المتاجر")
    return {
      icon: StoreIcon,
      eyebrow: "إدارة المتاجر",
      detail: "هيكل هذه المساحة مخصص لتاجر واحد ومتاجره؛ لا يعرض حاليًا أي متجر أو بيانات تشغيلية.",
    };
  if (page.group === "الطلبات")
    return {
      icon: ClipboardList,
      eyebrow: "سير الطلبات",
      detail: "إدارة طلبات متجر الجلسة بحدود وصول صارمة وسجل حالة قابل للتدقيق.",
    };
  if (page.group === "المنتجات")
    return {
      icon: PackageSearch,
      eyebrow: "كتالوج المتجر",
      detail: "مساحة تجريبية لهيكل المنتج والمخزون، جاهزة للربط في مرحلة لاحقة فقط.",
    };
  if (page.group === "العملاء")
    return {
      icon: UsersRound,
      eyebrow: "عملاء المتجر",
      detail: "هذه الوجهة تخص عملاء متاجر التاجر فقط، ولا تمثل قسم عملاء عامًا للمنصة.",
    };
  if (page.group === "التسويق")
    return {
      icon: Gift,
      eyebrow: "التسويق",
      detail: "هيكل للعروض والحملات والتواصل دون حملات أو قسائم أو عمليات إرسال فعلية.",
    };
  if (page.group === "المتجر والمحتوى")
    return {
      icon: ShoppingBag,
      eyebrow: "واجهة المتجر",
      detail: "مساحة تنقل لتجربة المتجر ومحتواه، من دون تحرير أو نشر أو وسائط فعلية.",
    };
  if (page.group === "الإعدادات")
    return {
      icon: Settings2,
      eyebrow: "إعدادات التاجر",
      detail:
        "تظهر وجهات الإعدادات كبنية فقط؛ لا توجد تغييرات حفظ أو تكاملات أو إعدادات دفع في هذه المرحلة.",
    };
  // Phase 19-أ: «الأمان» و«الجلسات والأجهزة» صارتا شاشتين حقيقيتين، فالنص الذي
  // كان ينفي وجود أي إجراء أمني صار كاذباً (ق-10) — والباقي في المجموعة ما يزال بنية.
  if (page.group === "حسابي")
    return {
      icon: CircleUserRound,
      eyebrow: "حساب التاجر",
      detail:
        "الأمان والجلسات والأجهزة تعمل فعلياً: غيّر كلمة مرورك، وشاهد ما هو داخل إلى حسابك وأنهِ ما ليس أنت. بقية وجهات هذه المجموعة ما تزال بنية تنقل.",
    };
  return {
    icon: LayoutDashboard,
    eyebrow: "مساحة التاجر",
    detail: "نقطة انطلاق هيكلية للوحة التاجر، من دون بيانات متجر أو إجراءات تشغيلية.",
  };
}

function matchesPath(location: string, path: string) {
  return location === path || (path !== dashboardPath && location.startsWith(`${path}/`));
}

function initialAccordionSection(location: string): string {
  const requestedSection =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;
  if (requestedSection && navGroups.some((group) => group.id === requestedSection))
    return requestedSection;
  return (
    navGroups.find((group) => group.entries.some((entry) => matchesPath(location, entry.path)))
      ?.id ?? ""
  );
}

function MerchantSidebar({
  location,
  navigate,
  closeMobile,
  storeSlug,
}: {
  location: string;
  navigate: (path: string) => void;
  closeMobile: () => void;
  storeSlug?: string;
}) {
  // ق-251: the menu carries availability badges — one read of the services view per store, then each leaf
  // shows «قريباً» / «تحت الصيانة» / «موقوفة» beside what the platform closed, before a click lands on a 423.
  const [availability, setAvailability] = useState<
    Record<string, { state: string; label: string }>
  >({});
  useEffect(() => {
    if (!storeSlug) {
      setAvailability({});
      return;
    }
    const slug = storeSlug;
    let cancelled = false;
    fetch(`/api/merchant/stores/${encodeURIComponent(slug)}/services`, {
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          payload: {
            services?: { capabilities: { code: string; state: string; label: string }[] }[];
          } | null
        ) => {
          if (cancelled || !payload?.services) return;
          const next: Record<string, { state: string; label: string }> = {};
          for (const service of payload.services)
            for (const capability of service.capabilities)
              next[capability.code] = { state: capability.state, label: capability.label };
          setAvailability(next);
        }
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storeSlug]);
  // The merchant was the ONLY identity without a way out. The other four each
  // have one, and the sessions screen does not substitute: it hides the revoke
  // button for the CURRENT session on purpose, so the only door it offers is
  // the one door he needs.
  //
  // `codiq_session` is HttpOnly — the client cannot drop it. /auth/logout is
  // identity-generic (sessions.ts): it revokes the row and clears the cookie
  // server-side. Navigate either way, so a failed call never strands him on a
  // dashboard he asked to leave.
  //
  // D-88 is open and it applies here: the cookie is shared across identities,
  // so this ends whatever session the cookie currently carries.
  async function logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
    } catch {
      /* offline or refused: the navigation below still gets him out */
    }
    closeMobile();
    navigate("/merchant/login");
  }

  const [openSection, setOpenSection] = useState<string>(() => initialAccordionSection(location));
  const changePage = (path: string) => {
    navigate(merchantPathForStore(path, storeSlug));
    closeMobile();
  };

  return (
    <div className="flex h-full flex-col" dir="rtl">
      <div className="border-b border-[var(--codiq-border)] px-5 pb-4 pt-5">
        <div className="flex items-center gap-3">
          {/* ق-138 lockup rules: mark BEFORE word — the row is dir=ltr so the
              mark sits left even in this RTL shell; wordmark «Codiq». */}
          <div dir="ltr" className="flex items-center gap-3">
            <BrandMark className="h-11 w-11 rounded-2xl shadow-[0_8px_18px_rgba(30,111,219,0.22)]" />
            <div>
              <p className="text-[21px] font-bold tracking-[-0.04em] text-[#15233E]">Codiq</p>
              <p className="mt-0.5 text-xs font-medium text-[#8792A7]" dir="rtl">
                لوحة التاجر
              </p>
            </div>
          </div>
        </div>
        <MerchantStoreSwitcher activeStoreSlug={storeSlug} navigate={navigate} />
      </div>

      <nav aria-label="تنقل لوحة التاجر" className="codiq-scroll flex-1 overflow-y-auto px-3 py-4">
        <button
          type="button"
          onClick={() => changePage(primaryEntry.path)}
          className={`mb-2 flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-right text-sm font-semibold transition-all duration-200 ${matchesPath(location, primaryEntry.path) ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)] shadow-[inset_-3px_0_0_#1E6FDB]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-canvas)]"}`}
          aria-current={matchesPath(location, primaryEntry.path) ? "page" : undefined}
        >
          <LayoutDashboard className="h-[18px] w-[18px]" strokeWidth={1.9} />
          <span>{primaryEntry.label}</span>
        </button>
        <Accordion
          type="single"
          collapsible
          value={openSection}
          onValueChange={setOpenSection}
          className="space-y-2"
        >
          {navGroups.map((group) => {
            const Icon = group.icon;
            const groupHasActivePage = group.entries.some((entry) =>
              matchesPath(location, entry.path)
            );
            return (
              <AccordionItem key={group.id} value={group.id} className="border-0">
                <AccordionTrigger
                  className={`group rounded-2xl px-3.5 py-3 text-right no-underline hover:no-underline ${groupHasActivePage ? "bg-[var(--codiq-neutral-soft)] text-[#1A5CAC]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-canvas)]"}`}
                >
                  <span className="flex items-center gap-3 text-sm font-semibold">
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
                    {group.label}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-1 pt-1">
                  <div className="mr-5 border-r border-[var(--codiq-border)] py-1 pr-3">
                    <div className="space-y-0.5">
                      {group.entries.map((entry) => (
                        <NavLeaf
                          key={entry.path}
                          entry={entry}
                          location={location}
                          onNavigate={changePage}
                          availability={availability}
                        />
                      ))}
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
        {/* ONE entry for everything scheduled. Fifteen «قريباً» badges used to
            sit inline among the working screens; the roadmap is honest, but it
            belongs in a place a person visits on purpose. */}
        <button
          type="button"
          onClick={() => changePage(roadmapEntry.path)}
          className={`mt-2 flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-right text-sm font-semibold transition-all duration-200 ${matchesPath(location, roadmapEntry.path) ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)] shadow-[inset_-3px_0_0_var(--codiq-accent)]" : "text-[var(--codiq-text-muted)] hover:bg-[var(--codiq-canvas)]"}`}
          aria-current={matchesPath(location, roadmapEntry.path) ? "page" : undefined}
        >
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.9} />
          <span>{roadmapEntry.label}</span>
          <span className="ms-auto rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-text-muted)]">
            {roadmap.length}
          </span>
        </button>
      </nav>

      <div className="m-3 rounded-[20px] bg-[var(--codiq-canvas)] p-3.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm">
            <CircleUserRound className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-[#293750]">حساب التاجر</p>
            <p className="truncate text-[11px] text-[#8490A5]">وصول تجريبي للمتاجر</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-xs font-bold text-[var(--codiq-text-secondary)] transition-colors hover:border-[var(--codiq-danger)] hover:text-[var(--codiq-danger)]"
        >
          <LogOut className="h-4 w-4" />
          تسجيل الخروج
        </button>
      </div>
    </div>
  );
}

function NavLeaf({
  entry,
  location,
  onNavigate,
  availability,
}: {
  entry: NavEntry;
  location: string;
  onNavigate: (path: string) => void;
  availability?: Record<string, { state: string; label: string }>;
}) {
  const active = location === entry.path;
  const badge = comingSoonLabel(entry.status);
  // ق-251: the platform's word on this entry's capability, when it is not simply available.
  const capabilityState = entry.capability ? availability?.[entry.capability] : undefined;
  const availabilityBadge =
    capabilityState && capabilityState.state !== "AVAILABLE" ? capabilityState.label : null;
  return (
    <button
      type="button"
      onClick={() => onNavigate(entry.path)}
      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-right text-[13px] transition-colors ${active ? "bg-[var(--codiq-surface)] font-bold text-[var(--codiq-accent)] shadow-sm" : "font-medium text-[#68758A] hover:bg-[var(--codiq-surface)] hover:text-[#26344C]"}`}
      aria-current={active ? "page" : undefined}
    >
      <span>{entry.label}</span>
      {badge ? (
        <span className="shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#8490A5]">
          {badge}
        </span>
      ) : availabilityBadge ? (
        <span
          className="shrink-0 rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-warning)]"
          data-testid={`nav-availability-${entry.capability}`}
        >
          {availabilityBadge}
        </span>
      ) : active ? (
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--codiq-accent)]" />
      ) : null}
    </button>
  );
}

export default function MerchantDashboard() {
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  // ق-226: this shell drew itself for ANYONE who typed the URL — the only one of
  // four that did. Nothing leaked, because every screen's own request was refused
  // by the server; what happened instead was worse to read: a signed-out merchant
  // got a full dashboard whose every card said «تعذر التحميل», and a store
  // employee or a platform owner (D-88: one cookie, five identities) landed on
  // the merchant's chrome instead of his own door. ق-171 closed exactly this for
  // the owner and the staff shells with a session probe; this is the merchant's.
  //
  // 401 → nobody is signed in · 403 → somebody else is, or this merchant is
  // suspended (ق-225) — and the one thing every one of them can do here is sign
  // in as a merchant. `mustChangePassword` (ق-218) is not a refusal: he IS the
  // merchant, and the shell owes him the one screen that lets him continue.
  const [gate, setGate] = useState<"checking" | "open">("checking");
  const securityPath = "/merchant/dashboard/account/security";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/merchant/session", { credentials: "same-origin" });
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          navigate("/merchant/login");
          return;
        }
        if (response.ok) {
          const session = await response.json().catch(() => null);
          if (cancelled) return;
          if (
            session?.mustChangePassword &&
            canonicalMerchantDashboardPath(location) !== securityPath
          ) {
            navigate(
              merchantPathForStore(
                securityPath,
                location.match(/^\/merchant\/stores\/([^/]+)\/dashboard/)?.[1]
              )
            );
            return;
          }
        }
      } catch {
        /* offline or refused: the screens' own calls will say so in place */
      }
      if (!cancelled) setGate("open");
    })();
    return () => {
      cancelled = true;
    };
    // Probed once per shell mount, exactly like the owner's: a session that dies
    // mid-visit is caught by the next screen's own 401, not by polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // MD-1: the unified search palette lives at the shell level so Ctrl/⌘+K works
  // on every merchant page, whichever layout branch renders below.
  const { open: searchOpen, setOpen: setSearchOpen } = useMerchantCommandPalette();
  const resolvedLocation = useMemo(() => canonicalMerchantDashboardPath(location), [location]);
  const storeSlug = useMemo(
    () => location.match(/^\/merchant\/stores\/([^/]+)\/dashboard/)?.[1],
    [location]
  );
  const currentPage = useMemo(
    () =>
      pageIndex.get(resolvedLocation) ?? {
        label: "صفحة تجريبية",
        group: "لوحة التاجر",
        status: "implemented" as NavEntryStatus,
      },
    [resolvedLocation]
  );
  const comingSoon = comingSoonLabel(currentPage.status);
  const pageMeta = getPagePresentation(currentPage);
  const PageIcon = pageMeta.icon;
  const productMode =
    resolvedLocation === "/merchant/dashboard/products/add"
      ? "add"
      : resolvedLocation === "/merchant/dashboard/products/categories"
        ? "categories"
        : resolvedLocation === "/merchant/dashboard/products/inventory"
          ? "inventory"
          : resolvedLocation === "/merchant/dashboard/products/import-export"
            ? "import-export"
            : resolvedLocation === "/merchant/dashboard/products"
              ? "list"
              : null;
  const orderRoute = resolvedLocation.match(
    /^\/merchant\/dashboard\/orders(?:\/([^/]+))?(?:\/history)?$/
  );
  const orderSegment = orderRoute?.[1];
  // The removed status sub-menus keep their deep links: every old URL still
  // opens the orders workspace with its preset (the chips carry it in-page).
  const orderFilters: Record<
    string,
    {
      title: string;
      status?:
        | "new"
        | "processing"
        | "preparation"
        | "out_for_delivery"
        | "completed"
        | "cancelled"
        | "rejected"
        | "returned";
      preset?: "action-needed";
    }
  > = {
    "": { title: "جميع الطلبات" },
    "action-needed": { title: "طلبات بحاجة لإجراء", preset: "action-needed" },
    new: { title: "طلبات جديدة", status: "new" },
    processing: { title: "طلبات قيد المعالجة", status: "processing" },
    preparation: { title: "طلبات قيد التجهيز", status: "preparation" },
    "out-for-delivery": { title: "طلبات قيد التوصيل", status: "out_for_delivery" },
    completed: { title: "طلبات مكتملة", status: "completed" },
    cancelled: { title: "طلبات ملغاة", status: "cancelled" },
    rejected: { title: "طلبات مرفوضة", status: "rejected" },
    returned: { title: "طلبات مرتجعة", status: "returned" },
  };
  // «returns» was a filter key here too, which made this branch swallow
  // /orders/returns BEFORE the ReturnsQueue mount below could ever run — the
  // sidebar «الإرجاع» opened a mere returned-orders list and the CD-3 refund
  // queue was unreachable dead code (flagged during RI-1, fixed with it). The
  // returned-status LIST is still one chip away inside the workspace.
  const orderMode =
    orderRoute &&
    orderSegment !== "delivery" &&
    orderSegment !== "settlements" &&
    orderSegment !== "reports" &&
    orderSegment !== "returns" &&
    orderSegment !== "support-tickets"
      ? orderFilters[orderSegment ?? ""]
        ? { kind: "list" as const, ...orderFilters[orderSegment ?? ""] }
        : {
            kind: "detail" as const,
            orderId: orderSegment!,
            backPath: merchantPathForStore("/merchant/dashboard/orders", storeSlug),
          }
      : null;
  // ق-226: nothing of the merchant's chrome is drawn until the probe answers.
  if (gate === "checking") {
    return (
      <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
        <p className="text-sm font-semibold text-[var(--codiq-text-secondary)]">
          جارٍ التحقق من الجلسة…
        </p>
      </main>
    );
  }

  // P27-7: the demo banner is mounted once in the Router (App.tsx) so it also
  // covers the routes that have no shell; it must not be repeated per shell.
  if (productMode)
    return (
      <div className="min-h-screen bg-[var(--codiq-canvas)] text-[#17233A] lg:flex" dir="rtl">
        <aside className="sticky top-0 z-30 hidden h-screen w-[328px] shrink-0 border-l border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] shadow-[-16px_0_38px_rgba(36,52,82,0.055)] lg:block">
          <MerchantSidebar
            location={resolvedLocation}
            navigate={navigate}
            closeMobile={() => undefined}
            storeSlug={storeSlug}
          />
        </aside>
        {mobileOpen ? (
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-[#17233A]/20 lg:hidden"
            aria-label="إغلاق القائمة"
          />
        ) : null}
        <aside
          className={`fixed inset-y-0 right-0 z-50 w-[328px] border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] lg:hidden ${mobileOpen ? "translate-x-0" : "translate-x-full"}`}
        >
          <div className="absolute left-3 top-3 z-10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(false)}
              aria-label="إغلاق القائمة"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <MerchantSidebar
            location={resolvedLocation}
            navigate={navigate}
            closeMobile={() => setMobileOpen(false)}
            storeSlug={storeSlug}
          />
        </aside>
        <main className="min-h-screen min-w-0 flex-1">
          <header className="flex items-center justify-between px-5 pb-4 pt-5 sm:px-8 lg:px-10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(true)}
              className="rounded-xl lg:hidden"
              aria-label="فتح القائمة"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="mr-auto flex items-center gap-2">
              <MerchantCommandPaletteButton onOpen={() => setSearchOpen(true)} />
              <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)]">
                <Box className="h-4 w-4 text-[var(--codiq-accent)]" />
                إدارة منتجات المتجر
              </div>
            </div>
          </header>
          <MerchantCommandPalette
            storeSlug={storeSlug}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            navigate={navigate}
          />
          <section className="relative mx-5 overflow-hidden rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] px-6 py-6 shadow-[0_12px_36px_rgba(32,52,87,0.055)] sm:mx-8 sm:px-9 sm:py-7 lg:mx-10">
            <div className="relative z-10">
              <p className="text-xs font-bold text-[var(--codiq-accent)]">
                المنتجات ← المتجر الحالي
              </p>
              <h1 className="mt-2 text-3xl font-bold text-[#15233E]">{currentPage.label}</h1>
              <p className="mt-2 text-sm leading-7 text-[#61708A]">
                إدارة فعلية مقيدة بمتجر جلسة التاجر، مع حماية API وقاعدة البيانات من أي عبور بين
                المتاجر.
              </p>
            </div>
          </section>
          <section className="mx-5 py-6 sm:mx-8 lg:mx-10 lg:py-7">
            <ProductCatalogManager storeSlug={storeSlug} mode={productMode} />
          </section>
        </main>
      </div>
    );
  return (
    <div className="min-h-screen bg-[var(--codiq-canvas)] text-[#17233A] lg:flex" dir="rtl">
      <aside className="sticky top-0 z-30 hidden h-screen w-[328px] shrink-0 border-l border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] shadow-[-16px_0_38px_rgba(36,52,82,0.055)] lg:block">
        <MerchantSidebar
          location={resolvedLocation}
          navigate={navigate}
          closeMobile={() => undefined}
          storeSlug={storeSlug}
        />
      </aside>
      {mobileOpen ? (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-[#17233A]/20 lg:hidden"
          aria-label="إغلاق القائمة"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 right-0 z-50 w-[328px] border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] lg:hidden ${mobileOpen ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="absolute left-3 top-3 z-10">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(false)}
            aria-label="إغلاق القائمة"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <MerchantSidebar
          location={resolvedLocation}
          navigate={navigate}
          closeMobile={() => setMobileOpen(false)}
          storeSlug={storeSlug}
        />
      </aside>
      <main className="min-h-screen min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 pb-4 pt-5 sm:px-8 lg:px-10">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(true)}
            className="rounded-xl lg:hidden"
            aria-label="فتح القائمة"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="mr-auto flex items-center gap-2">
            <MerchantCommandPaletteButton onOpen={() => setSearchOpen(true)} />
            <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm">
              <Box className="h-4 w-4 text-[var(--codiq-accent)]" /> وضع التاجر التجريبي
            </div>
          </div>
        </header>
        <MerchantCommandPalette
          storeSlug={storeSlug}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          navigate={navigate}
        />
        <section className="relative mx-5 overflow-hidden rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] px-6 py-6 shadow-[0_12px_36px_rgba(32,52,87,0.055)] sm:mx-8 sm:px-9 sm:py-7 lg:mx-10">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_92%_28%,rgba(30,111,219,0.12),transparent_27%),radial-gradient(circle_at_78%_90%,rgba(111,106,255,0.08),transparent_23%)]" />
          <div className="relative z-10 flex max-w-3xl items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)] shadow-[0_8px_18px_rgba(30,111,219,0.11)]">
              <PageIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--codiq-text-muted)]">
                <span>{currentPage.group}</span>
                <ChevronLeft className="h-3.5 w-3.5" />
                <span className="text-[var(--codiq-accent)]">{currentPage.label}</span>
              </div>
              <h1 className="text-3xl font-bold tracking-[-0.04em] text-[#15233E] sm:text-[34px]">
                {currentPage.label}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-7 text-[#61708A]">{pageMeta.detail}</p>
            </div>
          </div>
          <div className="absolute bottom-0 right-0 h-2/3 w-1.5 rounded-tl-full bg-[var(--codiq-accent)]/80" />
        </section>
        {/* ق-250: what the platform has to tell him sits above every screen, and leaves by itself. */}
        <MerchantAvailabilityBanner storeSlug={storeSlug} />
        <section className="mx-5 py-6 sm:mx-8 lg:mx-10 lg:py-7">
          {orderMode ? (
            <OrderWorkspace
              key={resolvedLocation}
              scope={{ kind: "merchant", storeSlug: storeSlug ?? "" }}
              mode={orderMode}
              navigate={navigate}
            />
          ) : resolvedLocation === dashboardPath ? (
            <MerchantHome storeSlug={storeSlug} navigate={navigate} />
          ) : resolvedLocation === roadmapEntry.path ? (
            <RoadmapPanel entries={roadmap} />
          ) : (
            (merchantScreenFor(resolvedLocation, { storeSlug, navigate }) ?? (
              <div className="grid max-w-[1030px] gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
                <div className="overflow-hidden rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
                  <div className="flex items-start gap-5 p-7 sm:p-9">
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-[19px] bg-[#F0F5FF] text-[var(--codiq-accent)]">
                      <PageIcon className="h-7 w-7" strokeWidth={1.5} />
                    </div>
                    <div>
                      <p className="text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
                        {pageMeta.eyebrow}
                      </p>
                      <p className="mt-2 text-xl font-bold text-[#263650]">
                        {comingSoon
                          ? `مساحة ${currentPage.label} قادمة ضمن الخطة`
                          : `مساحة ${currentPage.label} جاهزة للربط لاحقًا`}
                      </p>
                      <p className="mt-2 max-w-xl text-sm leading-7 text-[var(--codiq-text-muted)]">
                        {comingSoon
                          ? `هذه الوظيفة مجدولة بدقة ضمن خارطة الطريق المعتمدة وستُبنى في موعدها (${comingSoon}). لا توجد بيانات أو أزرار تشغيلية هنا قبل ذلك.`
                          : pageMeta.detail}
                      </p>
                      <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1.5 text-xs font-semibold text-[#65748B]">
                        <FileText className="h-3.5 w-3.5" />{" "}
                        {comingSoon ?? "Placeholder · هيكل تنقل"}
                      </div>
                    </div>
                  </div>
                </div>
                <aside className="rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-5">
                  <p className="text-sm font-bold text-[#33435D]">حالة المساحة</p>
                  <div className="mt-4 space-y-3">
                    <div className="rounded-2xl bg-[var(--codiq-surface)] px-3.5 py-3 shadow-sm">
                      <p className="text-[11px] font-semibold text-[#8A96A9]">السياق</p>
                      <p className="mt-1 text-sm font-bold text-[#385074]">{currentPage.group}</p>
                    </div>
                    <div className="rounded-2xl bg-[var(--codiq-surface)] px-3.5 py-3 shadow-sm">
                      <p className="text-[11px] font-semibold text-[#8A96A9]">الوصول</p>
                      <p className="mt-1 text-sm font-bold text-[#385074]">
                        {comingSoon ? "مجدولة" : "هيكل فقط"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-dashed border-[#CBD9ED] px-3.5 py-3 text-xs leading-6 text-[#687993]">
                      {comingSoon
                        ? `الوجهة تُفتح فعلياً ضمن ${comingSoon.replace("قريباً — ", "")}.`
                        : "لا توجد بيانات متجر أو إجراءات متاحة في هذه المرحلة."}
                    </div>
                  </div>
                </aside>
              </div>
            ))
          )}
        </section>
      </main>
    </div>
  );
}
