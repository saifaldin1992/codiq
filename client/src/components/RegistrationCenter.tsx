/**
 * codiq phase 17 — owner registration center: the auto/manual approval policy
 * toggle and the pending merchant application queue (ADR-006).
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, RefreshCw, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type RegistrationRequest = { id: string; email: string; ownerName: string | null; phone: string | null; businessName: string; createdAt: string; stores: { slug: string; name: string }[] };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function RegistrationCenter() {
  const [mode, setMode] = useState<"auto" | "manual" | null>(null);
  const [requests, setRequests] = useState<RegistrationRequest[] | null>(null);
  // 20-2: self-registration is open to the internet, so the size of this queue
  // is decided by whoever is signing up. Keyset-paged, oldest first.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const [modeResult, requestsResult] = await Promise.all([
        api<{ mode: "auto" | "manual" }>("/api/platform/settings/registration"),
        api<{ requests: RegistrationRequest[]; nextCursor: string | null }>(`/api/platform/merchants/registration-requests?${query.toString()}`),
      ]);
      setMode(modeResult.mode);
      setRequests((current) => (cursor ? [...(current ?? []), ...requestsResult.requests] : requestsResult.requests));
      setNextCursor(requestsResult.nextCursor);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function switchMode(next: "auto" | "manual") {
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/platform/settings/registration", { method: "PUT", body: JSON.stringify({ mode: next }) });
      setMode(next);
      setNotice(next === "manual" ? "أصبح التسجيل الذاتي بموافقة يدوية — الطلبات الجديدة ستظهر هنا." : "أصبح التسجيل الذاتي تلقائياً — المتاجر الجديدة تُفعل فوراً.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(request: RegistrationRequest, action: "approve" | "reject") {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/platform/merchants/${request.id}/approval`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice(action === "approve" ? `تمت الموافقة على «${request.businessName}» وتفعيل متجره.` : `رُفض طلب «${request.businessName}».`);
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[860px] space-y-5">
      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]"><UserCheck className="h-4 w-4" /> سياسة التسجيل الذاتي للتجار</p>
        {mode === null && !failure ? <p className="text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…</p> : null}
        {mode !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" data-testid="registration-mode-auto" disabled={busy} onClick={() => void switchMode("auto")} className={`rounded-2xl px-5 py-3 text-sm font-bold transition ${mode === "auto" ? "bg-[var(--codiq-accent)] text-white" : "bg-[var(--codiq-canvas)] text-[var(--codiq-text-secondary)]"}`}>تفعيل تلقائي</button>
            <button type="button" data-testid="registration-mode-manual" disabled={busy} onClick={() => void switchMode("manual")} className={`rounded-2xl px-5 py-3 text-sm font-bold transition ${mode === "manual" ? "bg-[var(--codiq-accent)] text-white" : "bg-[var(--codiq-canvas)] text-[var(--codiq-text-secondary)]"}`}>بموافقتي أولاً</button>
            <p className="text-xs leading-6 text-[var(--codiq-text-muted)]">{mode === "auto" ? "كل تسجيل جديد يُفعّل متجره فوراً على الخطة المجانية." : "التسجيلات الجديدة تنتظر موافقتك؛ لا دخول ولا متجر فعال قبلها."}</p>
          </div>
        ) : null}
      </div>

      <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs font-bold tracking-wide text-[var(--codiq-accent)]">طلبات التسجيل المعلقة</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="rounded-xl text-[var(--codiq-text-secondary)]"><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
        </div>
        {failure ? <p className="mb-3 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
        {notice ? <p data-testid="registration-notice" className="mb-3 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]">{notice}</p> : null}
        {requests?.length === 0 ? <p className="text-sm text-[var(--codiq-text-muted)]">لا توجد طلبات معلقة حالياً.</p> : null}
        <div className="space-y-2">
          {requests?.map((request) => (
            <div key={request.id} data-testid={`registration-request-${request.email}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[#263650]">{request.businessName}</p>
                <p className="truncate text-xs text-[var(--codiq-text-muted)]"><span dir="ltr">{request.email}</span> · متجر: <span dir="ltr">{request.stores[0]?.slug ?? "—"}</span></p>{/* ق-167: مَن يقف خلف الطلب، ورقمٌ يُتّصل به. الشرط لأن العمودين اختياريان في المخطط، ولأن صفوفاً سابقة كُتبت قبل أن يُطلبا. */}{request.ownerName || request.phone ? <p data-testid={`registration-contact-${request.email}`} className="mt-0.5 truncate text-xs text-[var(--codiq-text-secondary)]">{request.ownerName ?? "—"}{request.phone ? <> · <span dir="ltr">{request.phone}</span></> : null}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                <Button data-testid="registration-approve" size="sm" disabled={busy} onClick={() => void decide(request, "approve")} className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]">موافقة</Button>
                <Button data-testid="registration-reject" size="sm" disabled={busy} variant="outline" onClick={() => void decide(request, "reject")} className="rounded-xl border-[#E3B7BD] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]">رفض</Button>
              </div>
            </div>
          ))}
          <LoadMoreButton cursor={nextCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="registration-requests-more" />
        </div>
      </div>
    </div>
  );
}
