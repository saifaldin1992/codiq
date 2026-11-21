import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { PasswordInputWithMeter } from "@/components/ui/password-input-with-meter";

/**
 * PR-1 — «اختر كلمة سر جديدة»: the page a reset link opens.
 *
 * Reached from an email with NO session, so it is mounted outside every shell —
 * the same shape as `/unsubscribe/:token`, and for the same reason: a person who
 * cannot sign in must not meet a screen that assumes he did.
 *
 * IT DOES NOT SIGN HIM IN, and that is the security decision of the whole
 * feature rather than a missing convenience. If a successful reset issued a
 * session, an attacker who reads the mailbox of an owner enrolled in TOTP would
 * get exactly what the second factor exists to withhold. Instead he is sent to
 * the ordinary sign-in door, where the code is demanded as always. The server
 * answers with `redirectTo` — the right door for whichever identity the token
 * belonged to — so this page never has to guess.
 *
 * THE LINK IS CHECKED BEFORE THE FORM IS OFFERED. A dead link discovered only
 * after choosing a password, typing it and pressing the button is a person who
 * has to do all of it again; the inspect call spends nothing and costs one
 * round trip.
 *
 * The token is read from the query string and kept in state — never put into a
 * link, a redirect or a message on this page.
 */
export default function PasswordResetConsume() {
  const [, navigate] = useLocation();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "dead" | "done">("checking");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [redirectTo, setRedirectTo] = useState<string>("/");
  const [sessionsEnded, setSessionsEnded] = useState(0);

  useEffect(() => {
    const fromQuery =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("token");
    if (!fromQuery) {
      setState("dead");
      return;
    }
    setToken(fromQuery);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/password/reset/inspect", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: fromQuery }),
        });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        setState(response.ok && payload?.valid === true ? "ready" : "dead");
      } catch {
        // A network failure is NOT a dead link. Saying «الرابط منتهٍ» here would
        // send a person to ask for a second live takeover primitive when the
        // one in his hand is fine; the form is offered and the submit decides.
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");
    setError(null);
    if (newPassword !== confirm) {
      setError("تأكيد كلمة السر لا يطابق كلمة السر الجديدة.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/auth/password/reset/consume", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "تعذّر تعيين كلمة السر. اطلب رابطاً جديداً.");
      }
      setRedirectTo(typeof payload?.redirectTo === "string" ? payload.redirectTo : "/");
      setSessionsEnded(Number(payload?.sessionsEnded ?? 0));
      setState("done");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "تعذّر تعيين كلمة السر. اطلب رابطاً جديداً."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-[var(--codiq-canvas)] p-5">
      <div className="w-full max-w-md">
        <div className="rounded-[28px] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.08)] sm:p-9">
          <h1 className="text-2xl font-bold text-[var(--codiq-text)]">اختر كلمة سر جديدة</h1>

          {state === "checking" ? (
            <p className="mt-3 text-sm leading-6 text-[var(--codiq-text-muted)]">
              جارٍ التحقق من الرابط…
            </p>
          ) : null}

          {state === "dead" ? (
            <div data-testid="reset-consume-dead" role="alert" className="mt-4 space-y-3">
              <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-danger)]">
                هذا الرابط لم يعد صالحاً — فقد يكون استُعمل من قبل، أو انتهت مدته، أو طلبت رابطاً
                أحدث منه.
              </p>
              <p className="text-sm leading-6 text-[var(--codiq-text-muted)]">
                اطلب رابطاً جديداً من صفحة الاستعادة، وسيصلك خلال دقائق.
              </p>
              <Button
                type="button"
                data-testid="reset-consume-restart"
                onClick={() => navigate("/forgot-password")}
                className="h-11 w-full rounded-xl bg-[var(--codiq-accent)] text-base text-[var(--codiq-surface)] hover:bg-[var(--codiq-accent-hover)]"
              >
                اطلب رابطاً جديداً
              </Button>
            </div>
          ) : null}

          {state === "ready" ? (
            <form onSubmit={submit}>
              <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-muted)]">
                اختر كلمة سر جديدة لحسابك. سيُستعمل هذا الرابط مرة واحدة، وستُنهى كل الجلسات
                المفتوحة على حسابك.
              </p>
              <div className="mt-6 space-y-4">
                {/* Deliberately NOT a wrapping <label>: the reveal toggle would be
                    a descendant, and a descendant aria-label folds into the label
                    text alternative. htmlFor keeps the binding and the name clean. */}
                <div className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
                  <label htmlFor="reset-new-password">كلمة السر الجديدة</label>
                  <PasswordInputWithMeter
                    data-testid="reset-consume-password"
                    id="reset-new-password"
                    name="newPassword"
                    required
                    autoComplete="new-password"
                    autoFocus
                  />
                </div>
                <div className="block space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
                  <label htmlFor="reset-confirm-password">تأكيد كلمة السر</label>
                  <PasswordInputWithMeter
                    data-testid="reset-consume-confirm"
                    id="reset-confirm-password"
                    name="confirmPassword"
                    required
                    autoComplete="new-password"
                  />
                </div>
              </div>
              {error ? (
                <p
                  role="alert"
                  data-testid="reset-consume-error"
                  className="mt-4 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-danger)]"
                >
                  {error}
                </p>
              ) : null}
              <Button
                disabled={pending}
                data-testid="reset-consume-submit"
                className="mt-6 h-11 w-full rounded-xl bg-[var(--codiq-accent)] text-base text-[var(--codiq-surface)] hover:bg-[var(--codiq-accent-hover)]"
              >
                {pending ? "جارٍ الحفظ…" : "احفظ كلمة السر الجديدة"}
              </Button>
            </form>
          ) : null}

          {state === "done" ? (
            <div data-testid="reset-consume-done" role="status" className="mt-4 space-y-3">
              <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold leading-6 text-[var(--codiq-success)]">
                تم تعيين كلمة السر الجديدة.
              </p>
              {/* The count is EVIDENCE, said only when there is something to say.
                  A line reading «أُنهيت 0 جلسات» every time is how a person learns
                  to skim past the time it says 3. */}
              {sessionsEnded > 0 ? (
                <p
                  data-testid="reset-consume-sessions"
                  className="text-sm leading-6 text-[var(--codiq-text-muted)]"
                >
                  أُنهيت {sessionsEnded} من الجلسات المفتوحة على حسابك.
                </p>
              ) : null}
              <p className="text-sm leading-6 text-[var(--codiq-text-muted)]">
                سجّل الدخول بكلمة السر الجديدة. إن كان على حسابك تطبيق مصادقة، فسيُطلب رمزه
                كالمعتاد.
              </p>
              <Button
                type="button"
                data-testid="reset-consume-login"
                onClick={() => navigate(redirectTo)}
                className="h-11 w-full rounded-xl bg-[var(--codiq-accent)] text-base text-[var(--codiq-surface)] hover:bg-[var(--codiq-accent-hover)]"
              >
                إلى تسجيل الدخول
              </Button>
            </div>
          ) : null}

          <p className="mt-7 text-center text-sm text-[var(--codiq-text-muted)]">
            <Link href="/" className="font-bold text-[var(--codiq-accent)] hover:underline">
              العودة إلى الصفحة الرئيسية
            </Link>
          </p>
        </div>
        {/* ق-138 lockup rules: mark before word (dir=ltr), wordmark «Codiq». */}
        <div
          dir="ltr"
          className="mt-6 flex items-center justify-center gap-2 text-[var(--codiq-text-muted)]"
        >
          <BrandMark className="h-5 w-5" />
          <span className="text-[13px] font-semibold">Codiq</span>
        </div>
      </div>
    </main>
  );
}
