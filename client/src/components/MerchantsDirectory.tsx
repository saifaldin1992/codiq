/**
 * codiq menus pass A — owner merchants directory («التجار», absorbing «إدارة التجار»).
 * Reads GET /platform/merchants and cross-references the pending registration
 * queue: pending merchants expose approve/reject (the only decision the
 * approval endpoint accepts), decided merchants show their live active state.
 * Financial history is append-only by design, so there is no delete here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  CreditCard,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Store,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type MerchantRow = {
  id: string;
  email: string;
  businessName: string;
  ownerName: string | null;
  phone: string | null;
  isActive: boolean;
  storeCount: number;
  plan: { code: string; name: string } | null;
};
type RegistrationRequest = { id: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function MerchantsDirectory({ navigate }: { navigate: (path: string) => void }) {
  const [merchants, setMerchants] = useState<MerchantRow[] | null>(null);
  // D-74: `listMerchantsWithPlans()` took no arguments and returned every
  // merchant on the platform. It is a keyset page now, newest first.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // ق-225: which row is asking for a suspension reason, and what has been typed.
  const [suspendingId, setSuspendingId] = useState<string | null>(null);
  const [suspendReason, setSuspendReason] = useState("");

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const [merchantsResult, requestsResult] = await Promise.all([
        api<{ merchants: MerchantRow[]; nextCursor: string | null }>(
          `/api/platform/merchants?${query.toString()}`
        ),
        api<{ requests: RegistrationRequest[]; nextCursor: string | null }>(
          "/api/platform/merchants/registration-requests?limit=100"
        ),
      ]);
      setMerchants((current) =>
        cursor ? [...(current ?? []), ...merchantsResult.merchants] : merchantsResult.merchants
      );
      setNextCursor(merchantsResult.nextCursor);
      // The pending set is only used to badge a row that is already on screen,
      // so it follows the same page window rather than the whole queue.
      setPendingIds((current) => {
        const next = cursor ? new Set(current) : new Set<string>();
        for (const request of requestsResult.requests) next.add(request.id);
        return next;
      });
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      if (!cursor) setMerchants(null);
    } finally {
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * ق-225 — stopping a merchant the platform has already approved.
   *
   * The approve/reject pair above only ever reached a PENDING registration; an
   * approved merchant could not be stopped from any screen, which in a
   * cash-on-delivery market is the whole trust-and-safety response missing. The
   * reason is required by the server and asked for here rather than in a
   * `window.prompt`, because it is read months later in the audit log by someone
   * deciding whether to lift the suspension.
   */
  async function setSuspension(merchant: MerchantRow, suspended: boolean) {
    setBusyId(merchant.id);
    setNotice(null);
    setFailure(null);
    try {
      await api(`/api/platform/merchants/${merchant.id}/suspension`, {
        method: "POST",
        body: JSON.stringify({ suspended, reason: suspendReason.trim() }),
      });
      setNotice(
        suspended
          ? `أُوقف «${merchant.businessName}»: متاجره مغلقة أمام الزبائن وجلساته وجلسات موظفيه أُنهيت. سجلّاته المالية كما هي.`
          : `رُفع الإيقاف عن «${merchant.businessName}» — متاجره مفتوحة من جديد.`
      );
      setSuspendingId(null);
      setSuspendReason("");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusyId(null);
    }
  }

  async function decide(merchant: MerchantRow, action: "approve" | "reject") {
    setBusyId(merchant.id);
    setNotice(null);
    setFailure(null);
    try {
      await api(`/api/platform/merchants/${merchant.id}/approval`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setNotice(
        action === "approve"
          ? `تم تفعيل «${merchant.businessName}» ومتاجره.`
          : `أُوقف طلب «${merchant.businessName}».`
      );
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !merchants) return merchants ?? [];
    return merchants.filter(
      (merchant) =>
        merchant.businessName.toLowerCase().includes(needle) ||
        merchant.email.toLowerCase().includes(needle)
    );
  }, [merchants, search]);

  function statusBadge(merchant: MerchantRow) {
    if (pendingIds.has(merchant.id))
      return (
        <span className="rounded-full bg-[var(--codiq-warning-soft)] px-2.5 py-1 text-[11px] font-bold text-[#A76B13]">
          بانتظار الموافقة
        </span>
      );
    return merchant.isActive ? (
      <span className="rounded-full bg-[var(--codiq-success-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-success)]">
        نشط
      </span>
    ) : (
      <span className="rounded-full bg-[var(--codiq-danger-soft)] px-2.5 py-1 text-[11px] font-bold text-[#B44B40]">
        موقوف
      </span>
    );
  }

  return (
    <div className="max-w-[1030px] space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <UsersRound className="h-4 w-4" /> دليل التجار — التفعيل والإيقاف وإدارة الاشتراك من مكان
          واحد
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          className="rounded-xl text-[var(--codiq-text-secondary)]"
        >
          <RefreshCw className="ml-1 h-4 w-4" /> تحديث
        </Button>
      </div>
      <div className="relative max-w-md">
        <Search className="absolute right-3 top-3 h-4 w-4 text-[#8794A8]" />
        <input
          aria-label="البحث في التجار"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="بحث ضمن المعروض بالاسم أو البريد…"
          className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] py-2.5 pr-9 pl-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)] focus:ring-4 focus:ring-[var(--codiq-accent)]/10"
        />
      </div>
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">
          {notice}
        </p>
      ) : null}
      {merchants === null && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {merchants !== null && filtered.length === 0 ? (
        <p className="rounded-2xl bg-[var(--codiq-surface)] px-4 py-6 text-center text-sm text-[var(--codiq-text-muted)] shadow-sm">
          لا يوجد تجار مطابقون.
        </p>
      ) : null}
      <div className="space-y-2">
        {filtered.map((merchant) => {
          const pending = pendingIds.has(merchant.id);
          return (
            <div
              key={merchant.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-bold text-[#263650]">
                    {merchant.businessName}
                  </p>
                  {statusBadge(merchant)}
                </div>
                <p className="mt-1 truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                  {merchant.email}
                </p>
                {merchant.ownerName || merchant.phone ? (
                  <p
                    data-testid={`merchant-contact-${merchant.email}`}
                    className="mt-0.5 truncate text-xs text-[var(--codiq-text-secondary)]"
                  >
                    {merchant.ownerName ?? "—"}
                    {merchant.phone ? (
                      <>
                        {" "}
                        · <span dir="ltr">{merchant.phone}</span>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 rounded-full bg-[var(--codiq-neutral-soft)] px-2.5 py-1 text-[11px] font-semibold text-[#65748B]">
                  <Store className="h-3 w-3" /> متاجر: {merchant.storeCount}
                </span>
                <span className="rounded-full bg-[var(--codiq-accent-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--codiq-accent-hover)]">
                  {merchant.plan?.name ?? "بلا خطة"}
                </span>
                {pending ? (
                  <>
                    <Button
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void decide(merchant, "approve")}
                      className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]"
                    >
                      {busyId === merchant.id ? (
                        <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      تفعيل
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyId !== null}
                      variant="outline"
                      onClick={() => void decide(merchant, "reject")}
                      className="rounded-xl border-[#E3B7BD] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"
                    >
                      إيقاف
                    </Button>
                  </>
                ) : merchant.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`merchant-suspend-${merchant.id}`}
                    disabled={busyId !== null}
                    onClick={() => {
                      setSuspendingId(suspendingId === merchant.id ? null : merchant.id);
                      setSuspendReason("");
                    }}
                    className="rounded-xl border-[var(--codiq-danger-border)] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"
                  >
                    <ShieldOff className="ml-1 h-3.5 w-3.5" /> إيقاف التاجر
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    data-testid={`merchant-resume-${merchant.id}`}
                    disabled={busyId !== null}
                    onClick={() => void setSuspension(merchant, false)}
                    className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[var(--codiq-success-hover)]"
                  >
                    {busyId === merchant.id ? (
                      <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="ml-1 h-3.5 w-3.5" />
                    )}{" "}
                    رفع الإيقاف
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate("/platform/dashboard/subscriptions")}
                  className="rounded-xl border-[#C9D9EE] text-[var(--codiq-accent)]"
                >
                  <CreditCard className="ml-1 h-3.5 w-3.5" /> إدارة الاشتراك
                </Button>
              </div>
              {suspendingId === merchant.id ? (
                <div className="flex w-full flex-wrap items-end gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] p-3">
                  <label className="flex-1 space-y-1 text-xs font-bold text-[var(--codiq-text-secondary)]">
                    سبب الإيقاف{" "}
                    <span className="font-semibold text-[var(--codiq-text-muted)]">
                      (يُقرأ لاحقاً في سجلّ التدقيق وعند رفع الإيقاف)
                    </span>
                    <input
                      autoFocus
                      value={suspendReason}
                      onChange={(event) => setSuspendReason(event.target.value)}
                      maxLength={300}
                      placeholder="مثال: طلبات لا تصل الزبائن — بلاغان"
                      className="h-9 w-full rounded-lg border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-2 text-xs outline-none focus:border-[var(--codiq-accent)]"
                    />
                  </label>
                  <Button
                    size="sm"
                    data-testid={`merchant-suspend-confirm-${merchant.id}`}
                    disabled={busyId !== null || suspendReason.trim().length < 3}
                    onClick={() => void setSuspension(merchant, true)}
                    className="rounded-xl bg-[var(--codiq-danger)] text-white hover:bg-[var(--codiq-danger-hover)]"
                  >
                    {busyId === merchant.id ? (
                      <LoaderCircle className="ml-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    تأكيد الإيقاف
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId !== null}
                    onClick={() => setSuspendingId(null)}
                    className="rounded-xl text-[var(--codiq-text-secondary)]"
                  >
                    إلغاء
                  </Button>
                  <p className="w-full text-[11px] leading-5 text-[var(--codiq-text-secondary)]">
                    الإيقاف يُغلق متاجره أمام الزبائن وينهي جلساته وجلسات موظفيه فوراً. طلباته
                    وقيوده المالية ورصيده لا تُمسّ — الإيقاف بوّابةٌ على التصرّف لا على السجلّ.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <LoadMoreButton
        cursor={nextCursor}
        busy={loadingMore}
        onLoad={(cursor) => void load(cursor)}
        testId="merchants-more"
      />
      <p className="text-xs leading-6 text-[#8994A8]">
        الحذف النهائي غير متاح بتصميم النظام المالي (سجل append-only). طلبٌ معلّق يُحسم بالتفعيل أو
        الرفض، وتاجرٌ مُفعّل يُوقَف بسببٍ مكتوب ويُرفع عنه الإيقاف من الزرّ نفسه (ق-225) — وكل قرارٍ
        منها سطرٌ في سجلّ تدقيق المنصّة.
      </p>
    </div>
  );
}
