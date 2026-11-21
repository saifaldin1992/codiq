/**
 * MD-2 «الطباعة بنقرة» — بوليصة شحن، فاتورة، وقائمة تجهيز.
 *
 * HTML للطباعة، بلا مكتبة PDF (v1). القرار مقصود: متصفح التاجر يطبع بالفعل إلى
 * PDF وإلى الطابعة، ومكتبة على الخادم كانت ستضيف خطاً ثنائي الاتجاه ثانياً يجب
 * أن يبقى مطابقاً للأول — وهذا بالضبط ما يتصدع بصمت.
 *
 * ما يحكم هذا الملف: الورقة تُقرأ بالعين لا بالفأرة. لا لون خلفي يلتهم الحبر،
 * ولا شيء يعتمد على لون ليُفهم، و`break-inside: avoid` على كل مستند حتى لا
 * يُقَصّ عنوانُ زبون بين صفحتين.
 */
import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

type Item = { id: string; productName: string; variantName: string | null; sku: string | null; quantity: number; unitPriceIqd: number; lineTotalIqd: number };
type PrintOrder = {
  id: string; orderNumber: string; status: string; createdAt: string;
  customerName: string; recipientPhone: string;
  shippingGovernorate: string; shippingAddressLine1: string; shippingAddressLine2: string | null;
  subtotalIqd: number; deliveryFeeIqd: number; discountIqd: number; totalIqd: number; loyaltyPointsSpent: number; loyaltyDiscountIqd: number; platformDiscountIqd?: number;
  couponCode: string | null; customerNote: string | null; paymentStatus: string;
  items: Item[];
};
type Sheet = {
  store: { slug: string; name: string; businessName: string; contactPhone: string | null };
  orders: PrintOrder[];
  picking: { key: string; productName: string; variantName: string | null; sku: string | null; quantity: number }[];
  totals: { orders: number; units: number; collectIqd: number };
};

export type PrintKind = "label" | "invoice" | "picking";
const KIND_LABELS: Record<PrintKind, string> = { label: "بوليصة شحن", invoice: "فاتورة", picking: "قائمة تجهيز" };

const money = new Intl.NumberFormat("ar-IQ");
const stamp = (value: string) => new Intl.DateTimeFormat("ar-IQ", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
/** أرقام الهواتف تُقرأ يساراً-يميناً حتى داخل صفحة عربية. */
const Ltr = ({ children }: { children: React.ReactNode }) => <span dir="ltr" className="inline-block tabular-nums">{children}</span>;

export function OrderPrintSheet({ storeSlug, orderIds, kind, onClose }: { storeSlug: string; orderIds: string[]; kind: PrintKind; onClose: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const ids = useMemo(() => orderIds.join(","), [orderIds]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/orders/print/sheet?ids=${encodeURIComponent(ids)}`, { credentials: "same-origin" });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تجهيز الطباعة.");
        if (alive) { setSheet(body); setFailure(null); }
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      }
    })();
    return () => { alive = false; };
  }, [storeSlug, ids]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#0B1A2F]/45 print:static print:overflow-visible print:bg-[var(--codiq-surface)]">
      <div className="mx-auto my-6 max-w-[820px] rounded-3xl bg-[var(--codiq-surface)] p-5 shadow-xl print:my-0 print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        {/* شريط الأدوات لا يُطبع: الورقة يجب أن تخرج كما يراها الزبون لا كما يراها التاجر. */}
        <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
          <p className="text-sm font-bold text-[var(--codiq-accent-strong)]">{KIND_LABELS[kind]} — {orderIds.length} طلب</p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} className="rounded-xl text-[var(--codiq-text-secondary)]">إغلاق</Button>
            <Button size="sm" onClick={() => window.print()} disabled={!sheet} className="rounded-xl"><Printer className="ml-1 h-4 w-4" /> طباعة</Button>
          </div>
        </div>

        {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)] print:hidden"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
        {!sheet && !failure ? <p className="text-sm text-[var(--codiq-text-muted)] print:hidden"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التجهيز…</p> : null}

        {sheet ? (
          <div className="space-y-4 text-[#12233C] print:space-y-0">
            {kind === "picking" ? <PickingList sheet={sheet} /> : sheet.orders.map((order) => (
              kind === "label" ? <Label key={order.id} sheet={sheet} order={order} /> : <Invoice key={order.id} sheet={sheet} order={order} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** كل مستند صفحة قائمة بذاتها: عنوان زبون مقصوص بين ورقتين هو طرد ضائع. */
const SHEET = "break-inside-avoid border border-[#D8DFEA] rounded-2xl p-4 print:rounded-none print:border-black/40 print:break-after-page print:last:break-after-auto";

function Header({ sheet }: { sheet: Sheet }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#D8DFEA] pb-2.5">
      <div>
        <p className="text-base font-black">{sheet.store.name}</p>
        <p className="text-[11px] text-[var(--codiq-text-secondary)]">{sheet.store.businessName}</p>
      </div>
      {sheet.store.contactPhone ? <p className="text-[11px] font-semibold text-[var(--codiq-text-secondary)]">للاستفسار: <Ltr>{sheet.store.contactPhone}</Ltr></p> : null}
    </div>
  );
}

function Address({ order }: { order: PrintOrder }) {
  return (
    <>
      <p className="text-lg font-black">{order.customerName}</p>
      <p className="mt-0.5 text-base font-bold"><Ltr>{order.recipientPhone}</Ltr></p>
      <p className="mt-1 text-sm font-semibold leading-6">{order.shippingGovernorate} — {order.shippingAddressLine1}{order.shippingAddressLine2 ? ` — ${order.shippingAddressLine2}` : ""}</p>
    </>
  );
}

function Label({ sheet, order }: { sheet: Sheet; order: PrintOrder }) {
  return (
    <article className={SHEET}>
      <Header sheet={sheet} />
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1"><Address order={order} /></div>
        <div className="shrink-0 text-left">
          <p className="text-[11px] font-semibold text-[var(--codiq-text-secondary)]">رقم الطلب</p>
          <p className="text-xl font-black"><Ltr>{order.orderNumber}</Ltr></p>
        </div>
      </div>
      {/* المبلغ المطلوب تحصيله هو الرقم الوحيد الذي يقرأه المندوب على الباب. */}
      <div className="mt-3 rounded-xl border-2 border-[#12233C] px-3.5 py-2.5">
        <p className="text-[11px] font-bold">المبلغ المطلوب تحصيله (الدفع عند الاستلام)</p>
        <p className="text-2xl font-black tabular-nums">{money.format(order.totalIqd)} د.ع</p>
      </div>
      {order.customerNote ? (
        <p className="mt-2.5 rounded-xl border border-dashed border-[#12233C]/50 px-3 py-2 text-[13px] font-semibold leading-6">
          ملاحظة الزبون: {order.customerNote}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-[var(--codiq-text-secondary)]">{order.items.reduce((count, item) => count + item.quantity, 0)} قطعة · {stamp(order.createdAt)}</p>
    </article>
  );
}

function Invoice({ sheet, order }: { sheet: Sheet; order: PrintOrder }) {
  return (
    <article className={SHEET}>
      <Header sheet={sheet} />
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><Address order={order} /></div>
        <div className="text-left text-[11px] font-semibold text-[var(--codiq-text-secondary)]">
          <p>فاتورة رقم <Ltr>{order.orderNumber}</Ltr></p>
          <p className="mt-0.5">{stamp(order.createdAt)}</p>
        </div>
      </div>
      <table className="mt-3 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-y border-[#D8DFEA] text-[11px] text-[var(--codiq-text-secondary)]">
            <th className="py-1.5 text-start font-semibold">الصنف</th>
            <th className="py-1.5 text-center font-semibold">الكمية</th>
            <th className="py-1.5 text-end font-semibold">السعر</th>
            <th className="py-1.5 text-end font-semibold">المجموع</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b border-[var(--codiq-neutral-soft)]">
              <td className="py-1.5 text-start font-semibold">{item.productName}{item.variantName ? <span className="text-[var(--codiq-text-secondary)]"> — {item.variantName}</span> : null}</td>
              <td className="py-1.5 text-center tabular-nums">{money.format(item.quantity)}</td>
              <td className="py-1.5 text-end tabular-nums">{money.format(item.unitPriceIqd)}</td>
              <td className="py-1.5 text-end font-bold tabular-nums">{money.format(item.lineTotalIqd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-2.5 ms-auto w-full max-w-[280px] space-y-1 text-[13px]">
        <Row label="المجموع" value={`${money.format(order.subtotalIqd)} د.ع`} />
        <Row label="التوصيل" value={`${money.format(order.deliveryFeeIqd)} د.ع`} />
        {order.discountIqd > 0 ? <Row label={`الخصم${order.couponCode ? ` (${order.couponCode})` : ""}`} value={`− ${money.format(order.discountIqd)} د.ع`} /> : null}
        {order.loyaltyDiscountIqd > 0 ? <Row label={`خصم النقاط${order.loyaltyPointsSpent ? ` (${order.loyaltyPointsSpent} نقطة)` : ""}`} value={`− ${money.format(order.loyaltyDiscountIqd)} د.ع`} /> : null}
        {order.platformDiscountIqd ? <Row label="كوبون السوق (تتحمّله المنصّة)" value={`− ${money.format(order.platformDiscountIqd)} د.ع`} /> : null}
        <div className="flex items-baseline justify-between border-t border-[#12233C] pt-1.5">
          <dt className="text-sm font-black">الإجمالي</dt>
          <dd className="text-base font-black tabular-nums">{money.format(order.totalIqd)} د.ع</dd>
        </div>
      </dl>
      {order.customerNote ? <p className="mt-2 text-[12px] leading-6 text-[#3A4A63]">ملاحظة الزبون: {order.customerNote}</p> : null}
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between"><dt className="text-[var(--codiq-text-secondary)]">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>;
}

function PickingList({ sheet }: { sheet: Sheet }) {
  return (
    <article className={SHEET}>
      <Header sheet={sheet} />
      <p className="mt-3 text-sm font-black">قائمة تجهيز — {money.format(sheet.totals.orders)} طلب · {money.format(sheet.totals.units)} قطعة</p>
      <p className="text-[11px] text-[var(--codiq-text-secondary)]">مجمّعة عبر الطلبات المحددة: كل صنف مرة واحدة بمجموع كميته.</p>
      <table className="mt-2.5 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-y border-[#D8DFEA] text-[11px] text-[var(--codiq-text-secondary)]">
            <th className="w-10 py-1.5 text-center font-semibold">✓</th>
            <th className="py-1.5 text-start font-semibold">الصنف</th>
            <th className="py-1.5 text-start font-semibold">SKU</th>
            <th className="py-1.5 text-end font-semibold">الكمية</th>
          </tr>
        </thead>
        <tbody>
          {sheet.picking.map((line) => (
            <tr key={line.key} className="border-b border-[var(--codiq-neutral-soft)]">
              {/* مربع فارغ يُعلَّم بالقلم: الورقة أداة عمل لا تقرير. */}
              <td className="py-2 text-center"><span className="inline-block h-4 w-4 border border-[#12233C]" /></td>
              <td className="py-2 text-start font-semibold">{line.productName}{line.variantName ? <span className="text-[var(--codiq-text-secondary)]"> — {line.variantName}</span> : null}</td>
              <td className="py-2 text-start text-[11px] text-[var(--codiq-text-secondary)]">{line.sku ? <Ltr>{line.sku}</Ltr> : "—"}</td>
              <td className="py-2 text-end text-base font-black tabular-nums">{money.format(line.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2.5 text-[12px] font-semibold">إجمالي التحصيل المتوقع: <span className="tabular-nums">{money.format(sheet.totals.collectIqd)} د.ع</span></p>
    </article>
  );
}
