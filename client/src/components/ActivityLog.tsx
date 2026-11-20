/**
 * PG-2 (plan §4) — «سجل النشاط»: the merchant's own «من فعل ماذا» timeline,
 * read from `store_audit_events` through `GET …/audit-events`.
 *
 * Two deliberate choices.
 *
 * 1. **The action is a noun, not a conjugated verb.** The plan's sample line
 *    («سارة (موظفة) حذفت …») inflects for the actor's gender, which the server
 *    does not know and never will — `actor_label` is a text snapshot of a name.
 *    Guessing would produce «سارة … حذف» half the time, and ق-96 forbids the
 *    feminine forms outright. «إزالة المنتج «قميص قطني» · سارة (موظف)» is
 *    gender-free, shorter, and scans as a log line rather than a sentence.
 * 2. **Every value shown is the snapshot the event carries**, not a live join:
 *    the staff member may have left and the product may already be purged, so
 *    re-resolving names would turn old lines into blanks or, worse, into the
 *    name of whoever holds that id today.
 *
 * Read-only by construction: `store_audit_events` is append-only in the database
 * (`store_audit_events_immutable`), so there is nothing here to edit or delete.
 */
import { BadgeCheck, BadgeX, History, LoaderCircle, RotateCcw, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrashApiError, merchantStoreBase, readableError, trashApi } from "@/components/DeleteConfirmSheet";

interface AuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  entitySecondary: string | null;
  action: string;
  actorKind: string;
  actorLabel: string;
  /// MD-6: the owner's reason, when there is one. The API has always returned
  /// `metadata`; until now nothing here read it, so a note written for the
  /// merchant reached him as an empty line.
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_NOUN: Record<string, string> = {
  soft_deleted: "إزالة",
  "customer.blocked": "حظر",
  "customer.unblocked": "رفع الحظر",
  restored: "استعادة",
  purged: "حذف نهائي",
  purge_blocked: "تعذّر الحذف النهائي",
  // MD-6: an act of the PLATFORM on this store, not of the merchant on his own
  // rows -- the only entries here whose actor is the owner.
  "verification.granted": "منح توثيق",
  "verification.revoked": "سحب توثيق",
};

const ACTION_STYLE: Record<string, { icon: LucideIcon; tint: string; ring: string }> = {
  soft_deleted: { icon: Trash2, tint: "bg-[var(--codiq-danger-soft)] text-[#B44B40]", ring: "bg-[#E9B7B1]" },
  restored: { icon: RotateCcw, tint: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]", ring: "bg-[#A9D5BE]" },
  purged: { icon: Trash2, tint: "bg-[var(--codiq-neutral-soft)] text-[#65748B]", ring: "bg-[#C3CEDE]" },
  purge_blocked: { icon: TriangleAlert, tint: "bg-[#FFF6EC] text-[var(--codiq-warning)]", ring: "bg-[#E4C79A]" },
  "verification.granted": { icon: BadgeCheck, tint: "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)]", ring: "bg-[#AFC9EC]" },
  "verification.revoked": { icon: BadgeX, tint: "bg-[#FFF6EC] text-[var(--codiq-warning)]", ring: "bg-[#E4C79A]" },
};

const ENTITY_NOUN: Record<string, string> = {
  product: "المنتج",
  customer: "الزبون",
  product_variant: "متغيّر المنتج",
  product_category: "التصنيف",
  coupon: "الكوبون",
  staff_membership: "عضوية",
  store_verification: "توثيق المتجر",
};

const ACTOR_KIND: Record<string, string> = {
  merchant: "التاجر",
  staff: "موظف",
  platform_owner: "إدارة المنصة",
  system: "النظام",
};

const ENTITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "كل الأنواع" },
  { value: "product", label: "المنتجات" },
  { value: "product_variant", label: "متغيّرات المنتج" },
  { value: "product_category", label: "التصنيفات" },
  { value: "coupon", label: "الكوبونات" },
  { value: "staff_membership", label: "الفريق" },
  { value: "store_verification", label: "التوثيق" },
];

const timeOnly = new Intl.DateTimeFormat("ar-IQ", { timeStyle: "short" });
const fullStamp = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

function whenLabel(iso: string): string {
  const at = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (at.valueOf() >= startOfToday.valueOf()) return `اليوم ${timeOnly.format(at)}`;
  const startOfYesterday = new Date(startOfToday.valueOf() - 86_400_000);
  if (at.valueOf() >= startOfYesterday.valueOf()) return `أمس ${timeOnly.format(at)}`;
  return fullStamp.format(at);
}

export function ActivityLog({ storeSlug }: { storeSlug?: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const base = storeSlug ? merchantStoreBase(storeSlug) : null;
  // Switching the filter twice quickly fires two requests; without this the
  // slower one can land last and leave the timeline showing the OTHER filter's
  // rows under the filter the merchant selected.
  const request = useRef(0);

  const fetchPage = useCallback(async (after: string | null, replace: boolean) => {
    if (!base) return;
    const ticket = (request.current += 1);
    const query = new URLSearchParams({ limit: "25" });
    if (after) query.set("cursor", after);
    if (entityType) query.set("entityType", entityType);
    try {
      const data = await trashApi<{ events: AuditEvent[]; nextCursor: string | null }>(`${base}/audit-events?${query.toString()}`);
      if (ticket !== request.current) return;
      setEvents((current) => (replace ? data.events : [...current, ...data.events]));
      setCursor(data.nextCursor);
      setFailure(null);
    } catch (error) {
      if (ticket !== request.current) return;
      setFailure(error instanceof TrashApiError ? readableError(error) : "تعذر الاتصال بالخادم.");
      if (replace) setEvents([]);
    }
  }, [base, entityType]);

  useEffect(() => {
    setLoading(true);
    void fetchPage(null, true).finally(() => setLoading(false));
  }, [fetchPage]);

  if (!storeSlug || !base) {
    return <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]" dir="rtl"><ShieldAlert className="mb-3 h-6 w-6" />افتح لوحة التاجر عبر مسار متجر محدد قبل فتح سجل النشاط.</div>;
  }

  return (
    <section className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"><History className="h-5 w-5" strokeWidth={1.8} /></span>
          <div>
            <h2 className="font-bold text-[#273753]">سجل النشاط</h2>
            <p className="mt-1 max-w-xl text-xs leading-6 text-[var(--codiq-text-muted)]">من أزال ماذا ومتى، ومن استعاده. السجل لا يُعدَّل ولا يُحذف، ويبقى بعد تنقية العنصر نفسه.</p>
          </div>
        </div>
        <label className="text-right">
          <span className="sr-only">تصفية حسب النوع</span>
          <select
            data-testid="activity-entity-filter"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
            className="rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-xs font-semibold text-[var(--codiq-text)]"
          >
            {ENTITY_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
          </select>
        </label>
      </div>

      {loading ? <p className="mt-6 flex items-center gap-2 text-sm text-[#61708A]"><LoaderCircle className="h-4 w-4 animate-spin text-[var(--codiq-accent)]" />جارٍ تحميل سجل النشاط…</p> : null}

      {failure ? (
        <p data-testid="activity-error" className="mt-6 rounded-2xl border border-[#F3CBCA] bg-[#FFF7F7] px-4 py-3 text-sm leading-7 text-[#9B3733]">{failure}</p>
      ) : null}

      {!loading && !failure && !events.length ? <p className="mt-6 text-sm text-[var(--codiq-text-muted)]">لا نشاط مسجّل بعد في هذا المتجر.</p> : null}

      {events.length ? (
        <ol data-testid="activity-timeline" className="mt-6 space-y-0">
          {events.map((event, index) => {
            const style = ACTION_STYLE[event.action] ?? ACTION_STYLE.purged!;
            const Icon = style.icon;
            const last = index === events.length - 1;
            return (
              <li key={event.id} data-testid="activity-entry" className="relative flex gap-3 pb-5">
                {last ? null : <span aria-hidden className={`absolute right-[19px] top-10 bottom-0 w-px ${style.ring}`} />}
                <span className={`relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full ${style.tint}`}><Icon className="h-4 w-4" strokeWidth={1.8} /></span>
                <div className="min-w-0 flex-1 pt-1.5">
                  <p className="text-sm leading-7 text-[#31415C]">
                    <span className="font-bold">{ACTION_NOUN[event.action] ?? event.action}</span>
                    {" "}
                    {ENTITY_NOUN[event.entityType] ?? event.entityType} «{event.entityLabel}»
                    {event.entitySecondary ? <span className="mr-1.5 text-xs text-[#8A96A9]" dir="ltr">{event.entitySecondary}</span> : null}
                  </p>
                  {typeof event.metadata?.note === "string" && event.metadata.note ? (
                    // MD-6: the owner is told on his own screen that this note
                    // travels to the merchant. This is where it arrives — without
                    // it that warning would be asking him to self-censor for an
                    // audience that never reads him.
                    <p className="mt-1 rounded-xl bg-[var(--codiq-canvas)] px-3 py-2 text-[13px] leading-6 text-[#3A4A63]">{event.metadata.note}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-[#8A96A9]">
                    {event.actorLabel} ({ACTOR_KIND[event.actorKind] ?? event.actorKind}) · <time dateTime={event.createdAt}>{whenLabel(event.createdAt)}</time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {cursor && !loading ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 rounded-xl"
          disabled={loadingMore}
          data-testid="activity-load-more"
          onClick={() => { setLoadingMore(true); void fetchPage(cursor, false).finally(() => setLoadingMore(false)); }}
        >
          {loadingMore ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : null}عرض المزيد
        </Button>
      ) : null}
    </section>
  );
}
