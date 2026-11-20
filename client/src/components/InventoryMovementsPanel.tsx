/**
 * ق-176 — «حركة المخزون»: what changed, by how much, and why.
 *
 * The movement log had thirteen writers and no reader. The delete-confirm
 * sheet promised merchants it was kept forever, and it was — behind no door.
 * This lists it newest-first, narrows to one product when asked, and shows the
 * snapshot name and SKU the row carries, so a movement stays legible after the
 * product it belonged to is gone.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, CircleAlert, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Movement = {
  id: string;
  productId: string | null;
  variantId: string | null;
  delta: number;
  reason: string;
  productName: string;
  productSku: string;
  variantName: string | null;
  variantSku: string | null;
  createdAt: string;
};

const dateTime = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
const numberFormat = new Intl.NumberFormat("ar-IQ", { signDisplay: "always" });

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "تعذر تحميل حركة المخزون.");
  return body as T;
}

export function InventoryMovementsPanel({ storeSlug, products }: {
  storeSlug: string;
  /** The products already on screen, so the filter is a choice rather than an id to type. */
  products?: { id: string; name: string }[];
}) {
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/inventory/movements`;

  const loadPage = useCallback(async (after: string | null, filter: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (filter) query.set("productId", filter);
      if (after) query.set("cursor", after);
      const result = await api<{ movements: Movement[]; nextCursor: string | null }>(`${base}?${query.toString()}`);
      setRows((previous) => (after ? (previous ?? []).concat(result.movements) : result.movements));
      setCursor(result.nextCursor);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر تحميل حركة المخزون.");
    } finally {
      setBusy(false);
    }
  }, [base]);

  useEffect(() => { void loadPage(null, productId); }, [loadPage, productId]);

  return (
    <section className="rounded-[26px] border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-5 sm:p-6" data-testid="inventory-movements">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-black text-[var(--codiq-text)]"><History className="h-5 w-5 text-[var(--codiq-accent)]" />حركة المخزون</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">كل زيادة ونقصان، وسببه. يبقى السجل حتى بعد حذف المنتج.</p>
        </div>
        {products?.length ? (
          <select
            data-testid="inventory-movements-filter"
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            className="h-10 rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
          >
            <option value="">كل المنتجات</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        ) : null}
      </div>

      {failure ? <p role="alert" className="mt-4 flex items-center gap-2 text-sm text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4 shrink-0" />{failure}</p> : null}
      {rows === null && !failure ? <p className="mt-4 flex items-center gap-2 text-sm text-[var(--codiq-text-muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />جارٍ التحميل…</p> : null}
      {rows?.length === 0 ? <p className="mt-4 text-sm text-[var(--codiq-text-muted)]">لا حركة بعد{productId ? " على هذا المنتج" : ""}.</p> : null}

      {rows?.length ? (
        <ul className="mt-4 divide-y divide-[var(--codiq-border)]" data-testid="inventory-movements-list">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid="inventory-movement">
              <div className="min-w-0">
                <p className="text-sm font-bold text-[var(--codiq-text)]">
                  {row.productName}
                  {row.variantName ? <span className="text-[var(--codiq-text-muted)]"> · {row.variantName}</span> : null}
                  <span className="mr-2 font-mono text-[11px] text-[var(--codiq-text-muted)]" dir="ltr">{row.variantSku ?? row.productSku}</span>
                </p>
                <p className="mt-0.5 text-xs leading-5 text-[var(--codiq-text-secondary)]">{row.reason}</p>
                <p className="mt-0.5 text-[11px] text-[var(--codiq-text-muted)]">{dateTime.format(new Date(row.createdAt))}</p>
              </div>
              <span className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${row.delta < 0 ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`} dir="ltr">
                {row.delta < 0 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                {numberFormat.format(row.delta)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {cursor ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} data-testid="inventory-movements-more" className="mt-4 rounded-xl" onClick={() => void loadPage(cursor, productId)}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "تحميل المزيد"}
        </Button>
      ) : null}
    </section>
  );
}
