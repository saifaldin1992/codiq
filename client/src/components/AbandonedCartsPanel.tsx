/**
 * codiq phase 20B-2 — «السلات المتروكة» (D-24).
 * Configuration (opt-in toggle default OFF, window 1–72h, recovery coupon)
 * writes behind settings.manage; the live list + stats read behind
 * customers.view — a staff session missing one side sees the other honestly.
 * Guests are NEVER messaged (no contact channel) and the copy says so; the
 * «استُردت» stat is labeled as correlation («تحوّلت بعد الرسالة»), not causation.
 */
import { CircleAlert, LoaderCircle, MailCheck, RefreshCw, Save, ShoppingCart, TicketPercent, UserRound, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LoadMoreButton } from "@/components/LoadMoreButton";
import { Button } from "@/components/ui/button";

type Settings = { masterEnabled: boolean; enabled: boolean; windowHours: number; recoveryCouponId: string | null; recoveryCouponCode: string | null; recoveryCouponActive: boolean | null };
type CouponOption = { id: string; code: string; isActive: boolean };
type CartRow = { id: string; ownerKind: string; customerName: string | null; hasEmail: boolean; itemCount: number; totalIqd: number; lastActivityAt: string; message: { status: string; createdAt: string } | null };
type PanelData = { windowHours: number; carts: CartRow[]; stats: { sent: number; recovered: number } };

const number = new Intl.NumberFormat("ar-IQ");
const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "تعذر تنفيذ الطلب.");
  return body as T;
}

const inputClass = "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3.5 py-2.5 text-sm text-[var(--codiq-text)] outline-none transition focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10";

export function AbandonedCartsPanel({ storeSlug }: { storeSlug?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDenied, setSettingsDenied] = useState(false);
  const [coupons, setCoupons] = useState<CouponOption[]>([]);
  const [panel, setPanel] = useState<PanelData | null>(null);
  // 20-2: the recovery list was capped at 100 carts with no page 2, and a busy
  // shop abandons more than that in a day.
  const [cartsCursor, setCartsCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [panelDenied, setPanelDenied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [windowDraft, setWindowDraft] = useState("12");
  const [couponDraft, setCouponDraft] = useState("");
  const marketingBase = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/marketing` : null;

  const load = useCallback(async (cursor?: string) => {
    if (!marketingBase) return;
    if (cursor) setLoadingMore(true);
    setFailure(null);
    // The two guards are independent: settings.manage may be denied while
    // customers.view is granted (and vice versa) — each side degrades alone.
    try {
      const result = await api<{ settings: Settings }>(`${marketingBase}/abandoned-carts/settings`);
      setSettings(result.settings);
      setWindowDraft(String(result.settings.windowHours));
      setCouponDraft(result.settings.recoveryCouponId ?? "");
      setSettingsDenied(false);
      try {
        const couponsResult = await api<{ coupons: CouponOption[] }>(`${marketingBase}/coupons?limit=100`);
        setCoupons(couponsResult.coupons.filter((coupon) => coupon.isActive));
      } catch { setCoupons([]); }
    } catch (error) {
      if (error instanceof ApiError && error.code === "STAFF_PERMISSION_DENIED") { setSettings(null); setSettingsDenied(true); }
      else setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await api<PanelData & { storeSlug: string; nextCursor: string | null }>(`${marketingBase}/abandoned-carts?${query.toString()}`);
      setPanel((current) => ({
        windowHours: result.windowHours,
        carts: cursor && current ? [...current.carts, ...result.carts] : result.carts,
        stats: result.stats,
      }));
      setCartsCursor(result.nextCursor);
      setPanelDenied(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === "STAFF_PERMISSION_DENIED") { setPanel(null); setPanelDenied(true); }
      else setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingMore(false);
    }
  }, [marketingBase]);

  useEffect(() => { void load(); }, [load]);

  async function save(next: { enabled?: boolean; windowHours?: number; recoveryCouponId?: string | null }) {
    if (!marketingBase) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ settings: Settings }>(`${marketingBase}/abandoned-carts/settings`, { method: "PUT", body: JSON.stringify(next) });
      setSettings(result.settings);
      setWindowDraft(String(result.settings.windowHours));
      setCouponDraft(result.settings.recoveryCouponId ?? "");
      setNotice("حُفظت إعدادات استرداد السلات.");
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  if (!storeSlug) {
    return <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 text-sm font-semibold text-[var(--codiq-danger)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]" dir="rtl">افتح اللوحة عبر مسار متجر محدد قبل إدارة السلات المتروكة.</div>;
  }

  return (
    <div className="max-w-[1030px] space-y-5" dir="rtl">
      {failure ? <p data-testid="abandoned-error" className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p data-testid="abandoned-notice" className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><MailCheck className="h-4 w-4" /> رسائل الاسترداد (تُرسل عبر صندوق الإشعارات الموثوق)</p>
        <h2 className="mb-1 text-xl font-bold text-[#263650]">تفعيل رسائل السلات المتروكة</h2>
        <p className="mb-5 text-sm leading-6 text-[var(--codiq-text-muted)]">رسالة تسويقية واحدة لكل سلة — للأبد — تصل الزبائن المسجلين بعناوين بريد فقط. الضيوف لا وسيلة تواصل معهم فلا يُراسَلون أبداً؛ يظهرون هنا إحصائياً فقط. الميزة معطلة افتراضياً (opt-in).</p>
        {settingsDenied ? <p className="rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-sm font-semibold text-[#65748B]">هذه الجلسة لا تملك صلاحية إدارة الإعدادات (settings.manage)؛ القائمة والإحصاءات أدناه متاحة لصلاحية عرض العملاء.</p> : null}
        {settings === null && !settingsDenied && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
        {settings ? (
          <div className="space-y-4">
            {!settings.masterEnabled ? <p className="rounded-2xl bg-[var(--codiq-warning-soft)] px-4 py-3 text-xs font-semibold leading-6 text-[#A76B13]">مفتاح الإشعارات الرئيسي للمتجر معطل — لن تُرسل أي رسالة حتى تفعيله من «الإعدادات ← الإشعارات».</p> : null}
            <label className="flex items-center justify-between rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3">
              <span className="text-sm font-bold text-[#33435D]">إرسال رسالة استرداد للسلات المتروكة</span>
              <input data-testid="abandoned-enable" type="checkbox" className="h-5 w-5 accent-[var(--codiq-accent)]" checked={settings.enabled} disabled={busy} onChange={(event) => void save({ enabled: event.target.checked })} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-right">
                <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]">نافذة الترك (بالساعات، 1–72 — الافتراضي 12)</span>
                <div className="flex gap-2">
                  <input data-testid="abandoned-window" type="number" min={1} max={72} value={windowDraft} onChange={(event) => setWindowDraft(event.target.value)} className={inputClass} />
                  <Button type="button" disabled={busy} data-testid="abandoned-window-save" variant="outline" className="rounded-xl" onClick={() => void save({ windowHours: Number(windowDraft) })}><Save className="ml-1 h-3.5 w-3.5" />حفظ</Button>
                </div>
              </label>
              <label className="block text-right">
                <span className="mb-1.5 block text-xs font-bold text-[var(--codiq-text-secondary)]"><TicketPercent className="ml-1 inline h-3.5 w-3.5" />كوبون الحافز (اختياري — كوبونات المتجر الفعّالة فقط)</span>
                <div className="flex gap-2">
                  <select data-testid="abandoned-coupon" value={couponDraft} onChange={(event) => setCouponDraft(event.target.value)} className={inputClass}>
                    <option value="">بلا كوبون</option>
                    {coupons.map((coupon) => <option key={coupon.id} value={coupon.id}>{coupon.code}</option>)}
                  </select>
                  <Button type="button" disabled={busy} data-testid="abandoned-coupon-save" variant="outline" className="rounded-xl" onClick={() => void save({ recoveryCouponId: couponDraft || null })}><Save className="ml-1 h-3.5 w-3.5" />حفظ</Button>
                </div>
                {settings.recoveryCouponCode ? <span className="mt-1.5 block text-[11px] text-[#8994A8]">الكوبون الحالي: <b dir="ltr">{settings.recoveryCouponCode}</b>{settings.recoveryCouponActive === false ? " — أُوقف؛ لن يُرفق بالرسائل القادمة." : ""}</span> : null}
              </label>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><ShoppingCart className="h-4 w-4" /> السلات المتروكة الآن {panel ? `(نافذة ${number.format(panel.windowHours)} ساعة)` : ""}</p>
            <p className="mt-1 text-xs leading-5 text-[#8994A8]">تشمل الزبائن والضيوف؛ الضيوف يُعدّون إحصائياً فقط ولا تُرسل لهم رسائل.</p>
          </div>
          <Button data-testid="abandoned-refresh" variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
        </div>
        {panelDenied ? <p className="rounded-2xl bg-[var(--codiq-neutral-soft)] px-4 py-3 text-sm font-semibold text-[#65748B]">هذه الجلسة لا تملك صلاحية عرض العملاء (customers.view) المطلوبة لقائمة السلات.</p> : null}
        {panel ? (
          <>
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3.5">
                <p className="text-[11px] font-semibold text-[#8994A8]">رسائل استرداد أُنشئت</p>
                <p data-testid="abandoned-stat-sent" className="mt-1 text-2xl font-bold text-[#15233E]">{number.format(panel.stats.sent)}</p>
              </div>
              <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-3.5">
                <p className="text-[11px] font-semibold text-[#8994A8]">سلات تحوّلت بعد الرسالة <span className="font-normal">(ارتباط زمني، لا يثبت السببية)</span></p>
                <p data-testid="abandoned-stat-recovered" className="mt-1 text-2xl font-bold text-[var(--codiq-success)]">{number.format(panel.stats.recovered)}</p>
              </div>
            </div>
            {panel.carts.length === 0 ? <p data-testid="abandoned-empty" className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)]">لا سلات متروكة ضمن النافذة الحالية — ممتاز.</p> : null}
            <div className="space-y-2">
              {panel.carts.map((cart) => (
                <div key={cart.id} data-testid={`abandoned-cart-${cart.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-bold text-[#263650]">
                      {cart.ownerKind === "customer" ? <UserRound className="h-4 w-4 text-[var(--codiq-accent)]" /> : <UsersRound className="h-4 w-4 text-[#8994A8]" />}
                      {cart.ownerKind === "customer" ? cart.customerName ?? "زبون مسجل" : "ضيف — بلا وسيلة تواصل"}
                      {cart.ownerKind === "customer" && !cart.hasEmail ? <span className="rounded-full bg-[var(--codiq-warning-soft)] px-2 py-0.5 text-[10px] font-bold text-[#A76B13]">بلا بريد — لا تُراسَل</span> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--codiq-text-muted)]">{number.format(cart.itemCount)} منتج · {number.format(cart.totalIqd)} د.ع · آخر نشاط {dateTime.format(new Date(cart.lastActivityAt))}</p>
                  </div>
                  {cart.message ? <span className="rounded-full bg-[var(--codiq-success-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-success)]">رسالة استرداد أُنشئت</span> : <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-bold text-[#65748B]">{cart.ownerKind === "customer" && cart.hasEmail ? "بانتظار الماسح الدوري" : "إحصائية فقط"}</span>}
                </div>
              ))}
            </div>
            <LoadMoreButton cursor={cartsCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="abandoned-carts-more" />
          </>
        ) : null}
        {panel === null && !panelDenied && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      </div>
    </div>
  );
}
