/**
 * RI-1 «فحص المرتجعات» — the merchant's physical decision on returned goods.
 *
 * A returned storefront order parks its units here until someone INSPECTS
 * them: the fine ones go back on the shelf, the damaged are written off.
 * Until this card existed nothing consumed that state, so every refused COD
 * delivery bled phantom inventory.
 *
 * House idioms (the shortfalls-card family): server-computed rows the client
 * never re-derives (no reservation-status branching here — `stockDeducted`
 * is the server's word), rows leave the list by SERVER reload never splice,
 * and the destructive act (any write-off) confirms by SECOND CLICK with a 3s
 * disarm and a 500ms read-guard — the house explicitly rejects
 * window.confirm for destructive acts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, PackageCheck, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type PendingReturn = {
  id: string;
  quantity: number;
  returnedAt: string | null;
  orderNumber: string;
  productName: string | null;
  variantName: string | null;
  sku: string | null;
  stockDeducted: boolean;
  variantTrashed: boolean;
};

const dateFormat = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? `فشل الطلب (${response.status})`;
}

/** Arabic tamyiz for «قطعة» — the counted noun changes with its number. */
function piecesPhrase(count: number) {
  if (count === 1) return "قطعة واحدة";
  if (count === 2) return "قطعتان";
  if (count >= 3 && count <= 10) return `${count} قطع`;
  return `${count} قطعة`;
}

export function ReturnInspectionCard({ storeSlug }: { storeSlug: string }) {
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/inventory/returns`;
  const [rows, setRows] = useState<PendingReturn[] | null>(null);
  // 20-2: the queue is a keyset page now, not «the first 200 and nothing after».
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [damaged, setDamaged] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedAt = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`${base}?${query.toString()}`, { credentials: "same-origin" });
        if (!response.ok) throw new Error(await readError(response));
        const page = await response.json();
        setRows((current) => (cursor ? [...(current ?? []), ...page.returns] : page.returns));
        setNextCursor(page.nextCursor ?? null);
        setFailure(null);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
        if (!cursor) setRows(null);
      } finally {
        setLoadingMore(false);
      }
    },
    [base]
  );
  useEffect(() => {
    void load();
  }, [load]);

  function damagedFor(row: PendingReturn): number {
    const raw = damaged[row.id];
    const parsed = raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return -1;
    if (parsed > row.quantity) return -1;
    return parsed;
  }

  function arm(rowId: string) {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(rowId);
    // A double-click lands its second click ~150ms after the first — the
    // question only counts as asked once it could actually be read.
    armedAt.current = Date.now();
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  }

  // ق-168: سبب الإتلاف. الخادم يقبله منذ RI-1 — المخطط يحدّه بخمسمئة حرف
  // والخدمة تشذّبه وتخزّنه في «ثلاثي التدقيق» — ولم يكن للشاشة حقلٌ يكتبه.
  // إتلاف بضاعةٍ مالٌ ضائع؛ سببه أوّل ما يُسأل عنه بعد شهر.
  const [reason, setReason] = useState<Record<string, string>>({});

  async function resolve(row: PendingReturn) {
    const writeOffQty = damagedFor(row);
    if (writeOffQty < 0) {
      setFailure("كمية التالف يجب أن تكون رقماً صحيحاً بين صفر وكمية المرتجع.");
      return;
    }
    // Any write-off is an irreversible stock loss → second-click confirm.
    if (writeOffQty > 0) {
      if (armed !== row.id) {
        arm(row.id);
        return;
      }
      if (Date.now() - armedAt.current < 500) return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    setBusy(row.id);
    setFailure(null);
    try {
      const response = await fetch(`${base}/${encodeURIComponent(row.id)}/resolve`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // الملاحظة تُرسل حين تكون هناك كميةٌ تالفة فقط: صفٌّ رجع كلّه إلى
        // الرفّ لا سبب له، وحقلٌ اختياريٌّ فارغ يُترك خارج الحمولة كما يفعل
        // الكوبون والملاحظة في الدفع.
        body: JSON.stringify({
          restockQty: row.quantity - writeOffQty,
          writeOffQty,
          ...(writeOffQty > 0 && (reason[row.id] ?? "").trim()
            ? { note: (reason[row.id] ?? "").trim().slice(0, 500) }
            : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      // The row leaves the list by server reload, never by local splice.
      await load();
      setDamaged((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      setReason((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  function resolveLabel(row: PendingReturn) {
    const writeOffQty = damagedFor(row);
    if (writeOffQty === row.quantity) return "اشطبها كلها";
    if (writeOffQty <= 0) return "أرجعها للرف";
    return "أرجِع السليم واشطب التالف";
  }

  return (
    <section className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]">
          <RotateCcw className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-bold text-[var(--codiq-text)]">فحص المرتجعات</h2>
          <p className="mt-0.5 text-xs leading-6 text-[var(--codiq-text-muted)]">
            بضاعة مرتجعة بانتظار قرارك — افحصها، ثم أرجِع السليم للرف أو اشطب التالف؛ لا ترجع للبيع
            قبل ذلك.
          </p>
        </div>
      </div>
      <p className="mt-3 rounded-2xl bg-[var(--codiq-canvas)] px-4 py-2.5 text-[11px] leading-6 text-[var(--codiq-text-muted)]">
        تشمل القائمة مرتجعات المتجر الإلكتروني؛ مرتجعات الكاشير تُعدَّل يدوياً من شاشة المخزون.
      </p>
      {failure ? (
        <p
          data-testid="inventory-returns-error"
          className="mt-3 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          {failure}
        </p>
      ) : null}
      {rows === null && !failure ? (
        <p className="mt-4 text-sm text-[var(--codiq-text-muted)]">
          <LoaderCircle className="ml-1 inline h-4 w-4 animate-spin" /> جارٍ التحميل…
        </p>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <p
          data-testid="inventory-returns-empty"
          className="mt-4 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-3 text-sm text-[var(--codiq-success)]"
        >
          لا مرتجعات بانتظار الفحص.
        </p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul data-testid="inventory-returns-list" className="mt-4 space-y-3">
          {rows.map((row) => {
            const writeOffQty = damagedFor(row);
            const trashedBlocked = row.variantTrashed && writeOffQty !== row.quantity;
            return (
              <li
                key={row.id}
                className="rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-[var(--codiq-text)]">
                      {row.productName ?? "صنف محذوف"}
                      {row.variantName ? ` — ${row.variantName}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
                      {piecesPhrase(row.quantity)} · الطلب {row.orderNumber}
                      {row.sku ? (
                        <>
                          {" "}
                          ·{" "}
                          <span dir="ltr" className="inline-block font-mono">
                            {row.sku}
                          </span>
                        </>
                      ) : null}
                      {row.returnedAt
                        ? ` · أُرجع ${dateFormat.format(new Date(row.returnedAt))}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold ${row.stockDeducted ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
                  >
                    {row.stockDeducted ? "خرجت من المخزون عند الاكتمال" : "لم تُخصم من المخزون"}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                      التالف منها
                    </span>
                    <input
                      data-testid={`inventory-return-writeoff-input-${row.id}`}
                      type="number"
                      min={0}
                      max={row.quantity}
                      value={damaged[row.id] ?? "0"}
                      onChange={(event) => {
                        setDamaged((current) => ({ ...current, [row.id]: event.target.value }));
                        setArmed(null);
                      }}
                      className="w-24 rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
                    />
                  </label>
                  {writeOffQty > 0 ? (
                    <label className="block min-w-[200px] flex-1">
                      <span className="mb-1 block text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                        سبب الإتلاف{" "}
                        <span className="font-medium text-[var(--codiq-text-muted)]">
                          (اختياري)
                        </span>
                      </span>
                      <input
                        data-testid={`inventory-return-note-input-${row.id}`}
                        type="text"
                        maxLength={500}
                        placeholder="مكسور · منتهي الصلاحية · مفتوح"
                        value={reason[row.id] ?? ""}
                        onChange={(event) => {
                          setReason((current) => ({ ...current, [row.id]: event.target.value }));
                          setArmed(null);
                        }}
                        className="w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
                      />
                    </label>
                  ) : null}
                  <Button
                    data-testid={`inventory-return-resolve-${row.id}`}
                    type="button"
                    disabled={busy !== null || trashedBlocked}
                    title={
                      trashedBlocked
                        ? "الصنف في سلة المحذوفات — استرجعه أولاً، أو اشطب الكمية كلها."
                        : undefined
                    }
                    onClick={() => void resolve(row)}
                    className={`rounded-xl ${armed === row.id ? "bg-[var(--codiq-danger)] hover:bg-[var(--codiq-danger)]" : writeOffQty > 0 ? "bg-[var(--codiq-warning)] hover:bg-[var(--codiq-warning)]" : "bg-[var(--codiq-success)] hover:bg-[var(--codiq-success)]"}`}
                  >
                    {busy === row.id ? (
                      <LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
                    ) : (
                      <PackageCheck className="ml-2 h-4 w-4" />
                    )}
                    {armed === row.id ? "متأكد؟ اضغط ثانية" : resolveLabel(row)}
                  </Button>
                  {trashedBlocked ? (
                    <p className="text-[11px] leading-5 text-[var(--codiq-danger)]">
                      الصنف في سلة المحذوفات — استرجعه أولاً ثم أرجِع مخزونه.
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <LoadMoreButton
        cursor={nextCursor}
        busy={loadingMore}
        onLoad={(cursor) => void load(cursor)}
        testId="inventory-returns-more"
      />
    </section>
  );
}
