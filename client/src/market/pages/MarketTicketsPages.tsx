/**
 * Marketplace M7b — «تذاكر الدعم» for the shopper: his tickets (open / closed,
 * with a summary), opening one from a delivered order, and one ticket's thread.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { CircleAlert, ImagePlus, LifeBuoy, LoaderCircle, Send } from "lucide-react";
import { accountCall, useShopper } from "../market-shopper";
import { useMarketList } from "../use-market-list";
import { MarketEmptyState } from "../MarketEmptyState";
import { MarketSignIn } from "./MarketAccountPages";

type TicketCard = { id: string; number: number; typeLabel: string; subject: string | null; status: string; statusLabel: string; newReplies: boolean; updatedAt: string; order: { id: string; orderNumber: string }; store: { slug: string; name: string } };
type TicketView = {
  ticket: TicketCard & { description: string; comments: { id: string; side: "shopper" | "support"; body: string; createdAt: string }[]; attachments: { id: string; authorKind: string }[] };
  canReply: boolean; replyHint: string | null; askResolved: boolean; canAttach: boolean;
};
type Options = { types: { code: string; label: string }[]; windowHours: number; attachmentsPerSide: number };

const card = "space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm";
const input = "w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)]";
const primary = "flex w-full items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-60";
const secondary = "flex w-full items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-text)]";
const TONE: Record<string, string> = { awaiting_customer: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]", resolved: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]", closed: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]" };

function Failure({ text }: { text: string | null }) {
  return text ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-ticket-error"><CircleAlert className="h-4 w-4 shrink-0" /> {text}</p> : null;
}

/** On a delivered order's page: open a ticket, or go to the one already open. */
export function OrderTicketLink({ orderId }: { orderId: string }) {
  const [state, setState] = useState<{ allowed: boolean; reason: string | null; ticketId: string | null } | null>(null);
  useEffect(() => { void accountCall<{ allowed: boolean; reason: string | null; ticketId: string | null }>(`/api/market/orders/${encodeURIComponent(orderId)}/ticket-eligibility`).then(setState).catch(() => undefined); }, [orderId]);
  if (!state) return null;
  if (state.ticketId) return <Link href={`/tickets/${state.ticketId}`} className={secondary} data-testid="market-order-ticket-open"><LifeBuoy className="h-4 w-4" /> تذكرة الدعم لهذا الطلب</Link>;
  if (state.allowed) return <Link href={`/tickets/new?order=${encodeURIComponent(orderId)}`} className={secondary} data-testid="market-order-ticket-new"><LifeBuoy className="h-4 w-4" /> لديك مشكلة؟ افتح تذكرة دعم</Link>;
  return null;
}

export function MarketTicketsPage() {
  const { status, shopper } = useShopper();
  const tab = new URLSearchParams(useSearch()).get("tab") === "closed" ? "closed" : "open";
  const [, navigate] = useLocation();
  const [summary, setSummary] = useState<{ open: number; awaitingYou: number; closed: number } | null>(null);
  const url = shopper ? `/api/market/tickets?tab=${tab}` : null;
  const list = useMarketList<TicketCard>(url, "tickets");
  useEffect(() => { if (url) void accountCall<{ summary: { open: number; awaitingYou: number; closed: number } }>(`${url}&limit=1`).then((body) => setSummary(body.summary)).catch(() => undefined); }, [url]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  return (
    <div className="space-y-4" data-testid="market-tickets">
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تذاكر الدعم</h1>
      {summary ? <p className="text-xs text-[var(--codiq-text-secondary)]" data-testid="market-tickets-summary">مفتوحة: {summary.open.toLocaleString("ar-IQ")}{summary.awaitingYou ? ` — بانتظار ردّك: ${summary.awaitingYou.toLocaleString("ar-IQ")}` : ""} — مغلقة: {summary.closed.toLocaleString("ar-IQ")}</p> : null}
      <div className="flex gap-2">
        {(["open", "closed"] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => navigate(value === "open" ? "/tickets" : "/tickets?tab=closed")} className={`rounded-full px-3 py-1.5 text-xs font-bold ${tab === value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface)] text-[var(--codiq-text-secondary)]"}`} data-testid={`market-tickets-tab-${value}`}>{value === "open" ? "المفتوحة" : "المغلقة"}</button>)}
      </div>
      {!list.items ? <p className="text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {list.items?.length === 0 ? <MarketEmptyState icon={LifeBuoy} title={tab === "open" ? "لا تذاكر مفتوحة" : "لا تذاكر مغلقة"} body="تُفتح التذكرة من صفحة الطلب بعد استلامه، إن واجهت مشكلة فيه." /> : null}
      <ul className="space-y-3">
        {list.items?.map((ticket) => (
          <li key={ticket.id}>
            <Link href={`/tickets/${ticket.id}`} className="block space-y-1.5 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-ticket-${ticket.id}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-black text-[var(--codiq-text)]">#{ticket.number} — {ticket.typeLabel}</span><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[ticket.status] ?? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`}>{ticket.statusLabel}</span></div>
              <p className="text-xs text-[var(--codiq-text-secondary)]">{ticket.store.name} — طلب {ticket.order.orderNumber}</p>
              {ticket.newReplies ? <p className="text-[11px] font-bold text-[var(--codiq-danger)]" data-testid={`market-ticket-new-${ticket.id}`}>ردود جديدة</p> : null}
            </Link>
          </li>
        ))}
      </ul>
      {list.nextCursor ? <button type="button" onClick={() => void list.loadMore()} className={secondary}>عرض المزيد</button> : null}
    </div>
  );
}

export function MarketNewTicketPage() {
  const { status, shopper } = useShopper();
  const orderId = new URLSearchParams(useSearch()).get("order") ?? "";
  const [, navigate] = useLocation();
  const [options, setOptions] = useState<Options | null>(null);
  const [eligibility, setEligibility] = useState<{ allowed: boolean; reason: string | null; ticketId: string | null; until: string | null } | null>(null);
  const [type, setType] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!shopper) return;
    void accountCall<Options>("/api/market/tickets/options").then(setOptions).catch(() => undefined);
    if (orderId) void accountCall<typeof eligibility>(`/api/market/orders/${encodeURIComponent(orderId)}/ticket-eligibility`).then(setEligibility).catch((error: Error) => setFailure(error.message));
  }, [shopper, orderId]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (!orderId) return <MarketEmptyState icon={LifeBuoy} title="افتح التذكرة من طلبك" body="اختر الطلب من «طلباتي» ثمّ «افتح تذكرة دعم»." action={<Link href="/orders" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">طلباتي</Link>} />;
  if (eligibility && !eligibility.allowed) return <MarketEmptyState icon={LifeBuoy} title="لا يمكن فتح تذكرة" body={eligibility.reason ?? ""} action={eligibility.ticketId ? <Link href={`/tickets/${eligibility.ticketId}`} className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">عرض التذكرة</Link> : <Link href="/help" className="rounded-full bg-[var(--codiq-accent)] px-5 py-2.5 text-sm font-bold text-[var(--codiq-surface)]">المساعدة</Link>} testId="market-ticket-not-allowed" />;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFailure(null);
    try {
      const created = await accountCall<{ ticket: { id: string } }>("/api/market/tickets", { method: "POST", body: JSON.stringify({ orderId, type, subject: subject.trim() || undefined, description: description.trim() }) });
      for (const file of files) {
        const form = new FormData(); form.append("image", file);
        await accountCall(`/api/market/tickets/${created.ticket.id}/attachments`, { method: "POST", body: form });
      }
      navigate(`/tickets/${created.ticket.id}`);
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  const max = options?.attachmentsPerSide ?? 3;
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="market-ticket-new">
      <Link href={`/orders/${orderId}`} className="text-xs font-bold text-[var(--codiq-accent)]">← الطلب</Link>
      <h1 className="text-xl font-black text-[var(--codiq-text)]">تذكرة دعم جديدة</h1>
      {eligibility?.until ? <p className="text-xs text-[var(--codiq-text-muted)]">يمكنك فتح التذكرة حتّى {new Date(eligibility.until).toLocaleString("ar-IQ")}.</p> : null}
      <section className={card}>
        <p className="text-sm font-black text-[var(--codiq-text)]">ما نوع المشكلة؟</p>
        <div className="flex flex-wrap gap-1.5">{options?.types.map((entry) => <button key={entry.code} type="button" aria-pressed={type === entry.code} onClick={() => setType(entry.code)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${type === entry.code ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"}`} data-testid={`market-ticket-type-${entry.code}`}>{entry.label}</button>)}</div>
        <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={120} placeholder="عنوان مختصر (اختياريّ)" className={input} data-testid="market-ticket-subject" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={3000} placeholder="اشرح المشكلة بالتفصيل" className={input} data-testid="market-ticket-description" />
        <p className="text-[11px] text-[var(--codiq-text-muted)]">{description.trim().length < 10 ? "١٠ أحرف على الأقلّ." : `${description.trim().length.toLocaleString("ar-IQ")} / ٣٠٠٠`}</p>
        <label className={`${secondary} cursor-pointer`}><ImagePlus className="h-4 w-4" /> أرفق صوراً ({files.length.toLocaleString("ar-IQ")} / {max.toLocaleString("ar-IQ")})<input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { setFiles([...files, ...Array.from(event.target.files ?? [])].slice(0, max)); event.target.value = ""; }} data-testid="market-ticket-files" /></label>
        <Failure text={failure} />
        <button type="submit" disabled={busy || !type || description.trim().length < 10} className={primary} data-testid="market-ticket-submit">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} إرسال التذكرة</button>
      </section>
    </form>
  );
}

export function MarketTicketPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { status, shopper } = useShopper();
  const [view, setView] = useState<TicketView | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const url = `/api/market/tickets/${encodeURIComponent(id)}`;
  const load = useCallback(() => accountCall<TicketView>(url).then(setView).catch((error: Error) => setFailure(error.message)), [url]);
  useEffect(() => { if (shopper) void load(); }, [shopper, load]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  if (!view) return failure ? <MarketEmptyState icon={LifeBuoy} title="التذكرة غير موجودة" body={failure} /> : <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  async function act(target: string, body: unknown) {
    setBusy(true); setFailure(null);
    try { setView(await accountCall<TicketView>(target, { method: "POST", body: JSON.stringify(body) })); setReply(""); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  async function attach(file: File) {
    setBusy(true); setFailure(null);
    const form = new FormData(); form.append("image", file);
    try { await accountCall(`${url}/attachments`, { method: "POST", body: form }); await load(); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  const { ticket } = view;
  return (
    <div className="space-y-4" data-testid="market-ticket-page">
      <Link href="/tickets" className="text-xs font-bold text-[var(--codiq-accent)]">← تذاكر الدعم</Link>
      <section className={card}>
        <div className="flex items-center justify-between gap-2"><p className="text-sm font-black text-[var(--codiq-text)]">#{ticket.number} — {ticket.typeLabel}</p><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[ticket.status] ?? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"}`} data-testid="market-ticket-status">{ticket.statusLabel}</span></div>
        <Link href={`/orders/${ticket.order.id}`} className="text-xs font-bold text-[var(--codiq-accent)]">{ticket.store.name} — طلب {ticket.order.orderNumber}</Link>
        {ticket.subject ? <p className="text-sm font-semibold text-[var(--codiq-text)]">{ticket.subject}</p> : null}
        <p className="whitespace-pre-line text-xs leading-6 text-[var(--codiq-text-secondary)]">{ticket.description}</p>
        {ticket.attachments.length ? <div className="flex flex-wrap gap-2">{ticket.attachments.map((attachment) => <a key={attachment.id} href={`${url}/attachments/${attachment.id}`} target="_blank" rel="noopener noreferrer"><img src={`${url}/attachments/${attachment.id}`} alt="مرفق" className="h-16 w-16 rounded-xl object-cover" /></a>)}</div> : null}
      </section>
      <section className="space-y-2" data-testid="market-ticket-thread">
        {ticket.comments.map((comment) => (
          <div key={comment.id} className={`max-w-[85%] rounded-[20px] p-3 text-xs leading-6 ${comment.side === "shopper" ? "mr-auto bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "ml-auto bg-[var(--codiq-surface)] text-[var(--codiq-text)] shadow-sm"}`}>
            <p className="text-[10px] font-bold opacity-80">{comment.side === "shopper" ? "أنت" : "فريق الدعم"} — {new Date(comment.createdAt).toLocaleString("ar-IQ")}</p>
            <p className="whitespace-pre-line">{comment.body}</p>
          </div>
        ))}
      </section>
      {view.askResolved ? (
        <section className={card} data-testid="market-ticket-confirm">
          <p className="text-sm font-black text-[var(--codiq-text)]">هل حُلّت مشكلتك؟</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={() => void act(`/api/market/tickets/${encodeURIComponent(id)}/confirm`, { resolved: true })} className={primary} data-testid="market-ticket-confirm-yes">نعم</button>
            <button type="button" disabled={busy} onClick={() => void act(`/api/market/tickets/${encodeURIComponent(id)}/confirm`, { resolved: false })} className={secondary} data-testid="market-ticket-confirm-no">ليس بعد</button>
          </div>
        </section>
      ) : null}
      {view.canReply ? (
        <section className={card}>
          <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} maxLength={3000} placeholder="اكتب ردّك" className={input} data-testid="market-ticket-reply" />
          <button type="button" disabled={busy || !reply.trim()} onClick={() => void act(`/api/market/tickets/${encodeURIComponent(id)}/replies`, { body: reply })} className={primary} data-testid="market-ticket-send"><Send className="h-4 w-4" /> إرسال</button>
        </section>
      ) : view.replyHint ? <p className="rounded-2xl bg-[var(--codiq-surface)] p-3 text-center text-xs text-[var(--codiq-text-muted)]" data-testid="market-ticket-hint">{view.replyHint}</p> : null}
      {view.canAttach ? <label className={`${secondary} cursor-pointer`}><ImagePlus className="h-4 w-4" /> إرفاق صورة<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ""; }} data-testid="market-ticket-attach" /></label> : null}
      <Failure text={failure} />
    </div>
  );
}
