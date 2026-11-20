import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ArrowRight, CheckCircle2, CircleX, Clock3, FileHeart, PackageSearch, ReceiptText, RotateCcw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { GuestPasswordCard } from "@/components/GuestPasswordCard";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import { CustomerOrder, errorMessage, formatIqd, storefrontApi } from "@/lib/storefront-api";
import { useReorder } from "@/lib/use-reorder";

const statusLabel: Record<string, string> = { new: "جديد", processing: "قيد المعالجة", preparation: "قيد التجهيز", out_for_delivery: "خرج للتوصيل", completed: "مكتمل", cancelled: "ملغي", rejected: "مرفوض", returned: "مرتجع" };
function formatDate(value: string) { return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

const prescriptionLabels: Record<string, { title: string; detail: string; tone: string }> = {
  pending_upload: { title: "بانتظار رفع الوصفة", detail: "يتضمن الطلب منتجًا بوصفة طبية. ارفع صورة واضحة للوصفة (JPEG/PNG/WebP حتى 5 MB) ليبدأ المتجر بالمعالجة.", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  pending_review: { title: "الوصفة قيد المراجعة", detail: "استلم المتجر وصفتك وسيراجعها قبل بدء المعالجة.", tone: "border-sky-200 bg-sky-50 text-sky-900" },
  approved: { title: "الوصفة معتمدة", detail: "اعتمد المتجر وصفتك ويمكنه الآن معالجة الطلب.", tone: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  rejected: { title: "الوصفة مرفوضة — أعد الرفع", detail: "رفض المتجر الوصفة المرفوعة. ارفع صورة أوضح أو وصفة صحيحة لمتابعة الطلب.", tone: "border-red-200 bg-red-50 text-red-900" },
};

/**
 * PG-1: calling off an order the store has not started yet.
 *
 * Two steps on purpose. Cancelling is irreversible and the customer is often on
 * a phone, so the first press only opens the reason box; the confirm button is a
 * separate, deliberate press.
 */
function CancelOrderSection({ slug, order, onCancelled }: { slug: string; order: CustomerOrder; onCancelled: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The store commits work the moment it leaves `new`; after that the customer
  // has to talk to the merchant, and the server refuses regardless.
  if (order.status !== "new") return null;
  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await storefrontApi.cancelOrder(slug, order.id, reason.trim() || undefined); setOpen(false); setReason(""); await onCancelled(); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  if (!open) {
    return <div className="flex justify-center">
      <Button type="button" variant="outline" data-testid="cancel-order-open" onClick={() => setOpen(true)} className="rounded-xl border-[#EBC9C9] font-bold text-[#A33A3A] hover:bg-[#FFF5F5]"><CircleX className="ml-2 h-4 w-4" />إلغاء الطلب</Button>
    </div>;
  }
  return <section data-testid="cancel-order-panel" className="rounded-[26px] border border-[#F0D5D5] bg-[#FFF8F8] p-5 sm:p-6">
    <div className="flex items-center gap-2"><CircleX className="h-5 w-5 text-[#A33A3A]" /><h2 className="font-black text-[#8C3131]">إلغاء الطلب</h2></div>
    <p className="mt-2 text-sm leading-6 text-[#8A5A5A]">سيُلغى الطلب نهائيًا ولا يمكن التراجع. إن غيّرت رأيك لاحقًا يمكنك إعادة طلبه بضغطة واحدة.</p>
    <label htmlFor="cancel-order-reason" className="mt-4 block text-xs font-bold text-[#8A5A5A]">سبب الإلغاء (اختياري)</label>
    <textarea id="cancel-order-reason" data-testid="cancel-order-reason" value={reason} maxLength={500} rows={2} onChange={(event) => setReason(event.target.value)} placeholder="مثال: طلبت المقاس الخطأ" className="mt-2 w-full rounded-2xl border border-[#EDD3D3] bg-[var(--codiq-surface)] p-3 text-sm text-[#5C4141] outline-none focus:border-[#C98B8B]" />
    <div className="mt-4 flex flex-wrap gap-3">
      <Button type="button" disabled={busy} data-testid="cancel-order-confirm" onClick={() => void cancel()} className="rounded-xl bg-[#A33A3A] font-black hover:bg-[#8C3131]">{busy ? "جارٍ الإلغاء…" : "تأكيد الإلغاء"}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setOpen(false); setError(null); }} className="rounded-xl">تراجع</Button>
    </div>
    {error ? <p role="alert" data-testid="cancel-order-error" className="mt-3 text-xs font-bold text-[#A33A3A]">{error}</p> : null}
  </section>;
}

/** Phase 20B-1: post-order prescription upload — the checkout itself never touches files. */
function PrescriptionSection({ slug, order, onChanged }: { slug: string; order: CustomerOrder; onChanged: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!order.prescriptionStatus) return null;
  const meta = prescriptionLabels[order.prescriptionStatus] ?? prescriptionLabels.pending_upload;
  const canUpload = order.prescriptionStatus === "pending_upload" || order.prescriptionStatus === "rejected";
  const hasFile = order.prescriptionStatus === "pending_review" || order.prescriptionStatus === "approved" || order.prescriptionStatus === "rejected";
  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try { await storefrontApi.uploadPrescription(slug, order.id, file); setFile(null); await onChanged(); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section data-testid="prescription-section" className={`rounded-[26px] border p-5 sm:p-6 ${meta.tone}`}>
    <div className="flex items-center gap-2"><FileHeart className="h-5 w-5" /><h2 className="font-black">{meta.title}</h2></div>
    <p className="mt-2 text-sm leading-6">{meta.detail}</p>
    {hasFile ? <img src={storefrontApi.prescriptionUrl(slug, order.id)} alt="الوصفة المرفوعة" className="mt-4 max-h-64 rounded-2xl border border-white/60 object-contain" /> : null}
    {canUpload ? <div className="mt-4 flex flex-wrap items-center gap-3">
      <input type="file" accept="image/jpeg,image/png,image/webp" data-testid="prescription-file-input" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="block text-xs" />
      <Button type="button" disabled={!file || busy} data-testid="prescription-upload-button" onClick={() => void upload()} className="rounded-xl"><UploadCloud className="ml-2 h-4 w-4" />{busy ? "جارٍ الرفع…" : "رفع الوصفة"}</Button>
    </div> : null}
    {error ? <p role="alert" className="mt-3 text-xs font-bold">{error}</p> : null}
  </section>;
}


/**
 * CD-3: the shopper's return request, on the order he received.
 *
 * Only on a `completed` order — you cannot return what has not arrived; an order
 * still in flight is cancelled instead, which is the panel above. And the button
 * says «اطلب إرجاعاً», never «أرجِع»: pressing it asks the merchant, it does not
 * return anything, and a label that promised otherwise would have him waiting
 * for money nobody has agreed to send back.
 */
function RequestReturnPanel({ slug, order }: { slug: string; order: { id: string; status: string } }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (order.status !== "completed") return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await storefrontApi.requestReturn(slug, order.id, { reason: reason.trim() });
      setDone(true);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر إرسال الطلب.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">
      أُرسل طلب الإرجاع إلى التاجر. تابع حالته من <Link href={`/store/${slug}/account/returns`} className="underline">إرجاعاتي</Link>.
    </p>;
  }
  if (!open) {
    return <Button type="button" variant="outline" data-testid="request-return-open" onClick={() => setOpen(true)} className="rounded-xl">
      <RotateCcw className="ml-1 h-4 w-4" /> اطلب إرجاعاً
    </Button>;
  }
  return <section data-testid="request-return-panel" className="rounded-[26px] border border-[#E4DCCB] bg-[#FFFCF5] p-5">
    <h2 className="font-black text-[#7A5A22]">طلب إرجاع</h2>
    <p className="mt-1 text-xs leading-6 text-[#8A7550]">
      هذا طلب يُرسل إلى التاجر، وليس إرجاعاً فورياً. سيقرأ سببك ويوافق أو يرفض، وسيصلك رده هنا.
    </p>
    <label htmlFor="return-reason" className="mt-4 block text-xs font-bold text-[#7A5A22]">سبب الإرجاع (مطلوب)</label>
    <textarea id="return-reason" data-testid="return-reason" value={reason} maxLength={1000} rows={3}
      onChange={(event) => setReason(event.target.value)}
      placeholder="مثال: المقاس غير مناسب، أو المنتج وصل به عيب"
      className="mt-1 w-full rounded-xl border border-[#E4DCCB] bg-[var(--codiq-surface)] px-3 py-2 text-sm outline-none focus:border-[#B08A3E]" />
    <div className="mt-3 flex gap-2">
      <Button type="button" disabled={busy || !reason.trim()} data-testid="request-return-confirm" onClick={() => void submit()} className="rounded-xl bg-[#B08A3E] hover:bg-[#96742F]">إرسال الطلب</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="rounded-xl">إلغاء</Button>
    </div>
    {error ? <p role="alert" data-testid="request-return-error" className="mt-3 text-xs font-bold text-[#A33A3A]">{error}</p> : null}
  </section>;
}

export default function CustomerOrderDetailPage() {
  const { storeSlug, orderId } = useParams<{ storeSlug: string; orderId: string }>();
  const { customer, loading: storefrontLoading } = useStorefront();
  const [, navigate] = useLocation();
  // CD-1c: one-click reorder, shared with the orders list.
  const { reorder, pendingOrderId, inlineNotice } = useReorder();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!customer) return;
    setLoading(true);
    try { const result = await storefrontApi.order(storeSlug, orderId); setOrder(result.order); setPageError(null); }
    catch (error) { setPageError(errorMessage(error)); }
    finally { setLoading(false); }
  }, [customer, orderId, storeSlug]);
  useEffect(() => { void load(); }, [load]);
  if (storefrontLoading || (loading && customer)) return <LoadingState label="جارٍ تحميل تفاصيل الطلب…" />;
  if (!customer) return <EmptyState title="سجّل الدخول لعرض الطلب" detail="تفاصيل الطلب متاحة لصاحب الحساب فقط داخل المتجر الحالي." action={{ label: "تسجيل الدخول", onClick: () => navigate(`/store/${storeSlug}/account/login?returnTo=${encodeURIComponent(`/store/${storeSlug}/account/orders/${orderId}`)}`) }} />;
  if (pageError) return <ErrorState message={pageError} retry={() => void load()} />;
  if (!order) return <ErrorState message="تعذر العثور على الطلب." />;
  return <section className="mx-auto max-w-4xl space-y-6"><Link href={`/store/${storeSlug}/account/orders`} className="inline-flex items-center gap-2 text-sm font-bold text-[#52769F] hover:text-[#1769CF]"><ArrowRight className="h-4 w-4" />العودة إلى طلباتي</Link><div className="rounded-[28px] bg-[#1E4D8D] p-6 text-white shadow-lg sm:p-8"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><p className="text-sm font-bold text-white/70">رقم الطلب</p><h1 className="mt-2 text-2xl font-black sm:text-3xl">{order.orderNumber}</h1><p className="mt-2 text-sm text-white/75">{formatDate(order.createdAt)}</p></div><span className="inline-flex h-fit items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-black"><CheckCircle2 className="h-4 w-4" />{statusLabel[order.status] ?? order.status}</span></div></div><GuestPasswordCard /><PrescriptionSection slug={storeSlug} order={order} onChanged={load} /><CancelOrderSection slug={storeSlug} order={order} onCancelled={load} /><div className="grid gap-6 md:grid-cols-[1fr_300px]"><div className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6"><div className="flex items-center gap-2"><ReceiptText className="h-5 w-5 text-[#1769CF]" /><h2 className="font-black text-[#2C4364]">المنتجات</h2></div><div className="mt-5 divide-y divide-[var(--codiq-neutral-soft)]">{order.items.map((item) => <div key={item.id} className="flex justify-between gap-4 py-4 first:pt-0"><div><p className="font-black text-[#324A6B]">{item.productName}</p><p className="mt-1 text-xs text-[#788AA1]">{item.quantity} × {formatIqd.format(item.unitPriceIqd)} د.ع</p></div><strong className="shrink-0 text-sm text-[#2C4568]">{formatIqd.format(item.lineTotalIqd)} د.ع</strong></div>)}</div><div className="mt-4 space-y-2 border-t border-[var(--codiq-border)] pt-4 text-sm"><div className="flex justify-between text-[var(--codiq-text-muted)]"><span>مجموع المنتجات</span><span>{formatIqd.format(order.subtotalIqd)} د.ع</span></div>{order.discountIqd > 0 ? <div className="flex justify-between text-emerald-700"><span>الخصم{order.couponCode ? ` (${order.couponCode})` : ""}</span><span>-{formatIqd.format(order.discountIqd)} د.ع</span></div> : null}{/* ق-205: the points he spent are a term of the total he is about to hand the courier — without this row the page's own arithmetic is short by exactly what he redeemed. */}{order.loyaltyDiscountIqd > 0 ? <div data-testid="order-loyalty-line" className="flex justify-between text-[var(--codiq-success)]"><span>خصم النقاط{order.loyaltyPointsSpent ? ` — ${formatIqd.format(order.loyaltyPointsSpent)} نقطة` : ""}</span><span>-{formatIqd.format(order.loyaltyDiscountIqd)} د.ع</span></div> : null}<div className="flex justify-between text-[#667791]"><span>التوصيل</span><span>{formatIqd.format(order.deliveryFeeIqd)} د.ع</span></div><div className="flex justify-between pt-1 text-base"><span className="font-bold text-[#526C8D]">الإجمالي</span><strong className="text-[#1769CF]">{formatIqd.format(order.totalIqd)} د.ع</strong></div></div></div><aside className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6"><div className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-[#1769CF]" /><h2 className="font-black text-[#2C4364]">مسار الطلب</h2></div><ol className="mt-5 space-y-5 border-r-2 border-[#DCEBFC] pr-4">{order.statusEvents.map((event, index) => <li key={`${event.toStatus}-${event.createdAt}-${index}`} className="relative"><span className="absolute -right-[22px] top-1 h-3 w-3 rounded-full border-2 border-[var(--codiq-surface)] bg-[#1769CF]" /><p className="text-sm font-black text-[#304969]">{statusLabel[event.toStatus] ?? event.toStatus}</p><p className="mt-1 text-xs text-[#7A8BA2]">{formatDate(event.createdAt)}</p></li>)}</ol><p className="mt-6 rounded-2xl bg-[var(--codiq-canvas)] p-3 text-xs leading-5 text-[#637D9E]">يعرض هذا المسار حالة الطلب وتوقيتها فقط. لا يتضمن ملاحظات أو جهات تشغيل داخلية أو تفاصيل مخزون.</p></aside></div>{inlineNotice ? <p role="status" aria-live="polite" data-testid="reorder-notice" className="rounded-[24px] border border-[#F0DCC0] bg-[#FFFAF2] px-5 py-4 text-sm leading-6 text-[#8A6428]">{inlineNotice}</p> : null}<div className="flex flex-wrap items-center justify-center gap-3">
    {/* CD-1c: rebuild this order into the cart in one click — best effort, with an honest skipped list. */}
    <Button type="button" data-testid="reorder-button" disabled={pendingOrderId === order.id} className="rounded-xl bg-[#1769CF] font-black hover:bg-[#125CB8]" onClick={() => void reorder(order.id)}><RotateCcw className="ml-2 h-4 w-4" />{pendingOrderId === order.id ? "جارٍ الإضافة…" : "اطلبه مجدداً"}</Button>
    <RequestReturnPanel slug={storeSlug} order={order} />
    {/* CD-1a: the public tracking page, shareable with whoever will receive the order. */}
    <Link href={`/store/${storeSlug}/track`} className="inline-flex items-center gap-2 rounded-xl border border-[var(--codiq-border-strong)] px-4 py-2 text-sm font-bold text-[#1769CF] hover:bg-[#F1F7FF]"><PackageSearch className="h-4 w-4" />أين طلبي؟ تتبّع بدون تسجيل دخول</Link>
    <Button type="button" variant="outline" className="rounded-xl" onClick={() => navigate(`/store/${storeSlug}`)}>متابعة التسوق</Button>
  </div></section>;
}
