/**
 * codiq phase 20B-1 — coupons management (D-08), page «الكوبونات» under «التسويق».
 * Guarded server-side by settings.manage.
 *
 * PG-2 CORRECTED THE HEADLINE OF THIS FILE. It used to read «there is NO delete
 * — a coupon is retired with the activation toggle because redemptions
 * reference it forever», and that is no longer true: a coupon is soft-deleted
 * into the trash bin, its code is freed the same instant (the unique index is
 * partial), and the redemption ledger is untouched either way. What survives of
 * the old sentence is the reason the row itself is never hard-deleted while a
 * redemption points at it — that is now enforced at PURGE time by the
 * foreign-key wall, and the row keeps its «محفوظ لسجلاتك» badge in the bin.
 *
 * The toggle stays, and it means something different: «إيقاف» keeps the coupon
 * in the list, «إزالة» moves it to the bin.
 */
import { LoaderCircle, Pencil, Power, RefreshCw, ShieldAlert, TicketPercent, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { DeleteConfirmSheet, UndoBar, type DeleteTarget, type SoftDeleteResponse } from "@/components/DeleteConfirmSheet";

type CouponKind = "percent" | "fixed" | "free_shipping";
type Coupon = {
  id: string; code: string; kind: CouponKind; percentOff: number | null; amountOffIqd: number | null;
  minSubtotalIqd: number; maxUsesTotal: number | null; maxUsesPerCustomer: number | null;
  startsAt: string | null; endsAt: string | null; isActive: boolean; redemptionCount: number; createdAt: string;
};

const money = new Intl.NumberFormat("ar-IQ");
const kindLabels: Record<CouponKind, string> = { percent: "نسبة مئوية", fixed: "مبلغ ثابت", free_shipping: "شحن مجاني" };

type Draft = { code: string; kind: CouponKind; percentOff: string; amountOffIqd: string; minSubtotalIqd: string; maxUsesTotal: string; maxUsesPerCustomer: string; startsAt: string; endsAt: string };
const emptyDraft: Draft = { code: "", kind: "percent", percentOff: "10", amountOffIqd: "", minSubtotalIqd: "0", maxUsesTotal: "", maxUsesPerCustomer: "", startsAt: "", endsAt: "" };

function apiError(payload: unknown) {
  if (typeof payload === "object" && payload && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    return error?.message ?? "تعذر إتمام العملية.";
  }
  return "تعذر إتمام العملية.";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiError(payload));
  return payload as T;
}

function draftBody(draft: Draft) {
  return {
    code: draft.code.trim(),
    kind: draft.kind,
    ...(draft.kind === "percent" ? { percentOff: Number(draft.percentOff) } : {}),
    ...(draft.kind === "fixed" ? { amountOffIqd: Number(draft.amountOffIqd) } : {}),
    minSubtotalIqd: Number(draft.minSubtotalIqd) || 0,
    maxUsesTotal: draft.maxUsesTotal ? Number(draft.maxUsesTotal) : null,
    maxUsesPerCustomer: draft.maxUsesPerCustomer ? Number(draft.maxUsesPerCustomer) : null,
    startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
    endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-right"><span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">{label}</span>{children}</label>;
}

const inputClass = "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none transition focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10";

function couponValueLabel(coupon: Coupon) {
  if (coupon.kind === "percent") return `خصم ${coupon.percentOff}%`;
  if (coupon.kind === "fixed") return `خصم ${money.format(coupon.amountOffIqd ?? 0)} د.ع`;
  return "شحن مجاني";
}

export function CouponsManager({ storeSlug }: { storeSlug?: string }) {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  // 20-2: the list used to be every live coupon in the store, forever. Nothing
  // expires a coupon row, so a merchant running a code per campaign grew it
  // without a ceiling.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [undo, setUndo] = useState<{ result: SoftDeleteResponse; label: string } | null>(null);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/marketing/coupons` : null;

  const refresh = useCallback(async (cursor?: string) => {
    if (!base) return;
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const data = await api<{ coupons: Coupon[]; nextCursor: string | null }>(`${base}?${query.toString()}`);
      setCoupons((current) => (cursor ? [...current, ...data.coupons] : data.coupons));
      setNextCursor(data.nextCursor);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "تعذر تحميل الكوبونات."); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [base]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!base || !draft.code.trim()) return;
    setBusy(true);
    try {
      if (editingId) {
        await api(`${base}/${editingId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(draftBody(draft)) });
        setMessage("تم تحديث الكوبون.");
      } else {
        await api(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draftBody(draft)) });
        setMessage("تم إنشاء الكوبون داخل المتجر الحالي.");
      }
      setDraft(emptyDraft);
      setEditingId(null);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "تعذر حفظ الكوبون."); }
    finally { setBusy(false); }
  }

  async function toggleActive(coupon: Coupon) {
    if (!base) return;
    setBusy(true);
    try {
      await api(`${base}/${coupon.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !coupon.isActive }) });
      await refresh();
      setMessage(coupon.isActive ? "أُوقف الكوبون — يبقى في هذه القائمة ولا يعمل في المتجر." : "تم تفعيل الكوبون.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "تعذر تغيير حالة الكوبون."); }
    finally { setBusy(false); }
  }

  function startEditing(coupon: Coupon) {
    setEditingId(coupon.id);
    setDraft({
      code: coupon.code, kind: coupon.kind,
      percentOff: coupon.percentOff ? String(coupon.percentOff) : "10",
      amountOffIqd: coupon.amountOffIqd ? String(coupon.amountOffIqd) : "",
      minSubtotalIqd: String(coupon.minSubtotalIqd),
      maxUsesTotal: coupon.maxUsesTotal ? String(coupon.maxUsesTotal) : "",
      maxUsesPerCustomer: coupon.maxUsesPerCustomer ? String(coupon.maxUsesPerCustomer) : "",
      startsAt: coupon.startsAt ? coupon.startsAt.slice(0, 10) : "",
      endsAt: coupon.endsAt ? coupon.endsAt.slice(0, 10) : "",
    });
  }

  if (!storeSlug) return <div className="rounded-[24px] border border-[#F3CBCA] bg-[#FFF7F7] p-6 text-sm leading-7 text-[#9B3733]"><ShieldAlert className="mb-3 h-6 w-6" />اختر متجرًا عبر مسار لوحة التاجر المقيد بـ`store-slug` قبل إدارة الكوبونات.</div>;
  if (loading) return <div className="flex items-center gap-3 rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[#61708A]"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--codiq-accent)]" />جارٍ تحميل كوبونات المتجر…</div>;

  return <div className="space-y-5" dir="rtl">
    {message ? <div className="rounded-2xl border border-[#D8E6F8] bg-[var(--codiq-canvas)] px-4 py-3 text-sm text-[#35577F]">{message}</div> : null}
    {undo ? <UndoBar result={undo.result} label={undo.label} storeSlug={storeSlug} onUndone={() => { setUndo(null); void refresh(); setMessage("أُعيد الكوبون. إن كانت مدته قد انتهت فهو يعود منتهياً — الاستعادة لا تمدّد نافذته."); }} onDismiss={() => setUndo(null)} /> : null}
    {deleteTarget ? <DeleteConfirmSheet
      storeSlug={storeSlug}
      target={deleteTarget}
      onClose={() => setDeleteTarget(null)}
      onDeleted={(result) => { setUndo({ result, label: deleteTarget.label }); void refresh(); }}
      onDeactivated={() => { void refresh(); setMessage("أُوقف الكوبون بدل إزالته — يبقى في هذه القائمة."); }}
    /> : null}
    <form onSubmit={submit} className="space-y-5 rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
      <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><TicketPercent className="h-5 w-5" /></span><div><h2 className="font-bold text-[#273753]">{editingId ? "تعديل كوبون" : "كوبون جديد"}</h2><p className="text-xs text-[var(--codiq-text-muted)]">الخصم يُطبق على مجموع المنتجات فقط؛ «الشحن المجاني» يصفّر رسوم التوصيل ولا يمس الخصم. «الإيقاف» يُبقيه في هذه القائمة، و«الإزالة» تنقله إلى سلة المحذوفات ويتحرر رمزه فوراً — وسجل استخداماته يبقى محفوظاً في الحالتين.</p></div></div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="رمز الكوبون"><input required data-testid="coupon-code-input" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} placeholder="مثال: SAVE10" className={inputClass} /></Field>
        <Field label="نوع الكوبون"><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as CouponKind })} className={inputClass}><option value="percent">نسبة مئوية</option><option value="fixed">مبلغ ثابت</option><option value="free_shipping">شحن مجاني</option></select></Field>
        {draft.kind === "percent" ? <Field label="نسبة الخصم (1–100)"><input required type="number" min="1" max="100" value={draft.percentOff} onChange={(event) => setDraft({ ...draft, percentOff: event.target.value })} className={inputClass} /></Field> : null}
        {draft.kind === "fixed" ? <Field label="مبلغ الخصم بالدينار"><input required type="number" min="1" value={draft.amountOffIqd} onChange={(event) => setDraft({ ...draft, amountOffIqd: event.target.value })} className={inputClass} /></Field> : null}
        <Field label="الحد الأدنى للطلب (د.ع)"><input type="number" min="0" value={draft.minSubtotalIqd} onChange={(event) => setDraft({ ...draft, minSubtotalIqd: event.target.value })} className={inputClass} /></Field>
        <Field label="حد الاستخدام الكلي (اختياري)"><input type="number" min="1" value={draft.maxUsesTotal} onChange={(event) => setDraft({ ...draft, maxUsesTotal: event.target.value })} className={inputClass} /></Field>
        <Field label="حد الاستخدام لكل زبون (اختياري)"><input type="number" min="1" value={draft.maxUsesPerCustomer} onChange={(event) => setDraft({ ...draft, maxUsesPerCustomer: event.target.value })} className={inputClass} /></Field>
        <Field label="يبدأ في (اختياري)"><input type="date" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} className={inputClass} /></Field>
        <Field label="ينتهي في (اختياري)"><input type="date" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} className={inputClass} /></Field>
      </div>
      <div className="flex gap-2">
        <Button disabled={busy} type="submit" data-testid="coupon-submit" className="rounded-xl bg-[var(--codiq-accent)] px-5">{busy ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <TicketPercent className="ml-2 h-4 w-4" />}{editingId ? "حفظ التعديلات" : "إنشاء الكوبون"}</Button>
        {editingId ? <Button type="button" variant="outline" className="rounded-xl" onClick={() => { setEditingId(null); setDraft(emptyDraft); }}>إلغاء التعديل</Button> : null}
      </div>
    </form>
    <div className="space-y-3">
      <div className="flex items-center justify-between"><p className="text-sm font-bold text-[#435672]">{coupons.length} كوبون معروض{nextCursor ? " — وهناك المزيد" : ""}</p><Button type="button" variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className="ml-1 h-3.5 w-3.5" />تحديث</Button></div>
      {coupons.map((coupon) => <article key={coupon.id} data-testid={`coupon-row-${coupon.code}`} className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-black text-[#273753]">{coupon.code}</h3><span className="rounded-full bg-[#F0F5FF] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent)]">{kindLabels[coupon.kind]}</span><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${coupon.isActive ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-danger-soft)] text-[#B44B40]"}`}>{coupon.isActive ? "فعّال" : "موقوف"}</span></div>
            <p className="mt-2 text-xs text-[var(--codiq-text-muted)]">{couponValueLabel(coupon)}{coupon.minSubtotalIqd ? ` · حد أدنى ${money.format(coupon.minSubtotalIqd)} د.ع` : ""}{coupon.maxUsesTotal ? ` · حد كلي ${coupon.maxUsesTotal}` : ""}{coupon.maxUsesPerCustomer ? ` · ${coupon.maxUsesPerCustomer} لكل زبون` : ""}</p>
            <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">استُخدم {coupon.redemptionCount} مرة{coupon.startsAt ? ` · يبدأ ${new Date(coupon.startsAt).toLocaleDateString("ar-IQ")}` : ""}{coupon.endsAt ? ` · ينتهي ${new Date(coupon.endsAt).toLocaleDateString("ar-IQ")}` : ""}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => startEditing(coupon)}><Pencil className="ml-1 h-3.5 w-3.5" />تعديل</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} data-testid={`coupon-toggle-${coupon.code}`} className={coupon.isActive ? "border-[#F0C7C4] text-[#B34B43] hover:bg-[#FFF7F7]" : "border-[#CCE8D8] text-[var(--codiq-success)] hover:bg-[#F4FBF6]"} onClick={() => void toggleActive(coupon)}><Power className="ml-1 h-3.5 w-3.5" />{coupon.isActive ? "إيقاف" : "تفعيل"}</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} data-testid={`coupon-delete-${coupon.code}`} className="border-[#F0C7C4] text-[#B34B43] hover:bg-[#FFF7F7]" onClick={() => { setMessage(null); setUndo(null); setDeleteTarget({ entityType: "coupon", id: coupon.id, label: coupon.code }); }}><Trash2 className="ml-1 h-3.5 w-3.5" />إزالة</Button>
          </div>
        </div>
      </article>)}
      {!coupons.length ? <div className="rounded-[24px] bg-[var(--codiq-surface)] p-7 text-sm text-[var(--codiq-text-muted)]">لا توجد كوبونات بعد. أنشئ أول كوبون لتفعيل الخصومات في المتجر.</div> : null}
      <LoadMoreButton cursor={nextCursor} busy={loadingMore} onLoad={(cursor) => void refresh(cursor)} testId="coupons-more" />
    </div>
  </div>;
}
