/**
 * PG-2 (plan §4) — the ONE delete confirmation sheet for the four entities.
 *
 * Three rules shape everything below, and none of them is negotiable.
 *
 * 1. It tells the truth BEFORE the act. Every number on this sheet is a live
 *    count read from `GET …/trash/preview/:entityType/:id` — never a guess and
 *    never a client-side constant, including the retention window itself. When
 *    that read fails, the sheet drops the numbers and says the qualitative
 *    truth instead; it never falls back to a made-up figure (ق-10).
 * 2. A 409 is answered INSIDE the sheet, not by a toast. The merchant asked for
 *    «اختفِ من متجري», not «امحُ من قاعدة البيانات» — so when the server refuses
 *    the removal, the sheet offers the thing he actually wanted, one click away,
 *    without closing and losing his place.
 * 3. Masculine address throughout (ق-96). These strings are the source text for
 *    the English and Sorani catalogues in P27-9, so a slip here is paid three times.
 *
 * `window.confirm` is what this replaces. That dialog could not state a single
 * consequence, could not carry a «تراجع», and could not answer a 409 at all.
 */
import { CircleAlert, EyeOff, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
// The house pattern for an irreversible-action confirmation (OrderWorkspace's
// bulk bar uses the same primitive). Radix brings the focus trap, the scroll
// lock, the portal and Escape — all of which a hand-rolled overlay drops, and
// the focus trap is the one a keyboard user actually notices.
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Shared vocabulary — imported by TrashBin.tsx and ActivityLog.tsx so the four
// entity names, the number formatting and the API shapes exist in ONE place.
// ---------------------------------------------------------------------------

export type TrashEntityType = "product" | "product_category" | "coupon" | "staff_membership";

export const ENTITY_NOUN: Record<TrashEntityType, string> = {
  product: "المنتج",
  product_category: "التصنيف",
  coupon: "الكوبون",
  staff_membership: "عضوية الموظف",
};

export const ENTITY_TAB_LABEL: Record<TrashEntityType, string> = {
  product: "المنتجات",
  product_category: "التصنيفات",
  coupon: "الكوبونات",
  staff_membership: "الفريق",
};

/** Arabic-Indic digits, the same numbering system the rest of the merchant UI uses. */
const arabicDigits = new Intl.NumberFormat("ar-IQ");
export function ar(value: number): string {
  return arabicDigits.format(value);
}

/**
 * Correct Arabic agreement for a counted noun — «حركة واحدة» · «حركتان» ·
 * «٣ حركات» · «١٤ حركة». Getting this wrong is the kind of detail that makes a
 * platform read as machine-translated, and ق-34 asks for it explicitly.
 */
export interface CountedForms { one: string; two: string; few: string; many: string }
export function counted(value: number, forms: CountedForms): string {
  if (value === 1) return forms.one;
  if (value === 2) return forms.two;
  const rest = value % 100;
  if (rest >= 3 && rest <= 10) return `${ar(value)} ${forms.few}`;
  return `${ar(value)} ${forms.many}`;
}

// ع-7 — the DUAL is written in its genitive form («يومين» not «يومان») because
// every consumer below places it after a preposition: «بعد …» · «مباع في …» ·
// «استُخدم في …» · «فيه …» · «تحته …» · «تُزال معه …» · «له …». Getting this wrong
// is the one visible break in a helper written precisely to prevent it, and
// Home.tsx already had the precedent right («متجرين» · «طلبين شهرياً»).
export const DAY_FORMS: CountedForms = { one: "يوم واحد", two: "يومين", few: "أيام", many: "يوماً" };
const MOVEMENT_FORMS: CountedForms = { one: "حركة واحدة", two: "حركتين", few: "حركات", many: "حركة" };
const ORDER_FORMS: CountedForms = { one: "طلب واحد", two: "طلبين", few: "طلبات", many: "طلباً" };
const PRODUCT_FORMS: CountedForms = { one: "منتج واحد", two: "منتجين", few: "منتجات", many: "منتجاً" };
const CATEGORY_FORMS: CountedForms = { one: "تصنيف فرعي واحد", two: "تصنيفين فرعيين", few: "تصنيفات فرعية", many: "تصنيفاً فرعياً" };
const VARIANT_FORMS: CountedForms = { one: "متغيّر واحد", two: "متغيّرين", few: "متغيّرات", many: "متغيّراً" };
const SESSION_FORMS: CountedForms = { one: "جلسة واحدة", two: "جلستين", few: "جلسات", many: "جلسة" };

/** Whole days left before the purge sweep may hard-delete a row. */
export function daysUntil(iso: string): number {
  const remaining = new Date(iso).valueOf() - Date.now();
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}

export function merchantStoreBase(storeSlug: string): string {
  return `/api/merchant/stores/${encodeURIComponent(storeSlug)}`;
}

/** A server error carried whole: the code and the extra keys drive the UI branches. */
export class TrashApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function trashApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json", ...(init.headers ?? {}) } } : {}),
  });
  const payload = (await response.json().catch(() => null)) as { error?: Record<string, unknown> } | null;
  if (!response.ok) {
    const error = payload?.error ?? {};
    const { code, message, ...rest } = error as { code?: string; message?: string };
    throw new TrashApiError(response.status, code ?? "REQUEST_FAILED", message ?? "تعذر إتمام العملية.", rest);
  }
  return payload as T;
}

export interface SoftDeleteResponse {
  id: string;
  entityType: TrashEntityType;
  deletedAt: string;
  purgeAt: string;
  /** ع-1 — the server's own prediction: a RESTRICT key already holds this row,
   *  so the purge will refuse it and the undo bar must not promise otherwise. */
  keptForRecords: boolean;
  keptReason: string | null;
}

interface DeletePreview {
  entityType: TrashEntityType;
  id: string;
  label: string;
  secondary: string | null;
  retentionDays: number;
  effects: Record<string, number | string | boolean | null>;
}

// ---------------------------------------------------------------------------
// Endpoint table — the whole client-side contract in one readable block.
// ---------------------------------------------------------------------------

type Endpoints = { remove: string; restore: string; deactivate: string | null };

/**
 * EVERY restore goes through `…/trash/:entityType/:id/restore`, never through
 * the per-entity restore routes that also exist.
 *
 * Coupons and memberships have their own restore endpoints guarded by
 * `settings.manage` and `team.manage`. Using them here would mean a merchant who
 * ticks «منع» on «الاستعادة من سلة المحذوفات» for a manager — a control THIS
 * branch put on the team screen — watches that manager keep restoring coupons
 * and removed colleagues anyway. A permission that can be revoked without
 * anything changing is worse than no permission at all, so the bin and its undo
 * both ride `catalog.trash.restore` for all four entities.
 */
export function endpointsFor(storeSlug: string, entityType: TrashEntityType, id: string): Endpoints {
  const base = merchantStoreBase(storeSlug);
  const encoded = encodeURIComponent(id);
  const restore = `${base}/trash/${entityType}/${encoded}/restore`;
  if (entityType === "product") return { remove: `${base}/catalog/products/${encoded}`, restore, deactivate: `${base}/catalog/products/${encoded}` };
  // A category has no `is_active` column at all, so «أخفِه بدلاً من ذلك» does not
  // exist for it — the sheet must not offer a button that cannot work.
  if (entityType === "product_category") return { remove: `${base}/catalog/categories/${encoded}`, restore, deactivate: null };
  if (entityType === "coupon") return { remove: `${base}/marketing/coupons/${encoded}`, restore, deactivate: `${base}/marketing/coupons/${encoded}` };
  return { remove: `${base}/team/${encoded}`, restore, deactivate: `${base}/team/${encoded}` };
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface DeleteTarget {
  entityType: TrashEntityType;
  id: string;
  /** Name shown to the merchant; the sheet never re-derives it from the server. */
  label: string;
  secondary?: string | null;
}

export interface DeleteConfirmSheetProps {
  storeSlug: string;
  target: DeleteTarget;
  onClose: () => void;
  /** Called after a successful removal, with the server body the caller needs for «تراجع». */
  onDeleted: (result: SoftDeleteResponse) => void;
  /** Called after the merchant chose «أخفِه بدلاً من ذلك» instead of removing. */
  onDeactivated?: () => void;
}

const HEADINGS: Record<TrashEntityType, { title: string; confirm: string }> = {
  product: { title: "إزالة منتج", confirm: "أزِل المنتج" },
  product_category: { title: "إزالة تصنيف", confirm: "أزِل التصنيف" },
  coupon: { title: "إزالة كوبون", confirm: "أزِل الكوبون" },
  staff_membership: { title: "إزالة من الفريق", confirm: "أزِله من الفريق" },
};

/**
 * Only the product can reach the «أخفِه بدلاً من ذلك» branch: `hint: "deactivate"`
 * is emitted by PRODUCT_IN_ACTIVE_CART and PRODUCT_HAS_ACTIVE_RESERVATION, and by
 * the foreign-key handler. Coupon removal has no guard at all, and a membership
 * is refused with LAST_TEAM_MANAGER, which carries no hint — deactivating the
 * last manager would lock the store out just as thoroughly, so offering it there
 * would be offering a worse version of the thing that was just refused.
 * Labels for the other three would be strings that can never render.
 */
const DEACTIVATE_LABEL: Partial<Record<TrashEntityType, string>> = {
  product: "أخفِه من متجرك بدلاً من ذلك",
};

/**
 * Server error codes that are about the ACTOR, not the entity. Their messages
 * are English developer text; an Arabic RTL sheet must not print them raw.
 */
const ACCESS_MESSAGES: Record<string, string> = {
  STAFF_PERMISSION_DENIED: "هذه الجلسة لا تملك صلاحية تنفيذ هذا الإجراء. اطلبها من مدير المتجر.",
  IDENTITY_BOUNDARY_DENIED: "هذه الجلسة لا تملك صلاحية تنفيذ هذا الإجراء في هذا المتجر.",
  STORE_BOUNDARY_DENIED: "هذه الجلسة لا تملك صلاحية تنفيذ هذا الإجراء في هذا المتجر.",
  RESOURCE_NOT_FOUND: "لم يعد هذا العنصر موجوداً — حدِّث الصفحة.",
  // ع-8: the category is the only entity that answers with its own code, so it
  // was the only one that printed «The requested category was not found in this
  // store.» into an Arabic panel — with the full stop jumping to the wrong end.
  CATEGORY_NOT_FOUND: "لم يعد هذا التصنيف موجوداً — حدِّث الصفحة.",
};

/** The message to show for a server error: translated when it is about access. */
export function readableError(error: TrashApiError): string {
  return ACCESS_MESSAGES[error.code] ?? error.message;
}

function number(effects: DeletePreview["effects"], key: string): number | null {
  const value = effects[key];
  return typeof value === "number" ? value : null;
}

/** The consequence lines. Every number here came from the server or is absent. */
function consequenceLines(target: DeleteTarget, preview: DeletePreview | null): string[] {
  const lines: string[] = [];
  const effects = preview?.effects ?? {};
  const window = preview ? counted(preview.retentionDays, DAY_FORMS) : null;
  const restoreLine = window
    ? `تستطيع استعادته من سلة المحذوفات خلال ${window}.`
    : "تستطيع استعادته من سلة المحذوفات قبل التنقية النهائية.";

  if (target.entityType === "product") {
    lines.push(`سيختفي «${target.label}» من متجرك فوراً، ولن يظهر للزبائن.`);
    lines.push(restoreLine);
    const movements = number(effects, "inventoryMovements");
    if (movements !== null) {
      lines.push(movements > 0
        ? `سجل حركة المخزون (${counted(movements, MOVEMENT_FORMS)}) يُحفظ دائماً، حتى بعد التنقية النهائية.`
        : "لا توجد حركات مخزون مسجّلة على هذا المنتج بعد.");
    } else {
      lines.push("سجل حركة المخزون يُحفظ دائماً، حتى بعد التنقية النهائية.");
    }
    // Two sentences from two different facts, because they answer two questions:
    // «هل بِعتُه؟» excludes cancelled orders (ع-6), while «هل يبقى محفوظاً؟» is the
    // row's fate under a RESTRICT key and counts them. A reader without
    // `orders.view` gets the fate without the figure (ع-2) — the promise ق-97
    // requires, with no sales data attached.
    const soldOrders = number(effects, "soldOrders");
    const keptForRecords = effects.keptForRecords === true;
    if (soldOrders && soldOrders > 0) lines.push(`هذا المنتج مباع في ${counted(soldOrders, ORDER_FORMS)}.`);
    if (keptForRecords) lines.push("يبقى صفّه محفوظاً لسجلاتك ولا يُحذف نهائياً بعد المدة.");
    // The two conditions that will REFUSE this removal. The server already sends
    // them, so saying nothing would mean letting the merchant discover after the
    // click what the sheet could have told him before it.
    const inCart = number(effects, "liveCartItems");
    if (inCart && inCart > 0) lines.push("هذا المنتج في سلة زبون نشطة الآن، فستُرفض الإزالة حتى تنتهي تلك السلة — ويبقى «الإخفاء» متاحاً.");
    const reserved = number(effects, "activeReservations");
    if (reserved && reserved > 0) lines.push("عليه حجز مخزون لطلب قائم الآن، فستُرفض الإزالة حتى يُغلق ذلك الطلب — ويبقى «الإخفاء» متاحاً.");
    const variants = number(effects, "variants");
    if (variants && variants > 1) lines.push(`تُزال معه ${counted(variants, VARIANT_FORMS)}، وتعود كلها عند الاستعادة.`);
    // Plan §6.6 obliges the UI to DECLARE this asymmetry rather than let the
    // merchant discover it from a quota that did not move.
    lines.push("تتحرر حصة المنتجات في خطتك فوراً، أما مساحة صوره فتبقى محسوبة حتى التنقية النهائية.");
    return lines;
  }

  if (target.entityType === "product_category") {
    lines.push(`سيختفي التصنيف «${target.label}» من متجرك ومن تصفح الزبائن.`);
    const liveProducts = number(effects, "liveProducts");
    const liveChildren = number(effects, "liveChildren");
    if (liveProducts && liveProducts > 0) lines.push(`فيه ${counted(liveProducts, PRODUCT_FORMS)} ما زال حيّاً — انقلها إلى تصنيف آخر أولاً، وإلا رُفض الحذف.`);
    if (liveChildren && liveChildren > 0) lines.push(`تحته ${counted(liveChildren, CATEGORY_FORMS)} — احذفها أو انقلها أولاً، وإلا رُفض الحذف.`);
    if (!liveProducts && !liveChildren) lines.push("لا منتجات ولا تصنيفات فرعية تحته الآن، فحذفه لا يمسّ شيئاً آخر.");
    lines.push(restoreLine);
    lines.push("وإن استعدت لاحقاً منتجاً كان مصنَّفاً تحته، عاد التصنيف معه تلقائياً.");
    return lines;
  }

  if (target.entityType === "coupon") {
    lines.push(`لن يعمل الرمز «${target.label}» في متجرك بعد الآن.`);
    const redemptions = number(effects, "redemptions");
    if (redemptions !== null) {
      lines.push(redemptions > 0
        ? `استُخدم في ${counted(redemptions, ORDER_FORMS)}، وسجل استخداماته يبقى محفوظاً كما هو.`
        : "لم يُستخدم في أي طلب بعد.");
    }
    if (effects.keptForRecords === true) lines.push("يبقى سجلّه محفوظاً لسجلاتك ولا يُحذف نهائياً بعد المدة.");
    const endsAt = typeof effects.endsAt === "string" ? effects.endsAt : null;
    if (endsAt && new Date(endsAt).valueOf() < Date.now()) {
      lines.push(`مدته انتهت في ${new Date(endsAt).toLocaleDateString("ar-IQ")}؛ والاستعادة لا تمدّدها، فيعود منتهياً.`);
    }
    lines.push(restoreLine);
    lines.push("ورمزه يتحرر فوراً — تستطيع إنشاء كوبون جديد بالرمز نفسه.");
    return lines;
  }

  lines.push(`تُزال عضوية «${target.label}» من فريق هذا المتجر.`);
  const sessions = number(effects, "openSessions");
  if (sessions && sessions > 0) lines.push(`له ${counted(sessions, SESSION_FORMS)} مفتوحة الآن، تُبطل كلها في اللحظة نفسها.`);
  else lines.push("لا جلسات مفتوحة له الآن.");
  lines.push("حسابه على المنصة لا يُحذف — قد يكون عضواً في متاجر أخرى.");
  lines.push(window ? `تستطيع إعادته إلى الفريق خلال ${window}؛ تعود صلاحياته الخاصة معه، ولا تعود جلساته.` : "تستطيع إعادته إلى الفريق من سلة المحذوفات؛ تعود صلاحياته الخاصة معه، ولا تعود جلساته.");
  // Plan §1.و exception 6: `is_active` now carries two meanings, and the UI is
  // where they are told apart in words the merchant can act on.
  lines.push("وهذا غير «الإيقاف»: الموقوف يبقى في قائمة الفريق، والمُزال ينتقل إلى سلة المحذوفات.");
  return lines;
}

export function DeleteConfirmSheet({ storeSlug, target, onClose, onDeleted, onDeactivated }: DeleteConfirmSheetProps) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [busy, setBusy] = useState<"remove" | "deactivate" | null>(null);
  const [conflict, setConflict] = useState<TrashApiError | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const endpoints = endpointsFor(storeSlug, target.entityType, target.id);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setConflict(null);
    setDenied(null);
    setLoadingPreview(true);
    void (async () => {
      try {
        const data = await trashApi<{ preview: DeletePreview }>(`${merchantStoreBase(storeSlug)}/trash/preview/${target.entityType}/${encodeURIComponent(target.id)}`);
        if (!cancelled) setPreview(data.preview);
      } catch (error) {
        if (cancelled) return;
        setPreview(null);
        // The preview rides the SAME permission as the delete, so a 403 here is
        // the delete answering early. Narrating «سيختفي… تستطيع استعادته…» to
        // someone who will be refused would be describing outcomes he can never
        // have; the sheet says the true thing instead and disables the button.
        if (error instanceof TrashApiError && error.status === 403) setDenied(readableError(error));
        // Any OTHER failure is not something the merchant must read: the sheet
        // drops every number and states the qualitative truth instead.
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => { cancelled = true; };
  }, [storeSlug, target.entityType, target.id]);

  const remove = useCallback(async () => {
    setBusy("remove");
    setConflict(null);
    try {
      const result = await trashApi<SoftDeleteResponse>(endpoints.remove, { method: "DELETE" });
      onDeleted(result);
      onClose();
    } catch (error) {
      // The conflict stays HERE, in the sheet the merchant is already reading.
      if (error instanceof TrashApiError) setConflict(error);
      else setConflict(new TrashApiError(0, "NETWORK", "تعذر الاتصال بالخادم — أعد المحاولة."));
    } finally {
      setBusy(null);
    }
  }, [endpoints.remove, onClose, onDeleted]);

  const deactivate = useCallback(async () => {
    if (!endpoints.deactivate) return;
    setBusy("deactivate");
    try {
      await trashApi(endpoints.deactivate, { method: "PATCH", body: JSON.stringify({ isActive: false }) });
      onDeactivated?.();
      onClose();
    } catch (error) {
      setConflict(error instanceof TrashApiError ? error : new TrashApiError(0, "NETWORK", "تعذر الاتصال بالخادم — أعد المحاولة."));
    } finally {
      setBusy(null);
    }
  }, [endpoints.deactivate, onClose, onDeactivated]);

  const heading = HEADINGS[target.entityType];
  const lines = denied ? [] : consequenceLines(target, preview);
  const deactivateLabel = DEACTIVATE_LABEL[target.entityType];
  const offersDeactivate = Boolean(endpoints.deactivate && deactivateLabel && conflict?.details.hint === "deactivate");

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* Bottom sheet on a phone, centred card from `sm` up. The overrides ride
          tailwind-merge, so the later classes win over the primitive's own. */}
      <DialogContent
        dir="rtl"
        showCloseButton={false}
        data-testid="delete-confirm-sheet"
        className="top-auto bottom-0 max-h-[92vh] w-full max-w-full translate-y-0 gap-0 overflow-y-auto rounded-b-none rounded-t-[26px] border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 text-right shadow-[0_-12px_44px_rgba(31,55,98,0.14)] sm:top-[50%] sm:bottom-auto sm:max-w-[560px] sm:translate-y-[-50%] sm:rounded-[26px] sm:p-8 sm:shadow-[0_18px_52px_rgba(31,55,98,0.18)]"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-danger-soft)] text-[#B44B40]"><Trash2 className="h-5 w-5" strokeWidth={1.8} /></span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg font-bold text-[#15233E]">{heading.title}</DialogTitle>
            <DialogDescription className="mt-1 truncate text-sm text-[#61708A]">
              {target.label}
              {target.secondary ? <span className="mr-2 text-xs text-[#8A96A9]" dir="ltr">{target.secondary}</span> : null}
            </DialogDescription>
          </div>
          <Button type="button" variant="ghost" size="icon" className="shrink-0 rounded-xl" aria-label="إغلاق" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        {denied ? (
          <p data-testid="delete-sheet-denied" role="alert" className="mt-5 rounded-2xl border border-[#F0C7C4] bg-[#FFF7F7] p-4 text-sm leading-7 text-[#8E3B34]">{denied}</p>
        ) : (
          <ul data-testid="delete-sheet-consequences" className="mt-5 space-y-2.5 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-sm leading-7 text-[#3D4F6B]">
            {lines.map((line) => <li key={line} className="flex gap-2"><span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9DB3D2]" />{line}</li>)}
            {loadingPreview ? <li className="flex items-center gap-2 text-xs text-[#8A96A9]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />جارٍ قراءة أثر الإزالة من الخادم…</li> : null}
          </ul>
        )}

        {conflict ? (
          <div data-testid="delete-sheet-conflict" role="alert" className="mt-4 rounded-2xl border border-[#F0C7C4] bg-[#FFF7F7] p-4 text-sm leading-7 text-[#8E3B34]">
            <p className="flex items-start gap-2 font-semibold"><CircleAlert className="mt-1 h-4 w-4 shrink-0" />{readableError(conflict)}</p>
            {offersDeactivate ? (
              <>
                <p className="mt-2 text-[13px] text-[#9B5A53]">تريد إخفاءه من متجرك بدلاً من ذلك؟ يبقى في لوحتك ويختفي عن الزبائن، بلا مساس بأي عملية جارية.</p>
                <Button type="button" size="sm" disabled={busy !== null} data-testid="delete-sheet-deactivate" className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]" onClick={() => void deactivate()}>
                  {busy === "deactivate" ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <EyeOff className="ml-2 h-4 w-4" />}
                  {deactivateLabel}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="rounded-xl sm:min-w-[120px]" disabled={busy !== null} onClick={onClose}>{denied ? "إغلاق" : "إلغاء"}</Button>
          <Button
            type="button"
            data-testid="delete-sheet-confirm"
            disabled={busy !== null || denied !== null}
            className="rounded-xl bg-[#B34B43] hover:bg-[#9A3F38] sm:flex-1"
            onClick={() => void remove()}
          >
            {busy === "remove" ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <Trash2 className="ml-2 h-4 w-4" />}
            {heading.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The «تراجع» bar every caller shows after a successful removal.
// ---------------------------------------------------------------------------

export interface UndoBarProps {
  result: SoftDeleteResponse;
  label: string;
  storeSlug: string;
  onUndone: () => void;
  onDismiss: () => void;
}

/**
 * The undo runs the SAME restore the trash bin runs, so a 409 here means the
 * merchant needs the bin's conflict form — and the bar says exactly that
 * instead of pretending the undo silently worked.
 */
export function UndoBar({ result, label, storeSlug, onUndone, onDismiss }: UndoBarProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // ع-1 — the bar used to promise «يُحذف نهائياً بعد ٣٠ يوماً» for EVERY row,
  // including one the confirmation sheet had promised, a second earlier, would be
  // kept forever. It was not merely inconsistent: the purge really does refuse
  // that row (23503 on a RESTRICT key), so the sentence was false — and false in
  // the direction that sends a merchant back to hiding products instead of
  // removing them, which is the behaviour this whole feature exists to end.
  // The server now sends the same prediction the bin renders, so the two surfaces
  // cannot tell one row two stories.
  const days = counted(daysUntil(result.purgeAt), DAY_FORMS);

  async function undo() {
    setBusy(true);
    setFailure(null);
    try {
      await trashApi(endpointsFor(storeSlug, result.entityType, result.id).restore, { method: "POST", body: JSON.stringify({}) });
      onUndone();
    } catch (error) {
      setFailure(error instanceof TrashApiError
        ? `${readableError(error)} افتح «سلة المحذوفات» لاستعادته باسم أو رمز بديل.`
        : "تعذر الاتصال بالخادم — أعد المحاولة من «سلة المحذوفات».");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="trash-undo-bar" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-4 py-3 text-sm text-[#35577F]">
      <p className="min-w-0">
        نُقل «{label}» إلى سلة المحذوفات.{" "}
        {result.keptForRecords ? "ويبقى محفوظاً لسجلاتك — لا يُحذف نهائياً." : `يُحذف نهائياً بعد ${days}.`}
        {failure ? <span className="mt-1 block text-[13px] font-semibold text-[var(--codiq-danger)]">{failure}</span> : null}
      </p>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="sm" variant="outline" className="rounded-xl" disabled={busy} data-testid="trash-undo" onClick={() => void undo()}>
          {busy ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="ml-1 h-3.5 w-3.5" />}تراجع
        </Button>
        <Button type="button" size="sm" variant="ghost" className="rounded-xl text-[#66779A]" onClick={onDismiss}>إخفاء</Button>
      </div>
    </div>
  );
}
