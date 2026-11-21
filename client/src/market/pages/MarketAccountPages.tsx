/**
 * حسابي — signing in with a phone and a code, the account menu, «بياناتي» and
 * the delivery addresses. Everything else a shopper keeps (orders, tickets,
 * coupons, favourites) joins this menu in the phases that build it.
 */
import { PartnerLinkCard } from "./MarketPartnerPages";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Bell, Camera, Crown, Sparkles, Clapperboard, ChevronLeft, CircleAlert, Copy, Crosshair, Heart, LifeBuoy, LoaderCircle, LogOut, MapPin, MessageCircle, Package, Phone, Plus, Star, ThumbsUp, Ticket, Trash2, UserRound } from "lucide-react";
import { accountCall, displayPhone, setShopper, signOut, useShopper, type Shopper } from "../market-shopper";
import { loadMarketGeography, marketGet, type MarketGeography } from "../market-api";
import { writeMarketLocation } from "../market-location";
import { CodeEntry } from "../components/CodeEntry";

const field = "w-full rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm text-[var(--codiq-text)]";
const primary = "w-full rounded-full bg-[var(--codiq-accent)] py-3 text-sm font-black text-[var(--codiq-surface)] disabled:opacity-50";

function Problem({ text }: { text: string | null }) {
  return text ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-danger)]" data-testid="market-account-error"><CircleAlert className="h-4 w-4 shrink-0" /> {text}</p> : null;
}

// ── sign-in ──────────────────────────────────────────────────────────────────

export function MarketSignIn({ onDone }: { onDone?: (shopper: Shopper) => void }) {
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setFailure(null);
    try {
      const result = await accountCall<{ challengeId: string; resendAfterSeconds: number }>("/api/market/auth/code", { method: "POST", body: JSON.stringify({ phone }) });
      setChallenge({ id: result.challengeId, resendAt: Date.now() + result.resendAfterSeconds * 1000 });
      setCode("");
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  };
  const verify = async (value = code) => {
    if (!challenge || value.length !== 6) return;
    setBusy(true); setFailure(null);
    try {
      const result = await accountCall<{ shopper: Shopper }>("/api/market/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: challenge.id, code: value }) });
      setShopper(result.shopper);
      onDone?.(result.shopper);
    } catch (error) { setFailure((error as Error).message); setCode(""); } finally { setBusy(false); }
  };

  return (
    <section className="space-y-4 rounded-[26px] bg-[var(--codiq-surface)] p-5 shadow-sm" data-testid="market-sign-in">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Phone className="h-6 w-6" /></span>
        <div><p className="text-base font-black text-[var(--codiq-text)]">تسجيل الدخول</p><p className="text-xs text-[var(--codiq-text-muted)]">برقم هاتفك — بلا كلمة سرّ</p></div>
      </div>
      {!challenge ? (
        <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="space-y-3">
          <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="07701234567" dir="ltr" className={`${field} text-center text-lg`} data-testid="market-sign-in-phone" aria-label="رقم الهاتف" />
          <Problem text={failure} />
          <button type="submit" disabled={busy || phone.trim().length < 10} className={primary} data-testid="market-sign-in-send">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} أرسل رمز التحقق</button>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void verify(); }} className="space-y-3">
          <p className="text-center text-sm text-[var(--codiq-text-secondary)]">أدخل الرمز المرسل إلى <span dir="ltr" className="font-bold">{phone}</span></p>
          <CodeEntry value={code} onChange={(value) => { setCode(value); if (value.length === 6) void verify(value); }} resendAt={challenge.resendAt} onResend={() => void send()} testId="market-sign-in-code" />
          <Problem text={failure} />
          <button type="submit" disabled={busy || code.length !== 6} className={primary} data-testid="market-sign-in-verify">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} تأكيد</button>
          <button type="button" onClick={() => { setChallenge(null); setFailure(null); }} className="w-full text-xs font-bold text-[var(--codiq-accent)]">تغيير الرقم</button>
        </form>
      )}
    </section>
  );
}

// ── the account menu ─────────────────────────────────────────────────────────

export function MarketAccountPage() {
  const { status, shopper } = useShopper();
  const [copied, setCopied] = useState(false);
  if (status === "loading") return <p className="py-10 text-center text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p>;
  if (!shopper) return <div className="space-y-4" data-testid="market-account"><MarketSignIn /></div>;
  const copy = async () => { try { await navigator.clipboard.writeText(shopper.publicId); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard refused */ } };
  return (
    <div className="space-y-4" data-testid="market-account">
      <section className="flex items-center gap-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        {shopper.avatarUrl ? <img src={shopper.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" /> : <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><UserRound className="h-7 w-7" /></span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-black text-[var(--codiq-text)]" data-testid="market-account-name">{shopper.fullName ?? "أهلاً بك"}</p>
          <p className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">{displayPhone(shopper.phone)}</p>
        </div>
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-surface-sunken)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]" aria-label="نسخ معرّف الحساب">
          <Copy className="h-3 w-3" /> {copied ? "نُسخ" : shopper.publicId}
        </button>
      </section>
      <PartnerLinkCard />
      <nav className="divide-y divide-[var(--codiq-border)] overflow-hidden rounded-[26px] bg-[var(--codiq-surface)] shadow-sm">
        <MenuLink href="/orders" icon={Package} label="طلباتي" testId="market-account-orders-link" />
        <MenuLink href="/ratings" icon={Star} label="تقييماتي" testId="market-account-ratings-link" />
        <MenuLink href="/favourites" icon={Heart} label="المفضّلة" testId="market-account-favourites-link" />
        <MenuLink href="/coupons?tab=active" icon={Ticket} label="كوبوناتي" testId="market-account-coupons-link" />
        <MenuLink href="/points" icon={Crown} label="نقاطي" testId="market-account-points-link" />
        <MenuLink href="/wheel" icon={Sparkles} label="عجلة الجوائز" testId="market-account-wheel-link" />
        <MenuLink href="/reels" icon={Clapperboard} label="ريلز" testId="market-account-reels-link" />
        <MenuLink href="/notifications" icon={Bell} label="الإشعارات" testId="market-account-notifications-link" />
        <MenuLink href="/account/info" icon={UserRound} label="بياناتي" testId="market-account-info-link" />
        <MenuLink href="/account/addresses" icon={MapPin} label="العناوين" testId="market-account-addresses-link" />
      </nav>
      <nav className="divide-y divide-[var(--codiq-border)] overflow-hidden rounded-[26px] bg-[var(--codiq-surface)] shadow-sm">
        <MenuLink href="/tickets" icon={Ticket} label="تذاكر الدعم" testId="market-account-tickets-link" />
        <MenuLink href="/help" icon={LifeBuoy} label="المساعدة والأسئلة الشائعة" testId="market-account-help-link" />
        <MenuLink href="/help/contact" icon={MessageCircle} label="تواصل معنا" testId="market-account-contact-link" />
        <MenuLink href="/feedback" icon={ThumbsUp} label="قيّم التطبيق" testId="market-account-feedback-link" />
      </nav>
      <button type="button" onClick={() => void signOut()} className="flex w-full items-center justify-center gap-2 rounded-full border border-[var(--codiq-border)] bg-[var(--codiq-surface)] py-3 text-sm font-bold text-[var(--codiq-danger)]" data-testid="market-sign-out"><LogOut className="h-4 w-4" /> تسجيل الخروج</button>
    </div>
  );
}

function MenuLink({ href, icon: Icon, label, testId }: { href: string; icon: typeof UserRound; label: string; testId: string }) {
  return <Link href={href} className="flex items-center justify-between px-4 py-3.5 text-sm font-semibold text-[var(--codiq-text)]" data-testid={testId}><span className="flex items-center gap-3"><Icon className="h-5 w-5 text-[var(--codiq-accent)]" /> {label}</span><ChevronLeft className="h-4 w-4 text-[var(--codiq-text-muted)]" /></Link>;
}

function useSignedIn() {
  const current = useShopper();
  return current;
}

function Back({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"><ChevronLeft className="h-4 w-4 rotate-180" /> {label}</Link>;
}

// ── بياناتي ──────────────────────────────────────────────────────────────────

type CategoryNode = { id: number; slug: string; name: string; children: CategoryNode[] };

export function MarketAccountInfoPage() {
  const { status, shopper } = useSignedIn();
  const [draft, setDraft] = useState({ fullName: "", email: "", gender: "" as "" | "male" | "female", interests: [] as number[] });
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (shopper) setDraft({ fullName: shopper.fullName ?? "", email: shopper.email ?? "", gender: shopper.gender ?? "", interests: shopper.interests }); }, [shopper]);
  useEffect(() => { marketGet<{ categories: CategoryNode[] }>("/api/market/categories").then((body) => setCategories(body.categories)).catch(() => undefined); }, []);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;

  const save = async () => {
    setBusy(true); setFailure(null); setSaved(false);
    try {
      const result = await accountCall<{ shopper: Shopper }>("/api/market/me", { method: "PUT", body: JSON.stringify({ fullName: draft.fullName.trim() || null, email: draft.email.trim() || null, gender: draft.gender || null, interests: draft.interests }) });
      setShopper(result.shopper); setSaved(true);
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setFailure("حجم الصورة كبير، الحدّ الأقصى ٥ ميغابايت"); return; }
    const form = new FormData(); form.append("image", file);
    try { setShopper((await accountCall<{ shopper: Shopper }>("/api/market/me/avatar", { method: "POST", body: form })).shopper); } catch (error) { setFailure((error as Error).message); }
  };
  const removePicture = async () => { try { setShopper((await accountCall<{ shopper: Shopper }>("/api/market/me/avatar", { method: "DELETE" })).shopper); } catch (error) { setFailure((error as Error).message); } };
  const toggle = (id: number) => setDraft({ ...draft, interests: draft.interests.includes(id) ? draft.interests.filter((other) => other !== id) : [...draft.interests, id] });

  return (
    <div className="space-y-4" data-testid="market-account-info">
      <Back href="/account" label="حسابي" />
      <h1 className="text-xl font-black text-[var(--codiq-text)]">بياناتي</h1>
      <section className="flex items-center gap-4 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        {shopper.avatarUrl ? <img src={shopper.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" /> : <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><UserRound className="h-8 w-8" /></span>}
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--codiq-border)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text)]"><Camera className="h-4 w-4" /> {shopper.avatarUrl ? "تغيير الصورة" : "إضافة صورة"}<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void upload(event.target.files?.[0])} /></label>
          {shopper.avatarUrl ? <button type="button" onClick={() => void removePicture()} className="text-xs font-bold text-[var(--codiq-danger)]">حذف</button> : null}
        </div>
      </section>
      <section className="space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">الاسم<input value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} maxLength={80} className={field} data-testid="market-info-name" /></label>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">البريد الإلكترونيّ (اختياريّ)<input value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} type="email" dir="ltr" className={field} /></label>
        <div className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">الجنس
          <div className="flex gap-2">{([["male", "ذكر"], ["female", "أنثى"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.gender === value} onClick={() => setDraft({ ...draft, gender: draft.gender === value ? "" : value })} className={`flex-1 rounded-full border py-2 text-sm ${draft.gender === value ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text)]"}`}>{label}</button>)}</div>
        </div>
        <p className="text-xs text-[var(--codiq-text-muted)]">رقم الهاتف: <span dir="ltr">{displayPhone(shopper.phone)}</span> — رقم الدخول لا يتغيّر من هنا.</p>
      </section>
      <section className="space-y-2 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid="market-info-interests">
        <p className="text-sm font-black text-[var(--codiq-text)]">اهتماماتي</p>
        <p className="text-xs text-[var(--codiq-text-muted)]">اختر الفئات التي تهمّك لتصلك عروض ومنتجات أنسب لك.</p>
        <div className="flex flex-wrap gap-2">{categories.map((category) => <button key={category.id} type="button" aria-pressed={draft.interests.includes(category.id)} onClick={() => toggle(category.id)} className={`rounded-full border px-3 py-1.5 text-xs font-bold ${draft.interests.includes(category.id) ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`}>{category.name}</button>)}</div>
        {draft.interests.length ? <button type="button" onClick={() => setDraft({ ...draft, interests: [] })} className="text-xs font-bold text-[var(--codiq-accent)]">مسح التفضيلات</button> : null}
      </section>
      <Problem text={failure} />
      {saved ? <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-3 py-2 text-xs font-semibold text-[var(--codiq-success)]" data-testid="market-info-saved">حُفظت بياناتك.</p> : null}
      <button type="button" onClick={() => void save()} disabled={busy} className={primary} data-testid="market-info-save">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} حفظ</button>
    </div>
  );
}

// ── العناوين ─────────────────────────────────────────────────────────────────

type Address = { id: string; label: string; recipientName: string; phone: string; altPhone: string | null; governorate: { key: string; name: string }; district: { id: number; name: string }; addressLine: string; location: { latitude: number; longitude: number } | null; isDefault: boolean };

export function MarketAddressesPage() {
  const { status, shopper } = useSignedIn();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [, navigate] = useLocation();
  useEffect(() => { if (shopper) accountCall<{ addresses: Address[] }>("/api/market/me/addresses").then((body) => setAddresses(body.addresses)).catch((error: Error) => setFailure(error.message)); }, [shopper]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;
  const act = async (work: Promise<{ addresses: Address[] }>) => { try { setAddresses((await work).addresses); } catch (error) { setFailure((error as Error).message); } };
  return (
    <div className="space-y-4" data-testid="market-addresses">
      <Back href="/account" label="حسابي" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-black text-[var(--codiq-text)]">العناوين</h1>
        <button type="button" onClick={() => navigate("/account/addresses/new")} className="inline-flex items-center gap-1 rounded-full bg-[var(--codiq-accent)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-surface)]" data-testid="market-address-add"><Plus className="h-4 w-4" /> عنوان جديد</button>
      </div>
      <Problem text={failure} />
      {addresses?.length === 0 ? <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 text-center shadow-sm"><MapPin className="mx-auto h-8 w-8 text-[var(--codiq-accent)]" /><p className="mt-2 text-sm font-bold text-[var(--codiq-text)]">لا توجد عناوين محفوظة</p><p className="text-xs text-[var(--codiq-text-muted)]">أضف عنواناً لتسريع عملية الطلب.</p></div> : null}
      <ul className="space-y-3">
        {addresses?.map((address) => (
          <li key={address.id} className="space-y-2 rounded-[22px] bg-[var(--codiq-surface)] p-4 shadow-sm" data-testid={`market-address-${address.id}`}>
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-black text-[var(--codiq-text)]">{address.label}{address.isDefault ? <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-accent)]">الافتراضي</span> : null}</p>
              <div className="flex items-center gap-3">
                <Link href={`/account/addresses/${address.id}`} className="text-xs font-bold text-[var(--codiq-accent)]">تعديل</Link>
                <button type="button" aria-label="حذف" onClick={() => { if (window.confirm(`حذف «${address.label}»؟ لا يمكن التراجع.`)) void act(accountCall(`/api/market/me/addresses/${address.id}`, { method: "DELETE" })); }}><Trash2 className="h-4 w-4 text-[var(--codiq-danger)]" /></button>
              </div>
            </div>
            <p className="text-xs text-[var(--codiq-text-secondary)]">{address.recipientName} · <span dir="ltr">{displayPhone(address.phone)}</span></p>
            <p className="text-xs text-[var(--codiq-text-secondary)]">{address.governorate.name} · {address.district.name} — {address.addressLine}</p>
            {!address.isDefault ? <button type="button" onClick={() => void act(accountCall(`/api/market/me/addresses/${address.id}/default`, { method: "POST" }))} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--codiq-accent)]"><Star className="h-3 w-3" /> اجعله الافتراضي</button> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MarketAddressFormPage({ params }: { params: { id?: string } }) {
  const { status, shopper } = useSignedIn();
  const [, navigate] = useLocation();
  const editing = params.id && params.id !== "new" ? params.id : null;
  const [geo, setGeo] = useState<MarketGeography | null>(null);
  const [draft, setDraft] = useState({ label: "البيت", recipientName: "", phone: "", altPhone: "", governorateKey: "", districtId: "", addressLine: "", latitude: null as number | null, longitude: null as number | null, isDefault: false });
  const [originalPhone, setOriginalPhone] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ id: string; resendAt: number; phone: string } | null>(null);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadMarketGeography().then(setGeo).catch(() => undefined); }, []);
  useEffect(() => {
    if (!shopper) return;
    if (!editing) { setDraft((current) => ({ ...current, recipientName: current.recipientName || shopper.fullName || "", phone: current.phone || `0${shopper.phone.slice(4)}` })); return; }
    accountCall<{ addresses: Address[] }>("/api/market/me/addresses").then((body) => {
      const found = body.addresses.find((row) => row.id === editing);
      if (!found) { navigate("/account/addresses"); return; }
      setOriginalPhone(found.phone);
      setDraft({ label: found.label, recipientName: found.recipientName, phone: `0${found.phone.slice(4)}`, altPhone: found.altPhone ? `0${found.altPhone.slice(4)}` : "", governorateKey: found.governorate.key, districtId: String(found.district.id), addressLine: found.addressLine, latitude: found.location?.latitude ?? null, longitude: found.location?.longitude ?? null, isDefault: found.isDefault });
    }).catch((error: Error) => setFailure(error.message));
  }, [shopper, editing, navigate]);
  if (status === "loading") return null;
  if (!shopper) return <MarketSignIn />;

  const e164 = (local: string) => (local.trim().startsWith("0") ? `+964${local.trim().slice(1)}` : local.trim());
  const phoneNeedsCode = e164(draft.phone) !== shopper.phone && e164(draft.phone) !== originalPhone;
  const districts = geo?.governorates.find((row) => row.key === draft.governorateKey)?.districts ?? [];
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });

  const sendCode = async () => {
    setFailure(null);
    try {
      const result = await accountCall<{ challengeId: string; resendAfterSeconds: number }>("/api/market/me/addresses/phone-code", { method: "POST", body: JSON.stringify({ phone: draft.phone }) });
      setChallenge({ id: result.challengeId, resendAt: Date.now() + result.resendAfterSeconds * 1000, phone: e164(draft.phone) }); setCode("");
    } catch (error) { setFailure((error as Error).message); }
  };
  const locate = () => navigator.geolocation?.getCurrentPosition((position) => set({ latitude: Number(position.coords.latitude.toFixed(6)), longitude: Number(position.coords.longitude.toFixed(6)) }), () => setFailure("تعذّر تحديد موقعك. فعّل صلاحيّة الموقع أو تجاوز هذه الخطوة."));
  const save = async () => {
    setBusy(true); setFailure(null);
    try {
      const body = {
        label: draft.label, recipientName: draft.recipientName, phone: draft.phone, altPhone: draft.altPhone.trim() || null, governorateKey: draft.governorateKey, districtId: Number(draft.districtId),
        addressLine: draft.addressLine, latitude: draft.latitude, longitude: draft.longitude, isDefault: draft.isDefault,
        phoneVerification: phoneNeedsCode && challenge ? { challengeId: challenge.id, code } : null,
      };
      const result = await accountCall<{ address: Address }>(editing ? `/api/market/me/addresses/${editing}` : "/api/market/me/addresses", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      // The default address is where the shopper wants things: the header's «التوصيل إلى» follows it.
      if (result.address.isDefault) writeMarketLocation({ governorateKey: result.address.governorate.key, governorateName: result.address.governorate.name, districtId: result.address.district.id, districtName: result.address.district.name });
      navigate("/account/addresses");
    } catch (error) { setFailure((error as Error).message); } finally { setBusy(false); }
  };
  const ready = draft.recipientName.trim().length >= 2 && draft.phone.trim() && draft.governorateKey && draft.districtId && draft.addressLine.trim().length >= 5 && (!phoneNeedsCode || (challenge?.phone === e164(draft.phone) && code.length === 6));

  return (
    <div className="space-y-4" data-testid="market-address-form">
      <Back href="/account/addresses" label="العناوين" />
      <h1 className="text-xl font-black text-[var(--codiq-text)]">{editing ? "تعديل العنوان" : "عنوان جديد"}</h1>
      <section className="space-y-3 rounded-[26px] bg-[var(--codiq-surface)] p-4 shadow-sm">
        <div className="flex gap-2">{["البيت", "العمل", "بيت أهلي"].map((label) => <button key={label} type="button" aria-pressed={draft.label === label} onClick={() => set({ label })} className={`rounded-full border px-3 py-1.5 text-xs font-bold ${draft.label === label ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`}>{label}</button>)}</div>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">اسم العنوان<input value={draft.label} onChange={(event) => set({ label: event.target.value })} maxLength={40} className={field} /></label>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">اسم المستلم<input value={draft.recipientName} onChange={(event) => set({ recipientName: event.target.value })} maxLength={80} className={field} data-testid="market-address-recipient" /></label>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">رقم الهاتف<input value={draft.phone} onChange={(event) => { set({ phone: event.target.value }); setChallenge(null); }} inputMode="tel" dir="ltr" className={field} data-testid="market-address-phone" /></label>
        {phoneNeedsCode ? (
          <div className="space-y-2 rounded-2xl bg-[var(--codiq-surface-sunken)] p-3" data-testid="market-address-phone-verify">
            <p className="text-xs text-[var(--codiq-text-secondary)]">هذا ليس رقم حسابك، فسنرسل إليه رمزاً لتأكيد أنّه يصل.</p>
            {challenge?.phone === e164(draft.phone) ? <CodeEntry value={code} onChange={setCode} resendAt={challenge.resendAt} onResend={() => void sendCode()} testId="market-address-code" /> : <button type="button" onClick={() => void sendCode()} className="w-full rounded-full border border-[var(--codiq-accent)] py-2 text-xs font-bold text-[var(--codiq-accent)]" data-testid="market-address-send-code">أرسل رمز التحقق</button>}
          </div>
        ) : null}
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">رقم هاتف بديل (اختياريّ)<input value={draft.altPhone} onChange={(event) => set({ altPhone: event.target.value })} inputMode="tel" dir="ltr" className={field} placeholder="يتصل به المندوب إذا تعذّر الوصول إلى رقمك" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">المحافظة<select value={draft.governorateKey} onChange={(event) => set({ governorateKey: event.target.value, districtId: "" })} className={field} data-testid="market-address-governorate"><option value="">اختر المحافظة</option>{geo?.governorates.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}</select></label>
          <label className="space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">القضاء / المنطقة<select value={draft.districtId} onChange={(event) => set({ districtId: event.target.value })} disabled={!draft.governorateKey} className={field} data-testid="market-address-district"><option value="">{draft.governorateKey ? "اختر المنطقة" : "اختر المحافظة أولاً"}</option>{districts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        </div>
        <label className="block space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">العنوان التفصيليّ<textarea value={draft.addressLine} onChange={(event) => set({ addressLine: event.target.value })} rows={2} maxLength={300} placeholder="شارع · بناية · أقرب نقطة دالّة" className={field} data-testid="market-address-line" /></label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={locate} className="inline-flex items-center gap-1 rounded-full border border-[var(--codiq-border)] px-3 py-1.5 text-xs font-bold text-[var(--codiq-text)]"><Crosshair className="h-4 w-4" /> حدّد موقعي على الخريطة</button>
          {draft.latitude !== null ? <><a href={`https://www.openstreetmap.org/?mlat=${draft.latitude}&mlon=${draft.longitude}#map=17/${draft.latitude}/${draft.longitude}`} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-[var(--codiq-accent)]">عرض الموقع</a><button type="button" onClick={() => set({ latitude: null, longitude: null })} className="text-xs text-[var(--codiq-text-muted)]">إزالة</button></> : <span className="text-[11px] text-[var(--codiq-text-muted)]">اختياريّ، يساعد المندوب.</span>}
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--codiq-text)]"><input type="checkbox" checked={draft.isDefault} onChange={(event) => set({ isDefault: event.target.checked })} /> العنوان الافتراضيّ</label>
      </section>
      <Problem text={failure} />
      <button type="button" onClick={() => void save()} disabled={busy || !ready} className={primary} data-testid="market-address-save">{busy ? <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> : null} {editing ? "حفظ التعديل" : "حفظ العنوان"}</button>
    </div>
  );
}
