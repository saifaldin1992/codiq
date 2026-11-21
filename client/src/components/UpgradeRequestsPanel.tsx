/**
 * codiq approved addition (2026-08-26) — the platform-owner upgrade-request
 * queue. Merchants file upgrade/downgrade requests from the pricing CTA or
 * their subscription panel; approval assigns the plan atomically on the server
 * (manual until phase 25A automates billing).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Check, CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type RequestRow = {
  id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  merchant: { id: string; email: string; businessName: string };
  requestedPlan: { code: string; name: string; monthlyPriceIqd: number };
};

const money = new Intl.NumberFormat("ar-IQ");
const dateFormat = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
const STATUS_BADGES: Record<RequestRow["status"], { label: string; className: string }> = {
  pending: { label: "قيد المراجعة", className: "bg-[var(--codiq-warning-soft)] text-[#A76B13]" },
  approved: {
    label: "معتمد",
    className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]",
  },
  rejected: {
    label: "مرفوض",
    className: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]",
  },
};

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

function RequestCard({
  request,
  onDecide,
  busy,
}: {
  request: RequestRow;
  onDecide: (id: string, action: "approve" | "reject") => Promise<void>;
  busy: boolean;
}) {
  const badge = STATUS_BADGES[request.status];
  return (
    <div
      data-testid={`upgrade-request-row-${request.id}`}
      className={`rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-4 py-3 shadow-sm ${request.status === "pending" ? "" : "opacity-70"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-[#263650]">
            {request.merchant.businessName}
          </p>
          <p className="truncate text-xs text-[var(--codiq-text-muted)]" dir="ltr">
            {request.merchant.email}
          </p>
        </div>
        <div className="text-left">
          <p className="text-sm font-bold text-[var(--codiq-accent)]">
            إلى خطة «{request.requestedPlan.name}»
          </p>
          <p className="text-xs text-[#8490A5]">
            {request.requestedPlan.monthlyPriceIqd === 0
              ? "مجانية"
              : `${money.format(request.requestedPlan.monthlyPriceIqd)} د.ع شهرياً`}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      {request.note ? (
        <p className="mt-2 rounded-xl bg-[var(--codiq-canvas)] px-3 py-2 text-xs text-[var(--codiq-text-secondary)]">
          {request.note}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-[#8490A5]">
          أُرسل: {dateFormat.format(new Date(request.createdAt))}
          {request.decidedAt ? ` · حُسم: ${dateFormat.format(new Date(request.decidedAt))}` : ""}
        </p>
        {request.status === "pending" ? (
          <div className="flex items-center gap-2">
            <Button
              data-testid={`upgrade-approve-${request.id}`}
              disabled={busy}
              onClick={() => void onDecide(request.id, "approve")}
              size="sm"
              className="rounded-xl bg-[var(--codiq-success)] text-white hover:bg-[#1F5C41]"
            >
              <Check className="ml-1 h-4 w-4" /> اعتماد
            </Button>
            <Button
              data-testid={`upgrade-reject-${request.id}`}
              disabled={busy}
              onClick={() => void onDecide(request.id, "reject")}
              size="sm"
              variant="outline"
              className="rounded-xl border-[#F3D3D7] text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)]"
            >
              <X className="ml-1 h-4 w-4" /> رفض
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function UpgradeRequestsPanel() {
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  // 20-2: the queue used to load EVERY upgrade request ever made — decided ones
  // are never removed — and re-sort them in the browser. It is newest-first and
  // keyset-paged now, and `pendingCount` comes from the server so «لا توجد
  // طلبات» cannot be said while a pending one waits on page 2.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const result = await api<{
        requests: RequestRow[];
        nextCursor: string | null;
        pendingCount: number;
      }>(`/api/platform/upgrade-requests?${query.toString()}`);
      setRequests((current) =>
        cursor ? [...(current ?? []), ...result.requests] : result.requests
      );
      setNextCursor(result.nextCursor);
      setPendingCount(result.pendingCount);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
      if (!cursor) setRequests(null);
    } finally {
      setLoadingMore(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(requestId: string, action: "approve" | "reject") {
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      await api(`/api/platform/upgrade-requests/${requestId}/${action}`, { method: "POST" });
      setNotice(
        action === "approve"
          ? "اعتُمد الطلب وأُسندت الخطة الجديدة — الحدود نافذة فوراً."
          : "رُفض الطلب، ولم يتغير اشتراك التاجر."
      );
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(false);
    }
  }

  const pending = requests?.filter((request) => request.status === "pending") ?? [];
  const decided = requests?.filter((request) => request.status !== "pending") ?? [];

  return (
    <div className="max-w-[1030px] space-y-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
          <ArrowUpCircle className="h-4 w-4" /> طلبات الترقية — اعتماد يدوي حتى مرحلة الفوترة
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
      {failure ? (
        <p
          data-testid="upgrade-requests-error"
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          data-testid="upgrade-requests-notice"
          className="rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
        >
          {notice}
        </p>
      ) : null}
      {requests === null && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {requests !== null && pendingCount === 0 ? (
        <p data-testid="upgrade-requests-empty" className="text-sm text-[var(--codiq-text-muted)]">
          لا توجد طلبات قيد المراجعة حالياً.
        </p>
      ) : null}
      {requests !== null && pendingCount > pending.length ? (
        <p className="text-xs font-semibold text-[color:var(--codiq-text-muted)]">
          {pendingCount} طلباً قيد المراجعة — بعضها خارج الصفحة المعروضة.
        </p>
      ) : null}
      <div className="space-y-2">
        {pending.map((request) => (
          <RequestCard key={request.id} request={request} onDecide={decide} busy={busy} />
        ))}
      </div>
      {decided.length > 0 ? (
        <>
          <p className="pt-2 text-xs font-bold text-[#8490A5]">طلبات محسومة</p>
          <div className="space-y-2">
            {decided.map((request) => (
              <RequestCard key={request.id} request={request} onDecide={decide} busy={busy} />
            ))}
          </div>
        </>
      ) : null}
      <LoadMoreButton
        cursor={nextCursor}
        busy={loadingMore}
        onLoad={(cursor) => void load(cursor)}
        testId="upgrade-requests-more"
      />
    </div>
  );
}
