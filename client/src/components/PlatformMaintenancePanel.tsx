/**
 * ق-250 (المرحلة 29-2) — the two tabs the owner's «الخدمات والإتاحة» screen
 * gained: scheduled maintenance and incidents.
 *
 *   الصيانة  a window with a Baghdad start and end, a sentence in Arabic (and
 *            one in English if wanted), and a scope. It starts and ends by
 *            itself; the owner only cancels early. Merchants it touches are
 *            mailed when it is scheduled and when it ends.
 *   الحوادث  said out loud while something is wrong: title, public message,
 *            what it affects, and whether it BLOCKS (closes the affected
 *            capabilities) or only tells. Four states forward to «resolved»;
 *            every step is an update that stays.
 *
 * The screen shows what the server resolves; it never decides.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type WindowView = {
  id: string;
  scope: "platform" | "service" | "capability" | "merchant" | "store";
  phase: "upcoming" | "active" | "ended" | "cancelled";
  status: string;
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  messageAr: string;
  messageEn: string | null;
  affects: string[];
  subject: string;
  merchant: { email: string; businessName: string } | null;
  store: { slug: string; name: string } | null;
  createdByKind: string;
  createdAt: string;
};
type IncidentUpdate = {
  id: string;
  status: string;
  statusLabel: string;
  message: string;
  createdByKind: string;
  createdAt: string;
};
type IncidentView = {
  id: string;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  statusLabel: string;
  severity: "minor" | "major" | "critical";
  severityLabel: string;
  title: string;
  publicMessage: string;
  affects: string[];
  blocks: boolean;
  startedAt: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
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

const input =
  "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";
const label = "mb-1 block text-xs font-bold text-[var(--codiq-text-muted)]";
const SCOPE_LABELS = {
  platform: "المنصّة كلّها",
  service: "خدمة",
  capability: "قدرة",
  merchant: "تاجر بكلّ متاجره",
  store: "متجر واحد",
} as const;
const PHASE_LABELS = {
  upcoming: "قادمة",
  active: "جارية الآن",
  ended: "انتهت",
  cancelled: "أُلغيت",
} as const;
const phaseTone = (phase: WindowView["phase"]) =>
  phase === "active"
    ? "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"
    : phase === "upcoming"
      ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]"
      : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]";
const STATUS_OPTIONS: { value: IncidentView["status"]; label: string }[] = [
  { value: "investigating", label: "قيد التحقيق" },
  { value: "identified", label: "حُدّد السبب" },
  { value: "monitoring", label: "قيد المراقبة" },
  { value: "resolved", label: "حُلّ" },
];
const severityTone = (severity: IncidentView["severity"]) =>
  severity === "critical"
    ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]"
    : severity === "major"
      ? "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]"
      : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]";

/** datetime-local gives a wall-clock string with no zone; the browser's zone is the owner's, and Baghdad is what the server prints back. */
const toIso = (local: string) => new Date(local).toISOString();
const parseCodes = (value: string) =>
  value
    .split(/[,\s،]+/)
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);

export function MaintenanceTab({
  notify,
}: {
  notify: (message: string, failed?: boolean) => void;
}) {
  const [windows, setWindows] = useState<WindowView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    scope: "platform",
    serviceCode: "",
    capabilityCode: "",
    merchantEmail: "",
    storeSlug: "",
    startsAt: "",
    endsAt: "",
    messageAr: "",
    messageEn: "",
    affects: "",
  });

  const load = useCallback(
    async (cursor?: string | null) => {
      try {
        const page = await api<{ windows: WindowView[]; nextCursor: string | null }>(
          `/api/platform/maintenance-windows?live=${live ? "true" : "false"}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        setWindows((current) => (cursor && current ? [...current, ...page.windows] : page.windows));
        setNextCursor(page.nextCursor);
      } catch (error) {
        notify(error instanceof Error ? error.message : "تعذر تحميل نوافذ الصيانة.", true);
      }
    },
    [live, notify]
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        scope: form.scope,
        startsAt: toIso(form.startsAt),
        endsAt: toIso(form.endsAt),
        messageAr: form.messageAr,
        messageEn: form.messageEn || undefined,
      };
      if (form.scope === "service") body.serviceCode = form.serviceCode;
      if (form.scope === "capability") body.capabilityCode = form.capabilityCode;
      if (form.scope === "merchant") body.merchantEmail = form.merchantEmail;
      if (form.scope === "store") body.storeSlug = form.storeSlug;
      if (form.scope === "platform" || form.scope === "merchant" || form.scope === "store")
        body.affects = parseCodes(form.affects);
      await api("/api/platform/maintenance-windows", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify("سُجّلت نافذة الصيانة — من يمسّه الأمر يصله إشعار.");
      setForm((current) => ({ ...current, messageAr: "", messageEn: "", affects: "" }));
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تسجيل النافذة.", true);
    } finally {
      setSaving(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api(`/api/platform/maintenance-windows/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      notify("أُلغيت النافذة.");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الإلغاء.", true);
    }
  }

  const canSubmit =
    form.startsAt &&
    form.endsAt &&
    form.messageAr.trim().length >= 3 &&
    (form.scope !== "service" || form.serviceCode) &&
    (form.scope !== "capability" || form.capabilityCode) &&
    (form.scope !== "merchant" || form.merchantEmail) &&
    (form.scope !== "store" || form.storeSlug);

  return (
    <div className="space-y-5" data-testid="maintenance-tab">
      <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
          <CalendarClock className="h-4 w-4 text-[var(--codiq-accent)]" /> نافذة صيانة جديدة
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">
          تبدأ وتنتهي بنفسها بتوقيت بغداد. التجّار الذين تمسّهم يصلهم إشعار عند التسجيل وعند
          الانتهاء؛ الزبائن يقرؤون رسالتك حيث تتوقّف الخدمة.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={label}>النطاق</span>
            <select
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              className={input}
              data-testid="window-scope"
            >
              {(Object.keys(SCOPE_LABELS) as (keyof typeof SCOPE_LABELS)[]).map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          </label>
          {form.scope === "service" ? (
            <label className="block">
              <span className={label}>رمز الخدمة</span>
              <input
                value={form.serviceCode}
                onChange={(e) => setForm({ ...form, serviceCode: e.target.value })}
                placeholder="delivery"
                className={input}
                dir="ltr"
                data-testid="window-service"
              />
            </label>
          ) : null}
          {form.scope === "capability" ? (
            <label className="block">
              <span className={label}>رمز القدرة</span>
              <input
                value={form.capabilityCode}
                onChange={(e) => setForm({ ...form, capabilityCode: e.target.value })}
                placeholder="delivery.manifest"
                className={input}
                dir="ltr"
                data-testid="window-capability"
              />
            </label>
          ) : null}
          {form.scope === "merchant" ? (
            <label className="block">
              <span className={label}>بريد التاجر</span>
              <input
                value={form.merchantEmail}
                onChange={(e) => setForm({ ...form, merchantEmail: e.target.value })}
                className={input}
                dir="ltr"
                data-testid="window-merchant"
              />
            </label>
          ) : null}
          {form.scope === "store" ? (
            <label className="block">
              <span className={label}>رابط المتجر (slug)</span>
              <input
                value={form.storeSlug}
                onChange={(e) => setForm({ ...form, storeSlug: e.target.value })}
                className={input}
                dir="ltr"
                data-testid="window-store"
              />
            </label>
          ) : null}
          <label className="block">
            <span className={label}>من</span>
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className={input}
              data-testid="window-starts"
            />
          </label>
          <label className="block">
            <span className={label}>إلى</span>
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className={input}
              data-testid="window-ends"
            />
          </label>
          <label className="block sm:col-span-3">
            <span className={label}>الرسالة العربيّة (يقرؤها الزبون والتاجر)</span>
            <input
              value={form.messageAr}
              onChange={(e) => setForm({ ...form, messageAr: e.target.value })}
              maxLength={500}
              placeholder="مثال: نرقّي خوادم التوصيل — بيان الشحنات يعود في الموعد المذكور"
              className={input}
              data-testid="window-message"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>الرسالة الإنكليزيّة (اختياريّ)</span>
            <input
              value={form.messageEn}
              onChange={(e) => setForm({ ...form, messageEn: e.target.value })}
              maxLength={500}
              className={input}
              dir="ltr"
            />
          </label>
          {form.scope === "platform" || form.scope === "merchant" || form.scope === "store" ? (
            <label className="block">
              <span className={label}>يقتصر على (رموز، اختياريّ)</span>
              <input
                value={form.affects}
                onChange={(e) => setForm({ ...form, affects: e.target.value })}
                placeholder="delivery.manifest, pos"
                className={input}
                dir="ltr"
                data-testid="window-affects"
              />
            </label>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={saving || !canSubmit}
          onClick={() => void submit()}
          className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
          data-testid="window-submit"
        >
          {saving ? (
            <LoaderCircle className="ml-1 h-4 w-4 animate-spin" />
          ) : (
            <CalendarClock className="ml-1 h-4 w-4" />
          )}
          سجّل النافذة
        </Button>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-[var(--codiq-text)]">
            {live ? "النوافذ القادمة والجارية" : "كلّ النوافذ"}
          </p>
          <button
            type="button"
            onClick={() => setLive((current) => !current)}
            className="text-xs font-bold text-[var(--codiq-accent)]"
            data-testid="window-toggle-live"
          >
            {live ? "أظهر المنتهية والملغاة" : "القادمة والجارية فقط"}
          </button>
        </div>
        {!windows ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : windows.length === 0 ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">
            لا نافذةَ صيانة{live ? " قادمة أو جارية" : ""}.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--codiq-border)] rounded-[20px] border border-[var(--codiq-border)]">
            {windows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                data-testid="window-row"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--codiq-text)]">
                    {row.subject}{" "}
                    <span
                      className={`mr-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${phaseTone(row.phase)}`}
                    >
                      {PHASE_LABELS[row.phase]}
                    </span>{" "}
                    <span className="text-xs text-[var(--codiq-text-muted)]">
                      {SCOPE_LABELS[row.scope]}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--codiq-text-muted)]">
                    <span dir="ltr">
                      {row.startsAtLocal} → {row.endsAtLocal}
                    </span>{" "}
                    (بغداد) · {row.messageAr}
                    {row.affects.length ? <span dir="ltr"> · {row.affects.join(", ")}</span> : null}
                  </p>
                </div>
                {row.phase === "upcoming" || row.phase === "active" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-xl"
                    onClick={() => void cancel(row.id)}
                    data-testid="window-cancel"
                  >
                    {row.phase === "active" ? "أنهِ الآن" : "إلغاء"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {nextCursor ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 rounded-xl"
            onClick={() => void load(nextCursor)}
          >
            تحميل المزيد
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function IncidentsTab({ notify }: { notify: (message: string, failed?: boolean) => void }) {
  const [incidents, setIncidents] = useState<IncidentView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    severity: "minor",
    publicMessage: "",
    affects: "",
    blocks: false,
  });
  const [updates, setUpdates] = useState<
    Record<string, { status: IncidentView["status"]; message: string }>
  >({});

  const load = useCallback(
    async (cursor?: string | null) => {
      try {
        const page = await api<{ incidents: IncidentView[]; nextCursor: string | null }>(
          `/api/platform/incidents?open=${open ? "true" : "false"}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        setIncidents((current) =>
          cursor && current ? [...current, ...page.incidents] : page.incidents
        );
        setNextCursor(page.nextCursor);
      } catch (error) {
        notify(error instanceof Error ? error.message : "تعذر تحميل الحوادث.", true);
      }
    },
    [open, notify]
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setSaving(true);
    try {
      await api("/api/platform/incidents", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          severity: form.severity,
          publicMessage: form.publicMessage,
          affects: parseCodes(form.affects),
          blocks: form.blocks,
        }),
      });
      notify(
        form.blocks
          ? "فُتح الحادث — القدرات المتأثّرة موقوفة حتى يُحلّ."
          : "فُتح الحادث — التجّار يقرؤونه في لوحاتهم."
      );
      setForm({ title: "", severity: "minor", publicMessage: "", affects: "", blocks: false });
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر فتح الحادث.", true);
    } finally {
      setSaving(false);
    }
  }
  async function post(incident: IncidentView) {
    const draft = updates[incident.id] ?? { status: incident.status, message: "" };
    try {
      await api(`/api/platform/incidents/${encodeURIComponent(incident.id)}/updates`, {
        method: "POST",
        body: JSON.stringify({ status: draft.status, message: draft.message }),
      });
      notify(draft.status === "resolved" ? "حُلّ الحادث." : "سُجّل التحديث.");
      setUpdates((current) => ({
        ...current,
        [incident.id]: { status: draft.status, message: "" },
      }));
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تسجيل التحديث.", true);
    }
  }

  return (
    <div className="space-y-5" data-testid="incidents-tab">
      <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--codiq-text)]">
          <CircleAlert className="h-4 w-4 text-[var(--codiq-danger)]" /> حادث جديد
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--codiq-text-muted)]">
          الرسالة العامّة يقرؤها التجّار في لوحاتهم فوراً؛ إن اخترت «يحجب» تتوقّف القدرات المتأثّرة
          فعلاً حتى تحلّه.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className={label}>العنوان (للمنصّة)</span>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={160}
              className={input}
              data-testid="incident-title"
            />
          </label>
          <label className="block">
            <span className={label}>الشدّة</span>
            <select
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
              className={input}
              data-testid="incident-severity"
            >
              <option value="minor">طفيف</option>
              <option value="major">كبير</option>
              <option value="critical">حرج</option>
            </select>
          </label>
          <label className="block sm:col-span-3">
            <span className={label}>الرسالة العامّة (للتجّار، وللزبائن إن حجب)</span>
            <input
              value={form.publicMessage}
              onChange={(e) => setForm({ ...form, publicMessage: e.target.value })}
              maxLength={1000}
              className={input}
              data-testid="incident-message"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>يؤثّر في (رموز خدمات أو قدرات، فارغ = الكلّ)</span>
            <input
              value={form.affects}
              onChange={(e) => setForm({ ...form, affects: e.target.value })}
              placeholder="delivery.cod_reconciliation, pos"
              className={input}
              dir="ltr"
              data-testid="incident-affects"
            />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-bold text-[var(--codiq-text)]">
            <input
              type="checkbox"
              checked={form.blocks}
              onChange={(e) => setForm({ ...form, blocks: e.target.checked })}
              data-testid="incident-blocks"
            />{" "}
            يحجب القدرات المتأثّرة
          </label>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={saving || form.title.trim().length < 3 || form.publicMessage.trim().length < 3}
          onClick={() => void submit()}
          className="mt-3 rounded-xl bg-[var(--codiq-danger)] text-white hover:bg-[var(--codiq-danger-hover)]"
          data-testid="incident-submit"
        >
          {saving ? (
            <LoaderCircle className="ml-1 h-4 w-4 animate-spin" />
          ) : (
            <CircleAlert className="ml-1 h-4 w-4" />
          )}
          افتح الحادث
        </Button>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-[var(--codiq-text)]">
            {open ? "الحوادث المفتوحة" : "كلّ الحوادث"}
          </p>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="text-xs font-bold text-[var(--codiq-accent)]"
            data-testid="incident-toggle-open"
          >
            {open ? "أظهر المحلولة أيضاً" : "المفتوحة فقط"}
          </button>
        </div>
        {!incidents ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : incidents.length === 0 ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">لا حادثَ مفتوحاً — كلّ شيء يعمل.</p>
        ) : (
          <ul className="space-y-3">
            {incidents.map((incident) => {
              const draft = updates[incident.id] ?? { status: incident.status, message: "" };
              return (
                <li
                  key={incident.id}
                  className="rounded-[20px] border border-[var(--codiq-border)] p-4 text-sm"
                  data-testid="incident-row"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold text-[var(--codiq-text)]">
                      {incident.title}{" "}
                      <span
                        className={`mr-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${severityTone(incident.severity)}`}
                      >
                        {incident.severityLabel}
                      </span>{" "}
                      <span className="mr-1 rounded-full bg-[var(--codiq-neutral-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-text-secondary)]">
                        {incident.statusLabel}
                      </span>
                      {incident.blocks ? (
                        <span className="mr-1 rounded-full bg-[var(--codiq-danger-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--codiq-danger)]">
                          يحجب
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                      {incident.affects.length ? incident.affects.join(", ") : "المنصّة كلّها"}
                    </p>
                  </div>
                  <p className="mt-1 text-[var(--codiq-text-secondary)]">
                    {incident.publicMessage}
                  </p>
                  <ul className="mt-2 space-y-1 border-r-2 border-[var(--codiq-border)] pr-3 text-xs text-[var(--codiq-text-muted)]">
                    {incident.updates.map((update) => (
                      <li key={update.id}>
                        <span className="font-bold text-[var(--codiq-text-secondary)]">
                          {update.statusLabel}
                        </span>{" "}
                        — {update.message}{" "}
                        <span dir="ltr">
                          {new Date(update.createdAt).toLocaleString("ar-IQ", {
                            timeZone: "Asia/Baghdad",
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {incident.status !== "resolved" ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
                      <select
                        value={draft.status}
                        onChange={(e) =>
                          setUpdates({
                            ...updates,
                            [incident.id]: {
                              ...draft,
                              status: e.target.value as IncidentView["status"],
                            },
                          })
                        }
                        className={input}
                        data-testid="incident-update-status"
                      >
                        {STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={draft.message}
                        onChange={(e) =>
                          setUpdates({
                            ...updates,
                            [incident.id]: { ...draft, message: e.target.value },
                          })
                        }
                        placeholder="ما الذي تغيّر؟"
                        maxLength={1000}
                        className={input}
                        data-testid="incident-update-message"
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={draft.message.trim().length < 3}
                        onClick={() => void post(incident)}
                        className="rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
                        data-testid="incident-update-submit"
                      >
                        {draft.status === "resolved" ? "حُلّ" : "سجّل"}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 rounded-xl"
            onClick={() => void load(nextCursor)}
          >
            تحميل المزيد
          </Button>
        ) : null}
      </div>
    </div>
  );
}
