/**
 * ق-201 — a guest chooses a password and becomes an account, orders included.
 * Shown on the shopper's own order page, where he lands after buying without
 * an account; drawn for nobody else.
 */
import { FormEvent, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { useStorefront } from "@/components/StorefrontProvider";
import { errorMessage, storefrontApi } from "@/lib/storefront-api";

export function GuestPasswordCard() {
  const { slug, customer, setCustomer, setNotice } = useStorefront();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!customer?.isGuest) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await storefrontApi.setPassword(slug, password);
      setCustomer(result.account);
      setPassword("");
      setNotice("تم إنشاء كلمة المرور — صار لديك حساب بكل طلباتك.");
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={(event) => void submit(event)} data-testid="guest-password-card" className="rounded-[24px] border border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] p-5">
      <div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-[var(--codiq-accent)]" /><h2 className="font-black text-[var(--codiq-text)]">احفظ طلباتك بحساب</h2></div>
      <p className="mt-2 text-sm leading-6 text-[var(--codiq-text-secondary)]">اشتريت كضيف. اختر كلمة مرور وسيصير رقم هاتفك{customer.phoneNormalized ? <> <span dir="ltr" className="font-bold">{customer.phoneNormalized}</span></> : null} حسابك — بكل طلباتك، من دون تسجيل جديد.</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="guest-password">كلمة المرور</label>
        <div className="flex-1"><PasswordInput id="guest-password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="كلمة مرور من 8 أحرف على الأقل" className="h-11 w-full rounded-xl bg-[var(--codiq-surface)]" /></div>
        <Button type="submit" disabled={busy || password.length < 8} className="h-11 rounded-xl bg-[var(--codiq-accent)] font-bold hover:bg-[var(--codiq-accent-hover)]">{busy ? "جارٍ الحفظ…" : "إنشاء كلمة مرور"}</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs font-bold text-[var(--codiq-danger)]">{error}</p> : null}
    </form>
  );
}
