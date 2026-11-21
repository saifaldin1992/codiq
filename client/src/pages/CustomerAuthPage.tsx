import { FormEvent, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ArrowRight, LockKeyhole, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrengthMeter } from "@/components/ui/password-strength-meter";
import { useStorefront } from "@/components/StorefrontProvider";
import { errorMessage, storefrontApi } from "@/lib/storefront-api";

function safeReturnTo(value: string | null, slug: string) {
  const fallback = `/store/${slug}`;
  if (!value || !value.startsWith(`/store/${slug}/`) || value.includes("//")) return fallback;
  return value;
}

export default function CustomerAuthPage() {
  const { storeSlug } = useParams<{ storeSlug: string }>();
  const [location, navigate] = useLocation();
  const { setCart, setCustomer, setNotice, refreshAll } = useStorefront();
  const registerMode = location.includes("/account/register");
  const returnTo = useMemo(
    () =>
      safeReturnTo(
        new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get(
          "returnTo"
        ),
        storeSlug
      ),
    [location, storeSlug]
  );
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const alternateHref = `/store/${storeSlug}/account/${registerMode ? "login" : "register"}?returnTo=${encodeURIComponent(returnTo)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!phone.trim() || !password) {
      setFormError("أدخل رقم الهاتف وكلمة المرور.");
      return;
    }
    if (registerMode && !fullName.trim()) {
      setFormError("أدخل الاسم الكامل.");
      return;
    }
    if (registerMode && password !== confirmPassword) {
      setFormError("تأكيد كلمة المرور لا يطابق كلمة المرور.");
      return;
    }
    setPending(true);
    try {
      if (registerMode) {
        const result = await storefrontApi.register(storeSlug, {
          fullName: fullName.trim(),
          phone: phone.trim(),
          password,
          ...(email.trim() ? { email: email.trim() } : {}),
        });
        setCart(result.cart);
        setCustomer(result.account);
      } else {
        const result = await storefrontApi.login(storeSlug, phone.trim(), password);
        setCart(result.cart);
        setCustomer(result.account ?? result.customer ?? null);
      }
      await refreshAll();
      setNotice(
        registerMode ? "تم إنشاء الحساب ودمج السلة الحالية بأمان." : "تم تسجيل الدخول وحدثت السلة."
      );
      navigate(returnTo);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-xl">
      <Link
        href={`/store/${storeSlug}`}
        className="inline-flex items-center gap-2 text-sm font-bold text-[#4B6F99] hover:text-[#1769CF]"
      >
        <ArrowRight className="h-4 w-4" />
        العودة للكتالوج
      </Link>
      <div className="mt-5 overflow-hidden rounded-[30px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] shadow-[0_18px_48px_rgba(35,63,104,.08)]">
        <div className="bg-[var(--codiq-accent-soft)] px-6 py-7 sm:px-9">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#1769CF] text-white">
            <UserRound className="h-5 w-5" />
          </div>
          <p className="mt-5 text-sm font-bold text-[#1769CF]">حساب العميل</p>
          <h1 className="mt-1 text-3xl font-black text-[#223A5E]">
            {registerMode ? "أنشئ حسابك" : "مرحبًا بعودتك"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#607A9C]">
            {registerMode
              ? "سيساعدك الحساب على إتمام الطلبات ومشاهدة سجلها في هذا المتجر."
              : "سجّل الدخول لإتمام الطلبات ومتابعة الطلبات السابقة."}
          </p>
        </div>
        <form
          className="space-y-5 px-6 py-7 sm:px-9"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          {formError ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-2xl border border-[#F1D0CD] bg-[#FFF8F7] px-4 py-3 text-sm font-bold text-[#A34A44]"
            >
              {formError}
            </div>
          ) : null}
          {registerMode ? (
            <div className="space-y-2">
              <label htmlFor="customer-full-name" className="text-sm font-bold text-[#345273]">
                الاسم الكامل
              </label>
              <Input
                id="customer-full-name"
                autoComplete="name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                className="h-12 rounded-xl"
              />
              {registerMode ? (
                <PasswordStrengthMeter value={password} id="customer-password-strength" />
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <label htmlFor="customer-phone" className="text-sm font-bold text-[#345273]">
              رقم الهاتف
            </label>
            <Input
              id="customer-phone"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              className="h-12 rounded-xl text-right"
              placeholder="07XXXXXXXXX"
            />
          </div>
          {registerMode ? (
            <div className="space-y-2">
              <label htmlFor="customer-email" className="text-sm font-bold text-[#345273]">
                البريد الإلكتروني <span className="font-normal text-[#8496AD]">(اختياري)</span>
              </label>
              <Input
                id="customer-email"
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-12 rounded-xl"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <label htmlFor="customer-password" className="text-sm font-bold text-[#345273]">
              كلمة المرور
            </label>
            <PasswordInput
              id="customer-password"
              autoComplete={registerMode ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="h-12 rounded-xl"
            />
          </div>
          {registerMode ? (
            <div className="space-y-2">
              <label
                htmlFor="customer-confirm-password"
                className="text-sm font-bold text-[#345273]"
              >
                تأكيد كلمة المرور
              </label>
              <PasswordInput
                id="customer-confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                className="h-12 rounded-xl"
              />
            </div>
          ) : null}
          <Button
            type="submit"
            disabled={pending}
            className="h-12 w-full rounded-xl bg-[#1769CF] text-base font-black hover:bg-[#125CB8]"
          >
            <LockKeyhole className="ml-2 h-4 w-4" />
            {pending ? "جارٍ التحقق…" : registerMode ? "إنشاء الحساب" : "تسجيل الدخول"}
          </Button>
          {/* PR-1: offered on the sign-in side only. On the REGISTER side it
              would be an answer to a question nobody asked, next to a form for
              an account that does not exist yet. */}
          {registerMode ? null : (
            <p className="text-center text-sm">
              <Link
                href={`/store/${storeSlug}/account/forgot-password`}
                data-testid="customer-forgot-password"
                className="font-bold text-[var(--codiq-accent)] hover:underline"
              >
                هل نسيت كلمة السر؟
              </Link>
            </p>
          )}
          <p className="text-center text-sm text-[var(--codiq-text-muted)]">
            {registerMode ? "لديك حساب بالفعل؟" : "ليس لديك حساب بعد؟"}{" "}
            <Link href={alternateHref} className="font-black text-[#1769CF] hover:underline">
              {registerMode ? "سجّل الدخول" : "أنشئ حسابًا"}
            </Link>
          </p>
        </form>
      </div>
    </section>
  );
}
