import { ChevronDown, LoaderCircle, Plus, RotateCcw, StoreIcon } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type StoreSummary = { id: string; name: string; slug: string; isActive: boolean };
type ApiError = { error?: { code?: string; message?: string } };

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

function messageForError(error: ApiError, fallback: string) {
  if (error.error?.code === "STORE_LIMIT_REACHED") return "وصلت إلى الحد المؤقت المسموح به: ثلاثة متاجر.";
  if (error.error?.code === "DUPLICATE_STORE_SLUG") return "رابط المتجر مستخدم بالفعل. اختر رابطاً مختلفاً.";
  if (error.error?.code === "INVALID_STORE_SLUG") return "استخدم أحرفاً إنجليزية صغيرة وأرقاماً وشرطات فقط في رابط المتجر.";
  if (error.error?.code === "INVALID_STORE_NAME") return "أدخل اسماً صالحاً للمتجر.";
  return error.error?.message ?? fallback;
}

async function apiJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const payload = (await response.json().catch(() => ({}))) as ApiError & Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(messageForError(payload, "تعذر إكمال العملية الآن.")), { payload, status: response.status });
  return payload;
}

export function MerchantStoreSwitcher({ activeStoreSlug, navigate }: { activeStoreSlug?: string; navigate: (path: string) => void }) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  // P27-21 (ع-6): sign-in sends a merchant who owns more than one store to his
  // dashboard with `?stores=switch`, and the SERVER has been returning that
  // parameter since the batch shipped — while nothing here read it, so the
  // switcher stayed shut and the promise was untrue in the code and in its own
  // commit message. It opens on that signal now.
  const openedByLink = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("stores") === "switch";
  const [open, setOpen] = useState(openedByLink);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const activeStore = useMemo(() => stores.find((store) => store.slug === activeStoreSlug), [activeStoreSlug, stores]);

  const loadStores = async () => {
    setLoading(true);
    setLoadingError(null);
    try {
      const payload = await apiJson("/api/merchant/stores") as { stores: StoreSummary[] };
      setStores(payload.stores);
    } catch (error) {
      setLoadingError(error instanceof Error ? error.message : "تعذر تحميل متاجرك.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Switching stores closes the panel — but arriving WITH the signal must not,
    // or the mount would immediately undo what the link asked for.
    if (!openedByLink) setOpen(false);
    setFormOpen(false);
    setFormError(null);
    void loadStores();
  }, [activeStoreSlug]);

  const switchStore = async (store: StoreSummary) => {
    if (store.slug === activeStoreSlug || busySlug) return;
    setBusySlug(store.slug);
    setStatus(null);
    setFormError(null);
    try {
      const payload = await apiJson("/api/merchant/stores/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storeSlug: store.slug }),
      }) as { redirectTo: string };
      setStatus(`تم التبديل إلى ${store.name}.`);
      navigate(payload.redirectTo);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "تعذر تبديل المتجر.");
    } finally {
      setBusySlug(null);
    }
  };

  const createStore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    if (trimmedName.length < 2) return setFormError("أدخل اسم متجر مكوناً من حرفين على الأقل.");
    if (!slugPattern.test(slug)) return setFormError("استخدم أحرفاً إنجليزية صغيرة وأرقاماً وشرطات فقط في رابط المتجر.");
    setSubmitting(true);
    try {
      const payload = await apiJson("/api/merchant/stores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, slug }),
      }) as { redirectTo: string; store: StoreSummary };
      setStatus(`تم إنشاء ${payload.store.name} وتجهيزه بنجاح.`);
      navigate(payload.redirectTo);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "تعذر إنشاء المتجر.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 rounded-[18px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-1.5" aria-label="مبدّل المتاجر">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2.5 rounded-[13px] bg-[var(--codiq-surface)] px-3 py-2.5 text-right shadow-sm" aria-label="فتح مبدّل المتاجر" aria-expanded={open} aria-controls="merchant-store-switcher-panel">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]"><StoreIcon className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold text-[#34435B]">{loading ? "جارٍ تحميل المتاجر…" : activeStore?.name ?? "متجر الجلسة الحالي"}</span>
          <span className="block pt-0.5 text-[10px] text-[#8995AA]">{activeStore?.slug ?? activeStoreSlug ?? "سياق التاجر"}</span>
        </span>
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin text-[var(--codiq-accent)]" /> : <ChevronDown className={`h-4 w-4 text-[#8A96AA] transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>

      {open ? <div id="merchant-store-switcher-panel" className="mt-1.5 rounded-[13px] bg-[var(--codiq-surface)] p-2 shadow-sm" role="region" aria-label="خيارات المتاجر">
        {loadingError ? <div className="rounded-xl border border-[#F4CFD1] bg-[#FFF7F7] p-3 text-xs leading-5 text-[#A63A43]" role="alert">{loadingError}<button type="button" onClick={() => void loadStores()} className="mt-2 flex items-center gap-1 font-bold underline"><RotateCcw className="h-3 w-3" />إعادة المحاولة</button></div> : null}
        {!loading && !loadingError ? <div className="space-y-1" aria-label="قائمة المتاجر">{stores.map((store) => {
          const isCurrent = store.slug === activeStoreSlug;
          const isBusy = busySlug === store.slug;
          return <button key={store.id} type="button" data-store-switch-option={store.slug} disabled={isCurrent || Boolean(busySlug)} onClick={() => void switchStore(store)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-right text-xs transition-colors ${isCurrent ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)]" : "text-[#4B5B73] hover:bg-[var(--codiq-canvas)] disabled:opacity-60"}`}>
            <span className="min-w-0"><span className="block truncate font-bold">{store.name}</span><span className="mt-0.5 block truncate text-[10px] opacity-75">{store.slug}</span></span>
            <span className="shrink-0 text-[10px] font-bold">{isBusy ? "جارٍ التبديل…" : isCurrent ? "الحالي" : "تبديل"}</span>
          </button>;
        })}</div> : null}

        <button type="button" onClick={() => { setFormOpen((value) => !value); setFormError(null); }} className="mt-2 flex w-full items-center gap-2 rounded-xl border border-dashed border-[#B9CAE5] px-3 py-2.5 text-right text-xs font-bold text-[var(--codiq-accent)] hover:bg-[var(--codiq-canvas)]"><Plus className="h-4 w-4" />إنشاء متجر جديد</button>
        {formOpen ? <form onSubmit={(event) => void createStore(event)} className="mt-2 space-y-2 rounded-xl bg-[var(--codiq-surface-sunken)] p-3" noValidate>
          <label className="block text-[11px] font-bold text-[var(--codiq-text-secondary)]">اسم المتجر<input name="storeName" value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2.5 py-2 text-xs outline-none focus:border-[var(--codiq-accent)]" autoComplete="off" /></label>
          <label className="block text-[11px] font-bold text-[var(--codiq-text-secondary)]">رابط المتجر<input name="storeSlug" dir="ltr" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="my-store" className="mt-1 w-full rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2.5 py-2 text-left text-xs outline-none focus:border-[var(--codiq-accent)]" autoComplete="off" /></label>
          <p className="text-[10px] leading-5 text-[var(--codiq-text-muted)]">أحرف إنجليزية صغيرة وأرقام وشرطات، من 3 إلى 50 حرفاً.</p>
          {formError ? <p role="alert" className="rounded-lg bg-[var(--codiq-danger-soft)] px-2.5 py-2 text-[11px] leading-5 text-[#A63A43]">{formError}</p> : null}
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-[var(--codiq-accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-60">{submitting ? "جارٍ إنشاء المتجر…" : "إنشاء المتجر"}</button>
        </form> : null}
        {status ? <p role="status" className="mt-2 rounded-lg bg-[#ECFDF3] px-2.5 py-2 text-[11px] text-[#19714B]">{status}</p> : null}
        {!formOpen && formError ? <p role="alert" className="mt-2 rounded-lg bg-[var(--codiq-danger-soft)] px-2.5 py-2 text-[11px] text-[#A63A43]">{formError}</p> : null}
      </div> : null}
    </div>
  );
}
