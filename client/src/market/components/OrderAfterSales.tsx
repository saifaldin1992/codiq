/**
 * Marketplace M6 — the after-sales block on one order: the receipt code to hand
 * over, cancelling with a reason, rating, asking for a return.
 */
import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, RotateCcw, Star, XCircle } from "lucide-react";
import { accountCall } from "../market-shopper";

export type AfterSales = {
  deliveryStage: { code: string; label: string } | null;
  cancelReason: string | null;
  handoverCode: string | null;
  canCancel: boolean;
  canRate: boolean;
  rateBy: string | null;
  rating: { storeStars: number; deliveryStars: number | null; tags: string[]; tagLabels: string[]; note: string | null } | null;
  canReturn: boolean;
  returnBy: string | null;
  returnRequest: { id: string; status: string; reason: string; decisionNote: string | null; decidedAt: string | null; createdAt: string } | null;
};
type Reason = { code: string; label: string };
export type AfterSalesOptions = { cancelReasons: Reason[]; returnReasons: Reason[]; ratingTags: Reason[]; ratingWindowDays: number; returnWindowDays: number };

let optionsRequest: Promise<AfterSalesOptions> | null = null;
export function loadAfterSalesOptions() {
  optionsRequest ??= accountCall<AfterSalesOptions>("/api/market/after-sales/options").catch((error) => { optionsRequest = null; throw error; });
  return optionsRequest;
}

const card = "space-y-3 rounded-[24px] bg-[var(--codiq-surface)] p-4 shadow-sm";
const primary = "flex w-full items-center justify-center gap-2 rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-bold text-[var(--codiq-surface)] disabled:opacity-60";
const secondary = "flex w-full items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-2.5 text-sm font-bold text-[var(--codiq-text)]";

function Failure({ text }: { text: string | null }) {
  return text ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-after-sales-error"><CircleAlert className="h-4 w-4 shrink-0" /> {text}</p> : null;
}

function ReasonList({ reasons, value, onChange, name }: { reasons: Reason[]; value: string; onChange: (code: string) => void; name: string }) {
  return (
    <div className="space-y-1.5" role="radiogroup">
      {reasons.map((reason) => (
        <label key={reason.code} className={`flex cursor-pointer items-center gap-2 rounded-2xl border px-3 py-2.5 text-sm ${value === reason.code ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] font-bold text-[var(--codiq-text)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`}>
          <input type="radio" name={name} value={reason.code} checked={value === reason.code} onChange={() => onChange(reason.code)} className="accent-[var(--codiq-accent)]" data-testid={`${name}-${reason.code}`} />
          {reason.label}
        </label>
      ))}
    </div>
  );
}

export function Stars({ value, onChange, label, testId }: { value: number; onChange?: (stars: number) => void; label: string; testId?: string }) {
  return (
    <div className="flex items-center gap-1" role={onChange ? "radiogroup" : "img"} aria-label={`${label}: ${value.toLocaleString("ar-IQ")} من ٥`} data-testid={testId}>
      {[1, 2, 3, 4, 5].map((stars) => {
        const on = stars <= value;
        const icon = <Star className={`h-7 w-7 ${on ? "fill-[var(--codiq-warning)] text-[var(--codiq-warning)]" : "text-[var(--codiq-border)]"}`} />;
        return onChange
          ? <button key={stars} type="button" role="radio" aria-checked={stars === value} aria-label={`${stars.toLocaleString("ar-IQ")} نجوم`} onClick={() => onChange(stars)} data-testid={testId ? `${testId}-${stars}` : undefined}>{icon}</button>
          : <span key={stars}>{icon}</span>;
      })}
    </div>
  );
}

/** Four big digits and a QR of them: the courier or the counter types them in. */
export function HandoverCode({ code, pickup }: { code: string; pickup: boolean }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import("qrcode").then(({ toDataURL }) => toDataURL(code, { margin: 1, width: 160 })).then((url) => { if (live) setQr(url); }).catch(() => undefined);
    return () => { live = false; };
  }, [code]);
  return (
    <section className={`${card} text-center`} data-testid="market-handover">
      <p className="text-sm font-black text-[var(--codiq-text)]">رمز الاستلام</p>
      <p className="text-xs text-[var(--codiq-text-secondary)]">{pickup ? "اعرضه على موظّف المتجر عند الاستلام." : "أعطه للمندوب عند استلام طلبك، ولا تشاركه قبل ذلك."}</p>
      <p dir="ltr" className="text-4xl font-black tracking-[0.4em] text-[var(--codiq-accent)]" data-testid="market-handover-code">{code}</p>
      {qr ? <img src={qr} alt={`رمز الاستلام ${code}`} className="mx-auto h-32 w-32 rounded-xl" /> : null}
    </section>
  );
}

export function CancelOrder({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AfterSalesOptions | null>(null);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) void loadAfterSalesOptions().then(setOptions).catch((error: Error) => setFailure(error.message)); }, [open]);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className={`${secondary} text-[var(--codiq-danger)]`} data-testid="market-order-cancel"><XCircle className="h-4 w-4" /> إلغاء الطلب</button>;
  async function submit() {
    setBusy(true); setFailure(null);
    try {
      await accountCall(`/api/market/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", body: JSON.stringify({ reasonCode: reason, details: details.trim() || undefined }) });
      onDone();
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className={card} data-testid="market-cancel-form">
      <p className="text-sm font-black text-[var(--codiq-text)]">لماذا تريد إلغاء الطلب؟</p>
      {options ? <ReasonList reasons={options.cancelReasons} value={reason} onChange={setReason} name="cancel-reason" /> : <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-[var(--codiq-text-muted)]" />}
      <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={500} rows={2} placeholder="تفاصيل إضافيّة (اختياريّ)" className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm text-[var(--codiq-text)]" />
      <Failure text={failure} />
      <button type="button" disabled={!reason || busy} onClick={() => void submit()} className={`${primary} bg-[var(--codiq-danger)]`} data-testid="market-cancel-submit">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} تأكيد الإلغاء</button>
      <button type="button" onClick={() => setOpen(false)} className={secondary}>تراجع</button>
    </section>
  );
}

type RatableItem = { productId: string | null; productName: string };

export function RateOrder({ orderId, items, pickup, current, rateBy, onDone }: { orderId: string; items: RatableItem[]; pickup: boolean; current: AfterSales["rating"]; rateBy: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AfterSalesOptions | null>(null);
  const [storeStars, setStoreStars] = useState(current?.storeStars ?? 0);
  const [deliveryStars, setDeliveryStars] = useState(current?.deliveryStars ?? 0);
  const [tags, setTags] = useState<string[]>(current?.tags ?? []);
  const [note, setNote] = useState(current?.note ?? "");
  const products = Array.from(new Map(items.filter((item) => item.productId).map((item) => [item.productId as string, item.productName])).entries());
  const [productStars, setProductStars] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) void loadAfterSalesOptions().then(setOptions).catch((error: Error) => setFailure(error.message)); }, [open]);
  if (!open) {
    return (
      <section className={card} data-testid="market-rating-summary">
        {current ? (
          <>
            <p className="text-sm font-black text-[var(--codiq-text)]">تقييمك</p>
            <Stars value={current.storeStars} label="تقييم المتجر" />
            {current.tagLabels.length ? <p className="text-xs text-[var(--codiq-text-secondary)]">{current.tagLabels.join("، ")}</p> : null}
            {current.note ? <p className="text-xs text-[var(--codiq-text)]">{current.note}</p> : null}
            <button type="button" onClick={() => setOpen(true)} className={secondary} data-testid="market-order-rate">تعديل التقييم</button>
          </>
        ) : (
          <>
            <p className="text-sm font-black text-[var(--codiq-text)]">كيف كانت تجربتك؟</p>
            {rateBy ? <p className="text-xs text-[var(--codiq-text-muted)]">يمكنك التقييم حتّى {new Date(rateBy).toLocaleDateString("ar-IQ")}</p> : null}
            <button type="button" onClick={() => setOpen(true)} className={primary} data-testid="market-order-rate"><Star className="h-4 w-4" /> قيّم الطلب</button>
          </>
        )}
      </section>
    );
  }
  async function submit() {
    setBusy(true); setFailure(null);
    try {
      await accountCall(`/api/market/orders/${encodeURIComponent(orderId)}/rating`, {
        method: "PUT",
        body: JSON.stringify({ storeStars, deliveryStars: pickup || !deliveryStars ? null : deliveryStars, tags, note: note.trim() || undefined, products: Object.entries(productStars).map(([productId, stars]) => ({ productId, stars })) }),
      });
      setOpen(false);
      onDone();
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className={card} data-testid="market-rating-form">
      <p className="text-sm font-black text-[var(--codiq-text)]">قيّم المتجر</p>
      <Stars value={storeStars} onChange={setStoreStars} label="تقييم المتجر" testId="market-rate-store" />
      {!pickup ? <><p className="text-sm font-black text-[var(--codiq-text)]">قيّم التوصيل</p><Stars value={deliveryStars} onChange={setDeliveryStars} label="تقييم التوصيل" testId="market-rate-delivery" /></> : null}
      {options ? (
        <div className="flex flex-wrap gap-1.5">
          {options.ratingTags.map((tag) => {
            const on = tags.includes(tag.code);
            return <button key={tag.code} type="button" aria-pressed={on} onClick={() => setTags(on ? tags.filter((code) => code !== tag.code) : [...tags, tag.code])} className={`rounded-full px-3 py-1.5 text-xs font-bold ${on ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"}`} data-testid={`market-rate-tag-${tag.code}`}>{tag.label}</button>;
          })}
        </div>
      ) : null}
      {products.length ? (
        <div className="space-y-2 border-t border-[var(--codiq-border)] pt-3">
          <p className="text-sm font-black text-[var(--codiq-text)]">قيّم المنتجات</p>
          {products.map(([productId, name]) => (
            <div key={productId} className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-[var(--codiq-text)]">{name}</span>
              <Stars value={productStars[productId] ?? 0} onChange={(stars) => setProductStars({ ...productStars, [productId]: stars })} label={name} testId={`market-rate-product-${productId}`} />
            </div>
          ))}
        </div>
      ) : null}
      <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={3} placeholder="اكتب ملاحظتك (اختياريّ)" className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm text-[var(--codiq-text)]" data-testid="market-rate-note" />
      <Failure text={failure} />
      <button type="button" disabled={!storeStars || busy} onClick={() => void submit()} className={primary} data-testid="market-rate-submit">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} إرسال التقييم</button>
      <button type="button" onClick={() => setOpen(false)} className={secondary}>إلغاء</button>
    </section>
  );
}

const RETURN_STATUS: Record<string, string> = { requested: "قيد مراجعة المتجر", approved: "تمّت الموافقة على الإرجاع", rejected: "رفض المتجر الإرجاع", withdrawn: "سحبت الطلب" };

export function ReturnOrder({ orderId, state, onDone }: { orderId: string; state: AfterSales; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AfterSalesOptions | null>(null);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) void loadAfterSalesOptions().then(setOptions).catch((error: Error) => setFailure(error.message)); }, [open]);
  const request = state.returnRequest;
  async function call(init: RequestInit) {
    setBusy(true); setFailure(null);
    try {
      await accountCall(`/api/market/orders/${encodeURIComponent(orderId)}/return`, init);
      setOpen(false);
      onDone();
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  }
  const shown = request && request.status !== "withdrawn" ? (
    <section className={card} data-testid="market-return-status">
      <p className="text-sm font-black text-[var(--codiq-text)]">طلب الإرجاع: <span data-testid="market-return-status-label">{RETURN_STATUS[request.status] ?? request.status}</span></p>
      <p className="text-xs text-[var(--codiq-text-secondary)]">السبب: {request.reason}</p>
      {request.decisionNote ? <p className="text-xs text-[var(--codiq-text)]">ردّ المتجر: {request.decisionNote}</p> : null}
      {request.status === "approved" ? <p className="text-xs text-[var(--codiq-text-muted)]">سيتواصل معك المتجر لاستلام المنتج وردّ المبلغ.</p> : null}
      {request.status === "requested" ? <button type="button" disabled={busy} onClick={() => void call({ method: "DELETE" })} className={secondary} data-testid="market-return-withdraw">سحب طلب الإرجاع</button> : null}
      <Failure text={open ? null : failure} />
    </section>
  ) : null;
  if (!state.canReturn) return shown;
  if (!open) {
    return (
      <>
        {shown}
        <button type="button" onClick={() => setOpen(true)} className={secondary} data-testid="market-order-return"><RotateCcw className="h-4 w-4" /> طلب إرجاع</button>
        {state.returnBy ? <p className="text-center text-[11px] text-[var(--codiq-text-muted)]">الإرجاع متاح حتّى {new Date(state.returnBy).toLocaleDateString("ar-IQ")}</p> : null}
      </>
    );
  }
  return (
    <section className={card} data-testid="market-return-form">
      <p className="text-sm font-black text-[var(--codiq-text)]">ما سبب الإرجاع؟</p>
      {options ? <ReasonList reasons={options.returnReasons} value={reason} onChange={setReason} name="return-reason" /> : <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-[var(--codiq-text-muted)]" />}
      <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={500} rows={2} placeholder={reason === "other" ? "اكتب السبب" : "تفاصيل تساعد المتجر (اختياريّ)"} className="w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm text-[var(--codiq-text)]" data-testid="market-return-details" />
      <Failure text={failure} />
      <button type="button" disabled={!reason || (reason === "other" && !details.trim()) || busy} onClick={() => void call({ method: "POST", body: JSON.stringify({ reasonCode: reason, details: details.trim() || undefined }) })} className={primary} data-testid="market-return-submit">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} إرسال طلب الإرجاع</button>
      <button type="button" onClick={() => setOpen(false)} className={secondary}>إلغاء</button>
    </section>
  );
}
