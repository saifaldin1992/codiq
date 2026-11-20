import { useState } from "react";
import { Link, useParams } from "wouter";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * PR-1 — «نسيت كلمة السر». One screen for five identities.
 *
 * WHY ONE SCREEN. The five doors differ in exactly one thing: which endpoint
 * they ask. The words, the layout, the promise and — most importantly — the
 * REFUSAL to say whether an address is known are identical, and five copies of
 * a screen whose whole job is to say the same thing to everyone is five places
 * for one of them to start saying something different.
 *
 * WHAT IT MUST NEVER DO. It must not tell the person whether the address exists.
 * The server answers 202 either way, so the only way this screen could leak it
 * is by inventing a distinction the server did not make — «لم نجد هذا البريد» is
 * the sentence that would hand a stranger an account list one address at a time.
 * So there is exactly one success state and it is worded as a CONDITIONAL: «إن
 * كان هذا البريد مسجّلاً…».
 *
 * WHAT IT SAYS WHEN THE PLATFORM CANNOT SEND. `delivery` comes back
 * `"unavailable"` when no mail provider is configured (or no public base URL
 * exists to build a link with). That is a fact about the PLATFORM, identical for
 * every caller, so saying it plainly discloses nothing — and saying «تحقق من
 * بريدك» while the outbox marks the row `no_provider_configured` would be the
 * invented promise ق-10 forbids. The screen tells him the channel is down and
 * where to go instead.
 */
const KIND_COPY = {
  merchant: { title: "استعادة كلمة السر — التاجر", loginPath: "/merchant/login" },
  platform_owner: { title: "استعادة كلمة السر — مالك المنصة", loginPath: "/platform/login" },
  platform_staff: { title: "استعادة كلمة السر — طاقم المنصة", loginPath: "/platform/staff/login" },
  staff: { title: "استعادة كلمة السر — موظف المتجر", loginPath: "/staff/login" },
} as const;

type DashboardKind = keyof typeof KIND_COPY;

function requestedKind(): DashboardKind {
  const raw = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("kind");
  // Defaults to the merchant, and that is a decision rather than an accident:
  // he is the identity this feature was launch-blocking for, and the only one
  // who reaches this page without being handed the link by someone else.
  return raw && raw in KIND_COPY ? (raw as DashboardKind) : "merchant";
}

export default function PasswordResetRequest() {
  // Present only on the storefront mount. Its presence IS the switch between the
  // shared dashboard door and the store-scoped customer one — a customer is
  // keyed per store, so his request cannot be made without knowing which.
  const { storeSlug } = useParams<{ storeSlug?: string }>();
  const kind = requestedKind();
  const copy = storeSlug
    ? { title: "استعادة كلمة السر", loginPath: `/store/${encodeURIComponent(storeSlug)}/account/login` }
    : KIND_COPY[kind];

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"queued" | "unavailable" | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    try {
      const endpoint = storeSlug
        ? `/api/store/${encodeURIComponent(storeSlug)}/account/password/reset/request`
        : "/api/auth/password/reset/request";
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), ...(storeSlug ? {} : { kind }) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "تعذّر إرسال الطلب. أعد المحاولة بعد قليل.");
      }
      setOutcome(payload?.delivery === "unavailable" ? "unavailable" : "queued");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر إرسال الطلب. أعد المحاولة بعد قليل.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
      <div className="w-full max-w-md">
        <div className="rounded-[28px] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.08)] sm:p-9">
          <h1 className="text-2xl font-bold text-[var(--codiq-text)]">{copy.title}</h1>

          {outcome === null ? (
            <form onSubmit={submit}>
              <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
                {storeSlug
                  ? "أدخل البريد الإلكتروني الذي سجّلته في هذا المتجر، ونرسل لك رابطاً لاختيار كلمة سر جديدة."
                  : "أدخل بريدك الإلكتروني، ونرسل لك رابطاً لاختيار كلمة سر جديدة."}
              </p>
              {/* The shopper signs in with a PHONE and his email was optional at
                  registration, so this door can only reach him if he left one.
                  Said here because the RESPONSE cannot say it — it has to read
                  the same for every address. */}
              {storeSlug ? (
                <p className="mt-2 text-[12px] leading-5 text-[var(--codiq-text-muted)]">
                  إن لم تكن قد سجّلت بريداً إلكترونياً في هذا المتجر، تواصل مع المتجر لاستعادة حسابك.
                </p>
              ) : null}
              <div className="mt-6">
                <label className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
                  <span>البريد الإلكتروني</span>
                  <Input data-testid="reset-request-email" name="email" type="email" required autoComplete="email" autoFocus />
                </label>
              </div>
              {error ? (
                <p role="alert" data-testid="reset-request-error" className="mt-4 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-danger)]">{error}</p>
              ) : null}
              <Button disabled={pending} data-testid="reset-request-submit" className="mt-6 h-11 w-full rounded-xl bg-[var(--codiq-accent)] text-base text-[var(--codiq-surface)] hover:bg-[var(--codiq-accent-hover)]">
                {pending ? "جارٍ الإرسال…" : "أرسل رابط الاستعادة"}
              </Button>
            </form>
          ) : outcome === "queued" ? (
            /* CONDITIONAL, always. «إن كان» is the whole non-disclosure promise
               carried in two words: the same sentence is true for an address we
               know and one we have never seen. */
            <div data-testid="reset-request-queued" role="status" className="mt-4 space-y-3">
              <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-success)]">
                إن كان هذا البريد مسجّلاً لدينا، فسيصلك رابط لاختيار كلمة سر جديدة خلال دقائق.
              </p>
              <p className="text-sm leading-6 text-[var(--codiq-text-muted)]">
                الرابط صالح لمدة 45 دقيقة ولمرة واحدة فقط، وعند استخدامه تُنهى كل الجلسات المفتوحة على حسابك.
              </p>
              <p className="text-sm leading-6 text-[var(--codiq-text-muted)]">
                لم تجد الرسالة؟ تحقق من مجلد الرسائل غير المرغوب فيها قبل أن تطلب رابطاً جديداً.
              </p>
            </div>
          ) : (
            /* The honest branch. Never «راجع بريدك» when nothing was sent. */
            <div data-testid="reset-request-unavailable" role="status" className="mt-4 space-y-3">
              <p className="rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-warning)]">
                قناة البريد غير مفعّلة على المنصة حالياً، فلم نرسل أي رسالة ولم يتغيّر شيء في حسابك.
              </p>
              <p className="text-sm leading-6 text-[var(--codiq-text-muted)]">
                {storeSlug
                  ? "تواصل مع المتجر لاستعادة حسابك، أو أعد المحاولة لاحقاً."
                  : "تواصل مع إدارة Codiq لاستعادة حسابك، أو أعد المحاولة لاحقاً."}
              </p>
            </div>
          )}

          <p className="mt-7 text-center text-sm text-[var(--codiq-text-muted)]">
            <Link href={copy.loginPath} data-testid="reset-request-back" className="font-bold text-[var(--codiq-accent)] hover:underline">العودة إلى تسجيل الدخول</Link>
          </p>
        </div>
        {/* ق-138 lockup rules: mark before word (dir=ltr), wordmark «Codiq». */}
        <div dir="ltr" className="mt-6 flex items-center justify-center gap-2 text-[var(--codiq-text-muted)]">
          <BrandMark className="h-5 w-5" />
          <span className="text-[13px] font-semibold">Codiq</span>
        </div>
      </div>
    </main>
  );
}
