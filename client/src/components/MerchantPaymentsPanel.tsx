/**
 * ق-209 — «الدفع»: a switch per payment method, as on the reference dashboard.
 *
 * Cash on delivery is on until switched off. A wallet transfer (زين كاش، آسيا
 * حوالة، FIB) needs the merchant's wallet number before it can be switched on
 * — the shopper sees that number at checkout and transfers before delivery.
 * The card gateways are shown, named, and cannot be switched on before 25أ:
 * a switch that charges nobody would be a lie to the shopper.
 */
import { useCallback, useEffect, useState } from "react";
import { Banknote, CreditCard, LoaderCircle, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

type Method = {
  code: string;
  displayName: string;
  kind: "cod" | "manual_transfer" | "gateway";
  available: boolean;
  unavailableReason?: string;
  hint: string;
  enabled: boolean;
  walletNumber: string | null;
  holderName: string | null;
  instructions: string | null;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function MethodCard({
  method,
  storeSlug,
  onChanged,
}: {
  method: Method;
  storeSlug: string;
  onChanged: (methods: Method[]) => void;
}) {
  const [wallet, setWallet] = useState(method.walletNumber ?? "");
  const [holder, setHolder] = useState(method.holderName ?? "");
  const [instructions, setInstructions] = useState(method.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setWallet(method.walletNumber ?? "");
    setHolder(method.holderName ?? "");
    setInstructions(method.instructions ?? "");
  }, [method.walletNumber, method.holderName, method.instructions]);
  const Icon = method.kind === "cod" ? Banknote : method.kind === "gateway" ? CreditCard : Wallet;
  async function save(patch: {
    isEnabled?: boolean;
    walletNumber?: string;
    holderName?: string;
    instructions?: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ methods: Method[] }>(
        `/api/merchant/stores/${encodeURIComponent(storeSlug)}/payment-methods/${encodeURIComponent(method.code)}`,
        { method: "PUT", body: JSON.stringify(patch) }
      );
      onChanged(result.methods);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر الحفظ.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      data-testid={`payment-method-${method.code}`}
      className={`rounded-[22px] border p-5 ${method.available ? "border-[var(--codiq-border)] bg-[var(--codiq-surface)]" : "border-dashed border-[var(--codiq-border-strong)] bg-[var(--codiq-surface-sunken)]"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${method.enabled ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-muted)]"}`}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-base font-bold text-[var(--codiq-text)]">{method.displayName}</h3>
            <p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">
              {method.available ? method.hint : method.unavailableReason}
            </p>
          </div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]">
          <span>{method.enabled ? "مفعّلة" : "مطفأة"}</span>
          <Switch
            data-testid={`payment-switch-${method.code}`}
            checked={method.enabled}
            disabled={!method.available || busy}
            aria-label={`تشغيل ${method.displayName}`}
            onCheckedChange={(checked) =>
              void save({
                isEnabled: checked,
                ...(method.kind === "manual_transfer" && checked
                  ? {
                      walletNumber: wallet.trim(),
                      holderName: holder.trim(),
                      instructions: instructions.trim(),
                    }
                  : {}),
              })
            }
          />
        </label>
      </div>
      {method.kind === "manual_transfer" && method.available ? (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              walletNumber: wallet.trim(),
              holderName: holder.trim(),
              instructions: instructions.trim(),
            });
          }}
        >
          <label className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
            رقم المحفظة / الحساب
            <input
              data-testid={`wallet-${method.code}`}
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              inputMode="tel"
              dir="ltr"
              placeholder="07XXXXXXXXX"
              className="h-10 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm font-semibold outline-none focus:border-[var(--codiq-accent)]"
            />
          </label>
          <label className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
            اسم صاحب المحفظة
            <input
              value={holder}
              onChange={(event) => setHolder(event.target.value)}
              className="h-10 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm outline-none focus:border-[var(--codiq-accent)]"
            />
          </label>
          <label className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)] sm:col-span-2">
            تعليمات للزبون{" "}
            <span className="font-semibold text-[var(--codiq-text-muted)]">
              (اختياري — مثل: أرسل صورة الإيصال على واتساب)
            </span>
            <input
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={500}
              className="h-10 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm outline-none focus:border-[var(--codiq-accent)]"
            />
          </label>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy}
              className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
            >
              {busy ? "جارٍ الحفظ…" : "حفظ بيانات المحفظة"}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs font-bold text-[var(--codiq-danger)]">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function MerchantPaymentsPanel({ storeSlug }: { storeSlug?: string }) {
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = storeSlug
    ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/payment-methods`
    : null;
  const load = useCallback(async () => {
    if (!base) return;
    try {
      const result = await call<{ methods: Method[] }>(base);
      setMethods(result.methods);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر تحميل وسائل الدفع.");
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!storeSlug || !base)
    return (
      <p className="text-sm text-[var(--codiq-text-muted)]" dir="rtl">
        اختر متجراً لعرض وسائل الدفع.
      </p>
    );
  if (error)
    return (
      <div
        role="alert"
        className="rounded-2xl border border-[var(--codiq-danger-border)] bg-[var(--codiq-danger-soft)] p-4 text-sm text-[var(--codiq-danger)]"
        dir="rtl"
      >
        {error}
      </div>
    );
  if (!methods)
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]" dir="rtl">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        جارٍ تحميل وسائل الدفع…
      </p>
    );
  const enabled = methods.filter((method) => method.enabled).length;
  return (
    <div className="max-w-[820px] space-y-4" dir="rtl" data-testid="payments-panel">
      <p className="text-sm leading-7 text-[var(--codiq-text-muted)]">
        شغّل ما يقبله متجرك فعلاً؛ يراه الزبون عند إتمام الطلب وفي تذييل المتجر.{" "}
        <span className="font-bold text-[var(--codiq-text-secondary)]">{enabled}</span> وسيلة مفعّلة
        الآن — لا يمكن إطفاء آخر وسيلة.
      </p>
      {methods.map((method) => (
        <MethodCard
          key={method.code}
          method={method}
          storeSlug={storeSlug}
          onChanged={setMethods}
        />
      ))}
    </div>
  );
}
