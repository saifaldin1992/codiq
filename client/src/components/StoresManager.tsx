/**
 * codiq menus pass A — merchant stores pages:
 * - list: every store with in-page status filters (replacing the old
 *   النشطة/المعلّقة/المؤرشفة sidebar entries);
 * - create: a dedicated creation form over the same POST /merchant/stores the
 *   switcher uses (session moves to the new store on success);
 * - manage: the active store card — rename (PATCH, name only), slug, relative
 *   public link /store/{slug} with a copy button. QR rendering is deferred
 *   (needs a generator library; the vector-only visual rule stays intact).
 */
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, Copy, ExternalLink, LoaderCircle, Palmtree, Pencil, Plus, RefreshCw, StoreIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type StoreSummary = { id: string; name: string; slug: string; isActive: boolean };
type ApiErrorBody = { error?: { code?: string; message?: string } };

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

function messageForError(body: ApiErrorBody, fallback: string) {
  if (body.error?.code === "PLAN_LIMIT_EXCEEDED") return body.error.message ?? "وصلت إلى حد خطة الاشتراك.";
  if (body.error?.code === "DUPLICATE_STORE_SLUG") return "رابط المتجر مستخدم بالفعل. اختر رابطاً مختلفاً.";
  if (body.error?.code === "INVALID_STORE_SLUG") return "استخدم أحرفاً إنجليزية صغيرة وأرقاماً وشرطات فقط في رابط المتجر.";
  if (body.error?.code === "INVALID_STORE_NAME") return "اسم المتجر يجب أن يتكون من حرفين إلى 120 حرفاً.";
  return body.error?.message ?? fallback;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (!response.ok) throw new Error(messageForError(body, "تعذر إكمال العملية الآن."));
  return body;
}

function StatusPill({ isActive }: { isActive: boolean }) {
  return isActive
    ? <span className="rounded-full bg-[var(--codiq-success-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-success)]">نشط</span>
    : <span className="rounded-full bg-[var(--codiq-danger-soft)] px-2.5 py-1 text-[11px] font-bold text-[#B44B40]">معطّل</span>;
}

function StoresList({ activeStoreSlug, navigate }: { activeStoreSlug?: string; navigate: (path: string) => void }) {
  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const load = useCallback(async () => {
    try {
      const payload = await apiJson<{ stores: StoreSummary[] }>("/api/merchant/stores");
      setStores(payload.stores);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تحميل المتاجر.");
      setStores(null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!stores) return [];
    if (statusFilter === "active") return stores.filter((store) => store.isActive);
    if (statusFilter === "inactive") return stores.filter((store) => !store.isActive);
    return stores;
  }, [stores, statusFilter]);

  const chips = [
    { value: "all" as const, label: "الكل" },
    { value: "active" as const, label: "النشطة" },
    { value: "inactive" as const, label: "المعطّلة" },
  ];

  return (
    <div className="max-w-[860px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><StoreIcon className="h-4 w-4" /> متاجرك — حالة كل متجر وفلاتر داخل الصفحة</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
          <Button size="sm" onClick={() => navigate("/merchant/dashboard/stores/create")} className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"><Plus className="ml-1 h-4 w-4" /> إنشاء متجر</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="تصفية حسب الحالة">
        {chips.map((chip) => (
          <button key={chip.value} type="button" onClick={() => setStatusFilter(chip.value)} className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${statusFilter === chip.value ? "bg-[var(--codiq-accent)] text-white shadow-sm" : "bg-[var(--codiq-neutral-soft)] text-[#64748A] hover:bg-[var(--codiq-accent-soft)] hover:text-[var(--codiq-accent-hover)]"}`}>{chip.label}</button>
        ))}
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {stores === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {stores !== null && filtered.length === 0 ? <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">لا توجد متاجر ضمن هذا الفلتر.</p> : null}
      <div className="space-y-2">
        {filtered.map((store) => (
          <div key={store.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-bold text-[#263650]">{store.name}</p>
                <StatusPill isActive={store.isActive} />
                {store.slug === activeStoreSlug ? <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">متجر الجلسة</span> : null}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">/store/{store.slug}</p>
            </div>
            {store.slug === activeStoreSlug ? (
              <Button size="sm" variant="outline" onClick={() => navigate(`/merchant/stores/${encodeURIComponent(store.slug)}/dashboard/stores/manage`)} className="rounded-xl border-[#C9D9EE] text-[var(--codiq-accent)]"><Pencil className="ml-1 h-3.5 w-3.5" /> إدارة المتجر</Button>
            ) : (
              <span className="text-[11px] font-semibold text-[#8994A8]">بدّل إليه من مبدّل المتاجر لإدارته</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StoreCreateForm({ navigate }: { navigate: (path: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function createStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    if (trimmedName.length < 2) return setFormError("أدخل اسم متجر مكوناً من حرفين على الأقل.");
    if (!slugPattern.test(slug)) return setFormError("استخدم أحرفاً إنجليزية صغيرة وأرقاماً وشرطات فقط في رابط المتجر.");
    setSubmitting(true);
    try {
      const payload = await apiJson<{ redirectTo: string; store: StoreSummary }>("/api/merchant/stores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, slug }),
      });
      navigate(payload.redirectTo);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "تعذر إنشاء المتجر.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-[640px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9" dir="rtl">
      <p className="mb-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">متجر جديد ضمن حدود خطتك</p>
      <h2 className="mb-1 text-xl font-bold text-[#263650]">إنشاء متجر</h2>
      <p className="mb-5 text-sm leading-6 text-[var(--codiq-text-muted)]">ينشأ المتجر بأساساته كاملة (رابط عام، توصيل، إشعارات) وتنتقل جلستك إليه فوراً.</p>
      <form onSubmit={(event) => void createStore(event)} className="space-y-4" noValidate>
        <label className="block text-xs font-bold text-[var(--codiq-text-secondary)]">اسم المتجر
          <input name="storeName" value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" autoComplete="off" />
        </label>
        <label className="block text-xs font-bold text-[var(--codiq-text-secondary)]">رابط المتجر
          <input name="storeSlug" dir="ltr" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="my-store" className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-left text-sm outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" autoComplete="off" />
        </label>
        <p className="text-[11px] leading-5 text-[var(--codiq-text-muted)]">أحرف إنجليزية صغيرة وأرقام وشرطات، من 3 إلى 50 حرفاً. الرابط هوية عامة ولا يتغير لاحقاً.</p>
        {formError ? <p role="alert" className="rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2.5 text-xs leading-5 text-[#A63A43]">{formError}</p> : null}
        <Button type="submit" disabled={submitting} className="rounded-xl bg-[var(--codiq-accent)] px-5 hover:bg-[var(--codiq-accent-hover)]">{submitting ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}إنشاء المتجر</Button>
      </form>
    </div>
  );
}

function StoreManagePanel({ storeSlug }: { storeSlug?: string }) {
  const [store, setStore] = useState<StoreSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!storeSlug) return;
    try {
      const payload = await apiJson<{ stores: StoreSummary[] }>("/api/merchant/stores");
      const current = payload.stores.find((row) => row.slug === storeSlug) ?? null;
      setStore(current);
      setName(current?.name ?? "");
      setFailure(current ? null : "متجر الجلسة غير موجود ضمن متاجرك.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تحميل بيانات المتجر.");
    }
  }, [storeSlug]);
  useEffect(() => { void load(); }, [load]);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!store) return;
    setSaving(true);
    setNotice(null);
    setFailure(null);
    try {
      const payload = await apiJson<{ store: StoreSummary }>(`/api/merchant/stores/${encodeURIComponent(store.slug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setStore(payload.store);
      setName(payload.store.name);
      setNotice("تم حفظ اسم المتجر الجديد.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر إعادة التسمية.");
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    if (!store) return;
    const url = `${window.location.origin}/store/${encodeURIComponent(store.slug)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailure("تعذر النسخ تلقائياً — انسخ الرابط يدوياً.");
    }
  }

  if (!storeSlug) {
    return <div className="max-w-[640px] rounded-2xl border border-[#D6E5F7] bg-[var(--codiq-canvas)] px-4 py-3 text-sm leading-6 text-[#35577F]" dir="rtl">اختر متجراً عبر مبدّل المتاجر أولاً لإدارة بياناته.</div>;
  }

  return (
    <div className="max-w-[640px] space-y-4" dir="rtl">
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
      {store === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {store ? (
        <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><StoreIcon className="h-5 w-5" /></div>
              <div>
                <p className="text-lg font-bold text-[#263650]">{store.name}</p>
                <p className="text-xs text-[#8994A8]" dir="ltr">{store.slug}</p>
              </div>
            </div>
            <StatusPill isActive={store.isActive} />
          </div>

          <form onSubmit={(event) => void rename(event)} className="mt-6 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
            <label className="block text-xs font-bold text-[var(--codiq-text-secondary)]">اسم المتجر
              <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" />
            </label>
            <p className="mt-2 text-[11px] leading-5 text-[var(--codiq-text-muted)]">تُعاد التسمية فوراً؛ رابط المتجر (slug) هوية عامة ولا يتغير.</p>
            <Button type="submit" disabled={saving || name.trim() === store.name} className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">{saving ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <Pencil className="ml-2 h-4 w-4" />}حفظ الاسم</Button>
          </form>

          <div className="mt-4 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
            <p className="text-xs font-bold text-[var(--codiq-text-secondary)]">رابط المتجر العام</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded-xl bg-[var(--codiq-surface)] px-3 py-2 text-sm font-semibold text-[var(--codiq-text)] shadow-sm" dir="ltr">/store/{store.slug}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyLink()} className="rounded-xl border-[#C9D9EE] text-[var(--codiq-accent)]">{copied ? <Check className="ml-1 h-3.5 w-3.5" /> : <Copy className="ml-1 h-3.5 w-3.5" />}{copied ? "نُسخ" : "نسخ الرابط"}</Button>
              <a href={`/store/${encodeURIComponent(store.slug)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs font-bold text-[var(--codiq-accent)] hover:bg-[var(--codiq-neutral-soft)]"><ExternalLink className="h-3.5 w-3.5" /> فتح</a>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[var(--codiq-text-muted)]">يُنسخ الرابط الكامل بنطاق المنصة الحالي. رمز QR للرابط مؤجل لدفعة لاحقة (يتطلب مكتبة توليد، والتزامنا الحالي أيقونات vector فقط).</p>
          </div>

          <StoreStatusPanel storeSlug={store.slug} />
          <StoreMaintenanceWindows storeSlug={store.slug} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * ق-249 (المرحلة 29) — «حالة المتجر»: the MD-1 vacation switch grew into the
 * store's ONE named status. Four the merchant may choose: active; paused (the
 * old vacation — browsing open, checkout refused with 422 STORE_ON_VACATION
 * and his message as a banner); maintenance (closed to shoppers, this
 * dashboard stays, the shell shows his sentence and an optional return time);
 * closed. «suspended» is the platform's word and never appears here.
 */
const STATUS_MESSAGE_MAX_LENGTH = 500;
type StoreStatus = "active" | "paused" | "maintenance" | "suspended" | "closed";
const STATUS_OPTIONS: { value: Exclude<StoreStatus, "suspended">; label: string; detail: string }[] = [
  { value: "active", label: "نشط", detail: "يتصفّح الزبائن ويطلبون." },
  { value: "paused", label: "إجازة", detail: "التصفّح مفتوح، والطلبات الجديدة موقوفة برسالتك." },
  { value: "maintenance", label: "صيانة", detail: "المتجر مغلق للزبائن مؤقّتاً؛ لوحتك تعمل." },
  { value: "closed", label: "مغلق", detail: "المتجر يختفي من الزبائن حتى تعيد فتحه." },
];

function StoreStatusPanel({ storeSlug }: { storeSlug: string }) {
  const [status, setStatus] = useState<StoreStatus>("active");
  const [message, setMessage] = useState("");
  const [until, setUntil] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const path = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/status`;
  type StatusPayload = { status: StoreStatus; message: string | null; maintenanceUntil: string | null };

  const load = useCallback(async () => {
    try {
      const payload = await apiJson<StatusPayload>(path);
      setStatus(payload.status);
      setMessage(payload.message ?? "");
      setUntil(payload.maintenanceUntil ? payload.maintenanceUntil.slice(0, 16) : "");
      setFailure(null);
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تحميل حالة المتجر."); }
    finally { setLoaded(true); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);

  async function save(next: Exclude<StoreStatus, "suspended">) {
    setSaving(true);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { status: next, message: message.trim() || null };
      if (next === "maintenance" && until) body.maintenanceUntil = new Date(until).toISOString();
      const payload = await apiJson<StatusPayload>(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setStatus(payload.status);
      setMessage(payload.message ?? "");
      setFailure(null);
      setNotice(STATUS_OPTIONS.find((option) => option.value === payload.status)?.detail ?? "حُفظت الحالة.");
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر حفظ حالة المتجر."); }
    finally { setSaving(false); }
  }

  return (
    <div className="mt-4 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4" data-testid="store-status-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><Palmtree className="h-4 w-4 text-[var(--codiq-warning)]" /> حالة المتجر</p>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${status === "active" ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" : "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"}`} data-testid="store-status-badge">{status === "suspended" ? "موقوف من المنصّة" : STATUS_OPTIONS.find((option) => option.value === status)?.label}</span>
      </div>
      {status === "suspended" ? <p className="mt-2 text-[11px] leading-5 text-[var(--codiq-danger)]">أوقفت المنصّة هذا المتجر — تواصل مع الدعم لرفع الإيقاف.</p> : <>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {STATUS_OPTIONS.map((option) => <label key={option.value} className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 ${status === option.value ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)]" : "border-[var(--codiq-border)]"}`}>
            <input type="radio" name="store-status" value={option.value} checked={status === option.value} disabled={!loaded || saving} onChange={() => setStatus(option.value)} className="mt-1" data-testid={`store-status-${option.value}`} />
            <span><span className="block text-xs font-bold text-[var(--codiq-text)]">{option.label}</span><span className="block text-[11px] leading-5 text-[var(--codiq-text-muted)]">{option.detail}</span></span>
          </label>)}
        </div>
        <label className="mt-3 block text-xs font-bold text-[var(--codiq-text-secondary)]">رسالتك للزبائن (تظهر في الإجازة والصيانة)
          <textarea data-testid="store-status-message" value={message} maxLength={STATUS_MESSAGE_MAX_LENGTH} rows={2} onChange={(event) => setMessage(event.target.value)} placeholder="مثال: نعود بعد العيد — طلباتكم تصلنا وننفّذها حال العودة." className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm font-normal text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
        </label>
        {status === "maintenance" ? <label className="mt-3 block text-xs font-bold text-[var(--codiq-text-secondary)]">موعد العودة (اختياريّ)
          <input type="datetime-local" data-testid="store-status-until" value={until} onChange={(event) => setUntil(event.target.value)} className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm font-normal text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
        </label> : null}
        <Button type="button" size="sm" disabled={!loaded || saving} data-testid="store-status-save" onClick={() => void save(status as Exclude<StoreStatus, "suspended">)} className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">{saving ? <LoaderCircle className="ml-1 h-4 w-4 animate-spin" /> : null}حفظ الحالة</Button>
      </>}
      {failure ? <p className="mt-2 text-[11px] font-bold text-[var(--codiq-danger)]">{failure}</p> : null}
      {notice && !failure ? <p data-testid="store-status-notice" className="mt-2 text-[11px] font-bold text-[var(--codiq-success)]">{notice}</p> : null}
    </div>
  );
}

/**
 * ق-250: the merchant's own scheduled maintenance. He names an hour (Baghdad),
 * the shop closes to shoppers with his sentence when it comes and reopens when
 * it passes — no one has to be awake for either. A window the platform placed
 * on his store is listed but not his to cancel.
 */
type StoreWindow = { id: string; phase: "upcoming" | "active" | "ended" | "cancelled"; startsAtLocal: string; endsAtLocal: string; messageAr: string; createdByKind: string };
const WINDOW_PHASE_LABELS: Record<StoreWindow["phase"], string> = { upcoming: "قادمة", active: "جارية الآن", ended: "انتهت", cancelled: "أُلغيت" };
function StoreMaintenanceWindows({ storeSlug }: { storeSlug: string }) {
  const [windows, setWindows] = useState<StoreWindow[] | null>(null);
  const [form, setForm] = useState({ startsAt: "", endsAt: "", messageAr: "" });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/maintenance-windows`;
  async function load() {
    try { setWindows((await apiJson<{ windows: StoreWindow[] }>(`${path}?live=true`)).windows); setFailure(null); }
    catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تحميل نوافذ الصيانة."); }
  }
  useEffect(() => { void load(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  async function schedule() {
    setSaving(true); setFailure(null); setNotice(null);
    try {
      await apiJson<{ window: StoreWindow }>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), messageAr: form.messageAr }) });
      setNotice("سُجّلت نافذة الصيانة — يُغلق المتجر ويُفتح في موعديها من تلقاء نفسه.");
      setForm({ startsAt: "", endsAt: "", messageAr: "" });
      await load();
    } catch (error) { setFailure(error instanceof Error ? error.message : "تعذر تسجيل النافذة."); }
    finally { setSaving(false); }
  }
  async function cancel(id: string) {
    setFailure(null); setNotice(null);
    try { await apiJson<{ window: StoreWindow }>(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" }); setNotice("أُلغيت النافذة."); await load(); }
    catch (error) { setFailure(error instanceof Error ? error.message : "تعذر الإلغاء."); }
  }
  const canSchedule = Boolean(form.startsAt && form.endsAt && form.messageAr.trim().length >= 3);
  return (
    <div className="mt-4 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4" data-testid="store-maintenance-windows">
      <p className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]"><Palmtree className="h-4 w-4 text-[var(--codiq-warning)]" /> صيانة مجدولة</p>
      <p className="mt-2 text-[11px] leading-5 text-[var(--codiq-text-muted)]">سمِّ ساعةً بتوقيت بغداد: يُغلق المتجر للزبائن برسالتك حين تأتي ويُفتح حين تمضي — لوحتك تعمل طوال الوقت.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-bold text-[var(--codiq-text-secondary)]">من<input type="datetime-local" data-testid="store-window-starts" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></label>
        <label className="block text-xs font-bold text-[var(--codiq-text-secondary)]">إلى<input type="datetime-local" data-testid="store-window-ends" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" /></label>
      </div>
      <label className="mt-3 block text-xs font-bold text-[var(--codiq-text-secondary)]">رسالتك للزبائن أثناء الصيانة
        <textarea data-testid="store-window-message" value={form.messageAr} maxLength={STATUS_MESSAGE_MAX_LENGTH} rows={2} onChange={(event) => setForm({ ...form, messageAr: event.target.value })} placeholder="مثال: نرتّب المخزن — نعود الساعة الرابعة فجراً" className="mt-1.5 w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
      </label>
      <Button type="button" size="sm" disabled={saving || !canSchedule} data-testid="store-window-submit" onClick={() => void schedule()} className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">سجّل النافذة</Button>
      {windows && windows.length > 0 ? <ul className="mt-3 divide-y divide-[var(--codiq-border)] rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)]">
        {windows.map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs" data-testid="store-window-row">
          <span><span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${row.phase === "active" ? "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" : "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]"}`}>{WINDOW_PHASE_LABELS[row.phase]}</span> <span dir="ltr">{row.startsAtLocal} → {row.endsAtLocal}</span> · {row.messageAr}{row.createdByKind === "platform_owner" || row.createdByKind === "platform_staff" ? <span className="mr-1 text-[var(--codiq-text-muted)]">(من المنصّة)</span> : null}</span>
          {row.createdByKind === "merchant" || row.createdByKind === "staff" ? <Button type="button" variant="outline" size="sm" className="rounded-xl" data-testid="store-window-cancel" onClick={() => void cancel(row.id)}>{row.phase === "active" ? "أنهِ الآن" : "إلغاء"}</Button> : null}
        </li>)}
      </ul> : null}
      {failure ? <p className="mt-2 text-[11px] font-bold text-[var(--codiq-danger)]">{failure}</p> : null}
      {notice && !failure ? <p data-testid="store-window-notice" className="mt-2 text-[11px] font-bold text-[var(--codiq-success)]">{notice}</p> : null}
    </div>
  );
}

export function StoresManager({ mode, storeSlug, navigate }: { mode: "list" | "create" | "manage"; storeSlug?: string; navigate: (path: string) => void }) {
  if (mode === "create") return <StoreCreateForm navigate={navigate} />;
  if (mode === "manage") return <StoreManagePanel storeSlug={storeSlug} />;
  return <StoresList activeStoreSlug={storeSlug} navigate={navigate} />;
}
