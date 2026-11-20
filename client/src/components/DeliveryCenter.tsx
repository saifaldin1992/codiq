/**
 * ق-246 — «التسليم»: the parcel after the shelf.
 *
 * CODIQ is cash-on-delivery through courier companies. The courier takes the
 * parcel, collects the cash from the shopper, and pays the merchant back later,
 * in a lump, across many orders. This screen is the merchant's side of that
 * envelope: per courier and per window, what went out, what came back
 * delivered, what cash the courier collected, and what the merchant has marked
 * as received — the difference is the number he phones the courier about.
 *
 * The manifest download is the courier's side: one CSV row per parcel handed
 * over in the window, with the cash to collect, in the shape courier systems
 * in Iraq ingest.
 *
 * Manual by design (the precursor of 25أ): the facts are typed by the merchant
 * at the «قيد التوصيل» click and reconciled here by hand. An integration later
 * replaces the source of the numbers, not this screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, FileDown, LoaderCircle, RefreshCw, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";

type CourierRow = { courierName: string; handedOver: number; delivered: number; returned: number; inTransit: number; collectedIqd: number; receivedIqd: number; outstandingIqd: number };
type OutstandingRow = { id: string; orderNumber: string; courierName: string; trackingNumber: string | null; handedOverAt: string; totalIqd: number };
type Report = { window: { from: string; to: string; courier: string | null }; couriers: CourierRow[]; totals: { handedOver: number; delivered: number; collectedIqd: number; receivedIqd: number; outstandingIqd: number }; outstandingTotal: number; outstanding: OutstandingRow[] };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload as { error?: { message?: string } })?.error?.message ?? "تعذر إتمام العملية.");
  return payload as T;
}

const iqd = (value: number) => `${value.toLocaleString("ar-IQ")} د.ع`;
const dayInput = (date: Date) => date.toISOString().slice(0, 10);

export function DeliveryCenter({ storeSlug }: { storeSlug?: string }) {
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/orders` : null;
  const [from, setFrom] = useState(() => dayInput(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(() => dayInput(new Date()));
  const [courier, setCourier] = useState("");
  const [couriers, setCouriers] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The window is whole days in the browser's own zone; the server takes ISO instants.
  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("from", new Date(`${from}T00:00:00`).toISOString());
    params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    if (courier) params.set("courier", courier);
    return params.toString();
  }, [from, to, courier]);

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    try {
      const [names, data] = await Promise.all([
        api<{ couriers: string[] }>(`${base}/couriers`),
        api<Report>(`${base}/cod-reconciliation?${query}`),
      ]);
      setCouriers(names.couriers); setReport(data); setSelected(new Set()); setFailure(null);
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تحميل بيانات التسليم."); }
    finally { setLoading(false); }
  }, [base, query]);
  useEffect(() => { void load(); }, [load]);

  async function markReceived() {
    if (!base || selected.size === 0) return;
    setMarking(true);
    try {
      const result = await api<{ requested: number; marked: number }>(`${base}/cod-collected`, { method: "POST", body: JSON.stringify({ orderIds: Array.from(selected) }) });
      setMessage(`سُجِّل استلام النقد عن ${result.marked} من ${result.requested} طلباً.`);
      await load();
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تسجيل الاستلام."); }
    finally { setMarking(false); }
  }

  const manifestHref = base ? `${base}/manifest.csv?${query}` : "#";
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allOutstanding = report?.outstanding ?? [];

  return <section className="space-y-5" dir="rtl" data-testid="delivery-center">
    <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-[var(--codiq-text)]"><Truck className="h-5 w-5 text-[var(--codiq-accent)]" />التسليم ونقد الاستلام</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--codiq-text-muted)]">لكلّ ناقل: ما خرج، ما وصل، ما حصّله من الزبائن، وما استلمته أنت منه. الفرق هو ما تطالبه به.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={manifestHref} className="inline-flex items-center gap-2 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm font-semibold text-[var(--codiq-text-secondary)] hover:bg-[var(--codiq-surface-sunken)]" data-testid="manifest-download"><FileDown className="h-4 w-4" />بيان الشحنات (CSV)</a>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="rounded-xl"><RefreshCw className={`ml-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />تحديث</Button>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-muted)]">من</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm" /></label>
        <label className="block"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-muted)]">إلى</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm" /></label>
        <label className="block"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-muted)]">الناقل</span><select value={courier} onChange={(event) => setCourier(event.target.value)} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm"><option value="">كلّ الناقلين</option>{couriers.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      {failure ? <p className="mt-4 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
      {message ? <p className="mt-4 rounded-xl bg-[var(--codiq-success-soft)] px-3 py-2 text-sm font-semibold text-[var(--codiq-success)]" data-testid="delivery-notice">{message}</p> : null}
    </div>

    {report ? <>
      <div className="grid gap-3 sm:grid-cols-4">
        {[["طرود خرجت", String(report.totals.handedOver)], ["وصلت", String(report.totals.delivered)], ["حصّله الناقلون", iqd(report.totals.collectedIqd)], ["ما زال عندهم", iqd(report.totals.outstandingIqd)]].map(([label, value]) => (
          <div key={label} className="rounded-[20px] bg-[var(--codiq-surface)] p-4 shadow-sm"><p className="text-xs font-bold text-[var(--codiq-text-muted)]">{label}</p><p className="mt-1 text-lg font-bold text-[var(--codiq-text)]" dir="ltr">{value}</p></div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <h3 className="mb-3 text-base font-bold text-[var(--codiq-text-secondary)]">حسب الناقل</h3>
        {report.couriers.length ? <table className="w-full text-sm" data-testid="courier-table"><thead><tr className="text-right text-xs font-bold text-[var(--codiq-text-muted)]"><th className="py-2">الناقل</th><th>خرج</th><th>وصل</th><th>عاد</th><th>في الطريق</th><th>حصّله</th><th>استلمتُه</th><th>الفرق</th></tr></thead><tbody>
          {report.couriers.map((row) => <tr key={row.courierName} className="border-t border-[var(--codiq-border)]"><td className="py-2 font-semibold text-[var(--codiq-text)]">{row.courierName}</td><td>{row.handedOver}</td><td>{row.delivered}</td><td>{row.returned}</td><td>{row.inTransit}</td><td dir="ltr">{iqd(row.collectedIqd)}</td><td dir="ltr">{iqd(row.receivedIqd)}</td><td dir="ltr" className={row.outstandingIqd > 0 ? "font-bold text-[var(--codiq-danger)]" : ""}>{iqd(row.outstandingIqd)}</td></tr>)}
        </tbody></table> : <p className="text-sm text-[var(--codiq-text-muted)]">لم يُسلَّم طردٌ لناقلٍ في هذه المدّة. يُسجَّل الناقل عند نقل الطلب إلى «قيد التوصيل».</p>}
      </div>

      <div className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-bold text-[var(--codiq-text-secondary)]"><Banknote className="h-4 w-4 text-[var(--codiq-accent)]" />نقدٌ لم تستلمه بعد ({report.outstandingTotal})</h3>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={!allOutstanding.length} onClick={() => setSelected(selected.size === allOutstanding.length ? new Set() : new Set(allOutstanding.map((row) => row.id)))}>{selected.size === allOutstanding.length && allOutstanding.length ? "إلغاء التحديد" : "تحديد الكلّ"}</Button>
            <Button type="button" size="sm" className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" disabled={marking || selected.size === 0} onClick={() => void markReceived()} data-testid="mark-received">{marking ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : null}استلمتُ النقد ({selected.size})</Button>
          </div>
        </div>
        {allOutstanding.length ? <ul className="mt-3 divide-y divide-[var(--codiq-border)]">
          {allOutstanding.map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><label className="flex items-center gap-3"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} className="h-4 w-4" /><span className="font-semibold text-[var(--codiq-text)]">{row.orderNumber}</span><span className="text-[var(--codiq-text-muted)]">{row.courierName}{row.trackingNumber ? ` · ${row.trackingNumber}` : ""}</span></label><span className="text-[var(--codiq-text-muted)]">{new Date(row.handedOverAt).toLocaleDateString("ar-IQ")}</span><span className="font-bold" dir="ltr">{iqd(row.totalIqd)}</span></li>)}
        </ul> : <p className="mt-3 text-sm text-[var(--codiq-text-muted)]">لا نقدَ معلّقاً في هذه المدّة.</p>}
        {report.outstandingTotal > allOutstanding.length ? <p className="mt-2 text-xs text-[var(--codiq-text-muted)]" data-testid="outstanding-truncated">يُعرض أوّل {allOutstanding.length} من {report.outstandingTotal} — علّم ما استلمته ثمّ حدّث لتظهر البقيّة.</p> : null}
      </div>
    </> : loading ? <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p> : null}
  </section>;
}
