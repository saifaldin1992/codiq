/**
 * المرحلة 29 (ق-249) — «الخدمات والإتاحة»: the owner's control room, one screen
 * with three tabs because they are three jobs done by one person:
 *
 *   الخدمات   what the platform offers — every service and capability with the
 *             DEFAULT state the owner sets (available / coming soon / disabled /
 *             deprecated / retired). A switch here reaches every merchant.
 *   التجاوزات one store, one merchant, or the whole platform — a state with a
 *             written reason and an optional window. Revoked by stamping.
 *   الأعلام   rollout: a capability opened for one merchant, a plan, or a
 *             percentage before everyone. Never authorization.
 *
 * The screen shows what the server resolves; it never decides. Every write
 * lands as a platform audit row the owner can read months later.
 */
import { useCallback, useEffect, useState } from "react";
import { Flag, LoaderCircle, Power, ShieldOff, ToggleLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IncidentsTab, MaintenanceTab } from "@/components/PlatformMaintenancePanel";
import { ConfigTab } from "@/components/PlatformConfigPanel";

type ServiceState = "available" | "coming_soon" | "disabled" | "deprecated" | "retired";
type Capability = { code: string; name: string; description: string; state: ServiceState };
type Service = {
  code: string;
  name: string;
  description: string;
  state: ServiceState;
  dependencies: { kind: string; target: string; note: string }[];
  capabilities: Capability[];
};
type Override = {
  id: string;
  scope: "platform" | "merchant" | "store";
  state: string;
  reason: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  merchant: { email: string; businessName: string } | null;
  store: { slug: string; name: string } | null;
  subject: { kind: "service" | "capability"; code: string; name: string };
};
type FlagRule = {
  id: string;
  scope: string;
  enabled: boolean;
  percentage: number | null;
  plan: { code: string; name: string } | null;
  merchant: { email: string } | null;
  store: { slug: string } | null;
};
type FeatureFlag = {
  code: string;
  description: string;
  enabledDefault: boolean;
  rules: FlagRule[];
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

const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  available: "متاحة",
  coming_soon: "قريباً",
  disabled: "معطّلة",
  deprecated: "ستُوقف",
  retired: "أُوقفت",
};
const OVERRIDE_STATES = [
  "AVAILABLE",
  "COMING_SOON",
  "DISABLED",
  "MAINTENANCE",
  "TEMPORARILY_UNAVAILABLE",
  "DEPRECATED",
  "RETIRED",
] as const;
const OVERRIDE_LABELS: Record<(typeof OVERRIDE_STATES)[number], string> = {
  AVAILABLE: "متاحة (فتحٌ قسريّ)",
  COMING_SOON: "قريباً",
  DISABLED: "معطّلة",
  MAINTENANCE: "تحت الصيانة",
  TEMPORARILY_UNAVAILABLE: "متوقّفة مؤقّتاً",
  DEPRECATED: "ستُوقف",
  RETIRED: "أُوقفت",
};
const stateTone = (state: string) =>
  state === "available" || state === "AVAILABLE"
    ? "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"
    : state === "coming_soon" || state === "COMING_SOON"
      ? "bg-[var(--codiq-accent-soft)] text-[var(--codiq-accent-on-soft)]"
      : "bg-[var(--codiq-warning-soft)] text-[var(--codiq-warning)]";
const input =
  "w-full rounded-xl border border-[var(--codiq-border-strong)] bg-[var(--codiq-surface)] px-3 py-2 text-sm text-[var(--codiq-text)] outline-none focus:border-[var(--codiq-accent)]";
const label = "mb-1 block text-xs font-bold text-[var(--codiq-text-muted)]";

function ServicesTab({ notify }: { notify: (message: string, failed?: boolean) => void }) {
  const [services, setServices] = useState<Service[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setServices((await api<{ services: Service[] }>("/api/platform/services")).services);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل الخدمات.", true);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  async function setState(kind: "service" | "capability", code: string, state: ServiceState) {
    setBusy(code);
    try {
      await api(
        `/api/platform/${kind === "service" ? "services" : "capabilities"}/${encodeURIComponent(code)}`,
        { method: "PATCH", body: JSON.stringify({ state }) }
      );
      notify(`حُفظت حالة ${code}: ${SERVICE_STATE_LABELS[state]}.`);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحفظ.", true);
    } finally {
      setBusy(null);
    }
  }

  if (!services) return <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>;
  return (
    <div className="space-y-4" data-testid="services-tab">
      {services.map((service) => (
        <div
          key={service.code}
          className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-base font-bold text-[var(--codiq-text)]">
                {service.name}{" "}
                <span className="text-xs font-medium text-[var(--codiq-text-muted)]" dir="ltr">
                  {service.code}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-[var(--codiq-text-muted)]">{service.description}</p>
            </div>
            <label className="flex items-center gap-2 text-xs font-bold text-[var(--codiq-text-secondary)]">
              الحالة الافتراضيّة
              <select
                value={service.state}
                disabled={busy === service.code}
                onChange={(event) =>
                  void setState("service", service.code, event.target.value as ServiceState)
                }
                className={`${input} w-auto`}
                data-testid={`service-state-${service.code}`}
              >
                {(Object.keys(SERVICE_STATE_LABELS) as ServiceState[]).map((state) => (
                  <option key={state} value={state}>
                    {SERVICE_STATE_LABELS[state]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {service.dependencies.length ? (
            <p className="mt-2 text-[11px] text-[var(--codiq-text-muted)]">
              تعتمد على:{" "}
              {service.dependencies
                .map((d) => `${d.target}${d.note ? ` — ${d.note}` : ""}`)
                .join(" · ")}
            </p>
          ) : null}
          <ul className="mt-3 divide-y divide-[var(--codiq-border)]">
            {service.capabilities.map((capability) => (
              <li
                key={capability.code}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div>
                  <span className="font-semibold text-[var(--codiq-text)]">{capability.name}</span>{" "}
                  <span className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                    {capability.code}
                  </span>
                  <p className="text-xs text-[var(--codiq-text-muted)]">{capability.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${stateTone(capability.state)}`}
                  >
                    {SERVICE_STATE_LABELS[capability.state]}
                  </span>
                  <select
                    value={capability.state}
                    disabled={busy === capability.code}
                    onChange={(event) =>
                      void setState(
                        "capability",
                        capability.code,
                        event.target.value as ServiceState
                      )
                    }
                    className={`${input} w-auto py-1`}
                    data-testid={`capability-state-${capability.code}`}
                  >
                    {(Object.keys(SERVICE_STATE_LABELS) as ServiceState[]).map((state) => (
                      <option key={state} value={state}>
                        {SERVICE_STATE_LABELS[state]}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function OverridesTab({ notify }: { notify: (message: string, failed?: boolean) => void }) {
  const [overrides, setOverrides] = useState<Override[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    scope: "store",
    storeSlug: "",
    merchantEmail: "",
    subjectKind: "capability",
    subjectCode: "",
    state: "DISABLED",
    reason: "",
    startsAt: "",
    endsAt: "",
  });
  const load = useCallback(
    async (cursor?: string | null) => {
      try {
        const page = await api<{ overrides: Override[]; nextCursor: string | null }>(
          `/api/platform/availability/overrides${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        setOverrides((current) =>
          cursor && current ? [...current, ...page.overrides] : page.overrides
        );
        setNextCursor(page.nextCursor);
      } catch (error) {
        notify(error instanceof Error ? error.message : "تعذر تحميل التجاوزات.", true);
      }
    },
    [notify]
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        scope: form.scope,
        state: form.state,
        reason: form.reason,
      };
      if (form.scope === "store") body.storeSlug = form.storeSlug;
      if (form.scope === "merchant") body.merchantEmail = form.merchantEmail;
      if (form.subjectKind === "capability") body.capabilityCode = form.subjectCode;
      else body.serviceCode = form.subjectCode;
      if (form.startsAt) body.startsAt = new Date(form.startsAt).toISOString();
      if (form.endsAt) body.endsAt = new Date(form.endsAt).toISOString();
      await api("/api/platform/availability/overrides", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify("سُجّل التجاوز.");
      setForm((current) => ({ ...current, reason: "", subjectCode: "" }));
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تسجيل التجاوز.", true);
    } finally {
      setSaving(false);
    }
  }
  async function revoke(id: string) {
    try {
      await api(`/api/platform/availability/overrides/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      notify("أُلغي التجاوز.");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الإلغاء.", true);
    }
  }

  return (
    <div className="space-y-5" data-testid="overrides-tab">
      <div className="rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4">
        <p className="text-sm font-bold text-[var(--codiq-text)]">تجاوز جديد</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className={label}>النطاق</span>
            <select
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              className={input}
              data-testid="override-scope"
            >
              <option value="store">متجر واحد</option>
              <option value="merchant">تاجر بكلّ متاجره</option>
              <option value="platform">المنصّة كلّها</option>
            </select>
          </label>
          {form.scope === "store" ? (
            <label className="block">
              <span className={label}>رابط المتجر (slug)</span>
              <input
                value={form.storeSlug}
                onChange={(e) => setForm({ ...form, storeSlug: e.target.value })}
                className={input}
                dir="ltr"
                data-testid="override-store"
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
                data-testid="override-merchant"
              />
            </label>
          ) : null}
          <label className="block">
            <span className={label}>الموضوع</span>
            <select
              value={form.subjectKind}
              onChange={(e) => setForm({ ...form, subjectKind: e.target.value })}
              className={input}
            >
              <option value="capability">قدرة</option>
              <option value="service">خدمة كاملة</option>
            </select>
          </label>
          <label className="block">
            <span className={label}>
              رمز {form.subjectKind === "capability" ? "القدرة" : "الخدمة"}
            </span>
            <input
              value={form.subjectCode}
              onChange={(e) => setForm({ ...form, subjectCode: e.target.value })}
              placeholder={form.subjectKind === "capability" ? "delivery.manifest" : "delivery"}
              className={input}
              dir="ltr"
              data-testid="override-subject"
            />
          </label>
          <label className="block">
            <span className={label}>الحالة</span>
            <select
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
              className={input}
              data-testid="override-state"
            >
              {OVERRIDE_STATES.map((state) => (
                <option key={state} value={state}>
                  {OVERRIDE_LABELS[state]}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-3">
            <span className={label}>السبب (يقرؤه من يرفع التجاوز بعد شهور)</span>
            <input
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              maxLength={300}
              className={input}
              data-testid="override-reason"
            />
          </label>
          <label className="block">
            <span className={label}>من (اختياريّ)</span>
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className={input}
            />
          </label>
          <label className="block">
            <span className={label}>إلى (اختياريّ)</span>
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className={input}
            />
          </label>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={saving || !form.subjectCode || form.reason.trim().length < 3}
          onClick={() => void submit()}
          className="mt-3 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
          data-testid="override-submit"
        >
          {saving ? (
            <LoaderCircle className="ml-1 h-4 w-4 animate-spin" />
          ) : (
            <ShieldOff className="ml-1 h-4 w-4" />
          )}
          سجّل التجاوز
        </Button>
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-[var(--codiq-text)]">التجاوزات الحيّة</p>
        {!overrides ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
        ) : overrides.length === 0 ? (
          <p className="text-sm text-[var(--codiq-text-muted)]">
            لا تجاوزَ حيّاً — كلّ شيء على حالته الافتراضيّة.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--codiq-border)] rounded-[20px] border border-[var(--codiq-border)]">
            {overrides.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                data-testid="override-row"
              >
                <div>
                  <p className="font-semibold text-[var(--codiq-text)]">
                    {row.subject.name}{" "}
                    <span className="text-xs text-[var(--codiq-text-muted)]" dir="ltr">
                      {row.subject.code}
                    </span>{" "}
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-bold ${stateTone(row.state)}`}
                    >
                      {OVERRIDE_LABELS[row.state as keyof typeof OVERRIDE_LABELS] ?? row.state}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--codiq-text-muted)]">
                    {row.scope === "platform"
                      ? "المنصّة كلّها"
                      : row.scope === "merchant"
                        ? `التاجر ${row.merchant?.businessName ?? ""} (${row.merchant?.email ?? ""})`
                        : `المتجر ${row.store?.name ?? ""} (${row.store?.slug ?? ""})`}{" "}
                    · {row.reason}
                    {row.endsAt ? ` · حتى ${new Date(row.endsAt).toLocaleString("ar-IQ")}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  onClick={() => void revoke(row.id)}
                  data-testid="override-revoke"
                >
                  إلغاء
                </Button>
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
            حمّل المزيد
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FlagsTab({ notify }: { notify: (message: string, failed?: boolean) => void }) {
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState({
    flag: "",
    scope: "merchant",
    target: "",
    percentage: "10",
    enabled: true,
  });
  const load = useCallback(async () => {
    try {
      setFlags((await api<{ flags: FeatureFlag[] }>("/api/platform/feature-flags")).flags);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل الأعلام.", true);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  async function createFlag() {
    try {
      await api(`/api/platform/feature-flags/${encodeURIComponent(code.trim())}`, {
        method: "PUT",
        body: JSON.stringify({ description, enabledDefault: false }),
      });
      notify("أُنشئ العلم — مطفأ افتراضاً حتى تفتحه بقاعدة.");
      setCode("");
      setDescription("");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إنشاء العلم.", true);
    }
  }
  async function addRule() {
    try {
      const body: Record<string, unknown> = { scope: rule.scope, enabled: rule.enabled };
      if (rule.scope === "merchant" || rule.scope === "beta") body.merchantEmail = rule.target;
      if (rule.scope === "store") body.storeSlug = rule.target;
      if (rule.scope === "plan") body.planCode = rule.target;
      if (rule.scope === "percentage") body.percentage = Number(rule.percentage);
      await api(`/api/platform/feature-flags/${encodeURIComponent(rule.flag)}/rules`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify("أُضيفت القاعدة.");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إضافة القاعدة.", true);
    }
  }
  async function removeRule(flag: string, ruleId: string) {
    try {
      await api(
        `/api/platform/feature-flags/${encodeURIComponent(flag)}/rules/${encodeURIComponent(ruleId)}`,
        { method: "DELETE" }
      );
      notify("حُذفت القاعدة.");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف.", true);
    }
  }

  return (
    <div className="space-y-5" data-testid="flags-tab">
      <div className="grid gap-3 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-[1fr_2fr_auto]">
        <label className="block">
          <span className={label}>رمز العلم (رمز القدرة عادةً)</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="delivery.manifest"
            className={input}
            dir="ltr"
            data-testid="flag-code"
          />
        </label>
        <label className="block">
          <span className={label}>الوصف</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={input}
          />
        </label>
        <Button
          type="button"
          size="sm"
          className="self-end rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
          disabled={!code.trim()}
          onClick={() => void createFlag()}
          data-testid="flag-create"
        >
          <Flag className="ml-1 h-4 w-4" />
          أنشئ
        </Button>
      </div>
      <div className="grid gap-3 rounded-[20px] border border-[var(--codiq-border)] bg-[var(--codiq-surface-sunken)] p-4 sm:grid-cols-5">
        <label className="block">
          <span className={label}>العلم</span>
          <select
            value={rule.flag}
            onChange={(e) => setRule({ ...rule, flag: e.target.value })}
            className={input}
            data-testid="rule-flag"
          >
            <option value="">— اختر —</option>
            {(flags ?? []).map((flag) => (
              <option key={flag.code} value={flag.code}>
                {flag.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>النطاق</span>
          <select
            value={rule.scope}
            onChange={(e) => setRule({ ...rule, scope: e.target.value })}
            className={input}
            data-testid="rule-scope"
          >
            <option value="merchant">تاجر</option>
            <option value="beta">تاجر تجريبيّ</option>
            <option value="store">متجر</option>
            <option value="plan">خطّة</option>
            <option value="percentage">نسبة</option>
            <option value="global">الجميع</option>
          </select>
        </label>
        {rule.scope === "percentage" ? (
          <label className="block">
            <span className={label}>النسبة %</span>
            <input
              type="number"
              min={0}
              max={100}
              value={rule.percentage}
              onChange={(e) => setRule({ ...rule, percentage: e.target.value })}
              className={input}
            />
          </label>
        ) : rule.scope === "global" ? (
          <div />
        ) : (
          <label className="block">
            <span className={label}>
              {rule.scope === "store"
                ? "رابط المتجر"
                : rule.scope === "plan"
                  ? "رمز الخطّة"
                  : "بريد التاجر"}
            </span>
            <input
              value={rule.target}
              onChange={(e) => setRule({ ...rule, target: e.target.value })}
              className={input}
              dir="ltr"
              data-testid="rule-target"
            />
          </label>
        )}
        <label className="flex items-end gap-2 pb-2 text-sm font-bold text-[var(--codiq-text-secondary)]">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
            className="h-4 w-4"
          />{" "}
          مفتوح
        </label>
        <Button
          type="button"
          size="sm"
          className="self-end rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"
          disabled={!rule.flag}
          onClick={() => void addRule()}
          data-testid="rule-add"
        >
          <ToggleLeft className="ml-1 h-4 w-4" />
          أضف قاعدة
        </Button>
      </div>
      {!flags ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">جارٍ التحميل…</p>
      ) : flags.length === 0 ? (
        <p className="text-sm text-[var(--codiq-text-muted)]">
          لا أعلام بعد — كلّ قدرةٍ متاحة تُطرح للجميع مباشرةً.
        </p>
      ) : (
        <ul className="space-y-3">
          {flags.map((flag) => (
            <li
              key={flag.code}
              className="rounded-[20px] border border-[var(--codiq-border)] p-4"
              data-testid={`flag-${flag.code}`}
            >
              <p className="text-sm font-bold text-[var(--codiq-text)]" dir="ltr">
                {flag.code}{" "}
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] ${flag.enabledDefault ? stateTone("available") : stateTone("coming_soon")}`}
                >
                  {flag.enabledDefault ? "مفتوح افتراضاً" : "مطفأ افتراضاً"}
                </span>
              </p>
              {flag.description ? (
                <p className="text-xs text-[var(--codiq-text-muted)]">{flag.description}</p>
              ) : null}
              <ul className="mt-2 space-y-1 text-xs text-[var(--codiq-text-secondary)]">
                {flag.rules.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>
                      {r.scope === "global"
                        ? "الجميع"
                        : r.scope === "percentage"
                          ? `${r.percentage}% من التجّار`
                          : r.scope === "plan"
                            ? `خطّة ${r.plan?.name ?? ""}`
                            : r.scope === "store"
                              ? `متجر ${r.store?.slug ?? ""}`
                              : `تاجر ${r.merchant?.email ?? ""}`}{" "}
                      → {r.enabled ? "مفتوح" : "مغلق"}
                    </span>
                    <button
                      type="button"
                      className="text-[var(--codiq-danger)] underline"
                      onClick={() => void removeRule(flag.code, r.id)}
                    >
                      حذف
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlatformServicesPanel() {
  const [tab, setTab] = useState<
    "services" | "overrides" | "flags" | "maintenance" | "incidents" | "config"
  >("services");
  const [notice, setNotice] = useState<{ message: string; failed: boolean } | null>(null);
  const notify = useCallback(
    (message: string, failed = false) => setNotice({ message, failed }),
    []
  );
  const tabs: { id: typeof tab; label: string }[] = [
    { id: "services", label: "الخدمات والقدرات" },
    { id: "overrides", label: "التجاوزات" },
    { id: "flags", label: "أعلام الطرح" },
    { id: "maintenance", label: "الصيانة" },
    { id: "incidents", label: "الحوادث" },
    { id: "config", label: "التهيئة" },
  ];
  return (
    <section className="space-y-5" dir="rtl" data-testid="platform-services">
      <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)] sm:p-7">
        <h2 className="flex items-center gap-2 text-xl font-bold text-[var(--codiq-text)]">
          <Power className="h-5 w-5 text-[var(--codiq-accent)]" />
          الخدمات والإتاحة
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--codiq-text-muted)]">
          ما تقدّمه المنصّة، وهل هو متاح الآن ولمن — من هنا كإعدادات لا كود. الأعلى يغلب: قيدُ
          المنصّة فوق التاجر فوق المتجر فوق الحالة الافتراضيّة فوق علم الطرح.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-bold ${tab === t.id ? "bg-[var(--codiq-accent)] text-[var(--codiq-brand-ink)]" : "bg-[var(--codiq-neutral-soft)] text-[var(--codiq-text-secondary)]"}`}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {notice ? (
          <p
            role="status"
            className={`mt-4 rounded-xl px-3 py-2 text-sm font-semibold ${notice.failed ? "bg-[var(--codiq-danger-soft)] text-[var(--codiq-danger)]" : "bg-[var(--codiq-success-soft)] text-[var(--codiq-success)]"}`}
            data-testid="services-notice"
          >
            {notice.message}
          </p>
        ) : null}
      </div>
      <div className="rounded-[26px] bg-[var(--codiq-surface)] p-6 shadow-[0_16px_44px_rgba(31,55,98,0.055)]">
        {tab === "services" ? (
          <ServicesTab notify={notify} />
        ) : tab === "overrides" ? (
          <OverridesTab notify={notify} />
        ) : tab === "flags" ? (
          <FlagsTab notify={notify} />
        ) : tab === "maintenance" ? (
          <MaintenanceTab notify={notify} />
        ) : tab === "incidents" ? (
          <IncidentsTab notify={notify} />
        ) : (
          <ConfigTab notify={notify} />
        )}
      </div>
    </section>
  );
}
