/**
 * codiq المرحلة 19-ب — platform-staff shell. Identity and permissions come
 * exclusively from the read-only server session endpoint; the sidebar renders
 * only permitted entries from the central navigation source, and every action
 * still authorizes on the server. The sections mount the SAME components the
 * owner dashboard uses — they already call /api/platform/* and the server
 * resolves what this session may touch.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  BadgeCheck,
  CircleAlert,
  CircleUserRound,
  KeyRound,
  LoaderCircle,
  LogOut,
  Menu,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/BrandMark";
import { AccountSecurityPanel } from "@/components/AccountSecurityPanel";
import { FinanceCenter } from "@/components/FinanceCenter";
import { MerchantsDirectory } from "@/components/MerchantsDirectory";
import { OrderWorkspace } from "@/components/OrderWorkspace";
import { PlatformPulse } from "@/components/PlatformPulse";
import { PlatformLogoSection } from "@/components/PlatformLogoSection";
import { AuditTimeline } from "@/components/PlatformTeamManager";
import { PlansManager } from "@/components/PlansManager";
import { PlatformStoresDirectory } from "@/components/PlatformStoresDirectory";
import { PlatformServicesPanel } from "@/components/PlatformServicesPanel";
import { RegistrationCenter } from "@/components/RegistrationCenter";
import { SubscriptionsManager } from "@/components/SubscriptionsManager";
import { UpgradeRequestsPanel } from "@/components/UpgradeRequestsPanel";
import {
  platformStaffDashboardBase,
  platformStaffEntryPath,
  platformStaffNavEntries,
  visiblePlatformStaffEntries,
  type PlatformStaffNavEntry,
} from "@/config/platform-staff-navigation";

type PlatformStaffSession = {
  staff: { id: string; email: string; displayName: string };
  roleCode: "registrations_admin" | "accountant" | "supervisor";
  permissionVersion: number;
  permissions: string[];
  totpEnrolled: boolean;
};

const ROLE_LABELS = {
  registrations_admin: "مشرف تسجيلات",
  accountant: "محاسب",
  supervisor: "مشرف عام",
} as const;

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? `فشل الطلب (${response.status})`;
}

/**
 * ق-124: the second factor is MANDATORY for platform staff — a pre-enrolment
 * session reaches only the enrolment routes, so this screen blocks the whole
 * shell until the code is confirmed. Text + copy suffices deliberately: no QR
 * library enters the bundle for a screen each member sees exactly once.
 */
function TotpEnrolmentScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [material, setMaterial] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/platform/staff/security/totp/begin", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(await readError(response));
        const body = await response.json();
        if (!cancelled) setMaterial({ secret: body.secret, otpauthUri: body.uri });
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/platform/staff/security/totp/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response));
      onEnrolled();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  function copyText(value: string, copied: string) {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setNotice(copied);
  }

  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
      <div className="w-full max-w-lg rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
          <KeyRound className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-bold text-[var(--codiq-text)]">فعّل المصادقة الثنائية أولاً</h1>
        <p className="mt-2 text-sm leading-7 text-[var(--codiq-text-muted)]">
          عضويتك في طاقم المنصة تشترط رمزاً ثانياً مع كل دخول. أضف المفتاح أدناه إلى تطبيق مصادقة
          على هاتفك، ثم أدخل الرمز الظاهر فيه لتأكيد التفعيل — لن تصل إلى أي شاشة قبل ذلك.
        </p>
        {failure ? (
          <p
            data-testid="platform-staff-totp-error"
            className="mt-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          >
            <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">
            {notice}
          </p>
        ) : null}
        {material === null && !failure ? (
          <p className="mt-5 flex items-center gap-2 text-sm font-semibold text-[var(--codiq-text-secondary)]">
            <LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ توليد المفتاح…
          </p>
        ) : null}
        {material ? (
          <>
            <div className="mt-5 space-y-3">
              <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
                <p className="mb-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
                  المفتاح السري
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    data-testid="platform-staff-totp-secret"
                    dir="ltr"
                    className="break-all rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-mono text-sm font-bold tracking-wider text-[var(--codiq-text)]"
                  >
                    {material.secret}
                  </code>
                  <button
                    type="button"
                    data-testid="platform-staff-totp-copy-secret"
                    className="rounded-lg border border-[var(--codiq-border)] px-2 py-1 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:bg-[var(--codiq-surface)]"
                    onClick={() =>
                      copyText(material.secret, "نُسخ المفتاح — ألصقه في تطبيق المصادقة.")
                    }
                  >
                    نسخ
                  </button>
                </div>
              </div>
              <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
                <p className="mb-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
                  رابط otpauth (للتطبيقات التي تقبل لصق الرابط)
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    dir="ltr"
                    className="break-all rounded-lg bg-[var(--codiq-surface)] px-2 py-1 font-mono text-[11px] text-[var(--codiq-text-secondary)]"
                  >
                    {material.otpauthUri}
                  </code>
                  <button
                    type="button"
                    data-testid="platform-staff-totp-copy-uri"
                    className="rounded-lg border border-[var(--codiq-border)] px-2 py-1 text-xs font-bold text-[var(--codiq-text-secondary)] transition hover:bg-[var(--codiq-surface)]"
                    onClick={() =>
                      copyText(material.otpauthUri, "نُسخ الرابط — ألصقه في تطبيق المصادقة.")
                    }
                  >
                    نسخ
                  </button>
                </div>
              </div>
            </div>
            <form onSubmit={confirm} className="mt-5 space-y-3">
              <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
                <span>الرمز الظاهر في التطبيق الآن</span>
                <Input
                  data-testid="platform-staff-totp-code"
                  name="code"
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <Button
                type="submit"
                disabled={busy || code.trim().length === 0}
                data-testid="platform-staff-totp-confirm"
                className="h-11 w-full rounded-xl text-base"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تأكيد التفعيل"}
              </Button>
            </form>
          </>
        ) : null}
      </div>
    </main>
  );
}

function PlatformStaffSidebar({
  entries,
  location,
  navigate,
  closeMobile,
  session,
}: {
  entries: PlatformStaffNavEntry[];
  location: string;
  navigate: (path: string) => void;
  closeMobile: () => void;
  session: PlatformStaffSession;
}) {
  const base = platformStaffDashboardBase;
  return (
    <div className="flex h-full flex-col" dir="rtl">
      <div className="border-b border-[var(--codiq-border)] px-5 pb-4 pt-5">
        <div className="flex items-center gap-3">
          {/* ق-138 lockup rules: mark BEFORE word — the row is dir=ltr so the
              mark sits left even in this RTL shell; wordmark «Codiq». */}
          <div dir="ltr" className="flex items-center gap-3">
            <BrandMark className="h-11 w-11 rounded-2xl shadow-[0_8px_18px_rgba(30,111,219,0.22)]" />
            <div>
              <p className="text-[21px] font-bold tracking-[-0.04em] text-[var(--codiq-text)]">
                Codiq
              </p>
              <p className="mt-0.5 text-xs font-medium text-[var(--codiq-text-muted)]" dir="rtl">
                لوحة طاقم المنصة
              </p>
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-2xl bg-[var(--codiq-surface-sunken)] px-3.5 py-3">
          <p className="truncate text-xs font-bold text-[var(--codiq-text)]">
            {ROLE_LABELS[session.roleCode]}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[var(--codiq-text-muted)]">
            الصلاحيات تُحسم على الخادم مع كل طلب
          </p>
        </div>
      </div>
      <nav
        aria-label="تنقل لوحة طاقم المنصة"
        className="codiq-scroll flex-1 overflow-y-auto px-3 py-4"
      >
        <div className="space-y-1">
          {entries.map((entry) => {
            const path = platformStaffEntryPath(entry);
            const active =
              path === base
                ? location === base
                : location === path || location.startsWith(`${path}/`);
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                data-testid={`platform-staff-nav-${entry.id}`}
                onClick={() => {
                  navigate(path);
                  closeMobile();
                }}
                className={`flex w-full items-center justify-between rounded-2xl px-3.5 py-3 text-right text-sm font-semibold transition-all duration-200 ${active ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)] shadow-[inset_-3px_0_0_var(--codiq-accent)]" : "text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-surface-sunken)]"}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
                  {entry.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="m-3 rounded-[20px] bg-[var(--codiq-surface-sunken)] p-3.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--codiq-surface)] text-[var(--codiq-accent)] shadow-sm">
            <CircleUserRound className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p
              data-testid="platform-staff-display-name"
              className="truncate text-xs font-bold text-[var(--codiq-text)]"
            >
              {session.staff.displayName}
            </p>
            <p className="truncate text-[11px] text-[var(--codiq-text-muted)]">
              {ROLE_LABELS[session.roleCode]}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PlatformStaffDashboard() {
  const [location, navigate] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [session, setSession] = useState<PlatformStaffSession | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const base = platformStaffDashboardBase;

  const loadSession = useCallback(async () => {
    const response = await fetch("/api/platform/staff/session", { credentials: "same-origin" });
    if (response.status === 401) {
      navigate("/platform/staff/login");
      return;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      setFailure(body?.error?.message ?? "تعذر تحميل جلسة طاقم المنصة.");
      return;
    }
    setSession(body);
    setFailure(null);
  }, [navigate]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (failure) {
    return (
      <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      </main>
    );
  }
  if (!session) {
    return (
      <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--codiq-text-secondary)]">
          <LoaderCircle className="h-4 w-4 animate-spin" /> جارٍ التحقق من جلسة طاقم المنصة…
        </p>
      </main>
    );
  }
  if (!session.totpEnrolled) {
    return (
      <TotpEnrolmentScreen
        onEnrolled={() => {
          setSession(null);
          void loadSession();
        }}
      />
    );
  }

  const entries = visiblePlatformStaffEntries(session.permissions);
  const section =
    location === base ? "" : location.startsWith(`${base}/`) ? location.slice(base.length + 1) : "";
  const orderRoute = location.match(/^\/platform\/staff\/dashboard\/orders(?:\/([^/]+))?$/);
  const orderSegment = orderRoute?.[1];
  const orderMode = orderRoute
    ? orderSegment === undefined
      ? { kind: "list" as const, title: "جميع الطلبات" }
      : { kind: "detail" as const, orderId: orderSegment, backPath: `${base}/orders` }
    : null;
  // Looked up over ALL entries, not the visible ones: a denied deep-link still
  // deserves its own name on the denial screen, not the home entry's.
  const activeEntry =
    platformStaffNavEntries.find(
      (entry) =>
        entry.segment !== "" &&
        (section === entry.segment || section.startsWith(`${entry.segment}/`))
    ) ?? entries[0];
  const can = (code: string) => session.permissions.includes(code);

  async function logout() {
    // `codiq_session` is HttpOnly, so the client CANNOT drop it — the old
    // client-side expiry line was a no-op that left a live server session
    // behind a login screen: anyone reopening the tab walked straight back in.
    // /auth/logout is identity-generic (sessions.ts): it revokes the row and
    // clears the cookie server-side. Navigate either way — a failed call must
    // not strand him on a shell he asked to leave.
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
    } catch {
      /* offline or refused: the navigation below still gets him out */
    }
    navigate("/platform/staff/login");
  }

  let content: React.ReactNode;
  if (orderMode && can("orders.oversee")) {
    // ق-171: `dashboardBase` keeps a row click inside THIS shell. Without it the
    // workspace built owner-shell links, so one click moved a staff member from
    // his own shell into the owner shell.
    content = (
      <OrderWorkspace
        key={location}
        scope={{ kind: "platform", dashboardBase: base }}
        mode={orderMode}
        navigate={navigate}
      />
    );
  } else if (section === "registrations" && can("registrations.approve")) {
    content = <RegistrationCenter />;
  } else if (section === "merchants" && can("merchants.manage")) {
    content = <MerchantsDirectory navigate={navigate} />;
  } else if (section === "stores" && can("merchants.manage")) {
    content = <PlatformStoresDirectory />;
  } else if (section === "plans" && can("plans.manage")) {
    content = <PlansManager />;
  } else if (section === "subscriptions" && can("plans.manage")) {
    content = <SubscriptionsManager />;
  } else if (section === "upgrade-requests" && can("plans.manage")) {
    content = <UpgradeRequestsPanel />;
  } else if (section === "finance" && can("finance.view")) {
    content = <FinanceCenter />;
  } else if (section === "overview" && can("overview.view")) {
    content = <PlatformPulse />;
  } else if (section === "brand" && can("brand.manage")) {
    content = <PlatformLogoSection />;
  } else if (section === "audit" && can("audit.view")) {
    content = <AuditTimeline />;
  } else if (section === "services" && (can("services.manage") || can("availability.manage"))) {
    content = <PlatformServicesPanel />;
  } else if (section === "account/security") {
    content = <AccountSecurityPanel view="password" />;
  } else if (section === "account/sessions-devices") {
    content = <AccountSecurityPanel view="sessions" />;
  } else if (section === "") {
    content = (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <p className="text-lg font-bold text-[var(--codiq-text)]">
          أهلاً {session.staff.displayName}
        </p>
        <p className="mt-2 max-w-md text-sm leading-7 text-[var(--codiq-text-muted)]">
          تعمل هذه الجلسة بدور «{ROLE_LABELS[session.roleCode]}» على منصة Codiq نفسها. تظهر في
          القائمة الجانبية العناصر المصرح بها لعضويتك، ويتحقق الخادم من كل طلب على حدة.
        </p>
        <div className="mt-5 flex flex-wrap gap-1.5" data-testid="platform-staff-permission-chips">
          {session.permissions.map((permission) => (
            <span
              key={permission}
              className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--codiq-text-secondary)]"
              dir="ltr"
            >
              {permission}
            </span>
          ))}
        </div>
      </div>
    );
  } else {
    content = (
      <div
        className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9"
        data-testid="platform-staff-denied"
      >
        <p className="text-lg font-bold text-[var(--codiq-text)]">
          مساحة {activeEntry?.label ?? section} غير متاحة
        </p>
        <p className="mt-2 max-w-md text-sm leading-7 text-[var(--codiq-text-muted)]">
          هذه الوجهة خارج صلاحيات عضويتك في المرحلة الحالية. الخادم يرفض أي طلب غير مخول بغض النظر
          عن الواجهة.
        </p>
      </div>
    );
  }

  return (
    // P27-7: the demo banner is mounted once in the Router (App.tsx) so it also
    // covers the routes that have no shell; it must not be repeated per shell.
    <div
      className="min-h-screen bg-[var(--codiq-canvas)] text-[var(--codiq-text)] lg:flex"
      dir="rtl"
    >
      <aside className="sticky top-0 z-30 hidden h-screen w-[300px] shrink-0 border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] shadow-[-16px_0_38px_rgba(36,52,82,0.055)] lg:block">
        <PlatformStaffSidebar
          entries={entries}
          location={location}
          navigate={navigate}
          closeMobile={() => undefined}
          session={session}
        />
      </aside>
      {mobileOpen ? (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-[var(--codiq-text)]/20 lg:hidden"
          aria-label="إغلاق القائمة"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 right-0 z-50 w-[300px] border-l border-[var(--codiq-border)] bg-[var(--codiq-surface)] transition-transform duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] lg:hidden ${mobileOpen ? "translate-x-0" : "translate-x-full"}`}
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
        <PlatformStaffSidebar
          entries={entries}
          location={location}
          navigate={navigate}
          closeMobile={() => setMobileOpen(false)}
          session={session}
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
            <div className="flex items-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--codiq-text-secondary)] shadow-sm">
              <BadgeCheck className="h-4 w-4 text-[var(--codiq-accent)]" /> جلسة طاقم مقيدة
              بالصلاحيات
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void logout()}
              className="rounded-xl text-[var(--codiq-text-secondary)]"
              data-testid="platform-staff-logout"
            >
              <LogOut className="ml-1 h-4 w-4" /> خروج
            </Button>
          </div>
        </header>
        <section className="relative mx-5 overflow-hidden rounded-[28px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] px-6 py-6 shadow-[0_12px_36px_rgba(32,52,87,0.055)] sm:mx-8 sm:px-9 sm:py-7 lg:mx-10">
          <div className="relative z-10">
            <p className="text-xs font-bold text-[var(--codiq-accent)]">لوحة طاقم المنصة</p>
            <h1 className="mt-2 text-3xl font-bold text-[var(--codiq-text)]">
              {activeEntry?.label ?? "لوحة طاقم المنصة"}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-7 text-[var(--codiq-text-muted)]">
              صلاحياتك محسوبة على الخادم من الدور والاستثناءات المعتمدة؛ الواجهة تعرض فقط ولا تقرر.
            </p>
          </div>
          <div className="absolute bottom-0 right-0 h-2/3 w-1.5 rounded-tl-full bg-[var(--codiq-accent)]/80" />
        </section>
        <section className="mx-5 py-6 sm:mx-8 lg:mx-10 lg:py-7">{content}</section>
      </main>
    </div>
  );
}
