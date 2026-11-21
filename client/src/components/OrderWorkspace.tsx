import { OrderPrintSheet, type PrintKind } from "@/components/OrderPrintSheet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, CheckCircle2, CircleAlert, ClipboardList, Clock3, FileDown, ListChecks, LoaderCircle, MessageSquareText, PackageOpen, Printer, RefreshCw, Search, ShieldAlert, Store, Tag, UserRound, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type OrderStatus = "new" | "processing" | "preparation" | "out_for_delivery" | "completed" | "cancelled" | "rejected" | "returned";

// `dashboardBase` on the platform scope: the workspace is mounted in TWO shells
// (owner, platform staff). The detail link must stay inside whichever mounted
// it — ق-171 found a click carrying staff into the owner shell.
type Scope = { kind: "merchant"; storeSlug: string; dashboardBase?: string } | { kind: "platform"; dashboardBase?: string };
type OrderEvent = { id: string; fromStatus: OrderStatus | null; toStatus: OrderStatus; actorKind: string; actorId: string | null; note: string | null; createdAt: string };
/** Marketplace M5: `addons` are the paid extras already inside unitPriceIqd, named so the merchant packs them. */
type OrderLine = { id: string; productId: string | null; sku: string | null; productName: string; quantity: number; unitPriceIqd: number; lineTotalIqd: number; addons?: { name: string; priceIqd: number }[] };
type PrescriptionStatus = "pending_upload" | "pending_review" | "approved" | "rejected";
type Order = {
  /** Marketplace M5: delivery | pickup. */
  fulfilment?: string;
  // q-246: the parcel after the shelf. NULL until the merchant records them.
  courierName: string | null; trackingNumber: string | null; handedOverAt: string | null; codCollectedAt: string | null;
  id: string; storeId: string; orderNumber: string; status: OrderStatus; customerName: string; customerId: string | null; customerEmail: string | null; recipientPhone: string | null;
  customerNote: string | null; shippingGovernorate: string | null; shippingAddressLine1: string | null; shippingAddressLine2: string | null; subtotalIqd: number; deliveryFeeIqd: number; discountIqd: number;
  couponCode?: string | null; prescriptionStatus?: PrescriptionStatus | null;
  // MD-1: internal merchant labels. Present on merchant list rows only — the
  // platform payload and every customer/storefront payload omit them entirely.
  internalTags?: string[];
  totalIqd: number; loyaltyPointsSpent: number; loyaltyDiscountIqd: number; platformDiscountIqd?: number; paymentStatus: string; paymentMethodCode?: string; source: string; version: number; statusUpdatedAt: string; createdAt: string; items?: OrderLine[]; statusEvents?: OrderEvent[];
  store?: { id?: string; slug: string; name: string; merchant?: { id: string; businessName: string } };
};

// ---------- MD-1: internal notes, internal tags, bulk transitions ----------
type OrderNote = { id: string; authorKind: string; authorId: string; authorName?: string | null; body: string; createdAt: string };
type BulkResult = { orderId: string; ok: boolean; code: string; orderNumber?: string; message?: string };
type BulkSummary = { toStatus: OrderStatus; requested: number; succeeded: number; failed: number; results: BulkResult[] };

const BULK_ORDER_LIMIT = 50;
const ORDER_TAGS_MAX_COUNT = 8;
const ORDER_TAG_MAX_LENGTH = 24;
const ORDER_NOTE_MAX_LENGTH = 2000;

/**
 * Per-order failure reasons for the bulk summary. Every code below is one the
 * server can attach to a SINGLE order inside a batch; anything unmapped falls
 * back to the server's own message, so this table is a nicety, not a contract.
 * Request-level refusals (INVALID_BULK_SELECTION, BULK_LIMIT_EXCEEDED,
 * INVALID_ORDER_STATUS, INVALID_ORDER_NOTE, and the guard codes) never reach
 * this table — they fail the whole call and surface through `errorMessage`.
 */
const bulkFailureLabels: Record<string, string> = {
  INVALID_ORDER_TRANSITION: "الانتقال غير مسموح من حالة الطلب الحالية.",
  ORDER_VERSION_CONFLICT: "تغيّر الطلب في جلسة أخرى — أعِد المحاولة بعد التحديث.",
  INVALID_ORDER_VERSION: "تعذّرت قراءة إصدار الطلب — حدّث القائمة وأعِد المحاولة.",
  PRESCRIPTION_NOT_APPROVED: "بانتظار اعتماد الوصفة الطبية قبل المعالجة.",
  RESOURCE_NOT_FOUND: "الطلب غير موجود ضمن هذا المتجر.",
  INSUFFICIENT_AVAILABLE_STOCK: "المخزون المحجوز لم يعد كافياً لإكمال الطلب.",
  PLAN_LIMIT_EXCEEDED: "حدّ الباقة الحالية لا يسمح بإتمام هذا الإجراء.",
};

/**
 * Menus pass A: a list either presets one status, or the «بحاجة لإجراء»
 * composite (new + processing merged client-side — the API filters one status
 * per request). Chips inside the page set the same filter the nav presets do.
 */
type StatusFilter = OrderStatus | "" | "action-needed";
type ListMode = { kind: "list"; title: string; status?: OrderStatus; preset?: "action-needed" };
type DetailMode = { kind: "detail"; orderId: string; backPath: string };
type Mode = ListMode | DetailMode;

const ACTION_NEEDED_STATUSES: readonly OrderStatus[] = ["new", "processing"];

const statuses: Record<OrderStatus, { label: string; className: string }> = {
  new: { label: "جديدة", className: "bg-[var(--codiq-accent-soft)] text-[#1B64C4]" },
  processing: { label: "قيد المعالجة", className: "bg-[var(--codiq-warning-soft)] text-[#A76B13]" },
  preparation: { label: "قيد التجهيز", className: "bg-[#F2EEFF] text-[#6955B7]" },
  out_for_delivery: { label: "قيد التوصيل", className: "bg-[#EAF8F9] text-[#237C85]" },
  completed: { label: "مكتملة", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  cancelled: { label: "ملغاة", className: "bg-[var(--codiq-danger-soft)] text-[#B44B40]" },
  rejected: { label: "مرفوضة", className: "bg-[var(--codiq-danger-soft)] text-[#B52D46]" },
  returned: { label: "مرتجعة", className: "bg-[#F6F1EE] text-[#825541]" },
};

// Mirrors the `transitions` table in phase1-backend/src/services/order-lifecycle.service.ts.
const transitions: Record<OrderStatus, OrderStatus[]> = {
  new: ["processing", "cancelled", "rejected"], processing: ["preparation", "cancelled"], preparation: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["completed", "returned"], completed: ["returned"], cancelled: [], rejected: [], returned: [],
};

/**
 * A terminal status is one with NO outgoing edge — DERIVED from the table above
 * rather than hand-listed, so it follows the state machine instead of drifting
 * from it. Moving a batch into one of these cannot be undone from the UI, so the
 * bulk bar demands an explicit confirmation for exactly these targets and for no
 * others: the everyday «قيد المعالجة» / «قيد التجهيز» batch stays one click.
 * `md1.integration.mjs` asserts this derived set against the server's own.
 */
const TERMINAL_STATUSES: OrderStatus[] = (Object.keys(transitions) as OrderStatus[]).filter((status) => transitions[status].length === 0);

const money = new Intl.NumberFormat("ar-IQ");
const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

// Phase 20B-1: prescription review states on the merchant order detail.
const prescriptionBadges: Record<PrescriptionStatus, { label: string; className: string }> = {
  pending_upload: { label: "بانتظار رفع الوصفة", className: "bg-[var(--codiq-warning-soft)] text-[#A76B13]" },
  pending_review: { label: "وصفة قيد المراجعة", className: "bg-[var(--codiq-accent-soft)] text-[#1B64C4]" },
  approved: { label: "وصفة معتمدة", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  rejected: { label: "وصفة مرفوضة", className: "bg-[var(--codiq-danger-soft)] text-[#B52D46]" },
};

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

function basePath(scope: Scope) { return scope.kind === "merchant" ? `/api/merchant/stores/${encodeURIComponent(scope.storeSlug)}/orders` : "/api/platform/orders"; }
function detailPath(scope: Scope, orderId: string) { return scope.kind === "merchant" ? `${scope.dashboardBase ?? `/merchant/stores/${encodeURIComponent(scope.storeSlug)}/dashboard`}/orders/${orderId}` : `${scope.dashboardBase ?? "/platform/dashboard"}/orders/${orderId}`; }
function labelForActor(kind: string) { return kind === "merchant" ? "التاجر" : kind === "platform_owner" ? "مالك المنصة" : kind === "staff" ? "موظف المتجر" : kind === "system" ? "النظام" : "عميل"; }
function formatAmount(value: number) { return `${money.format(value)} د.ع`; }
function formatDate(value: string) { return dateTime.format(new Date(value)); }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? "تعذر إتمام طلب الأوامر.");
  }
  return body as T;
}

function StatusBadge({ status }: { status: OrderStatus }) {
  const config = statuses[status];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${config.className}`}>{config.label}</span>;
}

function Notice({ kind = "info", children }: { kind?: "info" | "error" | "success"; children: React.ReactNode }) {
  const tone = kind === "error" ? "border-[#F2CFCC] bg-[#FFF6F5] text-[#A33B35]" : kind === "success" ? "border-[#CCE8D8] bg-[#F4FBF6] text-[var(--codiq-success)]" : "border-[#D6E5F7] bg-[var(--codiq-canvas)] text-[#35577F]";
  return <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${tone}`}>{children}</div>;
}

function LoadingCard({ text = "جارٍ تحميل الطلبات…" }: { text?: string }) {
  return <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A] shadow-sm"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />{text}</div>;
}

function errorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "تعذر الاتصال بخدمة الطلبات. حاول مرة أخرى.";
  if (error.code === "ORDER_VERSION_CONFLICT") return "تم تحديث الطلب في جلسة أو نافذة أخرى. أُعيد تحميل أحدث حالة له.";
  if (error.code === "INVALID_ORDER_TRANSITION") return "هذا الانتقال لم يعد متاحاً لحالة الطلب الحالية.";
  if (error.code === "RESOURCE_NOT_FOUND") return "الطلب المطلوب غير موجود ضمن نطاق المتجر الحالي.";
  if (error.code === "STORE_BOUNDARY_DENIED" || error.code === "IDENTITY_BOUNDARY_DENIED") return "ليست لديك صلاحية الوصول إلى هذه الطلبات.";
  return error.message;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[11px] font-bold text-[#60708A]">{label}</span>{children}</label>;
}

function sortOrdersDesc(list: Order[]): Order[] {
  // Dedupe by id first: the action-needed view merges two status streams read
  // without a snapshot, so an order transitioning between the reads can appear
  // in both pages.
  const unique = Array.from(new Map(list.map((order) => [order.id, order])).values());
  return unique.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

function OrderList({ scope, mode, navigate }: { scope: Scope; mode: ListMode; navigate: (path: string) => void }) {
  const modeStatus: StatusFilter = mode.preset ?? mode.status ?? "";
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [storeSlug, setStoreSlug] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | "">(mode.status ?? "");
  const [applied, setApplied] = useState({ q: "", from: "", to: "", storeSlug: "", merchantId: "", status: modeStatus as StatusFilter, tag: "" });
  const [orders, setOrders] = useState<Order[]>([]);
  // One pagination cursor per fetched status stream ("" = no status filter);
  // the «بحاجة لإجراء» composite keeps a cursor for new and processing at once.
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // MD-1: multi-select + bulk transition, and the SERVER-side internal-tag filter.
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<OrderStatus | "">("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);
  // MD-2: printing reads the SAME selection the bulk bar acts on, so what is
  // printed is exactly what was chosen — no second, divergent notion of "these".
  const [printKind, setPrintKind] = useState<PrintKind | null>(null);
  // Every tag the STORE uses, straight from the server — not only the tags that
  // happen to sit on the loaded page.
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  // Confirmation gate for irreversible bulk targets (see TERMINAL_STATUSES).
  const [confirmTerminal, setConfirmTerminal] = useState<OrderStatus | null>(null);
  const ordersApiPath = scope.kind === "merchant" ? `/api/merchant/stores/${encodeURIComponent(scope.storeSlug)}/orders` : "/api/platform/orders";

  const load = useCallback(async (cursorMap?: Record<string, string>, append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const statusKeys: readonly string[] = applied.status === "action-needed" ? ACTION_NEEDED_STATUSES : [applied.status];
      const targets = append ? statusKeys.filter((key) => cursorMap?.[key]) : statusKeys;
      const results = await Promise.all(targets.map(async (statusKey) => {
        const params = new URLSearchParams({ limit: "25" });
        if (applied.q.trim()) params.set("q", applied.q.trim());
        if (applied.from) params.set("from", `${applied.from}T00:00:00.000Z`);
        if (applied.to) params.set("to", `${applied.to}T23:59:59.999Z`);
        if (statusKey) params.set("status", statusKey);
        // MD-1 review fix: the tag filter is applied by the SERVER across the
        // whole store, so the rows on screen — and therefore the rows a bulk
        // action would touch — are the real matches, not the subset that
        // happened to land on the current page.
        if (scope.kind === "merchant" && applied.tag) params.set("tag", applied.tag);
        if (scope.kind === "platform" && applied.storeSlug.trim()) params.set("storeSlug", applied.storeSlug.trim());
        if (scope.kind === "platform" && applied.merchantId.trim()) params.set("merchantId", applied.merchantId.trim());
        if (append && cursorMap?.[statusKey]) params.set("cursor", cursorMap[statusKey]);
        return { statusKey, page: await api<{ orders: Order[]; nextCursor: string | null; availableTags?: string[] }>(`${ordersApiPath}?${params.toString()}`) };
      }));
      const fetched = results.flatMap((result) => result.page.orders);
      const facets = results.find((result) => result.page.availableTags)?.page.availableTags;
      if (facets) setAvailableTags(facets);
      // A fresh (non-append) page invalidates the current selection: the rows it
      // pointed at may no longer be listed.
      if (!append) setSelected([]);
      setOrders((current) => sortOrdersDesc(append ? [...current, ...fetched] : fetched));
      setCursors((current) => {
        const next = append ? { ...current } : {};
        for (const { statusKey, page } of results) {
          if (page.nextCursor) next[statusKey] = page.nextCursor; else delete next[statusKey];
        }
        return next;
      });
      setFailure(null);
    } catch (error) { setFailure(errorMessage(error)); if (!append) setOrders([]); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [applied, ordersApiPath, scope.kind]);

  useEffect(() => { setSelectedStatus(mode.status ?? ""); setApplied((current) => ({ ...current, status: modeStatus })); }, [modeStatus, mode.status]);
  useEffect(() => { void load(); }, [load]);

  function applyFilters(event: React.FormEvent) { event.preventDefault(); setApplied((current) => ({ ...current, q: query, from, to, storeSlug, merchantId, status: selectedStatus })); }
  function clearFilters() { setQuery(""); setFrom(""); setTo(""); setStoreSlug(""); setMerchantId(""); setSelectedStatus(mode.status ?? ""); setApplied({ q: "", from: "", to: "", storeSlug: "", merchantId: "", status: modeStatus, tag: "" }); }
  function selectStatusChip(value: StatusFilter) {
    setSelectedStatus(value === "action-needed" ? "" : value);
    setApplied((current) => ({ ...current, status: value }));
  }
  function selectTagChip(value: string) { setApplied((current) => ({ ...current, tag: current.tag === value ? "" : value })); }

  // ---------- MD-1: bulk transitions over the SERVER-filtered rows ----------
  const tagFilter = applied.tag;
  const visibleOrders = orders;
  const selectableIds = useMemo(() => visibleOrders.map((order) => order.id), [visibleOrders]);
  const selectedVisible = useMemo(() => selected.filter((id) => selectableIds.includes(id)), [selected, selectableIds]);
  const overBulkLimit = selectedVisible.length > BULK_ORDER_LIMIT;

  function toggleSelected(orderId: string) {
    setSelected((current) => (current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId]));
  }
  function toggleSelectAll() {
    setSelected((current) => (selectableIds.every((id) => current.includes(id)) && selectableIds.length ? current.filter((id) => !selectableIds.includes(id)) : Array.from(new Set([...current, ...selectableIds]))));
  }

  /**
   * The server performs the transitions ONE BY ONE through the same
   * `transitionOrderStatus` a single-order move uses (own transaction, own
   * expectedVersion, same guards and prescription gate). This handler only
   * ships the selection and renders the per-order outcome.
   */
  /**
   * A terminal target (`cancelled` / `rejected` / `returned`) is irreversible, so
   * it routes through a confirmation that names the exact count first. Every
   * other target runs straight away — the common path stays one click.
   */
  function requestBulkTransition() {
    if (scope.kind !== "merchant" || !bulkStatus || !selectedVisible.length || overBulkLimit) return;
    if (TERMINAL_STATUSES.includes(bulkStatus)) { setConfirmTerminal(bulkStatus); return; }
    void runBulkTransition();
  }

  async function runBulkTransition() {
    if (scope.kind !== "merchant" || !bulkStatus || !selectedVisible.length || overBulkLimit) return;
    setConfirmTerminal(null);
    setBulkBusy(true);
    setBulkSummary(null);
    try {
      const summary = await api<BulkSummary>(`${ordersApiPath}/bulk-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // ق-219: each item carries the version THIS screen saw, so a stale board
        // is refused per order (ORDER_VERSION_CONFLICT in the summary) instead of
        // silently overwriting what a colleague moved a minute ago.
        body: JSON.stringify({ toStatus: bulkStatus, orders: selectedVisible.map((orderId) => ({ orderId, expectedVersion: orders.find((order) => order.id === orderId)?.version })) }),
      });
      setBulkSummary(summary);
      setSelected([]);
      setFailure(null);
      await load();
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBulkBusy(false); }
  }

  // Counts are intentionally absent from the chips: the list endpoints return
  // cursor pages without totals, and eight count scans per visit would be the
  // heavier choice — deferred to the analytics work in 20B.
  const statusChips: { value: StatusFilter; label: string }[] = [
    { value: "action-needed", label: "بحاجة لإجراء" },
    { value: "", label: "الكل" },
    ...Object.entries(statuses).map(([value, status]) => ({ value: value as StatusFilter, label: status.label })),
  ];
  const hasMore = Object.keys(cursors).length > 0;
  const activeFilterLabel = `${applied.status === "action-needed" ? "بحاجة لإجراء" : applied.status ? statuses[applied.status].label : "كل الحالات"}${tagFilter ? ` · وسم «${tagFilter}»` : ""}`;
  // Phase 20B-3 (D-25): merchant-scope CSV export of the CURRENT filters —
  // one row per order item, streamed with a UTF-8 BOM. Platform scope has no
  // export endpoint, so the button never renders there.
  const exportHref = scope.kind === "merchant"
    ? `${ordersApiPath}/export.csv?${new URLSearchParams({
        ...(applied.from ? { from: `${applied.from}T00:00:00.000Z` } : {}),
        ...(applied.to ? { to: `${applied.to}T23:59:59.999Z` } : {}),
        ...(applied.status && applied.status !== "action-needed" ? { status: applied.status } : {}),
      }).toString()}`
    : null;
  return <section className="space-y-5" dir="rtl">
    <div className="rounded-[26px] bg-[var(--codiq-surface)] p-5 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold text-[var(--codiq-accent)]">طلبات {scope.kind === "merchant" ? "المتجر الحالي" : "المنصة"}</p><h2 className="mt-1 text-xl font-bold text-[#273753]">{mode.title}</h2><p className="mt-1 text-sm leading-6 text-[var(--codiq-text-muted)]">{scope.kind === "merchant" ? "تعرض القائمة طلبات متجر الجلسة فقط." : "إشراف عالمي للقراءة فقط على طلبات المتاجر."}</p></div><div className="flex items-center gap-2">{exportHref ? <a data-testid="orders-export-csv" href={exportHref} download className="inline-flex items-center gap-1.5 rounded-xl border border-[#C9D9EE] bg-[var(--codiq-surface)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-accent)] transition hover:bg-[var(--codiq-canvas)]"><FileDown className="h-3.5 w-3.5" />تصدير CSV</a> : null}<span className="rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1.5 text-xs font-bold text-[#64748A]">{activeFilterLabel}</span></div></div>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="تصفية سريعة حسب الحالة">
        {statusChips.map((chip) => {
          const active = applied.status === chip.value;
          return <button key={chip.value || "all"} type="button" onClick={() => selectStatusChip(chip.value)} aria-current={active ? "page" : undefined} className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${active ? "bg-[var(--codiq-accent)] text-white shadow-sm" : "bg-[var(--codiq-neutral-soft)] text-[#64748A] hover:bg-[var(--codiq-accent-soft)] hover:text-[var(--codiq-accent-hover)]"}`}>{chip.label}</button>;
        })}
      </div>
      {scope.kind === "merchant" && availableTags.length ? <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="order-tag-filters" role="group" aria-label="تصفية بالوسوم الداخلية">
        <span className="text-[11px] font-bold text-[#8391A4]">وسوم داخلية:</span>
        <button type="button" onClick={() => selectTagChip("")} className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${tagFilter === "" ? "bg-[#39507A] text-white" : "bg-[var(--codiq-neutral-soft)] text-[#64748A] hover:bg-[var(--codiq-accent-soft)]"}`}>بلا تصفية</button>
        {availableTags.map((tag) => <button key={tag} type="button" data-testid={`order-tag-filter-${tag}`} aria-pressed={tagFilter === tag} onClick={() => selectTagChip(tag)} className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${tagFilter === tag ? "bg-[#39507A] text-white" : "bg-[var(--codiq-neutral-soft)] text-[#4C5C77] hover:bg-[var(--codiq-border-strong)]"}`}>{tag}</button>)}
      </div> : null}
      {/* MD-1: bulk transition bar. The server runs each order through the same
          single-order state machine, so this is a convenience, never a shortcut. */}
      {scope.kind === "merchant" ? <div className="mt-4 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-3.5" data-testid="orders-bulk-bar">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]">
            <input type="checkbox" data-testid="orders-bulk-select-all" aria-label="تحديد كل الطلبات المعروضة" checked={selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id))} onChange={toggleSelectAll} className="h-4 w-4 accent-[var(--codiq-accent)]" />
            تحديد الكل
          </label>
          <span data-testid="orders-bulk-count" className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">{selectedVisible.length} محدد</span>
          <select aria-label="الحالة الهدف للإجراء الجماعي" data-testid="orders-bulk-status" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as OrderStatus | "")} className="rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-xs text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]">
            <option value="">اختر الحالة الهدف</option>
            {Object.entries(statuses).map(([value, status]) => <option key={value} value={value}>{status.label}</option>)}
          </select>
          <Button type="button" size="sm" data-testid="orders-bulk-run" disabled={bulkBusy || !bulkStatus || !selectedVisible.length || overBulkLimit} onClick={requestBulkTransition} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">{bulkBusy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <ListChecks className="ml-1 h-3.5 w-3.5" />}تنفيذ النقل</Button>
          {scope.kind === "merchant" ? ([
            { kind: "label" as PrintKind, label: "بوليصة" },
            { kind: "invoice" as PrintKind, label: "فاتورة" },
            { kind: "picking" as PrintKind, label: "قائمة تجهيز" },
          ]).map((sheet) => (
            <Button key={sheet.kind} type="button" size="sm" variant="outline" data-testid={`orders-print-${sheet.kind}`} disabled={!selectedVisible.length || overBulkLimit} onClick={() => setPrintKind(sheet.kind)} className="rounded-xl">
              <Printer className="ml-1 h-3.5 w-3.5" />{sheet.label}
            </Button>
          )) : null}
          {selectedVisible.length ? <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])} className="rounded-xl text-[#64748A]">إلغاء التحديد</Button> : null}
        </div>
        {/* Irreversible-target confirmation. Rendered ONLY for terminal statuses,
            and it states the exact number of orders it is about to close. */}
        <Dialog open={confirmTerminal !== null} onOpenChange={(next) => { if (!next) setConfirmTerminal(null); }}>
          <DialogContent className="sm:max-w-md" data-testid="orders-bulk-confirm">
            <div dir="rtl">
              <DialogTitle className="text-base font-bold text-[#8A2F2F]">تأكيد إجراء لا رجعة فيه</DialogTitle>
              <DialogDescription className="mt-2 text-sm leading-7 text-[#5B6B84]">
                {confirmTerminal ? <>سيُنقل <span data-testid="orders-bulk-confirm-count" className="font-bold text-[#8A2F2F]">{selectedVisible.length}</span> طلباً إلى «{statuses[confirmTerminal].label}». هذه حالة نهائية: لا يمكن إرجاع الطلب منها إلى أي حالة أخرى، ولا يمكن التراجع عن هذا الإجراء من اللوحة.</> : null}
              </DialogDescription>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" variant="outline" data-testid="orders-bulk-confirm-cancel" onClick={() => setConfirmTerminal(null)} className="rounded-xl">تراجع</Button>
                <Button type="button" size="sm" data-testid="orders-bulk-confirm-run" disabled={bulkBusy} onClick={() => void runBulkTransition()} className="rounded-xl bg-[#A8433A] hover:bg-[#8E3730]">تأكيد النقل النهائي</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        {printKind && scope.kind === "merchant" ? <OrderPrintSheet storeSlug={scope.storeSlug} orderIds={selectedVisible} kind={printKind} onClose={() => setPrintKind(null)} /> : null}
        {overBulkLimit ? <p className="mt-2 text-[11px] font-bold text-[var(--codiq-danger)]">الحد الأقصى {BULK_ORDER_LIMIT} طلباً في العملية الواحدة — قلّل التحديد.</p> : <p className="mt-2 text-[11px] leading-5 text-[var(--codiq-text-muted)]">يُنفَّذ كل طلب على حدة عبر نفس آلة الحالات وحراسة الإصدار؛ الطلبات غير المؤهلة تُرفض وحدها من دون التأثير على البقية.</p>}
        {bulkSummary ? <div data-testid="orders-bulk-summary" className="mt-3 rounded-2xl border border-[#D6E5F7] bg-[var(--codiq-surface)] px-3.5 py-3 text-xs leading-6 text-[#35577F]">
          <p className="font-bold">نُقل {bulkSummary.succeeded}، تعذّر {bulkSummary.failed} من أصل {bulkSummary.requested}.</p>
          {bulkSummary.failed ? <ul className="mt-1.5 space-y-1">{bulkSummary.results.filter((result) => !result.ok).map((result) => <li key={result.orderId} className="text-[#A33B35]">{result.orderNumber ?? result.orderId} — {bulkFailureLabels[result.code] ?? result.message ?? result.code}</li>)}</ul> : null}
        </div> : null}
      </div> : null}
      <form onSubmit={applyFilters} className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><FilterField label="البحث برقم الطلب"><div className="relative"><Search className="absolute right-3 top-3 h-4 w-4 text-[#8794A8]" /><input aria-label="البحث برقم الطلب" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="مثال: ORD-1001" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] py-2.5 pr-9 pl-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" /></div></FilterField><FilterField label="من تاريخ"><input aria-label="من تاريخ" value={from} onChange={(event) => setFrom(event.target.value)} type="date" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></FilterField><FilterField label="إلى تاريخ"><input aria-label="إلى تاريخ" value={to} onChange={(event) => setTo(event.target.value)} type="date" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></FilterField>{scope.kind === "platform" ? <><FilterField label="معرّف المتجر"><input aria-label="معرّف المتجر" value={storeSlug} onChange={(event) => setStoreSlug(event.target.value)} placeholder="store-slug" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></FilterField><FilterField label="معرّف التاجر"><input aria-label="معرّف التاجر" value={merchantId} onChange={(event) => setMerchantId(event.target.value)} placeholder="UUID" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></FilterField></> : null}<FilterField label="الحالة"><select aria-label="الحالة" value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value as OrderStatus | "")} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"><option value="">كل الحالات</option>{Object.entries(statuses).map(([value, status]) => <option key={value} value={value}>{status.label}</option>)}</select></FilterField><div className="flex items-end gap-2"><Button type="submit" className="rounded-xl bg-[var(--codiq-accent)] px-4 hover:bg-[var(--codiq-accent-hover)]">تطبيق</Button><Button type="button" variant="outline" onClick={clearFilters} className="rounded-xl">مسح</Button></div></form>
    </div>
    {failure ? <Notice kind="error"><div className="flex flex-wrap items-center justify-between gap-3"><span>{failure}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()} className="border-[#E3B8B4] text-[#A33B35]">إعادة المحاولة</Button></div></Notice> : null}
    {loading ? <LoadingCard /> : visibleOrders.length ? <div className="space-y-3">{visibleOrders.map((order) => <article key={order.id} className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 shadow-sm transition hover:border-[#BED3EF] sm:p-5"><div className="flex items-start gap-3">{scope.kind === "merchant" ? <input type="checkbox" data-testid={`order-select-${order.orderNumber}`} aria-label={`تحديد الطلب ${order.orderNumber}`} checked={selected.includes(order.id)} onChange={() => toggleSelected(order.id)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--codiq-accent)]" /> : null}<button type="button" onClick={() => navigate(detailPath(scope, order.id))} className="min-w-0 flex-1 text-right"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold text-[#263650]">{order.orderNumber}</p><StatusBadge status={order.status} /></div><p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--codiq-text-muted)]"><UserRound className="h-3.5 w-3.5" />{order.customerName}</p>{scope.kind === "platform" && order.store ? <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--codiq-text-muted)]"><Store className="h-3.5 w-3.5" />{order.store.name} · {order.store.merchant?.businessName ?? ""}</p> : null}{order.internalTags?.length ? <span data-testid={`order-tags-${order.orderNumber}`} className="mt-2 flex flex-wrap gap-1">{order.internalTags.map((tag) => <span key={tag} className="rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[#4C5C77]">{tag}</span>)}</span> : null}</div><div className="text-left"><p className="font-bold text-[#253A58]">{formatAmount(order.totalIqd)}</p><p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-[#8794A8]"><CalendarDays className="h-3.5 w-3.5" />{formatDate(order.createdAt)}</p></div></div></button></div></article>)}</div> : <div className="rounded-[24px] bg-[var(--codiq-surface)] p-8 text-center shadow-sm"><PackageOpen className="mx-auto h-7 w-7 text-[#9AA8BB]" /><p className="mt-3 font-bold text-[#465977]">لا توجد طلبات تطابق المرشحات الحالية.</p><p className="mt-1 text-sm text-[#7D8BA0]">{tagFilter ? `لا يحمل أي طلب في المتجر الوسم «${tagFilter}» مع بقية المرشحات — البحث يشمل كل طلبات المتجر لا الصفحة المعروضة.` : "يمكنك مسح المرشحات أو تجربة نطاق تاريخ مختلف."}</p></div>}
    {hasMore ? <div className="flex justify-center"><Button type="button" variant="outline" disabled={loadingMore} onClick={() => void load(cursors, true)} className="rounded-xl border-[#C9D9EE]">{loadingMore ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}تحميل المزيد</Button></div> : null}
  </section>;
}

/**
 * MD-1 «ملاحظات ووسوم داخلية على الطلب» — merchant-side only.
 *
 * Both surfaces read and write exclusively through the merchant order routes
 * (`orders.view` to read, `orders.update` to write). Nothing here is ever
 * rendered on a storefront page, and the payloads that feed the customer order
 * views do not carry notes or tags at all.
 */
function OrderInternalPanel({ scope, orderId }: { scope: Extract<Scope, { kind: "merchant" }>; orderId: string }) {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  // 20-2: nothing caps how many notes a store writes on one order, and this
  // used to read all of them. A long-running dispute is exactly the order that
  // accumulates them.
  const [notesCursor, setNotesCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [draftTag, setDraftTag] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const base = `${basePath(scope)}/${orderId}`;

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const [noteData, tagData] = await Promise.all([api<{ notes: OrderNote[]; nextCursor: string | null }>(`${base}/notes?${query.toString()}`), api<{ tags: string[] }>(`${base}/tags`)]);
      setNotes((current) => (cursor ? [...current, ...noteData.notes] : noteData.notes));
      setNotesCursor(noteData.nextCursor);
      setTags(tagData.tags);
      setFailure(null);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  // Every action clears the previous confirmation first, so a stale «حُفظت
  // الوسوم» can never sit under the result of the action that followed it.
  async function addNote() {
    const body = draftNote.trim();
    if (!body) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await api<{ note: OrderNote }>(`${base}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
      setNotes((current) => [...current, created.note]); setDraftNote(""); setFailure(null); setNotice("أُضيفت الملاحظة الداخلية.");
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function saveTags(next: string[]) {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<{ tags: string[] }>(`${base}/tags`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: next }) });
      setTags(saved.tags); setFailure(null); setNotice("حُفظت الوسوم الداخلية.");
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function addTag() {
    const tag = draftTag.trim().replace(/\s+/g, " ");
    if (!tag) return;
    if (tags.some((existing) => existing.toLocaleLowerCase("ar-IQ") === tag.toLocaleLowerCase("ar-IQ"))) { setDraftTag(""); return; }
    if (tags.length >= ORDER_TAGS_MAX_COUNT) { setFailure(`الحد الأقصى ${ORDER_TAGS_MAX_COUNT} وسوم لكل طلب.`); return; }
    setDraftTag("");
    void saveTags([...tags, tag]);
  }

  return <section data-testid="order-internal-panel" className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-[var(--codiq-accent)]" /><h3 className="text-base font-bold text-[#30435F]">ملاحظات ووسوم داخلية</h3></div>
      <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[10px] font-bold text-[#64748A]">داخلي — لا يظهر للزبون</span>
    </div>
    {failure ? <p className="mt-3 rounded-2xl bg-[var(--codiq-danger-soft)] px-3.5 py-2.5 text-xs font-semibold text-[var(--codiq-danger)]">{failure}</p> : null}
    {notice && !failure ? <p data-testid="order-internal-notice" className="mt-3 rounded-2xl bg-[var(--codiq-success-soft)] px-3.5 py-2.5 text-xs font-semibold text-[var(--codiq-success)]">{notice}</p> : null}

    <div className="mt-4 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
      <div className="flex items-center gap-2"><Tag className="h-3.5 w-3.5 text-[#4C5C77]" /><p className="text-xs font-bold text-[var(--codiq-text-secondary)]">الوسوم ({tags.length}/{ORDER_TAGS_MAX_COUNT})</p></div>
      <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="order-tag-chips">
        {tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-bold text-[#4C5C77]">{tag}<button type="button" disabled={busy} aria-label={`إزالة الوسم ${tag}`} data-testid={`order-tag-remove-${tag}`} onClick={() => void saveTags(tags.filter((entry) => entry !== tag))} className="text-[#8391A4] transition hover:text-[var(--codiq-danger)]"><X className="h-3 w-3" /></button></span>)}
        {!tags.length ? <span className="text-[11px] text-[#8391A4]">لا توجد وسوم بعد.</span> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input value={draftTag} maxLength={ORDER_TAG_MAX_LENGTH} aria-label="وسم داخلي جديد" data-testid="order-tag-input" onChange={(event) => setDraftTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} placeholder={`حتى ${ORDER_TAG_MAX_LENGTH} حرفاً`} className="w-48 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-xs text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
        <Button type="button" size="sm" disabled={busy || !draftTag.trim() || tags.length >= ORDER_TAGS_MAX_COUNT} data-testid="order-tag-add" onClick={addTag} className="rounded-xl bg-[#39507A] hover:bg-[#2E4265]">إضافة وسم</Button>
      </div>
    </div>

    <div className="mt-4">
      {loading ? <p className="text-sm text-[#7A879A]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" />جارٍ تحميل الملاحظات…</p> : <div className="space-y-2.5" data-testid="order-notes-thread">
        {notes.map((note) => <article key={note.id} className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] px-3.5 py-3">
          <p className="text-[11px] font-bold text-[#8592A6]">{note.authorName ? `${note.authorName} · ${labelForActor(note.authorKind)}` : labelForActor(note.authorKind)} · {formatDate(note.createdAt)}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[#40536D]">{note.body}</p>
        </article>)}
        {!notes.length ? <p className="text-sm text-[#7A879A]">لا توجد ملاحظات داخلية على هذا الطلب بعد.</p> : null}
        <LoadMoreButton cursor={notesCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="order-notes-more" />
      </div>}
      <div className="mt-3">
        <textarea value={draftNote} onChange={(event) => setDraftNote(event.target.value)} maxLength={ORDER_NOTE_MAX_LENGTH} rows={2} aria-label="ملاحظة داخلية جديدة" data-testid="order-note-input" placeholder="تظهر لك ولطاقم المتجر فقط." className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#8391A4]">{draftNote.length}/{ORDER_NOTE_MAX_LENGTH}</span>
          <Button type="button" size="sm" disabled={busy || !draftNote.trim()} data-testid="order-note-add" onClick={() => void addNote()} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">{busy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}إضافة ملاحظة</Button>
        </div>
      </div>
    </div>
  </section>;
}

/**
 * WA-1 (ق-131/ق-139) — «التواصل عبر واتساب». The server renders everything:
 * message bodies from the store's templates, the ready-made wa.me links, and
 * the readiness verdict — this panel parses NOTHING (no phone logic client-side).
 * The action is a plain anchor on the user gesture so WhatsApp opens without a
 * popup blocker in the way; the audit POST rides alongside the navigation.
 * Merchant scope only — the platform overview stays a read-only mirror. The
 * button renders for every merchant-scope actor and the SERVER refuses a staff
 * member without orders.update («الواجهة تعرض فقط ولا تقرر»).
 */
type WhatsappPanel = {
  orderId: string;
  recipientPhone: string | null;
  waReady: boolean;
  reason: "no_phone" | "invalid_phone" | null;
  templates: Array<{ key: string; label: string; body: string; waUrl: string | null }>;
  sends: Array<{ id: string; templateKey: string; actorKind: string; actorName: string | null; createdAt: string }>;
};

function defaultWhatsappTemplate(status: OrderStatus): string {
  if (status === "out_for_delivery") return "courierDispatched";
  if (status === "completed" || status === "returned") return "orderCompleted";
  return "orderCreated";
}

function OrderWhatsappPanel({ scope, orderId, orderStatus }: { scope: Extract<Scope, { kind: "merchant" }>; orderId: string; orderStatus: OrderStatus }) {
  const [panel, setPanel] = useState<WhatsappPanel | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>(() => defaultWhatsappTemplate(orderStatus));
  const load = useCallback(async () => {
    try { setPanel(await api<WhatsappPanel>(`${basePath(scope)}/${orderId}/whatsapp`)); }
    catch (error) { setFailure(errorMessage(error)); }
  }, [orderId, scope]);
  useEffect(() => { void load(); }, [load]);

  if (failure) return <section className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm"><Notice kind="error">{failure}</Notice></section>;
  if (!panel) return null;
  const selected = panel.templates.find((template) => template.key === selectedKey) ?? panel.templates[0];

  function recordSend(templateKey: string) {
    // Fire-and-record beside the anchor's own navigation: the server re-renders
    // and stores what IT rendered; a failure surfaces without blocking WhatsApp.
    void api<{ send: WhatsappPanel["sends"][number] }>(`${basePath(scope)}/${orderId}/whatsapp/sends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateKey }),
    }).then(() => load()).catch((error) => setFailure(errorMessage(error)));
  }

  return <section data-testid="order-whatsapp-panel" className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-[var(--codiq-success)]" /><h3 className="text-base font-bold text-[var(--codiq-text)]">التواصل عبر واتساب</h3></div>
      <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-3 py-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]">إرسال يدوي — يفتح تطبيقك برسالة جاهزة</span>
    </div>
    {!panel.waReady ? (
      <p className="mt-4 rounded-2xl bg-[var(--codiq-canvas)] px-4 py-3 text-sm leading-7 text-[var(--codiq-text-secondary)]">
        {panel.reason === "no_phone"
          ? "لا يوجد رقم هاتف مسجل لهذا الطلب — أُنشئ من نقطة البيع أو دون رقم."
          : <>رقم الهاتف المسجل غير صالح للإرسال: <span dir="ltr" className="inline-block font-semibold">{panel.recipientPhone}</span></>}
      </p>
    ) : (
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">المناسبة</span>
          <select data-testid="order-whatsapp-template" value={selected?.key} onChange={(event) => setSelectedKey(event.target.value)} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]">
            {panel.templates.map((template) => <option key={template.key} value={template.key}>{template.label}</option>)}
          </select>
        </label>
        <div className="rounded-2xl bg-[var(--codiq-success-soft)] p-3.5 text-sm leading-7 text-[var(--codiq-success)]">
          <p className="mb-1 text-[11px] font-bold text-[var(--codiq-success)]">نص الرسالة كما سيصل الزبون — إلى <span dir="ltr" className="inline-block">{panel.recipientPhone}</span></p>
          <p className="whitespace-pre-wrap">{selected?.body}</p>
        </div>
        {selected?.waUrl ? (
          <a
            data-testid="order-whatsapp-open"
            href={selected.waUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => recordSend(selected.key)}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--codiq-success)] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[var(--codiq-success)]"
          >
            <MessageSquareText className="h-4 w-4" /> أرسل عبر واتساب
          </a>
        ) : null}
      </div>
    )}
    {panel.sends.length ? (
      <div className="mt-4 border-t border-[var(--codiq-border)] pt-3">
        <p className="text-[11px] font-bold text-[var(--codiq-text-muted)]">آخر الإرسالات</p>
        <ul data-testid="order-whatsapp-sends" className="mt-2 space-y-1.5 text-xs leading-6 text-[var(--codiq-text-secondary)]">
          {panel.sends.slice(0, 5).map((send) => {
            const label = panel.templates.find((template) => template.key === send.templateKey)?.label ?? send.templateKey;
            return <li key={send.id}>«{label}» — {send.actorName ?? (send.actorKind === "staff" ? "موظف المتجر" : "التاجر")} · {formatDate(send.createdAt)}</li>;
          })}
        </ul>
      </div>
    ) : null}
  </section>;
}

/**
 * Marketplace M6 — the market side of one order: the finer delivery step the
 * shopper sees, the shopper's receipt code typed in to mark it delivered, and
 * what the shopper said (cancel reason, rating). The code itself never reaches
 * this screen; the store only types what the shopper hands over.
 */
type MarketOrderView = {
  deliveryStage: string | null; deliveryStageAt: string | null; deliveryStages: { code: string; label: string }[];
  cancelReason: string | null; handover: { used: boolean; attemptsLeft: number } | null;
  rating: { storeStars: number; deliveryStars: number | null; tagLabels: string[]; note: string | null } | null;
};
function OrderMarketPanel({ scope, orderId, orderStatus, fulfilment, onChanged }: { scope: Extract<Scope, { kind: "merchant" }>; orderId: string; orderStatus: OrderStatus; fulfilment?: string; onChanged: () => void }) {
  const base = `${basePath(scope)}/${orderId}`;
  const [view, setView] = useState<MarketOrderView | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const load = useCallback(async () => { try { setView(await api<MarketOrderView>(`${base}/market`)); } catch { setView(null); } }, [base]);
  useEffect(() => { void load(); }, [load, orderStatus]);
  if (!view) return null;
  const pickup = fulfilment === "pickup";
  const stageOpen = !pickup && (orderStatus === "preparation" || orderStatus === "out_for_delivery");
  const handoverOpen = view.handover && !view.handover.used && view.handover.attemptsLeft > 0 && (orderStatus === "out_for_delivery" || (pickup && orderStatus === "preparation"));
  if (!stageOpen && !handoverOpen && !view.cancelReason && !view.rating) return null;
  async function setStage(stage: string) {
    setBusy(true); setMessage(null);
    try { setView(await api<MarketOrderView>(`${base}/delivery-stage`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: stage || null }) })); }
    catch (error) { setMessage({ kind: "error", text: errorMessage(error) }); } finally { setBusy(false); }
  }
  async function confirm(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      await api(`${base}/handover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      setCode(""); setMessage({ kind: "success", text: "تمّ التسليم واكتمل الطلب." }); onChanged();
    } catch (error) { setMessage({ kind: "error", text: errorMessage(error) }); await load(); } finally { setBusy(false); }
  }
  return (
    <section className="space-y-4 rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm" data-testid="order-market-panel">
      <h3 className="text-base font-bold text-[var(--codiq-text)]">السوق</h3>
      {stageOpen ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-semibold text-[var(--codiq-text-secondary)]">مرحلة التوصيل التي يراها الزبون</span>
          <select value={view.deliveryStage ?? ""} disabled={busy} onChange={(event) => void setStage(event.target.value)} className="h-11 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3" data-testid="order-market-stage">
            <option value="">بلا تفصيل</option>
            {view.deliveryStages.map((stage) => <option key={stage.code} value={stage.code}>{stage.label}</option>)}
          </select>
        </label>
      ) : null}
      {handoverOpen ? (
        <form onSubmit={(event) => void confirm(event)} className="space-y-2">
          <p className="text-sm font-semibold text-[var(--codiq-text-secondary)]">{pickup ? "اطلب من الزبون رمز الاستلام وأدخله لتسليم الطلب" : "أدخل رمز الاستلام الذي يعطيه الزبون للمندوب"}</p>
          <div className="flex gap-2">
            <input value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} inputMode="numeric" dir="ltr" placeholder="0000" aria-label="رمز الاستلام" className="h-11 w-32 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-center text-lg font-bold tracking-[0.3em]" data-testid="order-market-code" />
            <Button type="submit" disabled={busy || code.length !== 4} data-testid="order-market-handover">تأكيد التسليم</Button>
          </div>
          <p className="text-xs text-[var(--codiq-text-muted)]">المحاولات المتبقّية: {view.handover?.attemptsLeft}</p>
        </form>
      ) : null}
      {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}
      {view.cancelReason ? <p className="text-sm text-[var(--codiq-text-secondary)]" data-testid="order-market-cancel-reason">سبب إلغاء الزبون: <b>{view.cancelReason}</b></p> : null}
      {view.rating ? (
        <div className="space-y-1 text-sm" data-testid="order-market-rating">
          <p className="font-semibold text-[var(--codiq-text)]">تقييم الزبون: المتجر {view.rating.storeStars}/5{view.rating.deliveryStars ? `، التوصيل ${view.rating.deliveryStars}/5` : ""}</p>
          {view.rating.tagLabels.length ? <p className="text-xs text-[var(--codiq-text-secondary)]">{view.rating.tagLabels.join("، ")}</p> : null}
          {view.rating.note ? <p className="text-xs text-[var(--codiq-text)]">{view.rating.note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function OrderDetail({ scope, mode, navigate }: { scope: Scope; mode: DetailMode; navigate: (path: string) => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // ق-246: the handover facts, typed beside the «قيد التوصيل» button — the one
  // moment the merchant knows which courier has the parcel.
  const [courierName, setCourierName] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [courierSuggestions, setCourierSuggestions] = useState<string[]>([]);
  const [pendingDelivery, setPendingDelivery] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<OrderStatus | null>(null);
  const [pendingReview, setPendingReview] = useState<"approved" | "rejected" | null>(null);
  const load = useCallback(async () => { setLoading(true); try { const result = await api<{ order: Order }>(`${basePath(scope)}/${mode.orderId}`); setOrder(result.order); setFailure(null); } catch (error) { setOrder(null); setFailure(errorMessage(error)); } finally { setLoading(false); } }, [mode.orderId, scope]);
  useEffect(() => { void load(); }, [load]);

  async function reviewPrescription(decision: "approved" | "rejected") {
    if (scope.kind !== "merchant" || !order) return;
    setPendingReview(decision);
    try {
      await api(`${basePath(scope)}/${order.id}/prescription/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      await load();
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setPendingReview(null); }
  }

  // ق-246: a correction after the fact — the courier's real name, a waybill
  // that arrived later. Refused by the server before the handover stage.
  async function saveDelivery() {
    if (scope.kind !== "merchant" || !order) return;
    setPendingDelivery(true);
    try {
      const result = await api<{ order: Order }>(`${basePath(scope)}/${order.id}/delivery`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ courierName: courierName.trim() || null, trackingNumber: trackingNumber.trim() || null, expectedVersion: order.version }) });
      setOrder((current) => (current ? { ...current, ...result.order } : current)); setFailure(null);
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof ApiError && error.code === "ORDER_VERSION_CONFLICT") await load();
      setFailure(message);
    } finally { setPendingDelivery(false); }
  }
  useEffect(() => {
    if (scope.kind !== "merchant") return;
    api<{ couriers: string[] }>(`${basePath(scope)}/couriers`).then((result) => setCourierSuggestions(result.couriers)).catch(() => { /* suggestions only */ });
  }, [scope]);
  useEffect(() => { if (order) { setCourierName(order.courierName ?? ""); setTrackingNumber(order.trackingNumber ?? ""); } }, [order?.id, order?.courierName, order?.trackingNumber]);

  async function changeStatus(toStatus: OrderStatus) {
    if (scope.kind !== "merchant" || !order) return;
    setPendingStatus(toStatus);
    try {
      const result = await api<{ order: Order }>(`${basePath(scope)}/${order.id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        toStatus, expectedVersion: order.version, note: note.trim() || undefined,
        // ق-246: only the handover edge carries the courier; every other click sends nothing.
        ...(toStatus === "out_for_delivery" ? { courierName: courierName.trim() || undefined, trackingNumber: trackingNumber.trim() || undefined } : {}),
      }) });
      setOrder(result.order); setNote(""); setFailure(null);
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof ApiError && (error.code === "ORDER_VERSION_CONFLICT" || error.code === "INVALID_ORDER_TRANSITION")) await load();
      setFailure(message);
    }
    finally { setPendingStatus(null); }
  }

  if (loading) return <LoadingCard text="جارٍ تحميل تفاصيل الطلب…" />;
  if (!order) return <section className="space-y-4"><Notice kind="error">{failure ?? "تعذر تحميل الطلب."}</Notice><Button type="button" variant="outline" onClick={() => navigate(mode.backPath)} className="rounded-xl"><ArrowRight className="ml-2 h-4 w-4" />العودة إلى الطلبات</Button></section>;
  const allowedTransitions = scope.kind === "merchant" ? transitions[order.status] : [];
  // Phase 20B-1: the server refuses new→processing until the prescription is
  // approved (422 PRESCRIPTION_NOT_APPROVED); the button mirrors that with a
  // disabled state and an explicit reason.
  const prescriptionGateBlocked = order.status === "new" && !!order.prescriptionStatus && order.prescriptionStatus !== "approved";
  const prescriptionHasFile = order.prescriptionStatus === "pending_review" || order.prescriptionStatus === "approved" || order.prescriptionStatus === "rejected";
  return <section className="space-y-5" dir="rtl">
    {failure ? <Notice kind="error"><div className="flex flex-wrap items-center justify-between gap-3"><span>{failure}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()} className="border-[#E3B8B4] text-[#A33B35]">تحديث الحالة</Button></div></Notice> : null}
    <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><Button type="button" variant="ghost" size="sm" onClick={() => navigate(mode.backPath)} className="-mr-2 mb-3 text-[#54708F]"><ArrowRight className="ml-1 h-4 w-4" />العودة إلى الطلبات</Button><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-bold text-[#263650]">{order.orderNumber}</h2><StatusBadge status={order.status} />{order.prescriptionStatus ? <span data-testid="order-prescription-badge" className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${prescriptionBadges[order.prescriptionStatus].className}`}>{prescriptionBadges[order.prescriptionStatus].label}</span> : null}</div><p className="mt-2 text-sm text-[var(--codiq-text-muted)]">أنشئ في {formatDate(order.createdAt)} · الإصدار التشغيلي {order.version}</p></div><div className="rounded-2xl bg-[var(--codiq-canvas)] px-4 py-3 text-left"><p className="text-[11px] font-bold text-[#8391A4]">إجمالي الطلب</p><p className="mt-1 font-bold text-[#243855]">{formatAmount(order.totalIqd)}</p></div></div>
      {scope.kind === "merchant" ? <div className="mt-6 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-[var(--codiq-accent)]" /><h3 className="text-sm font-bold text-[#344762]">تحديث حالة الطلب</h3></div>{allowedTransitions.length ? <><p className="mt-1 text-xs leading-6 text-[var(--codiq-text-muted)]">تظهر الإجراءات المسموح بها لحالة الطلب الحالية فقط. يُمنع النقر المتكرر أثناء الحفظ.</p>{allowedTransitions.includes("out_for_delivery") || (order.handedOverAt && order.status !== "cancelled" && order.status !== "rejected") ? <div data-testid="delivery-fields" className="mt-4 grid gap-3 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-muted)]">شركة التوصيل</span><input list="courier-suggestions" value={courierName} onChange={(event) => setCourierName(event.target.value)} maxLength={120} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" placeholder="مثال: شركة الفهد" /><datalist id="courier-suggestions">{courierSuggestions.map((name) => <option key={name} value={name} />)}</datalist></label><label className="block"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-muted)]">رقم البوليصة</span><input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} maxLength={120} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" placeholder="اختياري" /></label>{order.handedOverAt ? <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--codiq-text-muted)]"><span>سُلِّم للناقل {new Date(order.handedOverAt).toLocaleString("ar-IQ")}{order.codCollectedAt ? ` · استُلم نقده ${new Date(order.codCollectedAt).toLocaleString("ar-IQ")}` : ""}</span><Button type="button" variant="outline" size="sm" disabled={pendingDelivery} onClick={() => void saveDelivery()} className="rounded-xl" data-testid="delivery-save">{pendingDelivery ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}حفظ بيانات التوصيل</Button></div> : null}</div> : null}<label className="mt-4 block"><span className="mb-1.5 block text-xs font-bold text-[#60708A]">ملاحظة اختيارية</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" placeholder="تظهر في سجل الحالة." /></label><div className="mt-4 flex flex-wrap gap-2">{allowedTransitions.map((target) => { const blockedByPrescription = target === "processing" && prescriptionGateBlocked; return <Button key={target} type="button" disabled={pendingStatus !== null || blockedByPrescription} title={blockedByPrescription ? "لا يمكن بدء المعالجة قبل اعتماد الوصفة الطبية." : undefined} onClick={() => void changeStatus(target)} className={`rounded-xl ${target === "cancelled" || target === "rejected" || target === "returned" ? "bg-[#80584A] hover:bg-[#6E493E]" : "bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"}`}>{pendingStatus === target ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : null}نقل إلى «{statuses[target].label}»</Button>; })}</div>{prescriptionGateBlocked ? <p data-testid="prescription-gate-reason" className="mt-3 rounded-xl bg-[var(--codiq-warning-soft)] px-3 py-2 text-xs leading-6 text-[#A76B13]">«قيد المعالجة» معطّل: {order.prescriptionStatus === "pending_upload" ? "بانتظار رفع الزبون للوصفة الطبية." : order.prescriptionStatus === "pending_review" ? "الوصفة مرفوعة وتحتاج اعتمادك أدناه." : "الوصفة مرفوضة وبانتظار رفع بديل من الزبون."} الإلغاء أو الرفض متاحان دون اعتماد.</p> : null}</> : <Notice kind="info"><div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />هذه حالة نهائية؛ لا توجد انتقالات إضافية.</div></Notice>}</div> : <div className="mt-6 rounded-[20px] border border-[#D9E6F5] bg-[var(--codiq-canvas)] p-4 text-sm leading-7 text-[#35577F]"><div className="flex items-center gap-2 font-bold"><ShieldAlert className="h-4 w-4" />إشراف للقراءة فقط</div><p className="mt-1">لا تتيح لوحة مالك المنصة تغيير حالة الطلب أو إضافة حدث جديد.</p></div>}
    </div>
    {order.prescriptionStatus ? <section data-testid="prescription-review-panel" className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-[#6955B7]" /><h3 className="text-base font-bold text-[#30435F]">الوصفة الطبية</h3><span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${prescriptionBadges[order.prescriptionStatus].className}`}>{prescriptionBadges[order.prescriptionStatus].label}</span></div>
        {scope.kind === "merchant" && order.prescriptionStatus === "pending_review" ? <div className="flex gap-2">
          <Button type="button" size="sm" disabled={pendingReview !== null} data-testid="prescription-approve" onClick={() => void reviewPrescription("approved")} className="rounded-xl bg-[#1F7A4D] hover:bg-[#186340]">{pendingReview === "approved" ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="ml-1 h-3.5 w-3.5" />}اعتماد الوصفة</Button>
          <Button type="button" size="sm" disabled={pendingReview !== null} data-testid="prescription-reject" onClick={() => void reviewPrescription("rejected")} className="rounded-xl bg-[#A8433A] hover:bg-[#8E3730]">{pendingReview === "rejected" ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <XCircle className="ml-1 h-3.5 w-3.5" />}رفض الوصفة</Button>
        </div> : null}
      </div>
      {prescriptionHasFile && scope.kind === "merchant" ? <img src={`${basePath(scope)}/${order.id}/prescription`} alt="الوصفة الطبية المرفوعة" className="mt-4 max-h-72 rounded-2xl border border-[var(--codiq-border)] object-contain" /> : null}
      {prescriptionHasFile && scope.kind === "platform" ? <p className="mt-3 text-sm leading-6 text-[var(--codiq-text-muted)]">ملف الوصفة يُعرض لتاجر المتجر وطاقمه حصراً — خصوصية بيانات طبية.</p> : null}
      {!prescriptionHasFile ? <p className="mt-3 text-sm leading-6 text-[var(--codiq-text-muted)]">لم يرفع الزبون الوصفة بعد؛ يظهر الملف هنا فور رفعه.</p> : null}
      {order.prescriptionStatus === "rejected" ? <p className="mt-3 text-xs leading-6 text-[#B52D46]">الوصفة الأخيرة مرفوضة — يمكن للزبون رفع وصفة بديلة من صفحة طلبه.</p> : null}
    </section> : null}
    {/* MD-1: internal notes + tags. Merchant scope only — the platform overview
        stays a read-only mirror and never carries the merchant's private labels. */}
    {scope.kind === "merchant" ? <><OrderMarketPanel scope={scope} orderId={order.id} orderStatus={order.status} fulfilment={order.fulfilment} onChanged={() => void load()} /><OrderInternalPanel scope={scope} orderId={order.id} /></> : null}
    {/* WA-1 (ق-131/ق-139): merchant scope only, like the notes. */}
    {scope.kind === "merchant" ? <OrderWhatsappPanel scope={scope} orderId={order.id} orderStatus={order.status} /> : null}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]"><div className="space-y-5"><section className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6"><h3 className="text-base font-bold text-[#30435F]">بنود الطلب</h3><div className="mt-4 divide-y divide-[var(--codiq-border)]">{order.items?.map((item) => <div key={item.id} className="flex items-start justify-between gap-3 py-3"><div><p className="font-semibold text-[#344761]">{item.productName}</p><p className="mt-1 text-xs text-[#8290A5]">{item.sku ? `SKU: ${item.sku} · ` : ""}الكمية: {item.quantity} × {formatAmount(item.unitPriceIqd)}</p>{item.addons?.length ? <p className="mt-1 text-xs font-semibold text-[var(--codiq-accent)]" data-testid="order-line-addons">+ {item.addons.map((addon) => `${addon.name} (${formatAmount(addon.priceIqd)})`).join("، ")}</p> : null}</div><p className="shrink-0 font-bold text-[#344761]">{formatAmount(item.lineTotalIqd)}</p></div>)}{!order.items?.length ? <p className="py-3 text-sm text-[#7A879A]">لا توجد بنود مسجلة لهذا الطلب.</p> : null}</div><div className="mt-4 space-y-2 border-t border-[var(--codiq-border)] pt-4 text-sm"><div className="flex justify-between text-[var(--codiq-text-muted)]"><span>المجموع الفرعي</span><span>{formatAmount(order.subtotalIqd)}</span></div><div className="flex justify-between text-[var(--codiq-text-muted)]"><span>{order.fulfilment === "pickup" ? "استلام من المتجر" : "التوصيل"}</span><span>{formatAmount(order.deliveryFeeIqd)}</span></div><div className="flex justify-between text-[var(--codiq-text-muted)]"><span>الخصم{order.couponCode ? ` — كوبون ${order.couponCode}` : ""}</span><span>{formatAmount(order.discountIqd)}</span></div>{order.loyaltyDiscountIqd > 0 ? <div className="flex justify-between text-[var(--codiq-text-muted)]"><span>خصم النقاط{order.loyaltyPointsSpent ? ` — ${order.loyaltyPointsSpent} نقطة` : ""}</span><span>{formatAmount(order.loyaltyDiscountIqd)}</span></div> : null}{order.platformDiscountIqd ? <div className="flex justify-between text-[var(--codiq-text-muted)]" data-testid="order-platform-discount"><span>كوبون السوق — تتحمّله المنصّة وتدفعه لك</span><span>{formatAmount(order.platformDiscountIqd)}</span></div> : null}<div className="flex justify-between pt-1 font-bold text-[#283C59]"><span>الإجمالي</span><span>{formatAmount(order.totalIqd)}</span></div></div></section><section className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6"><h3 className="text-base font-bold text-[#30435F]">سجل الحالة</h3><div className="mt-5 space-y-0">{order.statusEvents?.map((event, index) => <div key={event.id} className="relative flex gap-3 pb-5 last:pb-0"><div className="relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><ClipboardList className="h-3.5 w-3.5" /></div>{index < (order.statusEvents?.length ?? 0) - 1 ? <div className="absolute right-[13px] top-7 h-[calc(100%-16px)] w-px bg-[var(--codiq-border-strong)]" /> : null}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-[#364963]">{event.fromStatus ? `${statuses[event.fromStatus].label} ← ` : ""}{statuses[event.toStatus].label}</span><span className="text-[11px] text-[#8592A6]">{labelForActor(event.actorKind)} · {formatDate(event.createdAt)}</span></div>{event.note ? <p className="mt-1 text-sm leading-6 text-[var(--codiq-text-muted)]">{event.note}</p> : null}</div></div>)}{!order.statusEvents?.length ? <p className="text-sm text-[#7A879A]">لا توجد أحداث حالة مسجلة بعد.</p> : null}</div></section></div>
      <aside className="space-y-5"><section className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm"><h3 className="text-base font-bold text-[#30435F]">بيانات المستلم</h3><div className="mt-4 space-y-3 text-sm"><p><span className="block text-[11px] font-bold text-[#8995A8]">الاسم</span><span className="mt-1 block font-semibold text-[#40536D]">{order.customerName}</span></p>{order.customerEmail ? <p><span className="block text-[11px] font-bold text-[#8995A8]">البريد</span><span className="mt-1 block font-semibold text-[#40536D]">{order.customerEmail}</span></p> : null}{order.recipientPhone ? <p><span className="block text-[11px] font-bold text-[#8995A8]">الهاتف</span><span className="mt-1 block font-semibold text-[#40536D]">{order.recipientPhone}</span></p> : null}<p data-testid="order-payment"><span className="block text-[11px] font-bold text-[var(--codiq-text-muted)]">الدفع</span><span className="mt-1 block font-semibold text-[var(--codiq-text)]">{PAYMENT_METHOD_LABEL[order.paymentMethodCode ?? ""] ?? order.paymentMethodCode ?? "—"}{order.paymentStatus === "awaiting_transfer" ? <span className="mr-2 rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-warning)]">بانتظار التحويل</span> : order.paymentStatus === "awaiting_payment" ? <span className="mr-2 rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-warning)]" data-testid="order-awaiting-payment">بانتظار الدفع الإلكترونيّ — لا تجهّزه بعد</span> : order.paymentStatus === "paid" ? <span className="mr-2 rounded-full bg-[var(--codiq-success-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-success)]">مدفوع</span> : order.paymentStatus === "instalments" ? <span className="mr-2 rounded-full bg-[var(--codiq-success-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-success)]">بالأقساط — اجمع التوصيل فقط</span> : order.paymentStatus === "refunded" ? <span className="mr-2 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-text-secondary)]">أُعيد المبلغ</span> : null}</span></p>{order.customerNote ? <p data-testid="order-customer-note" className="rounded-2xl bg-[#FFFBF4] p-3.5"><span className="block text-[11px] font-bold text-[#A9741F]">ملاحظة الزبون</span><span className="mt-1 block whitespace-pre-wrap font-semibold leading-6 text-[#7A5514]">{order.customerNote}</span></p> : null}{order.shippingGovernorate || order.shippingAddressLine1 ? <p><span className="block text-[11px] font-bold text-[#8995A8]">عنوان التسليم</span><span className="mt-1 block font-semibold leading-6 text-[#40536D]">{[order.shippingGovernorate, order.shippingAddressLine1, order.shippingAddressLine2].filter(Boolean).join("، ")}</span></p> : <p className="text-xs leading-6 text-[#8491A5]">لا توجد بيانات عنوان مسجلة لهذا الطلب.</p>}</div></section><section className="rounded-[24px] bg-[var(--codiq-surface)] p-5 shadow-sm"><h3 className="text-base font-bold text-[#30435F]">بيانات تشغيلية</h3><div className="mt-4 space-y-3 text-sm"><p><span className="block text-[11px] font-bold text-[#8995A8]">حالة الدفع</span><span className="mt-1 block font-semibold text-[#40536D]">{order.paymentStatus}</span></p><p><span className="block text-[11px] font-bold text-[#8995A8]">مصدر الطلب</span><span className="mt-1 block font-semibold text-[#40536D]">{order.source}</span></p>{scope.kind === "platform" && order.store ? <><p><span className="block text-[11px] font-bold text-[#8995A8]">المتجر</span><span className="mt-1 block font-semibold text-[#40536D]">{order.store.name}</span></p><p><span className="block text-[11px] font-bold text-[#8995A8]">التاجر</span><span className="mt-1 block font-semibold text-[#40536D]">{order.store.merchant?.businessName ?? "—"}</span></p></> : null}</div></section></aside>
    </div>
  </section>;
}

// ق-209: the method the shopper picked, named the way the payments screen names it.
const PAYMENT_METHOD_LABEL: Record<string, string> = { cod: "الدفع عند الاستلام", zaincash: "زين كاش", asiahawala: "آسيا حوالة", fib: "FIB", cash: "نقداً (الكاشير)", legacy: "الدفع عند الاستلام", market_card: "بطاقة إلكترونيّة (السوق)", market_instalments: "أقساط (السوق) — التوصيل نقداً" };

export function OrderWorkspace({ scope, mode, navigate }: { scope: Scope; mode: Mode; navigate: (path: string) => void }) {
  if (scope.kind === "merchant" && !scope.storeSlug) return <Notice kind="error"><div className="flex items-center gap-2"><CircleAlert className="h-4 w-4" />اختر متجراً عبر مسار لوحة التاجر المقيد بـ`store-slug` قبل قراءة الطلبات.</div></Notice>;
  return mode.kind === "detail" ? <OrderDetail scope={scope} mode={mode} navigate={navigate} /> : <OrderList scope={scope} mode={mode} navigate={navigate} />;
}
