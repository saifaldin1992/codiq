/**
 * ق-177 — what was decided about returned goods, and why.
 *
 * RI-1 wrote the «ثلاثي التدقيق» — who inspected, when, and the note — and the
 * only list on the screen filtered on `pending_inspection`, so a decision left
 * every screen the moment it was taken. A write-off reason is money explained;
 * this is where it can be read back, newest first, with the split each row got.
 */
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type InspectedReturn = {
  id: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  restockedQuantity: number;
  writtenOffQuantity: number;
  disposition: "restocked" | "written_off" | "split";
  inspectedAt: string;
  inspectedByKind: string;
  inspectionNote: string | null;
};

const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
const ACTOR: Record<string, string> = { merchant: "التاجر", staff: "موظف المتجر" };
const DISPOSITION: Record<InspectedReturn["disposition"], { label: string; className: string }> = {
  restocked: { label: "أُعيد كله للمخزون", className: "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]" },
  written_off: { label: "شُطب كله", className: "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" },
  split: { label: "قُسّم", className: "bg-[var(--codiq-warning-soft)] text-[var(--codiq-text-secondary)]" },
};

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "تعذر تحميل قرارات الفحص.");
  return body as T;
}

export function ReturnInspectionHistory({ storeSlug }: { storeSlug: string }) {
  const [rows, setRows] = useState<InspectedReturn[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/inventory/returns/inspected`;

  const loadPage = useCallback(async (after: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<{ returns: InspectedReturn[]; nextCursor: string | null }>(`${base}?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      setRows((previous) => (after ? (previous ?? []).concat(result.returns) : result.returns));
      setCursor(result.nextCursor);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر تحميل قرارات الفحص.");
    } finally {
      setBusy(false);
    }
  }, [base]);

  useEffect(() => { void loadPage(null); }, [loadPage]);

  return (
    <section className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6" data-testid="return-inspection-history">
      <h2 className="flex items-center gap-2 font-black text-[var(--codiq-text)]"><ClipboardCheck className="h-5 w-5 text-[var(--codiq-accent)]" />قرارات الفحص السابقة</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">ما قرّرته أنت أو موظفوك في المرتجعات: كم أُعيد، وكم شُطب، ولماذا.</p>

      {failure ? <p role="alert" className="mt-4 flex items-center gap-2 text-sm text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" />{failure}</p> : null}
      {rows === null && !failure ? <p className="mt-4 flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ التحميل…</p> : null}
      {rows?.length === 0 ? <p className="mt-4 text-sm text-[var(--codiq-text-muted)]">لم يُفحص مرتجع بعد.</p> : null}

      {rows?.length ? (
        <ul className="mt-4 divide-y divide-[var(--codiq-border)]" data-testid="return-inspection-history-list">
          {rows.map((row) => {
            const tone = DISPOSITION[row.disposition];
            return (
              <li key={row.id} className="py-3" data-testid="return-inspection-decision">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--codiq-text)]">
                      {row.productName}{row.variantName ? <span className="text-[var(--codiq-text-muted)]"> · {row.variantName}</span> : null}
                      <span className="mr-2 font-mono text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">{row.sku}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--codiq-text-secondary)]">
                      طلب <span dir="ltr">{row.orderNumber}</span> · {row.quantity} قطعة: أُعيد {row.restockedQuantity}، شُطب {row.writtenOffQuantity}
                    </p>
                    {row.inspectionNote ? <p className="mt-1 text-xs leading-5 text-[var(--codiq-text)]" data-testid="return-inspection-note">«{row.inspectionNote}»</p> : null}
                    <p className="mt-0.5 text-[11px] text-[var(--codiq-text-muted)]">{ACTOR[row.inspectedByKind] ?? row.inspectedByKind} · {dateTime.format(new Date(row.inspectedAt))}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${tone.className}`}>{tone.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {cursor ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} className="mt-4 rounded-xl" onClick={() => void loadPage(cursor)}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تحميل المزيد"}
        </Button>
      ) : null}
    </section>
  );
}
