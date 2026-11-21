/**
 * «الحملات» — the owner's campaigns: their page and dates, the day schedule,
 * the hours of «عرض الساعة», and the stores' deals to approve or reject.
 * An hour that has started is fixed: its deals cannot be re-decided.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type CampaignRow = { id: string; slug: string; title: string; subtitle: string | null; startsAt: string; endsAt: string; isPublished: boolean; minPercent: number; slots: number; days: number; pendingDeals: number };
type Detail = {
  campaign: Omit<CampaignRow, "slots" | "days" | "pendingDeals">;
  days: { day: string; title: string; note: string | null }[];
  slots: { id: string; title: string | null; startsAt: string; endsAt: string; approved: number; pending: number }[];
};
type Deal = { id: string; percentOff: number; status: string; decisionNote: string | null; slot: { title: string | null; startsAt: string }; product: { name: string; priceIqd: number; store: { name: string } } };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}
const input = "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card = "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";
const toLocal = (iso: string) => new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocal = (value: string) => new Date(value).toISOString();
const when = (iso: string) => new Date(iso).toLocaleString("ar-IQ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function PlatformMarketCampaignsPanel() {
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ slug: "", title: "", subtitle: "", startsAt: "", endsAt: "", minPercent: 10 });
  const load = useCallback(async () => { try { setRows((await call<{ campaigns: CampaignRow[] }>("/api/platform/market/campaigns")).campaigns); } catch (error) { setFailure((error as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const report = { ok: (text: string) => { setNotice(text); setFailure(null); }, fail: (text: string) => { setFailure(text); setNotice(null); } };
  async function create() {
    try {
      const made = await call<{ campaign: { id: string } }>("/api/platform/market/campaigns", { method: "POST", body: JSON.stringify({ ...draft, subtitle: draft.subtitle || null, startsAt: fromLocal(draft.startsAt), endsAt: fromLocal(draft.endsAt), isPublished: false }) });
      report.ok("أُنشئت الحملة (غير منشورة بعد)."); setOpenId(made.campaign.id); await load();
    } catch (error) { report.fail((error as Error).message); }
  }
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-campaigns">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-campaigns-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="market-campaigns-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}
      {openId ? <CampaignEditor id={openId} report={report} onBack={() => { setOpenId(null); void load(); }} /> : (
        <>
          <section className={card}>
            <h3 className="font-bold text-[var(--codiq-text)]">حملة جديدة</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="العنوان" className={input} data-testid="campaign-new-title" />
              <input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="المعرّف (winter-sale)" dir="ltr" className={input} data-testid="campaign-new-slug" />
              <input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} placeholder="سطر تعريفيّ" className={input} />
              <label className="flex items-center gap-2 text-sm">أقلّ خصم <input type="number" min={1} max={90} value={draft.minPercent} onChange={(event) => setDraft({ ...draft, minPercent: Number(event.target.value) })} className="w-20 rounded-lg border border-[var(--codiq-border)] px-2 py-1" />%</label>
              <label className="space-y-1 text-xs text-[var(--codiq-text-secondary)]">تبدأ<input type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} className={input} data-testid="campaign-new-starts" /></label>
              <label className="space-y-1 text-xs text-[var(--codiq-text-secondary)]">تنتهي<input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} className={input} data-testid="campaign-new-ends" /></label>
            </div>
            <Button disabled={!draft.title || !draft.slug || !draft.startsAt || !draft.endsAt} onClick={() => void create()} data-testid="campaign-new-create"><Plus className="h-4 w-4" /> إنشاء</Button>
          </section>
          <section className={card}>
            {!rows ? <LoaderCircle className="h-5 w-5 animate-spin" /> : rows.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا حملات بعد.</p> : (
              <ul className="divide-y divide-[var(--codiq-border)]">
                {rows.map((row) => (
                  <li key={row.id}><button type="button" onClick={() => setOpenId(row.id)} className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-right" data-testid={`campaign-row-${row.slug}`}>
                    <span><span className="block font-bold text-[var(--codiq-text)]">{row.title}</span><span className="text-xs text-[var(--codiq-text-muted)]">{when(row.startsAt)} — {when(row.endsAt)} · {row.slots} ساعة · {row.days} يوم</span></span>
                    <span className="flex gap-2 text-xs font-bold">{row.pendingDeals ? <span className="rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[var(--codiq-warning)]">{row.pendingDeals} عرض بانتظارك</span> : null}<span className={`rounded-full px-2 py-0.5 ${row.isPublished ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"}`}>{row.isPublished ? "منشورة" : "مسودّة"}</span></span>
                  </button></li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function CampaignEditor({ id, report, onBack }: { id: string; report: { ok: (text: string) => void; fail: (text: string) => void }; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [slot, setSlot] = useState({ title: "", startsAt: "", endsAt: "" });
  const [days, setDays] = useState<{ day: string; title: string; note: string }[]>([]);
  const load = useCallback(async () => {
    try {
      const body = await call<Detail>(`/api/platform/market/campaigns/${id}`);
      setDetail(body); setDays(body.days.map((day) => ({ day: day.day, title: day.title, note: day.note ?? "" })));
      setDeals((await call<{ deals: Deal[] }>(`/api/platform/market/campaigns/${id}/deals?status=pending`)).deals);
    } catch (error) { report.fail((error as Error).message); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  async function run(action: () => Promise<unknown>, text: string) { try { await action(); report.ok(text); await load(); } catch (error) { report.fail((error as Error).message); } }
  if (!detail) return <LoaderCircle className="h-5 w-5 animate-spin" />;
  const c = detail.campaign;
  const body = (patch: Partial<typeof c>) => JSON.stringify({ slug: c.slug, title: c.title, subtitle: c.subtitle, startsAt: c.startsAt, endsAt: c.endsAt, minPercent: c.minPercent, isPublished: c.isPublished, ...patch });
  return (
    <div className="space-y-4" data-testid="campaign-editor">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--codiq-accent)]"><ArrowRight className="h-4 w-4" /> كلّ الحملات</button>
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h3 className="text-lg font-bold text-[var(--codiq-text)]">{c.title}</h3><p className="text-xs text-[var(--codiq-text-muted)]">{when(c.startsAt)} — {when(c.endsAt)} · أقلّ خصم {c.minPercent}% · <a href={`/market/campaign/${c.slug}`} target="_blank" rel="noopener noreferrer" className="font-bold text-[var(--codiq-accent)]">صفحة الحملة</a></p></div>
          <Button variant={c.isPublished ? "outline" : "default"} onClick={() => void run(() => call(`/api/platform/market/campaigns/${id}`, { method: "PUT", body: body({ isPublished: !c.isPublished }) }), c.isPublished ? "أُوقف نشر الحملة." : "نُشرت الحملة.")} data-testid="campaign-publish">{c.isPublished ? "إيقاف النشر" : "نشر"}</Button>
        </div>
      </section>
      <section className={card} data-testid="campaign-deals">
        <h3 className="font-bold text-[var(--codiq-text)]">عروض بانتظار الموافقة</h3>
        {deals.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا عروض بانتظارك.</p> : (
          <ul className="divide-y divide-[var(--codiq-border)]">
            {deals.map((deal) => (
              <li key={deal.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>{deal.product.store.name}: {deal.product.name} — خصم {deal.percentOff}% · {deal.slot.title ?? "ساعة"} {when(deal.slot.startsAt)}</span>
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => void run(() => call(`/api/platform/market/deals/${deal.id}/decision`, { method: "POST", body: JSON.stringify({ approve: true }) }), "اعتُمد العرض.")} data-testid={`deal-approve-${deal.id}`}>اعتماد</Button>
                  <Button size="sm" variant="outline" onClick={() => { const note = window.prompt("سبب الرفض (يراه المتجر)"); if (note) void run(() => call(`/api/platform/market/deals/${deal.id}/decision`, { method: "POST", body: JSON.stringify({ approve: false, note }) }), "رُفض العرض."); }}>رفض</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={card} data-testid="campaign-slots">
        <h3 className="font-bold text-[var(--codiq-text)]">ساعات «عرض الساعة»</h3>
        <ul className="divide-y divide-[var(--codiq-border)]">
          {detail.slots.map((row) => <li key={row.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span>{row.title ?? "عرض"} — {when(row.startsAt)} إلى {when(row.endsAt)} · {row.approved} معتمد · {row.pending} بانتظار</span><button type="button" aria-label="حذف الساعة" onClick={() => void run(() => call(`/api/platform/market/campaigns/${id}/slots/${row.id}`, { method: "DELETE" }), "حُذفت الساعة.")} className="text-[var(--codiq-danger)]"><Trash2 className="h-4 w-4" /></button></li>)}
        </ul>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input value={slot.title} onChange={(event) => setSlot({ ...slot, title: event.target.value })} placeholder="العنوان (اختياريّ)" className={input} />
          <input type="datetime-local" value={slot.startsAt} onChange={(event) => setSlot({ ...slot, startsAt: event.target.value })} className={input} data-testid="slot-starts" />
          <input type="datetime-local" value={slot.endsAt} onChange={(event) => setSlot({ ...slot, endsAt: event.target.value })} className={input} data-testid="slot-ends" />
          <Button disabled={!slot.startsAt || !slot.endsAt} onClick={() => void run(() => call(`/api/platform/market/campaigns/${id}/slots`, { method: "POST", body: JSON.stringify({ title: slot.title || null, startsAt: fromLocal(slot.startsAt), endsAt: fromLocal(slot.endsAt) }) }), "أُضيفت الساعة.").then(() => setSlot({ title: "", startsAt: "", endsAt: "" }))} data-testid="slot-add">إضافة</Button>
        </div>
      </section>
      <section className={card} data-testid="campaign-days">
        <h3 className="font-bold text-[var(--codiq-text)]">جدول الأيام</h3>
        {days.map((day, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[160px_1fr_1fr_auto]">
            <input type="date" value={day.day} onChange={(event) => setDays(days.map((row, at) => (at === index ? { ...row, day: event.target.value } : row)))} className={input} />
            <input value={day.title} onChange={(event) => setDays(days.map((row, at) => (at === index ? { ...row, title: event.target.value } : row)))} placeholder="عنوان اليوم" className={input} />
            <input value={day.note} onChange={(event) => setDays(days.map((row, at) => (at === index ? { ...row, note: event.target.value } : row)))} placeholder="ملاحظة" className={input} />
            <button type="button" aria-label="حذف اليوم" onClick={() => setDays(days.filter((_, at) => at !== index))} className="text-[var(--codiq-danger)]"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setDays([...days, { day: toLocal(c.startsAt).slice(0, 10), title: "", note: "" }])}><Plus className="h-4 w-4" /> يوم</Button>
          <Button disabled={days.some((day) => !day.title.trim())} onClick={() => void run(() => call(`/api/platform/market/campaigns/${id}/days`, { method: "PUT", body: JSON.stringify({ days: days.map((day) => ({ day: day.day, title: day.title, note: day.note || null })) }) }), "حُفظ الجدول.")} data-testid="campaign-days-save">حفظ الجدول</Button>
        </div>
      </section>
    </div>
  );
}
