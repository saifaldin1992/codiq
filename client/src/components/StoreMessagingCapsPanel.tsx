/**
 * ق-180 — the owner's hand on one store's daily message ceilings.
 *
 * The three columns were built for exactly this («so the platform owner can
 * tighten a particular store without a deploy») and had no writer but a test.
 * Marketing is the store's own volume; the two operational ceilings are
 * anti-abuse walls from 19-د — set them low only for a store you distrust,
 * because a busy honest store's order confirmations sit behind them too.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Gauge, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Caps = {
  marketingDailyCap: number;
  operationalDailyCap: number;
  operationalRecipientDailyCap: number;
};

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "تعذر تنفيذ الطلب."
    );
  return body as T;
}

const FIELDS: { key: keyof Caps; label: string; hint: string; min: number; max: number }[] = [
  {
    key: "marketingDailyCap",
    label: "رسائل تسويقية في اليوم",
    hint: "صفر يوقف التسويق لهذا المتجر. فوق السقف تُؤجَّل الرسائل إلى الغد ولا تُحذف.",
    min: 0,
    max: 10000,
  },
  {
    key: "operationalDailyCap",
    label: "رسائل تشغيلية في اليوم",
    hint: "قاطع دائرة لمتجرٍ واحد — تأكيدات الطلبات وحالاتها. ضعه بعيداً عن حجم متجرٍ نشط.",
    min: 1,
    max: 100000,
  },
  {
    key: "operationalRecipientDailyCap",
    label: "رسائل تشغيلية للمستلم الواحد في اليوم",
    hint: "الضابط الدقيق: لا زبون صادق يتلقّى عشرين رسالة تشغيلية من متجرٍ واحد في يوم.",
    min: 1,
    max: 1000,
  },
];

export function StoreMessagingCapsPanel({ storeSlug }: { storeSlug: string }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [draft, setDraft] = useState<Record<keyof Caps, string>>({
    marketingDailyCap: "",
    operationalDailyCap: "",
    operationalRecipientDailyCap: "",
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/platform/stores/${encodeURIComponent(storeSlug)}/messaging-caps`;

  const load = useCallback(async () => {
    try {
      const result = await api<{ caps: Caps }>(url);
      setCaps(result.caps);
      setDraft({
        marketingDailyCap: String(result.caps.marketingDailyCap),
        operationalDailyCap: String(result.caps.operationalDailyCap),
        operationalRecipientDailyCap: String(result.caps.operationalRecipientDailyCap),
      });
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر تحميل سقوف الرسائل.");
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = Object.fromEntries(
    FIELDS.map((field) => [field.key, Number(draft[field.key])])
  ) as Caps;
  const valid = FIELDS.every(
    (field) =>
      Number.isInteger(parsed[field.key]) &&
      parsed[field.key] >= field.min &&
      parsed[field.key] <= field.max
  );
  const dirty = caps !== null && FIELDS.some((field) => parsed[field.key] !== caps[field.key]);

  async function save() {
    if (!valid || !dirty) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await api<{ caps: Caps }>(url, {
        method: "PUT",
        body: JSON.stringify(parsed),
      });
      setCaps(result.caps);
      setNotice("حُفظت السقوف. تسري على الرسائل من الآن دون نشر.");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "تعذر حفظ السقوف.");
    } finally {
      setBusy(false);
    }
  }

  if (!caps && !failure)
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-[var(--codiq-text-muted)]">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        جارٍ تحميل سقوف الرسائل…
      </p>
    );

  return (
    <section
      className="mt-3 rounded-2xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] p-4"
      data-testid="store-messaging-caps"
    >
      <h3 className="flex items-center gap-2 text-sm font-black text-[var(--codiq-text)]">
        <Gauge className="h-4 w-4 text-[var(--codiq-accent)]" />
        سقوف الرسائل اليومية
      </h3>
      <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">
        تُشدّ على متجرٍ بعينه دون نشر. فوق أيّ سقفٍ تُؤجَّل الرسالة إلى الغد ولا تُحذف.
      </p>
      {failure ? (
        <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-[var(--codiq-danger)]">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {failure}
        </p>
      ) : null}
      {caps ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {FIELDS.map((field) => (
            <label key={field.key} className="space-y-1">
              <span className="block text-xs font-bold text-[var(--codiq-text-secondary)]">
                {field.label}
              </span>
              <input
                inputMode="numeric"
                data-testid={`caps-${field.key}`}
                value={draft[field.key]}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    [field.key]: event.target.value.replace(/\D/g, ""),
                  }));
                  setNotice(null);
                }}
                className="h-10 w-full rounded-xl border border-[var(--codiq-border)] bg-[var(--codiq-surface)] px-3 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]"
              />
              <span className="block text-[11px] leading-4 text-[var(--codiq-text-muted)]">
                {field.hint} ({field.min}–{field.max})
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-xs font-bold text-[var(--codiq-success)]">
          {notice}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        data-testid="caps-save"
        disabled={busy || !valid || !dirty}
        onClick={() => void save()}
        className="mt-3 h-9 rounded-xl px-4 text-xs font-bold"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "حفظ السقوف"}
      </Button>
    </section>
  );
}
