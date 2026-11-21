/**
 * «كوبونات المنصّة والنقاط» — the owner's market coupons (the platform pays
 * them: the store is still paid in full) and what the programme costs.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

type Coupon = {
  id: string;
  code: string;
  title: string;
  kind: "percent" | "fixed";
  percentOff: number | null;
  amountOffIqd: number | null;
  maxDiscountIqd: number | null;
  minSubtotalIqd: number;
  startsAt: string;
  endsAt: string;
  totalLimit: number | null;
  issuedCount: number;
  pointsCost: number;
  allStores: boolean;
  isActive: boolean;
  stores: number;
  used: number;
  description: string | null;
};
type Report = {
  platformDiscountIqd: number;
  pointsOutstanding: number;
  couponsIssued: number;
  couponsUsed: number;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}
const input =
  "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card =
  "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";
const money = (value: number) => `${value.toLocaleString("ar-IQ")} د.ع`;
const EMPTY = {
  code: "",
  title: "",
  kind: "percent" as "percent" | "fixed",
  value: 10,
  maxDiscountIqd: "",
  minSubtotalIqd: "0",
  days: 30,
  totalLimit: "",
  pointsCost: "0",
  storeSlugs: "",
};

export function PlatformMarketCouponsPanel() {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCoupons((await call<{ coupons: Coupon[] }>("/api/platform/market/coupons")).coupons);
      setReport(await call<Report>("/api/platform/market/rewards/report"));
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const body = (coupon: Coupon, patch: Partial<Coupon>) => JSON.stringify({ ...coupon, ...patch });
  async function create() {
    const slugs = draft.storeSlugs
      .split(/[\s,،]+/)
      .map((slug) => slug.trim())
      .filter(Boolean);
    try {
      const made = await call<{ coupon: Coupon }>("/api/platform/market/coupons", {
        method: "POST",
        body: JSON.stringify({
          code: draft.code,
          title: draft.title,
          kind: draft.kind,
          percentOff: draft.kind === "percent" ? draft.value : null,
          amountOffIqd: draft.kind === "fixed" ? draft.value : null,
          maxDiscountIqd: draft.maxDiscountIqd ? Number(draft.maxDiscountIqd) : null,
          minSubtotalIqd: Number(draft.minSubtotalIqd) || 0,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + draft.days * 86_400_000).toISOString(),
          totalLimit: draft.totalLimit ? Number(draft.totalLimit) : null,
          pointsCost: Number(draft.pointsCost) || 0,
          allStores: slugs.length === 0,
          isActive: true,
        }),
      });
      if (slugs.length)
        await call(`/api/platform/market/coupons/${made.coupon.id}/stores`, {
          method: "PUT",
          body: JSON.stringify({ storeSlugs: slugs }),
        });
      setNotice(`أُنشئ الكوبون ${made.coupon.code}.`);
      setFailure(null);
      setDraft(EMPTY);
      await load();
    } catch (error) {
      setFailure((error as Error).message);
      setNotice(null);
    }
  }
  async function toggle(coupon: Coupon) {
    try {
      await call(`/api/platform/market/coupons/${coupon.id}`, {
        method: "PUT",
        body: body(coupon, { isActive: !coupon.isActive }),
      });
      await load();
    } catch (error) {
      setFailure((error as Error).message);
    }
  }
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-coupons">
      {report ? (
        <section className="grid gap-3 sm:grid-cols-4" data-testid="market-rewards-report">
          {[
            ["ما تحمّلته المنصّة", money(report.platformDiscountIqd)],
            ["كوبونات وُزّعت", report.couponsIssued.toLocaleString("ar-IQ")],
            ["كوبونات استُخدمت", report.couponsUsed.toLocaleString("ar-IQ")],
            ["نقاط في أرصدة المتسوّقين", report.pointsOutstanding.toLocaleString("ar-IQ")],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4"
            >
              <p className="text-xs text-[var(--codiq-text-muted)]">{label}</p>
              <p className="text-lg font-black text-[var(--codiq-text)]">{value}</p>
            </div>
          ))}
        </section>
      ) : null}
      {failure ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
          data-testid="market-coupons-admin-error"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="market-coupons-admin-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      <section className={card}>
        <h3 className="font-bold text-[var(--codiq-text)]">كوبون جديد</h3>
        <p className="text-xs text-[var(--codiq-text-muted)]">
          كوبون السوق على حساب المنصّة: يدفع المتسوّق أقلّ، ويُدفع للمتجر كامل المبلغ.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            value={draft.code}
            onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
            placeholder="الرمز (WELCOME10)"
            dir="ltr"
            className={input}
            data-testid="coupon-new-code"
          />
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="العنوان"
            className={input}
            data-testid="coupon-new-title"
          />
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value as "percent" | "fixed" })
            }
            className={input}
          >
            <option value="percent">نسبة %</option>
            <option value="fixed">مبلغ ثابت</option>
          </select>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            {draft.kind === "percent" ? "النسبة %" : "المبلغ (د.ع)"}
            <input
              type="number"
              min={1}
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })}
              className={input}
              data-testid="coupon-new-value"
            />
          </label>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            أقصى خصم (اختياريّ)
            <input
              type="number"
              min={1}
              value={draft.maxDiscountIqd}
              onChange={(event) => setDraft({ ...draft, maxDiscountIqd: event.target.value })}
              className={input}
            />
          </label>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            أقلّ طلب
            <input
              type="number"
              min={0}
              value={draft.minSubtotalIqd}
              onChange={(event) => setDraft({ ...draft, minSubtotalIqd: event.target.value })}
              className={input}
            />
          </label>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            صالح لمدّة (يوم)
            <input
              type="number"
              min={1}
              max={365}
              value={draft.days}
              onChange={(event) => setDraft({ ...draft, days: Number(event.target.value) })}
              className={input}
            />
          </label>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            الكمّيّة (اختياريّ)
            <input
              type="number"
              min={1}
              value={draft.totalLimit}
              onChange={(event) => setDraft({ ...draft, totalLimit: event.target.value })}
              className={input}
            />
          </label>
          <label className="text-xs text-[var(--codiq-text-secondary)]">
            سعره بالنقاط (٠ = مجّانيّ)
            <input
              type="number"
              min={0}
              value={draft.pointsCost}
              onChange={(event) => setDraft({ ...draft, pointsCost: event.target.value })}
              className={input}
              data-testid="coupon-new-points"
            />
          </label>
        </div>
        <input
          value={draft.storeSlugs}
          onChange={(event) => setDraft({ ...draft, storeSlugs: event.target.value })}
          placeholder="متاجر محدّدة (معرّفاتها، فارغ = كلّ المتاجر)"
          dir="ltr"
          className={input}
        />
        <Button
          disabled={!draft.code || !draft.title || !draft.value}
          onClick={() => void create()}
          data-testid="coupon-new-create"
        >
          <Plus className="h-4 w-4" /> إنشاء
        </Button>
      </section>
      <section className={card}>
        {!coupons ? (
          <LoaderCircle className="h-5 w-5 animate-spin" />
        ) : coupons.length === 0 ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">لا كوبونات بعد.</p>
        ) : (
          <ul className="divide-y divide-[var(--codiq-border)]">
            {coupons.map((coupon) => (
              <li
                key={coupon.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                data-testid={`coupon-admin-${coupon.code}`}
              >
                <span>
                  <span className="font-mono font-bold" dir="ltr">
                    {coupon.code}
                  </span>{" "}
                  — {coupon.title}
                  <span className="block text-xs text-[var(--codiq-text-muted)]">
                    {coupon.kind === "percent"
                      ? `${coupon.percentOff}%`
                      : money(coupon.amountOffIqd ?? 0)}
                    {coupon.pointsCost ? ` · ${coupon.pointsCost} نقطة` : ""} · وُزّع{" "}
                    {coupon.issuedCount}
                    {coupon.totalLimit ? ` من ${coupon.totalLimit}` : ""} · استُخدم {coupon.used}
                    {coupon.allStores ? "" : ` · ${coupon.stores} متجر`}
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => void toggle(coupon)}>
                  {coupon.isActive ? "إيقاف" : "تفعيل"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
