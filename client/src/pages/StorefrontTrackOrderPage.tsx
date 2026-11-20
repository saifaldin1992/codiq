/**
 * codiq CD-1a — «أين طلبي؟».
 *
 * A public page: no session, no account, no cookie. The customer proves they
 * own the order with the two things they already have — the order number and
 * the phone they gave at checkout — and gets back a deliberately minimal view
 * (status, timeline, item count, total, governorate). The server returns the
 * SAME generic miss for a wrong number and a wrong phone, so this page shows
 * one neutral message for both and never hints that an order exists.
 */
import { FormEvent, useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowRight, MapPin, PackageSearch, Search, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, formatIqd, StorefrontApiError, storefrontApi, TrackedOrder } from "@/lib/storefront-api";

const statusLabel: Record<string, string> = { new: "جديد", processing: "قيد المعالجة", preparation: "قيد التجهيز", out_for_delivery: "خرج للتوصيل", completed: "مكتمل", cancelled: "ملغي", rejected: "مرفوض", returned: "مرتجع" };
function formatDate(value: string) { return new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

// One neutral sentence for every miss — the anti-enumeration guarantee reaches
// all the way to the copy.
const NO_MATCH = "لم نعثر على طلب بهذا الرقم مع رقم الهاتف المُدخل. تحقق من البيانات ثم حاول مجددًا.";

export default function StorefrontTrackOrderPage() {
  const { storeSlug } = useParams<{ storeSlug: string }>();
  // ق-232: a returning guest is sent here from checkout with his order number in
  // the URL — the one fact the server just told him — and types the phone
  // himself, which is the half that proves he is the one who placed it.
  const [orderNumber, setOrderNumber] = useState(() => new URLSearchParams(window.location.search).get("order") ?? "");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [searched, setSearched] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    if (!orderNumber.trim() || !phone.trim()) {
      setFormError("أدخل رقم الطلب ورقم الهاتف المستخدم عند الطلب.");
      return;
    }
    setPending(true);
    try {
      const result = await storefrontApi.trackOrder(storeSlug, orderNumber.trim(), phone.trim());
      setOrder(result.order);
      setSearched(true);
    } catch (error) {
      setOrder(null);
      setSearched(true);
      setFormError(error instanceof StorefrontApiError && error.status === 404 ? NO_MATCH : errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <Link href={`/store/${storeSlug}`} className="inline-flex items-center gap-2 text-sm font-bold text-[#4B6F99] hover:text-[#1769CF]"><ArrowRight className="h-4 w-4" />العودة للكتالوج</Link>

      <div className="overflow-hidden rounded-[30px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] shadow-[0_18px_48px_rgba(35,63,104,.08)]">
        <div className="bg-[var(--codiq-accent-soft)] px-6 py-7 sm:px-9">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#1769CF] text-white"><PackageSearch className="h-5 w-5" /></div>
          <p className="mt-5 text-sm font-bold text-[#1769CF]">تتبّع الطلب</p>
          <h1 className="mt-1 text-3xl font-black text-[#223A5E]">أين طلبي؟</h1>
          <p className="mt-2 text-sm leading-6 text-[#607A9C]">تابع حالة طلبك دون تسجيل دخول. أدخل رقم الطلب ورقم الهاتف الذي استخدمته عند الطلب.</p>
        </div>
        <form className="space-y-5 px-6 py-7 sm:px-9" onSubmit={(event) => void submit(event)} noValidate>
          {formError ? <div role="alert" aria-live="assertive" className="rounded-2xl border border-[#F1D0CD] bg-[#FFF8F7] px-4 py-3 text-sm font-bold text-[#A34A44]">{formError}</div> : null}
          <div className="space-y-2">
            <label htmlFor="track-order-number" className="text-sm font-bold text-[#345273]">رقم الطلب</label>
            <Input id="track-order-number" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} required className="h-12 rounded-xl" placeholder="SF-..." />
          </div>
          <div className="space-y-2">
            <label htmlFor="track-phone" className="text-sm font-bold text-[#345273]">رقم الهاتف</label>
            <Input id="track-phone" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required className="h-12 rounded-xl text-right" placeholder="+9647XXXXXXXX" />
          </div>
          <Button type="submit" disabled={pending} data-testid="track-submit" className="h-12 w-full rounded-xl bg-[#1769CF] text-base font-black hover:bg-[#125CB8]"><Search className="ml-2 h-4 w-4" />{pending ? "جارٍ البحث…" : "تتبّع الطلب"}</Button>
          <p className="text-center text-xs leading-6 text-[#8496AD]">لا تُعرض هنا أي بيانات شخصية أو عنوان تفصيلي — حالة الطلب ومساره فقط.</p>
        </form>
      </div>

      {order ? (
        <div data-testid="track-result" className="space-y-4">
          <div className="rounded-[28px] bg-[#1E4D8D] p-6 text-white shadow-lg sm:p-8">
            <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
              <div>
                <p className="text-sm font-bold text-white/70">رقم الطلب</p>
                <h2 className="mt-2 text-2xl font-black sm:text-3xl">{order.orderNumber}</h2>
                <p className="mt-2 text-sm text-white/75">{formatDate(order.createdAt)}</p>
              </div>
              <span className="inline-flex h-fit items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-black"><Truck className="h-4 w-4" />{statusLabel[order.status] ?? order.status}</span>
            </div>
            <div className="mt-6 grid gap-3 border-t border-white/15 pt-5 text-sm sm:grid-cols-3">
              <div><span className="block text-white/70">عدد القطع</span><strong className="mt-1 block text-base">{order.itemCount}</strong></div>
              <div><span className="block text-white/70">الإجمالي</span><strong className="mt-1 block text-base">{formatIqd.format(order.totalIqd)} د.ع</strong></div>
              <div><span className="block text-white/70">المحافظة</span><strong className="mt-1 flex items-center gap-1.5 text-base">{order.governorate ? <><MapPin className="h-4 w-4" />{order.governorate}</> : "—"}</strong></div>
            </div>
          </div>
          <div className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6">
            <h3 className="font-black text-[#2C4364]">مسار الطلب</h3>
            {order.statusTimeline.length ? (
              <ol className="mt-5 space-y-5 border-r-2 border-[#DCEBFC] pr-4">
                {order.statusTimeline.map((event, index) => (
                  <li key={`${event.toStatus}-${event.createdAt}-${index}`} className="relative">
                    <span className="absolute -right-[22px] top-1 h-3 w-3 rounded-full border-2 border-[var(--codiq-surface)] bg-[#1769CF]" />
                    <p className="text-sm font-black text-[#304969]">{statusLabel[event.toStatus] ?? event.toStatus}</p>
                    <p className="mt-1 text-xs text-[#7A8BA2]">{formatDate(event.createdAt)}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="mt-4 text-sm leading-6 text-[#7A8BA2]">لا توجد تحديثات على المسار بعد.</p>}
            <p className="mt-6 rounded-2xl bg-[var(--codiq-canvas)] p-3 text-xs leading-5 text-[#637D9E]">يعرض هذا المسار حالة الطلب وتوقيتها فقط، دون ملاحظات داخلية أو جهات تشغيل.</p>
          </div>
        </div>
      ) : searched && !formError ? (
        <p className="rounded-[24px] border border-dashed border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] p-6 text-center text-sm leading-7 text-[var(--codiq-text-muted)]">{NO_MATCH}</p>
      ) : null}
    </section>
  );
}
