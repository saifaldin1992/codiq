/**
 * codiq phase 14 — staff shell. Identity and permissions come exclusively from the
 * read-only server session endpoint; the sidebar renders only permitted entries from
 * the central navigation source, and every action still authorizes on the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { BadgeCheck, CircleAlert, CircleUserRound, LoaderCircle, LogOut, Menu, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { CustomersDirectory } from "@/components/CustomersDirectory";
import { NotificationCenter } from "@/components/NotificationCenter";
import { OrderWorkspace, type OrderStatus } from "@/components/OrderWorkspace";
import { ProductCatalogManager } from "@/components/ProductCatalogManager";
import { StoreTeamManager } from "@/components/StoreTeamManager";
import { TrashBin } from "@/components/TrashBin";
import { ActivityLog } from "@/components/ActivityLog";
import { staffDashboardBase, staffEntryPath, visibleStaffEntries, type StaffNavEntry } from "@/config/navigation";

type StaffSession = {
  staff: { id: string; email: string; displayName: string };
  store: { slug: string };
  membership: { id: string; roleCode: "store_manager" | "store_staff"; permissionVersion: number };
  permissions: string[];
};

const ROLE_LABELS = { store_manager: "مدير متجر", store_staff: "موظف متجر" } as const;

function StaffSidebar({ storeSlug, entries, location, navigate, closeMobile, session }: {
  storeSlug: string;
  entries: StaffNavEntry[];
  location: string;
  navigate: (path: string) => void;
  closeMobile: () => void;
  session: StaffSession;
}) {
  const base = staffDashboardBase(storeSlug);
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
            <p className="mt-0.5 text-xs font-medium text-[#8792A7]" dir="rtl">لوحة موظف المتجر</p>
          </div>
          </div>
        </div>
        <div className="mt-3 rounded-2xl bg-[var(--codiq-canvas)] px-3.5 py-3">
          <p className="truncate text-xs font-bold text-[#293750]">{session.store.slug}</p>
          <p className="mt-0.5 truncate text-[11px] text-[#8490A5]">سياق العضوية مقيد بهذا المتجر فقط</p>
        </div>
      </div>
      <nav aria-label="تنقل لوحة الموظف" className="codiq-scroll flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          {entries.map((entry) => {
            const path = staffEntryPath(storeSlug, entry);
            const active = path === base ? location === base : location === path || location.startsWith(`${path}/`);
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                data-testid={`staff-nav-${entry.id}`}
                onClick={() => { navigate(path); closeMobile(); }}
                className={`flex w-full items-center justify-between rounded-2xl px-3.5 py-3 text-right text-sm font-semibold transition-all duration-200 ${active ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)] shadow-[inset_-3px_0_0_#1E6FDB]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-canvas)]"}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="flex items-center gap-3"><Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />{entry.label}</span>
                {entry.status === "placeholder" ? <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#8490A5]">قريباً</span> : null}
              </button>
            );
          })}
        </div>
      </nav>
      <div className="m-3 rounded-[20px] bg-[var(--codiq-canvas)] p-3.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm"><CircleUserRound className="h-5 w-5" /></div>
          <div className="min-w-0">
            <p data-testid="staff-display-name" className="truncate text-xs font-bold text-[#293750]">{session.staff.displayName}</p>
            <p className="truncate text-[11px] text-[#8490A5]">{ROLE_LABELS[session.membership.roleCode]}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StaffDashboard() {
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [session, setSession] = useState<StaffSession | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const storeSlug = useMemo(() => location.match(/^\/staff\/stores\/([^/]+)\/dashboard/)?.[1] ?? "", [location]);
  const base = staffDashboardBase(storeSlug);

  const loadSession = useCallback(async () => {
    if (!storeSlug) return;
    const response = await fetch(`/api/staff/stores/${encodeURIComponent(storeSlug)}/session`, { credentials: "same-origin" });
    if (response.status === 401) { navigate("/staff/login"); return; }
    const body = await response.json().catch(() => null);
    if (!response.ok) { setFailure(body?.error?.message ?? "تعذر تحميل جلسة الموظف."); return; }
    setSession(body);
    setFailure(null);
  }, [storeSlug, navigate]);

  useEffect(() => { void loadSession(); }, [loadSession]);

  if (failure) {
    return <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5"><p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p></main>;
  }
  if (!session) {
    return <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5"><p className="flex items-center gap-2 text-sm font-semibold text-[var(--codiq-text-secondary)]"><LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ التحقق من جلسة الموظف…</p></main>;
  }

  const entries = visibleStaffEntries(session.permissions);
  const section = location === base ? "" : location.slice(base.length + 1).split("/")[0] ?? "";
  const orderRoute = location.match(/^\/staff\/stores\/[^/]+\/dashboard\/orders(?:\/([^/]+))?$/);
  const orderSegment = orderRoute?.[1];
  const orderFilters: Record<string, { title: string; status?: OrderStatus }> = { "": { title: "جميع الطلبات" } };
  const orderMode = orderRoute ? (orderFilters[orderSegment ?? ""] ? { kind: "list" as const, ...orderFilters[orderSegment ?? ""] } : { kind: "detail" as const, orderId: orderSegment!, backPath: `${base}/orders` }) : null;
  const activeEntry = entries.find((entry) => entry.segment === section) ?? entries[0];

  async function logout() {
    // `codiq_session` is HttpOnly — the client CANNOT drop it, so the old
    // cookie-expiry line did nothing and left a LIVE server session behind a
    // login screen: reopening the tab walked straight back in. /auth/logout is
    // identity-generic (sessions.ts); it revokes the row and clears the cookie
    // server-side. Navigate either way — a failed call must not strand him.
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    } catch {
      /* offline or refused: the navigation below still gets him out */
    }
    navigate("/staff/login");
  }

  let content: React.ReactNode;
  if (orderMode && session.permissions.includes("orders.view")) {
    content = <OrderWorkspace key={location} scope={{ kind: "merchant", storeSlug, dashboardBase: base }} mode={orderMode} navigate={navigate} />;
  } else if (section === "products" && session.permissions.includes("catalog.products.view")) {
    content = <ProductCatalogManager storeSlug={storeSlug} mode="list" />;
  } else if (section === "inventory" && session.permissions.includes("inventory.update")) {
    content = <ProductCatalogManager storeSlug={storeSlug} mode="inventory" />;
  } else if (section === "customers" && session.permissions.includes("customers.view")) {
    // Menus pass A: the same directory component the merchant dashboard uses;
    // the server enforces customers.view on every request either way.
    content = <CustomersDirectory storeSlug={storeSlug} />;
  } else if (section === "trash" && session.permissions.includes("catalog.trash.view")) {
    // ق-178: the same bin the merchant opens; restore stays gated on
    // catalog.trash.restore inside it, and on the server either way.
    content = <TrashBin storeSlug={storeSlug} permissions={session.permissions} />;
  } else if (section === "activity" && session.permissions.includes("catalog.audit.view")) {
    content = <ActivityLog storeSlug={storeSlug} />;
  } else if (section === "team" && session.permissions.includes("team.manage")) {
    content = <StoreTeamManager storeSlug={storeSlug} />;
  } else if (section === "settings" && session.permissions.includes("settings.manage")) {
    content = <NotificationCenter storeSlug={storeSlug} />;
  } else if (section === "") {
    content = (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><ShieldCheck className="h-5 w-5" /></div>
        <p className="text-lg font-bold text-[#263650]">أهلاً {session.staff.displayName}</p>
        <p className="mt-2 max-w-md text-sm leading-7 text-[var(--codiq-text-muted)]">تعمل هذه الجلسة بدور «{ROLE_LABELS[session.membership.roleCode]}» داخل المتجر {session.store.slug} فقط. تظهر في القائمة الجانبية العناصر المصرح بها لعضويتك، ويتحقق الخادم من كل طلب على حدة.</p>
        <div className="mt-5 flex flex-wrap gap-1.5" data-testid="staff-permission-chips">
          {session.permissions.map((permission) => <span key={permission} className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[#65748B]" dir="ltr">{permission}</span>)}
        </div>
      </div>
    );
  } else {
    content = (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="text-lg font-bold text-[#263650]">مساحة {activeEntry?.label ?? section} غير متاحة بعد</p>
        <p className="mt-2 max-w-md text-sm leading-7 text-[var(--codiq-text-muted)]">هذه الوجهة إما placeholder في المرحلة الحالية أو خارج صلاحيات عضويتك. الخادم يرفض أي طلب غير مخول بغض النظر عن الواجهة.</p>
      </div>
    );
  }

  return (
    // P27-7: the demo banner is mounted once in the Router (App.tsx) so it also
    // covers the routes that have no shell; it must not be repeated per shell.
    <div className="min-h-screen bg-[var(--codiq-canvas)] text-[#17233A] lg:flex" dir="rtl">
      <aside className="sticky top-0 z-30 hidden h-screen w-[300px] shrink-0 border-l border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] shadow-[-16px_0_38px_rgba(36,52,82,0.055)] lg:block">
        <StaffSidebar storeSlug={storeSlug} entries={entries} location={location} navigate={navigate} closeMobile={() => undefined} session={session} />
      </aside>
      {mobileOpen ? <button type="button" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-[#17233A]/20 lg:hidden" aria-label="إغلاق القائمة" /> : null}
      <aside className={`fixed inset-y-0 right-0 z-50 w-[300px] border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] lg:hidden ${mobileOpen ? "translate-x-0" : "translate-x-full"}`}>
        <div className="absolute left-3 top-3 z-10"><Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="إغلاق القائمة"><X className="h-5 w-5" /></Button></div>
        <StaffSidebar storeSlug={storeSlug} entries={entries} location={location} navigate={navigate} closeMobile={() => setMobileOpen(false)} session={session} />
      </aside>
      <main className="min-h-screen min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 pb-4 pt-5 sm:px-8 lg:px-10">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="rounded-xl lg:hidden" aria-label="فتح القائمة"><Menu className="h-5 w-5" /></Button>
          <div className="mr-auto flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm"><BadgeCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> جلسة موظف مقيدة بالعضوية</div>
            <Button variant="ghost" size="sm" onClick={() => void logout()} className="rounded-xl text-[var(--codiq-text-secondary)]" data-testid="staff-logout"><LogOut className="ml-1 h-4 w-4" /> خروج</Button>
          </div>
        </header>
        <section className="relative mx-5 overflow-hidden rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] px-6 py-6 shadow-[0_12px_36px_rgba(32,52,87,0.055)] sm:mx-8 sm:px-9 sm:py-7 lg:mx-10">
          <div className="relative z-10">
            <p className="text-xs font-bold text-[var(--codiq-accent)]">لوحة الموظف ← {session.store.slug}</p>
            <h1 className="mt-2 text-3xl font-bold text-[#15233E]">{activeEntry?.label ?? "لوحة الموظف"}</h1>
            <p className="mt-2 max-w-xl text-sm leading-7 text-[#61708A]">صلاحياتك محسوبة على الخادم من الدور والاستثناءات المعتمدة؛ الواجهة تعرض فقط ولا تقرر.</p>
          </div>
          <div className="absolute bottom-0 right-0 h-2/3 w-1.5 rounded-tl-full bg-[var(--codiq-accent)]/80" />
        </section>
        <section className="mx-5 py-6 sm:mx-8 lg:mx-10 lg:py-7">{content}</section>
      </main>
    </div>
  );
}
