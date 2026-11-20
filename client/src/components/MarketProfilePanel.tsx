/**
 * «السوق» — the merchant's side of the marketplace (docs/MARKETPLACE_PLAN.md M1):
 * whether his store is in the market, what is missing before he can ask, the
 * facts the directory shows (type, place, map point, pick-up, hours, cover),
 * and his reputation exactly as shoppers see it.
 */
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, CircleAlert, CircleCheck, Crosshair, ExternalLink, ImagePlus, LoaderCircle, Store, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Day = { weekday: number; opensAt: string | null; closesAt: string | null };
type BadgeView = { code: string; title: string; earned: boolean; level: string | null };
type Profile = {
  storeSlug: string;
  profile: {
    businessType: string | null; governorateKey: string | null; governorateName: string | null; districtId: number | null; districtName: string | null;
    latitude: number | null; longitude: number | null; pickupEnabled: boolean; logoUrl: string | null; coverUrl: string | null; openingHours: Day[];
  };
  listing: { status: "unlisted" | "pending" | "listed" | "rejected" | "delisted"; statusAt: string | null; note: string | null; listedAt: string | null; marketPath: string; ready: boolean; items: { code: string; title: string; done: boolean }[] };
  reputation: { score: number | null; tierLabel: string | null; rating: number | null; ratingCount: number; completedOrders: number; medianResponseMinutes: number | null; cancelRate: number | null };
  badges: BadgeView[];
};
type Geography = { governorates: { key: string; name: string; districts: { id: number; name: string }[] }[] };

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const STATUS: Record<Profile["listing"]["status"], { label: string; tone: string }> = {
  unlisted: { label: "غير معروض في السوق", tone: "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]" },
  pending: { label: "طلبك قيد المراجعة", tone: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" },
  listed: { label: "معروض في السوق", tone: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  rejected: { label: "رُفض الطلب", tone: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
  delisted: { label: "أُزيل من السوق", tone: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

type Draft = { businessType: string; governorateKey: string; districtId: string; latitude: string; longitude: string; pickupEnabled: boolean; hours: Day[] };

function draftOf(profile: Profile["profile"]): Draft {
  return {
    businessType: profile.businessType ?? "",
    governorateKey: profile.governorateKey ?? "",
    districtId: profile.districtId ? String(profile.districtId) : "",
    latitude: profile.latitude?.toString() ?? "",
    longitude: profile.longitude?.toString() ?? "",
    pickupEnabled: profile.pickupEnabled,
    hours: profile.openingHours,
  };
}

export function MarketProfilePanel({ storeSlug }: { storeSlug?: string }) {
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/market-profile` : null;
  const [data, setData] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [geo, setGeo] = useState<Geography | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const accept = useCallback((next: Profile) => { setData(next); setDraft(draftOf(next.profile)); }, []);

  useEffect(() => {
    if (!base) return;
    call<Profile>(base).then(accept).catch((error: Error) => setFailure(error.message));
    call<Geography>("/api/market/geo").then(setGeo).catch(() => undefined);
  }, [base, accept]);

  const run = async (label: string, work: () => Promise<Profile>, done: string) => {
    setBusy(label); setFailure(null); setNotice(null);
    try { accept(await work()); setNotice(done); } catch (error) { setFailure((error as Error).message); } finally { setBusy(null); }
  };

  if (!base) return <p className="text-sm text-[var(--codiq-text-muted)]">اختر متجراً أولاً.</p>;
  if (!data || !draft) return failure
    ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p>
    : <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;

  const districts = geo?.governorates.find((row) => row.key === draft.governorateKey)?.districts ?? [];
  const status = STATUS[data.listing.status];
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setDay = (weekday: number, patch: Partial<Day>) => set({ hours: draft.hours.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day)) });

  const save = () => run("save", () => call<Profile>(base, {
    method: "PUT",
    body: JSON.stringify({
      businessType: draft.businessType.trim() || null,
      governorateKey: draft.governorateKey || null,
      districtId: draft.districtId ? Number(draft.districtId) : null,
      latitude: draft.latitude.trim() ? Number(draft.latitude) : null,
      longitude: draft.longitude.trim() ? Number(draft.longitude) : null,
      pickupEnabled: draft.pickupEnabled,
      openingHours: draft.hours.filter((day) => day.opensAt && day.closesAt).map((day) => ({ weekday: day.weekday, opensAt: day.opensAt, closesAt: day.closesAt })),
    }),
  }), "حُفظ ملفّ السوق.");

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (position) => set({ latitude: position.coords.latitude.toFixed(6), longitude: position.coords.longitude.toFixed(6) }),
      () => setFailure("تعذّر تحديد موقعك. اكتب الإحداثيّات يدوياً أو فعّل صلاحيّة الموقع."),
    );
  };

  const uploadCover = (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("image", file);
    void run("cover", () => call<Profile>(`${base}/cover`, { method: "POST", body: form }), "رُفعت صورة الغلاف.");
  };

  return (
    <div className="max-w-[860px] space-y-5" data-testid="market-profile-panel">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]" data-testid="market-profile-error"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]" data-testid="market-profile-notice"><CircleCheck className="h-4 w-4" /> {notice}</p> : null}

      <section className="space-y-4 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Store className="h-5 w-5 text-[var(--codiq-accent)]" />
            <p className="text-base font-bold text-[var(--codiq-text)]">متجرك في السوق</p>
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.tone}`} data-testid="market-listing-status">{status.label}</span>
          </div>
          {data.listing.status === "listed" ? (
            <a href={data.listing.marketPath} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--codiq-accent)]"><ExternalLink className="h-4 w-4" /> صفحتك في السوق</a>
          ) : null}
        </div>
        {data.listing.note ? <p className="rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-sm text-[var(--codiq-danger)]" data-testid="market-listing-note">ملاحظة الإدارة: {data.listing.note}</p> : null}
        <p className="text-sm leading-6 text-[var(--codiq-text-secondary)]">
          السوق يعرض متجرك مع كل متاجر المنصّة، فيصلك زبائن لم يسمعوا بك. يُراجع فريق المنصّة طلبك قبل ظهور المتجر.
        </p>
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="market-readiness">
          {data.listing.items.map((item) => (
            <li key={item.code} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${item.done ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}>
              {item.done ? <CircleCheck className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />} {item.title}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {["unlisted", "rejected", "delisted"].includes(data.listing.status) ? (
            <Button disabled={!data.listing.ready || busy !== null} onClick={() => void run("request", () => call<Profile>(`${base}/listing`, { method: "POST" }), "أُرسل طلبك. سنراجعه قريباً.")} data-testid="market-request-listing">
              {busy === "request" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} اطلب الانضمام إلى السوق
            </Button>
          ) : (
            <Button variant="outline" disabled={busy !== null} onClick={() => void run("leave", () => call<Profile>(`${base}/listing`, { method: "DELETE" }), data.listing.status === "pending" ? "سُحب طلبك." : "أُخفي متجرك من السوق.")} data-testid="market-leave">
              {data.listing.status === "pending" ? "اسحب الطلب" : "أخفِ متجري من السوق"}
            </Button>
          )}
          {!data.listing.ready && ["unlisted", "rejected", "delisted"].includes(data.listing.status) ? <p className="self-center text-xs text-[var(--codiq-text-muted)]">أكمل البنود أعلاه أولاً.</p> : null}
        </div>
      </section>

      <section className="space-y-4 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <p className="text-base font-bold text-[var(--codiq-text)]">ما يراه الزبون عن متجرك</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-semibold text-[var(--codiq-text)]">نوع النشاط</span>
            <input value={draft.businessType} onChange={(event) => set({ businessType: event.target.value })} maxLength={40} placeholder="مثال: أجهزة ذكية، ملابس رجالية" className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2" data-testid="market-business-type" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-sm">
              <span className="font-semibold text-[var(--codiq-text)]">المحافظة</span>
              <select value={draft.governorateKey} onChange={(event) => set({ governorateKey: event.target.value, districtId: "" })} className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2" data-testid="market-governorate">
                <option value="">اختر</option>
                {geo?.governorates.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-semibold text-[var(--codiq-text)]">المنطقة</span>
              <select value={draft.districtId} onChange={(event) => set({ districtId: event.target.value })} disabled={!draft.governorateKey} className="w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2" data-testid="market-district">
                <option value="">{draft.governorateKey ? "اختر" : "اختر المحافظة أولاً"}</option>
                {districts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-[var(--codiq-text)]">موقع المتجر على الخريطة <span className="font-normal text-[var(--codiq-text-muted)]">(لـ«بالقرب منك» والاستلام)</span></p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={draft.latitude} onChange={(event) => set({ latitude: event.target.value })} inputMode="decimal" placeholder="خطّ العرض" dir="ltr" className="w-36 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm" data-testid="market-latitude" />
            <input value={draft.longitude} onChange={(event) => set({ longitude: event.target.value })} inputMode="decimal" placeholder="خطّ الطول" dir="ltr" className="w-36 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-sm" data-testid="market-longitude" />
            <Button type="button" variant="outline" onClick={locate}><Crosshair className="h-4 w-4" /> موقعي الحاليّ</Button>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--codiq-text)]">
            <input type="checkbox" checked={draft.pickupEnabled} onChange={(event) => set({ pickupEnabled: event.target.checked })} data-testid="market-pickup" /> الزبون يستطيع استلام طلبه من المتجر
          </label>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-[var(--codiq-text)]">أوقات الدوام <span className="font-normal text-[var(--codiq-text-muted)]">(اترك اليوم فارغاً إن كان عطلة)</span></p>
          <ul className="space-y-1.5" data-testid="market-hours">
            {draft.hours.map((day) => (
              <li key={day.weekday} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex w-28 items-center gap-2">
                  <input type="checkbox" checked={day.opensAt !== null} onChange={(event) => setDay(day.weekday, event.target.checked ? { opensAt: "09:00", closesAt: "21:00" } : { opensAt: null, closesAt: null })} data-testid={`market-hours-open-${day.weekday}`} />
                  {WEEKDAYS[day.weekday]}
                </label>
                {day.opensAt !== null ? (
                  <>
                    <input type="time" value={day.opensAt} onChange={(event) => setDay(day.weekday, { opensAt: event.target.value })} className="rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 py-1" aria-label={`فتح ${WEEKDAYS[day.weekday]}`} />
                    <span className="text-[var(--codiq-text-muted)]">إلى</span>
                    <input type="time" value={day.closesAt ?? ""} onChange={(event) => setDay(day.weekday, { closesAt: event.target.value })} className="rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 py-1" aria-label={`إغلاق ${WEEKDAYS[day.weekday]}`} />
                  </>
                ) : <span className="text-[var(--codiq-text-muted)]">مغلق</span>}
              </li>
            ))}
          </ul>
        </div>
        <Button onClick={() => void save()} disabled={busy !== null} data-testid="market-profile-save">{busy === "save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} حفظ</Button>
      </section>

      <section className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <p className="text-base font-bold text-[var(--codiq-text)]">صورة الغلاف</p>
        <div className="h-32 overflow-hidden rounded-2xl bg-[var(--codiq-accent-soft)]">{data.profile.coverUrl ? <img src={data.profile.coverUrl} alt="" className="h-full w-full object-cover" /> : null}</div>
        <div className="flex gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-[var(--codiq-border)] px-3 py-2 text-sm font-semibold text-[var(--codiq-text)]">
            <ImagePlus className="h-4 w-4" /> {data.profile.coverUrl ? "تغيير الصورة" : "رفع صورة"}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => uploadCover(event.target.files?.[0])} data-testid="market-cover-input" />
          </label>
          {data.profile.coverUrl ? <Button variant="outline" onClick={() => void run("cover", () => call<Profile>(`${base}/cover`, { method: "DELETE" }), "حُذفت صورة الغلاف.")}><Trash2 className="h-4 w-4" /> حذف</Button> : null}
        </div>
        <p className="text-xs text-[var(--codiq-text-muted)]">تظهر الصورة الغلاف خلف شعار متجرك في السوق. لا يظهر الغلاف قبل قبول متجرك في السوق.</p>
      </section>

      <section className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm" data-testid="market-reputation">
        <p className="text-base font-bold text-[var(--codiq-text)]">سمعتك في السوق</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="النتيجة العامّة" value={data.reputation.score !== null ? `${Math.round(data.reputation.score)} / 100` : "لم تُحتسب بعد"} />
          <Fact label="المستوى" value={data.reputation.tierLabel ?? "—"} />
          <Fact label="وقت الاستجابة" value={data.reputation.medianResponseMinutes !== null ? `${data.reputation.medianResponseMinutes} دقيقة` : "—"} />
          <Fact label="نسبة الإلغاء" value={data.reputation.cancelRate !== null ? `${Math.round(data.reputation.cancelRate * 100)}%` : "—"} />
        </div>
        <div className="flex flex-wrap gap-2">
          {data.badges.map((badge) => (
            <span key={badge.code} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.earned ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-muted)]"}`}>
              {badge.earned ? <BadgeCheck className="h-3.5 w-3.5" /> : null} {badge.title}
            </span>
          ))}
        </div>
        <p className="text-xs text-[var(--codiq-text-muted)]">تُحسب النتيجة من طلباتك المكتملة، وسرعة ردّك، وقلّة الإلغاء، وتقييمات زبائنك، ودقّة مخزونك. تُحدَّث كل ساعة.</p>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2">
      <p className="text-[11px] text-[var(--codiq-text-muted)]">{label}</p>
      <p className="text-sm font-bold text-[var(--codiq-text)]">{value}</p>
    </div>
  );
}
