import { useCallback, useEffect, useState } from "react";
import { useParams } from "wouter";
import { BellOff, CheckCircle2, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * PG-3 — the unsubscribe page.
 *
 * No session and no account: the person receiving an unwanted email is exactly
 * the one least likely to have either, and demanding one is how a working
 * unsubscribe link quietly becomes a decorative one.
 *
 * The page states the scope before asking for the press. The fear that stops
 * people using this button is losing their order updates, so the answer to that
 * fear is the largest thing on the screen.
 */
type Describe = {
  storeName: string | null;
  email: string;
  alreadyUnsubscribed: boolean;
  scope: string;
};

export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<Describe | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/unsubscribe/${encodeURIComponent(token)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "رابط إلغاء الاشتراك غير صالح.");
      setState(payload as Describe);
      setDone(Boolean((payload as Describe).alreadyUnsubscribed));
    } catch (caught) {
      // A network failure and a rejected token are different problems and the
      // reader can act on only one of them, so they read differently.
      setError(
        caught instanceof TypeError
          ? "تعذّر الاتصال بالخادم. تحقّق من الشبكة ثم أعد المحاولة."
          : caught instanceof Error
            ? caught.message
            : "رابط إلغاء الاشتراك غير صالح."
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "تعذّر إلغاء الاشتراك.");
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? "تعذّر الاتصال بالخادم. تحقّق من الشبكة ثم أعد المحاولة."
          : caught instanceof Error
            ? caught.message
            : "تعذّر إلغاء الاشتراك."
      );
    } finally {
      setBusy(false);
    }
  }

  const storeName = state?.storeName ?? "المتجر";

  return (
    <main dir="rtl" className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
      <section className="w-full rounded-[28px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-7 shadow-sm sm:p-9">
        {loading ? (
          <p className="flex items-center gap-3 text-sm text-[var(--codiq-text-secondary)]">
            <LoaderCircle className="h-5 w-5 animate-spin text-[#1769CF]" />
            جارٍ فتح الرابط…
          </p>
        ) : error && !state ? (
          <>
            <h1 className="text-xl font-black text-[#15233E]">تعذّر فتح الرابط</h1>
            <p role="alert" className="mt-3 text-sm leading-6 text-[var(--codiq-text-secondary)]">
              {error}
            </p>
            <Button type="button" onClick={() => void load()} className="mt-6 rounded-xl">
              أعد المحاولة
            </Button>
          </>
        ) : done ? (
          <>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-7 w-7 text-emerald-600" />
              <h1 className="text-xl font-black text-[#15233E]">تم إلغاء الاشتراك</h1>
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--codiq-text-secondary)]">
              لن تصلك رسائل تسويقية من <strong className="text-[#15233E]">{storeName}</strong> بعد
              الآن على{" "}
              <span dir="ltr" className="font-mono text-xs">
                {state?.email}
              </span>
              .
            </p>
            <p className="mt-4 flex items-start gap-2 rounded-2xl bg-[#F1F7FF] p-4 text-sm leading-6 text-[#2C4364]">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#1769CF]" />
              <span>
                إشعارات طلباتك تبقى تصلك كالمعتاد — تأكيد الطلب، وتغيّر حالته، وخروج المندوب. هذا
                الإلغاء يخصّ الرسائل التسويقية من هذا المتجر وحده.
              </span>
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <BellOff className="h-7 w-7 text-[#1769CF]" />
              <h1 className="text-xl font-black text-[#15233E]">إلغاء الرسائل التسويقية</h1>
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--codiq-text-secondary)]">
              سيتوقف إرسال الرسائل التسويقية من{" "}
              <strong className="text-[#15233E]">{storeName}</strong> إلى{" "}
              <span dir="ltr" className="font-mono text-xs">
                {state?.email}
              </span>
              .
            </p>
            <p className="mt-4 flex items-start gap-2 rounded-2xl bg-[#F1F7FF] p-4 text-sm leading-6 text-[#2C4364]">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#1769CF]" />
              <span>
                <strong>إشعارات طلباتك لن تتأثر.</strong> تأكيد الطلب وتغيّر حالته وخروج المندوب
                تبقى تصلك — وهذا الإلغاء يخصّ هذا المتجر وحده، لا بقية المتاجر.
              </span>
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="unsubscribe-confirm"
              className="mt-6 rounded-xl bg-[#1769CF] font-black hover:bg-[#125CB8]"
            >
              {busy ? "جارٍ الإلغاء…" : "تأكيد إلغاء الاشتراك"}
            </Button>
            {error ? (
              <p role="alert" className="mt-3 text-xs font-bold text-[#A33A3A]">
                {error}
              </p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
