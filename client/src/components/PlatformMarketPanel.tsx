/**
 * «السوق» in the owner's dashboard: the stores asking to join (oldest first),
 * and the listed, rejected and removed ones. Each row can be decided, and a
 * listed store can be marked a brand, boosted, or named «سفير» for a while.
 * Verification («موثّق») stays on the stores screen, where it always was.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, Store } from "lucide-react";
import { Button } from "@/components/ui/button";

type Status = "pending" | "listed" | "rejected" | "delisted";
type Row = {
  id: string;
  slug: string;
  name: string;
  businessType: string | null;
  logoUrl: string | null;
  location: string | null;
  merchantName: string | null;
  businessName: string;
  activeProducts: number;
  status: Status;
  statusAt: string | null;
  note: string | null;
  verified: boolean;
  isBrand: boolean;
  boostedUntil: string | null;
  ambassadorUntil: string | null;
  score: number | null;
  tier: string | null;
  completedOrders: number;
};

const TABS: { status: Status; label: string }[] = [
  { status: "pending", label: "بانتظار القرار" },
  { status: "listed", label: "معروضة" },
  { status: "rejected", label: "مرفوضة" },
  { status: "delisted", label: "أُزيلت" },
];

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

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const active = (until: string | null) => until !== null && new Date(until) > new Date();
const dateOf = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("ar-IQ") : "—";

export function PlatformMarketPanel() {
  const [status, setStatus] = useState<Status>("pending");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (which: Status, after?: string | null) => {
    setFailure(null);
    const page = await call<{ stores: Row[]; nextCursor: string | null }>(
      `/api/platform/market/stores?status=${which}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`
    );
    setRows((current) => (after ? [...(current ?? []), ...page.stores] : page.stores));
    setCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    setRows(null);
    load(status).catch((error: Error) => setFailure(error.message));
  }, [status, load]);

  const act = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setFailure(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await load(status);
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const decide = (row: Row, decision: "list" | "reject" | "delist") => {
    let note: string | undefined;
    if (decision !== "list") {
      note = window
        .prompt(decision === "reject" ? "سبب الرفض (يقرؤه التاجر):" : "سبب الإزالة (يقرؤه التاجر):")
        ?.trim();
      if (!note) return;
    }
    void act(
      `${row.id}:${decision}`,
      () =>
        call(`/api/platform/market/stores/${row.id}/decision`, {
          method: "PUT",
          body: JSON.stringify({ decision, note }),
        }),
      decision === "list"
        ? `«${row.name}» معروض الآن في السوق.`
        : decision === "reject"
          ? `رُفض طلب «${row.name}».`
          : `أُزيل «${row.name}» من السوق.`
    );
  };

  const flags = (row: Row, body: Record<string, unknown>, done: string) =>
    void act(
      `${row.id}:flags`,
      () =>
        call(`/api/platform/market/stores/${row.id}/flags`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      done
    );

  return (
    <div className="max-w-[1030px] space-y-4" data-testid="platform-market">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              onClick={() => setStatus(tab.status)}
              aria-pressed={status === tab.status}
              data-testid={`platform-market-tab-${tab.status}`}
              className={`rounded-full px-3 py-1.5 text-sm font-bold ${status === tab.status ? "bg-[var(--codiq-accent)] text-[var(--codiq-surface)]" : "bg-[var(--codiq-surface-sunken)] text-[var(--codiq-text-secondary)]"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void act(
              "recompute",
              () =>
                call<{ stores: number }>("/api/platform/market/metrics/recompute", {
                  method: "POST",
                }),
              "أُعيد حساب سمعة المتاجر."
            )
          }
          data-testid="platform-market-recompute"
        >
          {busy === "recompute" ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}{" "}
          إعادة حساب السمعة الآن
        </Button>
      </div>
      {failure ? (
        <p className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4" /> {failure}
        </p>
      ) : null}
      {notice ? (
        <p
          className="flex items-center gap-2 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-success)]"
          data-testid="platform-market-notice"
        >
          <CircleCheck className="h-4 w-4" /> {notice}
        </p>
      ) : null}
      {!rows ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {rows?.length === 0 ? (
        <p className="rounded-2xl bg-[var(--codiq-surface-sunken)] px-4 py-8 text-center text-sm text-[var(--codiq-text-muted)]">
          لا توجد متاجر هنا.
        </p>
      ) : null}
      <ul className="space-y-3">
        {rows?.map((row) => (
          <li
            key={row.id}
            className="space-y-3 rounded-[22px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4 shadow-sm"
            data-testid={`platform-market-row-${row.slug}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {row.logoUrl ? (
                  <img src={row.logoUrl} alt="" className="h-12 w-12 rounded-xl object-cover" />
                ) : (
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]">
                    <Store className="h-5 w-5" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--codiq-text)]">
                    {row.name}{" "}
                    {row.verified ? (
                      <span className="text-xs text-[var(--codiq-accent)]">· موثّق</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-[var(--codiq-text-muted)]">
                    {[
                      row.businessType,
                      row.location,
                      `${row.activeProducts} منتج`,
                      row.merchantName ?? row.businessName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-[11px] text-[var(--codiq-text-muted)]">
                    منذ {dateOf(row.statusAt)} · النتيجة{" "}
                    {row.score !== null ? Math.round(row.score) : "—"} · {row.completedOrders} طلب
                    مكتمل
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/market/s/${encodeURIComponent(row.slug)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="self-center text-xs font-bold text-[var(--codiq-accent)]"
                >
                  {row.status === "listed" ? "صفحته في السوق" : ""}
                </a>
                <a
                  href={`/store/${encodeURIComponent(row.slug)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="self-center text-xs font-bold text-[var(--codiq-accent)]"
                >
                  المتجر
                </a>
                {row.status !== "listed" ? (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => decide(row, "list")}
                    data-testid={`platform-market-list-${row.slug}`}
                  >
                    اعرضه في السوق
                  </Button>
                ) : null}
                {row.status === "pending" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => decide(row, "reject")}
                    data-testid={`platform-market-reject-${row.slug}`}
                  >
                    ارفض
                  </Button>
                ) : null}
                {row.status === "listed" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => decide(row, "delist")}
                    data-testid={`platform-market-delist-${row.slug}`}
                  >
                    أزِله من السوق
                  </Button>
                ) : null}
              </div>
            </div>
            {row.note ? (
              <p className="rounded-xl bg-[var(--codiq-surface-sunken)] px-3 py-2 text-xs text-[var(--codiq-text-secondary)]">
                الملاحظة: {row.note}
              </p>
            ) : null}
            {row.status === "listed" ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--codiq-border)] pt-3 text-xs">
                <FlagButton
                  on={row.isBrand}
                  onClick={() =>
                    flags(
                      row,
                      { isBrand: !row.isBrand },
                      row.isBrand ? "أُزيلت شارة العلامة التجاريّة." : "صار علامة تجاريّة."
                    )
                  }
                  testId={`platform-market-brand-${row.slug}`}
                >
                  علامة تجاريّة
                </FlagButton>
                <FlagButton
                  on={active(row.boostedUntil)}
                  onClick={() =>
                    flags(
                      row,
                      { boostedUntil: active(row.boostedUntil) ? null : inDays(7) },
                      active(row.boostedUntil) ? "أُوقف الترويج." : "مُروَّج لسبعة أيام."
                    )
                  }
                  testId={`platform-market-boost-${row.slug}`}
                >
                  {active(row.boostedUntil)
                    ? `مُروَّج حتى ${dateOf(row.boostedUntil)}`
                    : "روّجه ٧ أيام"}
                </FlagButton>
                <FlagButton
                  on={active(row.ambassadorUntil)}
                  onClick={() =>
                    flags(
                      row,
                      { ambassadorUntil: active(row.ambassadorUntil) ? null : inDays(30) },
                      active(row.ambassadorUntil)
                        ? "أُزيل من السفراء."
                        : "سفير السوق لثلاثين يوماً."
                    )
                  }
                  testId={`platform-market-ambassador-${row.slug}`}
                >
                  {active(row.ambassadorUntil)
                    ? `سفير حتى ${dateOf(row.ambassadorUntil)}`
                    : "اجعله سفيراً ٣٠ يوماً"}
                </FlagButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button
          variant="outline"
          className="w-full"
          onClick={() =>
            void load(status, cursor).catch((error: Error) => setFailure(error.message))
          }
        >
          عرض المزيد
        </Button>
      ) : null}
    </div>
  );
}

function FlagButton({
  on,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      className={`rounded-full border px-3 py-1.5 font-bold ${on ? "border-[var(--codiq-accent)] bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent)]" : "border-[var(--codiq-border)] text-[var(--codiq-text-secondary)]"}`}
    >
      {children}
    </button>
  );
}
