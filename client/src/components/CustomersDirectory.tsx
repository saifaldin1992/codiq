/**
 * codiq menus pass A — store customers directory, shared by the merchant
 * dashboard and the staff dashboard (permission customers.view is enforced by
 * the server on every request). Segments are the owner-approved definitions:
 * الجدد = سجّلوا خلال ٣٠ يوماً، النشطون = لديهم طلب واحد فأكثر،
 * المحتملون = سجّلوا ولم يطلبوا بعد.
 */
import { useCallback, useEffect, useState } from "react";
import { Ban, CircleAlert, LoaderCircle, RefreshCw, Search, UserRound, UserRoundCheck, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";

type CustomerRow = {
  id: string;
  fullName: string;
  isGuest?: boolean;
  phone: string | null;
  email: string | null;
  createdAt: string;
  ordersCount: number;
  isActive: boolean;
};
type Segment = "" | "new" | "active" | "prospect";

const dateFormat = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium" });

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

/**
 * MD-1: the unified search links here with `?q=…` so a customer hit actually
 * lands on that customer instead of on an unfiltered directory. Read once at
 * mount — afterwards the field belongs to the merchant.
 */
function initialSearchFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

export function CustomersDirectory({ storeSlug }: { storeSlug?: string }) {
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  // ق-179: two taps to block, one to lift. The reason rides the audit event.
  const [blocking, setBlocking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>("");
  const [search, setSearch] = useState(initialSearchFromLocation);
  const [appliedSearch, setAppliedSearch] = useState(initialSearchFromLocation);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    if (!storeSlug) return;
    if (cursor) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (segment) params.set("segment", segment);
      if (appliedSearch.trim()) params.set("q", appliedSearch.trim());
      if (cursor) params.set("cursor", cursor);
      const result = await api<{ customers: CustomerRow[]; nextCursor: string | null }>(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/customers?${params.toString()}`);
      setCustomers((current) => (cursor ? [...(current ?? []), ...result.customers] : result.customers));
      setNextCursor(result.nextCursor);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تحميل العملاء.");
      if (!cursor) setCustomers(null);
    } finally {
      setLoadingMore(false);
    }
  }, [storeSlug, segment, appliedSearch]);
  useEffect(() => { void load(); }, [load]);

  if (!storeSlug) {
    return <div className="max-w-[640px] rounded-2xl border border-[#D6E5F7] bg-[var(--codiq-canvas)] px-4 py-3 text-sm leading-6 text-[#35577F]" dir="rtl">اختر متجراً عبر مسار اللوحة المقيد بالمتجر قبل قراءة العملاء.</div>;
  }

  const chips: { value: Segment; label: string }[] = [
    { value: "", label: "الكل" },
    { value: "new", label: "الجدد" },
    { value: "active", label: "النشطون" },
    { value: "prospect", label: "المحتملون" },
  ];

  async function setAccess(customer: CustomerRow, isActive: boolean) {
    if (!storeSlug) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/merchant/stores/${encodeURIComponent(storeSlug)}/customers/${encodeURIComponent(customer.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive, ...(isActive || !reason.trim() ? {} : { reason: reason.trim() }) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? "تعذر تغيير حالة الزبون.");
      setBlocking(null);
      setReason("");
      setCustomers((previous) => (previous ?? []).map((row) => (row.id === customer.id ? { ...row, isActive } : row)));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر تغيير حالة الزبون.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[860px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UsersRound className="h-4 w-4" /> عملاء المتجر الحالي — شرائح وبحث داخل صفحة واحدة</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="شرائح العملاء">
        {chips.map((chip) => (
          <button key={chip.value || "all"} type="button" onClick={() => setSegment(chip.value)} className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${segment === chip.value ? "bg-[var(--codiq-accent)] text-white shadow-sm" : "bg-[var(--codiq-neutral-soft)] text-[#64748A] hover:bg-[var(--codiq-accent-soft)] hover:text-[var(--codiq-accent-hover)]"}`}>{chip.label}</button>
        ))}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search); }} className="flex max-w-md items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-3 h-4 w-4 text-[#8794A8]" />
          <input aria-label="البحث في العملاء" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الهاتف أو البريد…" className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] py-2.5 pr-9 pl-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10" />
        </div>
        <Button type="submit" size="sm" className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]">بحث</Button>
      </form>
      {failure ? <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
      {customers === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
      {customers !== null && customers.length === 0 ? <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">لا يوجد عملاء ضمن هذه الشريحة.</p> : null}
      <div className="space-y-2">
        {customers?.map((customer) => (
          <div key={customer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#F0F5FF] text-[var(--codiq-accent)]"><UserRound className="h-4.5 w-4.5" /></div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[#263650]">{customer.fullName}{customer.isActive ? null : <span data-testid="customer-blocked" className="mr-2 rounded-full bg-[var(--codiq-danger-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--codiq-danger)]">محظور</span>}</p>
                <p className="mt-0.5 truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">{[customer.phone, customer.email].filter(Boolean).join(" · ") || "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-semibold">
              <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[#65748B]">الطلبات: {customer.ordersCount}</span>
              <span className="rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[#65748B]">سجّل: {dateFormat.format(new Date(customer.createdAt))}</span>
              {customer.isActive ? (
                blocking === customer.id ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <input value={reason} onChange={(event) => setReason(event.target.value.slice(0, 200))} placeholder="السبب (اختياري)" aria-label="سبب الحظر" className="h-8 w-40 rounded-lg border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-2 text-[11px] text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]" />
                    <Button type="button" size="sm" disabled={busy} data-testid="customer-block-confirm" onClick={() => void setAccess(customer, false)} className="h-8 rounded-lg bg-[var(--codiq-danger)] px-2.5 text-[11px] font-bold text-white hover:bg-[var(--codiq-danger)]">تأكيد الحظر</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setBlocking(null); setReason(""); }} className="h-8 rounded-lg px-2 text-[11px]">إلغاء</Button>
                  </span>
                ) : (
                  <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="customer-block" onClick={() => setBlocking(customer.id)} className="h-8 rounded-lg px-2.5 text-[11px] font-bold text-[var(--codiq-danger)]"><Ban className="ml-1 h-3.5 w-3.5" />حظر</Button>
                )
              ) : (
                <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="customer-unblock" onClick={() => void setAccess(customer, true)} className="h-8 rounded-lg px-2.5 text-[11px] font-bold text-[var(--codiq-success)]"><UserRoundCheck className="ml-1 h-3.5 w-3.5" />رفع الحظر</Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {nextCursor ? <div className="flex justify-center"><Button type="button" variant="outline" disabled={loadingMore} onClick={() => void load(nextCursor)} className="rounded-xl border-[#C9D9EE]">{loadingMore ? <LoaderCircle className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}تحميل المزيد</Button></div> : null}
    </div>
  );
}
