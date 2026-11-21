/**
 * codiq menus pass A — «نظرة عامة» stat cards for the owner and merchant
 * dashboard homes. Every card fetches independently and renders its own
 * loading/error/empty state.
 *
 * Phase 20B-2: the merchant order cards now read the analytics aggregates
 * (summary / status-funnel) and show EXACT database counts — the documented
 * «100+» page-derived approximation is gone for them. Only the low-stock card
 * still derives from the paginated catalog list (no aggregate exists for it),
 * so it alone keeps the overflow marker.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardList,
  LoaderCircle,
  Store,
  UserCheck,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type CountResult = { count: number; overflow: boolean };
type CardState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; value: CountResult };

const arabicNumber = new Intl.NumberFormat("ar-IQ");

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

function utcTodayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function utcMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function countOrders(basePath: string, params: Record<string, string>): Promise<CountResult> {
  const query = new URLSearchParams({ limit: "100", ...params });
  const page = await api<{ orders: unknown[]; nextCursor: string | null }>(
    `${basePath}?${query.toString()}`
  );
  return { count: page.orders.length, overflow: page.nextCursor !== null };
}

function StatCard({
  label,
  hint,
  icon: Icon,
  fetcher,
}: {
  label: string;
  hint: string;
  icon: LucideIcon;
  fetcher: () => Promise<CountResult>;
}) {
  const [state, setState] = useState<CardState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetcher()
      .then((value) => {
        if (!cancelled) setState({ kind: "ready", value });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
    // The fetcher identity is stable per mount; cards refresh on remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-[#60708A]">{label}</p>
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#F0F5FF] text-[var(--codiq-accent)]">
          <Icon className="h-4.5 w-4.5" strokeWidth={1.9} />
        </div>
      </div>
      <div className="mt-3">
        {state.kind === "loading" ? (
          <LoaderCircle className="h-6 w-6 animate-spin text-[#9AA8BB]" />
        ) : null}
        {state.kind === "error" ? (
          <p className="flex items-center gap-1.5 text-sm font-semibold text-[#B44B40]">
            <AlertTriangle className="h-4 w-4" /> تعذر التحميل
          </p>
        ) : null}
        {state.kind === "ready" ? (
          <p className="text-2xl font-bold tracking-[-0.02em] text-[#15233E]">
            {arabicNumber.format(state.value.count)}
            {state.value.overflow ? (
              <span className="text-base font-bold text-[#8994A8]">+</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-[#8994A8]">{hint}</p>
    </div>
  );
}

type FunnelResponse = { funnel: { status: string; count: number }[] };

function funnelCount(funnel: FunnelResponse["funnel"], ...statuses: string[]): number {
  return funnel
    .filter((row) => statuses.includes(row.status))
    .reduce((sum, row) => sum + row.count, 0);
}

export function MerchantOverview({ storeSlug }: { storeSlug?: string }) {
  if (!storeSlug) {
    return (
      <div
        className="max-w-[640px] rounded-2xl border border-[#D6E5F7] bg-[var(--codiq-canvas)] px-4 py-3 text-sm leading-6 text-[#35577F]"
        dir="rtl"
      >
        اختر متجراً عبر مبدّل المتاجر لعرض نبض المتجر اليومي.
      </div>
    );
  }
  // Phase 20B-2: exact aggregates from the analytics endpoints (orders.view).
  const analyticsBase = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/marketing/analytics`;
  return (
    <div className="max-w-[1030px] space-y-4" dir="rtl">
      <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <ClipboardList className="h-4 w-4" /> نبض متجرك اليوم — بطاقات مستقلة تتحمل الخطأ كلٌّ على
        حدة
      </p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="طلبات اليوم"
          hint="كل طلبات المتجر منذ بداية اليوم (UTC) — عدّ دقيق."
          icon={ClipboardList}
          fetcher={async () => {
            const result = await api<{ summary: { ordersCount: number } }>(
              `${analyticsBase}/summary?from=${encodeURIComponent(utcTodayStart())}`
            );
            return { count: result.summary.ordersCount, overflow: false };
          }}
        />
        <StatCard
          label="بحاجة لإجراء"
          hint="الطلبات الجديدة + قيد المعالجة — عدّ دقيق."
          icon={AlertTriangle}
          fetcher={async () => {
            const result = await api<FunnelResponse>(`${analyticsBase}/status-funnel`);
            return { count: funnelCount(result.funnel, "new", "processing"), overflow: false };
          }}
        />
        <StatCard
          label="مكتملة هذا الشهر"
          hint="الطلبات المكتملة منذ بداية الشهر (UTC) — عدّ دقيق."
          icon={CheckCircle2}
          fetcher={async () => {
            const result = await api<FunnelResponse>(
              `${analyticsBase}/status-funnel?from=${encodeURIComponent(utcMonthStart())}`
            );
            return { count: funnelCount(result.funnel, "completed"), overflow: false };
          }}
        />
        <StatCard
          label="مخزون منخفض"
          hint="منتجات بلغت حد التنبيه المحدد لها."
          icon={Boxes}
          fetcher={async () => {
            const query = new URLSearchParams({ limit: "100", lowStock: "true" });
            const page = await api<{ products: unknown[]; nextCursor: string | null }>(
              `/api/merchant/stores/${encodeURIComponent(storeSlug)}/catalog/products?${query.toString()}`
            );
            return { count: page.products.length, overflow: page.nextCursor !== null };
          }}
        />
      </div>
      <p className="text-[11px] leading-5 text-[#8994A8]">
        <UsersRound className="ml-1 inline h-3.5 w-3.5" /> أعداد الطلبات دقيقة من تجميعات تحليلات
        20B؛ بطاقة المخزون المنخفض وحدها ما تزال من قائمة الكتالوج (حتى ١٠٠ سجل بالصفحة).
      </p>
    </div>
  );
}
