/**
 * ق-182 — who complained about which store's mail, and what to configure so
 * that this list can fill at all.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";

type Complaint = {
  id: string;
  email: string;
  note: string | null;
  reportedAt: string;
  providerEventId: string | null;
  store: { slug: string; name: string };
};

const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "تعذر تحميل الشكاوى."
    );
  return body as T;
}

export function EmailComplaintsSection() {
  const [rows, setRows] = useState<Complaint[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadPage = useCallback(async (after: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<{ complaints: Complaint[]; nextCursor: string | null }>(
        `/api/platform/messaging/complaints?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ""}`
      );
      setRows((previous) =>
        after ? (previous ?? []).concat(result.complaints) : result.complaints
      );
      setCursor(result.nextCursor);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر تحميل الشكاوى.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  return (
    <section
      className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)]"
      data-testid="email-complaints"
    >
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <MailWarning className="h-4 w-4" /> الشكاوى على البريد
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">
        من ضغط «هذا بريد مزعج»، وعلى أيّ متجر
      </h2>
      <p className="mb-4 text-sm leading-7 text-[var(--codiq-text-muted)]">
        يصلنا من Resend فور وقوعه، ويُوقف عنوان الشاكي عن ذلك المتجر تلقائياً. ليصل شيء هنا: في لوحة
        Resend ← Webhooks ← أضف
        <code
          className="mx-1 rounded bg-[var(--codiq-neutral-soft)] px-1.5 py-0.5 text-[12px]"
          dir="ltr"
        >
          https://codiqos.com/api/webhooks/resend
        </code>
        بحدث{" "}
        <code
          className="mx-1 rounded bg-[var(--codiq-neutral-soft)] px-1.5 py-0.5 text-[12px]"
          dir="ltr"
        >
          email.complained
        </code>
        ، وضع سرّه في Railway باسم{" "}
        <code
          className="mx-1 rounded bg-[var(--codiq-neutral-soft)] px-1.5 py-0.5 text-[12px]"
          dir="ltr"
        >
          CODIQ_RESEND_WEBHOOK_SECRET
        </code>
        .
      </p>
      {failure ? (
        <p className="mb-4 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      ) : null}
      {rows === null && !failure ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : null}
      {rows?.length === 0 ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          لا شكاوى — أو لم يُربط الـwebhook بعد.
        </p>
      ) : null}
      <ul className="space-y-3" data-testid="email-complaints-list">
        {rows?.map((row) => (
          <li key={row.id} className="rounded-2xl border border-[var(--codiq-border)] px-4 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
              <span dir="ltr">{row.email}</span>
              <span className="shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--codiq-text-secondary)]">
                {row.store.name}
              </span>
            </p>
            <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
              {row.note ? `«${row.note}» · ` : ""}
              {dateTime.format(new Date(row.reportedAt))}
            </p>
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          className="mt-5 rounded-xl"
          onClick={() => void loadPage(cursor)}
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تحميل المزيد"}
        </Button>
      ) : null}
    </section>
  );
}
