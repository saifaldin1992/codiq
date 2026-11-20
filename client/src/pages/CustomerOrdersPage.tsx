import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ClipboardList, ChevronLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStorefront } from "@/components/StorefrontProvider";
import { EmptyState, ErrorState, LoadingState } from "@/components/StorefrontStates";
import { errorMessage, formatIqd, OrderListItem, storefrontApi } from "@/lib/storefront-api";
import { useReorder } from "@/lib/use-reorder";

const statusLabel: Record<string, string> = { new: "جديد", processing: "قيد المعالجة", preparation: "قيد التجهيز", out_for_delivery: "خرج للتوصيل", completed: "مكتمل", cancelled: "ملغي", rejected: "مرفوض", returned: "مرتجع" };
function formatDate(value: string) { return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

export default function CustomerOrdersPage() {
  const { slug, customer, loading: storefrontLoading } = useStorefront();
  const [, navigate] = useLocation();
  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // CD-1c: one-click reorder straight from the history rows.
  const { reorder, pendingOrderId, inlineNotice } = useReorder();
  const load = useCallback(async (next?: string | null, append = false) => {
    if (!customer) return;
    try {
      append ? setMoreLoading(true) : setLoading(true);
      const result = await storefrontApi.orders(slug, next);
      setOrders((current) => append ? [...current, ...result.orders.filter((order) => !current.some((item) => item.id === order.id))] : result.orders);
      setCursor(result.nextCursor);
      setPageError(null);
    } catch (error) { setPageError(errorMessage(error)); }
    finally { setLoading(false); setMoreLoading(false); }
  }, [customer, slug]);
  useEffect(() => { void load(); }, [load]);
  if (storefrontLoading || (loading && customer)) return <LoadingState label="جارٍ تحميل الطلبات…" />;
  if (!customer) return <EmptyState title="سجّل الدخول لعرض طلباتك" detail="تظهر في هذه الصفحة الطلبات التابعة لحسابك داخل هذا المتجر فقط." action={{ label: "تسجيل الدخول", onClick: () => navigate(`/store/${slug}/account/login?returnTo=${encodeURIComponent(`/store/${slug}/account/orders`)}`) }} />;
  if (pageError) return <ErrorState message={pageError} retry={() => void load()} />;
  if (!orders.length) return <EmptyState title="لا توجد طلبات بعد" detail="عند إتمام أول طلب بالدفع عند الاستلام ستجده هنا." action={{ label: "تصفح المنتجات", onClick: () => navigate(`/store/${slug}`) }} />;
  return <section className="space-y-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-sm font-bold text-[#1769CF]">حسابي</p><h1 className="mt-1 text-3xl font-black text-[#263D5F]">طلباتي</h1><p className="mt-2 text-sm text-[var(--codiq-text-muted)]">تُعرض الطلبات الخاصة بحسابك في هذا المتجر فقط.</p></div><ClipboardList className="h-8 w-8 text-[#7FA6D2]" /></div>{inlineNotice ? <p role="status" aria-live="polite" data-testid="reorder-notice" className="rounded-[24px] border border-[#F0DCC0] bg-[#FFFAF2] px-5 py-4 text-sm leading-6 text-[#8A6428]">{inlineNotice}</p> : null}<div className="space-y-3">{orders.map((order) => <article key={order.id} className="rounded-[23px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-[0_10px_28px_rgba(37,67,108,.05)] transition hover:border-[#C5D9F0]">
    {/* The row link stays a link, and the reorder action sits BESIDE it — a
        button nested inside an anchor would be an invalid, unusable control. */}
    <Link href={`/store/${slug}/account/orders/${order.id}`} className="block"><div className="flex items-start justify-between gap-4"><div><p className="font-black text-[#2D4567]">{order.orderNumber}</p><p className="mt-1 text-xs text-[#7A8BA3]">{formatDate(order.createdAt)}</p></div><ChevronLeft className="h-5 w-5 text-[#7090B4]" /></div></Link>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--codiq-neutral-soft)] pt-4"><span className="rounded-full bg-[var(--codiq-accent-soft)] px-3 py-1 text-xs font-black text-[#1769CF]">{statusLabel[order.status] ?? order.status}</span><div className="flex items-center gap-3"><Button type="button" size="sm" variant="outline" data-testid={`reorder-button-${order.orderNumber}`} disabled={pendingOrderId === order.id} className="rounded-xl border-[#CFE0F4] font-bold text-[#1769CF] hover:bg-[#F1F7FF]" onClick={() => void reorder(order.id)}><RotateCcw className="ml-1.5 h-4 w-4" />{pendingOrderId === order.id ? "جارٍ الإضافة…" : "اطلبه مجدداً"}</Button><strong className="text-sm text-[#2D4567]">{formatIqd.format(order.totalIqd)} د.ع</strong></div></div>
  </article>)}</div>{cursor ? <div className="flex justify-center"><Button type="button" variant="outline" disabled={moreLoading} className="rounded-xl" onClick={() => void load(cursor, true)}>{moreLoading ? "جارٍ التحميل…" : "تحميل المزيد"}</Button></div> : null}</section>;
}
