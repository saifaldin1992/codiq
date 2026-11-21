/**
 * «البحث بالصورة» — the owner sees how many market products have a visual
 * fingerprint and fingerprints the rest. New pictures are done on upload; this
 * catches a store listed later, a changed main picture, or a new model.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";

type Status = { model: string; indexed: number; pending: number };
type Run = Status & { indexedNow: number; failed: number };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `فشل الطلب (${response.status})`);
  return body as T;
}

export function PlatformMarketImageIndexPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await call<Status>("/api/platform/market/image-index"));
    } catch (error) {
      setFailure((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function run() {
    setRunning(true);
    try {
      const result = await call<Run>("/api/platform/market/image-index/run", {
        method: "POST",
        body: JSON.stringify({ limit: 200 }),
      });
      setStatus(result);
      setNotice(
        `فُهرس ${result.indexedNow.toLocaleString("ar-IQ")} منتجاً${result.failed ? `، وتعذّر ${result.failed.toLocaleString("ar-IQ")} (صورة لا تُقرأ)` : ""}.`
      );
      setFailure(null);
    } catch (error) {
      setFailure((error as Error).message);
      setNotice(null);
    } finally {
      setRunning(false);
    }
  }
  const total = status ? status.indexed + status.pending : 0;
  return (
    <div className="max-w-[760px] space-y-4" data-testid="platform-market-image-index">
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="image-index-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      <section className="space-y-3 rounded-[24px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-base font-black text-[var(--codiq-text)]">
          <ScanSearch className="h-5 w-5 text-[var(--codiq-accent)]" /> فهرس البحث بالصورة
        </h2>
        <p className="text-xs text-[var(--codiq-text-secondary)]">
          لكلّ منتج معروض في السوق «بصمة» لصورته الرئيسيّة (الألوان والنقشة والشكل) يقارنها البحث
          بصورة المتسوّق. تُحسب عند رفع الصورة؛ هنا ما فاتها.
        </p>
        {!status ? (
          <LoaderCircle className="h-5 w-5 animate-spin" />
        ) : (
          <dl className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] p-3">
              <dt className="text-[11px] text-[var(--codiq-text-muted)]">مفهرسة</dt>
              <dd
                className="text-lg font-black text-[var(--codiq-text)]"
                data-testid="image-index-indexed"
              >
                {status.indexed.toLocaleString("ar-IQ")}
              </dd>
            </div>
            <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] p-3">
              <dt className="text-[11px] text-[var(--codiq-text-muted)]">بانتظار الفهرسة</dt>
              <dd
                className="text-lg font-black text-[var(--codiq-text)]"
                data-testid="image-index-pending"
              >
                {status.pending.toLocaleString("ar-IQ")}
              </dd>
            </div>
            <div className="rounded-2xl bg-[var(--codiq-surface-sunken)] p-3">
              <dt className="text-[11px] text-[var(--codiq-text-muted)]">التغطية</dt>
              <dd className="text-lg font-black text-[var(--codiq-text)]">
                {total ? Math.round((status.indexed / total) * 100).toLocaleString("ar-IQ") : "—"}٪
              </dd>
            </div>
          </dl>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => void run()}
            disabled={running || !status?.pending}
            data-testid="image-index-run"
          >
            {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} فهرسة ٢٠٠ منتج
          </Button>
          {status ? (
            <span className="text-[11px] text-[var(--codiq-text-muted)]">
              النموذج: {status.model}
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
