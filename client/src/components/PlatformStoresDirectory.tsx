/**
 * codiq menus pass A — owner platform-wide stores list («المتاجر») over the new
 * read-only GET /platform/stores endpoint.
 */
import { StoreVerificationPanel } from "@/components/StoreVerificationPanel";
import { StoreMessagingCapsPanel } from "@/components/StoreMessagingCapsPanel";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, CircleAlert, LoaderCircle, RefreshCw, Search, ShieldCheck, ShieldOff, Store } from "lucide-react";
import { Button } from "@/components/ui/button";

type StoreRow = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  /** ق-249: the one named status; `suspended` is the platform's and only the platform lifts it. */
  status: StoreStatus;
  statusMessage: string | null;
  createdAt: string;
  /** MD-6: null unless the platform owner granted the badge. */
  verifiedAt: string | null;
  merchant: { businessName: string; email: string };
};

type StoreStatus = "active" | "paused" | "maintenance" | "suspended" | "closed";

// ق-249: one pill per named status — the owner reads the store's state, not a boolean.
const STATUS_PILL: Record<StoreStatus, { label: string; className: string }> = {
  active: { label: "نشط", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  paused: { label: "إجازة", className: "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)]" },
  maintenance: { label: "صيانة", className: "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-hover)]" },
  suspended: { label: "موقوف من المنصّة", className: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
  closed: { label: "مغلق", className: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function PlatformStoresDirectory() {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [stores, setStores] = useState<StoreRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // ق-249: the platform's suspension of ONE store — a written message the
  // shopper and the merchant both read; the merchant cannot lift it.
  const [suspendingSlug, setSuspendingSlug] = useState<string | null>(null);
  const [suspendMessage, setSuspendMessage] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const result = await api<{ stores: StoreRow[]; nextCursor: string | null }>(`/api/platform/stores?${params.toString()}`);
      setStores((current) => (cursor ? [...(current ?? []), ...result.stores] : result.stores));
      setNextCursor(result.nextCursor);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      if (!cursor) setStores(null);
    } finally {
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function setStoreStatus(store: StoreRow, status: "suspended" | "active") {
    setBusySlug(store.slug);
    setFailure(null);
    try {
      const result = await api<{ storeSlug: string; status: StoreStatus; message: string | null }>(`/api/platform/stores/${store.slug}/status`, {
        method: "PATCH",
        body: JSON.stringify(status === "suspended" ? { status, message: suspendMessage.trim() } : { status, message: null }),
      });
      setStores((current) => (current ?? []).map((row) => (row.slug === store.slug
        ? { ...row, status: result.status, statusMessage: result.message, isActive: result.status !== "suspended" && result.status !== "closed" }
        : row)));
      setNotice(status === "suspended"
        ? `أُوقف «${store.name}» — زبائنه يقرؤون رسالة الإيقاف، وتاجره لا يستطيع رفعه.`
        : `أُعيد «${store.name}» — المتجر مفتوح من جديد.`);
      setSuspendingSlug(null);
      setSuspendMessage("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusySlug(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !stores) return stores ?? [];
    return stores.filter((store) => store.name.toLowerCase().includes(needle) || store.slug.includes(needle) || store.merchant.businessName.toLowerCase().includes(needle) || store.merchant.email.toLowerCase().includes(needle));
  }, [stores, search]);

  return (
    <div className="max-w-[1030px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><Store className="h-4 w-4" /> متاجر المنصة — قراءة إشرافية لكل المتاجر وتجارها</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
      </div>
      <div className="relative max-w-md">
        <Search className="absolute right-3 top-3 h-4 w-4 text-[#8794A8]" />
        <input aria-label="البحث في المتاجر" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الرابط أو التاجر…" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] py-2.5 pr-9 pl-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" />
      </div>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {notice ? <p data-testid="platform-store-status-notice" className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
      {stores === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {stores !== null && filtered.length === 0 ? <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">لا توجد متاجر مطابقة.</p> : null}
      <div className="space-y-2">
        {filtered.map((store) => (
          <div key={store.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-bold text-[#263650]">{store.name}</p>
                <span data-testid={`platform-store-status-${store.slug}`} className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${(STATUS_PILL[store.status] ?? STATUS_PILL.active).className}`}>{(STATUS_PILL[store.status] ?? STATUS_PILL.active).label}</span>
                {store.verifiedAt ? <span className="flex items-center gap-1 rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]"><BadgeCheck className="h-3 w-3" />موثّق</span> : null}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--codiq-text-muted)]"><span dir="ltr">/store/{store.slug}</span> · {store.merchant.businessName} · <span dir="ltr">{store.merchant.email}</span></p>
              {store.status !== "active" && store.statusMessage ? <p className="mt-1 text-xs text-[var(--codiq-text-secondary)]">«{store.statusMessage}»</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpenSlug((current) => (current === store.slug ? null : store.slug))} className="rounded-xl">
                <BadgeCheck className="ml-1 h-3.5 w-3.5" />{openSlug === store.slug ? "إخفاء التوثيق" : "التوثيق"}
              </Button>
              {store.status === "suspended"
                ? <Button type="button" size="sm" data-testid={`platform-store-resume-${store.slug}`} disabled={busySlug !== null} onClick={() => void setStoreStatus(store, "active")} className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[var(--codiq-success-hover)]">{busySlug === store.slug ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="ml-1 h-3.5 w-3.5" />} إعادة المتجر</Button>
                : <Button type="button" variant="outline" size="sm" data-testid={`platform-store-suspend-${store.slug}`} disabled={busySlug !== null} onClick={() => { setSuspendingSlug(suspendingSlug === store.slug ? null : store.slug); setSuspendMessage(""); }} className="rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"><ShieldOff className="ml-1 h-3.5 w-3.5" /> إيقاف المتجر</Button>}
            </div>
            {suspendingSlug === store.slug ? (
              <div className="w-full rounded-xl border border-[var(--codiq-danger-border)] p-3">
                <label className="block text-xs font-bold text-[var(--codiq-text)]">
                  رسالة الإيقاف <span className="font-semibold text-[var(--codiq-text-muted)]">(يقرؤها زبائن المتجر وتاجره، وتبقى في سجلّ التدقيق)</span>
                  <input autoFocus value={suspendMessage} onChange={(event) => setSuspendMessage(event.target.value)} maxLength={300} placeholder="مثال: المتجر موقوف مؤقتاً لمراجعة بلاغات الزبائن" className="mt-1 h-9 w-full rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2 text-xs outline-none focus:border-[var(--codiq-accent)]" />
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" data-testid={`platform-store-suspend-confirm-${store.slug}`} disabled={busySlug !== null || suspendMessage.trim().length < 3} onClick={() => void setStoreStatus(store, "suspended")} className="rounded-xl bg-[var(--codiq-danger)] text-white hover:bg-[var(--codiq-danger-hover)]">{busySlug === store.slug ? <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}تأكيد الإيقاف</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSuspendingSlug(null)} className="rounded-xl">إلغاء</Button>
                  <p className="w-full text-[11px] leading-5 text-[var(--codiq-text-secondary)]">الإيقاف من المنصّة يُغلق المتجر أمام الزبائن بالرسالة أعلاه، ويمنع التاجر من تغيير حالته حتى تُعيده من هنا. الطلبات والقيود لا تُمسّ.</p>
                </div>
              </div>
            ) : null}
            {/* MD-6: opened per store rather than listed for all — the criteria are
                computed live, so rendering them for every row would be a query per row. */}
            {openSlug === store.slug ? <div className="w-full"><StoreVerificationPanel storeSlug={store.slug} /><StoreMessagingCapsPanel storeSlug={store.slug} /></div> : null}
          </div>
        ))}
      </div>
      {nextCursor ? <div className="flex justify-center"><Button type="button" variant="outline" disabled={loadingMore} onClick={() => void load(nextCursor)} className="rounded-xl border-[#C9D9EE]">{loadingMore ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}تحميل المزيد</Button></div> : null}
    </div>
  );
}
