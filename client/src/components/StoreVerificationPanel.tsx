/**
 * MD-6 — the owner's verification screen for one store.
 *
 * The evidence is shown first and the button second, on purpose. The criteria
 * are computed live from the store's real figures so the owner grants a badge on
 * facts, and can tell a merchant exactly which figure is short. Nothing here
 * auto-grants: meeting every criterion enables an argument, not an action.
 */
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Evidence = { code: string; label: string; value: number | null; threshold: number; met: boolean };
type Verification = {
  storeSlug: string;
  storeName: string;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: { id: string; displayName: string } | null;
  note: string | null;
  evidence: Evidence[];
  meetsAll: boolean;
};

const number = new Intl.NumberFormat("ar-IQ");
const day = (value: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
/**
 * `completion_rate` is the only criterion measured in percent, and the only one
 * that can be null — a store with no orders has no rate. It shows as «—», not as
 * a zero it never scored.
 */
const shown = (item: Evidence) => {
  if (item.value === null) return "—";
  return item.code === "completion_rate" ? `${number.format(item.value)}٪` : number.format(item.value);
};

export function StoreVerificationPanel({ storeSlug }: { storeSlug: string }) {
  const [state, setState] = useState<Verification | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/platform/stores/${encodeURIComponent(storeSlug)}/verification`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تحميل حالة التوثيق.");
      setState(body.verification);
      setNote(body.verification.note ?? "");
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [storeSlug]);
  useEffect(() => { void load(); }, [load]);

  async function decide(verified: boolean) {
    setBusy(true);
    try {
      const response = await fetch(`/api/platform/stores/${encodeURIComponent(storeSlug)}/verification`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verified, ...(verified && note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر حفظ القرار.");
      setState(body.verification);
      setNote(body.verification.note ?? "");
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  if (failure && !state) return <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p>;
  if (!state) return <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;

  return (
    <section className="space-y-4 rounded-3xl bg-[var(--codiq-surface)] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-black text-[var(--codiq-accent-strong)]"><BadgeCheck className="h-4 w-4" /> توثيق المتجر</p>
          <p className="mt-0.5 text-xs text-[var(--codiq-text-secondary)]">شارة تمنحها المنصة وتظهر للزبائن في واجهة المتجر.</p>
        </div>
        {state.verified ? (
          <span className="rounded-full bg-[var(--codiq-success-soft)] px-3 py-1 text-[11px] font-bold text-[var(--codiq-success)]">موثّق منذ {state.verifiedAt ? day(state.verifiedAt) : "—"}</span>
        ) : (
          <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]">غير موثّق</span>
        )}
      </div>

      {state.verified && state.verifiedBy ? <p className="text-xs text-[var(--codiq-text-secondary)]">منحها: <b className="font-bold">{state.verifiedBy.displayName}</b></p> : null}

      <ul className="grid gap-2 sm:grid-cols-2">
        {state.evidence.map((item) => (
          <li key={item.code} className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--codiq-surface-sunken)] px-3.5 py-2.5">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--codiq-text)]">
              {/* The mark is never the only signal: the figure beside it says the same thing in numbers. */}
              {item.met ? <Check className="h-4 w-4 shrink-0 text-[var(--codiq-success)]" aria-hidden="true" /> : <X className="h-4 w-4 shrink-0 text-[var(--codiq-negative-icon)]" aria-hidden="true" />}
              <span className="truncate">{item.label}</span>
            </span>
            <span className={`shrink-0 text-[13px] font-black tabular-nums ${item.met ? "text-[var(--codiq-success)]" : "text-[var(--codiq-text-muted)]"}`}>
              {shown(item)}<span className="sr-only"> {item.met ? "مستوفى" : item.value === null ? "لا توجد بيانات بعد" : "غير مستوفى"}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs font-semibold text-[var(--codiq-text-secondary)]">
        {state.meetsAll
          ? "يستوفي المتجر كل المعايير. القرار يبقى قرارك — الأرقام تدعمه ولا تتخذه."
          : "لا يستوفي المتجر كل المعايير بعد. تستطيع التوثيق رغم ذلك إن كان لديك سبب خارج الأرقام."}
      </p>

      <label className="block space-y-1">
        <span className="text-[11px] font-bold text-[var(--codiq-text-secondary)]">ملاحظة (اختيارية، حتى 500 حرف)</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          rows={2}
          className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
          placeholder="مثال: زيارة ميدانية وتحقق من السجل التجاري"
        />
        {/* Said before he types it, not after: the note travels to the merchant. */}
        <span className="block text-[11px] text-[var(--codiq-text-muted)]">تظهر هذه الملاحظة للتاجر في سجل متجره. لا تضع فيها ما لا تريده أن يقرأه.</span>
      </label>

      {failure ? <p className="flex items-center gap-2 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-[13px] font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}

      <div className="flex flex-wrap gap-2">
        {state.verified ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decide(false)} className="rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]">
            {busy ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : null}سحب التوثيق
          </Button>
        ) : (
          <Button type="button" disabled={busy} onClick={() => void decide(true)} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">
            {busy ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : <BadgeCheck className="ml-1 h-4 w-4" />}منح التوثيق
          </Button>
        )}
        {state.verified ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide(true)} className="rounded-xl text-[var(--codiq-text-secondary)]">تحديث الملاحظة</Button>
        ) : null}
      </div>
    </section>
  );
}
