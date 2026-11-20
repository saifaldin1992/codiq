/**
 * PG-2 (plan §4) — سلة المحذوفات: four entity tabs plus the activity log.
 *
 * Three things on this screen are load-bearing and easy to get wrong.
 *
 * 1. `deletedAt` is a MANDATORY discriminator on every row, not decoration.
 *    Since the unique indexes became partial, «احذف ABC ← أنشئ ABC ← احذفه»
 *    legitimately leaves TWO trashed rows carrying the same SKU. Without the
 *    exact moment on each line the merchant cannot tell which one he is about
 *    to restore, and that is a correctness bug, not a polish one.
 * 2. A blocked row shows «محفوظ لسجلاتك» with the server's OWN reason string
 *    (`purgeBlockReason`, written by the purge job from the same table that
 *    produces the HTTP 409). No counter, no invented explanation (ق-10). And it
 *    shows NO countdown, because that row is never going to be purged.
 * 3. A restore conflict opens a PRE-FILLED, EDITABLE field. It never renames
 *    anything silently: a SKU is the merchant's key at his supplier and on his
 *    printed labels, so the suggestion is a starting point he can overwrite.
 */
import { AlertTriangle, Archive, CircleAlert, History, LoaderCircle, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActivityLog } from "@/components/ActivityLog";
import {
  DAY_FORMS,
  ENTITY_TAB_LABEL,
  TrashApiError,
  ar,
  counted,
  daysUntil,
  endpointsFor,
  merchantStoreBase,
  readableError,
  trashApi,
  type TrashEntityType,
} from "@/components/DeleteConfirmSheet";

const TAB_ORDER: TrashEntityType[] = ["product", "product_category", "coupon", "staff_membership"];

type TabId = TrashEntityType | "activity";

/**
 * ح-3 — `catalog.trash.view` is the entry fee, not the whole price: a coupon row
 * also answers to `settings.manage` and a team seat to `team.manage`. The server
 * already omits the rows a reader cannot act on, so a tab for them would open
 * onto a permanently empty list and a 403 on `?entityType=`.
 */
const TAB_GOVERNING_PERMISSION: Partial<Record<TrashEntityType, string>> = {
  coupon: "settings.manage",
  staff_membership: "team.manage",
};

function visibleTabs(permissions?: readonly string[]): Array<{ id: TabId; label: string }> {
  const entities = TAB_ORDER.filter((entityType) => {
    const governing = TAB_GOVERNING_PERMISSION[entityType];
    return !governing || !permissions || permissions.includes(governing);
  });
  return [
    ...entities.map((entityType) => ({ id: entityType as TabId, label: ENTITY_TAB_LABEL[entityType] })),
    { id: "activity" as TabId, label: "سجل النشاط" },
  ];
}

interface TrashRow {
  id: string;
  entityType: TrashEntityType;
  label: string;
  secondary: string | null;
  deletedAt: string;
  purgeAt: string;
  deletedBy: string | null;
  purgeBlockedAt: string | null;
  purgeBlockReason: string | null;
  /**
   * The server's answer to «هل سيُحذف هذا نهائياً؟», known on day one rather than
   * on day 31. It is true both for a row the sweep has already refused and for
   * one a restricting foreign key is already holding — so the bin never promises
   * a purge the confirmation sheet just said would not happen.
   */
  keptForRecords: boolean;
  keptReason: string | null;
}

interface Conflict {
  scope: "product" | "variant" | "category" | "coupon" | "staff_membership";
  variantId?: string;
  sku?: string;
  code?: string;
  name?: string;
  liveId: string;
  liveName: string;
}

type LiveCategory = { id: string; name: string };

/**
 * The suggestion state for one conflicting code: «SKU-300» → «SKU-300-1», and
 * if that is taken too → «SKU-300-2» — never «SKU-301».
 *
 * The counter is remembered per field instead of being read back out of the
 * value, because a merchant's SKU may legitimately END in digits: parsing
 * «SKU-300» as «SKU» + 300 and offering «SKU-301» would hand him the code of a
 * DIFFERENT product in his own catalogue. The base is captured once, from the
 * first conflict, and only the counter moves.
 *
 * A suggestion is exactly that. It lands in an editable field and is never sent
 * without the merchant pressing the button, because the server has no idea what
 * his supplier calls the item or what is printed on his labels.
 */
interface Suggestion { base: string; attempt: number; value: string }

function nextSuggestion(previous: Suggestion | undefined, takenCode: string): Suggestion {
  const base = previous?.base ?? takenCode;
  const attempt = (previous?.attempt ?? 0) + 1;
  return { base, attempt, value: `${base}-${attempt}` };
}

const stamp = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

/** «يُحذف نهائياً بعد ٣ أيام» — and never «بعد ٠ يوماً» once the window has run out. */
function purgeCountdown(purgeAt: string): string {
  const days = daysUntil(purgeAt);
  return days === 0 ? "يُحذف نهائياً في أول تنقية قادمة" : `يُحذف نهائياً بعد ${counted(days, DAY_FORMS)}`;
}

function ExactMoment({ iso }: { iso: string }) {
  // The full moment, never a relative phrase: «قبل ساعتين» cannot tell two rows
  // with the same SKU apart, and telling them apart is the whole point.
  return <time dateTime={iso} title={new Date(iso).toISOString()}>{stamp.format(new Date(iso))}</time>;
}

/**
 * `permissions` is the actor's server-resolved permission set, when the shell
 * has one. The merchant shell does NOT: a merchant session holds every code by
 * construction (`requireStoreActor` returns the full set), so leaving it
 * undefined shows all four tabs, which is correct for that shell. The staff
 * shell does have one, and ح-3 means a member without `settings.manage` or
 * `team.manage` receives no coupon or team rows at all — rendering those tabs
 * for him would be offering two doors that open onto an empty room.
 */
export function TrashBin({ storeSlug, permissions }: { storeSlug?: string; permissions?: readonly string[] }) {
  const [tab, setTab] = useState<TabId>("product");
  const [rows, setRows] = useState<TrashRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = storeSlug ? merchantStoreBase(storeSlug) : null;
  // Only the newest request may write state. Two quick «تحديث» clicks otherwise
  // land in whatever order the network chooses.
  const request = useRef(0);

  /**
   * ع-6: the bin is keyset-paginated because ق-97 sends every product that was
   * ever sold into it permanently, so the list has no upper bound. `after` is
   * the server's opaque cursor, passed back verbatim.
   */
  const load = useCallback(async (after: string | null) => {
    if (!base) return;
    const ticket = (request.current += 1);
    if (after) setLoadingMore(true); else setLoading(true);
    setFailure(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (after) query.set("cursor", after);
      const data = await trashApi<{ items: TrashRow[]; nextCursor: string | null }>(`${base}/trash?${query.toString()}`);
      if (ticket !== request.current) return;
      setRows((current) => (after && current ? [...current, ...data.items] : data.items));
      setCursor(data.nextCursor);
    } catch (error) {
      if (ticket !== request.current) return;
      if (!after) setRows(null);
      setFailure(error instanceof TrashApiError ? readableError(error) : "تعذر الاتصال بالخادم.");
    } finally {
      if (ticket === request.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [base]);

  const reload = useCallback(() => { setCursor(null); void load(null); }, [load]);

  useEffect(() => { reload(); }, [reload]);

  const tabs = useMemo(() => visibleTabs(permissions), [permissions]);
  // The badge counts LOADED rows, so it is only the truth once the last page has
  // arrived. While a cursor is outstanding it says nothing rather than a number
  // that is quietly short (ق-10).
  const counts = useMemo(() => {
    if (cursor) return null;
    const map = new Map<TrashEntityType, number>(TAB_ORDER.map((entityType) => [entityType, 0]));
    for (const row of rows ?? []) map.set(row.entityType, (map.get(row.entityType) ?? 0) + 1);
    return map;
  }, [rows, cursor]);

  const visible = useMemo(() => (tab === "activity" ? [] : (rows ?? []).filter((row) => row.entityType === tab)), [rows, tab]);

  // RTL: ArrowLeft advances, ArrowRight goes back — the reading direction, not
  // the Latin one. Home/End jump to the ends, as the tabs pattern expects.
  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((entry) => entry.id === tab);
    const step = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    let target = -1;
    if (step) target = (index + step + tabs.length) % tabs.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    if (target < 0) return;
    event.preventDefault();
    setTab(tabs[target]!.id);
    setNotice(null);
    // Focus follows selection, which is what makes the arrow keys useful rather
    // than merely present.
    requestAnimationFrame(() => document.getElementById(`trash-tab-${tabs[target]!.id}`)?.focus());
  }

  if (!storeSlug || !base) {
    return <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]" dir="rtl"><ShieldAlert className="mb-3 h-6 w-6" />افتح لوحة التاجر عبر مسار متجر محدد قبل فتح سلة المحذوفات.</div>;
  }

  return (
    <div className="max-w-[1030px] space-y-5" dir="rtl">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"><Archive className="h-5 w-5" strokeWidth={1.8} /></span>
            <div>
              <h2 className="font-bold text-[#273753]">سلة المحذوفات</h2>
              <p className="mt-1 max-w-xl text-xs leading-6 text-[var(--codiq-text-muted)]">كل ما أزلته من متجرك يبقى هنا قابلاً للاستعادة حتى موعد تنقيته. والصفوف المرتبطة بطلبات أو سجلات مالية تبقى محفوظة ولا تُنقّى أبداً.</p>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={reload}>تحديث</Button>
        </div>

        {/* A real tablist, not the look of one: each tab owns the panel by id,
            only the selected tab is in the Tab order, and the arrow keys the
            role advertises actually move the selection (WAI-ARIA tabs). */}
        <div className="codiq-scroll mt-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="أقسام سلة المحذوفات" onKeyDown={onTabKeyDown}>
          {tabs.map((entry) => {
            const selected = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`trash-tab-${entry.id}`}
                aria-selected={selected}
                aria-controls="trash-panel"
                tabIndex={selected ? 0 : -1}
                data-testid={`trash-tab-${entry.id}`}
                onClick={() => { setTab(entry.id); setNotice(null); }}
                className={`shrink-0 rounded-2xl px-3.5 py-2 text-[13px] font-semibold transition-colors ${selected ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)]" : "bg-[var(--codiq-canvas)] text-[#68758A] hover:bg-[var(--codiq-neutral-soft)]"}`}
              >
                {entry.id === "activity" ? <History className="ml-1.5 inline h-3.5 w-3.5" /> : null}
                {entry.label}
                {entry.id === "activity" || !counts ? null : <span className="mr-1.5 text-[11px] font-bold text-[#8A96A9]">{ar(counts.get(entry.id as TrashEntityType) ?? 0)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {notice ? <p data-testid="trash-notice" className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}

      <div id="trash-panel" role="tabpanel" aria-labelledby={`trash-tab-${tab}`} tabIndex={0} className="outline-none">
      {tab === "activity" ? <ActivityLog storeSlug={storeSlug} /> : (
        <div className="space-y-3">
          {loading ? <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A]"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />جارٍ تحميل سلة المحذوفات…</div> : null}
          {failure ? (
            <div data-testid="trash-error" className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]">
              <CircleAlert className="mb-3 h-5 w-5" />
              {failure}
            </div>
          ) : null}
          {!loading && !failure && !visible.length ? (
            <div className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]">
              {cursor ? "لا شيء في هذا القسم ضمن ما حُمّل حتى الآن — حمّل المزيد للمتابعة." : "لا شيء في هذا القسم من سلة المحذوفات."}
            </div>
          ) : null}
          {visible.map((row) => <TrashRowCard key={`${row.entityType}:${row.id}`} row={row} storeSlug={storeSlug} onRestored={(message) => { setNotice(message); reload(); }} />)}
          {cursor && !loading ? (
            <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={loadingMore} data-testid="trash-load-more" onClick={() => void load(cursor)}>
              {loadingMore ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : null}حمّل المزيد
            </Button>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}

function TrashRowCard({ row, storeSlug, onRestored }: { row: TrashRow; storeSlug: string; onRestored: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [conflictCode, setConflictCode] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // A ref, not state: nothing renders from it. It is bookkeeping that tells the
  // NEXT conflict which base to count from, and keeping it out of state avoids
  // a setState nested inside another setState's updater.
  const suggestions = useRef<Record<string, Suggestion>>({});
  const [categoryChoice, setCategoryChoice] = useState<string>("");
  const [liveCategories, setLiveCategories] = useState<LiveCategory[] | null>(null);
  const [settled, setSettled] = useState(false);
  // NOT `purgeBlockedAt`: that is stamped only when the sweep reaches the row on
  // day 31, so relying on it would print «يُحذف نهائياً بعد ٣٠ يوماً» for the
  // whole retention window over a sold product the sheet just promised to keep.
  const kept = row.keptForRecords;

  async function restore(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await trashApi(endpointsFor(storeSlug, row.entityType, row.id).restore, { method: "POST", body: JSON.stringify(body) });
      setConflicts(null);
      setConflictCode(null);
      setConflictMessage(null);
      onRestored(`استُعيد «${row.label}» إلى متجرك.`);
    } catch (error) {
      if (!(error instanceof TrashApiError)) { setConflictCode("NETWORK"); setConflictMessage("تعذر الاتصال بالخادم — أعد المحاولة."); setBusy(false); return; }
      setConflictCode(error.code);
      setConflictMessage(readableError(error));
      const list = Array.isArray(error.details.conflicts) ? (error.details.conflicts as Conflict[]) : null;
      setConflicts(list);
      if (list) {
        // Pre-fill each taken code with an editable suggestion. A value the
        // merchant has already TYPED is never overwritten — only a field still
        // holding our own previous suggestion advances to the next one.
        const replacements: Array<[string, string, string | undefined]> = [];
        for (const conflict of list) {
          const key = conflict.scope === "variant" && conflict.variantId ? `variant:${conflict.variantId}` : conflict.scope === "coupon" ? "code" : conflict.scope === "product" ? "sku" : null;
          const taken = conflict.sku ?? conflict.code;
          if (!key || !taken) continue;
          const previous = suggestions.current[key];
          const suggestion = nextSuggestion(previous, taken);
          suggestions.current[key] = suggestion;
          replacements.push([key, suggestion.value, previous?.value]);
        }
        // A functional update, because the merchant may have been typing in the
        // field while this request was in flight — his value must win.
        setOverrides((current) => {
          const next = { ...current };
          for (const [key, value, previousValue] of replacements) {
            const held = next[key];
            if (held === undefined || held === previousValue) next[key] = value;
          }
          return next;
        });
      }
      if (error.code === "CATEGORY_NAME_TAKEN" && row.entityType === "product") void loadLiveCategories();
      if (error.code === "STAFF_ALREADY_ON_TEAM") setSettled(true);
    } finally {
      setBusy(false);
    }
  }

  async function loadLiveCategories() {
    if (liveCategories) return;
    try {
      const data = await trashApi<{ categories: LiveCategory[] }>(`${merchantStoreBase(storeSlug)}/catalog/categories`);
      setLiveCategories(data.categories);
    } catch {
      setLiveCategories([]);
    }
  }

  function submitOverrides() {
    if (row.entityType === "coupon") { void restore({ code: overrides.code }); return; }
    if (conflictCode === "CATEGORY_NAME_TAKEN") { void restore({ categoryId: categoryChoice || null }); return; }
    const variantSkus: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (key.startsWith("variant:")) variantSkus[key.slice("variant:".length)] = value;
    }
    void restore({ ...(overrides.sku ? { sku: overrides.sku } : {}), ...(Object.keys(variantSkus).length ? { variantSkus } : {}) });
  }

  return (
    <article data-testid={`trash-row-${row.entityType}-${row.id}`} className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-[#273753]">{row.label}</h3>
            {row.secondary ? <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-bold text-[#65748B]" dir="ltr">{row.secondary}</span> : null}
            {kept ? (
              <span data-testid="trash-kept-badge" className="inline-flex items-center gap-1.5 rounded-full bg-[#FFF6EC] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-warning)]">
                <ShieldCheck className="h-3 w-3" />محفوظ لسجلاتك
              </span>
            ) : null}
          </div>
          {/* The mandatory discriminator — two trashed rows may share a SKU. */}
          <p className="mt-1.5 text-xs text-[var(--codiq-text-muted)]" data-testid="trash-row-deleted-at">أُزيل في <ExactMoment iso={row.deletedAt} />{row.deletedBy ? <> · حذفه {row.deletedBy}</> : null}</p>
          {kept ? (
            <p className="mt-1 text-xs leading-6 text-[var(--codiq-warning)]">{row.keptReason ?? "مرتبط بسجلات أخرى."} لا يُحذف نهائياً، ويبقى متاحاً للاستعادة.</p>
          ) : (
            <p className="mt-1 text-xs text-[var(--codiq-text-muted)]" data-testid="trash-row-purge-in">{purgeCountdown(row.purgeAt)}</p>
          )}
        </div>
        {settled ? null : (
          <Button type="button" size="sm" variant="outline" className="shrink-0 rounded-xl border-[#C9D9EE] text-[var(--codiq-accent)] hover:bg-[var(--codiq-canvas)]" disabled={busy} data-testid="trash-restore" onClick={() => void restore({})}>
            {busy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="ml-1 h-3.5 w-3.5" />}استعادة
          </Button>
        )}
      </div>

      {conflictMessage ? (
        <div data-testid="trash-conflict" role="alert" className="mt-4 rounded-2xl border border-[#F0D7B4] bg-[#FFFBF4] p-4 text-sm leading-7 text-[#7C5A1E]">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle className="mt-1 h-4 w-4 shrink-0" />{conflictMessage}</p>

          {conflictCode === "SKU_TAKEN_BY_ACTIVE_PRODUCT" && conflicts ? (
            <div className="mt-3 space-y-3">
              <p className="text-[13px] text-[#8A6A2C]">اختر رمزاً بديلاً. الرمز مفتاحك عند مورّدك وعلى ملصقاتك، فلن نغيّره من تلقاء أنفسنا — عدّل المقترح كما تشاء.</p>
              {conflicts.map((conflict) => {
                const key = conflict.scope === "variant" && conflict.variantId ? `variant:${conflict.variantId}` : "sku";
                return (
                  <label key={key} className="block text-right">
                    <span className="mb-1.5 block text-xs font-bold text-[#7C5A1E]">
                      {conflict.scope === "variant" ? "رمز المتغيّر" : "رمز المنتج"} «{conflict.sku}» يحمله الآن: {conflict.liveName}
                    </span>
                    <input
                      data-testid={`trash-conflict-input-${key}`}
                      value={overrides[key] ?? ""}
                      dir="ltr"
                      onChange={(event) => setOverrides({ ...overrides, [key]: event.target.value })}
                      className="w-full rounded-xl border border-[#E3CDA4] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[#C99A3E]"
                    />
                  </label>
                );
              })}
            </div>
          ) : null}

          {conflictCode === "COUPON_CODE_TAKEN" ? (
            <label className="mt-3 block text-right">
              <span className="mb-1.5 block text-xs font-bold text-[#7C5A1E]">رمز بديل للكوبون المستعاد</span>
              <input
                data-testid="trash-conflict-input-code"
                value={overrides.code ?? ""}
                dir="ltr"
                onChange={(event) => setOverrides({ ...overrides, code: event.target.value })}
                className="w-full rounded-xl border border-[#E3CDA4] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[#C99A3E]"
              />
            </label>
          ) : null}

          {conflictCode === "CATEGORY_NAME_TAKEN" && row.entityType === "product" ? (
            <label className="mt-3 block text-right">
              <span className="mb-1.5 block text-xs font-bold text-[#7C5A1E]">تصنيف بديل للمنتج المستعاد</span>
              <select
                data-testid="trash-conflict-category"
                value={categoryChoice}
                onChange={(event) => setCategoryChoice(event.target.value)}
                className="w-full rounded-xl border border-[#E3CDA4] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)]"
              >
                <option value="">أعِده بلا تصنيف</option>
                {(liveCategories ?? []).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
          ) : null}

          {/* Restoring a CATEGORY itself accepts no override on the server, so the
              only honest thing to say is what actually unblocks the merchant. */}
          {conflictCode === "CATEGORY_NAME_TAKEN" && row.entityType === "product_category" ? (
            <p className="mt-2 text-[13px] text-[#8A6A2C]">غيّر اسم التصنيف الحيّ الذي أخذ هذا الاسم من صفحة «التصنيفات»، ثم أعد الاستعادة من هنا.</p>
          ) : null}

          {conflictCode === "STAFF_ALREADY_ON_TEAM" ? (
            <p className="mt-2 text-[13px] text-[#8A6A2C]">لا حاجة لأي إجراء — عضويته الحالية تعمل، وهذا الصف القديم يبقى في السلة حتى تنقيته.</p>
          ) : null}

          {(conflictCode === "SKU_TAKEN_BY_ACTIVE_PRODUCT" || conflictCode === "COUPON_CODE_TAKEN" || (conflictCode === "CATEGORY_NAME_TAKEN" && row.entityType === "product")) ? (
            <Button type="button" size="sm" disabled={busy} data-testid="trash-conflict-submit" className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" onClick={submitOverrides}>
              {busy ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <RotateCcw className="ml-2 h-4 w-4" />}استعِده بهذه القيم
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
