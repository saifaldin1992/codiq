/**
 * «عجلة الجوائز» — the owner's wheel: its settings, its prizes with weights and
 * stock (the only place they are shown), prizes to send, and a shopper's log
 * for support.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

type Prize = { id: string; label: string; kind: string; weight: number; stock: number | null; wonCount: number; points: number | null; couponId: string | null; position: number; isActive: boolean };
type Wheel = { id: string; slug: string; title: string; howToPlay: string | null; isOpen: boolean; startsAt: string; endsAt: string; dailyFreeSpins: number; iqdPerExtraSpin: number; maxExtraSpinsPerOrder: number; maxWinsPerShopper: number; claimDays: number; prizes: Prize[] };
type QueueWin = { id: string; statusLabel: string; status: string; prize: { label: string }; shopper: { name: string | null; phone: string }; address: { recipientName: string; phoneNormalized: string; addressLine: string; district: { nameAr: string } } | null };
type Coupon = { id: string; code: string; title: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}
const input = "w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm";
const card = "space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm";
const KIND: Record<string, string> = { nothing: "حظّ أوفر", points: "نقاط", coupon: "كوبون", physical: "جائزة عينيّة" };

export function PlatformMarketWheelPanel() {
  const [wheels, setWheels] = useState<Wheel[] | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [queue, setQueue] = useState<QueueWin[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prize, setPrize] = useState({ label: "", kind: "points", weight: 10, stock: "", points: "", couponId: "" });
  const [phone, setPhone] = useState("");
  const [report, setReport] = useState<{ spins: number; wins: Record<string, number> } | null>(null);
  const [support, setSupport] = useState<{ shopper: { fullName: string | null }; spins: { id: string; prizeLabel: string; at: string }[] } | null>(null);
  const wheel = wheels?.[0] ?? null;
  const load = useCallback(async () => {
    try {
      const body = await call<{ wheels: Wheel[] }>("/api/platform/market/wheels");
      setWheels(body.wheels);
      if (body.wheels[0]) {
        setQueue((await call<{ wins: QueueWin[] }>(`/api/platform/market/wheels/${body.wheels[0].id}/wins?status=shipping`)).wins);
        setReport(await call<{ spins: number; wins: Record<string, number> }>(`/api/platform/market/wheels/${body.wheels[0].id}/report`));
      }
      setCoupons((await call<{ coupons: Coupon[] }>("/api/platform/market/coupons")).coupons);
    } catch (error) { setFailure((error as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(action: () => Promise<unknown>, text: string) { try { await action(); setNotice(text); setFailure(null); await load(); } catch (error) { setFailure((error as Error).message); setNotice(null); } }
  const settings = (patch: Partial<Wheel>, fresh = false) => {
    const base = (fresh ? null : wheel) ?? { slug: "wheel", title: "عجلة الجوائز", howToPlay: null, isOpen: false, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), dailyFreeSpins: 1, iqdPerExtraSpin: 25000, maxExtraSpinsPerOrder: 3, maxWinsPerShopper: 3, claimDays: 7 };
    const { id: _id, prizes: _prizes, ...rest } = { id: "", prizes: [], ...base, ...patch } as Wheel;
    return JSON.stringify(rest);
  };
  if (!wheels) return <LoaderCircle className="h-5 w-5 animate-spin" />;
  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market-wheel">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-wheel-admin-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="market-wheel-admin-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-[var(--codiq-text-secondary)]">{wheel ? "تُدار هنا أحدث عجلة. عجلة جديدة تبدأ موسماً جديداً بجوائزه." : "لا عجلة بعد."}</p>
          <Button variant={wheel ? "outline" : "default"} onClick={() => void run(() => call("/api/platform/market/wheels", { method: "POST", body: settings({ slug: `wheel-${Date.now().toString(36)}` }, true) }), "أُنشئت العجلة (مسكّرة).")} data-testid="wheel-create"><Plus className="h-4 w-4" /> عجلة جديدة</Button>
        </div>
      </section>
      {!wheel ? null : (
        <>
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-bold text-[var(--codiq-text)]">{wheel.title}</h3>
              <Button variant={wheel.isOpen ? "outline" : "default"} onClick={() => void run(() => call(`/api/platform/market/wheels/${wheel.id}`, { method: "PUT", body: settings({ isOpen: !wheel.isOpen }) }), wheel.isOpen ? "سُكّرت العجلة." : "فُتحت العجلة.")} data-testid="wheel-toggle">{wheel.isOpen ? "تسكير العجلة" : "فتح العجلة"}</Button>
            </div>
            {report ? <p className="text-sm font-semibold text-[var(--codiq-text)]" data-testid="wheel-report">{report.spins.toLocaleString("ar-IQ")} لفّة · {Object.values(report.wins).reduce((sum, count) => sum + count, 0).toLocaleString("ar-IQ")} فوز ({(report.wins.pending ?? 0).toLocaleString("ar-IQ")} بانتظار الاستلام، {(report.wins.shipping ?? 0).toLocaleString("ar-IQ")} بالطريق)</p> : null}
            <p className="text-xs text-[var(--codiq-text-muted)]">لفّات يوميّة {wheel.dailyFreeSpins} · لفّة إضافيّة لكلّ {wheel.iqdPerExtraSpin.toLocaleString("ar-IQ")} د.ع (حتّى {wheel.maxExtraSpinsPerOrder} للطلب) · أقصى فوز {wheel.maxWinsPerShopper} · مهلة الاستلام {wheel.claimDays} يوم</p>
          </section>
          <section className={card} data-testid="wheel-prizes">
            <h3 className="font-bold text-[var(--codiq-text)]">الجوائز (الأوزان والمخزون لا تصل المتسوّق)</h3>
            <table className="w-full text-sm"><thead><tr className="text-right text-xs text-[var(--codiq-text-muted)]"><th>الجائزة</th><th>النوع</th><th>الوزن</th><th>الاحتمال</th><th>رُبح / المخزون</th><th /></tr></thead>
              <tbody>{wheel.prizes.map((row) => { const total = wheel.prizes.filter((entry) => entry.isActive).reduce((sum, entry) => sum + entry.weight, 0) || 1; return (
                <tr key={row.id} className="border-t border-[var(--codiq-border)]"><td className="py-2">{row.label}</td><td>{KIND[row.kind]}</td>
                  <td><input type="number" min={0} defaultValue={row.weight} onBlur={(event) => { const weight = Number(event.target.value); if (weight !== row.weight) void run(() => call(`/api/platform/market/wheel-prizes/${row.id}`, { method: "PUT", body: JSON.stringify({ ...row, weight }) }), "حُفظ الوزن."); }} className="w-20 rounded-lg border border-[var(--codiq-border)] px-2 py-1" /></td>
                  <td>{row.isActive ? `${Math.round((row.weight / total) * 1000) / 10}%` : "—"}</td><td>{row.wonCount}{row.stock !== null ? ` / ${row.stock}` : ""}</td>
                  <td><Button size="sm" variant="outline" onClick={() => void run(() => call(`/api/platform/market/wheel-prizes/${row.id}`, { method: "PUT", body: JSON.stringify({ ...row, isActive: !row.isActive }) }), "حُفظت الجائزة.")}>{row.isActive ? "إيقاف" : "تفعيل"}</Button></td></tr>
              ); })}</tbody></table>
            <div className="grid gap-2 sm:grid-cols-6">
              <input value={prize.label} onChange={(event) => setPrize({ ...prize, label: event.target.value })} placeholder="الاسم على العجلة" className={input} data-testid="prize-label" />
              <select value={prize.kind} onChange={(event) => setPrize({ ...prize, kind: event.target.value })} className={input} data-testid="prize-kind">{Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <input type="number" min={0} value={prize.weight} onChange={(event) => setPrize({ ...prize, weight: Number(event.target.value) })} placeholder="الوزن" className={input} data-testid="prize-weight" />
              {prize.kind === "nothing" ? <span /> : <input type="number" min={0} value={prize.stock} onChange={(event) => setPrize({ ...prize, stock: event.target.value })} placeholder="المخزون" className={input} data-testid="prize-stock" />}
              {prize.kind === "points" ? <input type="number" min={1} value={prize.points} onChange={(event) => setPrize({ ...prize, points: event.target.value })} placeholder="النقاط" className={input} data-testid="prize-points" />
                : prize.kind === "coupon" ? <select value={prize.couponId} onChange={(event) => setPrize({ ...prize, couponId: event.target.value })} className={input}><option value="">اختر كوبوناً</option>{coupons.map((coupon) => <option key={coupon.id} value={coupon.id}>{coupon.code} — {coupon.title}</option>)}</select> : <span />}
              <Button disabled={!prize.label} onClick={() => void run(() => call(`/api/platform/market/wheels/${wheel.id}/prizes`, { method: "POST", body: JSON.stringify({ label: prize.label, kind: prize.kind, weight: prize.weight, stock: prize.stock === "" ? null : Number(prize.stock), points: prize.points ? Number(prize.points) : null, couponId: prize.couponId || null, position: wheel.prizes.length }) }).then(() => setPrize({ label: "", kind: "points", weight: 10, stock: "", points: "", couponId: "" })), "أُضيفت الجائزة.")} data-testid="prize-add"><Plus className="h-4 w-4" /> إضافة</Button>
            </div>
          </section>
          <section className={card} data-testid="wheel-queue">
            <h3 className="font-bold text-[var(--codiq-text)]">جوائز للإرسال</h3>
            {queue.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا جوائز بانتظار الإرسال.</p> : (
              <ul className="divide-y divide-[var(--codiq-border)]">{queue.map((win) => (
                <li key={win.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{win.prize.label} — {win.address ? `${win.address.recipientName}، ${win.address.district.nameAr}، ${win.address.addressLine}` : win.shopper.phone}</span>
                  <span className="flex gap-2"><Button size="sm" onClick={() => void run(() => call(`/api/platform/market/wheel-wins/${win.id}/status`, { method: "POST", body: JSON.stringify({ status: "delivered" }) }), "عُلّمت كمستلَمة.")}>وصلت</Button><Button size="sm" variant="outline" onClick={() => { const note = window.prompt("سبب الإلغاء (يراه المتسوّق)"); if (note) void run(() => call(`/api/platform/market/wheel-wins/${win.id}/status`, { method: "POST", body: JSON.stringify({ status: "cancelled", note }) }), "أُلغيت الجائزة وعادت للمخزون."); }}>إلغاء</Button></span></li>
              ))}</ul>
            )}
          </section>
          <section className={card}>
            <h3 className="font-bold text-[var(--codiq-text)]">سجلّ متسوّق (للدعم)</h3>
            <div className="flex gap-2"><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="07XXXXXXXXX" dir="ltr" className={input} /><Button variant="outline" onClick={() => void call<NonNullable<typeof support>>(`/api/platform/market/wheel/support?phone=${encodeURIComponent(phone)}`).then(setSupport).catch((error: Error) => setFailure(error.message))}><Search className="h-4 w-4" /></Button></div>
            {support ? <ul className="text-xs text-[var(--codiq-text-secondary)]">{support.spins.map((row) => <li key={row.id}>{new Date(row.at).toLocaleString("ar-IQ")} — {row.prizeLabel}</li>)}</ul> : null}
          </section>
        </>
      )}
    </div>
  );
}
