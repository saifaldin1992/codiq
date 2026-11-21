/**
 * الكاشير (ق-132) — pairing and reconciliation, the management half of the till.
 *
 * TWO CARDS, ONE SUBJECT: which devices may write sales into this store, and
 * what those sales did to the stock. They live in one panel because the second
 * card is the consequence of the first — a till that oversells the shelf writes
 * a shortfall, and the person who pairs tills is the person who reconciles them.
 *
 * REVOKED DEVICES STAY IN THE LIST, dimmed. Every past receipt names its
 * device by the four-letter code, so «هذا الجهاز أُلغي يوم كذا» must remain a
 * checkable fact — history, not garbage. The server never deletes them either.
 *
 * REVOKE CONFIRMS ON A SECOND CLICK, not with confirm(). A browser dialog
 * steals focus, reads in the browser's language, and trains people to click
 * through it. The button itself becomes the question («متأكد؟ اضغط ثانية») and
 * forgets the question after three seconds — the cost of a stray click is
 * three seconds of a red button, and the cost of a real revoke is two clicks
 * on the same spot.
 *
 * PERMISSIONS ARE THE SERVER'S, asymmetric on purpose: listing devices needs
 * only `pos.sell`, pairing/revoking need `settings.manage`, the shortfall
 * queue needs `inventory.update`. This panel computes nothing locally — a 403
 * arrives with an Arabic message and is shown where the refused act happened.
 *
 * THE THIRD CARD IS THE OWNER'S: prices the till charged that differ from the
 * catalog, and ticket discounts (`settings.manage`). A cashier whose session
 * cannot read it does not see the card at all — it is not an error he caused,
 * and an empty red box would only tell him there is something he may not see.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, CircleAlert, LoaderCircle, MonitorSmartphone, PackageMinus, ReceiptText, ScanBarcode } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadMoreButton } from "@/components/LoadMoreButton";

type PosDevice = {
  id: string;
  label: string;
  deviceShort: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

type PriceDeviation = {
  id: string;
  kind: "price_below_catalog" | "price_above_catalog" | "ticket_discount";
  quantity: number;
  soldUnitPriceIqd: number;
  catalogUnitPriceIqd: number;
  amountIqd: number;
  createdAt: string;
  productName: string | null;
  variantName: string | null;
  sku: string | null;
  orderNumber: string | null;
  soldAt: string | null;
  deviceLabel: string | null;
  soldBy: { kind: string; name: string | null } | null;
};

type Shortfall = {
  id: string;
  soldQty: number;
  availableQty: number;
  shortfallQty: number;
  createdAt: string;
  variant: { sku: string; name: string; product: { name: string } } | null;
  ticket: { order: { orderNumber: string } | null } | null;
};

const when = new Intl.DateTimeFormat("ar-IQ", { dateStyle: "medium", timeStyle: "short" });
const count = new Intl.NumberFormat("ar-IQ");
const money = (value: number) => `${count.format(value)} د.ع`;

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : when.format(parsed);
}

/**
 * Arabic counts change the noun with the number — one and two have their own
 * forms, three to ten take the plural, eleven upwards returns to the singular.
 * «٣ جهاز» reads to an Arabic speaker the way «3 device» reads to an English
 * one, and this is a platform written in Arabic, not translated into it.
 */
function devicesPhrase(total: number): string {
  if (total === 1) return "جهاز واحد";
  if (total === 2) return "جهازان";
  if (total <= 10) return `${count.format(total)} أجهزة`;
  return `${count.format(total)} جهازاً`;
}

function piecesPhrase(total: number): string {
  if (total === 1) return "قطعة واحدة";
  if (total === 2) return "قطعتان";
  if (total <= 10) return `${count.format(total)} قطع`;
  return `${count.format(total)} قطعة`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? `فشل الطلب (${response.status})`;
}

export function PosDevicesPanel({ storeSlug }: { storeSlug?: string }) {
  if (!storeSlug) {
    // The same guard StoreTeamManager renders: this panel must never guess a
    // store, and an unscoped URL is a bug to surface, not to work around.
    return (
      <div className="max-w-[760px] rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 text-sm font-semibold text-[var(--codiq-danger)] shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        افتح لوحة التاجر عبر مسار متجر محدد (store slug) قبل إدارة أجهزة الكاشير.
      </div>
    );
  }

  return (
    <div className="max-w-[900px] space-y-5">
      <DevicesCard storeSlug={storeSlug} />
      <ShortfallsCard storeSlug={storeSlug} />
      <PriceDeviationsCard storeSlug={storeSlug} />
    </div>
  );
}

function DevicesCard({ storeSlug }: { storeSlug: string }) {
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/pos`;
  const [devices, setDevices] = useState<PosDevice[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // "pair" while the pair form is submitting, a device id while that device is
  // being revoked — so only the acting control disables, never the whole card.
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [paired, setPaired] = useState<{ label: string; deviceShort: string } | null>(null);
  // Confirm-on-second-click: `armed` names the one device whose revoke button
  // is currently the question. The timer forgets the question after 3s.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedAt = useRef(0);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${base}/devices`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setDevices((body.devices ?? []) as PosDevice[]);
      setFailure(null);
    } catch (error) {
      setDevices(null);
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("pair");
    setFailure(null);
    setPaired(null);
    try {
      const response = await fetch(`${base}/devices`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setPaired({ label: body.device.label, deviceShort: body.device.deviceShort });
      setLabel("");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  function armRevoke(deviceId: string) {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(deviceId);
    // A double-click lands its second click ~150ms after the first — before a
    // person can possibly have read «متأكد؟». The question only counts as
    // asked once it has been on screen long enough to read.
    armedAt.current = Date.now();
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  }

  async function revoke(deviceId: string) {
    if (Date.now() - armedAt.current < 500) return;
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    setBusy(deviceId);
    setFailure(null);
    try {
      const response = await fetch(`${base}/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  const live = (devices ?? []).filter((device) => !device.revokedAt).length;

  return (
    <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <MonitorSmartphone className="h-4 w-4" /> الكاشير
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">أجهزة الكاشير</h2>
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        اربط كل جهاز باسم يعرفه موظفوك. لكل جهاز رمز من أربعة أحرف يظهر على كل فاتورة تصدر منه، فتعرف دائماً أي كاشير باع ماذا.
      </p>

      {failure && (
        <p
          data-testid="pos-devices-error"
          className="mb-5 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      )}

      {paired && (
        <div data-testid="pos-paired-notice" className="mb-5 rounded-2xl bg-[var(--codiq-success-soft)] px-4 py-4">
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-success)]">
            <BadgeCheck className="h-4 w-4 shrink-0" />
            رُبط «{paired.label}» — رمزه
            <span dir="ltr" className="rounded-md bg-[var(--codiq-surface)] px-2 py-0.5 font-mono text-sm font-bold tracking-widest text-[var(--codiq-success)]">
              {paired.deviceShort}
            </span>
          </p>
          <p className="mt-1.5 text-xs leading-6 text-[var(--codiq-success)]">
            هذا الرمز يظهر على كل فاتورة تصدر من هذا الكاشير — إن رأيته على وصل، فهذا الجهاز مصدره.
          </p>
        </div>
      )}

      <form onSubmit={pair} className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end" noValidate>
        <label className="block flex-1 space-y-1.5 text-sm font-semibold text-[var(--codiq-text-secondary)]">
          <span>اسم الجهاز</span>
          <Input
            data-testid="pos-device-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="مثل: كاشير ١"
            maxLength={60}
            required
          />
        </label>
        <Button
          type="submit"
          disabled={busy === "pair" || label.trim().length < 2}
          data-testid="pos-pair-submit"
          className="rounded-xl font-bold sm:shrink-0"
        >
          {busy === "pair" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "ربط جهاز"}
        </Button>
      </form>

      {devices === null ? (
        !failure && <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">لا أجهزة بعد — اربط أول كاشير من النموذج أعلاه.</p>
      ) : (
        <>
          <p className="mb-3 text-xs font-semibold text-[var(--codiq-text-secondary)]">
            {live === 0 ? "لا أجهزة مربوطة الآن." : `المربوط الآن: ${devicesPhrase(live)}.`}
          </p>
          <ul className="space-y-3" data-testid="pos-device-list">
            {devices.map((device) => (
              <li
                key={device.id}
                data-testid={`pos-device-${device.deviceShort}`}
                className={`rounded-2xl border border-[var(--codiq-border)] px-4 py-3 ${device.revokedAt ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
                      <span className="truncate">{device.label}</span>
                      <span
                        dir="ltr"
                        className="shrink-0 rounded-md bg-[var(--codiq-surface-sunken)] px-2 py-0.5 font-mono text-xs font-bold tracking-widest text-[var(--codiq-text-secondary)]"
                      >
                        {device.deviceShort}
                      </span>
                      {device.revokedAt && (
                        <span className="shrink-0 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                          مُلغى
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-[var(--codiq-text-muted)]">
                      {device.lastSeenAt ? `آخر استعمال: ${formatWhen(device.lastSeenAt)}` : "لم يُستعمل بعد"}
                      {" · "}رُبط: {formatWhen(device.createdAt)}
                      {device.revokedAt ? ` · أُلغي: ${formatWhen(device.revokedAt)}` : ""}
                    </p>
                  </div>
                  {!device.revokedAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === device.id}
                      data-testid={`pos-revoke-${device.deviceShort}`}
                      className={
                        armed === device.id
                          ? "shrink-0 rounded-xl font-bold text-[var(--codiq-danger)] hover:bg-[var(--codiq-danger-soft)] hover:text-[var(--codiq-danger)]"
                          : "shrink-0 rounded-xl text-[var(--codiq-text-muted)]"
                      }
                      onClick={() => (armed === device.id ? void revoke(device.id) : armRevoke(device.id))}
                    >
                      {busy === device.id ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : armed === device.id ? (
                        "متأكد؟ اضغط ثانية"
                      ) : (
                        "إلغاء الربط"
                      )}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Link
        href={`/merchant/stores/${encodeURIComponent(storeSlug)}/till`}
        data-testid="pos-open-till"
        className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--codiq-accent)] hover:text-[var(--codiq-accent-hover)]"
      >
        <ScanBarcode className="h-4 w-4" /> افتح شاشة الكاشير
      </Link>
    </div>
  );
}

function ShortfallsCard({ storeSlug }: { storeSlug: string }) {
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/pos`;
  const [shortfalls, setShortfalls] = useState<Shortfall[] | null>(null);
  // 20-2: the reconciliation queue was capped at 200 with no page 2, so a till
  // oversold through a bad week buried its own oldest discrepancies.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${base}/shortfalls?${query.toString()}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setShortfalls((current) => (cursor ? [...(current ?? []), ...((body.shortfalls ?? []) as Shortfall[])] : ((body.shortfalls ?? []) as Shortfall[])));
      setNextCursor(body.nextCursor ?? null);
      setFailure(null);
    } catch (error) {
      if (!cursor) setShortfalls(null);
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingMore(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  async function review(shortfallId: string) {
    setBusy(shortfallId);
    setFailure(null);
    try {
      const response = await fetch(`${base}/shortfalls/${encodeURIComponent(shortfallId)}/review`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await readError(response));
      // The row leaves the list because the SERVER says so: reload rather than
      // splice, so the screen always shows what the queue actually holds.
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <PackageMinus className="h-4 w-4" /> الكاشير
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">فروقات المخزون</h2>
      {/* The one sentence that matters — what a shortfall IS and what to do
          about it. The sale itself was accepted on purpose: refusing a sale
          whose goods already left the shop deletes a fact. */}
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        بيعٌ في الكاشير تجاوز المخزون المسجّل — راجع الرفّ وصحّح الكمية من المخزون، ثم علّم السجل كمُراجَع.
      </p>

      {failure && (
        <p
          data-testid="pos-shortfalls-error"
          className="mb-5 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      )}

      {shortfalls === null ? (
        !failure && <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : shortfalls.length === 0 ? (
        <p data-testid="pos-shortfalls-empty" className="text-sm text-[var(--codiq-text-muted)]">
          لا فروقات — المخزون والرفّ متطابقان.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="pos-shortfall-list">
          {shortfalls.map((row) => (
            <li key={row.id} className="rounded-2xl border border-[var(--codiq-border)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
                    <span className="truncate">
                      {row.variant?.product.name ?? "صنف محذوف"}
                      {row.variant?.name ? <span className="font-semibold text-[var(--codiq-text-secondary)]"> — {row.variant.name}</span> : null}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--codiq-danger-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--codiq-danger)]">
                      الفرق: {piecesPhrase(row.shortfallQty)}
                    </span>
                  </p>
                  <p className="mt-1 text-xs font-semibold text-[var(--codiq-text-secondary)]">
                    بِيع: {count.format(row.soldQty)} · كان المتاح: {count.format(row.availableQty)}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--codiq-text-muted)]">
                    {row.variant?.sku ? <span dir="ltr" className="font-mono">{row.variant.sku}</span> : null}
                    <span>
                      الطلب: <span dir="ltr" className="font-mono">{row.ticket?.order?.orderNumber ?? "—"}</span>
                    </span>
                    <span>{formatWhen(row.createdAt)}</span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === row.id}
                  data-testid={`pos-shortfall-review-${row.id}`}
                  className="shrink-0 rounded-xl"
                  onClick={() => void review(row.id)}
                >
                  {busy === row.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "علّمه مُراجَعاً"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <LoadMoreButton cursor={nextCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="pos-shortfalls-more" />
    </div>
  );
}

const DEVIATION_LABEL: Record<PriceDeviation["kind"], string> = {
  price_below_catalog: "أقل من سعر الكتالوج",
  price_above_catalog: "أعلى من سعر الكتالوج",
  ticket_discount: "خصم على الفاتورة",
};

function sellerPhrase(soldBy: PriceDeviation["soldBy"]): string {
  if (!soldBy) return "—";
  if (soldBy.kind === "merchant") return "صاحب المتجر";
  return soldBy.name ?? "موظف";
}

function PriceDeviationsCard({ storeSlug }: { storeSlug: string }) {
  const base = `/api/merchant/stores/${encodeURIComponent(storeSlug)}/pos`;
  const [deviations, setDeviations] = useState<PriceDeviation[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${base}/price-deviations?${query.toString()}`, { credentials: "same-origin" });
      if (response.status === 403) {
        setForbidden(true);
        return;
      }
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setDeviations((current) => (cursor ? [...(current ?? []), ...((body.deviations ?? []) as PriceDeviation[])] : ((body.deviations ?? []) as PriceDeviation[])));
      setNextCursor(body.nextCursor ?? null);
      setFailure(null);
    } catch (error) {
      if (!cursor) setDeviations(null);
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setLoadingMore(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  async function review(deviationId: string) {
    setBusy(deviationId);
    setFailure(null);
    try {
      const response = await fetch(`${base}/price-deviations/${encodeURIComponent(deviationId)}/review`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "خطأ غير متوقع.");
    } finally {
      setBusy(null);
    }
  }

  if (forbidden) return null;

  return (
    <div data-testid="pos-price-deviations" className="rounded-[26px] border border-[var(--codiq-surface)] bg-[var(--codiq-surface)] p-7 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-9">
      <p className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-[var(--codiq-accent)]">
        <ReceiptText className="h-4 w-4" /> الكاشير
      </p>
      <h2 className="mb-1 text-xl font-bold text-[var(--codiq-text)]">أسعار تختلف عن الكتالوج</h2>
      {/* What the row IS, and the honest caveat: an offline sale is priced
          when it was rung, and the catalog may have moved since. */}
      <p className="mb-6 text-sm leading-7 text-[var(--codiq-text-muted)]">
        بيعٌ في الكاشير بسعر غير سعر الكتالوج، أو بخصم على الفاتورة. البيع سُجّل كما هو — راجع السبب مع من باع، ثم علّم السجل كمُراجَع. قد يكون السعر تغيّر بعد بيعةٍ سُجّلت دون اتصال.
      </p>

      {failure && (
        <p
          data-testid="pos-price-deviations-error"
          className="mb-5 flex items-center gap-2 rounded-2xl bg-[var(--codiq-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--codiq-danger)]"
        >
          <CircleAlert className="h-4 w-4 shrink-0" /> {failure}
        </p>
      )}

      {deviations === null ? (
        !failure && <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : deviations.length === 0 ? (
        <p data-testid="pos-price-deviations-empty" className="text-sm text-[var(--codiq-text-muted)]">
          لا شيء للمراجعة — كل ما بِيع في الكاشير بسعر الكتالوج.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="pos-price-deviation-list">
          {deviations.map((row) => (
            <li key={row.id} className="rounded-2xl border border-[var(--codiq-border)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
                    <span className="truncate">
                      {row.kind === "ticket_discount" ? "الفاتورة كاملة" : row.productName ?? "صنف محذوف"}
                      {/* A default variant carries the product's own name; saying it twice says nothing. */}
                      {row.variantName && row.variantName !== row.productName ? <span className="font-semibold text-[var(--codiq-text-secondary)]"> — {row.variantName}</span> : null}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${row.kind === "price_above_catalog" ? "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]" : "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"}`}
                    >
                      {DEVIATION_LABEL[row.kind]}: {money(row.amountIqd)}
                    </span>
                  </p>
                  <p className="mt-1 text-xs font-semibold text-[var(--codiq-text-secondary)]">
                    {row.kind === "ticket_discount"
                      ? `مجموع الأسطر: ${money(row.catalogUnitPriceIqd)} · المدفوع: ${money(row.soldUnitPriceIqd)}`
                      : `بِيع بـ ${money(row.soldUnitPriceIqd)} · سعر الكتالوج ${money(row.catalogUnitPriceIqd)} · الكمية ${count.format(row.quantity)}`}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--codiq-text-muted)]">
                    <span>البائع: {sellerPhrase(row.soldBy)}</span>
                    {row.deviceLabel ? <span>الجهاز: {row.deviceLabel}</span> : null}
                    {row.sku ? <span dir="ltr" className="font-mono">{row.sku}</span> : null}
                    <span>
                      الطلب: <span dir="ltr" className="font-mono">{row.orderNumber ?? "—"}</span>
                    </span>
                    <span>{formatWhen(row.soldAt ?? row.createdAt)}</span>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === row.id}
                  data-testid={`pos-price-deviation-review-${row.id}`}
                  className="shrink-0 rounded-xl"
                  onClick={() => void review(row.id)}
                >
                  {busy === row.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "علّمه مُراجَعاً"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <LoadMoreButton cursor={nextCursor} busy={loadingMore} onLoad={(cursor) => void load(cursor)} testId="pos-price-deviations-more" />
    </div>
  );
}
