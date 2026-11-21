/**
 * Marketplace M7b — the support side of tickets, shared by the store
 * («تذاكر الدعم» under orders) and the platform owner («دعم السوق»). The owner
 * also escalates and closes; the store answers, marks «قيد المعالجة» or «حُلّت».
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleAlert, ImagePlus, LoaderCircle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

type Card = { id: string; number: number; typeLabel: string; subject: string | null; status: string; statusLabel: string; escalated: boolean; createdAt: string; updatedAt: string; order: { id: string; orderNumber: string }; store: { slug: string; name: string } };
type Detail = Card & { description: string; comments: { id: string; authorKind: string; side: string; body: string; createdAt: string }[]; attachments: { id: string; authorKind: string; contentType: string }[] };
type View = { ticket: Detail; order: { orderNumber: string; totalIqd: number; customerName: string; recipientPhone: string | null; status: string; items: { productName: string; quantity: number }[] }; canReply: boolean };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}
const FILTERS = [{ value: "active", label: "تحتاج ردّاً" }, { value: "awaiting_customer", label: "بانتظار الزبون" }, { value: "resolved", label: "حُلّت" }, { value: "closed", label: "مغلقة" }, { value: "", label: "الكلّ" }];
const AUTHOR: Record<string, string> = { shopper: "الزبون", merchant: "المتجر", staff: "موظّف المتجر", platform: "إدارة السوق" };
const card = "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";

export function SupportTicketsWorkspace({ kind, storeSlug }: { kind: "store" | "platform"; storeSlug?: string }) {
  // Literal per side, so each route has a visible caller.
  const listUrl = kind === "store" ? `/api/merchant/stores/${encodeURIComponent(storeSlug ?? "")}/support-tickets` : "/api/platform/market/support-tickets";
  const [filter, setFilter] = useState("active");
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [tickets, setTickets] = useState<Card[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(async (after?: string) => {
    try {
      const search = new URLSearchParams();
      if (filter) search.set("status", filter);
      if (escalatedOnly) search.set("escalated", "1");
      if (after) search.set("cursor", after);
      const body = await call<{ tickets: Card[]; nextCursor: string | null }>(`${listUrl}?${search.toString()}`);
      setTickets((current) => (after ? [...(current ?? []), ...body.tickets] : body.tickets)); setCursor(body.nextCursor); setFailure(null);
    } catch (error) { setFailure((error as Error).message); }
  }, [listUrl, filter, escalatedOnly]);
  useEffect(() => { setTickets(null); void load(); }, [load]);

  if (openId) return <TicketDetail kind={kind} storeSlug={storeSlug ?? ""} ticketId={openId} onBack={() => { setOpenId(null); void load(); }} />;
  return (
    <div className="max-w-[1030px] space-y-4" data-testid={`support-tickets-${kind}`}>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((entry) => <button key={entry.value} type="button" aria-pressed={filter === entry.value} onClick={() => setFilter(entry.value)} className={`rounded-full px-3 py-1.5 text-sm font-bold ${filter === entry.value ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}>{entry.label}</button>)}
        {kind === "platform" ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={escalatedOnly} onChange={(event) => setEscalatedOnly(event.target.checked)} /> المصعَّدة فقط</label> : null}
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      <section className={card}>
        {!tickets ? <LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-text-muted)]" /> : tickets.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا تذاكر هنا.</p> : (
          <ul className="divide-y divide-[var(--codiq-border)]">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <button type="button" onClick={() => setOpenId(ticket.id)} className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-right" data-testid={`support-ticket-row-${ticket.id}`}>
                  <span className="space-y-0.5">
                    <span className="block text-sm font-bold text-[var(--codiq-text)]">#{ticket.number} — {ticket.typeLabel}{ticket.subject ? `: ${ticket.subject}` : ""}</span>
                    <span className="block text-xs text-[var(--codiq-text-muted)]">طلب {ticket.order.orderNumber}{kind === "platform" ? ` — ${ticket.store.name}` : ""} — {new Date(ticket.updatedAt).toLocaleString("ar-IQ")}</span>
                  </span>
                  <span className="flex items-center gap-2">{ticket.escalated ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-warning)]"><ShieldAlert className="h-3 w-3" /> مصعَّدة</span> : null}<span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-accent)]">{ticket.statusLabel}</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor ? <Button variant="outline" onClick={() => void load(cursor)}>المزيد</Button> : null}
      </section>
    </div>
  );
}

/** Every action's URL written out per side, so each route has a visible caller. */
function ticketPaths(kind: "store" | "platform", storeSlug: string, id: string) {
  const slug = encodeURIComponent(storeSlug);
  return kind === "store"
    ? { detail: `/api/merchant/stores/${slug}/support-tickets/${id}`, replies: `/api/merchant/stores/${slug}/support-tickets/${id}/replies`, status: `/api/merchant/stores/${slug}/support-tickets/${id}/status`, attach: `/api/merchant/stores/${slug}/support-tickets/${id}/attachments`, image: (a: string) => `/api/merchant/stores/${slug}/support-tickets/${id}/attachments/${a}`, escalate: null, close: null }
    : { detail: `/api/platform/market/support-tickets/${id}`, replies: `/api/platform/market/support-tickets/${id}/replies`, status: null, attach: null, image: (a: string) => `/api/platform/market/support-tickets/${id}/attachments/${a}`, escalate: `/api/platform/market/support-tickets/${id}/escalate`, close: `/api/platform/market/support-tickets/${id}/close` };
}

function TicketDetail({ kind, storeSlug, ticketId, onBack }: { kind: "store" | "platform"; storeSlug: string; ticketId: string; onBack: () => void }) {
  const paths = ticketPaths(kind, storeSlug, ticketId);
  const url = paths.detail;
  const [view, setView] = useState<View | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(async () => { try { setView(await call<View>(url)); } catch (error) { setFailure((error as Error).message); } }, [url]);
  useEffect(() => { void load(); }, [load]);
  async function act(target: string | null, init: RequestInit) {
    if (!target) return;
    setBusy(true); setFailure(null);
    try { setView(await call<View>(target, init)); setReply(""); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  async function attach(file: File) {
    if (!paths.attach) return;
    const form = new FormData(); form.append("image", file);
    setBusy(true); setFailure(null);
    try { await call(paths.attach, { method: "POST", body: form }); await load(); } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  if (!view) return <p className="text-sm text-[var(--codiq-text-muted)]">{failure ?? <><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</>}</p>;
  const { ticket, order } = view;
  return (
    <div className="max-w-[860px] space-y-4" data-testid="support-ticket-detail">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--codiq-accent)]"><ArrowRight className="h-4 w-4" /> كلّ التذاكر</button>
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-[var(--codiq-text)]">تذكرة #{ticket.number} — {ticket.typeLabel}</h3>
          <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-xs font-bold text-[var(--codiq-accent)]" data-testid="support-ticket-status">{ticket.statusLabel}</span>
        </div>
        {ticket.subject ? <p className="text-sm font-semibold text-[var(--codiq-text)]">{ticket.subject}</p> : null}
        <p className="whitespace-pre-line text-sm text-[var(--codiq-text-secondary)]">{ticket.description}</p>
        <p className="text-xs text-[var(--codiq-text-muted)]">طلب {order.orderNumber} — {order.customerName}{order.recipientPhone ? <> — <span dir="ltr">{order.recipientPhone}</span></> : null} — {order.items.map((item) => `${item.productName} × ${item.quantity}`).join("، ")}</p>
        {ticket.attachments.length ? (
          <div className="flex flex-wrap gap-2">
            {ticket.attachments.map((attachment) => <a key={attachment.id} href={paths.image(attachment.id)} target="_blank" rel="noopener noreferrer"><img src={paths.image(attachment.id)} alt={`مرفق من ${AUTHOR[attachment.authorKind] ?? ""}`} className="h-20 w-20 rounded-xl border border-[var(--codiq-border)] object-cover" /></a>)}
          </div>
        ) : null}
      </section>
      <section className={card}>
        <h3 className="font-bold text-[var(--codiq-text)]">المحادثة</h3>
        {ticket.comments.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا ردود بعد. الزبون ينتظر ردّك الأوّل.</p> : (
          <ul className="space-y-2">
            {ticket.comments.map((comment) => <li key={comment.id} className={`rounded-2xl p-3 text-sm ${comment.side === "shopper" ? "bg-[var(--codiq-surface-sunken)]" : "bg-[var(--codiq-accent-soft)]"}`}><p className="text-xs font-bold text-[var(--codiq-text-secondary)]">{AUTHOR[comment.authorKind] ?? comment.authorKind} — {new Date(comment.createdAt).toLocaleString("ar-IQ")}</p><p className="whitespace-pre-line text-[var(--codiq-text)]">{comment.body}</p></li>)}
          </ul>
        )}
        {view.canReply ? (
          <div className="space-y-2">
            <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} maxLength={3000} placeholder="اكتب ردّك للزبون" className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm" data-testid="support-ticket-reply" />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !reply.trim()} onClick={() => void act(paths.replies, { method: "POST", body: JSON.stringify({ body: reply }) })} data-testid="support-ticket-send">إرسال</Button>
              <Button variant="outline" disabled={busy || !reply.trim()} onClick={() => void act(paths.replies, { method: "POST", body: JSON.stringify({ body: reply, resolve: true }) })} data-testid="support-ticket-send-resolve">إرسال وتعليمها كمحلولة</Button>
              {kind === "store" && ticket.status === "open" ? <Button variant="outline" disabled={busy} onClick={() => void act(paths.status, { method: "PUT", body: JSON.stringify({ status: "in_progress" }) })}>قيد المعالجة</Button> : null}
              {paths.attach ? <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--codiq-border)] px-3 py-2 text-sm font-semibold"><ImagePlus className="h-4 w-4" /> صورة<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ""; }} /></label> : null}
              {kind === "platform" && !ticket.escalated ? <Button variant="outline" disabled={busy} onClick={() => void act(paths.escalate, { method: "POST" })} data-testid="support-ticket-escalate">تصعيد</Button> : null}
              {kind === "platform" ? <Button variant="outline" disabled={busy} onClick={() => void act(paths.close, { method: "POST" })} data-testid="support-ticket-close">إغلاق</Button> : null}
            </div>
          </div>
        ) : <p className="text-sm text-[var(--codiq-text-muted)]">التذكرة مغلقة.</p>}
        {failure ? <p className="text-sm font-semibold text-[var(--codiq-danger)]" data-testid="support-ticket-error">{failure}</p> : null}
      </section>
    </div>
  );
}
