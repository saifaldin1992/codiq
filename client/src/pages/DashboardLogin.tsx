import { useState } from "react";
import { useLocation } from "wouter";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

/**
 * The one sign-in page all three identities share.
 *
 * P27-21 (ق-108) — the MERCHANT no longer types a store link. He signs in with
 * who he is, and the server resolves his stores afterwards: one store opens its
 * dashboard, several open the dashboard with the phase-13 switcher already open,
 * none answers a sentence he can act on instead of a bare 404. The staff door is
 * untouched: a staff member reaches his store through a link his merchant sent
 * him, so the store IS his context and asking for it costs nothing.
 *
 * P27-19 (ق-106) — the merchant card takes the shape the owner asked for: two
 * fields, one wide primary button, a divider, and a way to create an account.
 */
const KIND_COPY = {
  platform: {
    title: "دخول مالك المنصة",
    endpoint: () => "/api/auth/platform/login",
    needsStore: false,
    identityLabel: "البريد الإلكتروني",
    identityName: "email",
    identityType: "email",
    identityHint: null as string | null,
    signUp: null as { label: string; href: string } | null,
  },
  merchant: {
    title: "دخول التاجر",
    endpoint: () => "/api/auth/merchant/login",
    needsStore: false,
    identityLabel: "البريد الإلكتروني أو رقم الهاتف",
    identityName: "identifier",
    identityType: "text",
    identityHint: "مثال: name@example.com أو 07XXXXXXXXX",
    signUp: { label: "إنشاء حساب جديد", href: "/#signup" },
  },
  staff: {
    title: "دخول موظف المتجر",
    endpoint: (storeSlug: string) => `/api/auth/staff/stores/${encodeURIComponent(storeSlug)}/login`,
    needsStore: true,
    identityLabel: "البريد الإلكتروني",
    identityName: "email",
    identityType: "email",
    identityHint: null as string | null,
    signUp: null as { label: string; href: string } | null,
  },
  platformStaff: {
    title: "دخول طاقم المنصة",
    endpoint: () => "/api/auth/platform/staff/login",
    needsStore: false,
    identityLabel: "البريد الإلكتروني",
    identityName: "email",
    identityType: "email",
    identityHint: null as string | null,
    signUp: null as { label: string; href: string } | null,
  },
} as const;

/**
 * A last resort only. The server sends Arabic for every case it knows, and this
 * page used to THROW THAT AWAY and print `payload.error.code` — so a merchant
 * whose store was deactivated read the literal string
 * «MERCHANT_STORE_CONTEXT_NOT_FOUND» on his screen. The message now wins; this
 * map covers a code arriving with no message at all.
 */
const FALLBACK_MESSAGES: Record<string, string> = {
  INVALID_MERCHANT_CREDENTIALS: "بيانات الدخول غير صحيحة. تحقق من البريد أو رقم الهاتف وكلمة المرور.",
  INVALID_PLATFORM_OWNER_CREDENTIALS: "بيانات الدخول غير صحيحة.",
  INVALID_STAFF_CREDENTIALS: "بيانات الدخول غير صحيحة.",
  INVALID_PLATFORM_STAFF_CREDENTIALS: "بيانات الدخول غير صحيحة.",
  SECOND_FACTOR_REQUIRED: "أدخل رمز تطبيق المصادقة.",
  INVALID_SECOND_FACTOR: "الرمز غير صحيح أو مستعمل مسبقاً.",
  RATE_LIMITED: "محاولات كثيرة خلال وقت قصير — انتظر قليلاً ثم أعد المحاولة.",
};

/**
 * PR-1: this page's own vocabulary for the four doors is not the platform's.
 * The server names identities as they exist in the database
 * (`platform_owner`, `platform_staff`, …), so the mapping is written once here
 * rather than guessed at the link.
 */
const RESET_KIND = {
  platform: "platform_owner",
  merchant: "merchant",
  staff: "staff",
  platformStaff: "platform_staff",
} as const;

export default function DashboardLogin({ kind }: { kind: "platform" | "merchant" | "staff" | "platformStaff" }) {
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // ق-124 (المرحلة 19-ب): the code travels in the SAME request as the password —
  // no half-authenticated challenge token. The field appears only after the
  // server answers SECOND_FACTOR_REQUIRED, so an unenrolled account never sees
  // it and the form resubmits with all three values together. This serves the
  // owner door too: it accepted totpCode since 19-ب's owner TOTP, but the form
  // never offered the field, so an enrolled owner could not sign in.
  const [totpRequired, setTotpRequired] = useState(false);
  const copy = KIND_COPY[kind];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    const storeSlug = String(form.get("storeSlug") ?? "").trim();
    const totpCode = String(form.get("totpCode") ?? "").trim();
    try {
      const body = {
        ...(copy.identityName === "identifier"
          ? { identifier: form.get("identifier"), password: form.get("password") }
          : { email: form.get("email"), password: form.get("password") }),
        ...(totpCode ? { totpCode } : {}),
      };
      const response = await fetch(copy.endpoint(storeSlug), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const code = payload?.error?.code as string | undefined;
        if (code === "SECOND_FACTOR_REQUIRED") setTotpRequired(true);
        throw new Error(payload?.error?.message ?? (code ? FALLBACK_MESSAGES[code] : null) ?? "تعذّر تسجيل الدخول. أعد المحاولة.");
      }
      navigate(payload.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر تسجيل الدخول. أعد المحاولة.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
      <div className="w-full max-w-md">
        <form onSubmit={submit} className="rounded-[28px] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.08)] sm:p-9">
          <h1 className="text-2xl font-bold text-[var(--codiq-text)]">{copy.title}</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">تُنشأ جلسة محمية تلقائياً بعد نجاح التحقق.</p>
          <div className="mt-6 space-y-4">
            {copy.needsStore ? (
              <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
                <span>معرّف المتجر</span>
                <Input name="storeSlug" required placeholder="store-..." />
              </label>
            ) : null}
            <label className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
              <span>{copy.identityLabel}</span>
              <Input name={copy.identityName} type={copy.identityType} required autoComplete="username" />
              {copy.identityHint ? <span className="block text-[11px] font-normal text-[#8A97AC]">{copy.identityHint}</span> : null}
            </label>
            {/* Deliberately NOT a wrapping <label>: the reveal toggle would be a
                descendant, and a descendant aria-label folds into the label text
                alternative — the field would announce itself as «كلمة المرور إظهار
                كلمة المرور». htmlFor keeps the binding and the name clean. */}
            <div className="block space-y-1.5 text-sm font-semibold text-[#44526A]">
              <label htmlFor="dashboard-login-password">كلمة المرور</label>
              <PasswordInput id="dashboard-login-password" name="password" required autoComplete="current-password" />
            </div>
            {totpRequired ? (
              <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
                <span>رمز تطبيق المصادقة</span>
                <Input data-testid="login-totp" name="totpCode" dir="ltr" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
                <span className="block text-[11px] font-normal text-[var(--codiq-text-muted)]">افتح تطبيق المصادقة على هاتفك وأدخل الرمز الظاهر الآن.</span>
              </label>
            ) : null}
          </div>
          {error ? (
            <p role="alert" data-testid="login-error" className="mt-4 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-danger)]">{error}</p>
          ) : null}
          <Button disabled={pending} className="mt-6 h-11 w-full rounded-xl bg-[var(--codiq-accent)] text-base text-white hover:bg-[var(--codiq-accent-hover)]">
            {pending ? "جارٍ التحقق…" : "تسجيل الدخول"}
          </Button>
          {/* PR-1: it has arrived. This link was withheld until the feature
              behind it existed — a dead «هل نسيت كلمة السر؟» is exactly the
              invented promise ق-10 forbids — and until today a merchant who
              forgot his password needed a manual edit against the production
              database.

              The kind travels in the query string because all five doors share
              one recovery screen: they differ only in which endpoint they ask,
              and five copies of a screen whose whole job is to say the SAME
              thing to everyone is five places for one of them to start saying
              something different. */}
          <p className="mt-4 text-center text-sm">
            <a href={`/forgot-password?kind=${RESET_KIND[kind]}`} data-testid="login-forgot-password" className="font-semibold text-[var(--codiq-accent)] hover:underline">
              هل نسيت كلمة السر؟
            </a>
          </p>
          {copy.signUp ? (
            <>
              <div className="mt-7 flex items-center gap-3 text-[12px] text-[#9AA6BA]">
                <span className="h-px flex-1 bg-[var(--codiq-border)]" />
                <span>أو</span>
                <span className="h-px flex-1 bg-[var(--codiq-border)]" />
              </div>
              <Button
                type="button"
                variant="outline"
                data-testid="login-signup"
                onClick={() => navigate(copy.signUp!.href)}
                className="mt-4 h-11 w-full rounded-xl border-[#CFDDF0] text-base text-[var(--codiq-accent)] hover:bg-[var(--codiq-neutral-soft)]"
              >
                {copy.signUp.label}
              </Button>
            </>
          ) : null}
        </form>
        {/* ق-138 lockup rules: mark before word (dir=ltr), wordmark «Codiq». */}
        <div dir="ltr" className="mt-6 flex items-center justify-center gap-2 text-[#8A97AC]">
          <BrandMark className="h-5 w-5" />
          <span className="text-[13px] font-semibold">Codiq</span>
        </div>
      </div>
    </main>
  );
}
