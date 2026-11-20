/**
 * ق-199/ق-198/ق-204/ق-210/ق-211 — «واجهة المتجر»: the ONE screen where a
 * merchant shapes what his shoppers see. Identity (name, logo, headline), the
 * announcement strip, the front page's large slides in BOTH placements, the home
 * sections and their titles, contact, social handles, the written policies, his
 * own footer pages, and whether a stranger may buy without an account. Every
 * field here is a key in the storefront's `public-config`, and the
 * storefront-config guard holds the two lists equal.
 *
 * Each card saves on its own: the server reads an absent field as «leave it»,
 * so a merchant who only fixes his phone number sends only his phone number.
 */
import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowLeftRight, ArrowUp, ExternalLink, EyeOff, Eye, FileText, ImagePlus, LoaderCircle, Megaphone, Palette, Phone, Plus, ScrollText, Share2, ShoppingBag, Trash2, Upload, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

type HomeSection = { key: "banners" | "categories" | "newest" | "best_selling" | "banners_mid" | "top_rated" | "reviews"; enabled: boolean; title: string };
/** ق-211: a page the merchant wrote himself, linked from «روابط مهمة» in the footer. */
type CustomPage = { slug: string; title: string; body: string };
type Settings = {
  storeSlug: string; name: string; logo: { url: string; byteSize: number } | null; headline: string | null; subline: string | null;
  announcementEnabled: boolean; announcementText: string | null;
  supportEmail: string | null; supportPhone: string | null; supportWhatsapp: string | null; addressLine: string | null; city: string | null;
  socialFacebook: string | null; socialInstagram: string | null; socialX: string | null; socialTiktok: string | null; socialSnapchat: string | null; socialYoutube: string | null;
  policyReturn: string | null; policyPrivacy: string | null; policyDelivery: string | null; customPages: CustomPage[];
  guestCheckoutEnabled: boolean; homeSections: HomeSection[];
};
/** ق-210: `placement` says which of the front page's two sliders the slide belongs to. */
type BannerPlacement = "hero" | "mid";
type Banner = { id: string; url: string; linkUrl: string | null; altText: string | null; isActive: boolean; sortOrder: number; byteSize: number; placement: BannerPlacement };
const PLACEMENT_LABEL: Record<BannerPlacement, string> = { hero: "السلايدر الرئيسي — أعلى الصفحة", mid: "الشريط الترويجي — وسط الصفحة" };
const MAX_PER_PLACEMENT = 12;

const SECTION_HINT: Record<HomeSection["key"], string> = { banners: "الصور الكبيرة (السلايدر)", categories: "التصنيفات", newest: "أحدث المنتجات", best_selling: "الأكثر مبيعاً — من طلبات حقيقية", banners_mid: "الشريط الترويجي (وسط الصفحة)", top_rated: "الأعلى تقييماً — من تقييمات الزبائن", reviews: "آراء العملاء" };
/** Both slider sections are pictures and carry no title of their own. */
const TITLELESS_SECTIONS: readonly HomeSection["key"][] = ["banners", "banners_mid"];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? (body?.error?.fields?.[0]?.message as string | undefined) ?? `فشل الطلب (${response.status})`);
  return body as T;
}

const card = "rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm sm:p-6";
const field = "h-11 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";
const label = "block space-y-1.5 text-xs font-bold text-[var(--codiq-text-secondary)]";

function Card({ icon: Icon, title, hint, children, testId }: { icon: typeof Palette; title: string; hint: string; children: React.ReactNode; testId: string }) {
  return <section data-testid={testId} className={card}><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><Icon className="h-5 w-5" /></span><div><h2 className="text-base font-black text-[var(--codiq-text)]">{title}</h2><p className="mt-0.5 text-xs leading-6 text-[var(--codiq-text-muted)]">{hint}</p></div></div><div className="mt-5">{children}</div></section>;
}

function SaveRow({ busy, notice, error, labelText = "حفظ" }: { busy: boolean; notice: string | null; error: string | null; labelText?: string }) {
  return <div className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" size="sm" disabled={busy} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">{busy ? "جارٍ الحفظ…" : labelText}</Button>{error ? <p role="alert" className="text-xs font-bold text-[var(--codiq-danger)]">{error}</p> : notice ? <p role="status" className="text-xs font-bold text-[var(--codiq-success)]">{notice}</p> : null}</div>;
}

/** One card = one PUT of only its own fields. */
function useSection(base: string, onSaved: (settings: Settings) => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (payload: Record<string, unknown>, done = "تم الحفظ — يظهر في متجرك الآن.") => {
    setBusy(true); setNotice(null); setError(null);
    try { const result = await call<{ storefront: Settings }>(base, { method: "PUT", body: JSON.stringify(payload) }); onSaved(result.storefront); setNotice(done); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر الحفظ."); }
    finally { setBusy(false); }
  };
  return { busy, notice, error, save };
}

function IdentityCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [name, setName] = useState(settings.name);
  const [headline, setHeadline] = useState(settings.headline ?? "");
  const [subline, setSubline] = useState(settings.subline ?? "");
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setName(settings.name); setHeadline(settings.headline ?? ""); setSubline(settings.subline ?? ""); }, [settings.name, settings.headline, settings.subline]);
  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true); setLogoError(null);
    try { const form = new FormData(); form.append("image", file); const result = await call<{ storefront: Settings }>(`/api/merchant/stores/${encodeURIComponent(settings.storeSlug)}/storefront/logo`, { method: "POST", body: form }); onSaved(result.storefront); }
    catch (caught) { setLogoError(caught instanceof Error ? caught.message : "تعذر رفع الشعار."); }
    finally { setLogoBusy(false); }
  }
  async function removeLogo() {
    setLogoBusy(true); setLogoError(null);
    try { const result = await call<{ storefront: Settings }>(`/api/merchant/stores/${encodeURIComponent(settings.storeSlug)}/storefront/logo`, { method: "DELETE" }); onSaved(result.storefront); }
    catch (caught) { setLogoError(caught instanceof Error ? caught.message : "تعذر حذف الشعار."); }
    finally { setLogoBusy(false); }
  }
  return (
    <Card icon={Palette} title="الهوية" hint="اسم المتجر وشعاره في رأس كل صفحة، والعنوان الذي يستقبل الزبون تحت الصور الكبيرة." testId="storefront-identity">
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-canvas)]">{settings.logo ? <img src={settings.logo.url} alt="شعار المتجر" className="h-full w-full object-cover" /> : <ShoppingBag className="h-7 w-7 text-[var(--codiq-text-muted)]" />}</div>
        <div className="space-y-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 py-2 text-xs font-bold text-[var(--codiq-text-secondary)] hover:border-[var(--codiq-accent)]"><Upload className="h-4 w-4" />{logoBusy ? "جارٍ الرفع…" : settings.logo ? "استبدال الشعار" : "رفع شعار"}<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="logo-input" disabled={logoBusy} onChange={(event) => { void uploadLogo(event.target.files?.[0]); event.target.value = ""; }} /></label>
          {settings.logo ? <Button type="button" variant="ghost" size="sm" disabled={logoBusy} className="text-[var(--codiq-danger)]" onClick={() => void removeLogo()}><Trash2 className="ml-1 h-4 w-4" />حذف الشعار</Button> : null}
          <p className="text-[11px] text-[var(--codiq-text-muted)]">PNG أو JPEG أو WebP، حتى 5 MB. يُحسب على مساحة الصور في خطتك.</p>
          {logoError ? <p role="alert" className="text-xs font-bold text-[var(--codiq-danger)]">{logoError}</p> : null}
        </div>
      </div>
      <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void save({ name: name.trim(), headline, subline }); }}>
        <label className={label}>اسم المتجر<input data-testid="storefront-name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required className={field} /></label>
        <label className={label}>عنوان الترحيب <span className="font-semibold text-[var(--codiq-text-muted)]">(اختياري)</span><input data-testid="storefront-headline" value={headline} onChange={(event) => setHeadline(event.target.value)} maxLength={120} placeholder="مثال: عطور أصلية تصل بابك" className={field} /></label>
        <label className={`${label} sm:col-span-2`}>سطر تحت العنوان <span className="font-semibold text-[var(--codiq-text-muted)]">(اختياري)</span><input value={subline} onChange={(event) => setSubline(event.target.value)} maxLength={300} placeholder="مثال: توصيل لكل العراق — الدفع عند الاستلام" className={field} /></label>
        <div className="sm:col-span-2"><SaveRow busy={busy} notice={notice} error={error} /></div>
      </form>
    </Card>
  );
}

function AnnouncementCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [text, setText] = useState(settings.announcementText ?? "");
  const [enabled, setEnabled] = useState(settings.announcementEnabled);
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setText(settings.announcementText ?? ""); setEnabled(settings.announcementEnabled); }, [settings.announcementText, settings.announcementEnabled]);
  return (
    <Card icon={Megaphone} title="شريط الإعلان" hint="جملة واحدة تتحرك فوق رأس المتجر — «التوصيل مجاني فوق ٥٠ ألف»، «العيد: آخر طلب الخميس». لا تحتاج إغلاق المتجر لتقولها." testId="storefront-announcement">
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save({ announcementText: text, announcementEnabled: enabled }); }}>
        <label className={label}>نص الإعلان<input data-testid="announcement-text" value={text} onChange={(event) => setText(event.target.value)} maxLength={200} placeholder="اكتب جملة الإعلان…" className={field} /></label>
        <label className="mt-3 flex items-center gap-3 text-sm font-bold text-[var(--codiq-text-secondary)]"><Switch data-testid="announcement-switch" checked={enabled} onCheckedChange={setEnabled} aria-label="تشغيل شريط الإعلان" />{enabled ? "الشريط ظاهر لزبائنك" : "الشريط مخفي"}</label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}

function BannersCard({ storeSlug }: { storeSlug: string }) {
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/banners`;
  const [banners, setBanners] = useState<Banner[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { const result = await call<{ banners: Banner[] }>(base); setBanners(result.banners); } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر تحميل الصور."); } }, [base]);
  useEffect(() => { void load(); }, [load]);
  async function run(work: () => Promise<unknown>) { setBusy(true); setError(null); try { await work(); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر الحفظ."); } finally { setBusy(false); } }
  // ق-210: which of the two sliders the next upload joins. A chooser rather than a
  // guess: a merchant uploading a tall hero photograph and a wide promo band in the
  // same minute means two different things by them.
  const [placement, setPlacement] = useState<BannerPlacement>("hero");
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    await run(async () => { for (const file of Array.from(files)) { const form = new FormData(); form.append("image", file); form.append("placement", placement); await call(base, { method: "POST", body: form }); } });
  }
  const patch = (id: string, body: Record<string, unknown>) => call(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/banners/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  const remove = (id: string) => call(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/banners/${encodeURIComponent(id)}`, { method: "DELETE" });
  // Reordering happens INSIDE one slider: the two lists are two pages of the shop.
  async function move(group: Banner[], index: number, direction: -1 | 1) {
    const other = index + direction;
    if (other < 0 || other >= group.length) return;
    const a = group[index]!; const b = group[other]!;
    // Two slides swap their positions; when the stored orders happen to be equal, spread them.
    const [orderA, orderB] = a.sortOrder === b.sortOrder ? [other, index] : [b.sortOrder, a.sortOrder];
    await run(async () => { await patch(a.id, { sortOrder: orderA }); await patch(b.id, { sortOrder: orderB }); });
  }
  const groupOf = (target: BannerPlacement) => (banners ?? []).filter((banner) => (banner.placement ?? "hero") === target);
  const chosen = groupOf(placement);
  return (
    <Card icon={ImagePlus} title="الصور الكبيرة" hint="صور صفحتك الرئيسية: السلايدر الذي يفتح المتجر، والشريط الترويجي بين الأقسام — حتى 12 صورة لكل موضع، بترتيبك، مع رابط اختياري لكل صورة. أخفِ صورة موسمية بدل حذفها لتعود بلا رفع جديد." testId="storefront-banners">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-[var(--codiq-text-secondary)]">موضع الصور الجديدة:</span>
        {(["hero", "mid"] as const).map((target) => (
          <button key={target} type="button" data-testid={`banner-placement-${target}`} aria-pressed={placement === target} onClick={() => setPlacement(target)} className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition ${placement === target ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)] hover:border-[var(--codiq-accent)]"}`}>{PLACEMENT_LABEL[target]}</button>
        ))}
      </div>
      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--codiq-accent)] px-4 py-2.5 text-sm font-bold text-white hover:bg-[var(--codiq-accent-hover)]"><Upload className="h-4 w-4" />{busy ? "جارٍ الرفع…" : "رفع صور"}<input type="file" multiple accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="banner-input" disabled={busy || chosen.length >= MAX_PER_PLACEMENT} onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} /></label>
      <p className="mt-2 text-[11px] text-[var(--codiq-text-muted)]">{placement === "hero" ? "الأفضل 1600×700 بكسل أو أعرض." : "الأفضل 1600×450 بكسل — شريط عريض وقصير."} {banners ? `${chosen.length} / ${MAX_PER_PLACEMENT}` : ""}</p>
      {error ? <p role="alert" className="mt-2 text-xs font-bold text-[var(--codiq-danger)]">{error}</p> : null}
      {banners === null ? <p className="mt-4 flex items-center gap-2 text-xs text-[var(--codiq-text-muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ التحميل…</p> : banners.length === 0 ? <p className="mt-4 rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-xs leading-6 text-[var(--codiq-text-muted)]">لا صور بعد — تظهر رئيسية متجرك بلا سلايدر حتى ترفع أول صورة.</p> : (
        <div className="mt-4 space-y-5">
          {(["hero", "mid"] as const).map((target) => {
            const group = groupOf(target);
            if (!group.length) return null;
            return (
              <section key={target} data-testid={`banner-group-${target}`}>
                <h3 className="text-xs font-black text-[var(--codiq-text-secondary)]">{PLACEMENT_LABEL[target]} <span className="font-bold text-[var(--codiq-text-muted)]">({group.length})</span></h3>
                <ul className="mt-2 space-y-3">
                  {group.map((banner, index) => (
                    <BannerRow
                      key={banner.id} banner={banner} index={index} count={group.length} busy={busy}
                      onMove={(direction) => void move(group, index, direction)}
                      onPlacement={() => void run(() => patch(banner.id, { placement: target === "hero" ? "mid" : "hero" }))}
                      onToggle={() => void run(() => patch(banner.id, { isActive: !banner.isActive }))}
                      onDelete={() => { if (window.confirm("حذف هذه الصورة نهائياً؟ الإخفاء يبقيها لتعود لاحقاً بلا رفع.")) void run(() => remove(banner.id)); }}
                      onSave={(body) => void run(() => patch(banner.id, body))}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function BannerRow({ banner, index, count, busy, onMove, onPlacement, onToggle, onDelete, onSave }: { banner: Banner; index: number; count: number; busy: boolean; onMove: (direction: -1 | 1) => void; onPlacement: () => void; onToggle: () => void; onDelete: () => void; onSave: (body: { linkUrl: string; altText: string }) => void }) {
  const [link, setLink] = useState(banner.linkUrl ?? "");
  const [alt, setAlt] = useState(banner.altText ?? "");
  useEffect(() => { setLink(banner.linkUrl ?? ""); setAlt(banner.altText ?? ""); }, [banner.linkUrl, banner.altText]);
  return (
    <li data-testid="banner-row" className={`flex flex-col gap-3 rounded-2xl border p-3 sm:flex-row ${banner.isActive ? "border-[var(--codiq-border)] bg-[var(--codiq-surface)]" : "border-dashed border-[var(--codiq-border-strong)] bg-[var(--codiq-surface-sunken)]"}`}>
      <img src={banner.url} alt={banner.altText ?? ""} className="h-24 w-full shrink-0 rounded-xl object-cover sm:w-40" />
      <form className="grid flex-1 gap-2 sm:grid-cols-2" onSubmit={(event: FormEvent) => { event.preventDefault(); onSave({ linkUrl: link.trim(), altText: alt.trim() }); }}>
        <label className="space-y-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]">رابط عند النقر <span className="font-semibold text-[var(--codiq-text-muted)]">(اختياري، https)</span><input value={link} onChange={(event) => setLink(event.target.value)} dir="ltr" placeholder="https://…" className="h-9 w-full rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 text-xs outline-none focus:border-[var(--codiq-accent)]" /></label>
        <label className="space-y-1 text-[11px] font-bold text-[var(--codiq-text-secondary)]">وصف الصورة <span className="font-semibold text-[var(--codiq-text-muted)]">(لقارئ الشاشة)</span><input value={alt} onChange={(event) => setAlt(event.target.value)} maxLength={200} placeholder="مثال: عرض العيد" className="h-9 w-full rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 text-xs outline-none focus:border-[var(--codiq-accent)]" /></label>
        <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
          <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-8 rounded-lg text-xs">حفظ</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy || index === 0} aria-label="تحريك لأعلى" className="h-8 rounded-lg" onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" /></Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy || index === count - 1} aria-label="تحريك لأسفل" className="h-8 rounded-lg" onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" /></Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} className="h-8 rounded-lg text-xs" onClick={onToggle}>{banner.isActive ? <><EyeOff className="ml-1 h-4 w-4" />إخفاء</> : <><Eye className="ml-1 h-4 w-4" />إظهار</>}</Button>
          {/* ق-210: the slide keeps its bytes, link and description when it changes sliders. */}
          <Button type="button" size="sm" variant="ghost" disabled={busy} className="h-8 rounded-lg text-xs" onClick={onPlacement}><ArrowLeftRight className="ml-1 h-4 w-4" />{banner.placement === "mid" ? "إلى السلايدر الرئيسي" : "إلى الشريط الترويجي"}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} className="h-8 rounded-lg text-xs text-[var(--codiq-danger)]" onClick={onDelete}><Trash2 className="ml-1 h-4 w-4" />حذف</Button>
          {!banner.isActive ? <span className="text-[11px] font-bold text-[var(--codiq-text-muted)]">مخفية عن الزبائن</span> : null}
        </div>
      </form>
    </li>
  );
}

function SectionsCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [sections, setSections] = useState<HomeSection[]>(settings.homeSections);
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setSections(settings.homeSections); }, [settings.homeSections]);
  const move = (index: number, direction: -1 | 1) => setSections((current) => { const next = [...current]; const other = index + direction; if (other < 0 || other >= next.length) return current; [next[index], next[other]] = [next[other]!, next[index]!]; return next; });
  return (
    <Card icon={ScrollText} title="أقسام الصفحة الرئيسية" hint="أي الأقسام تظهر، بأي ترتيب، وتحت أي عنوان. قسم بلا محتوى لا يُرسم — «الأعلى تقييماً» يحتاج أربعة منتجات مقيَّمة." testId="storefront-sections">
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save({ homeSections: sections.map((section) => ({ key: section.key, enabled: section.enabled, title: section.title.trim() || null })) }); }}>
        <ul className="space-y-2">
          {sections.map((section, index) => (
            <li key={section.key} className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--codiq-border)] p-2.5">
              <Switch checked={section.enabled} aria-label={`إظهار ${SECTION_HINT[section.key]}`} onCheckedChange={(checked) => setSections((current) => current.map((entry) => entry.key === section.key ? { ...entry, enabled: checked } : entry))} />
              <span className="w-40 text-xs font-bold text-[var(--codiq-text-secondary)]">{SECTION_HINT[section.key]}</span>
              {TITLELESS_SECTIONS.includes(section.key) ? <span className="flex-1 text-xs text-[var(--codiq-text-muted)]">بلا عنوان</span> : <input value={section.title} onChange={(event) => setSections((current) => current.map((entry) => entry.key === section.key ? { ...entry, title: event.target.value } : entry))} maxLength={60} aria-label={`عنوان ${SECTION_HINT[section.key]}`} className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 text-xs outline-none focus:border-[var(--codiq-accent)]" />}
              <span className="flex items-center gap-1"><Button type="button" size="sm" variant="ghost" disabled={index === 0} aria-label="تحريك لأعلى" className="h-8 rounded-lg" onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button><Button type="button" size="sm" variant="ghost" disabled={index === sections.length - 1} aria-label="تحريك لأسفل" className="h-8 rounded-lg" onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button></span>
            </li>
          ))}
        </ul>
        <SaveRow busy={busy} notice={notice} error={error} labelText="حفظ الترتيب" />
      </form>
    </Card>
  );
}

function ContactCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [form, setForm] = useState({ supportEmail: settings.supportEmail ?? "", supportPhone: settings.supportPhone ?? "", supportWhatsapp: settings.supportWhatsapp ?? "", addressLine: settings.addressLine ?? "", city: settings.city ?? "" });
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setForm({ supportEmail: settings.supportEmail ?? "", supportPhone: settings.supportPhone ?? "", supportWhatsapp: settings.supportWhatsapp ?? "", addressLine: settings.addressLine ?? "", city: settings.city ?? "" }); }, [settings.supportEmail, settings.supportPhone, settings.supportWhatsapp, settings.addressLine, settings.city]);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Card icon={Phone} title="التواصل" hint="يظهر في تذييل المتجر وصفحة الدفع. بريد الدعم يصير أيضاً عنوان الرد على رسائل الطلبات التي تصل زبائنك." testId="storefront-contact">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(form); }}>
        <label className={label}>واتساب<input data-testid="contact-whatsapp" value={form.supportWhatsapp} onChange={set("supportWhatsapp")} inputMode="tel" dir="ltr" placeholder="07XXXXXXXXX" className={field} /></label>
        <label className={label}>هاتف الدعم<input data-testid="contact-phone" value={form.supportPhone} onChange={set("supportPhone")} inputMode="tel" dir="ltr" placeholder="07XXXXXXXXX" className={field} /></label>
        <label className={label}>بريد الدعم<input data-testid="contact-email" value={form.supportEmail} onChange={set("supportEmail")} type="email" dir="ltr" className={field} /></label>
        <label className={label}>المدينة<input value={form.city} onChange={set("city")} maxLength={60} className={field} /></label>
        <label className={`${label} sm:col-span-2`}>العنوان<input value={form.addressLine} onChange={set("addressLine")} maxLength={200} placeholder="الشارع، المنطقة، أقرب نقطة دالة" className={field} /></label>
        <div className="sm:col-span-2"><SaveRow busy={busy} notice={notice} error={error} /></div>
      </form>
    </Card>
  );
}

function SocialCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const of = (source: Settings) => ({ socialInstagram: source.socialInstagram ?? "", socialFacebook: source.socialFacebook ?? "", socialTiktok: source.socialTiktok ?? "", socialX: source.socialX ?? "", socialSnapchat: source.socialSnapchat ?? "", socialYoutube: source.socialYoutube ?? "" });
  const [form, setForm] = useState(() => of(settings));
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setForm(of(settings)); }, [settings.socialInstagram, settings.socialFacebook, settings.socialTiktok, settings.socialX, settings.socialSnapchat, settings.socialYoutube]);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Card icon={Share2} title="حسابات التواصل الاجتماعي" hint="اسم المستخدم فقط — بلا رابط. تظهر أيقوناتها في تذييل المتجر." testId="storefront-social">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(form); }}>
        <label className={label}>إنستغرام<input data-testid="social-instagram" value={form.socialInstagram} onChange={set("socialInstagram")} dir="ltr" placeholder="username" className={field} /></label>
        <label className={label}>فيسبوك<input value={form.socialFacebook} onChange={set("socialFacebook")} dir="ltr" placeholder="page.name" className={field} /></label>
        <label className={label}>تيك توك<input value={form.socialTiktok} onChange={set("socialTiktok")} dir="ltr" placeholder="username" className={field} /></label>
        <label className={label}>إكس<input value={form.socialX} onChange={set("socialX")} dir="ltr" placeholder="username" className={field} /></label>
        <label className={label}>سناب شات<input data-testid="social-snapchat" value={form.socialSnapchat} onChange={set("socialSnapchat")} dir="ltr" placeholder="username" className={field} /></label>
        <label className={label}>يوتيوب<input data-testid="social-youtube" value={form.socialYoutube} onChange={set("socialYoutube")} dir="ltr" placeholder="channel" className={field} /></label>
        <div className="sm:col-span-2"><SaveRow busy={busy} notice={notice} error={error} /></div>
      </form>
    </Card>
  );
}

function PoliciesCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [form, setForm] = useState({ policyReturn: settings.policyReturn ?? "", policyDelivery: settings.policyDelivery ?? "", policyPrivacy: settings.policyPrivacy ?? "" });
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setForm({ policyReturn: settings.policyReturn ?? "", policyDelivery: settings.policyDelivery ?? "", policyPrivacy: settings.policyPrivacy ?? "" }); }, [settings.policyReturn, settings.policyDelivery, settings.policyPrivacy]);
  const area = "min-h-28 w-full resize-y rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm leading-6 text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";
  return (
    <Card icon={ScrollText} title="السياسات" hint="سياساتك المكتوبة — لكل واحدة صفحتها في المتجر ورابطها في التذييل وصفحة الدفع. سياسات المنصة إلزامية دائماً؛ هذه تُضاف فوقها." testId="storefront-policies">
      <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(form); }}>
        <label className={label}>سياسة الإرجاع والاستبدال<textarea data-testid="policy-return" value={form.policyReturn} onChange={(event) => setForm((current) => ({ ...current, policyReturn: event.target.value }))} maxLength={5000} className={area} placeholder="مثال: الإرجاع خلال ٧ أيام بحالة المنتج الأصلية…" /></label>
        <label className={label}>سياسة التوصيل<textarea value={form.policyDelivery} onChange={(event) => setForm((current) => ({ ...current, policyDelivery: event.target.value }))} maxLength={5000} className={area} placeholder="مثال: التوصيل خلال ٢–٤ أيام عمل داخل بغداد…" /></label>
        <label className={label}>سياسة الخصوصية<textarea value={form.policyPrivacy} onChange={(event) => setForm((current) => ({ ...current, policyPrivacy: event.target.value }))} maxLength={5000} className={area} /></label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}

/**
 * ق-211 — «صفحات المتجر»: the rest of «روابط مهمة».
 *
 * The three policies above are named by the checkout screen and stay fixed. These
 * are the merchant's own: «من نحن», «اتفاقية المستخدم», an article about what he
 * sells. The whole list is saved at once, because the whole list is what the
 * footer draws — and the slug is the address, so it is latin and stable.
 */
function PagesCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const [pages, setPages] = useState<CustomPage[]>(settings.customPages ?? []);
  const { busy, notice, error, save } = useSection(base, onSaved);
  useEffect(() => { setPages(settings.customPages ?? []); }, [settings.customPages]);
  const area = "min-h-28 w-full resize-y rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-3 text-sm leading-6 text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";
  const set = (index: number, patch: Partial<CustomPage>) => setPages((current) => current.map((page, at) => at === index ? { ...page, ...patch } : page));
  return (
    <Card icon={FileText} title="صفحات المتجر" hint="صفحاتك النصية — «من نحن»، «اتفاقية المستخدم»، أو أي صفحة يحتاجها متجرك. تظهر روابطها في «روابط مهمة» بتذييل المتجر، حتى ست صفحات." testId="storefront-pages">
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save({ customPages: pages.map((page) => ({ slug: page.slug.trim().toLowerCase(), title: page.title.trim(), body: page.body.trim() })) }); }}>
        {pages.length === 0 ? <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] p-4 text-xs leading-6 text-[var(--codiq-text-muted)]">لا صفحات بعد. «من نحن» أول ما يبحث عنه زبون جديد.</p> : null}
        <ul className="space-y-3">
          {pages.map((page, index) => (
            <li key={index} data-testid="custom-page-row" className="space-y-2 rounded-2xl border border-[var(--codiq-border)] p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <label className={label}>عنوان الصفحة<input value={page.title} onChange={(event) => set(index, { title: event.target.value })} maxLength={80} placeholder="من نحن" className={field} /></label>
                <label className={label}>رابطها <span className="font-semibold text-[var(--codiq-text-muted)]">(إنجليزي)</span><input value={page.slug} onChange={(event) => set(index, { slug: event.target.value })} dir="ltr" maxLength={40} placeholder="about-us" className={field} /></label>
                <div className="flex items-end"><Button type="button" size="sm" variant="ghost" className="h-9 rounded-lg text-xs text-[var(--codiq-danger)]" onClick={() => setPages((current) => current.filter((_, at) => at !== index))}><Trash2 className="ml-1 h-4 w-4" />حذف</Button></div>
              </div>
              <label className={label}>النص<textarea value={page.body} onChange={(event) => set(index, { body: event.target.value })} maxLength={20000} className={area} placeholder="اكتب صفحتك هنا. سطر فارغ يبدأ فقرة جديدة." /></label>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" data-testid="add-custom-page" disabled={pages.length >= 6} className="h-9 rounded-lg text-xs" onClick={() => setPages((current) => [...current, { slug: "", title: "", body: "" }])}><Plus className="ml-1 h-4 w-4" />أضف صفحة</Button>
          <span className="text-[11px] text-[var(--codiq-text-muted)]">{pages.length} / 6</span>
        </div>
        <SaveRow busy={busy} notice={notice} error={error} labelText="حفظ الصفحات" />
      </form>
    </Card>
  );
}

function CheckoutCard({ settings, base, onSaved }: { settings: Settings; base: string; onSaved: (settings: Settings) => void }) {
  const { busy, notice, error, save } = useSection(base, onSaved);
  return (
    <Card icon={UserRound} title="خيارات الشراء" hint="هل يشتري الزبون من دون حساب؟ مفعّل افتراضياً: الزبون يكتب اسمه وهاتفه وعنوانه، ويمكنه لاحقاً اختيار كلمة مرور لحفظ طلباته." testId="storefront-checkout">
      <label className="flex items-center gap-3 text-sm font-bold text-[var(--codiq-text-secondary)]"><Switch data-testid="guest-checkout-switch" checked={settings.guestCheckoutEnabled} disabled={busy} aria-label="السماح بالشراء كضيف" onCheckedChange={(checked) => void save({ guestCheckoutEnabled: checked }, checked ? "الشراء كضيف مفعّل." : "صار الطلب يتطلب حساباً.")} />{settings.guestCheckoutEnabled ? "الشراء كضيف مفعّل" : "الطلب يتطلب تسجيل الدخول"}</label>
      {error ? <p role="alert" className="mt-2 text-xs font-bold text-[var(--codiq-danger)]">{error}</p> : notice ? <p role="status" className="mt-2 text-xs font-bold text-[var(--codiq-success)]">{notice}</p> : null}
    </Card>
  );
}

export function StorefrontSettingsPanel({ storeSlug }: { storeSlug?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = storeSlug ? `/api/merchant/stores/${encodeURIComponent(storeSlug)}/storefront` : null;
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    call<{ storefront: Settings }>(base).then((result) => { if (!cancelled) setSettings(result.storefront); }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "تعذر تحميل واجهة المتجر."); });
    return () => { cancelled = true; };
  }, [base]);
  if (!storeSlug || !base) return <p className="text-sm text-[var(--codiq-text-muted)]" dir="rtl">اختر متجراً لتحرير واجهته.</p>;
  if (error) return <div role="alert" className="rounded-2xl border border-[var(--codiq-danger-border)] bg-[var(--codiq-danger-soft)] p-4 text-sm text-[var(--codiq-danger)]" dir="rtl">{error}</div>;
  if (!settings) return <p className="flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]" dir="rtl"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ تحميل واجهة المتجر…</p>;
  const storeUrl = typeof window !== "undefined" ? `${window.location.origin}/store/${storeSlug}` : `/store/${storeSlug}`;
  return (
    <div className="max-w-[960px] space-y-5" dir="rtl" data-testid="storefront-settings">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-accent-soft)] px-5 py-4">
        <p className="text-sm leading-6 text-[var(--codiq-text-secondary)]">كل ما تحفظه هنا يظهر في متجرك فوراً. افتحه في تبويب آخر وقارن.</p>
        <a href={storeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--codiq-surface)] px-3 py-2 text-sm font-bold text-[var(--codiq-accent)] shadow-sm hover:bg-white"><ExternalLink className="h-4 w-4" />افتح المتجر</a>
      </div>
      <IdentityCard settings={settings} base={base} onSaved={setSettings} />
      <AnnouncementCard settings={settings} base={base} onSaved={setSettings} />
      <BannersCard storeSlug={storeSlug} />
      <SectionsCard settings={settings} base={base} onSaved={setSettings} />
      <ContactCard settings={settings} base={base} onSaved={setSettings} />
      <SocialCard settings={settings} base={base} onSaved={setSettings} />
      <PoliciesCard settings={settings} base={base} onSaved={setSettings} />
      <PagesCard settings={settings} base={base} onSaved={setSettings} />
      <CheckoutCard settings={settings} base={base} onSaved={setSettings} />
    </div>
  );
}
